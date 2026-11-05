export interface CompactTurn {
  role: 'user' | 'assistant';
  timestamp: string;
  text: string;
  toolsUsed?: string[];
  filesTouched?: string[];
  /** Short, redacted snippets of command output and tool errors (the evidence behind the reply). */
  toolOutputs?: string[];
}

export interface SessionRecord {
  id: string;
  source: 'antigravity' | 'claude-code' | 'cursor' | 'codex' | 'manual';
  title: string;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  headCommit?: string;
  deviceHostname?: string;
  author?: string;
  filesTouched: string[];
  recap: string;
  turns: CompactTurn[];
  rawStepCount: number;
  originalBytes: number;
  compressedBytes: number;
}

export interface TakeawayEntry {
  id: string;
  timestamp: string;
  author: string;
  category: 'architecture' | 'decision' | 'gotcha' | 'wip' | 'convention';
  content: string;
  sessionId?: string;
  commitSha?: string;
}

export interface RecipientEntry {
  label: string;
  sshPublicKey: string;
  fingerprint: string;
  addedAt: string;
}

export interface SessionIndexMeta {
  id: string;
  title: string;
  source: 'antigravity' | 'claude-code' | 'cursor' | 'codex' | 'manual';
  updatedAt: string;
  createdAt: string;
  branch?: string;
  headCommit?: string;
  author?: string;
  deviceHostname?: string;
  filesTouched: string[];
  recap: string;
  turnCount: number;
  originalBytes: number;
  compressedBytes: number;
}

export interface LoreManifest {
  version: 1;
  /**
   * Layout of the data stored in refs/ai/lore. Missing means 1.
   * Clients refuse to write a ref whose format is newer than they understand,
   * because rewriting it would drop data they can't read.
   */
  format?: number;
  updatedAt: string;
  encryption: 'ssh-x25519-aes256gcm' | 'none';
  recipients: RecipientEntry[];
  /**
   * Keys removed with `lore revoke`, so merging another device's manifest doesn't re-add them.
   * A recipient entry added after the revoke (`lore allow` again) wins.
   */
  revoked?: Array<{ fingerprint: string; at: string }>;
}

/** Marks a session or takeaway as deleted so other devices' merges don't bring it back. */
export interface TombstoneEntry {
  id: string;
  kind: 'session' | 'takeaway';
  at: string;
  by: string;
}

export interface EncryptedEnvelope {
  v: 1;
  alg: 'ssh-ed25519-x25519-aes256gcm';
  epk: string; // base64 ephemeral X25519 public key (32 bytes)
  iv: string;  // base64 AES-256-GCM nonce (12 bytes)
  tag: string; // base64 AES-256-GCM auth tag (16 bytes)
  ct: string;  // base64 gzipped + encrypted payload
  wraps: Array<{
    fp: string;   // recipient key fingerprint
    iv: string;   // base64 wrap nonce
    tag: string;  // base64 wrap tag
    ek: string;   // base64 wrapped 32-byte payload key
  }>;
}
