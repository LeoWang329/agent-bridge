# Design: Claude Code backend for Agent Bridge

Date: 2026-06-30
Status: Approved (design); implementation pending
Author: brainstormed with maintainer

## 1. Goal

Add a third delegated-agent backend — **Claude Code** — alongside the existing `omp`
and `codex` backends, so the orchestrator can open persistent Claude Code worker
sessions over MCP for: parallel fan-out, an independent fresh-context second
opinion / review, isolated write workspaces, and plain parity with OMP/Codex.

Non-goal: changing the bridge's session model, tool surface, or the shared
session contract. This is purely a new backend plugged into the existing registry.

## 2. Background — the backend contract

`scripts/agent-bridge.mjs` is a single-file, **zero-dependency** Node MCP server.
Backends are registry-driven: the `AGENTS` map plus a duck-typed `Session` class
(contract documented in-file around the "Backend session contract" banner).

Adding a backend is three mechanical steps:

1. Add an `AGENTS` entry: `{ label, env, bin, role, versionArgs, matchesCommand }`.
2. Implement a `Session` class satisfying the contract methods
   (`start / send / result / isSettled / refreshStatus / abort / close / summary`)
   and the generically-read fields (`id, agent, cwd, write, status, isStreaming,
   events, proc, logFile, answerFile, pidFile, createdAt, updatedAt, lastError`,
   and the turn-clock fields `currentTurnId/lastTurnId/turnStartedAt/turnEndedAt`).
3. Late-bind `AGENTS.<name>.Session = <Class>` after the class definition.

Everything else is automatic from the registry entry: `doctor` availability probe,
orphan reclamation (matches `matchesCommand` against the process command line), the
`open_session` `agent` enum, pid-record tracking, per-session logging/rotation, and
the Windows `.cmd`-shim spawn handling (`spawnPlan`/`resolveWindowsExecutable`).

**`CodexAppServerSession` is the template.** Codex is "a long-lived stdio process
speaking newline-delimited JSON, multi-turn, with an explicit turn-completion event."
Claude Code's headless stream-json mode is structurally identical.

## 3. Decision — drive the `claude` CLI stream-json (not the Agent SDK)

Two candidate mechanisms were considered:

- **A. Drive `claude --print --input-format stream-json --output-format stream-json`
  directly over stdio.** No new dependency; reuses `spawnPlan` and the existing
  Windows handling; matches the project's "single file, `git pull` updates
  everything, no `node_modules`" deployment model.
- **B. Use `@anthropic-ai/claude-agent-sdk`.** Adds an npm dependency and
  `node_modules` to a currently zero-dependency project, breaking that model. The
  SDK itself merely spawns the `claude` binary and drives it over the same
  stream-json protocol — so it buys nothing the bridge cannot do directly.

**Chosen: A.**

### 3.1 Make-or-break fact — empirically verified

The load-bearing question was whether a single `claude` process stays alive across
multiple stdin user messages (persistent multi-turn) or exits after one. This was
verified directly on the target machine (Claude Code v2.1.196, Windows), not from
docs:

```
persistentMultiTurn: true     one process, two turns
resultCount: 2                two `result` events received
firstResultProcAlive: true    process still alive after turn 1's result
session_id: 998231ff… (same)  one continuous session, not two independent calls
exitInfo: { code: 0 }         clean exit after stdin closed
```

`--input-format stream-json` is documented in `claude --help` as
"(realtime streaming input)", and `-p/--print` explicitly supports the
`--input-format=stream-json` + `--output-format=stream-json` combination (which also
skips the workspace-trust dialog). The persistent, multi-turn behaviour is confirmed.

## 4. The `ClaudeCodeSession` class

Mirrors `CodexAppServerSession`. Event-driven (no async status polling).

| Contract member | Claude Code implementation |
|---|---|
| `start()` | Spawn the CLI (args below) with `cwd`, `childEnv(this)`, `stdio: pipe/pipe/pipe`, `windowsHide`. Write the pid record. `readline` over stdout → `#handleLine`. Mark `idle` once the child has spawned and stdin is writable — do **not** block on a stdout readiness event: the observed trail shows `system/init` arriving once per *turn* (after the first user message), not as a startup handshake, and writing the first message immediately after spawn works. The binary is a native `.exe`, so `spawnPlan` launches it directly with no cmd.exe. |
| `send(message, opts)` | Reject if closed / no proc / a turn is already running. Set `running`. Write `{"type":"user","message":{"role":"user","content":message}}\n` to stdin. Begin the turn clock; accumulate `assistant` text; the turn promise resolves on the next `result` event. `wait`/non-`wait` and `maxChars` semantics identical to Codex. |
| turn-completion | The `result` event. `subtype: "success"` → resolve; error subtype / `is_error` → settle as failed. `result.result` is the final text; `result.usage` the token usage; `result.session_id` is stable across turns. |
| `result(opts)` | `buildSessionResult(this, finalText, opts)`. |
| `isSettled()` | `status === "idle" && !this.turn` (mirrors Codex's own-state test). |
| `refreshStatus()` | Synchronous no-op (event-driven, like Codex) — keeps status snapshots synchronous w.r.t. pipelined MCP requests. |
| `abort()` | See §7. |
| `close(opts)` | `stdin.end()` (proven clean exit, code 0), then `terminateProcessTree` + `scheduleForceKill` backstop only while our child handle is still live; remove pid record unless `removePidRecord === false`; rm answer artifact. |
| `summary()` | Standard flat shape + `agentSpecific: { sessionId, turnCount }`. |

### 4.1 Registry entry

```js
claude: {
  label: "Claude Code",
  env: "CLAUDE_BIN",
  bin: "claude",
  role: "claude-stream-json",
  versionArgs: ["--version"],
  // SECURITY BOUNDARY: keep tight — too loose risks killing an unrelated process during reclaim.
  matchesCommand: cmd => /\bclaude\b/.test(cmd) && /--input-format\s+stream-json/.test(cmd),
}
```

## 5. Command-line construction

Base (always):

```
claude --print --input-format stream-json --output-format stream-json --verbose
       --strict-mcp-config
```

- `--strict-mcp-config` (with no `--mcp-config`) loads **zero MCP servers** while
  still loading project `CLAUDE.md`, skills, and hooks — i.e. "cut MCP, keep project
  context." This prevents a delegated Claude from re-acquiring the agent-bridge MCP
  and nesting further delegation.
- `model` (if set, after `sanitizeAgentArg`) → `--model <model>`.
- `effort` is **ignored** for this backend: Claude Code has no per-turn effort knob
  (unlike Codex). Documented as unsupported; not silently mapped to anything.

> Post-review amendment (v0.9.0): Claude Code 2.1.196 exposes `--effort <level>`; the backend now maps `effort` to it, defaulting to `xhigh`. The original 'effort ignored' note is superseded.

Permission segment, by `write`:

| `write` | flags |
|---|---|
| `true`  | `--permission-mode bypassPermissions` — full autonomy in `cwd` (edits + Bash + all tools), matching OMP `--auto-approve yolo` / Codex `workspace-write`. |
| `false` | `--permission-mode default --allowedTools "Read,Glob,Grep,Bash,WebFetch,WebSearch"` — read + read-only Bash. In headless there is no approver, so non-allowlisted tools (Edit/Write/…) are denied. Bash is allowlisted for read-only commands (grep/find/git log); this is trust-by-prompt, **not** OS-level isolation (Claude Code has no read-only sandbox). |

> Post-review amendment (v0.9.0): `Bash` was dropped from the read-only allowlist — `--allowedTools Bash` grants full shell with no headless approver, which would break the `write:false` no-mutation boundary. Read-only is now `Read,Glob,Grep,WebFetch,WebSearch`. Caveat: `--strict-mcp-config` still loads project hooks, which execute outside the tool allowlist; `write:false` is a tool-level boundary, not a hook/OS sandbox.

(`--allowedTools` is passed as a single comma-joined argv entry to avoid variadic
greediness consuming following flags.)

## 6. Protocol frames (captured from v2.1.196)

- Input (stdin, one JSON object per line):
  `{"type":"user","message":{"role":"user","content":"<text>"}}`
- Per-turn output trail (stdout NDJSON):
  `system/init → system/thinking_tokens → assistant → result/success`
  (a leading `system/hook_started`/`hook_response` may appear when hooks load; benign).
- Turn boundary: the `result` event —
  `{ type:"result", subtype:"success"|<error>, is_error, session_id, result:"<text>", usage:{…} }`.

Streaming `assistant` events carry the assembled message; per-token deltas
(`stream_event` with `--include-partial-messages`) are NOT requested — the bridge only
needs final text, and the `assistant`/`result` events already carry it. `system/*`,
`rate_limit_event`, and `thinking_tokens` are treated as noise events (logged, not
surfaced) consistent with `NOISE_EVENT_TYPES`.

## 7. Abort strategy

Claude Code persists each session transcript to disk
(`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`), which gives a clean fallback
that OMP/Codex lack.

- Primary: attempt a stream-json **control-request interrupt** to cancel the in-flight
  turn and return to `idle` (parity with Codex `turn/interrupt`). **This is the one
  detail to verify empirically during implementation** — exact control frame shape.
- Fallback (if the control interrupt proves unreliable): terminate the child and, on
  the next `send`, respawn with `--resume <session_id>` to continue the SAME
  conversation from the on-disk transcript. Sessions are cheap and continuity is
  preserved.

Wait-timeout auto-abort (as Codex does on a `wait:true` timeout) uses the same path so
the session stays reusable rather than wedged at `running`.

## 8. doctor, cleanup, Windows — all automatic

- `doctor`: registry-driven — `claude --version` probe via `spawnPlan`; prints
  `claude: ok (claude) 2.1.196 …`.
- Cleanup: `matchesCommand` lets the existing orphan reaper find/confirm/kill a
  bridge-spawned `claude` after a hard server kill, with the same env-marker /
  start-time identity confirmation used for OMP/Codex.
- Windows: `claude.exe` is a native executable at `~/.local/bin/claude.exe`, so
  `spawnPlan` launches it directly (no cmd.exe routing, no injection surface). The
  `CLAUDE_BIN` env override exists for non-standard locations. stdin framing is
  plain `\n`-terminated JSON, already what the bridge writes.

## 9. Testing

- Unit-ish: reuse the repro/e2e harness pattern in `docs/repro-mcp-hang/`. Add a
  `claude`-backed real e2e: open → send (read-only) → result → second turn → close,
  asserting the same session lifecycle invariants the OMP/Codex e2e covers.
- Turn-state: confirm `isSettled()` never reports a settled turn mid-stream and never
  dead-waits a never-prompted session (the v0.8.1 class of bug).
- abort: a dedicated repro for the chosen abort path (control interrupt or
  resume-respawn), asserting the session is reusable afterward.
- Run `doctor` and confirm `claude: ok`.

## 10. Out of scope (YAGNI)

- The Agent SDK path (§3 B).
- Partial-message/token streaming surfacing (`--include-partial-messages`).
- ~~An `effort` mapping for Claude Code.~~ (superseded — see §5 amendment above)
- Any change to the shared contract, tool schemas, or other backends.

## 11. Open item to resolve during implementation

The exact stream-json control-request frame for turn interrupt (§7). Everything else
is verified against v2.1.196 on the target machine.
