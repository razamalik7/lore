import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { CompactTurn, SessionRecord } from '../types.js';
import { buildAutoRecap, isSameOrSubPath, normalizeFsPath } from './antigravity.js';

function getCursorWorkspaceStorageDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'workspaceStorage');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
  }
  return path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
}

/**
 * Collect and deterministically compress Cursor AI composer/chat sessions for a given repository path.
 * Supports both `~/.cursor/projects/<slug>/agent-transcripts` and Cursor's `workspaceStorage/*/state.vscdb`.
 */
export function collectCursorSessions(
  repoRoot: string,
  metaContext: { branch?: string; headCommit?: string; author?: string }
): SessionRecord[] {
  const sessions: SessionRecord[] = [];
  const hostname = os.hostname();

  // 1. Check ~/.cursor/projects/<slug>/agent-transcripts/*.jsonl or *.json
  const cursorProjectsDir = path.join(os.homedir(), '.cursor', 'projects');
  if (fs.existsSync(cursorProjectsDir)) {
    const encodedRepoSlug = repoRoot.replace(/[:\\/ ]+/g, '-').toLowerCase();
    try {
      for (const dir of fs.readdirSync(cursorProjectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        if (!dir.name.toLowerCase().startsWith(encodedRepoSlug)) continue;
        const transcriptsDir = path.join(cursorProjectsDir, dir.name, 'agent-transcripts');
        if (!fs.existsSync(transcriptsDir)) continue;

        for (const f of fs.readdirSync(transcriptsDir)) {
          if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
          const fullPath = path.join(transcriptsDir, f);
          const raw = fs.readFileSync(fullPath, 'utf8');
          const stat = fs.statSync(fullPath);
          const turns: CompactTurn[] = [];
          const filesSet = new Set<string>();

          for (const line of raw.split(/\r?\n/).filter(Boolean)) {
            try {
              const obj = JSON.parse(line);
              const role = obj.role === 'user' ? 'user' : obj.role === 'assistant' ? 'assistant' : null;
              const text = typeof obj.content === 'string' ? obj.content.trim() : typeof obj.text === 'string' ? obj.text.trim() : '';
              if (role && text) {
                turns.push({ role, timestamp: obj.timestamp || stat.mtime.toISOString(), text });
              }
            } catch {
              // Ignore
            }
          }

          if (turns.length > 0) {
            const id = `cursor-${path.basename(f, path.extname(f))}`;
            const firstUser = turns.find((t) => t.role === 'user')?.text ?? 'Cursor Session';
            const title = firstUser.split(/\r?\n/)[0].slice(0, 72);
            const filesTouched = Array.from(filesSet);
            const record: SessionRecord = {
              id,
              source: 'cursor',
              title,
              createdAt: turns[0].timestamp,
              updatedAt: stat.mtime.toISOString(),
              branch: metaContext.branch,
              headCommit: metaContext.headCommit,
              deviceHostname: hostname,
              author: metaContext.author,
              filesTouched,
              recap: buildAutoRecap(title, turns, filesTouched),
              turns,
              rawStepCount: turns.length,
              originalBytes: Buffer.byteLength(raw, 'utf8'),
              compressedBytes: 0,
            };
            record.compressedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
            sessions.push(record);
          }
        }
      }
    } catch {
      // Ignore scan errors
    }
  }

  // 2. Check Cursor workspaceStorage/*/state.vscdb
  const wsStorageDir = getCursorWorkspaceStorageDir();
  if (fs.existsSync(wsStorageDir)) {
    try {
      for (const entry of fs.readdirSync(wsStorageDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const wsJsonPath = path.join(wsStorageDir, entry.name, 'workspace.json');
        const dbPath = path.join(wsStorageDir, entry.name, 'state.vscdb');
        if (!fs.existsSync(wsJsonPath) || !fs.existsSync(dbPath)) continue;

        try {
          const wsMeta = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
          const folderUri = wsMeta.folder || wsMeta.workspace || '';
          if (!folderUri || !isSameOrSubPath(folderUri, repoRoot)) continue;

          const db = new DatabaseSync(dbPath, { readOnly: true });
          const rows = db
            .prepare(
              `SELECT key, value FROM ItemTable
               WHERE key IN ('composer.composerData', 'workbench.panel.aichat.view.aichat.chatdata')`
            )
            .all() as Array<{ key: string; value: string }>;
          db.close();

          for (const row of rows) {
            if (!row.value) continue;
            const originalBytes = Buffer.byteLength(row.value, 'utf8');
            const parsed = JSON.parse(row.value);
            const composers = parsed.allComposers || parsed.tabs || [];
            for (const comp of composers) {
              const conv = comp.conversation || comp.bubbles || [];
              if (!Array.isArray(conv) || conv.length === 0) continue;
              const turns: CompactTurn[] = [];
              for (const msg of conv) {
                const role = msg.type === 1 || msg.role === 'user' ? 'user' : 'assistant';
                const text = String(msg.text || msg.content || '').trim();
                if (text) {
                  turns.push({
                    role,
                    timestamp: new Date(msg.timingInfo?.clientStartTime || comp.lastUpdatedAt || Date.now()).toISOString(),
                    text,
                  });
                }
              }
              if (turns.length === 0) continue;
              const id = comp.composerId || comp.id || `cursor-${entry.name}`;
              const title = comp.name || turns[0].text.split(/\r?\n/)[0].slice(0, 72);
              const updatedAt = new Date(comp.lastUpdatedAt || Date.now()).toISOString();
              const record: SessionRecord = {
                id,
                source: 'cursor',
                title,
                createdAt: turns[0].timestamp,
                updatedAt,
                branch: metaContext.branch,
                headCommit: metaContext.headCommit,
                deviceHostname: hostname,
                author: metaContext.author,
                filesTouched: [],
                recap: buildAutoRecap(title, turns, []),
                turns,
                rawStepCount: conv.length,
                originalBytes,
                compressedBytes: 0,
              };
              record.compressedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
              sessions.push(record);
            }
          }
        } catch {
          // Ignore locked or incompatible vscdb
        }
      }
    } catch {
      // Ignore scan errors
    }
  }

  return sessions;
}
