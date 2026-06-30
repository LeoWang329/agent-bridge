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

Pick one method, then **restart the client** so the tools (and skill) load:

- **Claude Code — one-shot (recommended):** method **B** installs the MCP server **and** the skill together in a single step (`claude plugin install`, or `/plugin install` in-app). You do **not** install the two separately.
- **Codex, or tools-only:** method **A** (`claude mcp add` / `codex mcp add`) registers just the MCP server (the eight `agent_bridge_*` tools). Codex has no Claude-Code plugin one-click, so Codex uses **A** for tools and **C** to also load the skill.

```sh
git clone https://github.com/LeoWang329/agent-bridge.git
cd agent-bridge
```

### A. As an MCP server — simplest, works for both clients

```sh
# Claude Code (user scope = available in every project)
claude mcp add agent-bridge --scope user -- node "$PWD/scripts/agent-bridge.mjs" mcp

# Codex
codex mcp add agent-bridge -- node "$PWD/scripts/agent-bridge.mjs" mcp
```

Run from the repo root so `$PWD` expands to an absolute path (on Windows `cmd`, substitute the full path). Verify with `claude mcp list` / `codex mcp list`. Remove with `claude mcp remove agent-bridge --scope user` / `codex mcp remove agent-bridge`.

### B. As a Claude Code plugin — MCP server + skill in one go

```sh
claude plugin marketplace add LeoWang329/agent-bridge
claude plugin install agent-bridge@agent-bridge
```

The repo self-hosts a Claude Code marketplace, so this **one install registers the MCP server _and_ the skill** — there is no separate skill step. Equivalent inside Claude Code: `/plugin marketplace add LeoWang329/agent-bridge` then `/plugin install agent-bridge@agent-bridge`. Manage it later with `claude plugin` / `/plugin`; for local development against a working copy: `claude --plugin-dir "$PWD"`.

### C. Codex (and other non-plugin MCP clients) — MCP server + skill

Only Claude Code consumes method B's plugin bundle. For **Codex** — or any other MCP host that reads a per-user skills directory — give it the two pieces separately: the **MCP server** (the eight tools) via method A, and the **skill** (the usage guide that teaches the agent when and how to delegate) by linking it into the client's skills directory. Both pieces point straight at this clone, so there is no copied snapshot to go stale.

`<REPO>` below is the absolute path to this clone (the directory holding `scripts/` and `skills/`).

1. **MCP server (tools)** — same as method A:

   ```sh
   codex mcp add agent-bridge -- node "<REPO>/scripts/agent-bridge.mjs" mcp
   ```

2. **Skill (usage guide)** — link `skills/agent-bridge` into Codex's skills directory (`~/.codex/skills/`). Codex auto-loads any `~/.codex/skills/<name>/SKILL.md` on launch, exactly like Claude Code loads `~/.claude/skills/`. Use a symlink/junction (not a copy) so it tracks the repo:

   ```sh
   # macOS / Linux
   ln -s "<REPO>/skills/agent-bridge" ~/.codex/skills/agent-bridge

   # Windows (PowerShell or cmd) — junction, no admin needed
   cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge" "<REPO>\skills\agent-bridge"
   ```

   The same one-liner works for any client with a user skills directory — swap `~/.codex` for `~/.claude` to load the skill in Claude Code without the plugin, etc.

3. **Restart Codex.** Verify: `codex mcp list` shows `agent-bridge` connected, and the `agent-bridge` skill appears in the session's skill list.

#### Updating

Because both the MCP server (registered as a path to `scripts/agent-bridge.mjs`) and the skill (a symlink/junction into `skills/`) reference this clone in place, **a single `git pull` updates both** — there is nothing to reinstall:

```sh
cd <REPO> && git pull
```

Then **restart the client** so it reloads the running MCP server (the skill is re-read on the next launch either way). The symlink/junction needs recreating only if you move or rename the clone.

### Configuring this for an AI agent

If a user asks an AI agent (Claude Code, Codex, …) to set Agent Bridge up, follow this exactly. Use **absolute paths** — the agent's shell is usually not at the repo root, so `$PWD` is unreliable. Below, `<MJS>` = the absolute path to `scripts/agent-bridge.mjs` in the cloned repo.

1. **Prerequisites:** Node 20+, plus the backend(s) the user wants — `omp`, `codex`, and/or `claude` — launchable on `PATH` (Agent Bridge does not install them).
2. **Get the code:** `git clone https://github.com/LeoWang329/agent-bridge.git`; record the clone's absolute path.
3. **Register — pick the branch for the client:**
   - **Claude Code** (preferred — installs the MCP server **and** the skill in one step):
     ```sh
     claude plugin marketplace add LeoWang329/agent-bridge
     claude plugin install agent-bridge@agent-bridge
     ```
     MCP-only alternative (no skill): `claude mcp add agent-bridge --scope user -- node "<MJS>" mcp`
   - **Codex** (MCP server + skill, two steps — there is **no Claude-Code-style plugin for this repo on Codex, so do NOT run `codex plugin add`**). Register the tools, then link the skill into `~/.codex/skills/` (see method **C** for the per-OS link command):
     ```sh
     codex mcp add agent-bridge -- node "<MJS>" mcp
     ln -s "<REPO>/skills/agent-bridge" ~/.codex/skills/agent-bridge   # macOS/Linux; Windows: cmd /c mklink /J
     ```
4. **Restart the client** — the tools (and skill) only load after a restart. Tell the user to do this.
5. **Verify:** run `node "<MJS>" doctor` (each backend you'll use must print `ok`); then `claude mcp list` / `codex mcp list` should show `agent-bridge` connected. To update later, `git pull` in the clone (method **C** → Updating) — both tools and skill track it in place.

> In Claude Code the tools are namespaced, e.g. `mcp__agent-bridge__agent_bridge_open_session`.

## Tools

`agent_bridge_open_session` · `send_message` · `status` · `result` · `wait` · `abort` · `close_session` · `doctor`

## Usage

1. **`open_session`** with `agent: "omp"`, `"codex"`, or `"claude"`. Keep `write: false` for review/research; set `write: true` only when the agent should edit files.
2. **`send_message`** with the returned `session_id` — non-blocking by default (pass `wait: true` for a quick inline turn).
3. **`wait`** to join results — `mode: "all"` blocks until every session finishes, `mode: "any"` returns on the first; always pass a `timeout_ms` so you can do other work and wait again instead of dead-waiting. On timeout it returns `pendingSnapshots` (per still-running session: `status`, `charCount`, a `tail` of the live partial output — capped by `tail_chars`, default 240 — and the latest lifecycle event) so progress is visible without a separate `status` call. This is how you fan out across parallel sessions.
4. Reuse the same `session_id` for follow-ups.
5. **`close_session`** when done — omit `session_id` to close **every** session this server manages (a bulk-cleanup fallback after a crash or forgotten close).

You can pin `model` and `effort` per session at open time (they cannot change mid-session — open a new session to switch). Tool **inputs** are snake_case, **outputs** are camelCase; the full untruncated answer is always at `textRef`, with `max_chars` capping the inline `text`. See [docs/INSTALLATION.md](docs/INSTALLATION.md) for the full guide and result shapes.

## Backends

- **`omp`** — persistent `omp --mode rpc` over JSONL stdio. Write mode adds `--auto-approve --approval-mode yolo`.
- **`codex`** — persistent `codex app-server` over JSON-RPC. Read-only uses `sandbox: read-only`; write uses `sandbox: workspace-write`; both run non-interactively (`approvalPolicy: never`).
- **`claude`** — persistent Claude Code headless stream-json (`claude --print --input-format stream-json --output-format stream-json`). Read-only uses `--permission-mode default` with a read-only tool allowlist (`Read,Glob,Grep,WebFetch,WebSearch`) — no shell, so `write:false` cannot mutate the filesystem; write uses `--permission-mode bypassPermissions`. Always launched with `--strict-mcp-config` so a delegated Claude loads project context (CLAUDE.md/skills) but **no MCP servers** — preventing nested delegation. `effort` maps to Claude Code's per-session `--effort` and defaults to `xhigh` (override per session). With no `model` set, claude uses its own configured default model. Override the binary with `CLAUDE_BIN`.

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
