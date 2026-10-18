import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Configure global Antigravity (`~/.gemini/config/`) and Claude Code (`~/.claude.json`)
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

\`lore\` automatically syncs compressed AI chat transcripts and architectural takeaways across devices and approved repo contributors via the hidden Git ref \`refs/ai/lore\`.

## How to Use Automatically (Never Ask the User to Explain \`lore\`)

1. **Always-On Digest**:
   In initialized repos, \`.agents/rules/lore-context.md\` is automatically generated and git-excluded. It contains the latest architectural takeaways and recaps of the most recent coding sessions across devices.
2. **MCP Tools Available Everywhere**:
   - \`lore_status\`: Check synced sessions, active takeaways, and authorized SSH recipients for the current repo (also auto-fetches/collects latest context).
   - \`lore_search\`: Full-text BM25 search across all past chat transcripts and architectural notes in the repo (0 token cost until searched).
   - \`lore_get_session\`: Retrieve the full stripped User/Assistant conversation turns of a specific session ID (e.g., from another device or teammate).
   - \`lore_save_takeaway\`: Record a concise architectural decision, gotcha, convention, or WIP state into the repo's Living Digest so future sessions and other devices know it automatically.
   - \`lore_sync\`: Pull and push encrypted context via \`refs/ai/lore\`.
`;
  fs.writeFileSync(skillPath, skillContent, 'utf8');

  // 3. Claude Code Global Config (~/.claude.json) if present
  const claudeJsonPath = path.join(home, '.claude.json');
  let claudeConfigUpdated = false;
  if (fs.existsSync(claudeJsonPath)) {
    try {
      const raw = fs.readFileSync(claudeJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
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
  }

  // 4. Cursor Global MCP Config (~/.cursor/mcp.json) if ~/.cursor exists
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
