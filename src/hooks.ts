import fs from 'node:fs';
import path from 'node:path';
import { getLocalLorePaths } from './git-store.js';

const HOOK_MARKER_START = '# >>> lore-hook-start >>>';
const HOOK_MARKER_END = '# <<< lore-hook-end <<<';
const HOOK_NAMES = ['pre-push', 'post-merge'] as const;
const MAX_LOG_LINES = 200;

function upsertHookScript(hookPath: string, snippet: string): void {
  let content = '#!/bin/sh\n';
  if (fs.existsSync(hookPath)) {
    content = fs.readFileSync(hookPath, 'utf8');
    const startIdx = content.indexOf(HOOK_MARKER_START);
    const endIdx = content.indexOf(HOOK_MARKER_END);
    if (startIdx !== -1 && endIdx !== -1) {
      content =
        content.slice(0, startIdx).trimEnd() +
        '\n' +
        content.slice(endIdx + HOOK_MARKER_END.length).trimStart();
    }
  }
  if (!content.startsWith('#!')) {
    content = `#!/bin/sh\n${content}`;
  }
  const block = `\n${HOOK_MARKER_START}\n${snippet}\n${HOOK_MARKER_END}\n`;
  fs.writeFileSync(hookPath, `${content.trimEnd()}\n${block}`, { mode: 0o755 });
}

export function installGitHooks(repoRoot: string, cliEntryPath: string): string[] {
  const { gitDir } = getLocalLorePaths(repoRoot);
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const normalizedCli = cliEntryPath.replace(/\\/g, '/');
  // Crashes that happen before lore can log (e.g. a missing install) still land in hook.log via stderr
  const stderrLog = `2>>"$(git rev-parse --git-dir)/lore/hook.log"`;

  // 1. pre-push hook: syncs & pushes encrypted refs/ai/lore alongside code push
  const prePushSnippet = `if [ "$LORE_HOOK_ACTIVE" != "1" ]; then
  case "$(cat)" in
    *refs/ai/lore*) ;;
    *)
      export LORE_HOOK_ACTIVE=1
      node "${normalizedCli}" hook-pre-push "$1" >/dev/null ${stderrLog} || true
      ;;
  esac
fi`;

  // 2. post-merge hook (runs on git pull): fetches & decrypts refs/ai/lore and updates .agents/rules/lore-context.md
  const postMergeSnippet = `if [ "$LORE_HOOK_ACTIVE" != "1" ]; then
  export LORE_HOOK_ACTIVE=1
  node "${normalizedCli}" hook-post-merge >/dev/null ${stderrLog} || true
fi`;

  upsertHookScript(path.join(hooksDir, 'pre-push'), prePushSnippet);
  upsertHookScript(path.join(hooksDir, 'post-merge'), postMergeSnippet);

  return [...HOOK_NAMES];
}

/**
 * The lore CLI path the installed hooks call, or null if lore hooks aren't installed here.
 */
export function getInstalledHookCliPath(repoRoot: string): string | null {
  const { gitDir } = getLocalLorePaths(repoRoot);
  const hookPath = path.join(gitDir, 'hooks', 'pre-push');
  if (!fs.existsSync(hookPath)) return null;
  const content = fs.readFileSync(hookPath, 'utf8');
  if (!content.includes(HOOK_MARKER_START)) return null;
  const m = content.match(/node "([^"]+)" hook-pre-push/);
  return m ? m[1] : null;
}

/** Re-point existing lore hooks at `cliEntryPath` if they call a different copy of lore. Returns true if rewritten. */
export function refreshHooksIfStale(repoRoot: string, cliEntryPath: string): boolean {
  const current = getInstalledHookCliPath(repoRoot);
  if (!current) return false;
  if (current.toLowerCase() === cliEntryPath.replace(/\\/g, '/').toLowerCase()) return false;
  installGitHooks(repoRoot, cliEntryPath);
  return true;
}

export function appendHookLog(repoRoot: string, hook: string, status: 'ok' | 'error', detail: string): void {
  try {
    const { hookLogPath } = getLocalLorePaths(repoRoot);
    fs.mkdirSync(path.dirname(hookLogPath), { recursive: true });
    const line = `${new Date().toISOString()} ${hook} ${status.toUpperCase()} ${detail.replace(/\s+/g, ' ').trim()}\n`;
    let existing = fs.existsSync(hookLogPath) ? fs.readFileSync(hookLogPath, 'utf8') : '';
    existing += line;
    const lines = existing.split('\n').filter(Boolean);
    fs.writeFileSync(hookLogPath, `${lines.slice(-MAX_LOG_LINES).join('\n')}\n`, 'utf8');
  } catch {
    // Logging must never break a git push or pull
  }
}

/** Latest lore hook run, including raw stderr lines written by crashes. */
export function readLastHookEntry(repoRoot: string): { line: string; failed: boolean } | null {
  try {
    const { hookLogPath } = getLocalLorePaths(repoRoot);
    if (!fs.existsSync(hookLogPath)) return null;
    const lines = fs.readFileSync(hookLogPath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;
    // Find the last structured entry; any raw stderr after it means the run crashed
    let lastStructured = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\d{4}-\d{2}-\d{2}T\S+ hook-\S+ (OK|ERROR) /.test(lines[i])) {
        lastStructured = i;
        break;
      }
    }
    if (lastStructured === -1 || lastStructured < lines.length - 1) {
      return { line: lines[lines.length - 1], failed: true };
    }
    const line = lines[lastStructured];
    return { line, failed: / ERROR /.test(line) };
  } catch {
    return null;
  }
}
