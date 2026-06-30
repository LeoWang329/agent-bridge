# Claude Code Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third delegated-agent backend, `claude`, that drives Claude Code's headless stream-json mode as a persistent stdio subprocess — structurally a twin of the existing `codex` backend.

**Architecture:** A new `ClaudeCodeSession` class in `scripts/agent-bridge.mjs` spawns `claude --print --input-format stream-json --output-format stream-json --verbose` once, writes newline-delimited `{"type":"user",...}` messages to stdin, and resolves each turn on the stdout `result` event. It satisfies the existing duck-typed backend contract; a one-line `AGENTS` registry entry wires it into doctor/cleanup/dispatch automatically.

**Tech Stack:** Node 20+ stdlib only (`child_process`, `readline`). No new dependencies. Claude Code CLI (`claude`) on PATH.

## Global Constraints

- Node 20+; **zero new third-party dependencies** (the product is a single dependency-free `.mjs`).
- All product code lives in `scripts/agent-bridge.mjs`; follow the existing `CodexAppServerSession` patterns exactly (it is the template).
- Tool **inputs** snake_case, **outputs** camelCase (unchanged — no tool-schema changes).
- Cross-platform (Windows + POSIX). On Windows `claude.exe` is a native executable, so `spawnPlan` launches it directly.
- Backend binary overridable via `CLAUDE_BIN`.
- Do not commit secrets or machine-specific absolute paths.
- Verified facts this plan relies on (claude v2.1.196, captured empirically — do not re-derive):
  - Persistent multi-turn over one process: confirmed.
  - Input frame: `{"type":"user","message":{"role":"user","content":"<text>"}}` (content as a plain string works).
  - Turn boundary: `{type:"result", subtype:"success"|<error>, is_error, session_id, result:"<final text>", usage}`. Final text = `result.result` (no need to assemble from `assistant` events).
  - Nothing is emitted on stdout before the first user message; the process being up IS readiness.
  - Abort: `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` → `{"type":"control_response","response":{"subtype":"success","request_id":"<id>"}}`; the in-flight turn then emits `result/error_during_execution` and the SAME process stays reusable.

---

### Task 1: Registry entry + doctor probe

**Files:**
- Modify: `scripts/agent-bridge.mjs` (the `AGENTS` literal, ~line 80-99)

**Interfaces:**
- Produces: `AGENTS.claude` config object `{ label, env, bin, role, versionArgs, matchesCommand }`. `Session` is late-bound in Task 2. Adding this key auto-extends the `open_session` `agent` enum (`Object.keys(AGENTS)`), the doctor probe, and cleanup matching.

- [ ] **Step 1: Write the failing test**

Create `docs/repro-mcp-hang/probe-claude-doctor.mjs`:

```js
// Asserts the `claude` backend is registered and doctor probes it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/agent-bridge.mjs");
const out = spawnSync("node", [BRIDGE, "doctor"], { encoding: "utf8" });
const text = (out.stdout || "") + (out.stderr || "");
const ok = /(^|\n)claude:\s*(ok|missing)/i.test(text);
console.log(text);
console.log(ok ? ">>> PASS: claude backend registered (doctor lists it)" : ">>> FAIL: claude not listed by doctor");
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node docs/repro-mcp-hang/probe-claude-doctor.mjs`
Expected: FAIL — doctor lists only `omp:` and `codex:`, no `claude:` line.

- [ ] **Step 3: Add the registry entry**

In `scripts/agent-bridge.mjs`, add to the `AGENTS` object (after the `codex` entry, before the closing `}`):

```js
  claude: {
    label: "Claude Code",
    env: "CLAUDE_BIN",
    bin: "claude",
    role: "claude-stream-json",
    versionArgs: ["--version"],
    // SECURITY BOUNDARY: keep tight — too loose risks terminating an unrelated process during reclaim.
    matchesCommand: cmd => /\bclaude\b/.test(cmd) && /--input-format\s+stream-json/.test(cmd),
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node docs/repro-mcp-hang/probe-claude-doctor.mjs`
Expected: PASS — output contains `claude: ok (claude) 2.1.x` (or `claude: missing` on a machine without the CLI; either proves registration).

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-bridge.mjs docs/repro-mcp-hang/probe-claude-doctor.mjs
git commit -m "feat(claude): register Claude Code backend in AGENTS (doctor + dispatch enum)"
```

---

### Task 2: ClaudeCodeSession — start / close / summary

**Files:**
- Modify: `scripts/agent-bridge.mjs` (add the class after `CodexAppServerSession`, ~line 2152; add the late-bind at ~line 2159)

**Interfaces:**
- Consumes: `AGENTS.claude` (Task 1); shared helpers `assertCwd, sanitizeAgentArg, makeId, nowIso, agentBin, spawnPlan, childEnv, appendLog, stripAnsi, clampText, setSessionStatus, pushEvent, compactEvent, writePidRecord, removePidRecord, pidRecordPath, terminateProcessTree, scheduleForceKill, lastTurnOf, withTimeout, RUN_LOG_DIR`.
- Produces: `class ClaudeCodeSession` with fields `id, agent, cwd, write, model, effort, createdAt, updatedAt, status, isStreaming, lastAssistantText, lastError, events, proc, claudeSessionId, currentTurnId, lastTurnId, turnStartedAt, turnEndedAt, turnCount, turn, interrupting, controlPending, nextControlId, finalAnswer, tokenUsage, logFile, answerFile, pidFile`; methods `#buildArgs()`, `start()`, `#writePidRecord()`, `#handleLine(line)` (stub), `close(opts)`, `summary()`. Late-bind `AGENTS.claude.Session = ClaudeCodeSession`. Turn-driving methods land in Task 3.

- [ ] **Step 1: Write the failing test**

Create `docs/repro-mcp-hang/probe-claude-open.mjs`:

```js
// Open a read-only AND a write claude session, assert each reaches status "idle", then close.
// SKIPs (exit 0) if `claude` is not on PATH.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log(">>> SKIP: claude not on PATH"); process.exit(0);
}
const { spawn } = await import("node:child_process");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let exited = null; srv.on("close", (code, signal) => { exited = { code, signal }; });
let buf = ""; const got = new Map();
srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { const o = JSON.parse(l); if (o.id !== undefined) got.set(o.id, o); } catch {} } } });
srv.stderr.on("data", () => {});
let idc = 0;
function rpc(method, params) { const id = ++idc; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; }
async function call(name, args, waitMs = 60000) { const id = rpc("tools/call", { name, arguments: args }); const t = Date.now(); while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(100); } const o = got.get(id); if (!o) throw new Error(`timeout ${name}`); if (o.error) return { __error: o.error }; try { return JSON.parse(o.result.content[0].text); } catch { return { __raw: o.result?.content?.[0]?.text }; } }

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };
try {
  rpc("initialize", { protocolVersion: "2025-06-18" }); await sleep(300);
  const ro = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  check("open claude read-only -> idle", ro.session?.agent === "claude" && ro.session?.status === "idle", ro.session?.status);
  const w = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: true });
  check("open claude write -> idle, write:true", w.session?.status === "idle" && w.session?.write === true, JSON.stringify({ s: w.session?.status, write: w.session?.write }));
  const closed = await call("agent_bridge_close_session", {});
  check("close all", closed.closedAll === true || closed.count >= 2, JSON.stringify({ count: closed.count }));
} catch (e) { check(`harness error: ${e.message}`, false); }
finally { srv.stdin.end(); await sleep(800); if (!exited) srv.kill(); await sleep(300); check("server clean shutdown", exited?.code === 0, JSON.stringify(exited)); console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node docs/repro-mcp-hang/probe-claude-open.mjs`
Expected: FAIL — `open claude` errors with a `TypeError` (`AGENTS.claude.Session` is undefined; not yet bound).

- [ ] **Step 3: Add the ClaudeCodeSession class (start/close/summary)**

In `scripts/agent-bridge.mjs`, immediately after the `CodexAppServerSession` class closing brace (before the `AGENTS.omp.Session = ...` late-binds), insert:

```js
// Claude Code over headless stream-json. A persistent `claude --print --input-format stream-json
// --output-format stream-json` process: newline-delimited {"type":"user",...} on stdin, one `result`
// event per turn on stdout. Structurally a twin of CodexAppServerSession (event-driven, no status
// polling). See the backend session contract banner above OmpRpcSession.
class ClaudeCodeSession {
  constructor(options) {
    this.id = makeId("claude");
    this.agent = "claude";
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);
    this.model = sanitizeAgentArg(options.model, "model"); // null when unset; flows to --model
    this.effort = options.effort || null; // accepted but IGNORED: Claude Code has no per-turn effort knob
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    this.events = [];
    this.proc = null;
    this.claudeSessionId = null;     // claude's own session uuid (from system/init + result.session_id)
    this.currentTurnId = null;
    this.lastTurnId = null;
    this.turnStartedAt = null;
    this.turnEndedAt = null;
    this.turnCount = 0;
    this.turn = null;                // { resolve, reject, promise, settled } — the in-flight turn
    this.interrupting = false;       // true between abort()'s interrupt and the resulting error result
    this.controlPending = new Map(); // request_id -> { resolve, reject } for control_request/response
    this.nextControlId = 1;
    this.finalAnswer = "";           // unclamped final text from result.result
    this.tokenUsage = null;
    this.logFile = path.join(RUN_LOG_DIR, `${this.id}.log`);
    this.answerFile = path.join(RUN_LOG_DIR, `${this.id}.answer.txt`);
    this.pidFile = pidRecordPath(this.id);
  }

  #buildArgs() {
    const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"];
    if (this.model) args.push("--model", this.model);
    if (this.write) {
      // Parity with OMP --auto-approve yolo / Codex workspace-write: full autonomy in cwd.
      args.push("--permission-mode", "bypassPermissions");
    } else {
      // Read + read-only Bash. Headless has no approver, so non-allowlisted tools (Edit/Write/...) are
      // denied. Bash is allowed for read-only commands (grep/git log); trust-by-prompt, not isolation.
      args.push("--permission-mode", "default", "--allowedTools", "Read,Glob,Grep,Bash,WebFetch,WebSearch");
    }
    return args;
  }

  async start() {
    const args = this.#buildArgs();
    appendLog(this.logFile, `$ ${[agentBin("claude"), ...args].join(" ")}\n`);
    const plan = spawnPlan(agentBin("claude"), args);
    this.proc = spawn(plan.command, plan.args, { cwd: this.cwd, env: childEnv(this), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    appendLog(this.logFile, `[agent-bridge] spawned claude pid=${this.proc.pid}\n`);
    this.#writePidRecord();

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", text => { appendLog(this.logFile, text); this.lastError = clampText(stripAnsi(text), 4000); });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdin.on("error", err => {
      appendLog(this.logFile, `[agent-bridge] claude stdin error: ${err.message}\n`);
      this.lastError = err.message;
      if (this.status !== "closed") { setSessionStatus(this, "failed", false, { source: "stdin_error", error: err.message }); this.#failTurn(err); }
    });
    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", line => this.#handleLine(line));

    this.proc.on("error", err => { this.lastError = err.message; setSessionStatus(this, "failed", false, { source: "process_error", error: err.message }); this.#failTurn(err); });
    this.proc.on("close", (code, signal) => {
      appendLog(this.logFile, `[agent-bridge] claude exited code=${code} signal=${signal || ""}\n`);
      removePidRecord(this.pidFile);
      if (this.status === "closed") { setSessionStatus(this, "closed", false, { source: "process_close", code, signal }); return; }
      this.lastError = code === 0 ? this.lastError : `claude exited with code ${code}`;
      setSessionStatus(this, code === 0 && this.status !== "failed" ? "closed" : "failed", false, { source: "process_close", code, signal });
      this.#failTurn(new Error(this.lastError || "claude exited."));
    });

    // No startup handshake: the CLI emits nothing on stdout until the first user message, and writing
    // that message immediately after spawn is safe (verified). The live process IS readiness.
    setSessionStatus(this, "idle", false, { source: "ready" });
    return this;
  }

  #writePidRecord() {
    writePidRecord(this.pidFile, {
      id: this.id,
      agent: this.agent,
      ownerPid: process.pid,
      cwd: this.cwd,
      createdAt: this.createdAt,
      processes: [
        { role: AGENTS[this.agent].role, pid: this.proc?.pid || null, command: [agentBin("claude"), ...this.#buildArgs()], spawnedAt: nowIso() },
      ].filter(item => item.pid),
    });
  }

  // Turn-driving line handler lands in Task 3. Stub keeps start() functional: log + record raw events.
  #handleLine(line) {
    if (!line.trim()) return;
    appendLog(this.logFile, `${line}\n`);
    this.updatedAt = nowIso();
  }

  // Turn-failure helper (used by start()'s error handlers now; turn methods reuse it in Task 3).
  #failTurn(err) {
    if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
    for (const p of this.controlPending.values()) p.reject(err);
    this.controlPending.clear();
    const turn = this.turn; this.turn = null;
    turn?.reject?.(err);
  }

  summary() {
    return {
      id: this.id,
      agent: this.agent,
      cwd: this.cwd,
      write: this.write,
      model: this.model,
      effort: this.effort,
      status: this.status,
      pid: this.proc?.pid || null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      logFile: this.logFile,
      lastTurn: lastTurnOf(this),
      agentSpecific: { claudeSessionId: this.claudeSessionId, turnCount: this.turnCount },
    };
  }

  close(options = {}) {
    setSessionStatus(this, "closed", false, { source: "close" });
    try { this.proc?.stdin?.end(); } catch {}
    this.#failTurn(new Error("session closed"));
    const pid = this.proc?.pid;
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      terminateProcessTree(pid);
      scheduleForceKill(pid, 3000, () => this.proc != null && this.proc.exitCode === null && this.proc.signalCode === null);
    }
    if (options.removePidRecord !== false) removePidRecord(this.pidFile);
    try { fs.rmSync(this.answerFile, { force: true }); } catch {}
    return { closed: true, sessionId: this.id };
  }
}
```

- [ ] **Step 4: Add the late-bind**

Find the existing late-binds and add the claude line:

```js
AGENTS.omp.Session = OmpRpcSession;
AGENTS.codex.Session = CodexAppServerSession;
AGENTS.claude.Session = ClaudeCodeSession;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node docs/repro-mcp-hang/probe-claude-open.mjs`
Expected: PASS — both sessions reach `idle`, `write:true` reflected, close-all and clean shutdown all PASS. (SKIP exit 0 if `claude` missing.)

- [ ] **Step 6: Commit**

```bash
git add scripts/agent-bridge.mjs docs/repro-mcp-hang/probe-claude-open.mjs
git commit -m "feat(claude): ClaudeCodeSession start/close/summary + registry late-bind"
```

---

### Task 3: Turn lifecycle — send / result / isSettled / refreshStatus

**Files:**
- Modify: `scripts/agent-bridge.mjs` (replace the `#handleLine` stub; add turn methods to `ClaudeCodeSession`)

**Interfaces:**
- Consumes: the Task 2 class + `buildSessionResult, DEFAULT_WAIT_TIMEOUT_MS, stripThinking`.
- Produces: `#write(msg)`, `#writeUser(text)`, `#beginTurn(turnId)`, `#settleTurn(err, status)`, replace `#handleLine`, add `#handleResult(msg)`, `async send(message, opts)`, `async result(opts)`, `isSettled()`, `refreshStatus()`. Turn id minted bridge-side as `${this.id}-t${n}`.

- [ ] **Step 1: Write the failing test**

Create `docs/repro-mcp-hang/probe-claude-turn.mjs` (same harness boilerplate as `probe-claude-open.mjs` Steps; only the `try` body differs):

```js
// --- identical boilerplate header as probe-claude-open.mjs: SKIP-if-missing, srv spawn, rpc/call, check ---
try {
  rpc("initialize", { protocolVersion: "2025-06-18" }); await sleep(300);
  const o = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  const id = o.session?.id;
  check("open", !!id, id);
  // Turn 1 inline (wait:true)
  const r1 = await call("agent_bridge_send_message", { session_id: id, message: "Reply with exactly this token and nothing else: CLAUDE_T1", wait: true, timeout_ms: 120000 }, 140000);
  check("turn 1 result text", (r1.text || "").includes("CLAUDE_T1"), (r1.text || "").slice(0, 50));
  check("turn 1 settled to idle", r1.session?.status === "idle", r1.session?.status);
  check("turn 1 charCount reported", typeof r1.charCount === "number" && r1.charCount > 0, String(r1.charCount));
  // Turn 2 reuse (non-blocking then wait)
  await call("agent_bridge_send_message", { session_id: id, message: "Reply with exactly this token and nothing else: CLAUDE_T2", wait: false });
  const w = await call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 120000 }, 140000);
  const got2 = (w.results || []).find(x => x.sessionId === id);
  check("turn 2 reuse (wait all)", (got2?.text || "").includes("CLAUDE_T2"), (got2?.text || "").slice(0, 50));
  await call("agent_bridge_close_session", {});
} catch (e) { check(`harness error: ${e.message}`, false); }
// --- identical finally block as probe-claude-open.mjs ---
```

(Copy the boilerplate header/finally verbatim from `probe-claude-open.mjs`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node docs/repro-mcp-hang/probe-claude-turn.mjs`
Expected: FAIL — `send_message` errors (`session.send is not a function`).

- [ ] **Step 3: Replace #handleLine and add the turn methods**

In `ClaudeCodeSession`, replace the stub `#handleLine` with the real one and add the methods below (place them logically: `#write/#writeUser` near the top of the methods, lifecycle helpers and `send/result/isSettled/refreshStatus` after `start`):

```js
  #write(msg) {
    appendLog(this.logFile, `> ${JSON.stringify(msg).slice(0, 600)}\n`);
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || this.proc.exitCode !== null) throw new Error("claude stdin is not writable");
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #writeUser(text) {
    this.#write({ type: "user", message: { role: "user", content: text } });
  }

  #beginTurn(turnId) {
    this.currentTurnId = turnId;
    this.lastTurnId = turnId;
    this.turnStartedAt = nowIso();
    this.turnEndedAt = null;
    this.finalAnswer = "";
    this.lastAssistantText = "";
  }

  #settleTurn(err, status) {
    const turn = this.turn;
    if (!turn) return;
    turn.settled = { err: err || null, status: status ?? null };
    this.turn = null;
    this.currentTurnId = null;
    this.turnCount += 1;
    this.turnEndedAt = nowIso();
    this.updatedAt = nowIso();
    if (err) { this.lastError = err.message; setSessionStatus(this, "failed", false, { source: "turn_error", error: err.message }); turn.reject(err); return; }
    setSessionStatus(this, "idle", false, { source: "turn/completed", status });
    turn.resolve();
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { appendLog(this.logFile, `${line}\n`); pushEvent(this, { type: "raw", line }); return; }
    // Skip verbatim-logging high-frequency streaming chunks; the result event still carries final text.
    if (msg.type !== "assistant" && msg.type !== "stream_event") appendLog(this.logFile, `${JSON.stringify(stripThinking(msg))}\n`);
    this.updatedAt = nowIso();
    if (msg.type === "control_response") { this.#handleControlResponse(msg); return; } // method added in Task 4
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) this.claudeSessionId = msg.session_id;
    if (msg.type === "assistant") {
      if (this.turn && !this.isStreaming) setSessionStatus(this, "running", true, { source: "assistant" });
      pushEvent(this, compactEvent({ type: "assistant" }));
      return;
    }
    if (msg.type === "result") { this.#handleResult(msg); return; }
    pushEvent(this, compactEvent({ type: msg.type, subtype: msg.subtype }));
  }

  #handleResult(msg) {
    pushEvent(this, compactEvent({ type: "result", subtype: msg.subtype, is_error: msg.is_error }));
    if (msg.session_id) this.claudeSessionId = msg.session_id;
    if (msg.usage) this.tokenUsage = msg.usage;
    // abort()'s interrupt produces a terminal `result/error_during_execution`; consume it as an
    // intentional abort (idle, NOT failed). The interrupting flag is set in Task 4's abort().
    if (this.interrupting) { this.interrupting = false; this.#settleTurn(null, "aborted"); return; }
    if (msg.is_error || msg.subtype !== "success") { this.#settleTurn(new Error(`claude turn ${msg.subtype || "error"}`), msg.subtype || "error"); return; }
    const text = typeof msg.result === "string" ? msg.result : "";
    this.finalAnswer = text;
    this.lastAssistantText = clampText(text);
    this.#settleTurn(null, msg.subtype);
  }

  async send(message, options = {}) {
    if (!message || !String(message).trim()) throw new Error("message is required.");
    if (this.status === "closed") throw new Error(`Claude session ${this.id} is closed.`);
    if (!this.proc || this.proc.exitCode !== null) throw new Error(`Claude process for ${this.id} is not running.`);
    if (this.turn) throw new Error(`Claude session ${this.id} already has a running turn.`);

    const turnId = `${this.id}-t${this.turnCount + 1}`;
    setSessionStatus(this, "running", true, { source: "send" });
    const promise = new Promise((resolve, reject) => { this.turn = { resolve, reject }; });
    this.turn.promise = promise;
    promise.catch(() => {}); // pre-attach so an early rejection can't crash the server

    try {
      this.#writeUser(String(message));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.#settleTurn(e, "error");
      throw e;
    }
    this.#beginTurn(turnId);

    if (options.wait) {
      try {
        return await withTimeout(promise.then(() => this.result({ maxChars: options.maxChars })), options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS, "Timed out waiting for Claude turn.");
      } catch (err) {
        if (this.turn) { try { await this.abort(); } catch {} } // method added in Task 4
        throw err;
      }
    }
    promise.catch(err => { this.lastError = err.message; });
    return { accepted: true, sessionId: this.id, status: this.status, turnId };
  }

  // async purely for signature parity with the other backends' result().
  async result(options = {}) {
    return buildSessionResult(this, this.finalAnswer || this.lastAssistantText || "", options);
  }

  // Settled = idle with no in-flight turn. Mirrors CodexAppServerSession.isSettled (keys off this.turn).
  isSettled() {
    return this.status === "idle" && !this.turn;
  }

  // Event-driven (the turn resolves on the `result` event); no live state to poll. Sync no-op keeps
  // status snapshots synchronous w.r.t. pipelined MCP requests (same rationale as Codex).
  refreshStatus() {}
```

Note: `send()` and `#handleLine` reference `this.abort()` / `this.#handleControlResponse()` which are added in Task 4. They are only *called* at runtime (abort on a wait timeout; control_response on stdout), so the class loads and Task 3's tests pass without them; do not stub them — Task 4 fills them in before any abort path is exercised.

- [ ] **Step 4: Run test to verify it passes**

Run: `node docs/repro-mcp-hang/probe-claude-turn.mjs`
Expected: PASS — turn 1 returns `CLAUDE_T1`, settles idle, reports charCount; turn 2 reuse returns `CLAUDE_T2`.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-bridge.mjs docs/repro-mcp-hang/probe-claude-turn.mjs
git commit -m "feat(claude): turn lifecycle — send/result/isSettled/refreshStatus over stream-json"
```

---

### Task 4: Abort — control_request interrupt + wait-timeout cleanup

**Files:**
- Modify: `scripts/agent-bridge.mjs` (add control + abort methods to `ClaudeCodeSession`)

**Interfaces:**
- Consumes: Task 3 class; `withTimeout`.
- Produces: `#control(subtype)`, `#handleControlResponse(msg)`, `async abort()`. Sets `this.interrupting` so `#handleResult` (Task 3) treats the interrupt's terminal result as an abort.

- [ ] **Step 1: Write the failing test**

Create `docs/repro-mcp-hang/probe-claude-abort.mjs` (same boilerplate; `try` body below):

```js
try {
  rpc("initialize", { protocolVersion: "2025-06-18" }); await sleep(300);
  const o = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  const id = o.session?.id;
  // Long, interruptible turn — start non-blocking.
  await call("agent_bridge_send_message", { session_id: id, message: "Count from 1 to 80. For each number write one full sentence about a historical event from that year AD. Be thorough.", wait: false });
  await sleep(2500);
  const ab = await call("agent_bridge_abort", { session_id: id });
  check("abort accepted", ab.aborted === true, JSON.stringify(ab).slice(0, 60));
  await sleep(1500);
  const st = await call("agent_bridge_status", { session_id: id });
  check("idle after abort (reusable)", st.session?.status === "idle", st.session?.status);
  // Prove reusability: a fresh turn succeeds on the same session.
  const r = await call("agent_bridge_send_message", { session_id: id, message: "Reply with exactly: CLAUDE_AFTER_ABORT", wait: true, timeout_ms: 90000 }, 110000);
  check("reuse after abort", (r.text || "").includes("CLAUDE_AFTER_ABORT"), (r.text || "").slice(0, 50));
  await call("agent_bridge_close_session", {});
} catch (e) { check(`harness error: ${e.message}`, false); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node docs/repro-mcp-hang/probe-claude-abort.mjs`
Expected: FAIL — `agent_bridge_abort` errors (`session.abort is not a function`).

- [ ] **Step 3: Add the control + abort methods**

Add to `ClaudeCodeSession`:

```js
  #control(subtype) {
    const requestId = `ctl-${this.nextControlId++}`;
    const promise = new Promise((resolve, reject) => this.controlPending.set(requestId, { resolve, reject }));
    try { this.#write({ type: "control_request", request_id: requestId, request: { subtype } }); }
    catch (err) { this.controlPending.delete(requestId); throw err; }
    return promise;
  }

  #handleControlResponse(msg) {
    const id = msg.response?.request_id ?? msg.request_id;
    const pending = this.controlPending.get(id);
    if (!pending) return;
    this.controlPending.delete(id);
    if (msg.response?.subtype === "error") pending.reject(new Error(msg.response?.error || "claude control error"));
    else pending.resolve(msg.response ?? {});
  }

  async abort() {
    const turn = this.turn;
    if (!turn || !this.proc || this.proc.exitCode !== null) {
      // Nothing in flight — just normalize to idle if still live.
      if (this.status !== "closed" && this.proc && this.proc.exitCode === null) setSessionStatus(this, "idle", false, { source: "abort" });
      if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
      return { aborted: true, sessionId: this.id };
    }
    // Tell #handleResult the imminent terminal `result/error_during_execution` is an intentional abort.
    this.interrupting = true;
    try { await withTimeout(this.#control("interrupt"), 5000, "claude interrupt timeout"); } catch {}
    // The interrupted turn settles via #handleResult when its result arrives. Wait briefly for that;
    // if it never comes (e.g. control swallowed), settle manually so the session stays reusable.
    try { await withTimeout(turn.promise, 5000, "claude abort settle timeout"); }
    catch { this.interrupting = false; if (this.turn === turn) this.#settleTurn(null, "aborted"); }
    return { aborted: true, sessionId: this.id };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node docs/repro-mcp-hang/probe-claude-abort.mjs`
Expected: PASS — abort accepted, session idle and reusable, follow-up turn returns `CLAUDE_AFTER_ABORT`.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-bridge.mjs docs/repro-mcp-hang/probe-claude-abort.mjs
git commit -m "feat(claude): abort via stream-json control_request interrupt (session stays reusable)"
```

---

### Task 5: write:true file-edit proof + extend the real-backend e2e

**Files:**
- Modify: `docs/repro-mcp-hang/e2e-real.mjs` (add claude coverage)

**Interfaces:**
- Consumes: the full `ClaudeCodeSession` (Tasks 2-4).
- Produces: claude scenarios in the canonical e2e suite — dispatch, a turn, write:true real edit, abort+settle.

- [ ] **Step 1: Write the failing assertions**

In `docs/repro-mcp-hang/e2e-real.mjs`, extend the doctor gate to also detect claude (do NOT make claude mandatory — keep the suite runnable where only omp/codex exist). Add after the existing `cdxOk` line:

```js
  const claudeOk = /claude:\s*ok/i.test(docText);
  console.log(`[info] claude backend: ${claudeOk ? "ok" : "absent (claude scenarios will be skipped)"}`);
```

Then add a claude block before the final "9. close all" section:

```js
  // 8b. claude backend (only when present) — dispatch, a turn, write:true edit, abort+settle.
  if (claudeOk) {
    const oCl = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
    const clId = oCl.session?.id;
    check("open claude (registry dispatch)", oCl.session?.agent === "claude" && !!clId, clId);
    const clTurn = await call("agent_bridge_send_message", { session_id: clId, message: "Reply with exactly: E2E_CLAUDE_1", wait: true, timeout_ms: 120000 }, 140000);
    check("claude turn (async result)", (clTurn.text || "").includes("E2E_CLAUDE_1"), (clTurn.text || "").slice(0, 40));

    // abort: long turn non-blocking, abort, confirm idle + reusable
    await call("agent_bridge_send_message", { session_id: clId, message: "Count slowly from 1 to 400, one number per line.", wait: false });
    await sleep(2500);
    const clAb = await call("agent_bridge_abort", { session_id: clId });
    check("claude abort accepted", clAb.aborted === true, JSON.stringify(clAb).slice(0, 50));
    await sleep(1500);
    const clSt = await call("agent_bridge_status", { session_id: clId });
    check("claude settles to idle after abort", clSt.session?.status === "idle", clSt.session?.status);
    await call("agent_bridge_close_session", { session_id: clId });

    // write:true — fresh temp dir, create a file, verify on disk, clean up (mirrors step 7).
    const ctmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-e2e-claude-write-"));
    let cwId = null;
    try {
      const oCW = await call("agent_bridge_open_session", { agent: "claude", cwd: ctmp, write: true });
      cwId = oCW.session?.id;
      check("open claude write:true (temp dir)", oCW.session?.write === true && !!cwId, cwId);
      await call("agent_bridge_send_message", { session_id: cwId, message: "Create a file named e2e_claude.txt whose entire contents are exactly the line: E2E_CLAUDE_WRITE_OK — then reply DONE.", wait: true, timeout_ms: 150000 }, 170000);
      const ctarget = path.join(ctmp, "e2e_claude.txt");
      const cwrote = fs.existsSync(ctarget) && fs.readFileSync(ctarget, "utf8").includes("E2E_CLAUDE_WRITE_OK");
      check("claude write:true edited a file on disk", cwrote, cwrote ? "ok" : "file not created");
    } finally {
      if (cwId) { try { await call("agent_bridge_close_session", { session_id: cwId }); } catch {} }
      let cErr = null;
      for (let i = 0; i < 40 && fs.existsSync(ctmp); i++) { try { fs.rmSync(ctmp, { recursive: true, force: true }); break; } catch (e) { cErr = e; await sleep(250); } }
      check("claude temp dir cleaned up", !fs.existsSync(ctmp), fs.existsSync(ctmp) ? `LEAKED ${ctmp} (${cErr?.code || "unknown"})` : "");
    }
  }
```

- [ ] **Step 2: Run test to verify it fails first, then passes**

Run: `node docs/repro-mcp-hang/e2e-real.mjs`
Expected (before this task's code on a machine WITH claude): the new claude `check(...)` lines would FAIL/throw. After Step 1's additions: PASS — all claude checks green (and the whole suite still SKIPs cleanly where omp/codex are absent).

- [ ] **Step 3: Commit**

```bash
git add docs/repro-mcp-hang/e2e-real.mjs
git commit -m "test(claude): cover claude backend in real-backend e2e (turn, abort, write:true)"
```

---

### Task 6: Documentation + version bump

**Files:**
- Modify: `README.md` (Requirements, doctor, Backends, Usage `agent` enum)
- Modify: `skills/agent-bridge/SKILL.md` (mention the `claude` backend)
- Modify: `scripts/agent-bridge.mjs` (`BRIDGE_VERSION` bump)

**Interfaces:**
- Consumes: nothing (docs).
- Produces: user-facing docs that list `claude` as a backend.

- [ ] **Step 1: Bump the version**

In `scripts/agent-bridge.mjs`, change `const BRIDGE_VERSION = "0.8.7";` to `const BRIDGE_VERSION = "0.9.0";`.

- [ ] **Step 2: Update README Backends section**

In `README.md`, under `## Backends`, add a third bullet:

```markdown
- **`claude`** — persistent Claude Code headless stream-json (`claude --print --input-format stream-json --output-format stream-json`). Read-only uses `--permission-mode default` with a read-only tool allowlist (`Read,Glob,Grep,Bash,WebFetch,WebSearch`); write uses `--permission-mode bypassPermissions`. Always launched with `--strict-mcp-config` so a delegated Claude loads project context (CLAUDE.md/skills) but **no MCP servers** — preventing nested delegation. `effort` is not supported by Claude Code and is ignored. Override the binary with `CLAUDE_BIN`.
```

Also update the Requirements/`doctor`/Usage references from "**`omp`** and/or **`codex`**" to include claude, and the `open_session` usage line `agent: "omp"` / `"codex"` to mention `"claude"`.

- [ ] **Step 3: Update SKILL.md**

In `skills/agent-bridge/SKILL.md`, wherever backends are enumerated (omp/codex), add `claude` with a one-line note: "`claude` — a fresh-context Claude Code worker; good for an independent second opinion / review or an isolated write workspace."

- [ ] **Step 4: Verify docs build / doctor**

Run: `node scripts/agent-bridge.mjs doctor`
Expected: prints `Agent Bridge 0.9.0` and a `claude:` line.

- [ ] **Step 5: Commit**

```bash
git add README.md skills/agent-bridge/SKILL.md scripts/agent-bridge.mjs
git commit -m "docs(claude): document claude backend; bump to v0.9.0"
```

---

## Self-Review

**Spec coverage:**
- §3 approach A (CLI stream-json, no SDK) → Tasks 2-4. ✓
- §4 contract methods (start/send/result/isSettled/refreshStatus/abort/close/summary) → Tasks 2-4. ✓
- §4.1 registry entry → Task 1. ✓
- §5 base args + `--strict-mcp-config` + model + write/read permission mapping + effort ignored → Task 2 `#buildArgs`. ✓
- §6 protocol frames (input shape, result boundary, final text from result.result, noise events) → Task 3 `#handleLine`/`#handleResult`. ✓
- §7 abort via control_request interrupt, session reusable → Task 4 (empirically locked; the spec's "open item" §11 was resolved before planning). ✓
- §8 doctor/cleanup/Windows automatic → Task 1 (registry) + verified native-exe spawn. ✓
- §9 testing (e2e + turn-state + abort repros) → per-task probes + Task 5 e2e. ✓
- §10 out-of-scope (SDK, partial-message streaming, effort mapping) → honored. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only forward reference (Task 3's `send`/`#handleLine` calling Task 4's `abort`/`#handleControlResponse`) is explicitly explained and resolved within the same plan. ✓

**Type consistency:** Field/method names consistent across tasks — `this.turn` is `{resolve,reject,promise,settled}` everywhere; `#settleTurn(err,status)`, `#beginTurn(turnId)`, `#buildArgs()`, `#control(subtype)`, `#handleControlResponse(msg)`, `interrupting`, `controlPending`, `finalAnswer`, `claudeSessionId` used identically in every reference. `result.result` (string) → `finalAnswer` → `result()` chain is consistent. ✓
