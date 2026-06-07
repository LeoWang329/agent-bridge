# Agent Bridge

Agent Bridge is a session-first MCP bridge that lets MCP clients such as Codex and Claude Code delegate work to local OMP and Codex agents.

It is intentionally not a one-shot command wrapper. Codex opens a delegated-agent session, sends one or more messages into that same session, checks status/result, can abort the active turn, and closes the session when the work is done.

Sessions live **inside the MCP server process**. Each MCP client (one Claude Code / Codex instance) launches its own `agent-bridge mcp` process, which directly spawns and owns the OMP/Codex backends it opens — there is no shared background daemon and no web UI. When the client exits, its MCP server exits and all of its backend sessions are cleaned up with it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how this evolved.

## Backends

- `omp`: starts a persistent `omp --mode rpc` process and communicates through JSONL stdio RPC.
- `codex`: starts a persistent `codex app-server` process and communicates through newline-delimited JSON-RPC (`initialize` → `thread/start` → `turn/start`), streaming `item/agentMessage/delta` events. Read-only uses `sandbox: read-only`; write uses `sandbox: workspace-write`; both run non-interactively (`approvalPolicy: never`).

## MCP Tools

- `agent_bridge_open_session`
- `agent_bridge_send_message`
- `agent_bridge_status`
- `agent_bridge_result`
- `agent_bridge_wait` — block until sessions finish (`all`/`any`); for parallel fan-out
- `agent_bridge_abort`
- `agent_bridge_close_session`
- `agent_bridge_doctor`

## CLI

The MCP server is the only interface for managing sessions; the CLI exposes just the server entrypoint plus two operational helpers:

```sh
node scripts/agent-bridge.mjs mcp        # run the MCP server (stdio) — sessions live in this process
node scripts/agent-bridge.mjs doctor     # report backend availability (omp/codex)
node scripts/agent-bridge.mjs cleanup    # reap orphaned omp/codex children + abandoned run-dir logs from dead servers
```

There are no CLI session commands (`open`/`send`/`status`/…) and no daemon/UI commands — those were removed in v0.7.0 when sessions moved into the MCP server process. Drive sessions through the MCP tools instead. `cleanup` is a safety net: it terminates backend child processes whose owning MCP server is no longer alive (e.g. after a `kill -9`), removes their pid records, and deletes abandoned `logs/<runId>/` directories left by servers that did not exit cleanly. The same reclamation also runs automatically on every MCP server startup.

## Requirements

- Node.js 20 or newer
- An MCP client: Codex (CLI or app with MCP/plugin support) or Claude Code
- OMP installed and available as `omp` (if you delegate to OMP)
- Codex installed and available as `codex` (if you delegate to Codex)

**Install the delegated coding agents first.** Agent Bridge only bridges to OMP and Codex; it does not bundle or install them. If the backend you want to delegate to is not installed, the session cannot start. Install at least the backend(s) you plan to use before opening a session, then confirm each one is detected:

```sh
node scripts/agent-bridge.mjs doctor
```

`doctor` reports `ok` for each backend it finds and flags anything missing, so run it whenever a session fails to open.

You can override binary paths with environment variables:

```sh
export OMP_BIN="$HOME/.local/bin/omp"
export CODEX_BIN="$(command -v codex)"
```

## Quick Start

For a complete Chinese installation and usage guide, see [docs/INSTALLATION.md](docs/INSTALLATION.md).

Clone the repository:

```sh
git clone https://github.com/LeoWang329/agent-bridge.git
cd agent-bridge
```

Run local checks:

```sh
node --check scripts/agent-bridge.mjs
node scripts/agent-bridge.mjs doctor
node scripts/agent-bridge.mjs cleanup
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node scripts/agent-bridge.mjs mcp
```

## Use With Codex

Codex consumes Agent Bridge as a plugin that registers the MCP server, so no code changes are needed — make sure the backend agents are installed first (see [Requirements](#requirements)). This repository is already laid out as a Codex plugin:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/agent-bridge/SKILL.md`
- `scripts/agent-bridge.mjs`

For local development, place or symlink this repository under a personal plugin marketplace and install it with Codex:

```sh
mkdir -p "$HOME/plugins"
ln -sfn "$(pwd)" "$HOME/plugins/agent-bridge"
codex plugin add agent-bridge@personal
```

Your personal marketplace must contain an entry that points `agent-bridge` at `./plugins/agent-bridge`. See `docs/DEVELOPMENT.md` for a full example.

## Typical Codex Workflow

Codex should use the bridge like this:

1. Call `agent_bridge_open_session` with `agent: "omp"` or `agent: "codex"`.
2. Call `agent_bridge_send_message` with the returned `session_id` — non-blocking by default, it returns an ack immediately (pass `wait: true` to block inline for a quick turn).
3. Join the result with `agent_bridge_wait`, ideally with a short `timeout_ms` (e.g. 5–10 min): it returns the result when the turn finishes, or `{ timedOut, settled, pending }` if not — so you can check `agent_bridge_status` / `agent_bridge_result`, do other work, then wait again instead of dead-waiting.
4. Reuse the same `session_id` for follow-up messages.
5. Call `agent_bridge_close_session` when finished.

For parallel work, send to multiple sessions (non-blocking), then make a single `agent_bridge_wait` call: `mode: "all"` blocks until every session finishes; `mode: "any"` returns as soon as the first does (call again with the remaining ids to handle each as it completes). This replaces polling `agent_bridge_status` in a loop. `agent_bridge_status` with no `session_id` lists every session this server is managing (they all belong to this client — sessions are no longer shared across clients).

### Result shape (v0.6.0)

Tool **inputs** use snake_case (`session_id`, `timeout_ms`, `max_chars`); **outputs** are camelCase throughout (`logFile`, `recentEvents`, `sessionId`, `timedOut`). The `session` object has the same top-level shape for every backend — common core fields plus `lastTurn` (`{ id, startedAt, endedAt, durationMs }`) and an `agentSpecific` sub-object that holds backend-only fields (omp: session state; codex: `threadId`/`turnCount`). Result text always reports `charCount`/`byteCount`, and the full untruncated answer is written to `textRef`; pass `max_chars` to cap the inline `text` (sets `truncated: true`) while keeping the whole answer retrievable from `textRef`.

Keep `write: false` for review, diagnosis, planning, or research. Set `write: true` only when the user explicitly wants the delegated agent to edit files.

You can also pin a model and reasoning effort when opening a session. These are per-session — they are set on `agent_bridge_open_session` and cannot be changed per message, so open a new session to switch models. Pass `model` (forwarded verbatim to the backend's `--model`) and optional `effort`, which maps to OMP's `--thinking` (`minimal|low|medium|high|xhigh`) and Codex's turn effort (`none|minimal|low|medium|high|xhigh`). Omit both to use each backend's default. OMP in particular reaches many models via `omp --model <name>` (e.g. `deepseek-v4-pro`, `minimax-m3`, `claude`, `gpt`).

## Use With Claude Code

Agent Bridge is a standard stdio MCP server, so Claude Code can use it with no code changes — it speaks the same MCP protocol as Codex. You only need to register the server, and the backend agents must already be installed (see [Requirements](#requirements)).

In Claude Code the tools appear namespaced, for example `mcp__agent-bridge__agent_bridge_open_session` and `mcp__agent-bridge__agent_bridge_send_message`.

### Plugin (recommended)

This repository is also a Claude Code plugin and a self-hosting plugin marketplace, so a single install registers the MCP server **and** the skill — no path juggling. From inside Claude Code:

```text
/plugin marketplace add LeoWang329/agent-bridge
/plugin install agent-bridge@agent-bridge
```

The plugin manifest (`.claude-plugin/plugin.json`) launches the server via `${CLAUDE_PLUGIN_ROOT}/scripts/agent-bridge.mjs`, so it resolves wherever the plugin is installed. For local development, point Claude Code at a working copy instead:

```sh
claude --plugin-dir "$PWD"
```

Manage it later with `/plugin` (enable/disable/uninstall). The backend agents (`omp`, `codex`) must still be installed (see [Requirements](#requirements)).

If you would rather register only the MCP server (no plugin, no skill), use one of the scopes below.

### Project scope (this repository)

Claude Code automatically detects the project `.mcp.json` at the repository root. Launch `claude` from the repository root and approve the `agent-bridge` server when prompted, then confirm with:

```sh
claude mcp list
```

The bundled `.mcp.json` uses a relative path (`./scripts/agent-bridge.mjs`), so project scope only resolves when Claude Code is launched from the repository root.

### User scope (available in every directory)

Register the server once with an absolute path so the tools are available in any Claude Code session:

```sh
claude mcp add agent-bridge --scope user -- node "$PWD/scripts/agent-bridge.mjs" mcp
```

Run that from the repository root so `$PWD` expands to an absolute path. Remove it later with `claude mcp remove agent-bridge --scope user`.

### Optional: install the skill

The usage guidance in `skills/agent-bridge/SKILL.md` is compatible with Claude Code skills. Link it into your user skills directory:

```sh
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/agent-bridge" ~/.claude/skills/agent-bridge
```

The MCP tools work without the skill; it only adds guidance on when to delegate. The session workflow (open → send → status/result → reuse → close) and the safety rules below are identical to the Codex workflow.

## Safety Notes

- Agent Bridge defaults to read-oriented sessions.
- OMP write mode adds `--auto-approve --approval-mode yolo`.
- Codex read-only mode uses `sandbox: read-only`; write mode uses `sandbox: workspace-write`. Both run with `approvalPolicy: never`.
- Always close sessions after use so no backend process remains running.
- When the MCP server exits (client quits / stdin closes / SIGTERM), it closes all of its OMP/Codex child processes; a clean exit also removes that run's log directory. A hard exit (crash / `kill -9`) leaves the run dir behind, but the next server startup (or `cleanup`) reclaims any `logs/<runId>/` whose owning server is gone, so logs never accumulate unbounded.
- Agent Bridge runs no network listener of any kind — it speaks MCP over stdio only.
- Agent Bridge records its child process ids under `~/.agent-bridge/pids/`, skips records whose owning MCP server is still running, and reaps orphaned children on the next MCP startup or via `cleanup`.
- Do not commit personal access tokens, local secrets, or machine-specific absolute paths.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

For planned work and TODOs, see [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
