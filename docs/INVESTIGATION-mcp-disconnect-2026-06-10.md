# Investigation — "new Claude Code disconnects the current agent-bridge MCP" + server pileup

**Date:** 2026-06-10 (updated same day after controlled reproduction)
**Status:** **ROOT CAUSES CONFIRMED — FIXES IMPLEMENTED & VERIFIED (v0.8.1; parent-death watchdog P6 added v0.8.2; cross-review hardening v0.8.3).** Two independent causes found — one external one-off, one reproducible agent-bridge bug. P1–P4 + P6 below are implemented in `scripts/agent-bridge.mjs`; all repro harnesses and the close-regression check pass (kill: 3/3 waits return `failed` promptly; pipebreak: wait returns `timedOut` on schedule; parent-death: server self-exits with stdin held open and reaps its backend; server exits cleanly after stdin close; `close_session` still terminates a live backend).

**v0.8.3 follow-up (cross-review by codex + deepseek-v4-pro):** the P1–P6 fixes were cross-reviewed by four models; codex + deepseek surfaced real residual issues, now fixed and reproduced — F1 crash-scene aged by `bridge.log` mtime (P3 had used the dir mtime, reclaiming long-lived servers' post-mortems early); F2 watchdog arms only if the parent was alive at startup (closes the P6 shell-wrapper false-kill edge it had flagged); F3 `send()` catch can't flip a `dead` session to idle; F4 half-dead backend (alive, writable, silent) is declared `failed` after N RPC timeouts so `wait` fails fast instead of stalling to its deadline; F5 numeric env vars warn+fall-back instead of `NaN`-silently-disabling. Plus F7+F8 (a separate latent bug): the turn clock could read `endedAt` while `running` — see [BUG-omp-turn-state-inconsistency-2026-06-10.md](BUG-omp-turn-state-inconsistency-2026-06-10.md). New deterministic repros: `repro-turnstate`, `repro-halfdead`, `repro-reclaim`, `repro-watchdog-disarm` (all PASS, turn-state with a negative control). Full write-up in [CONSUMER_FEEDBACK.md](CONSUMER_FEEDBACK.md) § v0.8.3.
**Reporter symptom:** When launching multiple Claude Code instances, only the newest seems to have a working agent-bridge MCP; starting another client appears to disconnect the current client's agent-bridge MCP.

---

## TL;DR — what actually happened

1. **The observed `Connection closed` at 12:01:10 was the Node.js upgrade, not a bug in agent-bridge or CC.**
   Windows Application event log: the user ran `node-v24.16.0-x64.msi` at 12:01:01; the MSI's **Restart Manager** issued "Shutting down application or service 'Node.js JavaScript Runtime'" to every running `node.exe` at **12:01:06–12:01:10** — the exact second CC logged `Tool 'agent_bridge_wait' failed after 67s: MCP error -32000: Connection closed` (04:01:10.370Z). Every agent-bridge server is a `node.exe`; several were killed at once (some survived with "could not be shut down", e.g. pid 16024). CC auto-respawned the server +7s later and retried the wait → `Unknown session` (sessions live in server memory). **External, one-off, case closed.**

2. **The everyday symptom ("old client's bridge looks dead, newest works") is a reproducible agent-bridge bug: backend death during `wait` makes the tool call hang FOREVER.**
   Reproduced 6× with a stdio harness driving a real server (no CC involved): kill an omp backend mid-`agent_bridge_wait` (idle, streaming, or tree-kill variants) → the wait neither returns nor errors. To the user this *is* "the MCP is disconnected" — the server is alive but its tool calls never come back, while a freshly launched client works fine.

3. **The server/backend pileup is a direct downstream of the hang.** `serveMcp`'s exit gate (`maybeExit`, lines 2211–2213) requires `activeRequests === 0`; a hung request keeps `activeRequests ≥ 1` forever, so when the client later exits and stdin closes, the server **cannot exit** → zombie servers + orphaned backends accumulate.

4. **No cross-instance kill mechanism exists.** Proven by code audit + experiments: stdio-only, no shared exclusive resource, cleanup is identity-gated. "Launching a new client kills the old one's MCP" was the superposition of (1) the Node-upgrade mass-kill and (2) the hang bug.

---

## Facts established about Claude Code's MCP client (v2.1.170)

- **CC tolerates multi-minute tool calls.** Observed: `agent_bridge_wait` runs of 2m14s, 2m26s, 4m52s, 5m13s all completed; CC logs `still running (Ns elapsed)` every 30s. There is **no ~60s kill**; the earlier "67s" was coincidence (Node upgrade).
- On unexpected transport close, CC **auto-respawns** the server and **auto-retries** the in-flight tool call (observed: respawn +7s, retry at connect+0ms).
- `Terminating MCP server process tree` in CC logs = CC's own clean teardown (client exit/restart), not an error.
- CC logs live per project in `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project>\mcp-logs-agent-bridge\*.jsonl`.

## The reproducible bug, precisely

**Repro (harness in `%TEMP%\ab-repro\`, repro1/2/3.mjs + fake-omp):** drive `node scripts/agent-bridge.mjs mcp` over stdio → `open_session` (omp) → `agent_bridge_wait` (long timeout) → kill the backend (`taskkill /F`, `/T /F`, idle or mid-stream). **Result every time: the wait call hangs indefinitely** (observation windows 12–20s, far beyond the ≤1s a clean failure would take); in repro1 the server only drained much later via the wait's own `timeout_ms`.

**Mechanism (`scripts/agent-bridge.mjs`):**
- `request()` (1114–1122) unconditionally `this.proc.stdin.write(...)` and registers a `pending` entry. No liveness check.
- `proc.on("close")` (1001–1018) rejects + clears `pending` **once**. Any `request()` issued **after** that — e.g. `summarize → result() → request("get_last_assistant_text")` (1176–1183), `status → state()`, `abort()` — registers a pending that **no one will ever settle** → permanent hang.
- omp's `proc.stdin` has **no `error` listener** (codex has one at 1338) — a stream error there would be an uncaughtException; in practice on Windows the write is silently swallowed, which is *why* it hangs instead of crashing.
- `waitSessions` (1957–1982) swallows poll rejections (`.catch(() => {})`) but cannot guard a promise that never settles; once it enters `summarize` (mode=all settled path, 1968–1969) there is **no timeout** around it.

**Downstream (pileup):** `maybeExit` (2211–2213) = `inputClosed && activeRequests === 0`. Hung request ⇒ server never exits after stdin EOF ⇒ zombie `node … agent-bridge.mjs mcp` processes and their leftover backends. This reproduces the observed 7-server pileup (most of which the Node upgrade later culled).

## Secondary defects found on the way (latent, none caused this incident)

1. **Crash evidence is destroyed by siblings.** `cleanupAndExit` deliberately keeps the run dir on `code !== 0` "for debugging" (2302–2308), but any later server's `reclaimStaleLogs` (780–820) deletes every dead-owner run dir unconditionally — the crash breadcrumbs (`bridge.log` with reason, backend exit codes) are gone within one sweep. This is why the 12:01:10 victim left no trace and the investigation had to go through the Windows event log.
2. **`close()` fires an unverified first shot.** `terminateProcessTree(pid)` (1271) targets the recorded backend pid with no identity check; only the SIGKILL **backstop** verifies (1275). A long-dead backend whose pid was recycled means the first SIGTERM/taskkill can hit a stranger. (The startup/cleanup path *does* verify via `classifyChild`; it's only session `close()` that doesn't.)
3. **`ownerStillRunning` has a narrow false-negative window.** If the CIM snapshot succeeds but returns an empty `CommandLine` for a live owner (access/race anomalies), the owner is judged dead (`""` → no match, 659–662) and its backends/pid records/run dir become reapable by a sibling. Fail-safe covers probe *failure* (null), not *blank rows*.
4. **`winProcessSnapshot` is a blocking `spawnSync powershell`** (527–554) on startup and the 30-min timer — freezes the event loop of a live server for the duration of a full `Win32_Process` dump.
5. **Duplicate-scope CC registration** (user scope + repo `.mcp.json`) — `claude mcp list` warns; harmless to the above but worth deduping.

## Fixes — implementation guide (root-cause, prioritized; line numbers are v0.8.0)

### P1 — fail-fast `request()` (fixes the hang itself)

In `OmpRpcSession`:

1. Add `this.dead = false;` in the constructor. Set `this.dead = true;` at the top of both the `proc.on("error")` handler (992) and the `proc.on("close")` handler (1001), and in `close()` (1258).
2. Guard `request()` (1114–1122) before the write:
   ```js
   request(type, extra = {}) {
     if (this.dead || !this.proc || this.proc.exitCode !== null ||
         !this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
       return Promise.reject(new Error(`OMP process for ${this.id} is not running.`));
     }
     // ...existing body
   }
   ```
3. Add `this.proc.stdin.on("error", err => appendLog(this.logFile, `[agent-bridge] OMP stdin error: ${err.message}\n"));` next to the close listeners (979) — parity with codex's 1338; without it a stream error is an uncaughtException that kills the whole server.
4. Apply the same `dead`-flag + guard pattern to `CodexAppServerSession`'s request/write path (class at 1284–1784) — audit it for the identical "pending registered after close is never settled" shape.

No changes needed in `waitSessions`/`result`/`status`: they already `.catch` rejections (1181, 1942, 1961, 1878); they only hang today because the promise never settles. After P1, backend death mid-wait surfaces as a failed session within one 250ms poll tick.

**P1b (found by the pipebreak repro during implementation):** the dead-proc guards don't cover a backend that is *alive but unresponsive* (or a half-broken pipe, where writes still succeed) — `waitSessions` then wedges inside `await session.state()` and never even reaches its own `timeout_ms` check. Fix: bound every OMP RPC in `request()` with `OMP_RPC_TIMEOUT_MS` (default 10s, env `AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS`; the timeout also deletes the pending entry). Safe because every OMP command is an immediate ack — long work is observed by polling. Codex needs no equivalent: all its `#request` call sites are already `withTimeout`-bounded.

### P2 — bound the exit gate (fixes the zombie pileup)

`serveMcp`, `rl.on("close")` (2232–2235): stdin EOF means the client is gone and nobody will ever read a response. Force exit after a short grace even if a request is stuck:

```js
rl.on("close", () => {
  inputClosed = true;
  maybeExit();
  if (activeRequests > 0) {
    const t = setTimeout(() => cleanupAndExit(0, "stdin closed (grace expired with active requests)"), 5000);
    t.unref?.();
  }
});
```

### P3 — preserve crash scenes

`reclaimStaleLogs` (780–820) currently deletes every dead-owner run dir, defeating `cleanupAndExit`'s deliberate "keep on `code !== 0`" (2302–2308). Before the `rmSync` (815): if the dir contains a `bridge.log` whose text matches `shutdown code=[1-9]` **and** the dir is younger than `LOG_RETENTION_DAYS`, skip it. Crash dirs then age out via the normal retention sweep instead of being destroyed by the next sibling startup.

### P4 — verify before the first shot in `close()`

`close()` (1267–1276) calls `terminateProcessTree(pid)` unconditionally; only the SIGKILL backstop verifies. Gate the first shot with the same check the backstop uses — our own child handle is authoritative:

```js
if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
  terminateProcessTree(pid);
  scheduleForceKill(pid, 3000, () => this.proc != null && this.proc.exitCode === null && this.proc.signalCode === null);
}
```

Mirror in `CodexAppServerSession.close()` if it has the same shape.

### P6 — parent-death watchdog (added v0.8.2)

P2 reaps a server only when stdin EOFs. But a server can be orphaned with its stdin pipe still **held open** by another process — the exact shape of the 2-day-old pid-16024 zombie, whose parent was a *hung* `pi … models` command retaining the pipe. No EOF ever arrives, so the server runs forever and leaks its backends.

Fix: capture the spawning parent's pid once at startup (`process.ppid`) and poll its liveness on a cheap, **non-spawning** `process.kill(pid, 0)` probe (`pidAlive`, no PowerShell/CIM on the hot path — sidesteps the P5/winProcessSnapshot freeze). When the parent is gone for two consecutive ticks (`PARENT_WATCHDOG_INTERVAL_MS`, default 15s), `cleanupAndExit(0, …)` — which closes sessions and SIGTERMs backends, so the orphan reaps itself instead of leaking. `pidAlive` fails **safe**: only a definitive `ESRCH` counts as gone (EPERM/other → assume alive), so a live server is never reaped by an ambiguous probe. `AGENT_BRIDGE_PARENT_PID` overrides the watched pid (supervisor/test hook).

**Scope/limits (honest):** this catches *parent death*, not *parent hang*. The literal pid-16024 case (parent alive-but-hung) is still not auto-reaped — an alive parent might resume, so reaping it is unsafe by construction. The watchdog closes the much more common "client process died but the pipe lived on" leak, complementing the stdin-EOF path. Spawn model assumed: the client launches `node …mjs mcp` directly (ppid = client), which is how both the CC and Codex registrations in the README work; a shell-wrapper that exits early would trip it, so the override exists.

### P5 — hygiene (separate, optional)

Dedupe the CC registration (user scope vs repo `.mcp.json`); make `winProcessSnapshot` async/cheaper (existing backlog item).

### Verification (repro harness is committed in `docs/repro-mcp-hang/`)

```sh
node docs/repro-mcp-hang/repro-kill.mjs           # backend killed mid-wait  (P1/P1b/P2)
node docs/repro-mcp-hang/repro-pipebreak.mjs      # backend breaks its stdin pipe while alive (P1b)
node docs/repro-mcp-hang/repro-parent-death.mjs   # client dies while stdin stays open (P6)
```

- **Before fixes:** kill/pipebreak print `wait HUNG` (tool call never returns).
- **After P1:** the wait returns within ~1–2s with the session reported `failed` (and `repro-kill` exercises P2 implicitly: when the harness exits, the server must be gone within ~5s — check with `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'agent-bridge' }`).
- **P6:** `repro-parent-death` keeps the server's stdin open the whole time and kills a separate watched pid; the server must still self-exit `code=0` and its backend must be reaped — proving the watchdog, not the stdin path, did it.
- Also re-run a normal end-to-end (open → send → wait → close with a real backend) to confirm no regression, then `node scripts/agent-bridge.mjs cleanup` must report nothing to reap.

All three repros + the e2e close-regression PASS as of v0.8.2 (Windows).

## Evidence index

- CC log, victim session `ece97119` (project `D:\cc\photo_detect\demo`, file `2026-06-09T05-10-11-935Z.jsonl`): healthy long waits for 23h → 3 sessions opened 11:59:14/45/58 → wait 12:00:02 → `still running (60s)` 12:01:02 → **`Connection closed` 12:01:10.370** → respawn 12:01:17 → retry → `Unknown session: omp-mq7jhqvr-13qbkx`.
- Windows Application event log 12:01:01–12:01:49: MsiInstaller `node-v24.16.0-x64.msi` begin/installed; RestartManager 10002 "Shutting down … Node.js JavaScript Runtime" ×14 at 12:01:10, plus 10006/10010 ("could not be shut down", pid list including 16024).
- Repro harness: committed as `docs/repro-mcp-hang/` (`repro-kill.mjs`, `repro-pipebreak.mjs`, `fake-omp.*`) — original runs: kill-idle ×4, kill-streaming `/F`, tree-kill `/T /F`: hang every time; no crash, no graceful return. `repro-kill.mjs` also self-checks P2 (server must exit ≤5s after stdin close).
- Repro leftovers were reaped afterwards with `node scripts/agent-bridge.mjs cleanup` (worked as designed: 1 record + 1 run dir removed, 0 terminations, live owners untouched).
- Key code: `request()` 1114–1122 · omp `close` handler 1001–1018 · omp stdin no-error-listener (cf. codex 1338) · `waitSessions` 1957–1982 · `summarize`/`result` 1176–1188, 1939–1953 · `maybeExit` 2209–2213 · `cleanupAndExit` 2289–2310 · `reclaimStaleLogs` 780–820 · `ownerStillRunning` 650–663 · `close()` first-shot 1267–1276 · `winProcessSnapshot` 527–554.
