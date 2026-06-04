---
name: agent-bridge
description: Use persistent OMP or OpenCode delegated-agent sessions from Codex via Agent Bridge.
---

# Agent Bridge

Use Agent Bridge when the user explicitly asks to delegate work to OMP, OpenCode, or another local coding agent, or when a second independent agent pass would be useful for a substantial debugging, review, or implementation task.

This bridge is session-first. Do not treat it as a one-shot command runner.

Workflow:

1. Open a persistent session with `agent_bridge_open_session`.
2. Send work with `agent_bridge_send_message`.
3. Inspect progress with `agent_bridge_status`.
4. Read the latest answer with `agent_bridge_result`.
5. Abort only the active turn with `agent_bridge_abort` when needed.
6. Close the delegated session with `agent_bridge_close_session` when the user no longer needs it.

Agent choices:

- Use `agent: "omp"` for OMP. This opens `omp --mode rpc` and keeps the JSONL RPC process alive.
- Use `agent: "opencode"` for OpenCode. This opens an `opencode serve` backend and keeps that server alive while messages attach to the same backend/session.

Safety:

- Always pass the current workspace absolute path as `cwd`.
- Keep `write: false` for review, diagnosis, planning, or research.
- Set `write: true` only when the user explicitly wants the delegated agent to edit files.
- After delegated edits, verify the working tree yourself before reporting success.
- Do not delegate tiny tasks Codex can finish directly.

Prompting:

- Make the delegated prompt concrete and bounded.
- State what done looks like.
- Ask for concise findings, touched files, and verification when edits are allowed.
- For follow-ups, keep using the same `session_id` instead of opening a new session unless the user asks for a fresh independent run.
