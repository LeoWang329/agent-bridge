# Agent Bridge

Agent Bridge is a session-first MCP bridge that lets Codex delegate work to local OMP and OpenCode agents.

It is intentionally not a one-shot command wrapper. Codex opens a delegated-agent session, sends one or more messages into that same session, checks status/result, can abort the active turn, and closes the session when the work is done.

## Backends

- `omp`: starts a persistent `omp --mode rpc` process and communicates through JSONL stdio RPC.
- `opencode`: starts a persistent `opencode serve` backend and sends messages through `opencode run --attach`.

OpenCode 1.15.13 does not expose the same stdio JSONL RPC mode that OMP does. Agent Bridge therefore treats OpenCode as a persistent server/attach backend. When OpenCode's JSON stdout does not include final assistant text, Agent Bridge falls back to a read-only lookup in OpenCode's local SQLite database.

## MCP Tools

- `agent_bridge_open_session`
- `agent_bridge_send_message`
- `agent_bridge_status`
- `agent_bridge_result`
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

## Requirements

- Node.js 20 or newer
- Codex CLI or Codex app with MCP/plugin support
- OMP installed and available as `omp`
- OpenCode installed and available as `opencode`
- `sqlite3` on PATH for the OpenCode result fallback

You can override binary paths with environment variables:

```sh
export OMP_BIN="$HOME/.local/bin/omp"
export OPENCODE_BIN="$(command -v opencode)"
export OPENCODE_DB_PATH="$HOME/.local/share/opencode/opencode.db"
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

## Install As A Codex Plugin

This repository is laid out as a Codex plugin:

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

1. Call `agent_bridge_open_session` with `agent: "omp"` or `agent: "opencode"`.
2. Call `agent_bridge_send_message` with the returned `session_id`.
3. Poll `agent_bridge_status` or call `agent_bridge_result`.
4. Reuse the same `session_id` for follow-up messages.
5. Call `agent_bridge_close_session` when finished.

Keep `write: false` for review, diagnosis, planning, or research. Set `write: true` only when the user explicitly wants the delegated agent to edit files.

## Safety Notes

- Agent Bridge defaults to read-oriented sessions.
- OMP write mode adds `--auto-approve --approval-mode yolo`.
- OpenCode write mode adds `--dangerously-skip-permissions`.
- Always close sessions after use so no backend process remains running.
- On normal MCP shutdown, Agent Bridge closes all active OMP/OpenCode child processes.
- `agent-bridge stop` closes daemon-owned sessions and their OMP/OpenCode child processes.
- Agent Bridge records its child process ids under `~/.agent-bridge/pids/`, skips records whose MCP/daemon owner is still running, and removes stale recorded children on the next startup or `cleanup`.
- Do not commit personal access tokens, local secrets, or machine-specific absolute paths.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
