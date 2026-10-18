import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CompactTurn, SessionRecord } from '../types.js';
import { buildAutoRecap, isSameOrSubPath, normalizeFsPath } from './antigravity.js';

function walkJsonlFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(full, acc);
    } else if (entry.name.endsWith('.jsonl')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Collect and deterministically compress OpenAI Codex CLI sessions (`~/.codex/sessions/**`) for a given repository path.
 */
export function collectCodexSessions(
  repoRoot: string,
  metaContext: { branch?: string; headCommit?: string; author?: string }
): SessionRecord[] {
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(codexSessionsDir)) {
    return [];
  }

  const files = walkJsonlFiles(codexSessionsDir);
  const sessions: SessionRecord[] = [];
  const hostname = os.hostname();
  const normRepo = normalizeFsPath(repoRoot);

  for (const filePath of files) {
    try {
      const rawContent = fs.readFileSync(filePath, 'utf8');
      if (!normalizeFsPath(rawContent).includes(normRepo)) continue;

      const originalBytes = Buffer.byteLength(rawContent, 'utf8');
      const lines = rawContent.split(/\r?\n/).filter(Boolean);
      const stat = fs.statSync(filePath);

      let sessionId = path.basename(filePath, '.jsonl');
      let matchedCwd = false;
      let createdAt = '';
      let updatedAt = stat.mtime.toISOString();
      const turns: CompactTurn[] = [];
      const filesSet = new Set<string>();

      for (const line of lines) {
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.id && !createdAt) sessionId = obj.id;
        if (obj.timestamp) {
          if (!createdAt) createdAt = obj.timestamp;
          updatedAt = obj.timestamp;
        }
        const cwd = obj.cwd || obj.payload?.cwd || obj.context?.cwd;
        if (typeof cwd === 'string' && isSameOrSubPath(cwd, repoRoot)) {
          matchedCwd = true;
        }

        const role = obj.role || obj.payload?.role;
        const content = obj.content || obj.payload?.content || obj.message?.content;
        if (role === 'user' || role === 'assistant') {
          let text = '';
          if (typeof content === 'string') {
            text = content.trim();
          } else if (Array.isArray(content)) {
            text = content
              .filter((c: any) => (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') && c.text)
              .map((c: any) => String(c.text).trim())
              .join('\n')
              .trim();
          }
          if (text) {
            turns.push({
              role,
              timestamp: obj.timestamp || updatedAt,
              text,
            });
          }
        }
      }

      if (!matchedCwd || turns.length === 0) continue;

      const firstUser = turns.find((t) => t.role === 'user')?.text ?? 'Codex Session';
      const title = firstUser.split(/\r?\n/)[0].slice(0, 72) + (firstUser.length > 72 ? '…' : '');
      const filesTouched = Array.from(filesSet);

      const record: SessionRecord = {
        id: sessionId,
        source: 'codex',
        title,
        createdAt: createdAt || updatedAt,
        updatedAt,
        branch: metaContext.branch,
        headCommit: metaContext.headCommit,
        deviceHostname: hostname,
        author: metaContext.author,
        filesTouched,
        recap: buildAutoRecap(title, turns, filesTouched),
        turns,
        rawStepCount: lines.length,
        originalBytes,
        compressedBytes: 0,
      };
      record.compressedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
      sessions.push(record);
    } catch {
      // Ignore unreadable session file
    }
  }

  return sessions;
}
