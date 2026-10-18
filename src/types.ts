export interface CompactTurn {
  role: 'user' | 'assistant';
  timestamp: string;
  text: string;
  toolsUsed?: string[];
  filesTouched?: string[];
}

export interface SessionRecord {
  id: string;
  source: 'antigravity' | 'claude-code' | 'manual';
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
  source: 'antigravity' | 'claude-code' | 'manual';
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
  updatedAt: string;
  encryption: 'ssh-x25519-aes256gcm' | 'none';
  recipients: RecipientEntry[];
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
