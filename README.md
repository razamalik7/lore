# `lore` (`git-lore`)

**Git-native, encrypted, zero-token-bloat AI context & transcript sync across devices and contributors.**

`lore` syncs your AI coding sessions (Antigravity, Claude Code) and architectural takeaways directly through Git using an encrypted hidden ref (`refs/ai/lore`)—without polluting `git log`, `git status`, or burning thousands of tokens.

---

## Why `lore`?

1. **Zero Token Bloat (3-Tier Context Pyramid)**:
   - **Deterministic Transcript Stripping**: Strips ~90%+ of raw `.jsonl` bloat (giant file reads, grep dumps, internal schemas) on `git push` in `<50ms` with **0 LLM API calls**.
   - **Always-On Living Digest (~400 tokens)**: Automatically writes a git-excluded `.agents/rules/lore-context.md` containing active architectural takeaways and recaps of the last 4 sessions across devices.
   - **0-Token Deep Recall (SQLite FTS5 + MCP)**: Full stripped transcripts are indexed locally in `.git/lore/search.db` and queried on demand via MCP (`lore_search`, `lore_get_session`).
2. **Private Context on Public Repos**:
   - Uses **SSH Ed25519 → X25519 ECDH + AES-256-GCM multi-recipient envelope encryption**.
   - Authorize teammates directly via their GitHub username (`lore allow @username` fetches `https://github.com/username.keys`).
   - Anyone cloning a public repo without an authorized private key in `~/.ssh/` cannot decrypt `refs/ai/lore`.
3. **Zero Workflow Friction**:
   - Syncs automatically on `git push` (`pre-push` hook) and `git pull` (`post-merge` hook).
   - Works as both `lore <cmd>` and native Git subcommand `git lore <cmd>`.

---

## Quick Start

```bash
# 1. One-time machine setup (registers global MCP server & skill for Antigravity + Claude Code)
lore setup

# 2. Initialize in any Git repository
lore init

# 3. Authorize a teammate (fetches their ssh-ed25519 key from github.com/<user>.keys)
lore allow @octocat
```

---

## CLI Commands

| Command | Description |
| :--- | :--- |
| `lore setup` | One-time global install for Antigravity (`~/.gemini/config/`) and Claude Code (`~/.claude.json`) |
| `lore init` | Initialize `lore` in the current Git repo (installs hooks, authorizes local SSH key, syncs chats) |
| `lore status` | View synced sessions, compression ratio, takeaways, and authorized SSH keys |
| `lore sync` / `lore push` | Collect local transcripts, encrypt, merge with remote `refs/ai/lore`, and push |
| `lore pull` | Fetch & decrypt `refs/ai/lore` from `origin` and update `.agents/rules/lore-context.md` |
| `lore allow <@github-user>` | Authorize a GitHub user (or raw `ssh-ed25519` key) to decrypt repo context |
| `lore revoke <user>` | Remove a recipient and rotate encryption keys |
| `lore note "<text>"` | Save an architectural decision, gotcha, or WIP note (`--cat decision\|architecture\|gotcha\|wip`) |
| `lore search <query>` | Instant BM25 search across all past sessions and takeaways |
| `lore show <session-id>` | Read the stripped User/Assistant conversation turns of a session in your terminal |
