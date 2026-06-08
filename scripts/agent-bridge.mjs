#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const IS_WINDOWS = process.platform === "win32";

const BRIDGE_VERSION = "0.7.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_TEXT = 400_000;
const STATE_ROOT = process.env.AGENT_BRIDGE_STATE_DIR || path.join(os.homedir(), ".agent-bridge");
const LOG_DIR = path.join(STATE_ROOT, "logs");
const PID_DIR = path.join(STATE_ROOT, "pids");
const LOG_RETENTION_DAYS = Number(process.env.AGENT_BRIDGE_LOG_RETENTION_DAYS ?? 7);
const LOG_MAX_BYTES = Number(process.env.AGENT_BRIDGE_LOG_MAX_MB ?? 500) * 1024 * 1024;
const LOG_FILE_MAX_BYTES = Number(process.env.AGENT_BRIDGE_LOG_FILE_MAX_MB ?? 200) * 1024 * 1024;
const LOG_PRUNE_INTERVAL_MS = Number(process.env.AGENT_BRIDGE_LOG_PRUNE_INTERVAL_MIN ?? 30) * 60_000;

const AGENTS = {
  omp: {
    label: "Oh My Pi",
    env: "OMP_BIN",
    bin: "omp",
  },
  codex: {
    label: "Codex",
    env: "CODEX_BIN",
    bin: "codex",
  },
};

const sessions = new Map();
let processHandlersInstalled = false;
let shuttingDown = false;
// Per-process log directory: each MCP server gets logs/<runId>/ so concurrent servers never
// prune each other's files. Set in serveMcp(); defaults to the base LOG_DIR for one-shot CLI
// commands (doctor/cleanup) that never open sessions.
let RUN_LOG_DIR = LOG_DIR;

const TOOLS = [
  {
    name: "agent_bridge_open_session",
    description:
      "Open a persistent delegated-agent session. OMP uses its JSONL RPC mode; Codex drives a persistent codex app-server over JSON-RPC. Use this before sending messages.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["omp", "codex"], description: "Agent backend to open: omp or codex." },
        cwd: { type: "string", description: "Absolute workspace directory for the delegated agent." },
        write: {
          type: "boolean",
          default: false,
          description: "Allow delegated file edits. Default false. Enable only when the user explicitly wants edits.",
        },
        model: { type: "string", description: "Optional model selector for the delegated agent." },
        effort: {
          type: "string",
          description:
            "Optional reasoning effort. OMP maps it to --thinking (minimal|low|medium|high|xhigh). Codex sends it as the turn effort (none|minimal|low|medium|high|xhigh).",
        },
        initial_prompt: { type: "string", description: "Optional first message to send after opening." },
        wait: {
          type: "boolean",
          default: false,
          description: "When initial_prompt is provided, wait for that turn to finish before returning.",
        },
        timeout_ms: { type: "number", description: "Optional wait timeout in milliseconds." },
      },
      required: ["agent", "cwd"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_send_message",
    description:
      "Send a message to an existing persistent delegated-agent session. Returns immediately with an ack by default (non-blocking) so you stay responsive; join the result with agent_bridge_wait, using a short timeout_ms (e.g. 5-10 min) to check progress without dead-waiting. Pass wait=true to block inline until the turn completes and return its result.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id returned by agent_bridge_open_session." },
        message: { type: "string", description: "Message to send into the delegated agent session." },
        wait: {
          type: "boolean",
          default: false,
          description:
            "Default false: return immediately with an ack, then join via agent_bridge_wait (recommended with a short timeout_ms so you can poll progress instead of dead-waiting). Pass true to block until the turn completes and return its result inline.",
        },
        timeout_ms: { type: "number", description: "Optional wait timeout in milliseconds." },
        max_chars: {
          type: "number",
          description:
            "Optional cap (characters) on the inline result text when wait=true. If the answer is longer, text is truncated, truncated:true is set, and the full answer stays retrievable via textRef. charCount/byteCount are always reported.",
        },
      },
      required: ["session_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_status",
    description: "Inspect a persistent delegated-agent session, including streaming state and recent events. Omit session_id to list all sessions this server is managing.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional session id. If omitted, lists sessions." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_result",
    description:
      "Read the latest assistant result and recent raw events/logs from a persistent delegated-agent session. The result always reports charCount/byteCount; the full untruncated answer is written to textRef. Pass max_chars to cap the inline text (sets truncated:true) while keeping the full answer retrievable via textRef.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id returned by agent_bridge_open_session." },
        max_chars: {
          type: "number",
          description:
            "Optional cap (characters) on the inline result text. If the answer is longer, text is truncated, truncated:true is set, and the full answer stays retrievable via textRef.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_wait",
    description:
      "Block until delegated-agent sessions finish their current turn, then return their results. Use after " +
      'sending with wait=false to several sessions. mode "all" returns once every listed session is done; mode ' +
      '"any" returns as soon as the first finishes (call again with the remaining ids to handle each as it ' +
      "completes). One blocking call replaces polling agent_bridge_status in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        session_ids: {
          type: "array",
          items: { type: "string" },
          description: 'Session ids to wait on. For mode "any", pass only the still-running ids on each call.',
        },
        mode: {
          type: "string",
          enum: ["all", "any"],
          default: "all",
          description: '"all": return when every session is done. "any": return when the first one is done.',
        },
        timeout_ms: { type: "number", description: "Optional overall wait timeout in milliseconds." },
        max_chars: {
          type: "number",
          description:
            "Optional cap (characters) on each returned result's text. Longer answers are truncated with truncated:true and stay retrievable via textRef. charCount/byteCount are always reported.",
        },
      },
      required: ["session_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_abort",
    description: "Abort the active turn in a persistent delegated-agent session without closing the session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id returned by agent_bridge_open_session." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_close_session",
    description: "Close a persistent delegated-agent session and stop its backend process.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id returned by agent_bridge_open_session." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_doctor",
    description: "Check whether OMP, Codex, and Node are available for Agent Bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function usage() {
  return [
    "Usage:",
    "  agent-bridge mcp                 Run the MCP server (stdio). Sessions live in this process.",
    "  agent-bridge doctor [--json]     Report environment / backend availability.",
    "  agent-bridge cleanup [--json]    Reap orphaned omp/codex children from dead MCP servers.",
    "",
    "Sessions are managed exclusively through the MCP server's tools (open/send/status/result/",
    "wait/abort/close). The CLI exposes only the server entrypoint plus doctor/cleanup helpers.",
  ].join("\n");
}

function ensureDirs() {
  fs.mkdirSync(RUN_LOG_DIR, { recursive: true });
  fs.mkdirSync(PID_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertAgent(agent) {
  if (!AGENTS[agent]) throw new Error(`Unsupported agent "${agent}". Use omp or codex.`);
}

function assertCwd(cwd) {
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required.");
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved)) throw new Error(`cwd does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
  return resolved;
}

function agentBin(agent) {
  const config = AGENTS[agent];
  return process.env[config.env] || config.bin;
}

// Resolve `bin` to a concrete file by searching PATH and trying each PATHEXT extension in order (so a
// native .exe wins over a .cmd in the same directory, under the default PATHEXT). PATH only — we do
// not resolve against the current directory. Returns the resolved path, or null if nothing matched.
function resolveWindowsExecutable(bin) {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map(e => e.trim()).filter(Boolean);
  const lower = bin.toLowerCase();
  const hasKnownExt = exts.some(e => lower.endsWith(e.toLowerCase()));
  const asFile = p => {
    try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
  };
  if (path.isAbsolute(bin) || bin.includes("\\") || bin.includes("/")) {
    if (hasKnownExt) return asFile(bin);
    for (const e of exts) { const f = asFile(bin + e); if (f) return f; }
    return null;
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (hasKnownExt) { const f = asFile(path.join(dir, bin)); if (f) return f; }
    else { for (const e of exts) { const f = asFile(path.join(dir, bin + e)); if (f) return f; } }
  }
  return null;
}

// Decide how to spawn `bin args`. POSIX spawns directly. On Windows, Node cannot launch a .cmd/.bat
// without a shell — but routing a real .exe through cmd.exe is unnecessary and unsafe (cmd.exe
// re-parses every argument, so a metacharacter in a value like --model becomes command injection).
// So resolve the real target: spawn native executables DIRECTLY (clean argv array, no shell, no
// injection) and only run genuine .cmd/.bat through cmd.exe. Callers must NOT pass shell:true.
function spawnPlan(bin, args) {
  if (!IS_WINDOWS) return { command: bin, args };
  const resolved = resolveWindowsExecutable(bin);
  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    // Batch shim: must go through cmd.exe. Node MSVCRT-quotes argv entries with spaces; a resolved
    // path with cmd metacharacters (& | ^ etc.) is unsupported, but real install paths never use them.
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", resolved, ...args] };
  }
  // Native executable, or an unresolved bare name (fall through so the OS reports ENOENT cleanly).
  return { command: resolved || bin, args };
}

// Reject shell/CLI-hostile characters in pass-through agent arguments (OMP --model / --thinking).
// Defense in depth: the default backends resolve to executables we spawn without a shell, but a
// .cmd-based OMP_BIN would route these through cmd.exe, and a metacharacter must never reach a
// command line. Real model/effort names only use this character set.
function sanitizeAgentArg(value, label) {
  if (value == null) return null;
  const str = String(value);
  if (!/^[A-Za-z0-9._:\/@+-]+$/.test(str)) {
    throw new Error(`Invalid ${label} "${str}": only letters, digits, and . _ : / @ + - are allowed.`);
  }
  return str;
}

// Per-file byte counters so a live session's log can be rotated once it exceeds LOG_FILE_MAX_BYTES.
// pruneLogs() never touches files of active sessions, so without rotation a chatty, long-lived
// session's .log would grow unbounded. Rotation keeps at most the current file plus one ".1"
// generation (still a *.log name, so pruneLogs reaps it under the age/total caps).
const logBytesWritten = new Map();
function appendLog(file, text) {
  if (!file || !text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (LOG_FILE_MAX_BYTES > 0) {
    const bytes = Buffer.byteLength(text, "utf8");
    let written = logBytesWritten.get(file) || 0;
    if (written > 0 && written + bytes > LOG_FILE_MAX_BYTES) {
      try {
        fs.renameSync(file, file.replace(/(\.[^.\\/]+)$/, ".1$1")); // foo.log -> foo.1.log
      } catch {}
      written = 0;
    }
    logBytesWritten.set(file, written + bytes);
  }
  fs.appendFileSync(file, text, "utf8");
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function clampText(text, max = MAX_TEXT) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function pushEvent(session, event) {
  const record = { at: nowIso(), event };
  session.updatedAt = record.at;
  session.events.push(record);
  while (session.events.length > MAX_EVENTS) session.events.shift();
}

function setSessionStatus(session, status, isStreaming = session.isStreaming, extra = {}) {
  const nextStreaming = Boolean(isStreaming);
  const changed = session.status !== status || session.isStreaming !== nextStreaming;
  session.status = status;
  session.isStreaming = nextStreaming;
  session.updatedAt = nowIso();
  if (changed || extra.force) {
    pushEvent(session, { type: "status", status, isStreaming: nextStreaming, ...extra });
  }
}

function compactEvent(event) {
  return compactValue(event);
}

function compactValue(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value)) return value.map(item => compactValue(item, depth + 1));

  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = compactValue(child, depth + 1);
  }
  return copy;
}

// Per-token / heartbeat event types that carry no actionable signal for the orchestrating
// model — only "tokens streamed", which the session's isStreaming/status already convey.
// Dropping them keeps recentEvents a meaningful lifecycle trail instead of a wall of deltas.
const NOISE_EVENT_TYPES = new Set([
  "message_update", // OMP re-serializes the whole assistant message on every token
  "item/agentMessage/delta", // Codex per-token delta
  "message_start", // OMP message decode boundary — turn_start/turn_end already frame the turn
  "message_end",
  "extension_ui_request", // OMP extension UI plumbing — irrelevant when driven over RPC
  "account/rateLimits/updated",
  "thread/tokenUsage/updated",
]);

// Compact projection of recent events for tool results: just the type/status, not the full
// message/usage/thinking snapshots (those bloat the caller's context — see result()). Drops
// high-frequency streaming noise and collapses consecutive same-type events into a count, so
// the orchestrator sees turn/tool/error lifecycle, not hundreds of identical delta lines.
function slimEvents(events, limit = 12) {
  const out = [];
  for (const record of events) {
    const ev = record.event || {};
    const type = ev.type || ev.method || ev.kind || "event";
    if (NOISE_EVENT_TYPES.has(type)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.type === type && !ev.status && !ev.source) {
      prev.count = (prev.count || 1) + 1;
      prev.at = record.at;
      continue;
    }
    const item = { at: record.at, type };
    if (ev.status) item.status = ev.status;
    if (ev.source) item.source = ev.source;
    out.push(item);
  }
  return out.slice(-limit);
}

// Turn-level timing/id, surfaced uniformly across backends (omp mints a bridge-side turn id;
// codex reuses the app-server's). Null until a turn has been sent. Lets consumers profile a
// turn and confirm *which* turn a result belongs to without backend-specific plumbing.
function lastTurnOf(session) {
  if (!session.lastTurnId && !session.turnStartedAt) return null;
  const startedAt = session.turnStartedAt || null;
  const endedAt = session.turnEndedAt || null;
  const durationMs = startedAt && endedAt ? new Date(endedAt) - new Date(startedAt) : null;
  return { id: session.lastTurnId || null, startedAt, endedAt, durationMs };
}

// Build the result payload shared by result()/wait()/send(wait). The assistant `text` is
// must-read content, so it is never silently dropped: charCount/byteCount are always reported
// (the "compass needle"), and the full untruncated answer is persisted to an artifact that
// `textRef` points at — so a caller who caps inline size with `max_chars` can always retrieve
// the whole thing. Without max_chars the full text comes back inline (current behavior).
function buildSessionResult(session, fullText, options = {}) {
  const text = String(fullText ?? "");
  const charCount = text.length;
  const byteCount = Buffer.byteLength(text, "utf8");
  let textRef = null;
  if (text) {
    try {
      fs.writeFileSync(session.answerFile, text, "utf8");
      textRef = session.answerFile;
    } catch {}
  }
  const max = parseNumber(options.maxChars, undefined);
  // Only truncate when the full answer is actually retrievable (artifact written). If the
  // write failed, return the full text inline rather than silently dropping must-read content.
  const truncated = Boolean(max && max > 0 && charCount > max && textRef);
  return {
    session: session.summary(),
    text: (truncated ? text.slice(0, max) : text) || null,
    charCount,
    byteCount,
    truncated,
    textRef,
    recentEvents: slimEvents(session.events),
    // logFile is intentionally NOT repeated here — it already lives in session.logFile above.
  };
}

// Remove model thinking/reasoning content before logging an event (keeps the answer, tool calls,
// and structure; drops the chain-of-thought from disk).
function stripThinking(value, depth = 0) {
  if (!value || typeof value !== "object" || depth >= 10) return value;
  if (Array.isArray(value)) {
    return value
      .filter(item => !(item && typeof item === "object" && item.type === "thinking"))
      .map(item => stripThinking(item, depth + 1));
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "thinking" || key === "reasoning_content" || key === "thinkingSignature") continue;
    out[key] = stripThinking(child, depth + 1);
  }
  return out;
}

function shellQuote(value) {
  const s = String(value);
  if (/^[a-zA-Z0-9_./:=,+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function pidRecordPath(id) {
  return path.join(PID_DIR, `${id}.json`);
}

function writePidRecord(file, record) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...record, updatedAt: nowIso() }, null, 2)}\n`, "utf8");
}

function removePidRecord(file) {
  try {
    if (file) fs.rmSync(file, { force: true });
  } catch {}
}

// POSIX-only helper for terminateProcessTree's recursive kill; on Windows that path uses taskkill /T.
function listChildPids(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 1);
}

// Windows has no `ps`. Snapshot every process's command line via one CIM query, cached for the
// duration of a SINGLE cleanup/reclaim sweep. Callers reset it (resetWinProcessSnapshot) at the
// start of each sweep so the periodic reclaim timer never reuses a stale snapshot — stale data would
// otherwise mislead PID-reuse checks. winSnapshotValid records whether the query actually succeeded,
// so a probe failure is not mistaken for "process gone".
let winCommandSnapshot = null;
let winSnapshotValid = false;
function resetWinProcessSnapshot() {
  winCommandSnapshot = null;
  winSnapshotValid = false;
}
function winProcessSnapshot() {
  if (winCommandSnapshot) return winCommandSnapshot;
  winCommandSnapshot = new Map();
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout) {
    winSnapshotValid = true;
    for (const line of result.stdout.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const pid = Number(line.slice(0, tab));
      if (Number.isInteger(pid)) winCommandSnapshot.set(pid, line.slice(tab + 1).trim());
    }
  }
  return winCommandSnapshot;
}

// Returns the process command line, "" if the process is gone, or null if the probe itself is
// UNAVAILABLE (Windows CIM query failed, or POSIX `ps` could not be spawned). Callers must treat
// null as "unknown" — never as "process gone" — so a broken probe can't trigger reaping/deletion.
function processCommand(pid) {
  if (IS_WINDOWS) {
    winProcessSnapshot();
    if (!winSnapshotValid) return null;
    return winCommandSnapshot.get(Number(pid)) || "";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.error) return null; // `ps` not spawnable -> unknown, not "gone"
  if (result.status !== 0) return ""; // `ps` ran, pid not found
  return stripAnsi(result.stdout || "").trim();
}

function roleMatchesCommand(role, command) {
  if (!command) return false;
  if (role === "omp-rpc") return /\bomp\b/.test(command) && /--mode\s+rpc|--mode.*\brpc\b/.test(command);
  if (role === "codex-app-server") return /\bcodex\b/.test(command) && /\bapp-server\b/.test(command);
  return false;
}

function ownerStillRunning(record) {
  const ownerPid = Number(record?.ownerPid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || ownerPid === process.pid) return false;
  const command = processCommand(ownerPid);
  // A null command means the process probe was unavailable (not that the owner is gone). Assume the
  // owner is still alive so a failed probe can never make us reap pid records or delete live log dirs.
  if (command === null) return true;
  // Windows command lines carry a full, often-quoted node.exe path ("C:\...\node.exe"); the POSIX
  // anchored form would never match, so detect node with a separator-aware test there instead.
  const argv0LooksLikeNode = IS_WINDOWS
    ? /(?:^|[\\/"\s])node(?:\.exe)?(?:["\s]|$)/i.test(command)
    : /^(?:\S*\/)?node(?:\s|$)/.test(command);
  return argv0LooksLikeNode && /agent-bridge\.mjs/.test(command) && /\bmcp\b/.test(command);
}

function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (IS_WINDOWS) {
    // taskkill /T terminates the whole process tree. The agent may sit under a cmd.exe wrapper (for
    // .cmd shims) or spawn its own children, so killing only the root would orphan them. /F maps to
    // the forceful SIGKILL backstop; the graceful attempt omits it. Exit code 128 ("process not
    // found") means the tree is already gone — treat that as success.
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const result = spawnSync("taskkill", args, { encoding: "utf8", windowsHide: true });
    return result.status === 0 || result.status === 128;
  }
  for (const childPid of listChildPids(pid)) terminateProcessTree(childPid, signal);
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function scheduleForceKill(pid, graceMs = 3000) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const timer = setTimeout(() => {
    try {
      process.kill(pid, 0);
    } catch {
      return; // already exited
    }
    terminateProcessTree(pid, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}

// Log/answer files belonging to live sessions. pruneLogs must never remove a file that may still
// be appended to. A file is safe to prune only when its backend process is truly gone: the
// session was explicitly closed, or the child has exited. Status alone is NOT enough — Codex
// sets status="failed" on a turn error WITHOUT killing the app-server, and send() will happily
// reuse that session (writing more to the same log), so a failed-but-alive session must stay
// protected. A session in "starting" has no proc yet (proc undefined) → treated as alive.
// "Exited" must cover signal death too: a SIGKILLed child has exitCode === null but signalCode set.
function activeLogPaths() {
  const set = new Set();
  for (const session of sessions.values()) {
    const procExited = session.proc && (session.proc.exitCode !== null || session.proc.signalCode !== null);
    if (session.status === "closed" || procExited) continue;
    if (session.logFile) set.add(session.logFile);
    if (session.answerFile) set.add(session.answerFile);
  }
  return set;
}

// Bound on-disk logs in three passes: (1) drop files older than the retention window, (2) drop
// any single file over the per-file cap, (3) trim oldest-first until under the total-size cap.
// Files belonging to live sessions (activePaths) are never touched. Scoped to THIS process's
// run dir (RUN_LOG_DIR), so concurrent MCP servers never prune each other's files; bridge.log
// is always kept. Runs periodically while the server is alive (see serveMcp). Configure via
// AGENT_BRIDGE_LOG_RETENTION_DAYS / AGENT_BRIDGE_LOG_FILE_MAX_MB / AGENT_BRIDGE_LOG_MAX_MB
// (set any to 0 to disable that limit).
function pruneLogs(activePaths = new Set()) {
  let names;
  try {
    names = fs.readdirSync(RUN_LOG_DIR).filter(n => (n.endsWith(".log") || n.endsWith(".answer.txt")) && n !== "bridge.log");
  } catch {
    return { removed: 0, freedBytes: 0 };
  }
  const maxAgeMs = LOG_RETENTION_DAYS > 0 ? LOG_RETENTION_DAYS * 86_400_000 : Infinity;
  const maxBytes = LOG_MAX_BYTES > 0 ? LOG_MAX_BYTES : Infinity;
  const maxFileBytes = LOG_FILE_MAX_BYTES > 0 ? LOG_FILE_MAX_BYTES : Infinity;
  const now = Date.now();
  const entries = [];
  for (const name of names) {
    const file = path.join(RUN_LOG_DIR, name);
    if (activePaths.has(file)) continue; // in use by a live session — leave it alone
    try {
      const st = fs.statSync(file);
      entries.push({ file, mtime: st.mtimeMs, size: st.size, removed: false });
    } catch {}
  }
  let removed = 0;
  let freedBytes = 0;
  const remove = entry => {
    try {
      fs.rmSync(entry.file, { force: true });
      entry.removed = true;
      removed += 1;
      freedBytes += entry.size;
    } catch {}
  };
  for (const entry of entries) {
    if (now - entry.mtime > maxAgeMs) remove(entry);
  }
  for (const entry of entries) {
    if (!entry.removed && entry.size > maxFileBytes) remove(entry);
  }
  const live = entries.filter(e => !e.removed).sort((a, b) => a.mtime - b.mtime);
  let total = live.reduce((n, e) => n + e.size, 0);
  for (const entry of live) {
    if (total <= maxBytes) break;
    remove(entry);
    total -= entry.size;
  }
  return { removed, freedBytes };
}

// Reclaim leftover run dirs from servers that did not exit cleanly. A clean exit removes its own
// logs/<runId>/, but a hard exit (uncaughtException, SIGKILL, OOM, power loss) leaves it behind,
// and the periodic prune only scopes to the CURRENT run — so without this, logs/mcp-*/ dirs pile
// up forever. Each run dir carries an "owner" file with the server's pid; remove any whose owner
// is gone. Never touch a dir a live MCP still owns, our own run, or an owner-less brand-new dir
// (a server that may still be writing its owner file).
function reclaimStaleLogs() {
  resetWinProcessSnapshot(); // fresh process snapshot per sweep (this also runs on a periodic timer)
  let entries;
  try {
    entries = fs.readdirSync(LOG_DIR, { withFileTypes: true });
  } catch {
    return { runDirsRemoved: 0, freedBytes: 0 };
  }
  let runDirsRemoved = 0;
  let freedBytes = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith("mcp-")) continue;
    const dir = path.join(LOG_DIR, ent.name);
    if (dir === RUN_LOG_DIR) continue; // our own run
    let ownerPid = null;
    try {
      ownerPid = Number(fs.readFileSync(path.join(dir, "owner"), "utf8").trim()) || null;
    } catch {}
    if (ownerPid && ownerStillRunning({ ownerPid })) continue; // a live MCP still owns it
    if (!ownerPid) {
      // No owner tag — could be a server still starting up. Only reclaim once it's clearly old.
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {}
      if (Date.now() - mtimeMs < 60_000) continue;
    }
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          freedBytes += fs.statSync(path.join(dir, f)).size;
        } catch {}
      }
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      runDirsRemoved += 1;
    } catch {}
  }
  return { runDirsRemoved, freedBytes };
}

function cleanupStalePidRecords() {
  ensureDirs();
  resetWinProcessSnapshot(); // fresh process snapshot per sweep
  const summary = {
    records: 0,
    removed: 0,
    skippedRunningOwners: 0,
    skippedProbeFailures: 0,
    terminated: [],
  };
  for (const name of fs.readdirSync(PID_DIR)) {
    if (!name.endsWith(".json")) continue;
    summary.records += 1;
    const file = path.join(PID_DIR, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      removePidRecord(file);
      summary.removed += 1;
      continue;
    }
    if (ownerStillRunning(record)) {
      summary.skippedRunningOwners += 1;
      continue;
    }

    const processes = Array.isArray(record.processes) ? record.processes : [];
    let unreapableOrphan = false;
    for (const child of processes) {
      const pid = Number(child.pid);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      const command = processCommand(pid);
      if (roleMatchesCommand(child.role, command)) {
        // Confirmed orphan: owner is gone and the live command line still matches the role. Try a
        // graceful kill, then schedule a SIGKILL backstop (it fires on a long-running server). If the
        // graceful pass fails, force-kill synchronously — the `cleanup` CLI exits immediately, so the
        // unref'd backstop timer would never fire there.
        if (terminateProcessTree(pid)) {
          scheduleForceKill(pid);
          summary.terminated.push({ pid, role: child.role, command });
        } else if (terminateProcessTree(pid, "SIGKILL")) {
          summary.terminated.push({ pid, role: child.role, command });
        } else {
          unreapableOrphan = true;
        }
      }
    }
    // Preserve the record (retry next sweep) if our Windows process probe ran but failed — an empty
    // command map would otherwise look like "all processes gone" and drop the only handle to a leak.
    if (IS_WINDOWS && winCommandSnapshot != null && !winSnapshotValid) {
      summary.skippedProbeFailures += 1;
      continue;
    }
    if (unreapableOrphan) continue; // a matched orphan resisted termination; keep the record to retry
    removePidRecord(file);
    summary.removed += 1;
  }
  return summary;
}

class OmpRpcSession {
  constructor(options) {
    this.id = makeId("omp");
    this.agent = "omp";
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);
    // OMP passes these on the command line (--model / --thinking), so sanitize at the source.
    this.model = sanitizeAgentArg(options.model, "model");
    this.effort = sanitizeAgentArg(options.effort, "effort");
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    // Set true once the current turn is observed actually streaming (agent_start /
    // stream deltas / a live isStreaming reading); waitIdle won't accept the idle
    // window that exists *before* a freshly-sent prompt starts.
    this.turnStarted = false;
    this.sessionState = null;
    this.currentTurnId = null;
    this.lastTurnId = null;
    this.turnStartedAt = null;
    this.turnEndedAt = null;
    this.events = [];
    this.pending = new Map();
    this.requestCounter = 0;
    this.logFile = path.join(RUN_LOG_DIR, `${this.id}.log`);
    this.answerFile = path.join(RUN_LOG_DIR, `${this.id}.answer.txt`);
    this.pidFile = pidRecordPath(this.id);
    this.proc = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  async start() {
    const args = ["--mode", "rpc", "--no-title", "--no-extensions", "--no-rules"];
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--thinking", this.effort);
    if (this.write) {
      args.push("--auto-approve", "--approval-mode", "yolo");
    } else {
      args.push("--tools", "read,grep,find,lsp,web_search", "--approval-mode", "yolo");
    }

    appendLog(this.logFile, `$ ${[agentBin("omp"), ...args.map(shellQuote)].join(" ")}\n`);
    appendLog(
      this.logFile,
      `[agent-bridge] owner pid=${process.pid} ppid=${process.ppid} stdinTTY=${Boolean(process.stdin.isTTY)} stdoutTTY=${Boolean(process.stdout.isTTY)}\n`,
    );
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const plan = spawnPlan(agentBin("omp"), args);
    this.proc = spawn(plan.command, plan.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    appendLog(this.logFile, `[agent-bridge] spawned OMP pid=${this.proc.pid}\n`);
    this.#writePidRecord(args);

    this.proc.stdin.on("close", () => appendLog(this.logFile, "[agent-bridge] OMP stdin closed\n"));
    this.proc.stdout.on("close", () => appendLog(this.logFile, "[agent-bridge] OMP stdout closed\n"));
    this.proc.stderr.on("close", () => appendLog(this.logFile, "[agent-bridge] OMP stderr closed\n"));

    this.proc.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      appendLog(this.logFile, text);
      this.lastError = clampText(stripAnsi(text), 4000);
    });

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", line => this.#handleLine(line));

    this.proc.on("error", err => {
      this.lastError = err.message;
      if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
      setSessionStatus(this, "failed", false, { source: "process_error", error: err.message });
      this.readyReject?.(err);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });

    this.proc.on("close", (code, signal) => {
      appendLog(this.logFile, `[agent-bridge] OMP RPC exited code=${code} signal=${signal || ""}\n`);
      removePidRecord(this.pidFile);
      if (this.status === "closed") {
        setSessionStatus(this, "closed", false, { source: "process_close", code, signal });
        return;
      }
      if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
      this.lastError = code === 0 ? this.lastError : `OMP RPC exited with code ${code}`;
      setSessionStatus(this, code === 0 && this.status !== "failed" ? "closed" : "failed", false, {
        source: "process_close",
        code,
        signal,
      });
      this.readyReject?.(new Error(this.lastError || "OMP RPC exited before ready."));
      for (const pending of this.pending.values()) pending.reject(new Error(this.lastError || "OMP RPC exited."));
      this.pending.clear();
    });

    await withTimeout(this.readyPromise, 20000, "Timed out waiting for OMP RPC ready.");
    return this;
  }

  #writePidRecord(args) {
    writePidRecord(this.pidFile, {
      id: this.id,
      agent: this.agent,
      ownerPid: process.pid,
      cwd: this.cwd,
      createdAt: this.createdAt,
      processes: [
        {
          role: "omp-rpc",
          pid: this.proc?.pid || null,
          command: [agentBin("omp"), ...args],
        },
      ].filter(item => item.pid),
    });
  }

  #handleLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      appendLog(this.logFile, `${line}\n`);
      pushEvent(this, { type: "raw", line });
      return;
    }

    // Don't log noisy lines verbatim:
    // - message_update: OMP re-serializes the entire growing message on every delta, so logging
    //   each one is O(n^2) and produces multi-GB logs.
    // - get_state responses: waitIdle polls get_state every 750ms and each response is a ~112KB
    //   blob that is ~99% static (dumpTools + systemPrompt, identical across calls); logging it
    //   verbatim was the dominant OMP log-bloat source (single logs reaching ~1GB; see issue #1).
    // - get_last_assistant_text responses: result() fetches the full answer (up to MAX_TEXT) on
    //   every call; the answer already lands via turn_end/agent_end and in answerFile, so logging
    //   the response too is redundant and re-bloats on repeated result() polling.
    // Live state is still available via the get_state response object itself.
    const isMessageUpdate = message.type === "message_update";
    const isBulkResponse =
      message.type === "response" && (message.command === "get_state" || message.command === "get_last_assistant_text");
    if (!isMessageUpdate && !isBulkResponse) appendLog(this.logFile, `${JSON.stringify(stripThinking(message))}\n`);

    this.updatedAt = nowIso();
    if (message.type === "ready") {
      setSessionStatus(this, "idle", false, { source: "ready" });
      this.readyResolve?.();
      return;
    }

    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.success === false) pending.reject(new Error(message.error || "OMP RPC command failed."));
      else pending.resolve(message);
      return;
    }

    this.#applyEvent(message);
    pushEvent(this, compactEvent(message));
  }

  #applyEvent(message) {
    if (message.type === "agent_start" || message.type === "turn_start") {
      this.lastAssistantText = "";
      this.turnStarted = true;
      setSessionStatus(this, "running", true, { source: message.type });
      return;
    }
    if (message.type === "agent_end" || message.type === "turn_end") {
      this.turnEndedAt = nowIso();
      setSessionStatus(this, "idle", false, { source: message.type });
      return;
    }
    if (message.type === "message_update") {
      const update = message.assistantMessageEvent || message.message || message;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.lastAssistantText = clampText(this.lastAssistantText + update.delta);
      }
      if (typeof update?.text === "string") {
        this.lastAssistantText = clampText(update.text);
      }
    }
    if (message.type === "error" || message.type === "extension_error") {
      this.lastError = JSON.stringify(message);
    }
  }

  request(type, extra = {}) {
    const id = `req_${++this.requestCounter}`;
    const payload = { id, type, ...extra };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  async send(message, options = {}) {
    if (!message || !String(message).trim()) throw new Error("message is required.");
    if (this.status === "closed") throw new Error(`OMP session ${this.id} is closed.`);
    if (!this.proc || this.proc.exitCode !== null) throw new Error(`OMP process for ${this.id} is not running.`);
    // Reset before prompting so waitIdle below ignores the pre-streaming idle window
    // (a stale idle reading from before this turn actually starts).
    this.turnStarted = false;
    setSessionStatus(this, "running", true, { source: "send" });
    try {
      await this.request("prompt", { message: String(message) });
    } catch (err) {
      // Prompt was rejected; don't leave the session stuck at "running". If the backend is
      // still alive, return it to idle (a dead proc is handled by the close/error handlers).
      if (this.status !== "closed" && this.proc && this.proc.exitCode === null) {
        setSessionStatus(this, "idle", false, { source: "prompt_error" });
      }
      throw err;
    }
    // Prompt accepted — stamp the turn now. Doing this AFTER the ack means a failed prompt
    // leaves the previous turn's lastTurn coherent instead of half-overwriting it. OMP RPC
    // has no native turn id, so mint a bridge-side one (P6) and start the clock (P5).
    this.currentTurnId = makeId("turn");
    this.lastTurnId = this.currentTurnId;
    this.turnStartedAt = nowIso();
    this.turnEndedAt = null;
    if (options.wait) {
      try {
        await this.waitIdle(options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS);
      } catch (err) {
        // On wait timeout the OMP turn is still streaming; abort it so the session is
        // immediately reusable instead of rejecting the next send as "already processing".
        try {
          await this.abort();
        } catch {}
        throw err;
      }
      return await this.result({ maxChars: options.maxChars });
    }
    return { accepted: true, sessionId: this.id, status: this.status, turnId: this.currentTurnId };
  }

  async state() {
    const response = await this.request("get_state");
    this.sessionState = response.data || null;
    if (this.sessionState) {
      setSessionStatus(this, this.sessionState.isStreaming ? "running" : "idle", Boolean(this.sessionState.isStreaming), {
        source: "state",
      });
    }
    return this.sessionState;
  }

  async result(options = {}) {
    let text = this.lastAssistantText;
    try {
      const response = await this.request("get_last_assistant_text");
      if (response.data && typeof response.data.text === "string") text = response.data.text;
    } catch {
      // Keep accumulated stream text when the helper command is unavailable.
    }
    const full = text || this.lastAssistantText || "";
    this.lastAssistantText = clampText(full);
    // Hand buildSessionResult the UNCLAMPED text so the artifact/charCount reflect the true
    // full answer even past the internal MAX_TEXT clamp — must-read content is never lost.
    return buildSessionResult(this, full, options);
  }

  async abort() {
    await this.request("abort");
    // Only close the clock if a turn is actually in flight; aborting an idle session must
    // not stretch the previous turn's duration to now.
    if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
    setSessionStatus(this, "idle", false, { source: "abort" });
    return { aborted: true, sessionId: this.id };
  }

  async waitIdle(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(750);
      // If the process died, fail now instead of polling a dead pipe until timeout.
      if (!this.proc || this.proc.exitCode !== null) {
        throw new Error(`OMP process for ${this.id} exited (code ${this.proc?.exitCode ?? "?"}) before the turn completed.`);
      }
      try {
        const state = await this.state();
        const idle = !state?.isStreaming && !state?.queuedMessageCount;
        // Only accept idle once THIS turn has actually started, observed via the
        // agent_start event (turnStarted, reset at send). A live isStreaming reading is
        // not used to set turnStarted: it can reflect a prior aborted/queued turn still
        // streaming, which would let waitIdle return the previous turn's text early.
        if (idle && this.turnStarted) return;
      } catch {
        // state() failed. If the process died or the session failed/closed mid-poll, that
        // is a real error — don't let "turnStarted && !isStreaming" report it as a clean idle
        // (the close handler clears isStreaming on exit), which would return a half-done turn.
        if (!this.proc || this.proc.exitCode !== null || this.status === "failed" || this.status === "closed") {
          throw new Error(`OMP process for ${this.id} exited before the turn completed.`);
        }
        if (this.turnStarted && !this.isStreaming) return;
      }
    }
    throw new Error(`Timed out waiting for ${this.id} to become idle.`);
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
      // Backend-specific fields live here so the top-level shape is identical across agents
      // (P3). Empty until OMP reports state (after the first status poll / turn), so the old
      // always-null `sessionState` dead field is gone (P4).
      agentSpecific: this.sessionState
        ? {
            sessionId: this.sessionState.sessionId,
            messageCount: this.sessionState.messageCount,
            queuedMessageCount: this.sessionState.queuedMessageCount,
            model: this.sessionState.model?.id || this.sessionState.model?.name || (typeof this.sessionState.model === "string" ? this.sessionState.model : null),
          }
        : {},
    };
  }

  close(options = {}) {
    if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
    setSessionStatus(this, "closed", false, { source: "close" });
    // Reject any in-flight RPCs (send/state/result waiters) now: once status is "closed"
    // the proc "close" handler early-returns and won't reject them, so they'd hang forever.
    const err = new Error(`OMP session ${this.id} closed.`);
    this.readyReject?.(err);
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    try {
      this.proc?.stdin?.end();
    } catch {}
    const pid = this.proc?.pid;
    terminateProcessTree(pid);
    scheduleForceKill(pid);
    if (options.removePidRecord !== false) removePidRecord(this.pidFile);
    try {
      fs.rmSync(this.answerFile, { force: true });
    } catch {}
    return { closed: true, sessionId: this.id };
  }
}

class CodexAppServerSession {
  constructor(options) {
    this.id = makeId("codex");
    this.agent = "codex";
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);
    // Not sanitized like OMP: Codex receives model/effort over JSON-RPC, never on a command line.
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    this.events = [];
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.threadId = null;
    this.currentTurnId = null;
    this.lastTurnId = null;
    this.turnStartedAt = null;
    this.turnEndedAt = null;
    this.ignoredTurnIds = new Set();
    this.turn = null;
    this.turnCount = 0;
    this.finalAnswer = "";
    this.lastAgentMessage = "";
    this.tokenUsage = null;
    this.logFile = path.join(RUN_LOG_DIR, `${this.id}.log`);
    this.answerFile = path.join(RUN_LOG_DIR, `${this.id}.answer.txt`);
    this.pidFile = pidRecordPath(this.id);
  }

  async start() {
    const args = ["app-server"];
    appendLog(this.logFile, `$ ${[agentBin("codex"), ...args].join(" ")}\n`);
    const plan = spawnPlan(agentBin("codex"), args);
    this.proc = spawn(plan.command, plan.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    appendLog(this.logFile, `[agent-bridge] spawned codex app-server pid=${this.proc.pid}\n`);
    this.#writePidRecord();

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", text => {
      appendLog(this.logFile, text);
      this.lastError = clampText(stripAnsi(text), 4000);
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdin.on("error", err => {
      appendLog(this.logFile, `[agent-bridge] codex stdin error: ${err.message}\n`);
      this.lastError = err.message;
      // A broken stdin pipe means no request can be answered; fail outstanding work
      // instead of letting pending RPCs / the active turn wait forever. Skip during a
      // deliberate close() (status already "closed"), where end() naturally emits EPIPE.
      if (this.status !== "closed") {
        setSessionStatus(this, "failed", false, { source: "stdin_error", error: err.message });
        this.#rejectAll(err);
      }
    });
    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", line => this.#handleLine(line));

    this.proc.on("error", err => {
      this.lastError = err.message;
      setSessionStatus(this, "failed", false, { source: "process_error", error: err.message });
      this.#rejectAll(err);
    });
    this.proc.on("close", (code, signal) => {
      appendLog(this.logFile, `[agent-bridge] codex app-server exited code=${code} signal=${signal || ""}\n`);
      removePidRecord(this.pidFile);
      if (this.status === "closed") {
        setSessionStatus(this, "closed", false, { source: "process_close", code, signal });
        return;
      }
      this.lastError = code === 0 ? this.lastError : `codex app-server exited with code ${code}`;
      setSessionStatus(this, code === 0 && this.status !== "failed" ? "closed" : "failed", false, {
        source: "process_close",
        code,
        signal,
      });
      this.#rejectAll(new Error(this.lastError || "codex app-server exited."));
    });

    await withTimeout(
      this.#request("initialize", {
        clientInfo: { title: "Agent Bridge", name: "agent-bridge", version: BRIDGE_VERSION },
        capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
      }),
      20000,
      "Timed out on codex initialize.",
    );
    this.#notify("initialized", {});

    const started = await withTimeout(
      this.#request("thread/start", {
        cwd: this.cwd,
        model: this.model,
        approvalPolicy: "never",
        sandbox: this.write ? "workspace-write" : "read-only",
        serviceName: "agent_bridge",
        ephemeral: true,
        experimentalRawEvents: false,
      }),
      20000,
      "Timed out on codex thread/start.",
    );
    this.threadId = started?.thread?.id || started?.threadId || null;
    if (!this.threadId) throw new Error("codex thread/start returned no thread id");
    appendLog(this.logFile, `[agent-bridge] codex thread ${this.threadId}\n`);
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
      processes: [{ role: "codex-app-server", pid: this.proc?.pid || null, command: [agentBin("codex"), "app-server"] }].filter(
        item => item.pid,
      ),
    });
  }

  #write(msg) {
    appendLog(this.logFile, `> ${JSON.stringify(msg).slice(0, 600)}\n`);
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || this.proc.exitCode !== null) {
      throw new Error("codex app-server stdin is not writable");
    }
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  #request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.#write({ id, method, params });
    } catch (err) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(err);
    }
    return promise;
  }

  #notify(method, params = {}) {
    try {
      this.#write({ method, params });
    } catch (err) {
      appendLog(this.logFile, `[agent-bridge] codex notify failed: ${err.message}\n`);
    }
  }

  #rejectAll(err) {
    // Close the turn clock if a turn was in flight (process crash / stdin EPIPE / close),
    // so durationMs reflects the failed turn instead of staying null.
    if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    const turn = this.turn;
    this.turn = null;
    turn?.reject?.(err);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      appendLog(this.logFile, `${line}\n`);
      pushEvent(this, { type: "raw", line });
      return;
    }
    // Skip logging the high-frequency streaming delta notifications verbatim; the final
    // item/turn events (logged below) still capture the assembled output.
    if (msg.method !== "item/agentMessage/delta") appendLog(this.logFile, `${JSON.stringify(stripThinking(msg))}\n`);
    this.updatedAt = nowIso();
    if (msg.id !== undefined && msg.method) {
      // Server-initiated request: we do not implement any, so reject.
      this.#write({ id: msg.id, error: { code: -32601, message: "unsupported server request" } });
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || "codex error"), { rpc: msg.error }));
        else pending.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) this.#onNotification(msg);
  }

  #onNotification(msg) {
    const method = msg.method;
    const params = msg.params || {};
    const threadId = params.threadId ?? params.thread?.id ?? null;
    if (threadId && this.threadId && threadId !== this.threadId) {
      // Subagent / unrelated thread: keep for debug, do not drive our turn.
      pushEvent(this, compactEvent(msg));
      return;
    }
    // Events carry the turn they belong to; ignore ones from a turn that is no
    // longer current (an aborted/interrupted turn emitting trailing deltas or a
    // late turn/completed) so they cannot corrupt or prematurely settle a new turn.
    // `ignoredTurnIds` catches the post-abort window where currentTurnId is cleared
    // but the interrupted turn's id must still be rejected.
    const evTurnId = params.turn?.id ?? params.turnId ?? null;
    const staleTurn = Boolean(
      evTurnId && (this.ignoredTurnIds.has(evTurnId) || (this.currentTurnId && evTurnId !== this.currentTurnId)),
    );

    switch (method) {
      case "turn/started":
        if (staleTurn) {
          pushEvent(this, compactEvent(msg));
          return;
        }
        this.currentTurnId = params.turn?.id || this.currentTurnId;
        if (this.turn) setSessionStatus(this, "running", true, { source: "turn/started" });
        pushEvent(this, compactEvent(msg));
        return;
      case "item/agentMessage/delta":
        if (staleTurn) {
          pushEvent(this, compactEvent(msg));
          return;
        }
        if (typeof params.delta === "string") this.lastAssistantText = clampText(this.lastAssistantText + params.delta);
        pushEvent(this, compactEvent(msg));
        return;
      case "item/completed": {
        if (staleTurn) {
          pushEvent(this, { type: "item.completed", stale: true });
          return;
        }
        const item = params.item || {};
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
          this.lastAgentMessage = item.text;
          if (item.phase === "final_answer") this.finalAnswer = item.text;
        }
        // Strip large text payloads from the pushed event; recentEvents only needs the lifecycle.
        pushEvent(this, { type: "item.completed", itemType: item.type, phase: item.phase ?? null, id: item.id });
        return;
      }
      case "turn/completed": {
        if (staleTurn) {
          pushEvent(this, compactEvent(msg));
          return;
        }
        const status = params.turn?.status;
        pushEvent(this, compactEvent(msg));
        this.#settleTurn(status === "completed" || status === "interrupted" ? null : new Error(`codex turn ${status}`), status);
        return;
      }
      case "error":
        if (staleTurn) {
          pushEvent(this, compactEvent(msg));
          return;
        }
        this.lastError = clampText(JSON.stringify(params.error || params), 4000);
        pushEvent(this, compactEvent(msg));
        this.#settleTurn(new Error(this.lastError));
        return;
      case "thread/tokenUsage/updated":
        this.tokenUsage = params.tokenUsage || this.tokenUsage;
        return;
      default:
        pushEvent(this, compactEvent(msg));
    }
  }

  #settleTurn(err, status) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.currentTurnId = null;
    this.turnCount += 1;
    this.turnEndedAt = nowIso();
    this.updatedAt = nowIso();
    if (err) {
      this.lastError = err.message;
      setSessionStatus(this, "failed", false, { source: "turn_error", error: err.message });
      turn.reject(err);
      return;
    }
    this.lastAssistantText = clampText(this.finalAnswer || this.lastAgentMessage || this.lastAssistantText || "");
    setSessionStatus(this, "idle", false, { source: "turn/completed", status });
    turn.resolve();
  }

  async send(message, options = {}) {
    if (!message || !String(message).trim()) throw new Error("message is required.");
    if (this.status === "closed") throw new Error(`Codex session ${this.id} is closed.`);
    if (!this.proc || this.proc.exitCode !== null) throw new Error(`Codex app-server for ${this.id} is not running.`);
    if (this.turn) throw new Error(`Codex session ${this.id} already has a running turn.`);
    if (!this.threadId) throw new Error("Codex session is not started.");

    setSessionStatus(this, "running", true, { source: "send" });

    const done = new Promise((resolve, reject) => {
      this.turn = { resolve, reject };
    });
    const myTurn = this.turn;
    // Guard against unhandledRejection taking down the server if the turn rejects
    // (process crash / error notification) before a waiter is attached below.
    done.catch(() => {});

    let turnResp;
    // Capture the request id so a turn/start that times out can still handle a late
    // response: the app-server may yet return a turn id and run that turn untracked.
    const startReqId = this.nextId;
    try {
      turnResp = await withTimeout(
        this.#request("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text: String(message), text_elements: [] }],
          model: this.model,
          effort: this.effort,
          outputSchema: null,
        }),
        30000,
        "Timed out starting Codex turn.",
      );
    } catch (err) {
      // Replace the pending handler so a late turn/start response interrupts and
      // ignores the orphaned turn instead of letting its events drive a later turn.
      if (this.pending.has(startReqId)) {
        this.pending.set(startReqId, {
          resolve: result => {
            const lateId = result?.turn?.id;
            if (lateId) {
              this.#ignoreTurn(lateId);
              if (this.threadId && this.proc && this.proc.exitCode === null) {
                this.#request("turn/interrupt", { threadId: this.threadId, turnId: lateId }).catch(() => {});
              }
            }
          },
          reject: () => {},
        });
      }
      if (this.turn === myTurn) {
        this.turn = null;
        this.lastError = err instanceof Error ? err.message : String(err);
        if (this.status !== "closed") setSessionStatus(this, "idle", false, { source: "turn_start_error" });
      }
      throw err instanceof Error ? err : new Error(this.lastError);
    }
    const startedTurnId = turnResp?.turn?.id || null;
    if (this.turn !== myTurn) {
      // abort()/close() ran while turn/start was in flight, so it couldn't interrupt a
      // turn whose id was still unknown. Interrupt it now and ignore its trailing events.
      if (startedTurnId) {
        this.#ignoreTurn(startedTurnId);
        if (this.threadId && this.proc && this.proc.exitCode === null) {
          this.#request("turn/interrupt", { threadId: this.threadId, turnId: startedTurnId }).catch(() => {});
        }
      }
      return { accepted: false, sessionId: this.id, status: this.status, turnId: startedTurnId };
    }
    this.currentTurnId = startedTurnId || this.currentTurnId;
    this.lastTurnId = startedTurnId || this.lastTurnId;
    // Stamp timing AND reset accumulated text only now that the turn is accepted: a failed/
    // timed-out turn/start (the catch above) then leaves the previous turn's lastTurn AND its
    // result text intact instead of a stale-id mismatch / wiped answer. Runs synchronously
    // before any turn notification tick, so the new turn's deltas accumulate from empty.
    this.turnStartedAt = nowIso();
    this.turnEndedAt = null;
    this.finalAnswer = "";
    this.lastAgentMessage = "";
    this.lastAssistantText = "";
    const initialStatus = turnResp?.turn?.status;
    // Only a known-terminal status from the start response settles synchronously;
    // queued/pending/inProgress/unknown stay in flight and are driven by notifications.
    const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "error"]);
    if (initialStatus && TERMINAL.has(initialStatus)) {
      const failed = initialStatus !== "completed";
      this.#settleTurn(failed ? new Error(`codex turn ${initialStatus}`) : null, initialStatus);
      if (failed) throw new Error(`codex turn ${initialStatus}`);
    }

    if (options.wait) {
      try {
        return await withTimeout(
          done.then(() => this.result({ maxChars: options.maxChars })),
          options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS,
          "Timed out waiting for Codex turn.",
        );
      } catch (err) {
        // On a wait timeout the turn is still pending; interrupt the backend turn
        // and clear it so the session stays reusable instead of wedged at running.
        if (this.turn) {
          try {
            await this.abort();
          } catch {}
        }
        throw err;
      }
    }
    done.catch(err => {
      this.lastError = err.message;
    });
    return { accepted: true, sessionId: this.id, status: this.status, turnId: startedTurnId };
  }

  result(options = {}) {
    // finalAnswer/lastAgentMessage hold the UNCLAMPED final text (set on item.completed);
    // prefer them over the clamped lastAssistantText so the artifact/charCount are accurate.
    const full = this.finalAnswer || this.lastAgentMessage || this.lastAssistantText || "";
    return buildSessionResult(this, full, options);
  }

  async abort() {
    const interruptedTurnId = this.currentTurnId;
    if (this.threadId && this.currentTurnId) {
      try {
        await withTimeout(
          this.#request("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId }),
          5000,
          "codex interrupt timeout",
        );
      } catch {}
    }
    const turn = this.turn;
    this.turn = null;
    this.currentTurnId = null;
    // Reject any trailing notifications from the interrupted turn so a late
    // turn/completed or delta cannot settle/contaminate a subsequent turn.
    if (interruptedTurnId) this.#ignoreTurn(interruptedTurnId);
    // Only return to idle if the app-server is still alive; otherwise leave the
    // failed/closed status instead of masking a dead backend as reusable.
    if (this.status !== "closed" && this.proc && this.proc.exitCode === null) {
      setSessionStatus(this, "idle", false, { source: "abort" });
    }
    // Only close the clock if a turn is actually in flight (don't stretch a finished turn).
    if (this.turnStartedAt && !this.turnEndedAt) this.turnEndedAt = nowIso();
    turn?.resolve?.();
    return { aborted: true, sessionId: this.id };
  }

  #ignoreTurn(turnId) {
    this.ignoredTurnIds.add(turnId);
    // Bound the set; only a few turns are ever in flight around an abort.
    if (this.ignoredTurnIds.size > 32) {
      const oldest = this.ignoredTurnIds.values().next().value;
      this.ignoredTurnIds.delete(oldest);
    }
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
      // Backend-specific fields kept off the top level so the shape matches omp (P3).
      agentSpecific: { threadId: this.threadId, turnCount: this.turnCount },
    };
  }

  close(options = {}) {
    setSessionStatus(this, "closed", false, { source: "close" });
    try {
      this.proc?.stdin?.end();
    } catch {}
    // Reject the active turn AND every in-flight RPC (turn/start, turn/interrupt, ...)
    // so nothing is left pending; the proc "close" handler early-returns once closed.
    this.#rejectAll(new Error("session closed"));
    const pid = this.proc?.pid;
    terminateProcessTree(pid);
    scheduleForceKill(pid);
    if (options.removePidRecord !== false) removePidRecord(this.pidFile);
    try {
      fs.rmSync(this.answerFile, { force: true });
    } catch {}
    return { closed: true, sessionId: this.id };
  }
}

function extractAssistantText(value) {
  if (!value || typeof value !== "object") return "";
  const type = String(value.type || value.role || value.kind || "");
  if (/assistant|message|text|part|delta/i.test(type)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.delta === "string") return value.delta;
  }
  let out = "";
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes("thinking")) continue;
    if (child && typeof child === "object") out += extractAssistantText(child);
    else if (/^(text|content|delta)$/.test(key) && typeof child === "string") out += child;
  }
  return out;
}

function extractLikelyText(raw) {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) return line;
    try {
      const parsed = JSON.parse(line);
      const text = extractAssistantText(parsed);
      if (text) return text;
    } catch {}
  }
  return "";
}

async function openSession(params) {
  ensureDirs();
  assertAgent(params.agent);
  const session = params.agent === "omp" ? new OmpRpcSession(params) : new CodexAppServerSession(params);
  sessions.set(session.id, session);
  try {
    await session.start();
  } catch (err) {
    sessions.delete(session.id);
    try {
      session.close({ removePidRecord: false });
    } catch {}
    throw err;
  }

  let initial = null;
  if (params.initial_prompt) {
    initial = await session.send(params.initial_prompt, {
      wait: Boolean(params.wait),
      timeout_ms: params.timeout_ms,
    });
  }
  return { session: session.summary(), initial };
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

async function status(sessionId) {
  if (!sessionId) {
    return { sessions: [...sessions.values()].map(session => session.summary()) };
  }
  const session = getSession(sessionId);
  if (session instanceof OmpRpcSession && session.status !== "closed" && session.status !== "failed") {
    await session.state().catch(() => null);
  }
  // Slim projection (type/status/source only), same as result(): the raw events carry full
  // message/usage trees and bloat the caller's context into "a blob". Full raw events stay in
  // the per-session log file (session.logFile).
  return { session: session.summary(), recentEvents: slimEvents(session.events, 20) };
}

async function sendMessage(params) {
  const session = getSession(params.session_id);
  return await session.send(params.message, {
    wait: Boolean(params.wait),
    timeout_ms: params.timeout_ms,
    maxChars: params.max_chars,
  });
}

async function result(sessionId, options = {}) {
  const session = getSession(sessionId);
  return await session.result(options);
}

// A session has finished the turn we are waiting on once it leaves the running/starting
// state. OMP also gates on turnStarted (mirroring waitIdle) so a pre-stream idle window is
// never mistaken for a completed turn; Codex completion is driven by its turn promise.
function sessionSettled(session) {
  if (!session) return true;
  if (session.status === "failed" || session.status === "closed") return true;
  if (session instanceof OmpRpcSession) return session.status === "idle" && session.turnStarted;
  return session.status === "idle" && !session.turn;
}

async function waitSessions(params) {
  const ids = Array.isArray(params.session_ids) ? params.session_ids.filter(Boolean) : [];
  if (!ids.length) throw new Error("session_ids is required (a non-empty array of session ids).");
  const mode = params.mode === "any" ? "any" : "all";
  const timeoutMs = parseNumber(params.timeout_ms, DEFAULT_WAIT_TIMEOUT_MS);
  // Validate up front so an unknown id is a clear error rather than a silent timeout.
  for (const id of ids) getSession(id);

  const summarize = async id => {
    const session = sessions.get(id);
    if (!session) return { sessionId: id, status: "closed", text: null, gone: true };
    const r = await result(id, { maxChars: params.max_chars }).catch(() => null);
    return {
      sessionId: id,
      status: session.status,
      text: r?.text ?? null,
      charCount: r?.charCount ?? null,
      byteCount: r?.byteCount ?? null,
      truncated: r?.truncated ?? false,
      textRef: r?.textRef ?? null,
      lastTurn: lastTurnOf(session),
    };
  };
  const pendingIds = () => ids.filter(id => !sessionSettled(sessions.get(id)));

  const started = Date.now();
  for (;;) {
    // Refresh running OMP sessions via state() (most authoritative); Codex is event-driven.
    for (const id of ids) {
      const session = sessions.get(id);
      if (session instanceof OmpRpcSession && !sessionSettled(session)) await session.state().catch(() => {});
    }
    const settledIds = ids.filter(id => sessionSettled(sessions.get(id)));
    if (mode === "any" && settledIds.length) {
      return { mode, completed: await summarize(settledIds[0]), pending: pendingIds() };
    }
    if (mode === "all" && settledIds.length === ids.length) {
      return { mode, results: await Promise.all(ids.map(summarize)) };
    }
    if (Date.now() - started >= timeoutMs) {
      return { mode, timedOut: true, settled: await Promise.all(settledIds.map(summarize)), pending: pendingIds() };
    }
    await sleep(250);
  }
}

async function abortSession(sessionId) {
  return await getSession(sessionId).abort();
}

function closeSession(sessionId) {
  const session = getSession(sessionId);
  const closed = session.close();
  sessions.delete(sessionId);
  logBytesWritten.delete(session.logFile);
  // The just-closed session's files are no longer active; prune now so the per-file/total caps are
  // enforced promptly instead of waiting up to a full periodic interval (bounds inter-sweep buildup).
  try {
    pruneLogs(activeLogPaths());
  } catch {}
  return closed;
}

function doctor() {
  return {
    bridgeVersion: BRIDGE_VERSION,
    node: process.version,
    stateRoot: STATE_ROOT,
    logDir: RUN_LOG_DIR,
    agents: Object.entries(AGENTS).map(([agent, config]) => {
      const bin = agentBin(agent);
      const plan = spawnPlan(bin, ["--version"]);
      const probe = spawnSync(plan.command, plan.args, { encoding: "utf8", windowsHide: true });
      return {
        agent,
        label: config.label,
        bin,
        available: probe.status === 0,
        version: probe.status === 0 ? stripAnsi(probe.stdout || probe.stderr).trim() : null,
        error: probe.status === 0 ? null : stripAnsi(probe.stderr || probe.error?.message || "not available"),
      };
    }),
  };
}

function renderDoctor(value) {
  const lines = [`Agent Bridge ${value.bridgeVersion}`, `Node: ${value.node}`, `State: ${value.stateRoot}`, ""];
  for (const row of value.agents) {
    lines.push(`${row.agent}: ${row.available ? "ok" : "missing"} (${row.bin})${row.version ? ` ${row.version}` : ""}`);
    if (row.error) lines.push(`  ${row.error}`);
  }
  return `${lines.join("\n")}\n`;
}

const BOOLEAN_ARGS = new Set(["json", "write", "wait", "help", "noStart"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
      const normalized = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (normalized.startsWith("no") && normalized.length > 2 && inline === undefined) {
        const positive = normalized.slice(2, 3).toLowerCase() + normalized.slice(3);
        out[positive] = false;
      } else if (inline !== undefined) {
        out[normalized] = inline;
      } else if (BOOLEAN_ARGS.has(normalized)) {
        out[normalized] = true;
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
        out[normalized] = argv[++i];
      } else {
        out[normalized] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function parseNumber(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got: ${value}`);
  return parsed;
}

function printCliResult(value, args = {}) {
  if (args.json || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  }
}

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case "mcp":
    case "serve-mcp":
      serveMcp();
      return;
    case "doctor": {
      const value = doctor();
      process.stdout.write(args.json ? `${JSON.stringify(value, null, 2)}\n` : renderDoctor(value));
      return;
    }
    case "cleanup":
      // Reap orphaned backend child processes (omp/codex) left behind by an MCP server that
      // was SIGKILLed before it could clean up its own sessions (matched by pid records whose
      // owner MCP is gone), and remove abandoned logs/<runId>/ dirs from those dead servers.
      printCliResult({ childProcesses: cleanupStalePidRecords(), staleLogs: reclaimStaleLogs() }, args);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
  }
}

function mcpText(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name, args) {
  switch (name) {
    case "agent_bridge_open_session":
      return mcpText(await openSession(args || {}));
    case "agent_bridge_send_message":
      // Default to non-blocking: an omitted wait means false, returning an ack immediately so
      // the agent stays responsive instead of dead-waiting (up to 30 min) on one turn. Join the
      // result via agent_bridge_wait with a short timeout_ms to poll progress. Pass wait:true
      // here for a simple inline blocking send.
      return mcpText(await sendMessage({ ...(args || {}), wait: args?.wait ?? false }));
    case "agent_bridge_status":
      return mcpText(await status(args?.session_id));
    case "agent_bridge_result":
      return mcpText(await result(args?.session_id, { maxChars: args?.max_chars }));
    case "agent_bridge_wait":
      return mcpText(await waitSessions(args || {}));
    case "agent_bridge_abort":
      return mcpText(await abortSession(args?.session_id));
    case "agent_bridge_close_session":
      return mcpText(closeSession(args?.session_id));
    case "agent_bridge_doctor":
      return mcpText(renderDoctor(doctor()));
    default:
      return mcpText(`Unknown tool: ${name}`, true);
  }
}

function serveMcp() {
  // This MCP server process is the sole owner of its sessions; give it a private log dir so
  // concurrent servers never prune each other's files.
  RUN_LOG_DIR = path.join(LOG_DIR, makeId("mcp"));
  ensureDirs();
  // Tag the run dir with our pid so a later startup/cleanup can tell whether a leftover
  // logs/mcp-*/ belongs to a still-living server before reclaiming it.
  try {
    fs.writeFileSync(path.join(RUN_LOG_DIR, "owner"), `${process.pid}\n`, "utf8");
  } catch {}
  cleanupStalePidRecords();
  reclaimStaleLogs(); // sweep run dirs left by servers that did not exit cleanly
  installProcessHandlers();
  // Periodic prune of THIS run's logs while the server is long-lived (the per-file/total caps
  // matter most for chatty OMP sessions), plus a sweep of other servers' abandoned run dirs.
  // Scoped work only; unref so it never holds the process open on its own.
  if (LOG_PRUNE_INTERVAL_MS > 0) {
    const pruneTimer = setInterval(() => {
      try {
        pruneLogs(activeLogPaths());
        reclaimStaleLogs();
      } catch {}
    }, LOG_PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let activeRequests = 0;
  let inputClosed = false;
  const maybeExit = () => {
    if (inputClosed && activeRequests === 0) cleanupAndExit(0, "stdin closed");
  };
  rl.on("line", line => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      rpcError(null, -32700, `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (message.id === undefined) return;
    activeRequests += 1;
    handleMcp(message)
      .catch(err => rpcError(message.id, -32000, err instanceof Error ? err.message : String(err)))
      .finally(() => {
        activeRequests -= 1;
        maybeExit();
      });
  });
  rl.on("close", () => {
    inputClosed = true;
    maybeExit();
  });
}

async function handleMcp(message) {
  switch (message.method) {
    case "initialize":
      rpcResult(message.id, {
        protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-bridge", version: BRIDGE_VERSION },
      });
      return;
    case "tools/list":
      rpcResult(message.id, { tools: TOOLS });
      return;
    case "tools/call":
      rpcResult(message.id, await callTool(message.params?.name, message.params?.arguments || {}));
      return;
    case "ping":
      rpcResult(message.id, {});
      return;
    default:
      rpcError(message.id, -32601, `Unknown method: ${message.method}`);
  }
}

function rpcResult(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function rpcError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function cleanupSessions(options = {}) {
  for (const session of sessions.values()) {
    try {
      session.close(options);
    } catch (err) {
      process.stderr.write(`Failed to close ${session.id}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  sessions.clear();
}

function cleanupAndExit(code = 0, reason = "shutdown", error = null) {
  if (shuttingDown) return;
  shuttingDown = true;
  appendLog(path.join(RUN_LOG_DIR, "bridge.log"), `[${nowIso()}] Agent Bridge shutdown code=${code} reason=${reason}\n`);
  if (error) {
    process.stderr.write(`${reason}: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  }
  // KEEP pid records on process shutdown (removePidRecord:false). close() only SIGTERMs the
  // children; its SIGKILL backstop is an async timer that cannot fire before process.exit() below.
  // So a TERM-resistant backend may briefly outlive us — leaving its pid record lets the next MCP
  // startup's cleanupStalePidRecords reap it (see docs/DEVELOPMENT.md). A child that does die
  // removes its own record via its proc "exit" handler.
  cleanupSessions({ removePidRecord: false });
  // Clean exit (stdin close / signal) removes this run's ephemeral log dir; a crash (code !== 0)
  // keeps it for debugging. Never touch the base LOG_DIR (one-shot CLI mode never sets a run dir).
  if (code === 0 && RUN_LOG_DIR !== LOG_DIR) {
    try {
      fs.rmSync(RUN_LOG_DIR, { recursive: true, force: true });
    } catch {}
  }
  process.exit(code);
}

function installProcessHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => cleanupAndExit(0, signal));
  }
  process.once("uncaughtException", err => cleanupAndExit(1, "uncaughtException", err));
  process.once("unhandledRejection", err => cleanupAndExit(1, "unhandledRejection", err));
  process.once("exit", () => {
    if (!shuttingDown) cleanupSessions({ removePidRecord: false });
  });
  process.once("beforeExit", code => {
    appendLog(path.join(RUN_LOG_DIR, "bridge.log"), `[${nowIso()}] Agent Bridge beforeExit code=${code}\n`);
  });
  process.stdout.on("error", err => {
    if (err?.code === "EPIPE") cleanupAndExit(0, "stdout closed");
    else cleanupAndExit(1, "stdout error", err);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

runCli(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  cleanupSessions({ removePidRecord: false });
  process.exit(1);
});
