import crypto from 'node:crypto';
import {
  collectAndCacheLocalSessions,
  commitToGitRef,
  findGitRoot,
  getGitMeta,
  importFromGitRef,
  loadAllLocalSessions,
  loadManifest,
  loadTakeaways,
  pullLoreFromRemote,
  pushLoreToRemote,
  saveTakeaways,
} from './git-store.js';
import {
  refreshWorkspaceContextFiles,
  renderDigestMarkdown,
  searchLore,
} from './context-injector.js';
import type { TakeawayEntry } from './types.js';

const MCP_TOOLS = [
  {
    name: 'lore_status',
    description:
      'Get the current repository Living Digest, recent AI coding sessions across devices, and authorized contributors. Automatically refreshes local sessions.',
    annotations: {
      title: 'Lore Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: {
          type: 'string',
          description: 'Optional path inside the target Git repository (defaults to current working directory).',
        },
      },
    },
  },
  {
    name: 'lore_search',
    description:
      'Full-text BM25 search across all past AI coding sessions and architectural takeaways in this repository. Use this to recall why code was written, past debugging sessions, or work from another device without burning tokens.',
    annotations: {
      title: 'Lore Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords, file names, function names, or concepts to search for.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 8).',
        },
        repoPath: {
          type: 'string',
          description: 'Optional path inside the target Git repository.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lore_get_session',
    description:
      'Retrieve the stripped User/Assistant conversation turns of a specific past session by its ID (or 8-character ID prefix).',
    annotations: {
      title: 'Lore Get Session',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Full session ID or prefix (e.g. from lore_status or lore_search).',
        },
        repoPath: {
          type: 'string',
          description: 'Optional path inside the target Git repository.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'lore_save_takeaway',
    description:
      'Save an important architectural decision, gotcha, convention, or WIP handoff note to the repository Living Digest so future chats and other devices know it automatically.',
    annotations: {
      title: 'Lore Save Takeaway',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['architecture', 'decision', 'gotcha', 'wip', 'convention'],
          description: 'Category of the takeaway.',
        },
        content: {
          type: 'string',
          description: 'Concise 1-3 sentence takeaway or handoff note.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional path inside the target Git repository.',
        },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'lore_sync',
    description:
      'Collect local AI chat transcripts, encrypt them for authorized contributors, merge with remote refs/ai/lore, and push.',
    annotations: {
      title: 'Lore Sync',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        push: {
          type: 'boolean',
          description: 'Whether to push refs/ai/lore to origin (default true).',
        },
        repoPath: {
          type: 'string',
          description: 'Optional path inside the target Git repository.',
        },
      },
    },
  },
];

function resolveRepo(repoPathArg?: unknown): string {
  const start = typeof repoPathArg === 'string' && repoPathArg.trim() ? repoPathArg.trim() : process.cwd();
  const root = findGitRoot(start);
  if (!root) {
    throw new Error(`Not inside a Git repository: ${start}`);
  }
  return root;
}

async function handleToolCall(name: string, args: Record<string, any>): Promise<string> {
  const repoRoot = resolveRepo(args.repoPath);

  if (name === 'lore_status') {
    importFromGitRef(repoRoot);
    collectAndCacheLocalSessions(repoRoot);
    refreshWorkspaceContextFiles(repoRoot);
    const manifest = loadManifest(repoRoot);
    const digest = renderDigestMarkdown(repoRoot);
    const recipients = manifest.recipients.map((r) => `${r.label} (${r.fingerprint})`).join(', ');
    return `${digest}\n---\nAuthorized Recipients (${manifest.recipients.length}): ${recipients}`;
  }

  if (name === 'lore_search') {
    const query = String(args.query || '').trim();
    const limit = typeof args.limit === 'number' ? args.limit : 8;
    collectAndCacheLocalSessions(repoRoot);
    refreshWorkspaceContextFiles(repoRoot);
    const hits = searchLore(repoRoot, query, limit);
    if (hits.length === 0) {
      return `No matches found in lore history for query: "${query}"`;
    }
    return hits
      .map(
        (h, i) =>
          `${i + 1}. [${h.docType.toUpperCase()}] **${h.title}** (id: \`${h.docId}\` · ${h.updatedAt.slice(0, 16)})\n` +
          (h.files ? `   Files: ${h.files}\n` : '') +
          `   Snippet: ${h.snippet}`
      )
      .join('\n\n');
  }

  if (name === 'lore_get_session') {
    const targetId = String(args.sessionId || '').trim().toLowerCase();
    collectAndCacheLocalSessions(repoRoot);
    const sessions = loadAllLocalSessions(repoRoot);
    const match = sessions.find(
      (s) => s.id.toLowerCase() === targetId || s.id.toLowerCase().startsWith(targetId)
    );
    if (!match) {
      return `Session "${args.sessionId}" not found. Available sessions:\n` +
        sessions.map((s) => `- \`${s.id.slice(0, 8)}\`: ${s.title} (${s.updatedAt.slice(0, 16)})`).join('\n');
    }

    const header = [
      `# Session: ${match.title}`,
      `- **ID**: \`${match.id}\``,
      `- **Source**: ${match.source} · **Device**: ${match.deviceHostname || 'unknown'} · **Branch**: ${match.branch || 'main'}`,
      `- **Updated**: ${match.updatedAt}`,
      `- **Files Touched**: ${match.filesTouched.join(', ') || 'none'}`,
      `- **Compression**: ${(match.originalBytes / 1024).toFixed(1)} KB raw → ${(match.compressedBytes / 1024).toFixed(1)} KB stripped`,
      '',
      '## Conversation Transcript',
      '',
    ].join('\n');

    const body = match.turns
      .map((t) => {
        const toolLine =
          t.toolsUsed && t.toolsUsed.length > 0
            ? `\n  _[Tools: ${t.toolsUsed.slice(0, 8).join('; ')}]_\n`
            : '';
        return `### ${t.role === 'user' ? 'User' : 'Assistant'} (${t.timestamp.slice(11, 19)})${toolLine}\n${t.text}`;
      })
      .join('\n\n---\n\n');

    return `${header}${body}`;
  }

  if (name === 'lore_save_takeaway') {
    const category = (args.category || 'decision') as TakeawayEntry['category'];
    const content = String(args.content || '').trim();
    if (!content) throw new Error('Takeaway content cannot be empty');

    const meta = getGitMeta(repoRoot);
    const existing = loadTakeaways(repoRoot);
    const entry: TakeawayEntry = {
      id: crypto.randomUUID().slice(0, 12),
      timestamp: new Date().toISOString(),
      author: meta.author,
      category,
      content,
      commitSha: meta.headCommit,
    };
    saveTakeaways(repoRoot, [...existing, entry]);
    commitToGitRef(repoRoot);
    const { tokenEstimate } = refreshWorkspaceContextFiles(repoRoot);
    return `Saved [${category.toUpperCase()}] takeaway (${entry.id}) to refs/ai/lore and updated .agents/rules/lore-context.md (~${tokenEstimate} tokens).`;
  }

  if (name === 'lore_sync') {
    const shouldPush = args.push !== false;
    if (shouldPush) {
      const res = pushLoreToRemote(repoRoot);
      const { tokenEstimate } = refreshWorkspaceContextFiles(repoRoot);
      return `Synced lore to refs/ai/lore (${res.commitSha.slice(0, 8)}): ${res.sessionCount} sessions, ${res.takeawayCount} takeaways. Remote push: ${res.pushed ? 'success' : 'local-only (no remote)'}. Digest size: ~${tokenEstimate} tokens.`;
    } else {
      pullLoreFromRemote(repoRoot);
      collectAndCacheLocalSessions(repoRoot);
      const res = commitToGitRef(repoRoot);
      const { tokenEstimate } = refreshWorkspaceContextFiles(repoRoot);
      return `Synced lore locally to refs/ai/lore (${res.commitSha.slice(0, 8)}): ${res.sessionCount} sessions, ${res.takeawayCount} takeaways (~${tokenEstimate} tokens).`;
    }
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}

/**
 * Start the MCP Stdio JSON-RPC 2.0 Server.
 */
export function startMcpServer(): void {
  let useContentLengthFraming = false;
  let buffer = '';

  const sendResponse = (msg: Record<string, any>) => {
    const json = JSON.stringify(msg);
    if (useContentLengthFraming) {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  const handleRpcMessage = async (req: any) => {
    if (!req || typeof req !== 'object') return;
    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        // Proactively refresh context if launched inside a git repo
        const root = findGitRoot(process.cwd());
        if (root) {
          try {
            importFromGitRef(root);
            collectAndCacheLocalSessions(root);
            refreshWorkspaceContextFiles(root);
          } catch {
            // Non-fatal during initialize
          }
        }

        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'lore',
              version: '0.1.0',
            },
          },
        });
        return;
      }

      if (method === 'notifications/initialized' || id === undefined) {
        return;
      }

      if (method === 'ping') {
        sendResponse({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS,
          },
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const textResult = await handleToolCall(toolName, toolArgs);
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: textResult }],
            },
          });
        } catch (err: any) {
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `lore error: ${err.message}` }],
            },
          });
        }
        return;
      }

      sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (err: any) {
      if (id !== undefined) {
        sendResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err.message || 'Internal error' },
        });
      }
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    while (buffer.length > 0) {
      if (buffer.startsWith('Content-Length:')) {
        useContentLengthFraming = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        const len = match ? parseInt(match[1], 10) : 0;
        const rest = buffer.slice(headerEnd + 4);
        if (Buffer.byteLength(rest, 'utf8') < len) break;
        const bodyBuf = Buffer.from(rest, 'utf8').subarray(0, len);
        const bodyStr = bodyBuf.toString('utf8');
        buffer = Buffer.from(rest, 'utf8').subarray(len).toString('utf8');
        try {
          handleRpcMessage(JSON.parse(bodyStr));
        } catch {
          // Ignore malformed JSON
        }
      } else {
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx === -1) break;
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          handleRpcMessage(JSON.parse(line));
        } catch {
          // Ignore malformed line
        }
      }
    }
  });
}
