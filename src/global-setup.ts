import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AGENTS_MD_BLOCK,
  ANTIGRAVITY_SKILL_MD,
  CLAUDE_MD_BLOCK,
  upsertMarkedBlock,
} from './agent-instructions.js';

/**
 * Configure global Antigravity (`~/.gemini/config/`) and Claude Code (`~/.claude.json` + `~/.claude/CLAUDE.md`)
 * so agents across all repositories automatically have `lore` MCP tools and instructions
 * without the user ever needing to explain `lore` in chat.
 */
const HANDOFF_HOOK_TAG = ' handoff --hook';

/**
 * Add, update, or remove lore's Claude Code SessionStart hook (`lore handoff --hook`).
 * `want` true adds it, false removes it, undefined keeps whatever is there (re-pointing its path).
 * Returns whether the hook is installed afterwards.
 */
export function applyHandoffHook(settings: Record<string, any>, cliPath: string, want: boolean | undefined): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const groups: any[] = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes(HANDOFF_HOOK_TAG);
  const hadIt = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs));
  const keep = want ?? hadIt;

  const cleaned = groups
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (keep) {
    cleaned.push({
      matcher: 'startup|resume|clear',
      hooks: [{ type: 'command', command: `node "${cliPath.replace(/\\/g, '/')}"${HANDOFF_HOOK_TAG}`, timeout: 20 }],
    });
  }
  if (cleaned.length > 0) settings.hooks.SessionStart = cleaned;
  else delete settings.hooks.SessionStart;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return keep;
}

export function installGlobalAgentIntegrations(
  cliEntryPath: string,
  opts: { handoff?: boolean } = {}
): {
  antigravityMcpPath: string;
  antigravitySkillPath: string;
  claudeConfigUpdated: boolean;
  handoffHookInstalled: boolean;
  codexInstructionsPath?: string;
} {
  const home = os.homedir();
  const normalizedCli = path.resolve(cliEntryPath);
  let handoffHookInstalled = false;
  let codexInstructionsPath: string | undefined;

  // 1. Antigravity Global MCP Config (~/.gemini/config/mcp_config.json)
  const agyConfigDir = path.join(home, '.gemini', 'config');
  fs.mkdirSync(agyConfigDir, { recursive: true });
  const agyMcpPath = path.join(agyConfigDir, 'mcp_config.json');

  let mcpConfig: Record<string, any> = { mcpServers: {} };
  if (fs.existsSync(agyMcpPath)) {
    const raw = fs.readFileSync(agyMcpPath, 'utf8').trim();
    if (raw.length > 0) {
      try {
        mcpConfig = JSON.parse(raw);
      } catch {
        mcpConfig = { mcpServers: {} };
      }
    }
  }
  if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
    mcpConfig.mcpServers = {};
  }

  delete mcpConfig.mcpServers.llore;
  mcpConfig.mcpServers.lore = {
    command: 'node',
    args: [normalizedCli, 'mcp'],
  };
  fs.writeFileSync(agyMcpPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

  // 2. Antigravity Global Skill (~/.gemini/config/skills/lore/SKILL.md)
  const skillDir = path.join(agyConfigDir, 'skills', 'lore');
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  const skillContent = ANTIGRAVITY_SKILL_MD;
  fs.writeFileSync(skillPath, skillContent, 'utf8');

  // 3. Claude Code Global Config (~/.claude.json + ~/.claude/CLAUDE.md)
  const claudeJsonPath = path.join(home, '.claude.json');
  let claudeConfigUpdated = false;
  try {
    let parsed: Record<string, any> = {};
    if (fs.existsSync(claudeJsonPath)) {
      const raw = fs.readFileSync(claudeJsonPath, 'utf8').trim();
      if (raw) parsed = JSON.parse(raw);
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      parsed.mcpServers = {};
    }
    delete parsed.mcpServers.llore;
    parsed.mcpServers.lore = {
      type: 'stdio',
      command: 'node',
      args: [normalizedCli, 'mcp'],
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(parsed, null, 2), 'utf8');
    claudeConfigUpdated = true;
  } catch {
    // Ignore if ~/.claude.json is locked or non-standard
  }

  const claudeDir = path.join(home, '.claude');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    const existingMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8') : null;
    fs.writeFileSync(
      claudeMdPath,
      upsertMarkedBlock(existingMd, CLAUDE_MD_BLOCK, '# Global Claude Code Instructions'),
      'utf8'
    );

    // Also auto-allow lore CLI and MCP tools in ~/.claude/settings.json so Claude never prompts for permission
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    let claudeSettings: Record<string, any> = {};
    if (fs.existsSync(claudeSettingsPath)) {
      const rawSettings = fs.readFileSync(claudeSettingsPath, 'utf8').trim();
      if (rawSettings) {
        try {
          claudeSettings = JSON.parse(rawSettings);
        } catch {
          claudeSettings = {};
        }
      }
    }
    if (!claudeSettings.permissions || typeof claudeSettings.permissions !== 'object') {
      claudeSettings.permissions = {};
    }
    if (!Array.isArray(claudeSettings.permissions.allow)) {
      claudeSettings.permissions.allow = [];
    }
    for (const rule of ['Bash(lore:*)', 'mcp__lore__*']) {
      if (!claudeSettings.permissions.allow.includes(rule)) {
        claudeSettings.permissions.allow.push(rule);
      }
    }
    handoffHookInstalled = applyHandoffHook(claudeSettings, normalizedCli, opts.handoff);
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2), 'utf8');
  } catch {
    // Ignore if ~/.claude/CLAUDE.md is not writable
  }

  // 4. Claude Desktop Config (Standard + Windows Store MSIX + macOS/Linux)
  const claudeDesktopConfigDirs: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    claudeDesktopConfigDirs.push(path.join(appData, 'Claude'));
    const packagesDir = path.join(localAppData, 'Packages');
    if (fs.existsSync(packagesDir)) {
      try {
        for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('Claude_')) {
            claudeDesktopConfigDirs.push(
              path.join(packagesDir, entry.name, 'LocalCache', 'Roaming', 'Claude')
            );
          }
        }
      } catch {
        // Ignore
      }
    }
  } else if (process.platform === 'darwin') {
    claudeDesktopConfigDirs.push(
      path.join(home, 'Library', 'Application Support', 'Claude')
    );
  } else {
    claudeDesktopConfigDirs.push(path.join(home, '.config', 'Claude'));
  }

  for (const desktopDir of claudeDesktopConfigDirs) {
    if (!fs.existsSync(desktopDir)) continue;
    try {
      const desktopCfgPath = path.join(desktopDir, 'claude_desktop_config.json');
      let desktopCfg: Record<string, any> = {};
      if (fs.existsSync(desktopCfgPath)) {
        const raw = fs.readFileSync(desktopCfgPath, 'utf8').trim();
        if (raw) desktopCfg = JSON.parse(raw);
      }
      if (!desktopCfg.mcpServers || typeof desktopCfg.mcpServers !== 'object') {
        desktopCfg.mcpServers = {};
      }
      delete desktopCfg.mcpServers.llore;
      desktopCfg.mcpServers.lore = {
        command: process.execPath || 'node',
        args: [normalizedCli, 'mcp'],
      };
      fs.writeFileSync(desktopCfgPath, JSON.stringify(desktopCfg, null, 2), 'utf8');
      claudeConfigUpdated = true;
    } catch {
      // Ignore if locked or unwritable
    }
  }

  // 5. Cursor Global MCP Config (~/.cursor/mcp.json) if ~/.cursor exists
  const cursorDir = path.join(home, '.cursor');
  if (fs.existsSync(cursorDir)) {
    try {
      const cursorMcpPath = path.join(cursorDir, 'mcp.json');
      let cursorMcp: Record<string, any> = { mcpServers: {} };
      if (fs.existsSync(cursorMcpPath)) {
        const raw = fs.readFileSync(cursorMcpPath, 'utf8').trim();
        if (raw) cursorMcp = JSON.parse(raw);
      }
      if (!cursorMcp.mcpServers || typeof cursorMcp.mcpServers !== 'object') {
        cursorMcp.mcpServers = {};
      }
      cursorMcp.mcpServers.lore = {
        command: 'node',
        args: [normalizedCli, 'mcp'],
      };
      fs.writeFileSync(cursorMcpPath, JSON.stringify(cursorMcp, null, 2), 'utf8');
    } catch {
      // Ignore
    }
  }

  // 6. Codex global instructions (~/.codex/AGENTS.md) if Codex is installed
  const codexDir = path.join(home, '.codex');
  if (fs.existsSync(codexDir)) {
    try {
      const agentsPath = path.join(codexDir, 'AGENTS.md');
      const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
      fs.writeFileSync(agentsPath, upsertMarkedBlock(existing, AGENTS_MD_BLOCK, '# Global Codex Instructions'), 'utf8');
      codexInstructionsPath = agentsPath;
    } catch {
      // Ignore
    }
  }

  return {
    antigravityMcpPath: agyMcpPath,
    antigravitySkillPath: skillPath,
    claudeConfigUpdated,
    handoffHookInstalled,
    codexInstructionsPath,
  };
}
