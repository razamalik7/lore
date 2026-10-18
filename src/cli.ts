#!/usr/bin/env node
import './silence-warnings.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ensureLocalIdentity,
  fetchGithubUserKeys,
  getSshFingerprint,
} from './crypto.js';
import {
  collectAndCacheLocalSessions,
  commitToGitRef,
  findGitRoot,
  getGitMeta,
  importFromGitRef,
  LORE_REF,
  loadAllLocalSessions,
  loadManifest,
  loadTakeaways,
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
import { installGitHooks } from './hooks.js';
import { installGlobalAgentIntegrations } from './global-setup.js';
import { startMcpServer } from './mcp-server.js';
import type { TakeawayEntry } from './types.js';

const __filename = fileURLToPath(import.meta.url);

function formatKB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
  lore setup                         One-time global install for Antigravity & Claude Code (MCP + Skill)
  lore init                          Initialize lore in current Git repo (hooks + SSH encryption + initial sync)
  lore status                        Show synced sessions, compression stats, takeaways, and authorized keys
  lore sync                          Collect local chats, encrypt, merge with remote refs/ai/lore, and push
  lore pull                          Fetch and decrypt refs/ai/lore from origin and refresh agent rules
  lore allow <@github-user | key>    Authorize a contributor via GitHub SSH keys (github.com/<user>.keys)
  lore revoke <user | fingerprint>   Revoke a contributor's access and rotate encryption keys
  lore note <text> [--cat <type>]    Save an architectural decision, gotcha, or WIP note to the Living Digest
  lore search <query>                Full-text BM25 search across all past sessions & takeaways
  lore show <session-id>             View the stripped conversation turns of a session in your terminal
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
    const id = ensureLocalIdentity();
    const res = installGlobalAgentIntegrations(__filename);
    console.log('✔ lore global setup complete!');
    console.log(`  • Local SSH Identity : ${id.label} (${id.fingerprint})`);
    console.log(`  • Key Path           : ${id.privPath}`);
    console.log(`  • Antigravity MCP    : ${res.antigravityMcpPath}`);
    console.log(`  • Antigravity Skill  : ${res.antigravitySkillPath}`);
    if (res.claudeConfigUpdated) {
      console.log(`  • Claude Code MCP    : ~/.claude.json (updated)`);
    }
    console.log('\nAgents in all workspaces now automatically know how to use lore.');
    return;
  }

  if (cmd === 'hook-pre-push') {
    const root = findGitRoot(process.cwd());
    if (!root) return;
    const remote = args[1] || 'origin';
    pushLoreToRemote(root, remote);
    refreshWorkspaceContextFiles(root);
    return;
  }

  if (cmd === 'hook-post-merge') {
    const root = findGitRoot(process.cwd());
    if (!root) return;
    pullLoreFromRemote(root);
    collectAndCacheLocalSessions(root);
    refreshWorkspaceContextFiles(root);
    return;
  }

  if (cmd === 'init') {
    const repoRoot = requireRepoRoot();
    const id = ensureLocalIdentity();
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

    const hooks = installGitHooks(repoRoot, __filename);
    const pullRes = pullLoreFromRemote(repoRoot);
    const collectRes = collectAndCacheLocalSessions(repoRoot);
    const commitRes = commitToGitRef(repoRoot);
    const ruleRes = refreshWorkspaceContextFiles(repoRoot);

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
    const res = pushLoreToRemote(repoRoot);
    const ruleRes = refreshWorkspaceContextFiles(repoRoot);
    console.log(`✔ Synced lore → ${LORE_REF} (${res.commitSha.slice(0, 8)})`);
    console.log(`  • Sessions           : ${res.sessionCount}`);
    console.log(`  • Takeaways          : ${res.takeawayCount}`);
    console.log(`  • Remote Push        : ${res.pushed ? 'pushed to origin' : 'saved locally (no remote or offline)'}`);
    console.log(`  • Living Digest      : ~${ruleRes.tokenEstimate} tokens (.agents/rules/lore-context.md)`);
    return;
  }

  if (cmd === 'pull') {
    const repoRoot = requireRepoRoot();
    const pullRes = pullLoreFromRemote(repoRoot);
    importFromGitRef(repoRoot);
    const collectRes = collectAndCacheLocalSessions(repoRoot);
    const ruleRes = refreshWorkspaceContextFiles(repoRoot);
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
    collectAndCacheLocalSessions(repoRoot);
    refreshWorkspaceContextFiles(repoRoot);
    const hits = searchLore(repoRoot, query, 10);
    if (hits.length === 0) {
      console.log(`No matches found for "${query}".`);
      return;
    }
    console.log(`Found ${hits.length} match(es) for "${query}":\n`);
    for (const h of hits) {
      console.log(`• [${h.docType.toUpperCase()}] ${h.title} (id: ${h.docId.slice(0, 8)} · ${h.updatedAt.slice(0, 16)})`);
      if (h.files) console.log(`  Files  : ${h.files}`);
      console.log(`  Snippet: ${h.snippet}\n`);
    }
    return;
  }

  if (cmd === 'show') {
    const targetId = args[1]?.trim().toLowerCase();
    if (!targetId) {
      console.error('Usage: lore show <session-id-or-prefix>');
      process.exit(1);
    }
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
    for (const t of match.turns) {
      const roleHeader = t.role === 'user' ? '▶ USER' : '◀ AGENT';
      console.log(`${roleHeader} (${t.timestamp.slice(0, 19).replace('T', ' ')})`);
      if (t.toolsUsed && t.toolsUsed.length > 0) {
        console.log(`  [Tools: ${t.toolsUsed.slice(0, 6).join(' | ')}]`);
      }
      console.log(`${t.text}\n`);
    }
    return;
  }

  if (cmd === 'status') {
    const repoRoot = requireRepoRoot();
    importFromGitRef(repoRoot);
    collectAndCacheLocalSessions(repoRoot);
    const ruleRes = refreshWorkspaceContextFiles(repoRoot);
    const manifest = loadManifest(repoRoot);
    const sessions = loadAllLocalSessions(repoRoot);
    const takeaways = loadTakeaways(repoRoot);
    const refSha = tryGit(repoRoot, ['rev-parse', '--short', LORE_REF]) || 'uncommitted';

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
    console.log(`  • Authorized Keys    : ${manifest.recipients.length}`);
    for (const r of manifest.recipients) {
      console.log(`      - ${r.label} (${r.fingerprint})`);
    }

    if (sessions.length > 0) {
      console.log(`\nRecent Sessions:`);
      for (const s of sessions.slice(0, 5)) {
        console.log(
          `  [${s.id.slice(0, 8)}] ${s.title} (${s.source} · ${s.deviceHostname || 'local'} · ${s.turns.length} turns · ${formatKB(s.originalBytes)}→${formatKB(s.compressedBytes)})`
        );
      }
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
