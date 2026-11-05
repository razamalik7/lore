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
  // One new session blob, plus a new catalog blob (takeaways.enc lists sessions)
  assert.equal(blobsAfterOne - blobsBefore, 2, `Adding one session should add exactly 2 blobs (got ${blobsAfterOne - blobsBefore})`);
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
  assert.ok(paths6.includes('sessions/desktop-session-003.enc'), 'Remote keeps desktop session');
  assert.ok(paths6.includes('sessions/laptop-session-001.enc'), 'Remote has laptop session');
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
  assert.ok(!treePaths(remoteBare, LORE_REF).includes('sessions/desktop-session-002.enc'), 'Remote no longer holds it');
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
  const sessionsBefore = treePaths(remoteBare, LORE_REF).filter((p) => p.startsWith('sessions/')).length;
  const compacted = compactLoreRef(desktopRepo, 'origin');
  assert.equal(compacted.pushed, true, `Compact should replace the remote (${compacted.error ?? ''})`);
  assert.equal(runGit(remoteBare, ['rev-list', '--count', LORE_REF]), '1');
  assert.equal(
    treePaths(remoteBare, LORE_REF).filter((p) => p.startsWith('sessions/')).length,
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
  const latestSession = runGit(remoteBare, ['show', `${LORE_REF}:sessions/desktop-session-004.enc`]);
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

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nALL E2E TESTS PASSED!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
