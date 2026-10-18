import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CompactTurn, SessionRecord, TakeawayEntry } from '../types.js';
import {
  buildAutoRecap,
  getEncodedRepoSlugs,
  isSameOrSubPath,
  matchesRepoSlug,
  normalizeFsPath,
} from './antigravity.js';

/**
 * Collect and deterministically compress Claude Code sessions (`~/.claude/projects/*`) for a given repository path.
 */
export function collectClaudeCodeSessions(
  repoRoot: string,
  metaContext: { branch?: string; headCommit?: string; author?: string },
  customClaudeProjectsDir?: string
): SessionRecord[] {
  const claudeProjectsDir =
    customClaudeProjectsDir || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeProjectsDir)) {
    return [];
  }

  // Support both single-dash (c-users-...) and multi-dash (c--users-...) slugs on Windows + worktree suffixes
  const repoSlugs = getEncodedRepoSlugs(repoRoot);
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

  const candidateFiles: string[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (matchesRepoSlug(dir.name, repoRoot)) {
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

      if (entry.type === 'custom-title' && entry.customTitle) {
        aiTitle = entry.customTitle;
      } else if (entry.type === 'ai-title' && entry.aiTitle && !aiTitle) {
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

    const sessionFolder = path.join(path.dirname(filePath), sessionId);
    const customTitleFile = path.join(sessionFolder, 'custom-title.json');
    if (!aiTitle && fs.existsSync(customTitleFile)) {
      try {
        const ct = JSON.parse(fs.readFileSync(customTitleFile, 'utf8'));
        if (ct.customTitle) aiTitle = ct.customTitle;
      } catch {
        // Ignore
      }
    }

    const normFile = normalizeFsPath(filePath).toLowerCase();
    if (!matchedCwd && !repoSlugs.some((slug) => normFile.includes(slug))) {
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

function inferMemoryCategory(
  name: string,
  description: string,
  metaType: string
): TakeawayEntry['category'] {
  const combined = `${name} ${description} ${metaType}`.toLowerCase();
  if (metaType === 'feedback' || /\b(standard|convention|feedback|rule|style)\b/.test(combined)) {
    return 'convention';
  }
  if (/\b(queue|todo|wip|open-items|roadmap)\b/.test(combined)) {
    return 'wip';
  }
  if (/\b(dead|lie|gamed|collision|bug|gotcha|broken|is-ice|audit|phantom|trap)\b/.test(combined)) {
    return 'gotcha';
  }
  if (metaType === 'project' || /\b(architecture|scope|pipeline|system|layer)\b/.test(combined)) {
    return 'architecture';
  }
  return 'decision';
}

/**
 * Automatically harvest curated Claude Code project memory files (`~/.claude/projects/<slug>/memory/*.md`)
 * as Lore takeaways so architectural notes, gotchas, and feedback are synced and indexed with zero manual effort.
 */
export function collectClaudeMemoryTakeaways(
  repoRoot: string,
  metaContext: { branch?: string; headCommit?: string; author?: string },
  customClaudeProjectsDir?: string
): TakeawayEntry[] {
  const claudeProjectsDir =
    customClaudeProjectsDir || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeProjectsDir)) {
    return [];
  }

  const takeaways: TakeawayEntry[] = [];
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (!matchesRepoSlug(dir.name, repoRoot)) continue;

    const memoryDir = path.join(claudeProjectsDir, dir.name, 'memory');
    if (!fs.existsSync(memoryDir)) continue;

    const mdFiles = fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'memory.md');

    for (const file of mdFiles) {
      const fullPath = path.join(memoryDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8').trim();
        if (!raw) continue;
        const stat = fs.statSync(fullPath);

        const baseSlug = path.basename(file, '.md');
        let name = baseSlug;
        let description = '';
        let metaType = '';
        let originSessionId: string | undefined;
        let modified = stat.mtime.toISOString();
        let body = raw;

        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (fmMatch) {
          const fm = fmMatch[1];
          body = fmMatch[2].trim();

          const nameMatch = fm.match(/^\s*name:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');

          const descMatch = fm.match(/^\s*description:\s*"([^"]+)"/m) || fm.match(/^\s*description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');

          const typeMatch = fm.match(/^\s*type:\s*(.+)$/m);
          if (typeMatch) metaType = typeMatch[1].trim().replace(/^["']|["']$/g, '');

          const sessMatch = fm.match(/^\s*originSessionId:\s*(.+)$/m);
          if (sessMatch) originSessionId = sessMatch[1].trim().replace(/^["']|["']$/g, '');

          const modMatch = fm.match(/^\s*modified:\s*(.+)$/m);
          if (modMatch) modified = modMatch[1].trim().replace(/^["']|["']$/g, '');
        }

        const firstBodyLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) || name;
        const headline = description ? `${name}: ${description}` : `${name}: ${firstBodyLine}`;
        const fullContent = body ? `${headline}\n\n${body}` : headline;

        takeaways.push({
          id: `claude-${baseSlug}`,
          timestamp: modified,
          author: metaContext.author || 'claude-code',
          category: inferMemoryCategory(name, description, metaType),
          content: fullContent,
          sessionId: originSessionId,
          commitSha: metaContext.headCommit,
        });
      } catch {
        // Ignore unreadable memory file
      }
    }
  }

  return takeaways;
}

