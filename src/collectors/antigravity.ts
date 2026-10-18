import '../silence-warnings.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { CompactTurn, SessionRecord } from '../types.js';

export function normalizeFsPath(p: string): string {
  try {
    let cleaned = p.trim();
    if (cleaned.startsWith('file:///')) {
      cleaned = decodeURIComponent(cleaned.slice('file:///'.length));
    } else if (cleaned.startsWith('file://')) {
      cleaned = decodeURIComponent(cleaned.slice('file://'.length));
    } else {
      cleaned = decodeURIComponent(cleaned);
    }
    cleaned = cleaned.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') {
      cleaned = cleaned.toLowerCase();
    }
    return cleaned;
  } catch {
    const fallback = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? fallback.toLowerCase() : fallback;
  }
}

export function isSameOrSubPath(targetPath: string, repoRoot: string): boolean {
  const normTarget = normalizeFsPath(targetPath);
  const normRepo = normalizeFsPath(repoRoot);
  return normTarget === normRepo || normTarget.startsWith(`${normRepo}/`);
}

function cleanUserPrompt(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const core = match ? match[1] : raw;
  return core
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<EPHEMERAL_MESSAGE>[\s\S]*?<\/EPHEMERAL_MESSAGE>/gi, '')
    .trim();
}

function unquoteJsonArg(val: unknown): string {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      s = JSON.parse(s);
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s;
}

export function buildAutoRecap(title: string, turns: CompactTurn[], filesTouched: string[]): string {
  const userTurns = turns.filter((t) => t.role === 'user' && t.text.length > 0);
  const assistantTurns = turns.filter((t) => t.role === 'assistant' && t.text.length > 0);

  const firstPrompt = userTurns[0]?.text.replace(/\s+/g, ' ').slice(0, 180) ?? '';
  const lastPrompt =
    userTurns.length > 1
      ? userTurns[userTurns.length - 1].text.replace(/\s+/g, ' ').slice(0, 180)
      : '';
  const lastAssistant =
    assistantTurns.length > 0
      ? assistantTurns[assistantTurns.length - 1].text
          .replace(/```[\s\S]*?```/g, '[code]')
          .replace(/\s+/g, ' ')
          .slice(0, 260)
      : '';

  const parts: string[] = [];
  if (firstPrompt) parts.push(`Goal: ${firstPrompt}${firstPrompt.length >= 180 ? '...' : ''}`);
  if (lastPrompt && lastPrompt !== firstPrompt) {
    parts.push(`Latest prompt: ${lastPrompt}${lastPrompt.length >= 180 ? '...' : ''}`);
  }
  if (filesTouched.length > 0) {
    parts.push(`Files touched: ${filesTouched.slice(0, 8).join(', ')}${filesTouched.length > 8 ? ` (+${filesTouched.length - 8} more)` : ''}`);
  }
  if (lastAssistant) {
    parts.push(`Outcome: ${lastAssistant}${lastAssistant.length >= 260 ? '...' : ''}`);
  }
  return parts.join(' | ') || title;
}

/**
 * Collect and deterministically compress Antigravity sessions for a given repository path.
 */
export function collectAntigravitySessions(
  repoRoot: string,
  metaContext: { branch?: string; headCommit?: string; author?: string }
): SessionRecord[] {
  const agyRoot = path.join(os.homedir(), '.gemini', 'antigravity');
  const dbPath = path.join(agyRoot, 'conversation_summaries.db');
  const brainDir = path.join(agyRoot, 'brain');

  if (!fs.existsSync(brainDir)) {
    return [];
  }

  const matchedConvs = new Map<
    string,
    { title: string; updatedAt: string; stepCount: number }
  >();
  const dbTitles = new Map<string, { title: string; updatedAt: string; stepCount: number }>();

  // 1. Query conversation_summaries.db if present
  if (fs.existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, workspace_uris, step_count, last_modified_time
           FROM conversation_summaries
           WHERE parent_conversation_id = ''
           ORDER BY last_modified_time DESC`
        )
        .all() as Array<{
        conversation_id: string;
        title: string;
        workspace_uris: string;
        step_count: number;
        last_modified_time: string;
      }>;

      for (const row of rows) {
        const meta = {
          title: row.title || '',
          updatedAt: row.last_modified_time || new Date().toISOString(),
          stepCount: Number(row.step_count || 0),
        };
        dbTitles.set(row.conversation_id, meta);
        try {
          const uris: string[] = JSON.parse(row.workspace_uris || '[]');
          const matchesRepo = uris.some((u) => isSameOrSubPath(u, repoRoot));
          if (matchesRepo) {
            matchedConvs.set(row.conversation_id, meta);
          }
        } catch {
          // Ignore malformed workspace_uris
        }
      }
      db.close();
    } catch {
      // Fallback to scanning brain directory if SQLite DB is locked/unavailable
    }
  }

  // 2. Also scan brain/* for sessions that touched files inside repoRoot (e.g. parent workspace)
  try {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    const normRepo = normalizeFsPath(repoRoot);
    for (const entry of entries) {
      if (!entry.isDirectory() || matchedConvs.has(entry.name)) continue;
      const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;
      const stat = fs.statSync(transcriptPath);
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      if (normalizeFsPath(raw).includes(normRepo)) {
        const dbMeta = dbTitles.get(entry.name);
        matchedConvs.set(entry.name, {
          title: dbMeta?.title || '',
          updatedAt: dbMeta?.updatedAt || stat.mtime.toISOString(),
          stepCount: dbMeta?.stepCount || 0,
        });
      }
    }
  } catch {
    // Ignore scan errors
  }

  const sessions: SessionRecord[] = [];
  const hostname = os.hostname();

  for (const [convId, summaryMeta] of matchedConvs.entries()) {
    const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) continue;

    const rawContent = fs.readFileSync(transcriptPath, 'utf8');
    const originalBytes = Buffer.byteLength(rawContent, 'utf8');
    const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);

    const turns: CompactTurn[] = [];
    const filesSet = new Set<string>();
    let createdAt = '';
    let updatedAt = summaryMeta.updatedAt;
    let pendingTools: string[] = [];
    let pendingFiles: string[] = [];

    for (const line of lines) {
      let step: any;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }

      if (!createdAt && step.created_at) {
        createdAt = step.created_at;
      }
      if (step.created_at) {
        updatedAt = step.created_at;
      }

      if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
        const cleaned = cleanUserPrompt(step.content);
        if (cleaned) {
          turns.push({
            role: 'user',
            timestamp: step.created_at || updatedAt,
            text: cleaned,
          });
        }
      } else if (step.type === 'PLANNER_RESPONSE') {
        if (Array.isArray(step.tool_calls)) {
          for (const tc of step.tool_calls) {
            const args = tc.args || {};
            const summary = unquoteJsonArg(args.toolSummary) || unquoteJsonArg(args.toolAction) || tc.name;
            if (summary) pendingTools.push(`${tc.name}: ${summary}`);

            const rawFile = unquoteJsonArg(args.TargetFile) || unquoteJsonArg(args.AbsolutePath);
            if (rawFile && isSameOrSubPath(rawFile, repoRoot)) {
              const rel = path.relative(repoRoot, rawFile).replace(/\\/g, '/');
              if (rel && !rel.startsWith('..')) {
                filesSet.add(rel);
                pendingFiles.push(rel);
              }
            }
          }
        }

        if (typeof step.content === 'string' && step.content.trim().length > 0) {
          const text = step.content
            .replace(/<truncated \d+ bytes>/g, '…')
            .trim();
          turns.push({
            role: 'assistant',
            timestamp: step.created_at || updatedAt,
            text,
            toolsUsed: pendingTools.length > 0 ? Array.from(new Set(pendingTools)) : undefined,
            filesTouched: pendingFiles.length > 0 ? Array.from(new Set(pendingFiles)) : undefined,
          });
          pendingTools = [];
          pendingFiles = [];
        }
      }
    }

    if (turns.length === 0) continue;

    const firstUserText = turns.find((t) => t.role === 'user')?.text ?? 'Untitled Session';
    const title =
      summaryMeta.title.trim() ||
      firstUserText.split(/\r?\n/)[0].slice(0, 72) + (firstUserText.length > 72 ? '…' : '');
    const filesTouched = Array.from(filesSet);
    const recap = buildAutoRecap(title, turns, filesTouched);

    const record: SessionRecord = {
      id: convId,
      source: 'antigravity',
      title,
      createdAt: createdAt || updatedAt,
      updatedAt,
      branch: metaContext.branch,
      headCommit: metaContext.headCommit,
      deviceHostname: hostname,
      author: metaContext.author,
      filesTouched,
      recap,
      turns,
      rawStepCount: lines.length,
      originalBytes,
      compressedBytes: 0,
    };
    record.compressedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    sessions.push(record);
  }

  return sessions;
}
