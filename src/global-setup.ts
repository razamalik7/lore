import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Configure global Antigravity (`~/.gemini/config/`) and Claude Code (`~/.claude.json` + `~/.claude/CLAUDE.md`)
 * so agents across all repositories automatically have `lore` MCP tools and instructions
 * without the user ever needing to explain `lore` in chat.
 */
export function installGlobalAgentIntegrations(cliEntryPath: string): {
  antigravityMcpPath: string;
  antigravitySkillPath: string;
  claudeConfigUpdated: boolean;
} {
  const home = os.homedir();
  const normalizedCli = path.resolve(cliEntryPath);

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
  const skillContent = `---
name: lore
description: >-
  Automatic cross-device and team AI context memory synced via encrypted Git refs (refs/ai/lore).
  Use automatically whenever the user references past chats, work from another device, architectural decisions,
  or when completing significant milestones in a Git repository.
---

# lore — Git-Native Encrypted AI Context & Memory

\`lore\` automatically syncs compressed AI chat transcripts, Claude Code project memories (\`memory/*.md\`), and architectural takeaways across devices and approved repo contributors via the hidden Git ref \`refs/ai/lore\`.

## How to Use Automatically (Zero Permission Prompts)

1. **Always-On Digest**:
   In initialized repos, \`.agents/rules/lore-context.md\` is automatically generated and git-excluded. Read it with \`view_file\` for the latest architectural takeaways and recaps of recent coding sessions across devices.
2. **CLI Commands (Preferred in Antigravity for Zero Permission Prompts)**:
   Run \`lore\` directly via \`run_command\` so it executes seamlessly without MCP confirmation dialogs:
   - \`lore status\`: Check synced sessions, compression stats, takeaways, and authorized SSH recipients.
   - \`lore search "<query>"\`: Full-text BM25 search across all past sessions & takeaways (<15ms, 0 token cost).
   - \`lore show <session-id>\`: View the stripped User/Assistant conversation turns of a specific session.
   - \`lore note "<text>" --cat <decision|architecture|gotcha|wip|convention>\`: Save a takeaway to the Living Digest.
   - \`lore sync\`: Collect local sessions + Claude \`memory/*.md\`, encrypt, merge with remote \`refs/ai/lore\`, and push.
3. **MCP Tools (Alternative when CLI is unavailable)**:
   \`lore_status\`, \`lore_search\`, \`lore_get_session\`, \`lore_save_takeaway\`, \`lore_sync\`.
`;
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
    const claudeLoreBlock = `<!-- lore-global-instructions -->
## \`lore\` — Cross-Device & Multi-Agent Git Context Memory
- In repositories using \`lore\`, read \`.agents/rules/lore-context.md\` (or run \`lore status\` / call MCP tool \`lore_status\`) to see shared architectural takeaways and recent sessions from Antigravity, Claude Code, Cursor, and Codex across devices.
- Search past sessions & takeaways with \`lore search "<query>"\` (or MCP \`lore_search\`), view full session transcripts with \`lore show <id>\` (or MCP \`lore_get_session\`), record key decisions/gotchas with \`lore note "<text>" --cat <decision|architecture|gotcha|wip|convention>\`, and sync via \`lore sync\`.
<!-- /lore-global-instructions -->`;
    if (fs.existsSync(claudeMdPath)) {
      const existingMd = fs.readFileSync(claudeMdPath, 'utf8');
      if (existingMd.includes('<!-- lore-global-instructions -->')) {
        const updatedMd = existingMd.replace(
          /<!-- lore-global-instructions -->[\s\S]*?<!-- \/lore-global-instructions -->/,
          claudeLoreBlock
        );
        fs.writeFileSync(claudeMdPath, updatedMd, 'utf8');
      } else {
        fs.writeFileSync(claudeMdPath, `${existingMd.trimEnd()}\n\n${claudeLoreBlock}\n`, 'utf8');
      }
    } else {
      fs.writeFileSync(claudeMdPath, `# Global Claude Code Instructions\n\n${claudeLoreBlock}\n`, 'utf8');
    }

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

  return {
    antigravityMcpPath: agyMcpPath,
    antigravitySkillPath: skillPath,
    claudeConfigUpdated,
  };
}
