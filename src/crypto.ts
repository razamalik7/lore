import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { ed25519, x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import type { EncryptedEnvelope, RecipientEntry } from './types.js';

/**
 * Parse an OpenSSH `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5...` public key line into raw 32-byte Ed25519 public key.
 */
export function parseSshEd25519Pub(line: string): Uint8Array {
  const parts = line.trim().split(/\s+/);
  const b64 = parts.find((p) => p.startsWith('AAAAC3NzaC1lZDI1NTE5'));
  if (!b64) {
    throw new Error(`Invalid or unsupported SSH public key (expected ssh-ed25519): ${line.slice(0, 48)}...`);
  }
  const buf = Buffer.from(b64, 'base64');
  let off = 0;
  const readChunk = () => {
    const len = buf.readUInt32BE(off);
    off += 4;
    const s = buf.subarray(off, off + len);
    off += len;
    return s;
  };
  const keyType = readChunk().toString('utf8');
  if (keyType !== 'ssh-ed25519') {
    throw new Error(`Unsupported SSH key type "${keyType}". Only ssh-ed25519 is supported.`);
  }
  const pubBytes = readChunk();
  if (pubBytes.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: ${pubBytes.length}`);
  }
  return new Uint8Array(pubBytes);
}

/**
 * Format a raw 32-byte Ed25519 public key into OpenSSH `ssh-ed25519 AAAAC3...` line.
 */
export function formatSshEd25519Pub(pubBytes: Uint8Array, comment = 'lore'): string {
  const typeBuf = Buffer.from('ssh-ed25519', 'utf8');
  const out = Buffer.alloc(4 + typeBuf.length + 4 + pubBytes.length);
  let off = 0;
  out.writeUInt32BE(typeBuf.length, off);
  off += 4;
  typeBuf.copy(out, off);
  off += typeBuf.length;
  out.writeUInt32BE(pubBytes.length, off);
  off += 4;
  Buffer.from(pubBytes).copy(out, off);
  return `ssh-ed25519 ${out.toString('base64')} ${comment}`;
}

/**
 * Compute standard SHA256 fingerprint of an ssh-ed25519 public key (`SHA256:...`).
 */
export function getSshFingerprint(sshPubLine: string): string {
  const pubBytes = parseSshEd25519Pub(sshPubLine);
  const typeBuf = Buffer.from('ssh-ed25519', 'utf8');
  const wire = Buffer.alloc(4 + typeBuf.length + 4 + pubBytes.length);
  wire.writeUInt32BE(typeBuf.length, 0);
  typeBuf.copy(wire, 4);
  wire.writeUInt32BE(pubBytes.length, 4 + typeBuf.length);
  Buffer.from(pubBytes).copy(wire, 8 + typeBuf.length);
  const digest = crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * Parse an unencrypted OpenSSH Ed25519 private key (`-----BEGIN OPENSSH PRIVATE KEY-----`)
 * or a lore JSON seed file into a 32-byte Ed25519 seed and 32-byte public key.
 */
export function parseSshEd25519Priv(content: string): { seed: Uint8Array; pub: Uint8Array } {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const seed = new Uint8Array(Buffer.from(parsed.seed, 'base64'));
    const pub = ed25519.getPublicKey(seed);
    return { seed, pub };
  }

  const b64 = trimmed
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----/g, '')
    .replace(/-----END OPENSSH PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  const magic = 'openssh-key-v1\0';
  if (buf.subarray(0, magic.length).toString('utf8') !== magic) {
    throw new Error('Not a valid OpenSSH v1 private key');
  }
  let off = magic.length;
  const readChunk = () => {
    const len = buf.readUInt32BE(off);
    off += 4;
    const s = buf.subarray(off, off + len);
    off += len;
    return s;
  };
  const cipher = readChunk().toString('utf8');
  readChunk(); // kdf
  readChunk(); // kdfOptions
  off += 4; // numKeys
  readChunk(); // pubKey0
  const privBlock = readChunk();
  if (cipher !== 'none') {
    throw new Error('SSH key is passphrase-protected');
  }
  let pOff = 8; // checkint1, checkint2
  const readPrivChunk = () => {
    const len = privBlock.readUInt32BE(pOff);
    pOff += 4;
    const s = privBlock.subarray(pOff, pOff + len);
    pOff += len;
    return s;
  };
  const kType = readPrivChunk().toString('utf8');
  if (kType !== 'ssh-ed25519') {
    throw new Error(`Expected ssh-ed25519 private key, got ${kType}`);
  }
  const pub = readPrivChunk();
  const priv64 = readPrivChunk();
  return {
    seed: new Uint8Array(priv64.subarray(0, 32)),
    pub: new Uint8Array(pub),
  };
}

export interface LocalKeyIdentity {
  privPath: string;
  pubLine: string;
  fingerprint: string;
  label: string;
  seed: Uint8Array;
  pubBytes: Uint8Array;
}

/**
 * Discover the user's local `~/.ssh/id_ed25519` key or create a fallback `~/.ssh/lore_ed25519` key.
 */
export function ensureLocalIdentity(): LocalKeyIdentity {
  const sshDir = path.join(os.homedir(), '.ssh');
  const candidates = [
    path.join(sshDir, 'id_ed25519'),
    path.join(sshDir, 'lore_ed25519'),
  ];

  for (const privPath of candidates) {
    if (fs.existsSync(privPath)) {
      try {
        const privContent = fs.readFileSync(privPath, 'utf8');
        const { seed, pub } = parseSshEd25519Priv(privContent);
        const pubPath = `${privPath}.pub`;
        const defaultComment = `${os.userInfo().username}@${os.hostname()}`;
        const pubLine = fs.existsSync(pubPath)
          ? fs.readFileSync(pubPath, 'utf8').trim()
          : formatSshEd25519Pub(pub, defaultComment);
        const fingerprint = getSshFingerprint(pubLine);
        return {
          privPath,
          pubLine,
          fingerprint,
          label: `local:${defaultComment}`,
          seed,
          pubBytes: pub,
        };
      } catch {
        // Try next candidate if encrypted or unreadable
      }
    }
  }

  // Generate fallback ~/.ssh/lore_ed25519
  fs.mkdirSync(sshDir, { recursive: true });
  const seed = new Uint8Array(crypto.randomBytes(32));
  const pub = ed25519.getPublicKey(seed);
  const defaultComment = `${os.userInfo().username}@${os.hostname()}`;
  const pubLine = formatSshEd25519Pub(pub, defaultComment);
  const privPath = path.join(sshDir, 'lore_ed25519');
  fs.writeFileSync(privPath, JSON.stringify({ seed: Buffer.from(seed).toString('base64') }, null, 2), { mode: 0o600 });
  fs.writeFileSync(`${privPath}.pub`, `${pubLine}\n`, { mode: 0o644 });

  return {
    privPath,
    pubLine,
    fingerprint: getSshFingerprint(pubLine),
    label: `local:${defaultComment}`,
    seed,
    pubBytes: pub,
  };
}

/**
 * Fetch all `ssh-ed25519` public keys for a GitHub user from `https://github.com/<username>.keys`.
 */
export async function fetchGithubUserKeys(username: string): Promise<RecipientEntry[]> {
  const cleanUser = username.replace(/^@/, '').trim();
  const url = `https://github.com/${encodeURIComponent(cleanUser)}.keys`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch SSH keys from ${url} (HTTP ${res.status})`);
  }
  const text = await res.text();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ssh-ed25519 '));

  if (lines.length === 0) {
    throw new Error(
      `GitHub user @${cleanUser} has no ssh-ed25519 public keys published at ${url}. ` +
      `Ask them to add an Ed25519 SSH key to their GitHub account or pass a raw ssh-ed25519 key.`
    );
  }

  const now = new Date().toISOString();
  return lines.map((line, idx) => ({
    label: lines.length > 1 ? `github:${cleanUser}#${idx + 1}` : `github:${cleanUser}`,
    sshPublicKey: `${line} github:${cleanUser}`,
    fingerprint: getSshFingerprint(line),
    addedAt: now,
  }));
}

function deriveWrapKey(sharedSecret: Uint8Array, epk: Uint8Array, recipientXPub: Uint8Array): Buffer {
  const info = Buffer.concat([
    Buffer.from('lore-v1-x25519-wrap', 'utf8'),
    Buffer.from(epk),
    Buffer.from(recipientXPub),
  ]);
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sharedSecret), Buffer.alloc(32), info, 32));
}

/**
 * Encrypt arbitrary JSON/string payload for multiple SSH-Ed25519 recipients.
 * Compresses plaintext with gzip first to keep Git objects tiny.
 */
export function encryptForRecipients(plaintext: string, recipients: RecipientEntry[]): EncryptedEnvelope {
  if (recipients.length === 0) {
    throw new Error('Cannot encrypt payload: recipient list is empty');
  }

  // 1. Gzip compress plaintext
  const compressed = zlib.gzipSync(Buffer.from(plaintext, 'utf8'), { level: 9 });

  // 2. Encrypt compressed payload with random 32-byte Content Encryption Key (CEK)
  const cek = crypto.randomBytes(32);
  const payloadIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cek, payloadIv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const payloadTag = cipher.getAuthTag();

  // 3. Generate ephemeral X25519 keypair
  const ephemPriv = new Uint8Array(crypto.randomBytes(32));
  const ephemPub = x25519.getPublicKey(ephemPriv);

  // 4. Wrap CEK for each recipient
  const wraps = recipients.map((r) => {
    const edPub = parseSshEd25519Pub(r.sshPublicKey);
    const xPub = edwardsToMontgomeryPub(edPub);
    const shared = x25519.getSharedSecret(ephemPriv, xPub);
    const wrapKey = deriveWrapKey(shared, ephemPub, xPub);
    const wrapIv = crypto.randomBytes(12);
    const wrapCipher = crypto.createCipheriv('aes-256-gcm', wrapKey, wrapIv);
    const ek = Buffer.concat([wrapCipher.update(cek), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();
    return {
      fp: r.fingerprint,
      iv: wrapIv.toString('base64'),
      tag: wrapTag.toString('base64'),
      ek: ek.toString('base64'),
    };
  });

  return {
    v: 1,
    alg: 'ssh-ed25519-x25519-aes256gcm',
    epk: Buffer.from(ephemPub).toString('base64'),
    iv: payloadIv.toString('base64'),
    tag: payloadTag.toString('base64'),
    ct: ciphertext.toString('base64'),
    wraps,
  };
}

/**
 * Decrypt an EncryptedEnvelope using the user's local SSH Ed25519 key.
 */
export function decryptWithLocalIdentity(envelope: EncryptedEnvelope, identity?: LocalKeyIdentity): string {
  const id = identity ?? ensureLocalIdentity();
  const wrap = envelope.wraps.find((w) => w.fp === id.fingerprint);
  if (!wrap) {
    throw new Error(
      `Access denied: your local SSH key (${id.fingerprint}) is not in the authorized recipients list for this repo's lore context.`
    );
  }

  const ephemPub = new Uint8Array(Buffer.from(envelope.epk, 'base64'));
  const xPriv = edwardsToMontgomeryPriv(id.seed);
  const xPub = edwardsToMontgomeryPub(id.pubBytes);
  const shared = x25519.getSharedSecret(xPriv, ephemPub);
  const wrapKey = deriveWrapKey(shared, ephemPub, xPub);

  const decipherWrap = crypto.createDecipheriv(
    'aes-256-gcm',
    wrapKey,
    Buffer.from(wrap.iv, 'base64')
  );
  decipherWrap.setAuthTag(Buffer.from(wrap.tag, 'base64'));
  const cek = Buffer.concat([
    decipherWrap.update(Buffer.from(wrap.ek, 'base64')),
    decipherWrap.final(),
  ]);

  const decipherPayload = crypto.createDecipheriv(
    'aes-256-gcm',
    cek,
    Buffer.from(envelope.iv, 'base64')
  );
  decipherPayload.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const compressed = Buffer.concat([
    decipherPayload.update(Buffer.from(envelope.ct, 'base64')),
    decipherPayload.final(),
  ]);

  return zlib.gunzipSync(compressed).toString('utf8');
}
