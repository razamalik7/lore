import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionRecord, TakeawayEntry } from './types.js';
import {
  ensureLocalLoreDirs,
  loadAllLocalSessions,
  loadTakeaways,
} from './git-store.js';

/**
 * Ensure `.agents/rules/lore-context.md` is listed in `.git/info/exclude`
 * so `git status` stays 100% clean without modifying the repo's tracked `.gitignore`.
 */
export function ensureGitExclude(gitDir: string, pattern = '.agents/rules/lore-context.md'): void {
  const infoDir = path.join(gitDir, 'info');
  fs.mkdirSync(infoDir, { recursive: true });
  const excludePath = path.join(infoDir, 'exclude');
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (!existing.split(/\r?\n/).some((line) => line.trim() === pattern)) {
    const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
    fs.writeFileSync(excludePath, `${existing}${prefix}# lore auto-generated context\n${pattern}\n`, 'utf8');
  }
}

/**
 * Rebuild local SQLite FTS5 index (`.git/lore/search.db`) over all decrypted sessions & takeaways.
 */
export function rebuildSearchIndex(repoRoot: string): void {
  const paths = ensureLocalLoreDirs(repoRoot);
  const sessions = loadAllLocalSessions(repoRoot);
  const takeaways = loadTakeaways(repoRoot);

  const db = new DatabaseSync(paths.searchDbPath);
  db.exec(`
    DROP TABLE IF EXISTS lore_fts;
    CREATE VIRTUAL TABLE lore_fts USING fts5(
      doc_type UNINDEXED,
      doc_id UNINDEXED,
      title,
      author UNINDEXED,
      device UNINDEXED,
      updated_at UNINDEXED,
      files,
      body,
      tokenize = 'porter unicode61'
    );
  `);

  const insert = db.prepare(
    `INSERT INTO lore_fts (doc_type, doc_id, title, author, device, updated_at, files, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const t of takeaways) {
    insert.run(
      'takeaway',
      t.id,
      `[${t.category.toUpperCase()}]`,
      t.author || '',
      '',
      t.timestamp,
      '',
      t.content
    );
  }

  for (const s of sessions) {
    const bodyText = s.turns
      .map((turn) => `${turn.role.toUpperCase()}: ${turn.text}`)
      .join('\n\n');
    insert.run(
      'session',
      s.id,
      s.title,
      s.author || '',
      s.deviceHostname || '',
      s.updatedAt,
      s.filesTouched.join(' '),
      `${s.recap}\n\n${bodyText}`
    );
  }

  db.close();
}

export interface SearchHit {
  docType: 'session' | 'takeaway';
  docId: string;
  title: string;
  author: string;
  device: string;
  updatedAt: string;
  files: string;
  snippet: string;
}

/**
 * Full-text search across all past sessions and takeaways using SQLite FTS5 BM25 ranking.
 */
export function searchLore(repoRoot: string, query: string, limit = 8): SearchHit[] {
  const paths = ensureLocalLoreDirs(repoRoot);
  if (!fs.existsSync(paths.searchDbPath)) {
    rebuildSearchIndex(repoRoot);
  }

  const sanitized = query
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' OR ');

  if (!sanitized) return [];

  const db = new DatabaseSync(paths.searchDbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT
           doc_type AS docType,
           doc_id AS docId,
           title,
           author,
           device,
           updated_at AS updatedAt,
           files,
           snippet(lore_fts, 7, '«', '»', ' … ', 42) AS snippet
         FROM lore_fts
         WHERE lore_fts MATCH ?
         ORDER BY bm25(lore_fts)
         LIMIT ?`
      )
      .all(sanitized, limit) as unknown as SearchHit[];
    db.close();
    return rows;
  } catch {
    db.close();
    return [];
  }
}

/**
 * Render the compact (~400–600 token) Living Digest Markdown string.
 */
export function renderDigestMarkdown(
  repoRoot: string,
  sessions?: SessionRecord[],
  takeaways?: TakeawayEntry[]
): string {
  const allSessions = sessions ?? loadAllLocalSessions(repoRoot);
  const allTakeaways = takeaways ?? loadTakeaways(repoRoot);

  const lines: string[] = [
    '# Project Lore (`lore` Shared AI Context)',
    '',
    '> Auto-synced across devices & approved contributors via encrypted `refs/ai/lore`.',
    '> Need full verbatim dialogue or older chats? Call MCP tools `lore_get_session(id)` or `lore_search(query)`.',
    '> Finished a milestone or architectural decision? Call `lore_save_takeaway(category, content)`.',
    '',
  ];

  if (allTakeaways.length > 0) {
    lines.push('## Active Architectural Takeaways & WIP');
    const recentTakeaways = allTakeaways.slice(-15);
    for (const t of recentTakeaways) {
      const dateStr = t.timestamp.slice(0, 10);
      lines.push(`- **[${t.category.toUpperCase()}]** ${t.content} _(${t.author}, ${dateStr})_`);
    }
    lines.push('');
  }

  if (allSessions.length > 0) {
    lines.push('## Recent AI Coding Sessions (Across Devices)');
    const topSessions = allSessions.slice(0, 4);
    for (const s of topSessions) {
      const dateStr = s.updatedAt.slice(0, 16).replace('T', ' ');
      const metaParts = [
        `id: \`${s.id.slice(0, 8)}\``,
        s.source,
        s.deviceHostname ? `device: ${s.deviceHostname}` : '',
        s.branch ? `branch: ${s.branch}` : '',
        dateStr,
      ].filter(Boolean);
      lines.push(`### ${s.title} (${metaParts.join(' · ')})`);
      lines.push(`- ${s.recap}`);
      lines.push('');
    }
    if (allSessions.length > 4) {
      lines.push(
        `_Plus ${allSessions.length - 4} older synced session(s) searchable via \`lore_search(query)\`._`
      );
      lines.push('');
    }
  } else {
    lines.push('_No synced sessions recorded yet._');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write `.agents/rules/lore-context.md` (git-excluded) and rebuild local FTS5 index
 * so Antigravity and Claude Code have immediate, low-token awareness of repo lore.
 */
export function refreshWorkspaceContextFiles(repoRoot: string): {
  ruleFilePath: string;
  tokenEstimate: number;
} {
  const paths = ensureLocalLoreDirs(repoRoot);
  ensureGitExclude(paths.gitDir, '.agents/rules/lore-context.md');
  ensureGitExclude(paths.gitDir, '.cursor/rules/lore-context.mdc');
  rebuildSearchIndex(repoRoot);

  const markdown = renderDigestMarkdown(repoRoot);
  const rulesDir = path.join(repoRoot, '.agents', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const ruleFilePath = path.join(rulesDir, 'lore-context.md');
  fs.writeFileSync(ruleFilePath, markdown, 'utf8');

  // If repo uses Cursor (.cursor/), also write .cursor/rules/lore-context.mdc
  if (fs.existsSync(path.join(repoRoot, '.cursor'))) {
    const cursorRulesDir = path.join(repoRoot, '.cursor', 'rules');
    fs.mkdirSync(cursorRulesDir, { recursive: true });
    const mdcContent = `---\ndescription: lore shared cross-device AI context\nalwaysApply: true\n---\n\n${markdown}`;
    fs.writeFileSync(path.join(cursorRulesDir, 'lore-context.mdc'), mdcContent, 'utf8');
  }

  const tokenEstimate = Math.ceil(markdown.length / 4);
  return { ruleFilePath, tokenEstimate };
}
