import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { ed25519 } from '@noble/curves/ed25519';
import {
  decryptWithLocalIdentity,
  encryptForRecipients,
  ensureLocalIdentity,
  formatSshEd25519Pub,
  getSshFingerprint,
  type LocalKeyIdentity,
} from '../src/crypto.js';
import { DatabaseSync } from 'node:sqlite';
import {
  commitToGitRef,
  compactLoreRef,
  forgetItems,
  LORE_REF,
  NewerFormatError,
  loadAllLocalSessions,
  loadManifest,
  loadTakeaways,
  pullLoreFromRemote,
  pushLoreToRemote,
  runGit,
  saveLocalSession,
  saveManifest,
  saveTakeaways,
  tryGit,
} from '../src/git-store.js';
import {
  refreshWorkspaceContextFiles,
  searchLore,
} from '../src/context-injector.js';
import {
  collectClaudeCodeSessions,
  collectClaudeMemoryTakeaways,
} from '../src/collectors/claude.js';
import { collectAntigravitySessions, matchesRepoSlug } from '../src/collectors/antigravity.js';
import type { SessionRecord } from '../src/types.js';
import { renderOutline, renderSessionMarkdown, resolveTurnRange } from '../src/session-view.js';
import { buildHandoff } from '../src/handoff.js';
import { redactSecrets } from '../src/redactor.js';
import { applyHandoffHook } from '../src/global-setup.js';
import { CLAUDE_MD_BLOCK, upsertMarkedBlock } from '../src/agent-instructions.js';

function makeSession(id: string, title: string, text: string): SessionRecord {
  return {
    id,
    source: 'claude-code',
    title,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:05:00Z',
    branch: 'main',
    headCommit: 'abc1234',
    deviceHostname: 'test-device',
    author: 'tester',
    filesTouched: [],
    recap: `Goal: ${title}`,
    turns: [
      { role: 'user', timestamp: '2026-11-01T10:00:00Z', text: `Please ${title.toLowerCase()}` },
      { role: 'assistant', timestamp: '2026-11-01T10:05:00Z', text },
    ],
    rawStepCount: 2,
    originalBytes: 1000,
    compressedBytes: 0,
  };
}

/** Number of distinct blobs reachable from a ref, i.e. what Git stores for its whole history. */
function blobCount(repo: string, ref: string): number {
  const objs = runGit(repo, ['rev-list', '--objects', ref])
    .split(/\r?\n/)
    .map((l) => l.split(' ')[0])
    .filter(Boolean);
  const types = runGit(repo, ['cat-file', '--batch-check=%(objecttype)'], undefined, `${objs.join('\n')}\n`);
  return types.split(/\r?\n/).filter((t) => t === 'blob').length;
}

function treePaths(repo: string, ref: string): string[] {
  return runGit(repo, ['ls-tree', '-r', '--name-only', ref]).split(/\r?\n/).filter(Boolean);
}

/** Write a new commit on top of `parent` with one file added/replaced, without touching any index. */
function commitWithExtraFile(repo: string, parent: string, filePath: string, content: string): string {
  const tempIndex = path.join(repo, '.git', 'test-extra.index');
  const env = { GIT_INDEX_FILE: tempIndex };
  runGit(repo, ['read-tree', parent], env);
  const sha = runGit(repo, ['hash-object', '-w', '--stdin'], undefined, content);
  runGit(repo, ['update-index', '--add', '--cacheinfo', `100644,${sha},${filePath}`], env);
  const tree = runGit(repo, ['write-tree'], env);
  fs.rmSync(tempIndex, { force: true });
  return runGit(repo, ['commit-tree', tree, '-p', parent, '-m', 'test commit']);
}

async function runV015Tests(ctx: {
  tmpRoot: string;
  remoteBare: string;
  desktopRepo: string;
  laptopRepo: string;
  branch: string;
}) {
  const { tmpRoot, remoteBare, desktopRepo, laptopRepo } = ctx;

  console.log('5. Testing that unchanged syncs reuse encrypted blobs instead of storing new copies...');
  // Bring both sides to the same state first
  pushLoreToRemote(laptopRepo, 'origin');
  pushLoreToRemote(desktopRepo, 'origin');
  const refBefore = runGit(desktopRepo, ['rev-parse', LORE_REF]);
  const blobsBefore = blobCount(remoteBare, LORE_REF);
  const again = pushLoreToRemote(desktopRepo, 'origin');
  assert.equal(again.pushed, true);
  assert.equal(runGit(desktopRepo, ['rev-parse', LORE_REF]), refBefore, 'Syncing with no changes must not create a commit');
  const laptopAgain = pushLoreToRemote(laptopRepo, 'origin');
  assert.equal(laptopAgain.pushed, true);
  assert.equal(
    runGit(remoteBare, ['rev-parse', LORE_REF]),
    refBefore,
    'A second device with the same data must reuse the first device\'s blobs (no new commit)'
  );
  assert.equal(blobCount(remoteBare, LORE_REF), blobsBefore, 'No new blobs for unchanged data');

  saveLocalSession(desktopRepo, makeSession('desktop-session-002', 'Add rate limiting', 'Added a token bucket limiter.'));
  pushLoreToRemote(desktopRepo, 'origin');
  const blobsAfterOne = blobCount(remoteBare, LORE_REF);
  // One new session = its meta blob + one turn chunk, plus a new catalog blob (takeaways.enc lists sessions)
  assert.equal(blobsAfterOne - blobsBefore, 3, `Adding one session should add exactly 3 blobs (got ${blobsAfterOne - blobsBefore})`);
  console.log('   ✔ No-op syncs add nothing; one new session adds only its own blob plus the catalog.');

  console.log('6. Testing concurrent pushes merge instead of force-overwriting...');
  pullLoreFromRemote(laptopRepo, 'origin');
  saveLocalSession(desktopRepo, makeSession('desktop-session-003', 'Desktop race work', 'Desktop side of the race.'));
  saveLocalSession(laptopRepo, makeSession('laptop-session-001', 'Laptop race work', 'Laptop side of the race.'));
  const desktopPush = pushLoreToRemote(desktopRepo, 'origin');
  assert.equal(desktopPush.pushed, true);
  const desktopHead = runGit(remoteBare, ['rev-parse', LORE_REF]);
  const laptopPush = pushLoreToRemote(laptopRepo, 'origin');
  assert.equal(laptopPush.pushed, true, 'Laptop push should succeed after merging');
  const remoteHead = runGit(remoteBare, ['rev-parse', LORE_REF]);
  assert.ok(
    tryGit(remoteBare, ['merge-base', '--is-ancestor', desktopHead, remoteHead]) !== null,
    'Desktop\'s pushed commit must remain in remote history (fast-forward, not overwrite)'
  );
  const paths6 = treePaths(remoteBare, LORE_REF);
  assert.ok(paths6.includes('s2/desktop-session-003/meta.enc'), 'Remote keeps desktop session');
  assert.ok(paths6.includes('s2/laptop-session-001/meta.enc'), 'Remote has laptop session');
  console.log('   ✔ Racing devices both land their sessions with fast-forward pushes.');

  console.log('7. Testing files from newer lore versions are kept, and newer formats are refused...');
  pullLoreFromRemote(desktopRepo, 'origin');
  const base7 = runGit(remoteBare, ['rev-parse', LORE_REF]);
  runGit(desktopRepo, ['fetch', 'origin', `${LORE_REF}:refs/test/base7`]);
  const withFuture = commitWithExtraFile(desktopRepo, base7, 'future/data.json', '{"from":"a newer lore"}');
  runGit(desktopRepo, ['push', 'origin', `${withFuture}:${LORE_REF}`]);
  saveLocalSession(laptopRepo, makeSession('laptop-session-002', 'After future file', 'Laptop work.'));
  assert.equal(pushLoreToRemote(laptopRepo, 'origin').pushed, true);
  assert.ok(treePaths(remoteBare, LORE_REF).includes('future/data.json'), 'Unknown files must survive a sync');

  const goodHead = runGit(remoteBare, ['rev-parse', LORE_REF]);
  runGit(desktopRepo, ['fetch', 'origin', `${LORE_REF}:refs/test/good`]);
  const manifestRaw = runGit(desktopRepo, ['show', `${goodHead}:manifest.json`]);
  const future = commitWithExtraFile(
    desktopRepo,
    goodHead,
    'manifest.json',
    JSON.stringify({ ...JSON.parse(manifestRaw), format: 99 }, null, 2)
  );
  runGit(desktopRepo, ['push', 'origin', `${future}:${LORE_REF}`]);
  assert.throws(() => pushLoreToRemote(laptopRepo, 'origin'), NewerFormatError, 'Must refuse to rewrite a newer format');
  assert.equal(runGit(remoteBare, ['rev-parse', LORE_REF]), future, 'Remote must be untouched after refusal');
  // Restore the remote for the remaining tests
  runGit(desktopRepo, ['push', '-f', 'origin', `${goodHead}:${LORE_REF}`]);
  runGit(desktopRepo, ['update-ref', LORE_REF, goodHead]);
  runGit(laptopRepo, ['update-ref', LORE_REF, goodHead]);
  console.log('   ✔ Unknown files carried over; newer-format refs are left alone.');

  console.log('8. Testing forget propagates across devices and is not resurrected...');
  pullLoreFromRemote(laptopRepo, 'origin');
  forgetItems(laptopRepo, [{ id: 'desktop-session-002', kind: 'session' }, { id: 'takeaway-001', kind: 'takeaway' }], 'tester');
  assert.ok(!loadAllLocalSessions(laptopRepo).some((s) => s.id === 'desktop-session-002'));
  assert.equal(pushLoreToRemote(laptopRepo, 'origin').pushed, true);
  pullLoreFromRemote(desktopRepo, 'origin');
  assert.ok(!loadAllLocalSessions(desktopRepo).some((s) => s.id === 'desktop-session-002'), 'Desktop drops forgotten session');
  assert.ok(!loadTakeaways(desktopRepo).some((t) => t.id === 'takeaway-001'), 'Desktop drops forgotten takeaway');
  // A collector re-finding the same session must not bring it back
  assert.equal(
    saveLocalSession(desktopRepo, makeSession('desktop-session-002', 'Add rate limiting', 'Added a token bucket limiter.')),
    false
  );
  saveTakeaways(desktopRepo, [
    ...loadTakeaways(desktopRepo),
    { id: 'takeaway-001', timestamp: '2026-10-18T08:16:00Z', author: 'x', category: 'architecture', content: 'resurrected?' },
  ]);
  assert.ok(!loadTakeaways(desktopRepo).some((t) => t.id === 'takeaway-001'), 'Forgotten takeaway stays gone');
  pushLoreToRemote(desktopRepo, 'origin');
  assert.ok(!treePaths(remoteBare, LORE_REF).some((p) => p.startsWith('s2/desktop-session-002/')), 'Remote no longer holds it');
  console.log('   ✔ Forgotten items disappear everywhere and stay gone.');

  console.log('9. Testing repo scoping for Antigravity conversations and project folder names...');
  const agyRoot = path.join(tmpRoot, 'agy');
  const projects = path.join(tmpRoot, 'Projects');
  const repoPath = path.join(projects, 'aniML-vision');
  const otherRepo = path.join(projects, 'aniML-world');
  fs.mkdirSync(path.join(agyRoot, 'brain'), { recursive: true });
  const db = new DatabaseSync(path.join(agyRoot, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT,
    step_count INTEGER, last_modified_time TEXT, parent_conversation_id TEXT)`);
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?)');
  const uri = (p: string) => JSON.stringify([`file:///${p.replace(/\\/g, '/')}`]);
  const q = (v: string) => JSON.stringify(v);
  const writeConv = (id: string, steps: any[]) => {
    const dir = path.join(agyRoot, 'brain', id, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n'), 'utf8');
  };
  const userStep = (text: string) => ({ type: 'USER_INPUT', created_at: '2026-11-01T10:00:00Z', content: text });
  const reply = (text: string, toolCalls: any[] = []) => ({
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-01T10:01:00Z',
    content: text,
    tool_calls: toolCalls,
  });

  // A: rooted in another repo; only *mentions* this repo's path in command output -> excluded
  insert.run('conv-other', 'Wolf RL', uri(otherRepo), 3, '2026-11-01T10:01:00Z', '');
  writeConv('conv-other', [
    userStep('train the wolves'),
    reply('Checked running processes', [{ name: 'run_command', args: { CommandLine: q('Get-Process'), Cwd: q(otherRepo) } }]),
    { type: 'GENERIC', created_at: '2026-11-01T10:02:00Z', content: `python.exe ${repoPath}\\art-pipeline\\train.py` },
  ]);
  // B: parent workspace (~/Projects) that edited a file inside this repo -> included
  insert.run('conv-parent-edit', 'Edit from parent', uri(projects), 2, '2026-11-01T10:01:00Z', '');
  writeConv('conv-parent-edit', [
    userStep('fix the site header'),
    reply('Edited header', [{ name: 'view_file', args: { AbsolutePath: q(path.join(repoPath, 'site', 'header.tsx')) } }]),
  ]);
  // C: parent workspace that only talked about this repo -> excluded
  insert.run('conv-parent-talk', 'Talk from parent', uri(projects), 2, '2026-11-01T10:01:00Z', '');
  writeConv('conv-parent-talk', [userStep(`what is in ${repoPath}?`), reply(`It holds ${repoPath}\\art-pipeline.`)]);
  // D: workspace is this repo -> included
  insert.run('conv-direct', 'Direct', uri(repoPath), 2, '2026-11-01T10:01:00Z', '');
  writeConv('conv-direct', [userStep('redesign the UI'), reply('Done')]);
  // E: no DB row, ran a command inside this repo -> included
  writeConv('conv-no-row', [
    userStep('run tests'),
    reply('Ran tests', [{ name: 'run_command', args: { CommandLine: q('npm test'), Cwd: q(repoPath) } }]),
  ]);
  db.close();

  const agyIds = collectAntigravitySessions(repoPath, { branch: 'main' }, agyRoot).map((s) => s.id).sort();
  assert.deepEqual(agyIds, ['conv-direct', 'conv-no-row', 'conv-parent-edit'], `Unexpected Antigravity matches: ${agyIds.join(', ')}`);

  assert.equal(matchesRepoSlug('C--Users-x-Projects-lore', 'C:\\Users\\x\\Projects\\lore'), true);
  assert.equal(matchesRepoSlug('C--Users-x-Projects-lore--claude-worktrees-jolly', 'C:\\Users\\x\\Projects\\lore'), true);
  assert.equal(matchesRepoSlug('C--Users-x-Projects-lore-site', 'C:\\Users\\x\\Projects\\lore'), false, 'lore must not match lore-site');
  assert.equal(matchesRepoSlug('C--Users-x-Projects-razamalik-dev', 'C:\\Users\\x\\Projects\\razamalik.dev'), true, 'Dots are encoded as dashes');
  console.log('   ✔ Only conversations that worked in the repo are collected; lore no longer matches lore-site.');

  console.log('10. Testing compact rewrites history and stays compacted after other devices sync...');
  const commitsBefore = Number(runGit(remoteBare, ['rev-list', '--count', LORE_REF]));
  assert.ok(commitsBefore > 2, 'Remote should have history before compaction');
  const sessionsBefore = treePaths(remoteBare, LORE_REF).filter((p) => p.endsWith('/meta.enc')).length;
  const compacted = compactLoreRef(desktopRepo, 'origin');
  assert.equal(compacted.pushed, true, `Compact should replace the remote (${compacted.error ?? ''})`);
  assert.equal(runGit(remoteBare, ['rev-list', '--count', LORE_REF]), '1');
  assert.equal(
    treePaths(remoteBare, LORE_REF).filter((p) => p.endsWith('/meta.enc')).length,
    sessionsBefore,
    'Compaction must keep all current sessions'
  );
  saveLocalSession(laptopRepo, makeSession('laptop-session-003', 'After compact', 'Laptop work after compact.'));
  assert.equal(pushLoreToRemote(laptopRepo, 'origin').pushed, true);
  assert.equal(
    runGit(remoteBare, ['rev-list', '--count', LORE_REF]),
    '2',
    'A device with old history must build on the compacted commit, not re-attach old history'
  );
  console.log('   ✔ History compacted to one commit, and it stays compact.');

  console.log('11. Testing revoke is not undone by merging another device\'s key list...');
  const bob = makeTempIdentity('bob-revoke');
  const bobEntry = { label: bob.label, sshPublicKey: bob.pubLine, fingerprint: bob.fingerprint, addedAt: '2026-11-01T00:00:00Z' };
  const m1 = loadManifest(desktopRepo);
  m1.recipients.push(bobEntry);
  saveManifest(desktopRepo, m1);
  saveLocalSession(desktopRepo, makeSession('desktop-session-004', 'Shared with bob', 'Bob can read this.'));
  assert.equal(pushLoreToRemote(desktopRepo, 'origin').pushed, true);
  pullLoreFromRemote(laptopRepo, 'origin');
  assert.ok(loadManifest(laptopRepo).recipients.some((r) => r.fingerprint === bob.fingerprint), 'Laptop learns about bob');

  const m2 = loadManifest(desktopRepo);
  m2.recipients = m2.recipients.filter((r) => r.fingerprint !== bob.fingerprint);
  m2.revoked = [{ fingerprint: bob.fingerprint, at: new Date().toISOString() }];
  saveManifest(desktopRepo, m2);
  assert.equal(pushLoreToRemote(desktopRepo, 'origin').pushed, true);
  // Laptop still lists bob locally; its sync must not put him back
  assert.equal(pushLoreToRemote(laptopRepo, 'origin').pushed, true);
  const remoteManifest = JSON.parse(runGit(remoteBare, ['show', `${LORE_REF}:manifest.json`]));
  assert.ok(!remoteManifest.recipients.some((r: any) => r.fingerprint === bob.fingerprint), 'Bob stays revoked on the remote');
  const latestSession = runGit(remoteBare, ['show', `${LORE_REF}:s2/desktop-session-004/meta.enc`]);
  assert.throws(() => decryptWithLocalIdentity(JSON.parse(latestSession), bob), /Access denied/, 'Bob cannot read new data');
  console.log('   ✔ Revoked keys stay revoked across devices and lose access to current data.');
}

function makeTempIdentity(name: string): LocalKeyIdentity {
  const seed = new Uint8Array(crypto.randomBytes(32));
  const pubBytes = ed25519.getPublicKey(seed);
  const pubLine = formatSshEd25519Pub(pubBytes, name);
  return {
    privPath: 'memory',
    pubLine,
    fingerprint: getSshFingerprint(pubLine),
    label: `test:${name}`,
    seed,
    pubBytes,
  };
}

async function runTests() {
  console.log('1. Testing SSH Ed25519 -> X25519 multi-recipient encryption & access control...');
  const alice = makeTempIdentity('alice');
  const bob = makeTempIdentity('bob');
  const mallory = makeTempIdentity('mallory');

  const secretPayload = JSON.stringify({
    message: 'Why we chose X25519 envelope encryption over shadow repos',
    tokens: 420,
  });

  const envelope = encryptForRecipients(secretPayload, [
    { label: alice.label, sshPublicKey: alice.pubLine, fingerprint: alice.fingerprint, addedAt: new Date().toISOString() },
    { label: bob.label, sshPublicKey: bob.pubLine, fingerprint: bob.fingerprint, addedAt: new Date().toISOString() },
  ]);

  assert.equal(decryptWithLocalIdentity(envelope, alice), secretPayload, 'Alice should decrypt payload');
  assert.equal(decryptWithLocalIdentity(envelope, bob), secretPayload, 'Bob should decrypt payload');
  assert.throws(
    () => decryptWithLocalIdentity(envelope, mallory),
    /Access denied/,
    'Mallory (unapproved user on public repo) must be denied decryption'
  );
  console.log('   ✔ Multi-recipient encryption & unauthorized key rejection verified.');

  console.log('2. Testing cross-device sync via hidden Git ref (refs/ai/lore) without polluting git log or git status...');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-e2e-'));
  const remoteBare = path.join(tmpRoot, 'origin.git');
  const desktopRepo = path.join(tmpRoot, 'desktop-repo');
  const laptopRepo = path.join(tmpRoot, 'laptop-repo');

  fs.mkdirSync(remoteBare, { recursive: true });
  runGit(remoteBare, ['init', '--bare']);

  fs.mkdirSync(desktopRepo, { recursive: true });
  runGit(desktopRepo, ['init']);
  runGit(desktopRepo, ['config', 'user.name', 'DevDesktop']);
  runGit(desktopRepo, ['config', 'user.email', 'dev@example.com']);
  fs.writeFileSync(path.join(desktopRepo, 'index.ts'), 'export const x = 1;\n', 'utf8');
  runGit(desktopRepo, ['add', 'index.ts']);
  runGit(desktopRepo, ['commit', '-m', 'Initial code commit']);
  runGit(desktopRepo, ['remote', 'add', 'origin', remoteBare]);
  const branch = runGit(desktopRepo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  runGit(desktopRepo, ['push', '-u', 'origin', branch]);

  // Add simulated desktop session + architectural takeaway
  const localId = ensureLocalIdentity();
  const manifest = loadManifest(desktopRepo);
  assert.ok(manifest.recipients.some((r) => r.fingerprint === localId.fingerprint));

  saveLocalSession(desktopRepo, {
    id: 'desktop-session-001',
    source: 'antigravity',
    title: 'Fix JWT refresh race condition in auth middleware',
    createdAt: '2026-10-18T08:00:00Z',
    updatedAt: '2026-10-18T08:15:00Z',
    branch,
    headCommit: runGit(desktopRepo, ['rev-parse', '--short', 'HEAD']),
    deviceHostname: 'desktop-pc',
    author: 'DevDesktop',
    filesTouched: ['src/auth.ts', 'src/middleware.ts'],
    recap: 'Goal: Fix concurrent 401 token refresh race condition | Files touched: src/auth.ts | Outcome: Added single-flight mutex promise on refreshToken()',
    turns: [
      {
        role: 'user',
        timestamp: '2026-10-18T08:00:00Z',
        text: 'Multiple parallel requests trigger simultaneous refresh token calls and invalidate each other.',
      },
      {
        role: 'assistant',
        timestamp: '2026-10-18T08:15:00Z',
        text: 'We resolved this by deduplicating in-flight refresh requests with a shared `refreshPromise` singleton in `src/auth.ts`.',
        toolsUsed: ['replace_file_content: Add single-flight refresh mutex'],
        filesTouched: ['src/auth.ts'],
      },
    ],
    rawStepCount: 24,
    originalBytes: 58400,
    compressedBytes: 620,
  });

  saveTakeaways(desktopRepo, [
    {
      id: 'takeaway-001',
      timestamp: '2026-10-18T08:16:00Z',
      author: 'DevDesktop',
      category: 'architecture',
      content: 'Auth token refresh uses a single-flight promise mutex in src/auth.ts; never call /oauth/token directly from components.',
    },
  ]);

  const pushRes = pushLoreToRemote(desktopRepo, 'origin');
  assert.equal(pushRes.pushed, true, 'Should push refs/ai/lore to origin bare repo');
  refreshWorkspaceContextFiles(desktopRepo);

  // Verify git status and git log on desktop are 100% clean
  const gitStatusDesktop = runGit(desktopRepo, ['status', '--porcelain']);
  assert.equal(gitStatusDesktop, '', 'git status must remain 100% clean after lore sync & rule generation');
  const gitLogDesktop = runGit(desktopRepo, ['log', '--oneline']);
  assert.equal(gitLogDesktop.split(/\r?\n/).length, 1, 'Branch commit history must not be polluted by lore commits');
  console.log('   ✔ Desktop push to refs/ai/lore succeeded with 0 working-tree or commit-log pollution.');

  // Clone onto simulated Laptop and pull lore context
  runGit(tmpRoot, ['clone', remoteBare, laptopRepo]);
  const pullRes = pullLoreFromRemote(laptopRepo, 'origin');
  assert.equal(pullRes.fetched, true, 'Laptop should fetch refs/ai/lore from origin');
  assert.ok(pullRes.importedSessions >= 1, 'Laptop should decrypt and import desktop session');
  assert.equal(pullRes.importedTakeaways, 1, 'Laptop should decrypt and import desktop takeaway');

  const ruleRes = refreshWorkspaceContextFiles(laptopRepo);
  assert.ok(fs.existsSync(ruleRes.ruleFilePath), 'Laptop should generate .agents/rules/lore-context.md');
  assert.ok(ruleRes.tokenEstimate < 600, `Living Digest should be compact (<600 tokens, got ${ruleRes.tokenEstimate})`);

  // Test FTS5 search on Laptop
  const hits = searchLore(laptopRepo, 'single-flight mutex refresh');
  assert.ok(hits.length >= 1, 'FTS5 search on laptop must find desktop session');
  console.log(`   ✔ Laptop pulled, decrypted, indexed, and generated ~${ruleRes.tokenEstimate}-token digest.`);

  // 3. Test Windows C-- Claude path slugs, worktree directories, and memory/*.md auto-ingestion
  console.log('3. Testing Windows C-- Claude path slugs, worktrees, and memory/*.md auto-ingestion...');
  const fakeClaudeProjects = path.join(tmpRoot, 'claude-projects');
  const winRepoPath = 'C:\\Users\\nars7\\Projects\\aniML-world';
  const mainDir = path.join(fakeClaudeProjects, 'C--Users-nars7-Projects-aniML-world');
  const wtDir = path.join(fakeClaudeProjects, 'C--Users-nars7-Projects-aniML-world--claude-worktrees-jolly-clarke');
  const memDir = path.join(mainDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });

  fs.writeFileSync(
    path.join(mainDir, 'sess-main.jsonl'),
    [
      JSON.stringify({ sessionId: 'sess-main', timestamp: '2026-10-18T10:00:00Z', type: 'custom-title', customTitle: 'Stylized Water Integration' }),
      JSON.stringify({ sessionId: 'sess-main', timestamp: '2026-10-18T10:01:00Z', type: 'user', message: { content: 'Integrate Stylized Water 3 rivers' } }),
      JSON.stringify({ sessionId: 'sess-main', timestamp: '2026-10-18T10:02:00Z', type: 'assistant', message: { content: [{ type: 'text', text: 'Configured cascade spawner and river splines.' }] } }),
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(wtDir, 'sess-wt.jsonl'),
    [
      JSON.stringify({ sessionId: 'sess-wt', timestamp: '2026-10-18T11:00:00Z', type: 'user', message: { content: 'Test deer locomotion in worktree' } }),
      JSON.stringify({ sessionId: 'sess-wt', timestamp: '2026-10-18T11:01:00Z', type: 'assistant', message: { content: [{ type: 'text', text: 'Verified skull-Z height in headless playback.' }] } }),
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(memDir, 'urp-volumes-dead-in-batch-captures.md'),
    `---\nname: urp-volumes-dead-in-batch-captures\ndescription: "URP volume post-processing silently no-ops in headless manual Camera.Render()"\nmetadata:\n  type: project\n  modified: 2026-07-27T06:26:58.386Z\n---\n\nComposite grades in image space and verify A/B deltas numerically.\n`,
    'utf8'
  );

  const collectedClaude = collectClaudeCodeSessions(
    winRepoPath,
    { branch: 'main', headCommit: 'abc1234', author: 'nars7' },
    fakeClaudeProjects
  );
  assert.equal(collectedClaude.length, 2, 'Should collect both main C-- project dir and --claude-worktrees dir');
  assert.equal(collectedClaude[0].title, 'Stylized Water Integration', 'Should parse customTitle from Claude session');

  const collectedMems = collectClaudeMemoryTakeaways(
    winRepoPath,
    { branch: 'main', headCommit: 'abc1234', author: 'nars7' },
    fakeClaudeProjects
  );
  assert.equal(collectedMems.length, 1, 'Should auto-harvest Claude memory/*.md files');
  assert.equal(collectedMems[0].id, 'claude-urp-volumes-dead-in-batch-captures');
  assert.equal(collectedMems[0].category, 'gotcha');
  console.log('   ✔ Windows C-- path slugs, worktrees, and Claude memory/*.md auto-import verified.');

  // 4. Test MCP Server over Stdio
  console.log('4. Testing MCP Server stdio JSON-RPC 2.0 tools...');
  // Run the CLI from source so tests never need (or overwrite) a build in dist/
  const cliPath = path.resolve('src/cli.ts');
  const tsxLoader = import.meta.resolve('tsx');
  const mcpProc = spawn(process.execPath, ['--import', tsxLoader, cliPath, 'mcp'], {
    cwd: laptopRepo,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const sendAndAwait = (msg: Record<string, any>): Promise<any> =>
    new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
        for (const l of lines) {
          try {
            const parsed = JSON.parse(l);
            if (parsed.id === msg.id) {
              mcpProc.stdout.off('data', onData);
              resolve(parsed);
            }
          } catch {
            // Continue
          }
        }
      };
      mcpProc.stdout.on('data', onData);
      mcpProc.stdin.write(`${JSON.stringify(msg)}\n`);
      setTimeout(() => reject(new Error(`Timeout waiting for MCP response to ${msg.method}`)), 5000);
    });

  const initResp = await sendAndAwait({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initResp.result.serverInfo.name, 'lore');

  const searchResp = await sendAndAwait({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'lore_search', arguments: { query: 'mutex' } },
  });
  const searchText = searchResp.result.content[0].text;
  assert.ok(searchText.includes('Fix JWT refresh race condition'), 'MCP lore_search should return desktop session');

  const sessionResp = await sendAndAwait({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'lore_get_session', arguments: { sessionId: 'desktop-' } },
  });
  assert.ok(sessionResp.result.content[0].text.includes('refreshPromise'), 'MCP lore_get_session should return full stripped dialogue');

  mcpProc.kill();
  console.log('   ✔ MCP Server (initialize, lore_search, lore_get_session) passed.');

  await runV015Tests({ tmpRoot, remoteBare, desktopRepo, laptopRepo, branch });
  await runV02Tests({ tmpRoot, remoteBare, desktopRepo, laptopRepo });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nALL E2E TESTS PASSED!');
}

function longSession(id: string, turnCount: number): SessionRecord {
  const turns: SessionRecord['turns'] = [];
  for (let i = 0; i < turnCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    turns.push({
      role,
      timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString(),
      text: role === 'user' ? `Prompt number ${i + 1} about topic ${i}` : `Reply number ${i + 1}`,
    });
  }
  return { ...makeSession(id, `Long session ${id}`, 'x'), turns, rawStepCount: turnCount };
}

async function runV02Tests(ctx: { tmpRoot: string; remoteBare: string; desktopRepo: string; laptopRepo: string }) {
  const { tmpRoot, remoteBare, desktopRepo, laptopRepo } = ctx;

  console.log('12. Testing chunked sessions: a growing session only rewrites its last chunk...');
  pullLoreFromRemote(desktopRepo, 'origin');
  const big = longSession('big-session', 120);
  saveLocalSession(desktopRepo, big);
  assert.equal(pushLoreToRemote(desktopRepo, 'origin').pushed, true);
  const bigPaths = treePaths(remoteBare, LORE_REF).filter((p) => p.startsWith('s2/big-session/')).sort();
  assert.deepEqual(bigPaths, ['s2/big-session/c0000.enc', 's2/big-session/c0001.enc', 's2/big-session/c0002.enc', 's2/big-session/meta.enc']);
  const manifest12 = JSON.parse(runGit(remoteBare, ['show', `${LORE_REF}:manifest.json`]));
  assert.equal(manifest12.format, 2, 'Manifest should declare format 2');
  const blobs12 = blobCount(remoteBare, LORE_REF);
  const grown = { ...big, turns: [...big.turns, { role: 'user' as const, timestamp: '2026-11-01T11:00:00Z', text: 'One more prompt' }], updatedAt: '2026-11-01T11:00:00Z' };
  saveLocalSession(desktopRepo, grown);
  assert.equal(pushLoreToRemote(desktopRepo, 'origin').pushed, true);
  assert.equal(blobCount(remoteBare, LORE_REF) - blobs12, 3, 'Growth should add only meta + last chunk + catalog');
  pullLoreFromRemote(laptopRepo, 'origin');
  const onLaptop = loadAllLocalSessions(laptopRepo).find((s) => s.id === 'big-session');
  assert.ok(onLaptop, 'Laptop should reassemble the chunked session');
  assert.equal(onLaptop!.turns.length, 121);
  assert.equal(onLaptop!.turns[120].text, 'One more prompt');
  console.log('   ✔ Sessions round-trip through chunks; growth touches only the last chunk.');

  console.log('13. Testing format-1 refs are read and migrated to format 2...');
  const legacyRemote = path.join(tmpRoot, 'legacy.git');
  const legacyRepo = path.join(tmpRoot, 'legacy-repo');
  fs.mkdirSync(legacyRemote, { recursive: true });
  runGit(legacyRemote, ['init', '--bare']);
  fs.mkdirSync(legacyRepo, { recursive: true });
  runGit(legacyRepo, ['init']);
  runGit(legacyRepo, ['config', 'user.name', 'Legacy']);
  runGit(legacyRepo, ['config', 'user.email', 'legacy@example.com']);
  runGit(legacyRepo, ['remote', 'add', 'origin', legacyRemote]);
  const me = ensureLocalIdentity();
  const recipients = [{ label: me.label, sshPublicKey: me.pubLine, fingerprint: me.fingerprint, addedAt: '2026-01-01T00:00:00Z' }];
  const legacySession = makeSession('legacy-session', 'Written by v0.1.x', 'Old format reply.');
  const idx = path.join(legacyRepo, '.git', 'legacy.index');
  const env = { GIT_INDEX_FILE: idx };
  const put = (p: string, content: string) => {
    const sha = runGit(legacyRepo, ['hash-object', '-w', '--stdin'], undefined, content);
    runGit(legacyRepo, ['update-index', '--add', '--cacheinfo', `100644,${sha},${p}`], env);
  };
  put('manifest.json', JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00Z', encryption: 'ssh-x25519-aes256gcm', recipients }));
  put('takeaways.enc', JSON.stringify(encryptForRecipients(JSON.stringify({ takeaways: [], indexMeta: [] }), recipients)));
  put('sessions/legacy-session.enc', JSON.stringify(encryptForRecipients(JSON.stringify(legacySession), recipients)));
  const legacyTree = runGit(legacyRepo, ['write-tree'], env);
  fs.rmSync(idx, { force: true });
  const legacyCommit = runGit(legacyRepo, ['commit-tree', legacyTree, '-m', 'v0.1 lore']);
  runGit(legacyRepo, ['push', 'origin', `${legacyCommit}:${LORE_REF}`]);
  assert.equal(pushLoreToRemote(legacyRepo, 'origin').pushed, true);
  assert.ok(loadAllLocalSessions(legacyRepo).some((s) => s.id === 'legacy-session'), 'Format-1 session imported');
  const migrated = treePaths(legacyRemote, LORE_REF);
  assert.ok(migrated.includes('s2/legacy-session/meta.enc'), 'Session rewritten in format 2');
  assert.ok(!migrated.some((p) => p.startsWith('sessions/')), 'Format-1 files removed after migration');
  console.log('   ✔ v0.1.x data is imported and migrated.');

  console.log('14. Testing turn ranges, outlines, and long-session defaults...');
  assert.deepEqual(resolveTurnRange(100, { last: 10 }), { from: 91, to: 100 });
  assert.deepEqual(resolveTurnRange(100, { from: 40, to: 45 }), { from: 40, to: 45 });
  assert.deepEqual(resolveTurnRange(100, { from: 95, to: 500 }), { from: 95, to: 100 });
  const outline = renderOutline(big);
  assert.ok(outline.startsWith('#1 ['), 'Outline lists turn numbers');
  assert.equal(outline.split('\n').length, 60, 'One outline line per user prompt');
  const smart = renderSessionMarkdown(big, { smartDefault: true });
  assert.ok(smart.includes('## Outline') && smart.includes('Turns 101–120 of 120'), 'Long sessions default to outline + tail');
  const stretch = renderSessionMarkdown(big, { from: 41, to: 42, smartDefault: true });
  assert.ok(stretch.includes('#41 User') && stretch.includes('#42 Assistant') && !stretch.includes('#43 '), 'from/to returns exactly that stretch');
  console.log('   ✔ Turn navigation works.');

  console.log('15. Testing tool-output snippets are captured and redacted...');
  const fakeClaude = path.join(tmpRoot, 'claude-projects-15');
  const repo15 = 'C:\\Users\\x\\Projects\\snip';
  const dir15 = path.join(fakeClaude, 'C--Users-x-Projects-snip');
  fs.mkdirSync(dir15, { recursive: true });
  fs.writeFileSync(
    path.join(dir15, 's15.jsonl'),
    [
      { sessionId: 's15', timestamp: '2026-11-01T10:00:00Z', type: 'user', message: { content: 'run the build' } },
      { sessionId: 's15', timestamp: '2026-11-01T10:00:01Z', type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'C:\\Users\\x\\Projects\\snip\\a.ts' } }] } },
      { sessionId: 's15', timestamp: '2026-11-01T10:00:02Z', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Build failed: 3 errors. API_KEY=supersecretvalue123' }, { type: 'tool_result', tool_use_id: 't2', content: 'export const fileContents = 1;' }] } },
      { sessionId: 's15', timestamp: '2026-11-01T10:00:03Z', type: 'assistant', message: { content: [{ type: 'text', text: 'The build has 3 errors.' }] } },
    ].map((e) => JSON.stringify(e)).join('\n'),
    'utf8'
  );
  const s15 = collectClaudeCodeSessions(repo15, { branch: 'main' }, fakeClaude)[0];
  const outputs = s15.turns.find((t) => t.role === 'assistant')?.toolOutputs ?? [];
  assert.equal(outputs.length, 1, 'Only command output kept (file reads skipped)');
  assert.ok(outputs[0].startsWith('Bash: Build failed: 3 errors.'), outputs[0]);
  assert.ok(outputs[0].includes('[REDACTED]') && !outputs[0].includes('supersecretvalue123'), 'Secrets in output are redacted');
  assert.ok(!outputs.join(' ').includes('fileContents'), 'File contents are not stored');
  console.log('   ✔ Command output kept, file reads skipped, secrets redacted.');

  console.log('16. Testing handoff notes...');
  const now = new Date('2026-11-05T12:00:00Z');
  const agySess = { ...makeSession('agy-1', 'Squirrel outline pass', 'Equalized outline widths to 2.8px.'), source: 'antigravity' as const, updatedAt: '2026-11-05T10:00:00Z' };
  const claudeOld = { ...makeSession('claude-1', 'Earlier Claude work', 'done'), updatedAt: '2026-11-05T08:00:00Z' };
  const note = buildHandoff([claudeOld, agySess], 'claude-code', { now });
  assert.ok(note && note.includes('Antigravity') && note.includes('2 hours ago') && note.includes('lore show agy-1'), note ?? 'null');
  assert.ok(note!.length < 1600, 'Handoff stays short');
  assert.equal(buildHandoff([agySess, { ...claudeOld, updatedAt: '2026-11-05T11:00:00Z' }], 'claude-code', { now }), null, 'No handoff when the latest work is in the same tool');
  assert.equal(buildHandoff([{ ...agySess, updatedAt: '2026-11-03T10:00:00Z' }], 'claude-code', { now }), null, 'No handoff for stale work');
  console.log('   ✔ Handoff only fires for recent work in another tool.');

  console.log('17. Testing search reports matching turn numbers...');
  saveLocalSession(laptopRepo, longSession('turn-search', 30));
  const marked = loadAllLocalSessions(laptopRepo).find((s) => s.id === 'turn-search')!;
  marked.turns[22] = { ...marked.turns[22], text: 'We chose the zanzibar caching strategy here' };
  saveLocalSession(laptopRepo, { ...marked, updatedAt: '2026-11-02T00:00:00Z' });
  refreshWorkspaceContextFiles(laptopRepo);
  const turnHit = searchLore(laptopRepo, 'zanzibar').find((h) => h.docId === 'turn-search');
  assert.ok(turnHit && turnHit.turns && turnHit.turns[0] === 23, `Expected turn 23, got ${JSON.stringify(turnHit?.turns)}`);
  console.log('   ✔ Search points at the matching turn.');

  console.log('18. Testing setup helpers: handoff hook toggling and instruction blocks...');
  const settings: Record<string, any> = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  applyHandoffHook(settings, 'C:\\npm\\cli.js', true);
  applyHandoffHook(settings, 'C:\\npm\\cli.js', true);
  const ours = settings.hooks.SessionStart.flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes('handoff --hook'));
  assert.equal(ours.length, 1, 'Hook added once');
  assert.equal(applyHandoffHook(settings, 'C:\\new\\cli.js', undefined), true, 'Unspecified keeps it on');
  assert.ok(JSON.stringify(settings).includes('C:/new/cli.js'), 'Path updated');
  applyHandoffHook(settings, 'C:\\npm\\cli.js', false);
  assert.ok(!JSON.stringify(settings).includes('handoff --hook'), 'Hook removed');
  assert.ok(JSON.stringify(settings).includes('echo mine'), "User's own hooks untouched");
  const md1 = upsertMarkedBlock('# Mine\n\nkeep me', CLAUDE_MD_BLOCK, '# Global');
  const md2 = upsertMarkedBlock(md1, CLAUDE_MD_BLOCK, '# Global');
  assert.equal(md1, md2, 'Re-running setup does not duplicate the block');
  assert.ok(md2.includes('keep me'));
  console.log('   ✔ Setup is idempotent and leaves user content alone.');

  console.log('19. Testing redaction of keys pasted in prose and new key formats...');
  // Fake keys built at runtime so this file never contains anything key-shaped
  const fakeAQ = `AQ.${'Ab3_x9Kq'.repeat(6)}z`;
  const fakeOpaque = `${'Zx81QwPl'.repeat(4)}`;
  const leaks = [
    `ok yeah so now we have access to nano banana programitically here is a key: ${fakeAQ} set up to billing`,
    `my api key is ${fakeOpaque}`,
    `token: "${fakeOpaque}"`,
    `export GEMINI_API_KEY=${fakeOpaque}`,
    `password - ${fakeOpaque}`,
  ];
  for (const l of leaks) {
    const red = redactSecrets(l);
    assert.ok(!red.includes(fakeAQ) && !red.includes(fakeOpaque), `Leaked through redaction: ${red}`);
  }
  assert.ok(redactSecrets(leaks[0]).includes('set up to billing'), 'Surrounding text is kept');
  const keep = [
    'tokens: 247,000,000 used so far',
    'api_key="YOUR_API_KEY_HERE"',
    'the key insight is that chunking keeps blobs stable',
    'key: src/collectors/antigravity.ts',
    'Authorized Keys    : 3',
  ];
  for (const k of keep) assert.equal(redactSecrets(k), k, `False positive: ${k}`);

  // Data stored before a rule existed is cleaned on the next sync, including tool summaries
  const leakyRepo = laptopRepo;
  const paths19 = path.join(leakyRepo, '.git', 'lore', 'sessions');
  const leaky = makeSession('leaky-session', 'Paste of a key', `here is a key: ${fakeAQ}`);
  leaky.turns[1].toolsUsed = [`run_command: setx GEMINI_API_KEY ${fakeOpaque}`];
  fs.writeFileSync(path.join(paths19, 'leaky-session.json'), JSON.stringify(leaky, null, 2), 'utf8'); // bypasses saveLocalSession
  assert.equal(pushLoreToRemote(leakyRepo, 'origin').pushed, true);
  const cached = fs.readFileSync(path.join(paths19, 'leaky-session.json'), 'utf8');
  assert.ok(!cached.includes(fakeAQ) && !cached.includes(fakeOpaque), 'Local cache is re-scrubbed before commit');
  const pushedMeta = runGit(remoteBare, ['show', `${LORE_REF}:s2/leaky-session/c0000.enc`]);
  const decrypted = decryptWithLocalIdentity(JSON.parse(pushedMeta));
  assert.ok(!decrypted.includes(fakeAQ) && !decrypted.includes(fakeOpaque), 'Pushed data contains no key');
  console.log('   ✔ Prose-pasted and new-format keys are redacted, old data is re-scrubbed, false alarms are left alone.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
