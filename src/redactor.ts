/**
 * Automatically scrub API keys, access tokens, and private keys from chat transcripts and takeaways
 * BEFORE they are cached locally or encrypted into `refs/ai/lore`.
 */
const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // GitHub Personal Access Tokens / OAuth tokens
  { regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { regex: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, replacement: '[REDACTED_GITHUB_PAT]' },
  // OpenAI / Anthropic / DeepSeek / Stripe sk- keys
  { regex: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,255}\b/g, replacement: '[REDACTED_API_KEY]' },
  // Google / Gemini API keys
  { regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[REDACTED_GOOGLE_KEY]' },
  // AWS Access Key IDs
  { regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // Slack tokens
  { regex: /\bxox[baprs]-[0-9A-Za-z-]{10,255}\b/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  // npm tokens
  { regex: /\bnpm_[A-Za-z0-9]{20,255}\b/g, replacement: '[REDACTED_NPM_TOKEN]' },
  // PEM / OpenSSH Private Key blocks
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // Authorization Bearer tokens
  { regex: /(Bearer\s+)[A-Za-z0-9._~+/=-]{24,512}/gi, replacement: '$1[REDACTED_BEARER_TOKEN]' },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}
