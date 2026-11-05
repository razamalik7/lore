import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type {
  EncryptedEnvelope,
  LoreManifest,
  RecipientEntry,
  SessionIndexMeta,
  SessionRecord,
  TakeawayEntry,
  TombstoneEntry,
} from './types.js';
import {
  decryptWithLocalIdentity,
  encryptForRecipients,
  ensureLocalIdentity,
  getAllLocalIdentities,
} from './crypto.js';
import { collectAntigravitySessions } from './collectors/antigravity.js';
import { collectClaudeCodeSessions, collectClaudeMemoryTakeaways } from './collectors/claude.js';
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
  tombstonesPath: string;
  blobCachePath: string;
  hookLogPath: string;
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
    tombstonesPath: path.join(loreDir, 'tombstones.json'),
    blobCachePath: path.join(loreDir, 'blob-cache.json'),
    hookLogPath: path.join(loreDir, 'hook.log'),
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
  ensureLocalIdentity(repoRoot);
  const localIdentities = getAllLocalIdentities();

  if (fs.existsSync(paths.manifestPath)) {
    try {
      const existing = JSON.parse(stripBom(fs.readFileSync(paths.manifestPath, 'utf8'))) as LoreManifest;
      let changed = false;
      for (const id of localIdentities) {
        if (
          !existing.recipients.some((r) => r.fingerprint === id.fingerprint) &&
          !(existing.revoked ?? []).some((r) => r.fingerprint === id.fingerprint)
        ) {
          existing.recipients.push({
            label: id.label,
            sshPublicKey: id.pubLine,
            fingerprint: id.fingerprint,
            addedAt: new Date().toISOString(),
          });
          changed = true;
        }
      }
      if (changed) saveManifest(repoRoot, existing);
      return existing;
    } catch {
      // Fallthrough
    }
  }

  const now = new Date().toISOString();
  const initial: LoreManifest = {
    version: 1,
    updatedAt: now,
    encryption: 'ssh-x25519-aes256gcm',
    recipients: localIdentities.map((id) => ({
      label: id.label,
      sshPublicKey: id.pubLine,
      fingerprint: id.fingerprint,
      addedAt: now,
    })),
  };
  saveManifest(repoRoot, initial);
  return initial;
}

/** Union of revoke lists, keeping the latest revoke time per key, sorted for stable bytes. */
export function mergeRevoked(
  ...lists: Array<LoreManifest['revoked'] | undefined>
): Array<{ fingerprint: string; at: string }> {
  const latest = new Map<string, string>();
  for (const list of lists) {
    for (const r of list ?? []) {
      if (!r || typeof r.fingerprint !== 'string') continue;
      const prev = latest.get(r.fingerprint);
      if (!prev || r.at > prev) latest.set(r.fingerprint, r.at);
    }
  }
  return Array.from(latest.entries())
    .map(([fingerprint, at]) => ({ fingerprint, at }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export function saveManifest(repoRoot: string, manifest: LoreManifest): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Tombstones (forgotten sessions / takeaways)
// ---------------------------------------------------------------------------

export function loadTombstones(repoRoot: string): TombstoneEntry[] {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (!fs.existsSync(paths.tombstonesPath)) return [];
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(paths.tombstonesPath, 'utf8')));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTombstones(repoRoot: string, tombstones: TombstoneEntry[]): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  const byKey = new Map<string, TombstoneEntry>();
  for (const t of tombstones) {
    if (!t || typeof t.id !== 'string') continue;
    const key = `${t.kind}:${t.id}`;
    if (!byKey.has(key)) byKey.set(key, t);
  }
  const sorted = Array.from(byKey.values()).sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)
  );
  writeFileIfChanged(paths.tombstonesPath, JSON.stringify(sorted, null, 2));
}

function tombstonedIds(repoRoot: string, kind: TombstoneEntry['kind']): Set<string> {
  return new Set(loadTombstones(repoRoot).filter((t) => t.kind === kind).map((t) => t.id));
}

function safeSessionFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Delete local copies of anything that has a tombstone. */
function applyTombstones(repoRoot: string): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  const tombs = loadTombstones(repoRoot);
  for (const t of tombs.filter((x) => x.kind === 'session')) {
    const filePath = path.join(paths.sessionsDir, `${safeSessionFileId(t.id)}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const deadTakeaways = new Set(tombs.filter((x) => x.kind === 'takeaway').map((x) => x.id));
  if (deadTakeaways.size > 0 && fs.existsSync(paths.takeawaysPath)) {
    const kept = loadTakeaways(repoRoot).filter((t) => !deadTakeaways.has(t.id));
    writeFileIfChanged(paths.takeawaysPath, JSON.stringify(kept, null, 2));
  }
}

/**
 * Forget sessions and/or takeaways by full id. Records tombstones so the deletion
 * propagates to other devices, and so collectors don't re-add them.
 */
export function forgetItems(
  repoRoot: string,
  items: Array<{ id: string; kind: TombstoneEntry['kind'] }>,
  by: string
): void {
  const now = new Date().toISOString();
  saveTombstones(repoRoot, [
    ...loadTombstones(repoRoot),
    ...items.map((i) => ({ id: i.id, kind: i.kind, at: now, by })),
  ]);
  applyTombstones(repoRoot);
}

// ---------------------------------------------------------------------------
// Takeaways and sessions (local cache in .git/lore/)
// ---------------------------------------------------------------------------

function writeFileIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    try {
      if (fs.readFileSync(filePath, 'utf8') === content) return false;
    } catch {
      // Overwrite
    }
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
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
  const dead = tombstonedIds(repoRoot, 'takeaway');
  const byId = new Map<string, TakeawayEntry>();
  for (const t of takeaways) {
    if (dead.has(t.id)) continue;
    byId.set(t.id, { ...t, content: redactSecrets(t.content) });
  }
  const sorted = Array.from(byId.values()).sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
  );
  writeFileIfChanged(paths.takeawaysPath, JSON.stringify(sorted, null, 2));
}

export function loadAllLocalSessions(repoRoot: string): SessionRecord[] {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (!fs.existsSync(paths.sessionsDir)) return [];
  const dead = tombstonedIds(repoRoot, 'session');
  const files = fs.readdirSync(paths.sessionsDir).filter((f) => f.endsWith('.json'));
  const records: SessionRecord[] = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(stripBom(fs.readFileSync(path.join(paths.sessionsDir, f), 'utf8'))) as SessionRecord;
      if (dead.has(rec.id)) continue;
      records.push(rec);
    } catch {
      // Ignore corrupt file
    }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/**
 * Save a session into the local cache. Returns false if it was skipped (forgotten, or an older copy).
 *
 * The branch and commit a session was first seen on are kept: collectors stamp sessions with the
 * *current* HEAD, so without this every sync would relabel old sessions and change their bytes.
 */
export function saveLocalSession(repoRoot: string, session: SessionRecord): boolean {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (tombstonedIds(repoRoot, 'session').has(session.id)) return false;
  const filePath = path.join(paths.sessionsDir, `${safeSessionFileId(session.id)}.json`);
  let existing: SessionRecord | null = null;
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8'))) as SessionRecord;
      // Only overwrite if incoming has >= turns or newer timestamp
      if (existing.turns.length > session.turns.length && existing.updatedAt > session.updatedAt) {
        return false;
      }
    } catch {
      existing = null;
    }
  }
  const scrubbed: SessionRecord = {
    ...session,
    branch: existing?.branch ?? session.branch,
    headCommit: existing?.headCommit ?? session.headCommit,
    title: redactSecrets(session.title),
    recap: redactSecrets(session.recap),
    turns: session.turns.map((t) => ({
      ...t,
      text: redactSecrets(t.text),
      ...(t.toolOutputs ? { toolOutputs: t.toolOutputs.map((o) => redactSecrets(o)) } : {}),
    })),
  };
  scrubbed.compressedBytes = Buffer.byteLength(JSON.stringify({ ...scrubbed, compressedBytes: 0 }), 'utf8');
  writeFileIfChanged(filePath, JSON.stringify(scrubbed, null, 2));
  return true;
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
  const allNew = collectAllLocalSessions(repoRoot, meta);

  let bytesSaved = 0;
  for (const s of allNew) {
    saveLocalSession(repoRoot, s);
    bytesSaved += Math.max(0, s.originalBytes - s.compressedBytes);
  }

  try {
    const claudeMemories = collectClaudeMemoryTakeaways(repoRoot, meta);
    if (claudeMemories.length > 0) {
      const existingTakeaways = loadTakeaways(repoRoot);
      // Memory files carry no stable commit; keep the first one recorded so the takeaway doesn't change every sync
      const existingById = new Map(existingTakeaways.map((t) => [t.id, t]));
      const stabilized = claudeMemories.map((m) => {
        const prev = existingById.get(m.id);
        return prev ? { ...m, commitSha: prev.commitSha, author: prev.author } : m;
      });
      saveTakeaways(repoRoot, [...existingTakeaways, ...stabilized]);
    }
  } catch {
    // Ignore memory collection errors
  }

  const totalSessions = loadAllLocalSessions(repoRoot).length;
  return { collected: allNew.length, totalSessions, bytesSaved };
}

function collectAllLocalSessions(
  repoRoot: string,
  meta: { branch?: string; headCommit?: string; author?: string }
): SessionRecord[] {
  const agy = collectAntigravitySessions(repoRoot, meta);
  const claude = collectClaudeCodeSessions(repoRoot, meta);
  const cursor = collectCursorSessions(repoRoot, meta);
  const codex = collectCodexSessions(repoRoot, meta);
  return [...agy, ...claude, ...cursor, ...codex];
}

/**
 * Sessions recorded from this device that its collectors no longer attribute to this repo.
 * These are usually sessions that older lore versions filed here by mistake
 * (or whose original transcript has since been deleted).
 */
export function findMisfiledSessions(repoRoot: string): SessionRecord[] {
  const meta = getGitMeta(repoRoot);
  const currentIds = new Set(collectAllLocalSessions(repoRoot, meta).map((s) => s.id));
  const host = os.hostname();
  return loadAllLocalSessions(repoRoot).filter(
    (s) => s.source !== 'manual' && s.deviceHostname === host && !currentIds.has(s.id)
  );
}

// ---------------------------------------------------------------------------
// Encryption cache: reuse encrypted blobs for unchanged payloads
// ---------------------------------------------------------------------------

/**
 * Every encryption uses fresh random keys, so re-encrypting an unchanged session produces new bytes
 * and Git stores a full new copy. This cache remembers, per path in the ref, a fingerprint of the
 * plaintext + recipients and the blob that already holds it, so unchanged payloads reuse that blob.
 * It lives only in .git/lore/ (fingerprints of plaintext must never be published).
 */
interface BlobCache {
  v: 1;
  entries: Record<string, { key: string; blob: string }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function payloadKey(payload: unknown, recipientFps: string[]): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(payload))
    .update('|')
    .update([...recipientFps].sort().join(','))
    .digest('hex');
}

function loadBlobCache(repoRoot: string): BlobCache {
  const paths = ensureLocalLoreDirs(repoRoot);
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(paths.blobCachePath, 'utf8')));
    if (parsed && parsed.v === 1 && parsed.entries) return parsed;
  } catch {
    // Missing or corrupt
  }
  return { v: 1, entries: {} };
}

function saveBlobCache(repoRoot: string, cache: BlobCache): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  writeFileIfChanged(paths.blobCachePath, JSON.stringify(cache));
}

function existingBlobs(repoRoot: string, shas: string[]): Set<string> {
  const unique = Array.from(new Set(shas));
  if (unique.length === 0) return new Set();
  const out = tryGit(repoRoot, ['cat-file', '--batch-check'], undefined, `${unique.join('\n')}\n`) || '';
  const present = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const [sha, type] = line.split(' ');
    if (type === 'blob') present.add(sha);
  }
  return present;
}

// ---------------------------------------------------------------------------
// Reading the ref
// ---------------------------------------------------------------------------

/**
 * Data layout version written by this client.
 * 1: one encrypted blob per session at `sessions/<id>.enc` (v0.1.x).
 * 2: each session split into `s2/<id>/meta.enc` (everything but turns) plus fixed-size turn chunks
 *    `s2/<id>/c0000.enc`, `c0001.enc`, ... so a growing session only rewrites its last chunk.
 *    Format-1 refs are still read; they're migrated to format 2 on the next write.
 */
export const LORE_FORMAT = 2;
export const TURNS_PER_CHUNK = 50;

const LEGACY_SESSION_PATH = /^sessions\/[^/]+\.enc$/;
const S2_PATH = /^s2\/([^/]+)\/(meta|c(\d{4,}))\.enc$/;

/** Paths this client owns in the ref tree. Anything else was written by a newer client and is carried over untouched. */
function isKnownTreePath(p: string): boolean {
  return p === 'manifest.json' || p === 'takeaways.enc' || LEGACY_SESSION_PATH.test(p) || S2_PATH.test(p);
}

interface SessionMetaPayload extends Omit<SessionRecord, 'turns'> {
  turnCount: number;
  chunkCount: number;
  turnsPerChunk: number;
}

interface SessionChunkPayload {
  sessionId: string;
  index: number;
  turns: SessionRecord['turns'];
}

function splitSession(session: SessionRecord): { meta: SessionMetaPayload; chunks: SessionChunkPayload[] } {
  const { turns, ...rest } = session;
  const chunks: SessionChunkPayload[] = [];
  for (let i = 0; i * TURNS_PER_CHUNK < turns.length; i++) {
    chunks.push({ sessionId: session.id, index: i, turns: turns.slice(i * TURNS_PER_CHUNK, (i + 1) * TURNS_PER_CHUNK) });
  }
  return {
    meta: { ...rest, turnCount: turns.length, chunkCount: chunks.length, turnsPerChunk: TURNS_PER_CHUNK },
    chunks,
  };
}

function chunkFileName(index: number): string {
  return `c${String(index).padStart(4, '0')}.enc`;
}

function readRefFormat(repoRoot: string, commitSha: string): number {
  const raw = tryGit(repoRoot, ['show', `${commitSha}:manifest.json`]);
  if (!raw) return 1;
  try {
    const m = JSON.parse(stripBom(raw)) as LoreManifest;
    return typeof m.format === 'number' ? m.format : 1;
  } catch {
    return 1;
  }
}

export class NewerFormatError extends Error {
  constructor(found: number) {
    super(
      `This repo's lore data uses format ${found}, which is newer than this version of lore understands (format ${LORE_FORMAT}). ` +
        `Upgrade with: npm i -g git-lore-cli@latest`
    );
    this.name = 'NewerFormatError';
  }
}

function listTree(repoRoot: string, commitSha: string): Array<{ mode: string; sha: string; path: string }> {
  const out = tryGit(repoRoot, ['ls-tree', '-r', commitSha]) || '';
  const entries: Array<{ mode: string; sha: string; path: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/);
    if (m) entries.push({ mode: m[1], sha: m[2], path: m[3] });
  }
  return entries;
}

/**
 * Read a Git ref (`refs/ai/lore` or `refs/remotes/origin/ai-lore`), decrypt all envelopes,
 * and union-merge into `.git/lore/`.
 */
export function importFromGitRef(repoRoot: string, refName = LORE_REF): {
  importedSessions: number;
  importedTakeaways: number;
  decryptionError?: string;
  newerFormat?: number;
} {
  const refSha = tryGit(repoRoot, ['rev-parse', '--verify', refName]);
  if (!refSha) {
    return { importedSessions: 0, importedTakeaways: 0 };
  }

  ensureLocalIdentity(repoRoot);
  const format = readRefFormat(repoRoot, refSha);
  const newerFormat = format > LORE_FORMAT ? format : undefined;

  // 1. Read manifest.json if present
  const remoteManifestRaw = tryGit(repoRoot, ['show', `${refSha}:manifest.json`]);
  if (remoteManifestRaw) {
    try {
      const remoteManifest = JSON.parse(stripBom(remoteManifestRaw)) as LoreManifest;
      const localManifest = loadManifest(repoRoot);
      // Same key on both sides: keep the earliest entry, so every device converges on identical bytes
      const revoked = mergeRevoked(localManifest.revoked, remoteManifest.revoked);
      const revokedAt = new Map(revoked.map((r) => [r.fingerprint, r.at]));
      const mergedRecipients = new Map<string, RecipientEntry>();
      for (const r of [...localManifest.recipients, ...remoteManifest.recipients]) {
        const revokeTime = revokedAt.get(r.fingerprint);
        if (revokeTime && (r.addedAt || '') <= revokeTime) continue;
        const prev = mergedRecipients.get(r.fingerprint);
        if (!prev || (r.addedAt || '') < (prev.addedAt || '')) mergedRecipients.set(r.fingerprint, r);
      }
      const merged = Array.from(mergedRecipients.values());
      if (
        merged.length > 0 &&
        (JSON.stringify(merged) !== JSON.stringify(localManifest.recipients) ||
          JSON.stringify(revoked) !== JSON.stringify(localManifest.revoked ?? []))
      ) {
        localManifest.recipients = merged;
        if (revoked.length > 0) localManifest.revoked = revoked;
        saveManifest(repoRoot, localManifest);
      }
    } catch {
      // Ignore malformed manifest
    }
  }

  let importedTakeaways = 0;
  let importedSessions = 0;
  let decryptionError: string | undefined;
  const cache = loadBlobCache(repoRoot);
  const tree = listTree(repoRoot, refSha);
  const blobAt = new Map(tree.map((e) => [e.path, e.sha]));

  // 2. Read takeaways.enc (takeaways + tombstones). Tombstones are applied before sessions are imported.
  const remoteTakeawaysRaw = tryGit(repoRoot, ['show', `${refSha}:takeaways.enc`]);
  if (remoteTakeawaysRaw) {
    try {
      const env = JSON.parse(remoteTakeawaysRaw) as EncryptedEnvelope;
      const decrypted = decryptWithLocalIdentity(env);
      const parsed = JSON.parse(decrypted) as {
        takeaways?: TakeawayEntry[];
        tombstones?: TombstoneEntry[];
      };
      if (Array.isArray(parsed.tombstones) && parsed.tombstones.length > 0) {
        saveTombstones(repoRoot, [...loadTombstones(repoRoot), ...parsed.tombstones]);
        applyTombstones(repoRoot);
      }
      if (Array.isArray(parsed.takeaways)) {
        const current = loadTakeaways(repoRoot);
        saveTakeaways(repoRoot, [...current, ...parsed.takeaways]);
        importedTakeaways = parsed.takeaways.length;
      }
      const sha = blobAt.get('takeaways.enc');
      if (sha) cache.entries['takeaways.enc'] = { key: payloadKey(parsed, env.wraps.map((w) => w.fp)), blob: sha };
    } catch (err: any) {
      decryptionError = err.message;
    }
  }

  const decryptBlob = <T>(entry: { path: string; sha: string }): T => {
    const rawEnv = tryGit(repoRoot, ['cat-file', 'blob', entry.sha]);
    if (!rawEnv) throw new Error(`Missing blob for ${entry.path}`);
    const env = JSON.parse(rawEnv) as EncryptedEnvelope;
    const payload = JSON.parse(decryptWithLocalIdentity(env)) as T;
    cache.entries[entry.path] = { key: payloadKey(payload, env.wraps.map((w) => w.fp)), blob: entry.sha };
    return payload;
  };

  // 3a. Format-1 sessions (one blob each)
  for (const entry of tree.filter((e) => LEGACY_SESSION_PATH.test(e.path))) {
    try {
      const session = decryptBlob<SessionRecord>(entry);
      if (saveLocalSession(repoRoot, session)) importedSessions++;
    } catch (err: any) {
      decryptionError = err.message;
    }
  }

  // 3b. Format-2 sessions (meta + turn chunks)
  const s2 = new Map<string, { meta?: { path: string; sha: string }; chunks: Map<number, { path: string; sha: string }> }>();
  for (const entry of tree) {
    const m = entry.path.match(S2_PATH);
    if (!m) continue;
    const group = s2.get(m[1]) ?? { meta: undefined, chunks: new Map<number, { path: string; sha: string }>() };
    if (m[2] === 'meta') group.meta = entry;
    else group.chunks.set(Number(m[3]), entry);
    s2.set(m[1], group);
  }
  for (const [dirId, group] of s2) {
    try {
      if (!group.meta) throw new Error(`Session ${dirId} has turn chunks but no meta.enc`);
      const meta = decryptBlob<SessionMetaPayload>(group.meta);
      const turns: SessionRecord['turns'] = [];
      for (let i = 0; i < meta.chunkCount; i++) {
        const chunkEntry = group.chunks.get(i);
        if (!chunkEntry) throw new Error(`Session ${meta.id} is missing turn chunk ${i}`);
        const chunk = decryptBlob<SessionChunkPayload>(chunkEntry);
        turns.push(...chunk.turns);
      }
      const { turnCount, chunkCount, turnsPerChunk, ...rest } = meta;
      void chunkCount;
      void turnsPerChunk;
      if (turns.length !== turnCount) throw new Error(`Session ${meta.id} has ${turns.length} turns, expected ${turnCount}`);
      if (saveLocalSession(repoRoot, { ...rest, turns } as SessionRecord)) importedSessions++;
    } catch (err: any) {
      decryptionError = err.message;
    }
  }

  saveBlobCache(repoRoot, cache);
  return { importedSessions, importedTakeaways, decryptionError, newerFormat };
}

// ---------------------------------------------------------------------------
// Writing the ref
// ---------------------------------------------------------------------------

/**
 * Commit all encrypted sessions, takeaways, and manifest into the hidden Git ref `refs/ai/lore`
 * using a temporary Git index so the user's working tree and staging area are never touched.
 *
 * - Unchanged payloads reuse their existing encrypted blobs (see BlobCache).
 * - `remoteParent` (the fetched remote commit) becomes the only parent. The remote's data has already
 *   been merged into the local cache, so building on top of it makes the push a plain fast-forward,
 *   and local-only history (e.g. from before a `lore compact`) is never re-attached.
 * - Without a remote, the commit builds on the local ref.
 * - No commit is made when nothing changed.
 * - `noParent` writes a fresh root commit (used by `lore compact`).
 */
export function commitToGitRef(
  repoRoot: string,
  opts: { remoteParent?: string | null; noParent?: boolean } = {}
): {
  commitSha: string;
  sessionCount: number;
  takeawayCount: number;
  recipientCount: number;
  changed: boolean;
} {
  const paths = ensureLocalLoreDirs(repoRoot);
  const manifest = loadManifest(repoRoot);
  const takeaways = loadTakeaways(repoRoot);
  const sessions = loadAllLocalSessions(repoRoot);
  const tombstones = loadTombstones(repoRoot);

  const localSha = tryGit(repoRoot, ['rev-parse', '--verify', LORE_REF]);
  const remoteSha = opts.remoteParent || null;
  // Remote first: when both hold a file this version doesn't understand, the remote's copy wins
  const mergeSources = Array.from(new Set([remoteSha, localSha].filter((c): c is string => Boolean(c))));
  for (const p of mergeSources) {
    const f = readRefFormat(repoRoot, p);
    if (f > LORE_FORMAT) throw new NewerFormatError(f);
  }
  const base = remoteSha ?? localSha;
  const parents = opts.noParent || !base ? [] : [base];

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

  const recipientFps = manifest.recipients.map((r) => r.fingerprint);
  const cache = loadBlobCache(repoRoot);
  const cachedShas = Object.values(cache.entries).map((e) => e.blob);
  const present = existingBlobs(repoRoot, cachedShas);
  const nextCache: BlobCache = { v: 1, entries: {} };
  const indexLines: string[] = [];

  const addEncrypted = (repoRelPath: string, payload: unknown) => {
    const key = payloadKey(payload, recipientFps);
    const hit = cache.entries[repoRelPath];
    let sha: string;
    if (hit && hit.key === key && present.has(hit.blob)) {
      sha = hit.blob;
    } else {
      const env = encryptForRecipients(JSON.stringify(payload), manifest.recipients);
      sha = runGit(repoRoot, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(env));
    }
    nextCache.entries[repoRelPath] = { key, blob: sha };
    indexLines.push(`100644 ${sha}\t${repoRelPath}`);
  };

  // 1. Public manifest.json (recipient public keys + metadata). Its timestamp is left out of
  //    the stored copy so it doesn't change on every sync.
  const storedManifest: LoreManifest = {
    version: 1,
    format: LORE_FORMAT,
    updatedAt: '',
    encryption: manifest.encryption,
    recipients: [...manifest.recipients].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    ...(manifest.revoked && manifest.revoked.length > 0 ? { revoked: mergeRevoked(manifest.revoked) } : {}),
  };
  const manifestSha = runGit(
    repoRoot,
    ['hash-object', '-w', '--stdin'],
    undefined,
    JSON.stringify(storedManifest, null, 2)
  );
  indexLines.push(`100644 ${manifestSha}\tmanifest.json`);

  // 2. Encrypted takeaways + session catalog + tombstones
  addEncrypted('takeaways.enc', { takeaways, indexMeta, tombstones });

  // 3. Each session as a small meta blob plus fixed-size turn chunks (format 2).
  //    Format-1 `sessions/*.enc` files from older refs are not carried over: their data was imported above.
  const writtenPaths = new Set(['manifest.json', 'takeaways.enc']);
  const writtenSessionDirs = new Set<string>();
  for (const session of sessions) {
    const dir = `s2/${safeSessionFileId(session.id)}`;
    if (writtenSessionDirs.has(dir)) continue;
    writtenSessionDirs.add(dir);
    const { meta, chunks } = splitSession(session);
    writtenPaths.add(`${dir}/meta.enc`);
    addEncrypted(`${dir}/meta.enc`, meta);
    for (const chunk of chunks) {
      const p = `${dir}/${chunkFileName(chunk.index)}`;
      writtenPaths.add(p);
      addEncrypted(p, chunk);
    }
  }

  // 4. Carry over files written by newer clients that this version doesn't understand
  for (const source of mergeSources) {
    for (const entry of listTree(repoRoot, source)) {
      if (isKnownTreePath(entry.path) || writtenPaths.has(entry.path)) continue;
      writtenPaths.add(entry.path);
      indexLines.push(`${entry.mode} ${entry.sha}\t${entry.path}`);
    }
  }

  const tempIndex = path.join(paths.loreDir, 'temp.git.index');
  if (fs.existsSync(tempIndex)) fs.unlinkSync(tempIndex);
  const env = { GIT_INDEX_FILE: tempIndex };
  runGit(repoRoot, ['update-index', '--add', '--index-info'], env, `${indexLines.join('\n')}\n`);
  const treeSha = runGit(repoRoot, ['write-tree'], env);
  if (fs.existsSync(tempIndex)) fs.unlinkSync(tempIndex);
  saveBlobCache(repoRoot, nextCache);

  const result = {
    sessionCount: sessions.length,
    takeawayCount: takeaways.length,
    recipientCount: manifest.recipients.length,
  };

  // Nothing changed: keep (or fast-forward to) the single existing parent
  if (parents.length === 1) {
    const parentTree = tryGit(repoRoot, ['rev-parse', `${parents[0]}^{tree}`]);
    if (parentTree === treeSha) {
      if (parents[0] !== localSha) runGit(repoRoot, ['update-ref', LORE_REF, parents[0]]);
      return { commitSha: parents[0], changed: false, ...result };
    }
  }

  const commitArgs = ['commit-tree', treeSha, '-m', `lore sync (${sessions.length} sessions, ${takeaways.length} takeaways)`];
  for (const p of parents) commitArgs.push('-p', p);
  const gitUserName = tryGit(repoRoot, ['config', 'user.name']) || os.userInfo().username || 'lore';
  const gitUserEmail = tryGit(repoRoot, ['config', 'user.email']) || `${gitUserName}@localhost`;
  const commitEnv = {
    GIT_AUTHOR_NAME: gitUserName,
    GIT_AUTHOR_EMAIL: gitUserEmail,
    GIT_COMMITTER_NAME: gitUserName,
    GIT_COMMITTER_EMAIL: gitUserEmail,
  };
  const commitSha = runGit(repoRoot, commitArgs, commitEnv);
  runGit(repoRoot, ['update-ref', LORE_REF, commitSha]);

  return { commitSha, changed: true, ...result };
}

// ---------------------------------------------------------------------------
// Remote sync
// ---------------------------------------------------------------------------

/** Fetch the remote lore ref. Returns its commit, or null if the remote has none (or is unreachable). */
function fetchRemoteLore(repoRoot: string, remote: string): string | null {
  const remoteRef = remoteTrackingRef(remote);
  const fetchOut = tryGit(repoRoot, ['fetch', '--no-tags', remote, `+${LORE_REF}:${remoteRef}`]);
  if (fetchOut === null) return null;
  return tryGit(repoRoot, ['rev-parse', '--verify', remoteRef]);
}

function remoteTrackingRef(remote: string): string {
  return remote === 'origin' ? LORE_REMOTE_REF : `refs/remotes/${remote}/ai-lore`;
}

/**
 * Fetch `refs/ai/lore` from remote, union-merge with local state, and update local ref.
 */
export function pullLoreFromRemote(
  repoRoot: string,
  remote = 'origin',
  opts: { commit?: boolean } = {}
): {
  fetched: boolean;
  importedSessions: number;
  importedTakeaways: number;
  decryptionError?: string;
  newerFormat?: number;
  remoteSha: string | null;
} {
  const hasRemote = tryGit(repoRoot, ['remote', 'get-url', remote]);
  if (!hasRemote) {
    return { fetched: false, importedSessions: 0, importedTakeaways: 0, remoteSha: null };
  }

  const remoteSha = fetchRemoteLore(repoRoot, remote);
  if (!remoteSha) {
    // Remote may not have refs/ai/lore yet
    return { fetched: false, importedSessions: 0, importedTakeaways: 0, remoteSha: null };
  }

  const res = importFromGitRef(repoRoot, remoteTrackingRef(remote));
  if (opts.commit !== false && !res.decryptionError && !res.newerFormat) {
    commitToGitRef(repoRoot, { remoteParent: remoteSha });
  }
  return { fetched: true, ...res, remoteSha };
}

/**
 * Push `refs/ai/lore` to remote (`origin`).
 * Fetches and merges the remote first, and records the remote commit as a parent, so the push is a
 * plain fast-forward. Never force-pushes: if another device pushed in between, it merges again and retries.
 */
export function pushLoreToRemote(repoRoot: string, remote = 'origin'): {
  pushed: boolean;
  commitSha: string;
  sessionCount: number;
  takeawayCount: number;
  error?: string;
} {
  const hasRemote = tryGit(repoRoot, ['remote', 'get-url', remote]);
  let committed: ReturnType<typeof commitToGitRef> | null = null;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    const pull = pullLoreFromRemote(repoRoot, remote, { commit: false });
    if (pull.newerFormat) throw new NewerFormatError(pull.newerFormat);
    if (pull.decryptionError) {
      // Committing now would drop whatever we couldn't decrypt from the remote
      throw new Error(`Could not decrypt remote lore data: ${pull.decryptionError}`);
    }
    if (attempt === 0) collectAndCacheLocalSessions(repoRoot);
    committed = commitToGitRef(repoRoot, { remoteParent: pull.remoteSha });

    if (!hasRemote) {
      return { pushed: false, ...committed };
    }
    if (pull.remoteSha === committed.commitSha) {
      return { pushed: true, ...committed };
    }
    try {
      runGit(repoRoot, ['push', '--no-verify', remote, `${LORE_REF}:${LORE_REF}`]);
      return { pushed: true, ...committed };
    } catch (err: any) {
      lastError = String(err?.stderr || err?.message || err).trim();
      // Rejected (someone pushed in between) or offline: loop merges the newer remote and retries
    }
  }

  return { pushed: false, error: lastError, ...committed! };
}

/**
 * Rewrite `refs/ai/lore` as a single commit with no history, then replace the remote copy.
 * This is the only operation that force-pushes, and it uses an explicit lease so it fails
 * instead of overwriting anything pushed after our fetch.
 */
export function compactLoreRef(repoRoot: string, remote = 'origin'): {
  pushed: boolean;
  commitSha: string;
  commitsBefore: number;
  error?: string;
} {
  const hasRemote = Boolean(tryGit(repoRoot, ['remote', 'get-url', remote]));
  const pull = hasRemote
    ? pullLoreFromRemote(repoRoot, remote, { commit: false })
    : { remoteSha: null as string | null, decryptionError: undefined, newerFormat: undefined };
  if (pull.newerFormat) throw new NewerFormatError(pull.newerFormat);
  if (pull.decryptionError) throw new Error(`Could not decrypt remote lore data: ${pull.decryptionError}`);
  collectAndCacheLocalSessions(repoRoot);

  const before = tryGit(repoRoot, ['rev-list', '--count', LORE_REF]);
  const committed = commitToGitRef(repoRoot, { remoteParent: pull.remoteSha, noParent: true });
  if (!hasRemote) return { pushed: false, commitSha: committed.commitSha, commitsBefore: Number(before || 0) };

  try {
    runGit(repoRoot, [
      'push',
      '--no-verify',
      `--force-with-lease=${LORE_REF}:${pull.remoteSha ?? ''}`,
      remote,
      `${LORE_REF}:${LORE_REF}`,
    ]);
    return { pushed: true, commitSha: committed.commitSha, commitsBefore: Number(before || 0) };
  } catch (err: any) {
    return {
      pushed: false,
      commitSha: committed.commitSha,
      commitsBefore: Number(before || 0),
      error: String(err?.stderr || err?.message || err).trim(),
    };
  }
}
