import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CompactTurn, SessionRecord } from '../types.js';
import { buildAutoRecap, isSameOrSubPath, normalizeFsPath } from './antigravity.js';

/**
 * Collect and deterministically compress Claude Code sessions (`~/.claude/projects/*`) for a given repository path.
 */
export function collectClaudeCodeSessions(
  repoRoot: string,
  metaContext: { branch?: string; headCommit?: string; author?: string }
): SessionRecord[] {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeProjectsDir)) {
    return [];
  }

  // Claude Code encodes project directory names by replacing ':', '\', '/', ' ' with '-'
  const encodedRepoSlug = repoRoot.replace(/[:\\/ ]+/g, '-').toLowerCase();
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

  const candidateFiles: string[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirSlug = dir.name.toLowerCase();
    if (dirSlug === encodedRepoSlug || dirSlug.startsWith(encodedRepoSlug)) {
      const fullDir = path.join(claudeProjectsDir, dir.name);
      for (const f of fs.readdirSync(fullDir)) {
        if (f.endsWith('.jsonl')) {
          candidateFiles.push(path.join(fullDir, f));
        }
      }
    }
  }

  const sessions: SessionRecord[] = [];
  const hostname = os.hostname();

  for (const filePath of candidateFiles) {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const originalBytes = Buffer.byteLength(rawContent, 'utf8');
    const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);

    let sessionId = path.basename(filePath, '.jsonl');
    let aiTitle = '';
    let createdAt = '';
    let updatedAt = fs.statSync(filePath).mtime.toISOString();
    let branch = metaContext.branch;

    const turns: CompactTurn[] = [];
    const filesSet = new Set<string>();
    let pendingTools: string[] = [];
    let pendingFiles: string[] = [];
    let matchedCwd = false;

    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.sessionId) sessionId = entry.sessionId;
      if (entry.timestamp) {
        if (!createdAt) createdAt = entry.timestamp;
        updatedAt = entry.timestamp;
      }
      if (entry.gitBranch && entry.gitBranch !== 'HEAD') {
        branch = entry.gitBranch;
      }
      if (entry.cwd && isSameOrSubPath(entry.cwd, repoRoot)) {
        matchedCwd = true;
      }

      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      } else if (entry.type === 'user' && entry.message?.content) {
        const content = entry.message.content;
        let text = '';
        if (typeof content === 'string') {
          text = content.trim();
        } else if (Array.isArray(content)) {
          text = content
            .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text.trim())
            .join('\n')
            .trim();
        }
        if (text) {
          turns.push({
            role: 'user',
            timestamp: entry.timestamp || updatedAt,
            text,
          });
        }
      } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const textBlocks: string[] = [];
        for (const block of entry.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            textBlocks.push(block.text.trim());
          } else if (block.type === 'tool_use') {
            const name = block.name || 'tool';
            const input = block.input || {};
            const desc = input.description || input.command || input.file_path || input.path || '';
            pendingTools.push(desc ? `${name}: ${String(desc).slice(0, 60)}` : name);

            const fp = input.file_path || input.path;
            if (typeof fp === 'string' && isSameOrSubPath(fp, repoRoot)) {
              const rel = path.relative(repoRoot, fp).replace(/\\/g, '/');
              if (rel && !rel.startsWith('..')) {
                filesSet.add(rel);
                pendingFiles.push(rel);
              }
            }
          }
        }

        if (textBlocks.length > 0) {
          turns.push({
            role: 'assistant',
            timestamp: entry.timestamp || updatedAt,
            text: textBlocks.join('\n\n'),
            toolsUsed: pendingTools.length > 0 ? Array.from(new Set(pendingTools)) : undefined,
            filesTouched: pendingFiles.length > 0 ? Array.from(new Set(pendingFiles)) : undefined,
          });
          pendingTools = [];
          pendingFiles = [];
        }
      }
    }

    if (!matchedCwd && normalizeFsPath(filePath).indexOf(encodedRepoSlug) === -1) {
      continue;
    }
    if (turns.length === 0) continue;

    const firstUserText = turns.find((t) => t.role === 'user')?.text ?? 'Claude Session';
    const title =
      aiTitle.trim() ||
      firstUserText.split(/\r?\n/)[0].slice(0, 72) + (firstUserText.length > 72 ? '…' : '');
    const filesTouched = Array.from(filesSet);
    const recap = buildAutoRecap(title, turns, filesTouched);

    const record: SessionRecord = {
      id: sessionId,
      source: 'claude-code',
      title,
      createdAt: createdAt || updatedAt,
      updatedAt,
      branch,
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
