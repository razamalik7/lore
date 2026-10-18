import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
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

const GIST_DESC = 'lore-account-identity-v1 (do not share)';
const GIST_FILENAME = 'lore-identity.enc.json';
const VAULT_VAR_NAME = 'LORE_VAULT_KEY';

function deriveAccountVaultKey(
  vaultSecretB64: string,
  githubNumericId: number | string,
  githubNodeId: string,
  saltB64: string
): Buffer {
  const vaultSecret = Buffer.from(vaultSecretB64, 'base64');
  if (vaultSecret.length < 32) {
    throw new Error('Invalid LORE_VAULT_KEY length (expected 32-byte base64 secret)');
  }
  const ikm = Buffer.concat([
    vaultSecret,
    Buffer.from(`:lore-github-account-v2:${githubNumericId}:${githubNodeId}`, 'utf8'),
  ]);
  const salt = Buffer.from(saltB64, 'base64');
  return Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('lore-account-vault-aes256gcm-v2', 'utf8'), 32)
  );
}

/**
 * Parse `owner/repo` from a Git repository's `origin` remote URL if it points to GitHub.
 */
export function detectGithubOwnerRepo(repoRoot = process.cwd()): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const httpsMatch = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch {
    return null;
  }
}

function getGitCredentialGithubToken(): string | null {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const m = out.match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function ghApi(endpoint: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', bodyObj?: Record<string, any>): string {
  // 1. Try gh CLI first if installed
  try {
    const args = ['api', endpoint];
    if (method !== 'GET') args.push('-X', method);
    let input: string | undefined;
    if (bodyObj) {
      args.push('--input', '-');
      input = JSON.stringify(bodyObj);
    }
    return execFileSync('gh', args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // 2. Fallback to git credential fill + curl (works on Windows/macOS/Linux without gh CLI installed)
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getGitCredentialGithubToken();
    if (!token) {
      throw new Error('No GitHub token available via gh CLI or git credential fill');
    }
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = `https://api.github.com/${cleanEndpoint}`;
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const curlArgs = [
      '-sS',
      '-f',
      '-X',
      method,
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'User-Agent: git-lore-cli',
    ];
    let input: string | undefined;
    if (bodyObj) {
      curlArgs.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
      input = JSON.stringify(bodyObj);
    }
    curlArgs.push(url);
    return execFileSync(curlBin, curlArgs, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}

function getRepoVaultKey(ownerRepo: string): string | null {
  try {
    const out = ghApi(`repos/${ownerRepo}/actions/variables/${VAULT_VAR_NAME}`, 'GET');
    const parsed = JSON.parse(out) as { value?: string };
    return parsed.value || null;
  } catch {
    return null;
  }
}

function setRepoVaultKey(ownerRepo: string, vaultKeyB64: string): boolean {
  try {
    const existing = getRepoVaultKey(ownerRepo);
    if (existing) {
      ghApi(`repos/${ownerRepo}/actions/variables/${VAULT_VAR_NAME}`, 'PATCH', {
        name: VAULT_VAR_NAME,
        value: vaultKeyB64,
      });
    } else {
      ghApi(`repos/${ownerRepo}/actions/variables`, 'POST', {
        name: VAULT_VAR_NAME,
        value: vaultKeyB64,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync (or initialize) a dedicated `lore`-only account key (`~/.ssh/lore_account_ed25519`)
 * across the user's own devices using a 2-Part Split Lock:
 *  - Part 1: AES-256-GCM encrypted key envelope in an unlisted Secret Gist (discoverable only via authenticated `GET /gists`).
 *  - Part 2: 256-bit random `LORE_VAULT_KEY` stored in the GitHub repository's Actions Variables (`repos/{owner}/{repo}/actions/variables/LORE_VAULT_KEY`),
 *            which strictly returns 401/403 to anyone without authenticated repo push access.
 * - Never touches or uploads the user's personal `~/.ssh/id_ed25519` key.
 * - Never creates any extra GitHub repositories.
 */
export function syncGithubAccountIdentity(repoRoot = process.cwd()): LocalKeyIdentity | null {
  const sshDir = path.join(os.homedir(), '.ssh');
  const accountPrivPath = path.join(sshDir, 'lore_account_ed25519');
  const accountPubPath = `${accountPrivPath}.pub`;

  try {
    // 1. Verify GitHub authentication (via `gh` CLI or `git credential fill`) and fetch user's GitHub login, id, node_id
    const userJson = ghApi('user', 'GET');
    const user = JSON.parse(userJson) as { login: string; id: number; node_id: string };
    if (!user.login || !user.id || !user.node_id) return null;

    const label = `github:${user.login}`;
    const currentOwnerRepo = detectGithubOwnerRepo(repoRoot);

    // 2. Query authenticated user's gists for existing lore envelope
    const gistsJson = ghApi('gists?per_page=100', 'GET');
    const gists = JSON.parse(gistsJson) as Array<{
      id: string;
      public: boolean;
      description: string;
      files: Record<string, { filename: string }>;
    }>;

    const existingGist = gists.find(
      (g) => !g.public && g.description === GIST_DESC && g.files && g.files[GIST_FILENAME]
    );

    if (existingGist) {
      const detailJson = ghApi(`gists/${existingGist.id}`, 'GET');
      const detail = JSON.parse(detailJson);
      const rawContent = detail?.files?.[GIST_FILENAME]?.content;
      if (rawContent) {
        const env = JSON.parse(rawContent) as {
          v: number;
          vaultRepo?: string;
          salt: string;
          iv: string;
          tag: string;
          ct: string;
        };

        if (env.v === 2) {
          // Fetch Part 2 (256-bit random LORE_VAULT_KEY) from repo Actions variable or local cache
          let vaultKey: string | null = null;
          if (currentOwnerRepo) {
            vaultKey = getRepoVaultKey(currentOwnerRepo);
          }
          if (!vaultKey && env.vaultRepo && env.vaultRepo !== currentOwnerRepo) {
            vaultKey = getRepoVaultKey(env.vaultRepo);
          }
          if (!vaultKey && fs.existsSync(accountPrivPath)) {
            try {
              const cached = JSON.parse(fs.readFileSync(accountPrivPath, 'utf8'));
              if (cached.vaultKey) vaultKey = cached.vaultKey;
            } catch {
              // Ignore
            }
          }

          if (vaultKey) {
            // Ensure current repo also has LORE_VAULT_KEY if we're in a repo owned by this user
            if (currentOwnerRepo && currentOwnerRepo.toLowerCase().startsWith(`${user.login.toLowerCase()}/`)) {
              setRepoVaultKey(currentOwnerRepo, vaultKey);
            }

            const key = deriveAccountVaultKey(vaultKey, user.id, user.node_id, env.salt);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
            const decrypted = Buffer.concat([
              decipher.update(Buffer.from(env.ct, 'base64')),
              decipher.final(),
            ]).toString('utf8');
            const parsed = JSON.parse(decrypted) as { seed: string };
            const seed = new Uint8Array(Buffer.from(parsed.seed, 'base64'));
            const pub = ed25519.getPublicKey(seed);
            const pubLine = formatSshEd25519Pub(pub, label);

            fs.mkdirSync(sshDir, { recursive: true });
            fs.writeFileSync(
              accountPrivPath,
              JSON.stringify({ seed: parsed.seed, vaultKey, label }, null, 2),
              { mode: 0o600 }
            );
            fs.writeFileSync(accountPubPath, `${pubLine}\n`, { mode: 0o644 });

            return {
              privPath: accountPrivPath,
              pubLine,
              fingerprint: getSshFingerprint(pubLine),
              label,
              seed,
              pubBytes: pub,
            };
          }
        }
      }
    }

    // 3. Initialize or upgrade to v2 Split-Lock (requires a target GitHub repo for Part 2 variable storage)
    let seed: Uint8Array;
    let vaultKeyB64: string = crypto.randomBytes(32).toString('base64');
    if (fs.existsSync(accountPrivPath)) {
      const rawLocal = fs.readFileSync(accountPrivPath, 'utf8');
      const local = parseSshEd25519Priv(rawLocal);
      seed = local.seed;
      try {
        const parsedLocal = JSON.parse(rawLocal);
        if (parsedLocal.vaultKey) vaultKeyB64 = parsedLocal.vaultKey;
      } catch {
        // Use newly generated vaultKeyB64
      }
    } else {
      seed = new Uint8Array(crypto.randomBytes(32));
    }

    const pub = ed25519.getPublicKey(seed);
    const pubLine = formatSshEd25519Pub(pub, label);
    const seedB64 = Buffer.from(seed).toString('base64');

    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(
      accountPrivPath,
      JSON.stringify({ seed: seedB64, vaultKey: vaultKeyB64, label }, null, 2),
      { mode: 0o600 }
    );
    fs.writeFileSync(accountPubPath, `${pubLine}\n`, { mode: 0o644 });

    // Store Part 2 in the current repo's Actions Variables (or fallback to user's primary owned repo if outside a git repo)
    let targetVaultRepo = currentOwnerRepo;
    if (!targetVaultRepo) {
      try {
        const reposJson = ghApi('user/repos?affiliation=owner&per_page=1&sort=pushed', 'GET');
        const repos = JSON.parse(reposJson) as Array<{ full_name?: string }>;
        if (repos[0]?.full_name) targetVaultRepo = repos[0].full_name;
      } catch {
        // Ignore
      }
    }
    if (targetVaultRepo) {
      const stored = setRepoVaultKey(targetVaultRepo, vaultKeyB64);
      if (!stored) targetVaultRepo = null;
    }

    if (targetVaultRepo) {
      const salt = crypto.randomBytes(32).toString('base64');
      const iv = crypto.randomBytes(12);
      const key = deriveAccountVaultKey(vaultKeyB64, user.id, user.node_id, salt);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([
        cipher.update(JSON.stringify({ seed: seedB64, createdAt: new Date().toISOString() }), 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      const gistBody = {
        description: GIST_DESC,
        public: false,
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify({
              v: 2,
              vaultRepo: targetVaultRepo,
              salt,
              iv: iv.toString('base64'),
              tag: tag.toString('base64'),
              ct: ct.toString('base64'),
            }),
          },
        },
      };

      if (existingGist) {
        ghApi(`gists/${existingGist.id}`, 'PATCH', gistBody);
      } else {
        ghApi('gists', 'POST', gistBody);
      }
    }

    return {
      privPath: accountPrivPath,
      pubLine,
      fingerprint: getSshFingerprint(pubLine),
      label,
      seed,
      pubBytes: pub,
    };
  } catch {
    return null;
  }
}

/**
 * Load all available local identities on this machine (both the GitHub-account-synced
 * `~/.ssh/lore_account_ed25519` key AND the device's `~/.ssh/id_ed25519` / `~/.ssh/lore_ed25519` keys).
 */
export function getAllLocalIdentities(): LocalKeyIdentity[] {
  const sshDir = path.join(os.homedir(), '.ssh');
  const candidates = [
    path.join(sshDir, 'lore_account_ed25519'),
    path.join(sshDir, 'id_ed25519'),
    path.join(sshDir, 'lore_ed25519'),
  ];

  const found: LocalKeyIdentity[] = [];
  for (const privPath of candidates) {
    if (!fs.existsSync(privPath)) continue;
    try {
      const privContent = fs.readFileSync(privPath, 'utf8');
      const { seed, pub } = parseSshEd25519Priv(privContent);
      const pubPath = `${privPath}.pub`;
      const defaultComment = `${os.userInfo().username}@${os.hostname()}`;
      let label = `local:${defaultComment}`;
      if (privContent.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(privContent);
          if (parsed.label) label = parsed.label;
        } catch {
          // Ignore
        }
      }
      const pubLine = fs.existsSync(pubPath)
        ? fs.readFileSync(pubPath, 'utf8').trim()
        : formatSshEd25519Pub(pub, label);
      const fingerprint = getSshFingerprint(pubLine);
      found.push({
        privPath,
        pubLine,
        fingerprint,
        label,
        seed,
        pubBytes: pub,
      });
    } catch {
      // Try next
    }
  }
  return found;
}

/**
 * Discover the user's primary identity (preferring the GitHub-account-synced `~/.ssh/lore_account_ed25519`
 * so all devices logged into the same GitHub account decrypt seamlessly, falling back to `~/.ssh/id_ed25519`).
 */
export function ensureLocalIdentity(repoRoot?: string): LocalKeyIdentity {
  const accountPrivPath = path.join(os.homedir(), '.ssh', 'lore_account_ed25519');
  if (!fs.existsSync(accountPrivPath)) {
    syncGithubAccountIdentity(repoRoot);
  }

  const existing = getAllLocalIdentities();
  if (existing.length > 0) {
    return existing[0];
  }

  // Generate fallback ~/.ssh/lore_ed25519
  const sshDir = path.join(os.homedir(), '.ssh');
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
 * Decrypt an EncryptedEnvelope using any matching local or GitHub-account identity.
 */
export function decryptWithLocalIdentity(envelope: EncryptedEnvelope, identity?: LocalKeyIdentity): string {
  let candidates = identity ? [identity] : getAllLocalIdentities();
  let matchedIdentity = candidates.find((c) => envelope.wraps.some((w) => w.fp === c.fingerprint));

  // If no local key matched yet and no explicit identity was forced, try syncing GitHub account identity on the fly
  if (!matchedIdentity && !identity) {
    const synced = syncGithubAccountIdentity();
    if (synced && envelope.wraps.some((w) => w.fp === synced.fingerprint)) {
      matchedIdentity = synced;
    }
    candidates = getAllLocalIdentities();
  }

  const id = matchedIdentity ?? candidates[0] ?? ensureLocalIdentity();
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
