# Agent Bridge

A persistent session bridge that lets **Claude Code** and **Codex** delegate work to local **OMP**, **Codex**, **Claude**, **Cursor**, and **Kimi** agents over MCP.

It is not a one-shot wrapper: you open a delegated-agent session, send one or more messages into it, read the result, reuse it, and close it. Sessions live **inside the MCP server process** — there is no background daemon, no web UI, and no network listener. Each client launches its own server; when the client exits, its sessions are cleaned up with it.

Works on macOS, Linux, and Windows.

## Requirements

- **Node.js 20+**
- An MCP client: **Claude Code** or **Codex**
- The backend(s) you delegate to, launchable on `PATH`: **`omp`**, **`codex`**, **`claude`**, **`cursor`** (the `agent` CLI; **Windows only**), and/or **`kimi`** (the native `kimi.exe`; **Windows only**)

Agent Bridge only bridges to OMP, Codex, Claude, Cursor, and Kimi — it does not install them. Install at least the backend you plan to use, then confirm it is detected:

```sh
node scripts/agent-bridge.mjs doctor
```

`doctor` prints `ok` for each backend it finds and flags anything missing. Override a binary path with `OMP_BIN` / `CODEX_BIN` / `CLAUDE_BIN` / `CURSOR_AGENT_BIN` / `KIMI_BIN` if it lives somewhere unusual.

## Install

Agent Bridge runs **straight from the clone** — nothing is copied into a package directory, so a single `git pull` updates everything. There are two pieces, both pointing at this clone in place, and setup is identical for **Claude Code** (`~/.claude`) and **Codex** (`~/.codex`):

1. the **MCP server** — the eight `agent_bridge_*` tools;
2. the **skills** — `agent-bridge` (the bridge usage guide) plus three optional companions: `agent-bridge-dev` (delegated code dev/review/design/debug via role personas from `skills/agent-bridge-dev/roles/`), `agent-bridge-roundtable` (N-agent anonymous deliberation with a live SSE observer page), and `agent-bridge-loop` (contract-driven generator/validator delivery loop with an AC-climb observer page; supports unattended runs).

> **Consumer or maintainer?** If you only *use* Agent Bridge, point everything at your clone and `git pull` to update — the steps below are written for you (`<REPO>` = your clone). If you *develop* Agent Bridge, do **not** point your everyday agent at your working tree: uncommitted, untested edits go live (skills are re-read every session; the server reloads on restart). Keep a **separate stable clone** for your agent to consume and advance it only with a deliberate `git pull` — see [docs/INSTALLATION.md](docs/INSTALLATION.md) *(Consumer vs maintainer)*.

> **Which agent? Tools are universal; skills are Claude Code / Codex only.** The MCP **server** (the `agent_bridge_*` tools) registers in *any* stdio-MCP client — Claude Code, Codex, Cursor, Cline, …. The **skills** (usage guides) are a Claude Code / Codex convention: other clients get the tools but not the auto-loaded guides (feed them `skills/agent-bridge/SKILL.md` as plain docs if useful). Tool names are bare `agent_bridge_*`, except Claude Code prefixes `mcp__agent-bridge__`. Per-agent specifics are in [docs/INSTALLATION.md](docs/INSTALLATION.md) *(Adapting to different agents)*.

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
ln -s "<REPO>/skills/agent-bridge"            ~/.claude/skills/agent-bridge
ln -s "<REPO>/skills/agent-bridge-dev"        ~/.claude/skills/agent-bridge-dev        # optional: dev-role companion
ln -s "<REPO>/skills/agent-bridge-roundtable" ~/.claude/skills/agent-bridge-roundtable # optional: N-agent roundtable
ln -s "<REPO>/skills/agent-bridge-loop"       ~/.claude/skills/agent-bridge-loop       # optional: delivery loop

# Windows (PowerShell or cmd) — junction, no admin needed
cmd /c mklink /J "%USERPROFILE%\.claude\skills\agent-bridge"            "<REPO>\skills\agent-bridge"
cmd /c mklink /J "%USERPROFILE%\.claude\skills\agent-bridge-dev"        "<REPO>\skills\agent-bridge-dev"
cmd /c mklink /J "%USERPROFILE%\.claude\skills\agent-bridge-roundtable" "<REPO>\skills\agent-bridge-roundtable"
cmd /c mklink /J "%USERPROFILE%\.claude\skills\agent-bridge-loop"       "<REPO>\skills\agent-bridge-loop"
```

A per-user skills directory has **no plugin namespace**, so the skills load under their bare directory names — `agent-bridge`, `agent-bridge-dev`, `agent-bridge-roundtable`, `agent-bridge-loop`.

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

1. **Prerequisites:** Node 20+, plus the backend(s) the user wants — `omp`, `codex`, `claude`, `cursor` (Windows only), and/or `kimi` (Windows only) — launchable on `PATH` (Agent Bridge does not install them).
2. **Get the code:** `git clone https://github.com/LeoWang329/agent-bridge.git`; record the clone's absolute path.
3. **Register the MCP server** for the user's client:
   ```sh
   # Claude Code
   claude mcp add agent-bridge --scope user -- node "<MJS>" mcp
   # Codex
   codex mcp add agent-bridge -- node "<MJS>" mcp
   ```
4. **Link the skills** into the client's skills dir (`~/.claude/skills/` for Claude Code, `~/.codex/skills/` for Codex) — `agent-bridge`, plus any of the companions `agent-bridge-dev` / `agent-bridge-roundtable` / `agent-bridge-loop` (Windows: `cmd /c mklink /J`):
   ```sh
   ln -s "<REPO>/skills/agent-bridge"            ~/.claude/skills/agent-bridge
   ln -s "<REPO>/skills/agent-bridge-dev"        ~/.claude/skills/agent-bridge-dev
   ln -s "<REPO>/skills/agent-bridge-roundtable" ~/.claude/skills/agent-bridge-roundtable
   ln -s "<REPO>/skills/agent-bridge-loop"       ~/.claude/skills/agent-bridge-loop
   ```
5. **Restart the client** — the tools and skills only load after a restart. Tell the user to do this.
6. **Verify:** run `node "<MJS>" doctor` (each backend the user will use must print `ok`); then `claude mcp list` / `codex mcp list` shows `agent-bridge` connected. To update later, `git pull` in the clone — both tools and skills track it in place.

> In Claude Code the tools are namespaced, e.g. `mcp__agent-bridge__agent_bridge_open_session`.

## Tools

`agent_bridge_open_session` · `send_message` · `status` · `result` · `wait` · `abort` · `close_session` · `doctor`

## Usage

1. **`open_session`** with `agent: "omp"`, `"codex"`, `"claude"`, `"cursor"`, or `"kimi"`. Pick a capability tier with `access`: `"read"` (read + **execute** — file reads, search, and running shell commands to investigate, but no Edit/Write tools — cursor and kimi excepted, their read keeps the native write tool (see Backends); the default) or `"write"` (full file edits). `write: false`/`true` still works as a legacy alias for `read`/`write`. Note that `read` includes a shell, and its write-boundary differs by backend: codex hard-blocks writes via its read-only OS sandbox, while omp/claude/cursor/kimi allow shell that *can* write (soft — role discipline, not a sandbox), so `read` on omp/claude/cursor/kimi is not a hard no-write guarantee.
2. **`send_message`** with the returned `session_id` — non-blocking by default (pass `wait: true` for a quick inline turn).
3. **`wait`** to join results — `mode: "all"` blocks until every session finishes, `mode: "any"` returns on the first; always pass a `timeout_ms` so you can do other work and wait again instead of dead-waiting. On timeout it returns `pendingSnapshots` (per still-running session: `status`, `charCount`, a `tail` of the live partial output — capped by `tail_chars`, default 240 — and the latest lifecycle event) so progress is visible without a separate `status` call. This is how you fan out across parallel sessions.
4. Reuse the same `session_id` for follow-ups.
5. **`close_session`** when done — omit `session_id` to close **every** session this server manages (a bulk-cleanup fallback after a crash or forgotten close).

You can pin `model` and `effort` per session at open time (they cannot change mid-session — open a new session to switch). Tool **inputs** are snake_case, **outputs** are camelCase; the full untruncated answer is always at `textRef`, with `max_chars` capping the inline `text`. See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the full guide and result shapes.

## Backends

Each backend maps the `access` tier (`read`/`write`) to its own capability controls. `read` = read + execute (a shell for investigation, no Edit/Write tools — except cursor and kimi, see their bullets); its write-boundary is HARD on codex (OS sandbox) but SOFT on omp/claude/cursor/kimi (shell can write):

- **`omp`** — persistent `omp --mode rpc` over JSONL stdio. `read` → `--tools read,bash,grep,find,lsp,web_search --approval-mode yolo` — a real shell for investigation, but writes are **not** fenced (`--approval-mode write` classifies bash wholesale as write-class and blocks even read-only commands non-interactively, and the bridge has no approval responder, so `read` uses yolo and is a *soft* boundary). `write` → `--auto-approve --approval-mode yolo`.
- **`codex`** — persistent `codex app-server` over JSON-RPC. `read` → `sandbox: read-only` — codex's read-only sandbox already runs commands (it isolates the filesystem, not execution) and **hard-blocks disk writes at the OS level** (verified enforced on Windows), so `read` is a *hard* boundary that still has a shell. `write` → `sandbox: workspace-write` on macOS/Linux, but `danger-full-access` on **Windows** (a SOFT boundary like omp/claude/cursor/kimi — codex's Windows sandbox breaks `apply_patch`, an upstream bug; see `scripts/agent-bridge.mjs`). All non-interactive (`approvalPolicy: never`).
- **`claude`** — persistent Claude Code headless stream-json (`claude --print --input-format stream-json --output-format stream-json`). `read` → `--permission-mode default` with allowlist `Read,Glob,Grep,WebFetch,WebSearch,Bash` — Bash runs without prompts for investigation, but *can* write to disk (a *soft* boundary; Edit/Write stay out of the allowlist). This is a tool-level boundary, not an OS/hook sandbox — project hooks, if configured, still run. `write` uses `--permission-mode bypassPermissions`. Always launched with `--strict-mcp-config` so a delegated Claude loads project context (CLAUDE.md/skills) but **no MCP servers** — preventing nested delegation. `effort` maps to Claude Code's per-session `--effort` and defaults to `xhigh` (override per session). With no `model` set, claude uses its own configured default model. Override the binary with `CLAUDE_BIN`.
- **`cursor`** — **Windows-only (v1).** Drives the cursor-agent CLI as a per-turn cloud chat: the logical session is a cloud `chatId`, and each turn spawns a short-lived `node index.js -p --resume <chatId> --output-format stream-json` that exits when the turn ends (no process is held between turns). Both `read` and `write` are *soft* (no OS sandbox). Specifics: `model` needs a tier-suffixed selector (e.g. `gpt-5.3-codex-high`, `cursor-grok-4.5-high` — list them with `agent --list-models` and use the exact selector it prints); `append_system_prompt_file` has no native system flag, so it is injected as a *soft first-turn user prefix* (adherence is model-dependent, and it shares the ~24K argv budget with the message); `effort` is accepted but ignored (echoed back as `null`) and `schema` is rejected before spawn; `read` and `write` share the same `--force` launch, so cursor's `read` keeps the native Edit/Write tool (a *softer* boundary than omp/claude — held back only by a per-turn "don't edit" instruction, with no clean per-session way to remove it); `contextUsage` is always `null` (stream-json carries no token usage); and there is **no delete-chat**, so `close_session` only forgets the id while the cloud chat — and any repo content it read — stays in Cursor's retention. Override the binary with `CURSOR_AGENT_BIN`.
- **`kimi`** — **Windows-only (v1).** Drives the Kimi Code CLI (Moonshot, K2/K3 family) as a per-turn native process: the logical session is a **local** session id that kimi itself mints on the first turn, and each turn spawns a short-lived `kimi.exe --output-format stream-json -S <session-id> -p <prompt>` that exits when the turn ends (no process is held between turns). Simpler than cursor: the id is local, so there is no create-chat round-trip and no cloud chat store — **but inference still runs against Moonshot's cloud API**, so the prompt and any repo content the agent reads do leave the machine. Both `read` and `write` are *soft* (no OS sandbox): they share the same launch, and `read` is held back only by a per-turn "read-only investigation" prompt prefix, so kimi's `read` keeps the native write tool and is **not** a true read-only mode. Specifics: `model` takes a `kimi-code/…` alias (`kimi-code/k3` — the default — plus `kimi-code/kimi-for-coding` and `kimi-code/kimi-for-coding-highspeed`; list them with `kimi provider list`); `append_system_prompt_file` has no native system flag, so it is injected as a *soft first-turn user prefix* (adherence is model-dependent, and it shares the argv budget with the message); `effort` is accepted but ignored (echoed back as `null`) and `schema` is rejected before spawn; `contextUsage` is always `null` (stream-json carries no token usage). Override the binary with `KIMI_BIN` — it must point at a native `kimi.exe`, never a `.cmd`/`.bat` shim.

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
- Spawned backends carry `AGENT_BRIDGE_SESSION_ID` / `AGENT_BRIDGE_OWNER_PID` / `AGENT_BRIDGE_AGENT` in their environment, so a bridge-launched `omp`/`codex`/`claude`/`cursor`/`kimi` is attributable to a session at the OS level (read via `/proc/<pid>/environ` or `ps e` on POSIX) instead of guessed from command-line side signatures. The short-lived per-turn children of cursor and kimi are tracked the same way while a turn runs, but between turns there is no process and no pid record.
- Child PIDs are tracked under `~/.agent-bridge/pids/`; records whose owning server is still alive are skipped, and orphans are reaped on the next startup or via `cleanup` (POSIX uses `pgrep`/signals, Windows uses `taskkill`/CIM). Before terminating a matched orphan, cleanup confirms identity — by the env marker (POSIX) or the process start time vs the recorded spawn time — so a recycled PID that merely matches `omp --mode rpc` / `codex app-server` is never killed by mistake.
- Don't commit secrets or machine-specific absolute paths.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Planned work lives in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
