import fs from 'node:fs';
import path from 'node:path';
import { getLocalLorePaths } from './git-store.js';

const HOOK_MARKER_START = '# >>> lore-hook-start >>>';
const HOOK_MARKER_END = '# <<< lore-hook-end <<<';

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

  // 1. pre-push hook: syncs & pushes encrypted refs/ai/lore alongside code push
  const prePushSnippet = `if [ "$LORE_HOOK_ACTIVE" != "1" ]; then
  case "$(cat)" in
    *refs/ai/lore*) ;;
    *)
      export LORE_HOOK_ACTIVE=1
      node "${normalizedCli}" hook-pre-push "$1" >/dev/null 2>&1 || true
      ;;
  esac
fi`;

  // 2. post-merge hook (runs on git pull): fetches & decrypts refs/ai/lore and updates .agents/rules/lore-context.md
  const postMergeSnippet = `if [ "$LORE_HOOK_ACTIVE" != "1" ]; then
  export LORE_HOOK_ACTIVE=1
  node "${normalizedCli}" hook-post-merge >/dev/null 2>&1 || true
fi`;

  upsertHookScript(path.join(hooksDir, 'pre-push'), prePushSnippet);
  upsertHookScript(path.join(hooksDir, 'post-merge'), postMergeSnippet);

  return ['pre-push', 'post-merge'];
}
