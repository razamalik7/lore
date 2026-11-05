import type { CompactTurn, SessionRecord } from './types.js';

/** Sessions longer than this get an outline + recent turns by default instead of a full dump (MCP). */
export const LONG_SESSION_TURNS = 60;
export const DEFAULT_TAIL_TURNS = 20;

export interface TurnRange {
  /** 1-based, inclusive */
  from: number;
  /** 1-based, inclusive */
  to: number;
}

/**
 * Resolve `last` / `from` / `to` options into a concrete 1-based turn range.
 * `last` wins over from/to. Out-of-range values are clamped.
 */
export function resolveTurnRange(
  total: number,
  opts: { last?: number; from?: number; to?: number }
): TurnRange {
  if (total === 0) return { from: 1, to: 0 };
  const clamp = (n: number) => Math.min(Math.max(1, Math.floor(n)), total);
  if (opts.last && opts.last > 0) {
    return { from: clamp(total - opts.last + 1), to: total };
  }
  const from = opts.from ? clamp(opts.from) : 1;
  const to = opts.to ? clamp(opts.to) : total;
  return from <= to ? { from, to } : { from: to, to: from };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One line per user prompt, with its turn number, so an agent can jump into the
 * middle of a long session instead of reading only the end.
 */
export function renderOutline(session: SessionRecord, maxLineChars = 110): string {
  const lines: string[] = [];
  let assistantSince = 0;
  let lastUserIdx = -1;
  const flush = () => {
    if (lastUserIdx >= 0 && assistantSince > 0) {
      lines[lines.length - 1] += `  (+${assistantSince} agent turn${assistantSince === 1 ? '' : 's'})`;
    }
  };
  session.turns.forEach((t, i) => {
    if (t.role === 'user') {
      flush();
      assistantSince = 0;
      lastUserIdx = i;
      lines.push(`#${i + 1} [${t.timestamp.slice(0, 16).replace('T', ' ')}] ${oneLine(t.text, maxLineChars)}`);
    } else {
      assistantSince++;
    }
  });
  flush();
  return lines.join('\n');
}

export function renderTurnMarkdown(t: CompactTurn, index: number): string {
  const toolLine =
    t.toolsUsed && t.toolsUsed.length > 0 ? `\n  _[Tools: ${t.toolsUsed.slice(0, 8).join('; ')}]_` : '';
  const outputLines =
    t.toolOutputs && t.toolOutputs.length > 0
      ? `\n  _[Output: ${t.toolOutputs.slice(0, 6).map((o) => oneLine(o, 240)).join(' ‖ ')}]_`
      : '';
  return `### #${index + 1} ${t.role === 'user' ? 'User' : 'Assistant'} (${t.timestamp.slice(0, 16).replace('T', ' ')})${toolLine}${outputLines}\n${t.text}`;
}

export interface SessionViewOptions {
  last?: number;
  from?: number;
  to?: number;
  outline?: boolean;
  /** When no range is given, long sessions show outline + last turns instead of everything. */
  smartDefault?: boolean;
}

/** Markdown view of a session used by MCP `lore_get_session`. */
export function renderSessionMarkdown(session: SessionRecord, opts: SessionViewOptions = {}): string {
  const total = session.turns.length;
  const header = [
    `# Session: ${session.title}`,
    `- **ID**: \`${session.id}\``,
    `- **Source**: ${session.source} · **Device**: ${session.deviceHostname || 'unknown'} · **Branch**: ${session.branch || 'main'}`,
    `- **Updated**: ${session.updatedAt} · **Turns**: ${total}`,
    `- **Files Touched**: ${session.filesTouched.join(', ') || 'none'}`,
    '',
  ];

  if (opts.outline) {
    return [
      ...header,
      '## Outline (user prompts with turn numbers)',
      '',
      renderOutline(session),
      '',
      `_Read a stretch with sessionId \`${session.id.slice(0, 8)}\` and from/to (turn numbers above)._`,
    ].join('\n');
  }

  const hasRange = Boolean(opts.last || opts.from || opts.to);
  if (!hasRange && opts.smartDefault && total > LONG_SESSION_TURNS) {
    const range = resolveTurnRange(total, { last: DEFAULT_TAIL_TURNS });
    return [
      ...header,
      `This session is long (${total} turns), so here is its outline and the last ${DEFAULT_TAIL_TURNS} turns.`,
      `Decisions made mid-session are often not in the last turns: use the outline to pick a stretch, then call again with from/to.`,
      '',
      '## Outline',
      '',
      renderOutline(session),
      '',
      `## Turns ${range.from}–${range.to} of ${total}`,
      '',
      session.turns
        .slice(range.from - 1, range.to)
        .map((t, i) => renderTurnMarkdown(t, range.from - 1 + i))
        .join('\n\n---\n\n'),
    ].join('\n');
  }

  const range = resolveTurnRange(total, opts);
  const body = session.turns
    .slice(range.from - 1, range.to)
    .map((t, i) => renderTurnMarkdown(t, range.from - 1 + i))
    .join('\n\n---\n\n');
  const rangeNote = range.from === 1 && range.to === total ? `## Conversation (${total} turns)` : `## Turns ${range.from}–${range.to} of ${total}`;
  return [...header, rangeNote, '', body].join('\n');
}
