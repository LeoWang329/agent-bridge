# Agent Bridge

A persistent session bridge that lets **Claude Code** and **Codex** delegate work to local **OMP** and **Codex** agents over MCP.

It is not a one-shot wrapper: you open a delegated-agent session, send one or more messages into it, read the result, reuse it, and close it. Sessions live **inside the MCP server process** — there is no background daemon, no web UI, and no network listener. Each client launches its own server; when the client exits, its sessions are cleaned up with it.

Works on macOS, Linux, and Windows.

## Requirements

- **Node.js 20+**
- An MCP client: **Claude Code** or **Codex**
- The backend(s) you delegate to, launchable on `PATH`: **`omp`**, **`codex`**, and/or **`claude`**

Agent Bridge only bridges to OMP, Codex, and Claude — it does not install them. Install at least the backend you plan to use, then confirm it is detected:

```sh
node scripts/agent-bridge.mjs doctor
```

`doctor` prints `ok` for each backend it finds and flags anything missing. Override a binary path with `OMP_BIN` / `CODEX_BIN` / `CLAUDE_BIN` if it lives somewhere unusual.

## Install

Agent Bridge runs **straight from the clone** — nothing is copied into a package directory, so a single `git pull` updates everything. There are two pieces, both pointing at this clone in place, and setup is identical for **Claude Code** (`~/.claude`) and **Codex** (`~/.codex`):

1. the **MCP server** — the eight `agent_bridge_*` tools;
2. the **skills** — `agent-bridge` (the bridge usage guide) and `agent-bridge-dev` (an optional companion that orchestrates delegated code dev/review/design/debug by injecting role personas from `skills/agent-bridge-dev/roles/`).

```sh
git clone https://github.com/LeoWang329/agent-bridge.git
cd agent-bridge
node scripts/agent-bridge.mjs doctor    # confirm your backend(s) print `ok`
```

`<REPO>` below is the absolute path to this clone (the directory holding `scripts/` and `skills/`).

### 1. Register the MCP server (the tools)

```sh
# Claude Code — user scope = available in every project
claude mcp add agent-bridge --scope user -- node "<REPO>/scripts/agent-bridge.mjs" mcp

# Codex
codex mcp add agent-bridge -- node "<REPO>/scripts/agent-bridge.mjs" mcp
```

Verify with `claude mcp list` / `codex mcp list`. Remove with `claude mcp remove agent-bridge --scope user` / `codex mcp remove agent-bridge`.

### 2. Link the skills (the usage guides)

Both clients auto-load any `<skills-dir>/<name>/SKILL.md` on launch — Claude Code from `~/.claude/skills/`, Codex from `~/.codex/skills/`. Link each skill you want with a **symlink/junction (not a copy)** so it tracks the repo. The examples use `~/.claude`; swap in `~/.codex` for Codex.

```sh
# macOS / Linux
ln -s "<REPO>/skills/agent-bridge"     ~/.claude/skills/agent-bridge
ln -s "<REPO>/skills/agent-bridge-dev" ~/.claude/skills/agent-bridge-dev    # optional: the dev-role companion

# Windows (PowerShell or cmd) — junction, no admin needed
cmd /c mklink /J "%USERPROFILE%\.claude\skills\agent-bridge"     "<REPO>\skills\agent-bridge"
cmd /c mklink /J "%USERPROFILE%\.claude\skills\agent-bridge-dev" "<REPO>\skills\agent-bridge-dev"
```

A per-user skills directory has **no plugin namespace**, so the skills load under their bare directory names — `agent-bridge` and `agent-bridge-dev`.

### 3. Restart the client

The tools and skills only load after a restart. Then verify: `claude mcp list` / `codex mcp list` shows `agent-bridge` connected, and the `agent-bridge` skill (plus `agent-bridge-dev`, if you linked it) appears in the session's skill list.

### Updating

Because both the MCP server (registered as a path to `scripts/agent-bridge.mjs`) and the skills (symlinks/junctions into `skills/`) reference this clone in place, **a single `git pull` updates everything** — there is nothing to reinstall:

```sh
cd <REPO> && git pull
```

Then **restart the client** so it reloads the running MCP server (the skills are re-read on the next launch either way). A symlink/junction only needs recreating if you move or rename the clone.

### Configuring this for an AI agent

If a user asks an AI agent (Claude Code, Codex, …) to set Agent Bridge up, follow this exactly. Use **absolute paths** — the agent's shell is usually not at the repo root, so `$PWD` is unreliable. Below, `<REPO>` = the absolute path to the cloned repo and `<MJS>` = `<REPO>/scripts/agent-bridge.mjs`.

1. **Prerequisites:** Node 20+, plus the backend(s) the user wants — `omp`, `codex`, and/or `claude` — launchable on `PATH` (Agent Bridge does not install them).
2. **Get the code:** `git clone https://github.com/LeoWang329/agent-bridge.git`; record the clone's absolute path.
3. **Register the MCP server** for the user's client:
   ```sh
   # Claude Code
   claude mcp add agent-bridge --scope user -- node "<MJS>" mcp
   # Codex
   codex mcp add agent-bridge -- node "<MJS>" mcp
   ```
4. **Link the skills** into the client's skills dir (`~/.claude/skills/` for Claude Code, `~/.codex/skills/` for Codex) — `agent-bridge`, plus `agent-bridge-dev` for the delegated-role companion (Windows: `cmd /c mklink /J`):
   ```sh
   ln -s "<REPO>/skills/agent-bridge"     ~/.claude/skills/agent-bridge
   ln -s "<REPO>/skills/agent-bridge-dev" ~/.claude/skills/agent-bridge-dev
   ```
5. **Restart the client** — the tools and skills only load after a restart. Tell the user to do this.
6. **Verify:** run `node "<MJS>" doctor` (each backend the user will use must print `ok`); then `claude mcp list` / `codex mcp list` shows `agent-bridge` connected. To update later, `git pull` in the clone — both tools and skills track it in place.

> In Claude Code the tools are namespaced, e.g. `mcp__agent-bridge__agent_bridge_open_session`.

## Tools

`agent_bridge_open_session` · `send_message` · `status` · `result` · `wait` · `abort` · `close_session` · `doctor`

## Usage

1. **`open_session`** with `agent: "omp"`, `"codex"`, or `"claude"`. Pick a capability tier with `access`: `"read"` (read + **execute** — file reads, search, and running shell commands to investigate, but no Edit/Write tools; the default) or `"write"` (full file edits). `write: false`/`true` still works as a legacy alias for `read`/`write`. Note that `read` includes a shell, and its write-boundary differs by backend: codex hard-blocks writes via its read-only OS sandbox, while omp/claude allow shell that *can* write (soft — role discipline, not a sandbox), so `read` on omp/claude is not a hard no-write guarantee.
2. **`send_message`** with the returned `session_id` — non-blocking by default (pass `wait: true` for a quick inline turn).
3. **`wait`** to join results — `mode: "all"` blocks until every session finishes, `mode: "any"` returns on the first; always pass a `timeout_ms` so you can do other work and wait again instead of dead-waiting. On timeout it returns `pendingSnapshots` (per still-running session: `status`, `charCount`, a `tail` of the live partial output — capped by `tail_chars`, default 240 — and the latest lifecycle event) so progress is visible without a separate `status` call. This is how you fan out across parallel sessions.
4. Reuse the same `session_id` for follow-ups.
5. **`close_session`** when done — omit `session_id` to close **every** session this server manages (a bulk-cleanup fallback after a crash or forgotten close).

You can pin `model` and `effort` per session at open time (they cannot change mid-session — open a new session to switch). Tool **inputs** are snake_case, **outputs** are camelCase; the full untruncated answer is always at `textRef`, with `max_chars` capping the inline `text`. See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the full guide and result shapes.

## Backends

Each backend maps the `access` tier (`read`/`write`) to its own capability controls. `read` = read + execute (a shell for investigation, no Edit/Write tools); its write-boundary is HARD on codex (OS sandbox) but SOFT on omp/claude (shell can write):

- **`omp`** — persistent `omp --mode rpc` over JSONL stdio. `read` → `--tools read,bash,grep,find,lsp,web_search --approval-mode yolo` — a real shell for investigation, but writes are **not** fenced (`--approval-mode write` classifies bash wholesale as write-class and blocks even read-only commands non-interactively, and the bridge has no approval responder, so `read` uses yolo and is a *soft* boundary). `write` → `--auto-approve --approval-mode yolo`.
- **`codex`** — persistent `codex app-server` over JSON-RPC. `read` → `sandbox: read-only` — codex's read-only sandbox already runs commands (it isolates the filesystem, not execution) and **hard-blocks disk writes at the OS level** (verified enforced on Windows), so `read` is a *hard* boundary that still has a shell. `write` → `sandbox: workspace-write`. All non-interactive (`approvalPolicy: never`).
- **`claude`** — persistent Claude Code headless stream-json (`claude --print --input-format stream-json --output-format stream-json`). `read` → `--permission-mode default` with allowlist `Read,Glob,Grep,WebFetch,WebSearch,Bash` — Bash runs without prompts for investigation, but *can* write to disk (a *soft* boundary; Edit/Write stay out of the allowlist). This is a tool-level boundary, not an OS/hook sandbox — project hooks, if configured, still run. `write` uses `--permission-mode bypassPermissions`. Always launched with `--strict-mcp-config` so a delegated Claude loads project context (CLAUDE.md/skills) but **no MCP servers** — preventing nested delegation. `effort` maps to Claude Code's per-session `--effort` and defaults to `xhigh` (override per session). With no `model` set, claude uses its own configured default model. Override the binary with `CLAUDE_BIN`.

## CLI

The MCP server is the only way to drive sessions. The CLI exposes just three commands:

```sh
node scripts/agent-bridge.mjs mcp        # run the MCP server (stdio)
node scripts/agent-bridge.mjs doctor     # report backend availability
node scripts/agent-bridge.mjs cleanup    # reap orphaned backends + stale logs left by dead servers
```

`cleanup` is a safety net for backends orphaned by a hard-killed server (e.g. `kill -9`); the same reclamation runs automatically on every server startup.

## Notes

- Read-oriented by default. Always close sessions so no backend keeps running.
- No network listener — MCP over stdio only.
- Spawned backends carry `AGENT_BRIDGE_SESSION_ID` / `AGENT_BRIDGE_OWNER_PID` / `AGENT_BRIDGE_AGENT` in their environment, so a bridge-launched `omp`/`codex` is attributable to a session at the OS level (read via `/proc/<pid>/environ` or `ps e` on POSIX) instead of guessed from command-line side signatures.
- Child PIDs are tracked under `~/.agent-bridge/pids/`; records whose owning server is still alive are skipped, and orphans are reaped on the next startup or via `cleanup` (POSIX uses `pgrep`/signals, Windows uses `taskkill`/CIM). Before terminating a matched orphan, cleanup confirms identity — by the env marker (POSIX) or the process start time vs the recorded spawn time — so a recycled PID that merely matches `omp --mode rpc` / `codex app-server` is never killed by mistake.
- Don't commit secrets or machine-specific absolute paths.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Planned work lives in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
