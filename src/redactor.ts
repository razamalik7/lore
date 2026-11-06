/**
 * Automatically scrub API keys, access tokens, and private keys from chat transcripts and takeaways
 * BEFORE they are cached locally or encrypted into `refs/ai/lore`.
 *
 * Two layers:
 * 1. Known formats (GitHub, OpenAI/Anthropic, Google, AWS, Slack, npm, JWTs, private keys, ...).
 * 2. Context: a key-shaped value right after words like "key:", "token is", "API_KEY=" is redacted
 *    whatever its format, because new key formats keep appearing (e.g. Google's `AQ.` keys) and people
 *    paste keys into chat in plain prose ("here is a key: ...").
 */
type Replacer = string | ((match: string, ...groups: string[]) => string);

/** Looks like a real credential rather than a word, number, path, or placeholder. */
export function looksLikeSecretValue(value: string, minLength = 16): boolean {
  if (value.length < minLength) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (/^(your|my|example|sample|placeholder|xxx|changeme|redacted|todo)/i.test(value)) return false;
  if (/[<>{}$]/.test(value)) return false; // templates: <KEY>, ${KEY}, {{key}}
  if (/^[A-Za-z]:[\\/]|^\.{0,2}\/|[\\/].*[\\/]/.test(value)) return false; // file paths
  if (/^\[REDACTED/.test(value)) return false;
  return true;
}

const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: Replacer }> = [
  // GitHub Personal Access Tokens / OAuth tokens
  { regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, replacement: '[REDACTED_GITHUB_PAT]' },
  // OpenAI / Anthropic / DeepSeek / Stripe sk- keys
  { regex: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,255}\b/g, replacement: '[REDACTED_API_KEY]' },
  // Google / Gemini API keys: classic `AIza...` and the newer `AQ.` format
  { regex: /\bAIza[0-9A-Za-z_-]{30,}/g, replacement: '[REDACTED_GOOGLE_KEY]' },
  { regex: /\bAQ\.[0-9A-Za-z_-]{20,}/g, replacement: '[REDACTED_GOOGLE_KEY]' },
  // AWS Access Key IDs
  { regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // Slack tokens
  { regex: /\bxox[baprs]-[0-9A-Za-z-]{10,255}\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  // npm tokens
  { regex: /\bnpm_[A-Za-z0-9]{20,255}\b/g, replacement: '[REDACTED_NPM_TOKEN]' },
  // Hugging Face tokens
  { regex: /\bhf_[A-Za-z0-9]{30,}\b/g, replacement: '[REDACTED_HF_TOKEN]' },
  // PEM / OpenSSH Private Key blocks
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // Private key blocks cut off before their END line (e.g. in clipped command output)
  { regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  // Authorization Bearer tokens
  { regex: /(Bearer\s+)[A-Za-z0-9._~+/=-]{24,512}/gi, replacement: '$1[REDACTED_BEARER_TOKEN]' },
  // JSON Web Tokens
  { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[REDACTED_JWT]' },
  // Passwords embedded in URLs (postgres://user:pass@host)
  { regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, replacement: '$1[REDACTED]@' },
  // SECRET=..., API_KEY: ..., DB_PASSWORD="...", `setx GEMINI_API_KEY value` (env dumps, config, shell)
  {
    regex: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Za-z0-9_]*(?:\s*[=:]\s*|\s+)["']?)([^\s"',;]{8,})/gi,
    replacement: (m, prefix, value) => (looksLikeSecretValue(value, 12) ? `${prefix}[REDACTED]` : m),
  },
  // Prose: "here is a key: X", "my token is X", "api key - X", "password: X"
  {
    regex: /\b((?:api[\s_-]?)?(?:key|token|secret|password|passwd|passphrase|credential)s?\b\s*(?:is|was|=|:|-|→)?\s*(?:is\s+)?["'`]?)([A-Za-z0-9._~+/=-]{16,})/gi,
    replacement: (m, prefix, value) => (looksLikeSecretValue(value) ? `${prefix}[REDACTED]` : m),
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = typeof replacement === 'string' ? out.replace(regex, replacement) : out.replace(regex, replacement as any);
  }
  return out;
}
