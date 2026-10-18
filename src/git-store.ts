import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type {
  EncryptedEnvelope,
  LoreManifest,
  RecipientEntry,
  SessionIndexMeta,
  SessionRecord,
  TakeawayEntry,
} from './types.js';
import {
  decryptWithLocalIdentity,
  encryptForRecipients,
  ensureLocalIdentity,
} from './crypto.js';
import { collectAntigravitySessions } from './collectors/antigravity.js';
import { collectClaudeCodeSessions } from './collectors/claude.js';
import { collectCursorSessions } from './collectors/cursor.js';
import { collectCodexSessions } from './collectors/codex.js';
import { redactSecrets } from './redactor.js';

export const LORE_REF = 'refs/ai/lore';
export const LORE_REMOTE_REF = 'refs/remotes/origin/ai-lore';

export function runGit(repoRoot: string, args: string[], envOverride?: Record<string, string>, input?: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    env: { ...process.env, ...envOverride },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function tryGit(repoRoot: string, args: string[], envOverride?: Record<string, string>, input?: string): string | null {
  try {
    return runGit(repoRoot, args, envOverride, input);
  } catch {
    return null;
  }
}

export function findGitRoot(startDir = process.cwd()): string | null {
  return tryGit(startDir, ['rev-parse', '--show-toplevel']);
}

export function getGitMeta(repoRoot: string): { branch: string; headCommit: string; author: string } {
  const branch = tryGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const headCommit = tryGit(repoRoot, ['rev-parse', '--short', 'HEAD']) || '';
  const gitUser = tryGit(repoRoot, ['config', 'user.name']) || os.userInfo().username;
  return { branch, headCommit, author: gitUser };
}

export interface LocalLorePaths {
  gitDir: string;
  loreDir: string;
  manifestPath: string;
  takeawaysPath: string;
  sessionsDir: string;
  searchDbPath: string;
}

export function getLocalLorePaths(repoRoot: string): LocalLorePaths {
  const gitDirRaw = tryGit(repoRoot, ['rev-parse', '--git-dir']) || '.git';
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(repoRoot, gitDirRaw);
  const loreDir = path.join(gitDir, 'lore');
  const sessionsDir = path.join(loreDir, 'sessions');
  return {
    gitDir,
    loreDir,
    manifestPath: path.join(loreDir, 'manifest.json'),
    takeawaysPath: path.join(loreDir, 'takeaways.json'),
    sessionsDir,
    searchDbPath: path.join(loreDir, 'search.db'),
  };
}

export function ensureLocalLoreDirs(repoRoot: string): LocalLorePaths {
  const paths = getLocalLorePaths(repoRoot);
  fs.mkdirSync(paths.loreDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  return paths;
}

export function stripBom(str: string): string {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

export function loadManifest(repoRoot: string): LoreManifest {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (fs.existsSync(paths.manifestPath)) {
    try {
      return JSON.parse(stripBom(fs.readFileSync(paths.manifestPath, 'utf8')));
    } catch {
      // Fallthrough
    }
  }
  const identity = ensureLocalIdentity();
  const initial: LoreManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    encryption: 'ssh-x25519-aes256gcm',
    recipients: [
      {
        label: identity.label,
        sshPublicKey: identity.pubLine,
        fingerprint: identity.fingerprint,
        addedAt: new Date().toISOString(),
      },
    ],
  };
  saveManifest(repoRoot, initial);
  return initial;
}

export function saveManifest(repoRoot: string, manifest: LoreManifest): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

export function loadTakeaways(repoRoot: string): TakeawayEntry[] {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (!fs.existsSync(paths.takeawaysPath)) return [];
  try {
    return JSON.parse(stripBom(fs.readFileSync(paths.takeawaysPath, 'utf8')));
  } catch {
    return [];
  }
}

export function saveTakeaways(repoRoot: string, takeaways: TakeawayEntry[]): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  const byId = new Map<string, TakeawayEntry>();
  for (const t of takeaways) {
    byId.set(t.id, { ...t, content: redactSecrets(t.content) });
  }
  const sorted = Array.from(byId.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  fs.writeFileSync(paths.takeawaysPath, JSON.stringify(sorted, null, 2), 'utf8');
}

export function loadAllLocalSessions(repoRoot: string): SessionRecord[] {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (!fs.existsSync(paths.sessionsDir)) return [];
  const files = fs.readdirSync(paths.sessionsDir).filter((f) => f.endsWith('.json'));
  const records: SessionRecord[] = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(stripBom(fs.readFileSync(path.join(paths.sessionsDir, f), 'utf8'))) as SessionRecord;
      records.push(rec);
    } catch {
      // Ignore corrupt file
    }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveLocalSession(repoRoot: string, session: SessionRecord): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(paths.sessionsDir, `${safeId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8'))) as SessionRecord;
      // Only overwrite if incoming has >= turns or newer timestamp
      if (existing.turns.length > session.turns.length && existing.updatedAt > session.updatedAt) {
        return;
      }
    } catch {
      // Overwrite
    }
  }
  const scrubbed: SessionRecord = {
    ...session,
    title: redactSecrets(session.title),
    recap: redactSecrets(session.recap),
    turns: session.turns.map((t) => ({ ...t, text: redactSecrets(t.text) })),
  };
  fs.writeFileSync(filePath, JSON.stringify(scrubbed, null, 2), 'utf8');
}

/**
 * Collect local Antigravity and Claude Code sessions for this repo and merge into `.git/lore/sessions`.
 */
export function collectAndCacheLocalSessions(repoRoot: string): {
  collected: number;
  totalSessions: number;
  bytesSaved: number;
} {
  const meta = getGitMeta(repoRoot);
  const agy = collectAntigravitySessions(repoRoot, meta);
  const claude = collectClaudeCodeSessions(repoRoot, meta);
  const cursor = collectCursorSessions(repoRoot, meta);
  const codex = collectCodexSessions(repoRoot, meta);
  const allNew = [...agy, ...claude, ...cursor, ...codex];

  let bytesSaved = 0;
  for (const s of allNew) {
    saveLocalSession(repoRoot, s);
    bytesSaved += Math.max(0, s.originalBytes - s.compressedBytes);
  }
  const totalSessions = loadAllLocalSessions(repoRoot).length;
  return { collected: allNew.length, totalSessions, bytesSaved };
}

/**
 * Read a Git ref (`refs/ai/lore` or `refs/remotes/origin/ai-lore`), decrypt all envelopes,
 * and union-merge into `.git/lore/`.
 */
export function importFromGitRef(repoRoot: string, refName = LORE_REF): {
  importedSessions: number;
  importedTakeaways: number;
  decryptionError?: string;
} {
  const refSha = tryGit(repoRoot, ['rev-parse', '--verify', refName]);
  if (!refSha) {
    return { importedSessions: 0, importedTakeaways: 0 };
  }

  const identity = ensureLocalIdentity();

  // 1. Read manifest.json if present
  const remoteManifestRaw = tryGit(repoRoot, ['show', `${refSha}:manifest.json`]);
  if (remoteManifestRaw) {
    try {
      const remoteManifest = JSON.parse(remoteManifestRaw) as LoreManifest;
      const localManifest = loadManifest(repoRoot);
      const mergedRecipients = new Map<string, RecipientEntry>();
      for (const r of localManifest.recipients) mergedRecipients.set(r.fingerprint, r);
      for (const r of remoteManifest.recipients) mergedRecipients.set(r.fingerprint, r);
      localManifest.recipients = Array.from(mergedRecipients.values());
      saveManifest(repoRoot, localManifest);
    } catch {
      // Ignore malformed manifest
    }
  }

  let importedTakeaways = 0;
  let importedSessions = 0;
  let decryptionError: string | undefined;

  // 2. Read takeaways.enc
  const remoteTakeawaysRaw = tryGit(repoRoot, ['show', `${refSha}:takeaways.enc`]);
  if (remoteTakeawaysRaw) {
    try {
      const env = JSON.parse(remoteTakeawaysRaw) as EncryptedEnvelope;
      const decrypted = decryptWithLocalIdentity(env, identity);
      const parsed = JSON.parse(decrypted) as { takeaways?: TakeawayEntry[] };
      if (Array.isArray(parsed.takeaways)) {
        const current = loadTakeaways(repoRoot);
        saveTakeaways(repoRoot, [...current, ...parsed.takeaways]);
        importedTakeaways = parsed.takeaways.length;
      }
    } catch (err: any) {
      decryptionError = err.message;
    }
  }

  // 3. List sessions/*.enc in tree
  const treeLines = tryGit(repoRoot, ['ls-tree', '-r', '--name-only', refSha, 'sessions/']);
  if (treeLines) {
    for (const relPath of treeLines.split(/\r?\n/).filter((l) => l.endsWith('.enc'))) {
      const rawEnv = tryGit(repoRoot, ['show', `${refSha}:${relPath}`]);
      if (!rawEnv) continue;
      try {
        const env = JSON.parse(rawEnv) as EncryptedEnvelope;
        const decrypted = decryptWithLocalIdentity(env, identity);
        const session = JSON.parse(decrypted) as SessionRecord;
        saveLocalSession(repoRoot, session);
        importedSessions++;
      } catch (err: any) {
        decryptionError = err.message;
      }
    }
  }

  return { importedSessions, importedTakeaways, decryptionError };
}

/**
 * Commit all encrypted sessions, takeaways, and manifest into the hidden Git ref `refs/ai/lore`
 * using a temporary Git index so the user's working tree and staging area are never touched.
 */
export function commitToGitRef(repoRoot: string): {
  commitSha: string;
  sessionCount: number;
  takeawayCount: number;
  recipientCount: number;
} {
  const paths = ensureLocalLoreDirs(repoRoot);
  const manifest = loadManifest(repoRoot);
  const takeaways = loadTakeaways(repoRoot);
  const sessions = loadAllLocalSessions(repoRoot);

  const indexMeta: SessionIndexMeta[] = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    source: s.source,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
    branch: s.branch,
    headCommit: s.headCommit,
    author: s.author,
    deviceHostname: s.deviceHostname,
    filesTouched: s.filesTouched,
    recap: s.recap,
    turnCount: s.turns.length,
    originalBytes: s.originalBytes,
    compressedBytes: s.compressedBytes,
  }));

  const tempIndex = path.join(paths.loreDir, 'temp.git.index');
  if (fs.existsSync(tempIndex)) fs.unlinkSync(tempIndex);
  const env = { GIT_INDEX_FILE: tempIndex };

  const writeBlobToIndex = (repoRelPath: string, content: string) => {
    const sha = runGit(repoRoot, ['hash-object', '-w', '--stdin'], env, content);
    runGit(repoRoot, ['update-index', '--add', '--cacheinfo', `100644,${sha},${repoRelPath}`], env);
  };

  // 1. Write public manifest.json (recipient public keys + metadata)
  writeBlobToIndex('manifest.json', JSON.stringify(manifest, null, 2));

  // 2. Write encrypted takeaways + session catalog
  const takeawaysEnv = encryptForRecipients(
    JSON.stringify({ takeaways, indexMeta }),
    manifest.recipients
  );
  writeBlobToIndex('takeaways.enc', JSON.stringify(takeawaysEnv));

  // 3. Write each session as its own encrypted blob
  for (const session of sessions) {
    const safeId = session.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionEnv = encryptForRecipients(JSON.stringify(session), manifest.recipients);
    writeBlobToIndex(`sessions/${safeId}.enc`, JSON.stringify(sessionEnv));
  }

  const treeSha = runGit(repoRoot, ['write-tree'], env);
  if (fs.existsSync(tempIndex)) fs.unlinkSync(tempIndex);

  const parentSha = tryGit(repoRoot, ['rev-parse', '--verify', LORE_REF]);
  const commitArgs = ['commit-tree', treeSha, '-m', `lore sync (${sessions.length} sessions, ${takeaways.length} takeaways)`];
  if (parentSha) {
    commitArgs.push('-p', parentSha);
  }
  const commitSha = runGit(repoRoot, commitArgs);
  runGit(repoRoot, ['update-ref', LORE_REF, commitSha]);

  return {
    commitSha,
    sessionCount: sessions.length,
    takeawayCount: takeaways.length,
    recipientCount: manifest.recipients.length,
  };
}

/**
 * Fetch `refs/ai/lore` from remote, union-merge with local state, and update local ref.
 */
export function pullLoreFromRemote(repoRoot: string, remote = 'origin'): {
  fetched: boolean;
  importedSessions: number;
  importedTakeaways: number;
  decryptionError?: string;
} {
  const hasRemote = tryGit(repoRoot, ['remote', 'get-url', remote]);
  if (!hasRemote) {
    return { fetched: false, importedSessions: 0, importedTakeaways: 0 };
  }

  const fetchOut = tryGit(repoRoot, ['fetch', remote, `+${LORE_REF}:${LORE_REMOTE_REF}`]);
  if (fetchOut === null) {
    // Remote may not have refs/ai/lore yet
    return { fetched: false, importedSessions: 0, importedTakeaways: 0 };
  }

  const res = importFromGitRef(repoRoot, LORE_REMOTE_REF);
  if (!res.decryptionError) {
    commitToGitRef(repoRoot);
  }
  return {
    fetched: true,
    ...res,
  };
}

/**
 * Push `refs/ai/lore` to remote (`origin`).
 * First fetches & union-merges any remote sessions so pushes are always fast-forward / conflict-free!
 */
export function pushLoreToRemote(repoRoot: string, remote = 'origin'): {
  pushed: boolean;
  commitSha: string;
  sessionCount: number;
  takeawayCount: number;
} {
  pullLoreFromRemote(repoRoot, remote);
  collectAndCacheLocalSessions(repoRoot);
  const committed = commitToGitRef(repoRoot);

  const hasRemote = tryGit(repoRoot, ['remote', 'get-url', remote]);
  if (!hasRemote) {
    return { pushed: false, ...committed };
  }

  const pushRes = tryGit(repoRoot, ['push', '--force-with-lease', remote, `${LORE_REF}:${LORE_REF}`])
    ?? tryGit(repoRoot, ['push', '-f', remote, `${LORE_REF}:${LORE_REF}`]);

  return {
    pushed: pushRes !== null,
    ...committed,
  };
}
