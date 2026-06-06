# Agent Bridge

Agent Bridge is a session-first MCP bridge that lets MCP clients such as Codex and Claude Code delegate work to local OMP and Codex agents.

It is intentionally not a one-shot command wrapper. Codex opens a delegated-agent session, sends one or more messages into that same session, checks status/result, can abort the active turn, and closes the session when the work is done.

MCP tools, the CLI facade, and the local web monitor all share the same daemon-backed session manager. A session opened from Codex can be observed in the UI and managed from the CLI; a session opened from the UI can be closed from the CLI.

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

## CLI Facade

Codex should use the MCP server as the primary interface. The CLI facade is for human debugging, smoke tests, cleanup, and operational control.

The CLI facade auto-starts a local Agent Bridge daemon and talks to it through a Unix socket, so sessions persist across separate CLI invocations:

```sh
node scripts/agent-bridge.mjs start
node scripts/agent-bridge.mjs open --agent omp --cwd "$PWD" --json
node scripts/agent-bridge.mjs send <session_id> "Only inspect the repo. Do not edit files." --wait --json
node scripts/agent-bridge.mjs result <session_id> --json
node scripts/agent-bridge.mjs close <session_id>
node scripts/agent-bridge.mjs stop
```

## Web UI Monitor

The UI monitor starts or reuses the local daemon, then serves a localhost-only HTTP/SSE facade. It binds to `127.0.0.1` only and, by default, picks a free port and opens your browser automatically:

```sh
node scripts/agent-bridge.mjs ui
```

You do not need to start the daemon first — `ui` auto-starts (or reuses) it. The command prints the address it bound to, for example `Agent Bridge UI: http://127.0.0.1:52799`.

Flags:

- `--port PORT` pins a fixed port (default is a random free port).
- `--no-open` skips opening the browser and just prints the address (useful for headless or remote use).
- `--json` prints the address as JSON (also skips opening the browser).

```sh
node scripts/agent-bridge.mjs ui --port 8787
node scripts/agent-bridge.mjs ui --no-open --json
```

The monitor exposes `GET /sessions`, `POST /sessions`, `GET /sessions/:id`, `POST /sessions/:id/messages`, `GET /sessions/:id/result`, `GET /sessions/:id/events`, `POST /sessions/:id/abort`, `DELETE /sessions/:id`, and `POST /daemon/stop`. SSE events stream status changes and assistant-visible text while raw/debug JSON stays behind the collapsible Debug panel.

The UI keeps running in the background together with the daemon. Stop everything (UI, daemon, and any daemon-owned sessions) with:

```sh
node scripts/agent-bridge.mjs stop
```

> Tip: alias the CLI for convenience, e.g. `alias agent-bridge='node /absolute/path/to/agent-bridge/scripts/agent-bridge.mjs'`, then run `agent-bridge ui` from any directory.

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
3. Join the result with `agent_bridge_wait`, ideally with a short `timeout_ms` (e.g. 5–10 min): it returns the result when the turn finishes, or `{ timed_out, settled, pending }` if not — so you can check `agent_bridge_status` / `agent_bridge_result`, do other work, then wait again instead of dead-waiting.
4. Reuse the same `session_id` for follow-up messages.
5. Call `agent_bridge_close_session` when finished.

For parallel work, send to multiple sessions (non-blocking), then make a single `agent_bridge_wait` call: `mode: "all"` blocks until every session finishes; `mode: "any"` returns as soon as the first does (call again with the remaining ids to handle each as it completes). This replaces polling `agent_bridge_status` in a loop. Pass `mine: true` to `agent_bridge_status` (no `session_id`) to list only the sessions this client opened.

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
- On normal daemon shutdown, Agent Bridge closes all active daemon-owned OMP/Codex child processes.
- `agent-bridge stop` closes daemon-owned sessions and their OMP/Codex child processes.
- `agent-bridge ui` listens only on `127.0.0.1` by default.
- Agent Bridge records its child process ids under `~/.agent-bridge/pids/`, skips records whose MCP/daemon owner is still running, and removes stale recorded children on the next startup or `cleanup`.
- Do not commit personal access tokens, local secrets, or machine-specific absolute paths.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

For planned work and TODOs, see [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).
