#!/usr/bin/env node
import './silence-warnings.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ensureLocalIdentity,
  fetchGithubUserKeys,
  getSshFingerprint,
  syncGithubAccountIdentity,
} from './crypto.js';
import {
  collectAndCacheLocalSessions,
  commitToGitRef,
  compactLoreRef,
  findGitRoot,
  findMisfiledSessions,
  forgetItems,
  getGitMeta,
  importFromGitRef,
  LORE_REF,
  LORE_REMOTE_REF,
  loadAllLocalSessions,
  loadManifest,
  loadTakeaways,
  mergeRevoked,
  pullLoreFromRemote,
  pushLoreToRemote,
  saveManifest,
  saveTakeaways,
  tryGit,
} from './git-store.js';
import {
  refreshWorkspaceContextFiles,
  searchLore,
} from './context-injector.js';
import {
  appendHookLog,
  getInstalledHookCliPath,
  installGitHooks,
  readLastHookEntry,
  refreshHooksIfStale,
} from './hooks.js';
import { resolveStableCliPath } from './install-path.js';
import { renderOutline, resolveTurnRange } from './session-view.js';
import { runHandoff } from './handoff.js';
import { installGlobalAgentIntegrations } from './global-setup.js';
import { startMcpServer } from './mcp-server.js';
import type { TakeawayEntry } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const IS_DEV_SOURCE = __filename.endsWith('.ts');

/**
 * If this repo's lore hooks call a different copy of lore than the stable install, re-point them.
 * Cheap when they already match; only resolves the global install path when they don't.
 */
function healStaleHooks(repoRoot: string): void {
  if (IS_DEV_SOURCE) return;
  try {
    const hookPath = getInstalledHookCliPath(repoRoot);
    if (!hookPath || hookPath.toLowerCase() === __filename.replace(/\\/g, '/').toLowerCase()) return;
    const stable = resolveStableCliPath(__filename);
    if (refreshHooksIfStale(repoRoot, stable.path)) {
      console.error(`  (re-pointed this repo's lore git hooks at ${stable.path})`);
    }
  } catch {
    // Never block a command on hook maintenance
  }
}

function runHook(hook: string, fn: (root: string) => string): void {
  const root = findGitRoot(process.cwd());
  if (!root) return;
  try {
    appendHookLog(root, hook, 'ok', fn(root));
  } catch (err: any) {
    appendHookLog(root, hook, 'error', err?.message || String(err));
  }
}

function formatKB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function withProgress<T>(message: string, fn: () => T): T {
  const isTTY = Boolean(process.stderr.isTTY);
  if (isTTY) {
    process.stderr.write(`\r⟳ ${message}...`);
  }
  try {
    return fn();
  } finally {
    if (isTTY) {
      process.stderr.write(`\r\x1b[K`);
    }
  }
}

function requireRepoRoot(): string {
  const root = findGitRoot(process.cwd());
  if (!root) {
    console.error('✖ Error: Not inside a Git repository. Run `git init` first.');
    process.exit(1);
  }
  return root;
}

function printHelp(): void {
  console.log(`
lore (git-lore) — Git-Native Encrypted AI Context & Memory

Usage:
  lore setup [--handoff|--no-handoff] One-time global install for Antigravity, Claude Code, Cursor, Codex
                                     (--handoff: Claude Code sessions start with recent work from other tools)
  lore handoff                       Show recent work from another tool in this repo (what --handoff injects)
  lore init                          Initialize lore in current Git repo (hooks + SSH encryption + initial sync)
  lore status                        Show synced sessions, compression stats, takeaways, and authorized keys
  lore sync                          Collect local chats, encrypt, merge with remote refs/ai/lore, and push
  lore pull                          Fetch and decrypt refs/ai/lore from origin and refresh agent rules
  lore allow <@github-user | key>    Authorize a contributor via GitHub SSH keys (github.com/<user>.keys)
  lore revoke <user | fingerprint>   Revoke a contributor's access and rotate encryption keys
  lore note <text> [--cat <type>]    Save an architectural decision, gotcha, or WIP note to the Living Digest
  lore search <query>                Full-text BM25 search across all past sessions & takeaways
  lore show <session-id>             View the stripped conversation turns of a session in your terminal
       [--outline]                   One line per user prompt, with turn numbers
       [--last N | --from A --to B]  Only a stretch of turns
  lore forget <id> [<id>...]         Delete sessions/takeaways by id or prefix (on every device, after sync)
  lore forget --check                List sessions from this device that no longer belong to this repo
  lore compact                       Rewrite refs/ai/lore without history (purges forgotten/revoked data)
  lore mcp                           Run the Model Context Protocol (MCP) server over stdio
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';

  if (cmd === 'mcp') {
    startMcpServer();
    return;
  }

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }

  if (cmd === 'setup') {
    syncGithubAccountIdentity(process.cwd());
    const id = ensureLocalIdentity(process.cwd());
    const stable = resolveStableCliPath(__filename, args.includes('--use-this-copy'));
    const handoff = args.includes('--handoff') ? true : args.includes('--no-handoff') ? false : undefined;
    const res = installGlobalAgentIntegrations(stable.path, { handoff });
    console.log('✔ lore global setup complete!');
    console.log(`  • Local SSH Identity : ${id.label} (${id.fingerprint})`);
    console.log(`  • Key Path           : ${id.privPath}`);
    console.log(`  • Antigravity MCP    : ${res.antigravityMcpPath}`);
    console.log(`  • Antigravity Skill  : ${res.antigravitySkillPath}`);
    console.log(`  • lore Entry Point   : ${stable.path}`);
    if (stable.note) console.log(`    (${stable.note})`);
    if (res.claudeConfigUpdated) {
      console.log(`  • Claude Code MCP    : ~/.claude.json (updated)`);
    }
    if (res.codexInstructionsPath) {
      console.log(`  • Codex Instructions : ${res.codexInstructionsPath}`);
    }
    console.log(
      `  • Handoff Hook       : ${res.handoffHookInstalled ? 'on' : 'off'} ` +
        `(Claude Code sessions ${res.handoffHookInstalled ? 'start with' : 'can start with'} a note about recent work in other tools; ` +
        `${res.handoffHookInstalled ? 'turn off with lore setup --no-handoff' : 'turn on with lore setup --handoff'})`
    );
    console.log('\nAgents in all workspaces now automatically know how to use lore.');
    return;
  }

  if (cmd === 'handoff') {
    const hook = args.includes('--hook');
    // readFileSync(0) is unreliable on Windows pipes, so read stdin as a stream with a short timeout
    const stdinText =
      hook && !process.stdin.isTTY
        ? await new Promise<string>((resolve) => {
            let buf = '';
            const done = () => resolve(buf);
            const timer = setTimeout(done, 3000);
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (d) => (buf += d));
            process.stdin.on('end', () => {
              clearTimeout(timer);
              done();
            });
            process.stdin.on('error', () => {
              clearTimeout(timer);
              done();
            });
          })
        : undefined;
    process.stdin.pause();
    const note = runHandoff((dir) => findGitRoot(dir), { hook, stdinText });
    if (note) console.log(note);
    else if (!hook) console.log('No recent work from another tool to hand off.');
    return;
  }

  if (cmd === 'hook-pre-push') {
    runHook('hook-pre-push', (root) => {
      const remote = args[1] || 'origin';
      const res = pushLoreToRemote(root, remote);
      refreshWorkspaceContextFiles(root);
      if (!res.pushed && res.error) throw new Error(`push failed: ${res.error}`);
      return `${res.sessionCount} sessions, ${res.pushed ? 'pushed' : 'local only'} (${res.commitSha.slice(0, 8)})`;
    });
    return;
  }

  if (cmd === 'hook-post-merge') {
    runHook('hook-post-merge', (root) => {
      const pull = pullLoreFromRemote(root);
      collectAndCacheLocalSessions(root);
      refreshWorkspaceContextFiles(root);
      if (pull.newerFormat) throw new Error(`remote lore uses newer format ${pull.newerFormat}; upgrade lore`);
      if (pull.decryptionError) throw new Error(`decryption failed: ${pull.decryptionError}`);
      return pull.fetched ? `imported ${pull.importedSessions} sessions` : 'no remote lore';
    });
    return;
  }

  if (cmd === 'init') {
    const repoRoot = requireRepoRoot();
    syncGithubAccountIdentity(repoRoot);
    const id = ensureLocalIdentity(repoRoot);
    const manifest = loadManifest(repoRoot);
    if (!manifest.recipients.some((r) => r.fingerprint === id.fingerprint)) {
      manifest.recipients.push({
        label: id.label,
        sshPublicKey: id.pubLine,
        fingerprint: id.fingerprint,
        addedAt: new Date().toISOString(),
      });
      saveManifest(repoRoot, manifest);
    }

    const hooks = installGitHooks(
      repoRoot,
      resolveStableCliPath(__filename, args.includes('--use-this-copy')).path
    );
    const { pullRes, collectRes, commitRes, ruleRes } = withProgress(
      'Collecting & encrypting local AI sessions',
      () => {
        const pullRes = pullLoreFromRemote(repoRoot);
        const collectRes = collectAndCacheLocalSessions(repoRoot);
        const commitRes = commitToGitRef(repoRoot);
        const ruleRes = refreshWorkspaceContextFiles(repoRoot);
        return { pullRes, collectRes, commitRes, ruleRes };
      }
    );

    console.log(`✔ Initialized lore in ${repoRoot}`);
    console.log(`  • Hidden Git Ref     : ${LORE_REF} (${commitRes.commitSha.slice(0, 8)})`);
    console.log(`  • Git Hooks Installed: ${hooks.join(', ')}`);
    console.log(`  • Authorized Key     : ${id.label} (${id.fingerprint})`);
    console.log(
      `  • Sessions Collected : ${commitRes.sessionCount} session(s)` +
        (collectRes.bytesSaved > 0 ? ` (stripped ${formatKB(collectRes.bytesSaved)} of raw log bloat)` : '')
    );
    if (pullRes.fetched) {
      console.log(`  • Remote Lore Merged : ${pullRes.importedSessions} session(s) from origin`);
    }
    console.log(`  • Agent Context Rule : .agents/rules/lore-context.md (~${ruleRes.tokenEstimate} tokens, git-excluded)`);
    return;
  }

  if (cmd === 'sync' || cmd === 'push') {
    const repoRoot = requireRepoRoot();
    healStaleHooks(repoRoot);
    const { res, ruleRes } = withProgress('Syncing & encrypting AI sessions', () => {
      const res = pushLoreToRemote(repoRoot);
      const ruleRes = refreshWorkspaceContextFiles(repoRoot);
      return { res, ruleRes };
    });
    console.log(`✔ Synced lore → ${LORE_REF} (${res.commitSha.slice(0, 8)})`);
    console.log(`  • Sessions           : ${res.sessionCount}`);
    console.log(`  • Takeaways          : ${res.takeawayCount}`);
    console.log(`  • Remote Push        : ${res.pushed ? 'pushed to origin' : 'saved locally (no remote or offline)'}`);
    if (res.error) console.log(`    ⚠ ${res.error.split(/\r?\n/)[0]}`);
    console.log(`  • Living Digest      : ~${ruleRes.tokenEstimate} tokens (.agents/rules/lore-context.md)`);
    return;
  }

  if (cmd === 'pull') {
    const repoRoot = requireRepoRoot();
    const { pullRes, collectRes, ruleRes } = withProgress('Pulling & decrypting lore context', () => {
      const pullRes = pullLoreFromRemote(repoRoot);
      importFromGitRef(repoRoot);
      const collectRes = collectAndCacheLocalSessions(repoRoot);
      const ruleRes = refreshWorkspaceContextFiles(repoRoot);
      return { pullRes, collectRes, ruleRes };
    });
    if (pullRes.newerFormat) {
      console.error(
        `✖ This repo's lore data uses format ${pullRes.newerFormat}, newer than this lore understands. Upgrade: npm i -g git-lore-cli@latest`
      );
      process.exit(1);
    }
    if (pullRes.decryptionError) {
      console.error(`✖ Decryption error: ${pullRes.decryptionError}`);
      process.exit(1);
    }
    console.log(`✔ Pulled lore context for ${path.basename(repoRoot)}`);
    console.log(`  • Remote Sessions    : ${pullRes.importedSessions} imported`);
    console.log(`  • Total Local Cache  : ${collectRes.totalSessions} session(s)`);
    console.log(`  • Living Digest      : ~${ruleRes.tokenEstimate} tokens (.agents/rules/lore-context.md)`);
    return;
  }

  if (cmd === 'allow') {
    const target = args.slice(1).join(' ').trim();
    if (!target) {
      console.error('Usage: lore allow <github-username | "ssh-ed25519 AAAAC3...">');
      process.exit(1);
    }
    const repoRoot = requireRepoRoot();
    const manifest = loadManifest(repoRoot);

    if (target.startsWith('ssh-ed25519 ')) {
      const fp = getSshFingerprint(target);
      const comment = target.split(/\s+/)[2] || 'custom-key';
      if (!manifest.recipients.some((r) => r.fingerprint === fp)) {
        manifest.recipients.push({
          label: `ssh:${comment}`,
          sshPublicKey: target,
          fingerprint: fp,
          addedAt: new Date().toISOString(),
        });
      }
      saveManifest(repoRoot, manifest);
      const commitRes = commitToGitRef(repoRoot);
      console.log(`✔ Authorized SSH key ${fp} (ssh:${comment})`);
      console.log(`  Re-encrypted ${commitRes.sessionCount} session(s) in ${LORE_REF} (${commitRes.commitSha.slice(0, 8)})`);
    } else {
      const keys = await fetchGithubUserKeys(target);
      let added = 0;
      for (const k of keys) {
        if (!manifest.recipients.some((r) => r.fingerprint === k.fingerprint)) {
          manifest.recipients.push(k);
          added++;
        }
      }
      saveManifest(repoRoot, manifest);
      const commitRes = commitToGitRef(repoRoot);
      console.log(`✔ Authorized GitHub contributor @${target.replace(/^@/, '')} (${keys.length} ssh-ed25519 key(s), ${added} newly added):`);
      for (const k of keys) {
        console.log(`  • ${k.label} (${k.fingerprint})`);
      }
      console.log(`  Re-encrypted ${commitRes.sessionCount} session(s) in ${LORE_REF} (${commitRes.commitSha.slice(0, 8)})`);
    }
    return;
  }

  if (cmd === 'revoke') {
    const query = args[1]?.trim();
    if (!query) {
      console.error('Usage: lore revoke <github-username | fingerprint>');
      process.exit(1);
    }
    const repoRoot = requireRepoRoot();
    const manifest = loadManifest(repoRoot);
    const clean = query.replace(/^@/, '').toLowerCase();
    const before = manifest.recipients.length;
    const beforeFps = manifest.recipients.map((r) => r.fingerprint);
    manifest.recipients = manifest.recipients.filter(
      (r) =>
        !r.label.toLowerCase().includes(clean) &&
        !r.fingerprint.toLowerCase().includes(clean)
    );
    if (manifest.recipients.length === 0) {
      console.error('✖ Cannot revoke all recipients (at least 1 recipient must remain).');
      process.exit(1);
    }
    const removed = before - manifest.recipients.length;
    const kept = new Set(manifest.recipients.map((r) => r.fingerprint));
    const revokedNow = new Date().toISOString();
    manifest.revoked = mergeRevoked(
      manifest.revoked,
      beforeFps.filter((fp) => !kept.has(fp)).map((fingerprint) => ({ fingerprint, at: revokedNow }))
    );
    saveManifest(repoRoot, manifest);
    const commitRes = commitToGitRef(repoRoot);
    console.log(`✔ Revoked ${removed} key(s) matching "${query}". Rotated encryption keys on ${LORE_REF} (${commitRes.commitSha.slice(0, 8)}).`);
    return;
  }

  if (cmd === 'note' || cmd === 'checkpoint') {
    const repoRoot = requireRepoRoot();
    let category: TakeawayEntry['category'] = 'decision';
    const textParts: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--cat' && args[i + 1]) {
        category = args[i + 1] as TakeawayEntry['category'];
        i++;
      } else {
        textParts.push(args[i]);
      }
    }
    const content = textParts.join(' ').trim();
    if (!content) {
      console.error('Usage: lore note "Your architectural decision or WIP note" [--cat decision|architecture|gotcha|wip|convention]');
      process.exit(1);
    }
    const meta = getGitMeta(repoRoot);
    const existing = loadTakeaways(repoRoot);
    const entry: TakeawayEntry = {
      id: crypto.randomUUID().slice(0, 12),
      timestamp: new Date().toISOString(),
      author: meta.author,
      category,
      content,
      commitSha: meta.headCommit,
    };
    saveTakeaways(repoRoot, [...existing, entry]);
    const commitRes = commitToGitRef(repoRoot);
    const ruleRes = refreshWorkspaceContextFiles(repoRoot);
    console.log(`✔ Saved [${category.toUpperCase()}] note to ${LORE_REF} (${commitRes.commitSha.slice(0, 8)})`);
    console.log(`  Updated .agents/rules/lore-context.md (~${ruleRes.tokenEstimate} tokens)`);
    return;
  }

  if (cmd === 'search') {
    const query = args.slice(1).join(' ').trim();
    if (!query) {
      console.error('Usage: lore search <query>');
      process.exit(1);
    }
    const repoRoot = requireRepoRoot();
    const hits = withProgress('Indexing & searching lore history', () => {
      collectAndCacheLocalSessions(repoRoot);
      refreshWorkspaceContextFiles(repoRoot);
      return searchLore(repoRoot, query, 10);
    });
    if (hits.length === 0) {
      console.log(`No matches found for "${query}".`);
      return;
    }
    console.log(`Found ${hits.length} match(es) for "${query}":\n`);
    for (const h of hits) {
      console.log(`• [${h.docType.toUpperCase()}] ${h.title} (id: ${h.docId.slice(0, 8)} · ${h.updatedAt.slice(0, 16)})`);
      if (h.files) console.log(`  Files  : ${h.files}`);
      console.log(`  Snippet: ${h.snippet.replace(/\s+/g, ' ').trim()}`);
      if (h.turns && h.turns.length > 0) {
        const first = Math.max(1, h.turns[0] - 3);
        console.log(`  Turns  : #${h.turns.join(', #')}  →  lore show ${h.docId.slice(0, 8)} --from ${first} --to ${h.turns[0] + 6}`);
      }
      console.log('');
    }
    return;
  }

  if (cmd === 'show') {
    const targetId = args.slice(1).find((a, i, arr) => !a.startsWith('--') && !(i > 0 && /^--(last|from|to)$/.test(arr[i - 1])))?.trim().toLowerCase();
    if (!targetId) {
      console.error('Usage: lore show <session-id-or-prefix> [--outline | --last N | --from A --to B]');
      process.exit(1);
    }
    const numFlag = (name: string): number | undefined => {
      const i = args.indexOf(name);
      if (i === -1) return undefined;
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`✖ ${name} needs a positive turn number`);
        process.exit(1);
      }
      return n;
    };
    const rangeOpts = { last: numFlag('--last'), from: numFlag('--from'), to: numFlag('--to') };
    const repoRoot = requireRepoRoot();
    collectAndCacheLocalSessions(repoRoot);
    const sessions = loadAllLocalSessions(repoRoot);
    const match = sessions.find(
      (s) => s.id.toLowerCase() === targetId || s.id.toLowerCase().startsWith(targetId)
    );
    if (!match) {
      console.error(`✖ Session "${targetId}" not found.`);
      process.exit(1);
    }
    console.log(`================================================================================`);
    console.log(`Session : ${match.title}`);
    console.log(`ID      : ${match.id}`);
    console.log(`Source  : ${match.source} | Device: ${match.deviceHostname || 'local'} | Branch: ${match.branch || 'main'}`);
    console.log(`Size    : ${formatKB(match.originalBytes)} raw -> ${formatKB(match.compressedBytes)} stripped (${match.turns.length} turns)`);
    if (match.filesTouched.length > 0) {
      console.log(`Files   : ${match.filesTouched.join(', ')}`);
    }
    console.log(`================================================================================\n`);
    if (args.includes('--outline')) {
      console.log(renderOutline(match));
      console.log(`\nRead a stretch: lore show ${match.id.slice(0, 8)} --from <turn> --to <turn>`);
      return;
    }
    const range = resolveTurnRange(match.turns.length, rangeOpts);
    if (range.from !== 1 || range.to !== match.turns.length) {
      console.log(`(turns ${range.from}–${range.to} of ${match.turns.length})\n`);
    }
    match.turns.slice(range.from - 1, range.to).forEach((t, i) => {
      const roleHeader = t.role === 'user' ? '▶ USER' : '◀ AGENT';
      console.log(`#${range.from + i} ${roleHeader} (${t.timestamp.slice(0, 19).replace('T', ' ')})`);
      if (t.toolsUsed && t.toolsUsed.length > 0) {
        console.log(`  [Tools: ${t.toolsUsed.slice(0, 6).join(' | ')}]`);
      }
      if (t.toolOutputs && t.toolOutputs.length > 0) {
        for (const o of t.toolOutputs) console.log(`  [Output: ${o}]`);
      }
      console.log(`${t.text}\n`);
    });
    return;
  }

  if (cmd === 'forget') {
    const repoRoot = requireRepoRoot();
    const targets = args.slice(1).filter((a) => !a.startsWith('--'));
    if (args.includes('--check')) {
      const suspects = findMisfiledSessions(repoRoot);
      if (suspects.length === 0) {
        console.log('✔ Every session from this device still belongs to this repo.');
        return;
      }
      console.log(`${suspects.length} session(s) from this device no longer match this repo`);
      console.log('(filed here by an older lore version, or their original transcript was deleted):\n');
      for (const s of suspects) {
        console.log(`  [${s.id.slice(0, 8)}] ${s.title} (${s.source} · ${s.updatedAt.slice(0, 10)} · ${s.turns.length} turns)`);
      }
      console.log(`\nTo remove them: lore forget ${suspects.map((s) => s.id.slice(0, 8)).join(' ')}`);
      return;
    }
    if (targets.length === 0) {
      console.error('Usage: lore forget <session-or-takeaway-id> [...]   |   lore forget --check');
      process.exit(1);
    }
    const sessions = loadAllLocalSessions(repoRoot);
    const takeaways = loadTakeaways(repoRoot);
    const items: Array<{ id: string; kind: 'session' | 'takeaway'; label: string }> = [];
    for (const raw of targets) {
      const q = raw.toLowerCase();
      const matches = [
        ...sessions
          .filter((s) => s.id.toLowerCase().startsWith(q))
          .map((s) => ({ id: s.id, kind: 'session' as const, label: `session: ${s.title}` })),
        ...takeaways
          .filter((t) => t.id.toLowerCase().startsWith(q))
          .map((t) => ({
            id: t.id,
            kind: 'takeaway' as const,
            label: `takeaway: ${t.content.split(/\r?\n/)[0].slice(0, 60)}`,
          })),
      ];
      const exact = matches.filter((m) => m.id.toLowerCase() === q);
      const chosen = exact.length === 1 ? exact : matches;
      if (chosen.length === 0) {
        console.error(`✖ Nothing matches "${raw}".`);
        process.exit(1);
      }
      if (chosen.length > 1) {
        console.error(`✖ "${raw}" matches ${chosen.length} items; use a longer id:`);
        for (const m of chosen) console.error(`    ${m.id}  (${m.label})`);
        process.exit(1);
      }
      items.push(chosen[0]);
    }
    forgetItems(repoRoot, items, getGitMeta(repoRoot).author);
    const commitRes = commitToGitRef(repoRoot);
    refreshWorkspaceContextFiles(repoRoot);
    for (const i of items) console.log(`✔ Forgot ${i.label}`);
    console.log(`  Recorded in ${LORE_REF} (${commitRes.commitSha.slice(0, 8)}); other devices drop it on their next sync.`);
    console.log(`  Run 'lore sync' to push now, and 'lore compact' to also purge it from the ref's history.`);
    return;
  }

  if (cmd === 'compact') {
    const repoRoot = requireRepoRoot();
    const res = withProgress('Rewriting refs/ai/lore without history', () => compactLoreRef(repoRoot));
    console.log(`✔ Compacted ${LORE_REF} from ${res.commitsBefore} commit(s) to 1 (${res.commitSha.slice(0, 8)})`);
    console.log(`  • Remote             : ${res.pushed ? 'replaced on origin' : 'local only'}`);
    if (res.error) console.log(`    ⚠ ${res.error.split(/\r?\n/)[0]}`);
    console.log('  Note: copies other machines already fetched keep the old history until they sync.');
    return;
  }

  if (cmd === 'status') {
    const repoRoot = requireRepoRoot();
    healStaleHooks(repoRoot);
    const { ruleRes, manifest, sessions, takeaways, refSha, remoteRefSha, hasOrigin } = withProgress(
      'Scanning local AI sessions & project memory',
      () => {
        importFromGitRef(repoRoot);
        collectAndCacheLocalSessions(repoRoot);
        const ruleRes = refreshWorkspaceContextFiles(repoRoot);
        const manifest = loadManifest(repoRoot);
        const sessions = loadAllLocalSessions(repoRoot);
        const takeaways = loadTakeaways(repoRoot);
        const refSha = tryGit(repoRoot, ['rev-parse', '--short', LORE_REF]) || 'uncommitted';
        const remoteRefSha = tryGit(repoRoot, ['rev-parse', '--short', LORE_REMOTE_REF]);
        const hasOrigin = Boolean(tryGit(repoRoot, ['remote', 'get-url', 'origin']));
        return { ruleRes, manifest, sessions, takeaways, refSha, remoteRefSha, hasOrigin };
      }
    );

    const totalRaw = sessions.reduce((acc, s) => acc + s.originalBytes, 0);
    const totalStripped = sessions.reduce((acc, s) => acc + s.compressedBytes, 0);
    const savingsPct = totalRaw > 0 ? Math.round((1 - totalStripped / totalRaw) * 100) : 0;

    console.log(`lore status — ${repoRoot}`);
    console.log(`  • Hidden Git Ref     : ${LORE_REF} (${refSha})`);
    console.log(`  • Always-On Digest   : ~${ruleRes.tokenEstimate} tokens (.agents/rules/lore-context.md)`);
    console.log(
      `  • Synced Sessions    : ${sessions.length} (${formatKB(totalRaw)} raw → ${formatKB(totalStripped)} stripped, ${savingsPct}% noise removed)`
    );
    console.log(`  • Active Takeaways   : ${takeaways.length}`);
    for (const t of takeaways.slice(-8)) {
      console.log(`      - [${t.id.slice(0, 12)}] ${t.category}: ${t.content.split(/\r?\n/)[0].slice(0, 70)}`);
    }
    console.log(`  • Authorized Keys    : ${manifest.recipients.length}`);
    for (const r of manifest.recipients) {
      console.log(`      - ${r.label} (${r.fingerprint})`);
    }

    const lastHook = readLastHookEntry(repoRoot);
    if (lastHook) {
      console.log(`  • Last Git Hook      : ${lastHook.failed ? '⚠ FAILED — ' : ''}${lastHook.line.slice(0, 160)}`);
    }

    if (sessions.length > 0) {
      console.log(`\nRecent Sessions:`);
      for (const s of sessions.slice(0, 5)) {
        console.log(
          `  [${s.id.slice(0, 8)}] ${s.title} (${s.source} · ${s.deviceHostname || 'local'} · ${s.turns.length} turns · ${formatKB(s.originalBytes)}→${formatKB(s.compressedBytes)})`
        );
      }
    }

    if (refSha === 'uncommitted' || (hasOrigin && remoteRefSha !== refSha)) {
      console.log(`\n  💡 Tip: run 'lore sync' to push encrypted context to origin`);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(`✖ lore error: ${err.message}`);
  process.exit(1);
});
