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
import {
  commitToGitRef,
  LORE_REF,
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
  const cliPath = path.resolve('dist/cli.js');
  const mcpProc = spawn('node', [cliPath, 'mcp'], {
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
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('   ✔ MCP Server (initialize, lore_search, lore_get_session) passed.');
  console.log('\nALL E2E TESTS PASSED!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
