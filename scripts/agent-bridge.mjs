#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BRIDGE_VERSION = "0.2.3";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_TEXT = 400_000;
const STATE_ROOT = process.env.AGENT_BRIDGE_STATE_DIR || path.join(os.homedir(), ".agent-bridge");
const LOG_DIR = path.join(STATE_ROOT, "logs");
const PID_DIR = path.join(STATE_ROOT, "pids");
const DAEMON_SOCKET = process.env.AGENT_BRIDGE_SOCKET || path.join(STATE_ROOT, "agent-bridge.sock");
const DAEMON_PID_FILE = path.join(STATE_ROOT, "agent-bridge-daemon.pid");
const OPENCODE_DB_PATH =
  process.env.OPENCODE_DB_PATH ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db");

const AGENTS = {
  omp: {
    label: "Oh My Pi",
    env: "OMP_BIN",
    bin: "omp",
  },
  opencode: {
    label: "OpenCode",
    env: "OPENCODE_BIN",
    bin: "opencode",
  },
};

const sessions = new Map();
let processHandlersInstalled = false;
let shuttingDown = false;
let daemonServer = null;

const TOOLS = [
  {
    name: "agent_bridge_open_session",
    description:
      "Open a persistent delegated-agent session. OMP uses its JSONL RPC mode; OpenCode starts a persistent opencode serve backend. Use this before sending messages.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["omp", "opencode"], description: "Agent backend to open." },
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
            "Optional reasoning effort. OMP accepts minimal|low|medium|high|xhigh. OpenCode receives this as --variant.",
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
      "Send a message to an existing persistent delegated-agent session. Returns immediately unless wait=true.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id returned by agent_bridge_open_session." },
        message: { type: "string", description: "Message to send into the delegated agent session." },
        wait: { type: "boolean", default: false, description: "Wait for the turn to complete." },
        timeout_ms: { type: "number", description: "Optional wait timeout in milliseconds." },
      },
      required: ["session_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_status",
    description: "Inspect a persistent delegated-agent session, including streaming state and recent events.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional session id. If omitted, lists all sessions." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agent_bridge_result",
    description: "Read the latest assistant result and recent raw events/logs from a persistent delegated-agent session.",
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
    description: "Check whether OMP, OpenCode, and Node are available for Agent Bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function usage() {
  return [
    "Usage:",
    "  agent-bridge mcp",
    "  agent-bridge daemon",
    "  agent-bridge doctor [--json]",
    "  agent-bridge cleanup [--json]",
    "  agent-bridge start [--json]",
    "  agent-bridge stop [--json]",
    "  agent-bridge sessions [--json]",
    "  agent-bridge open --agent omp|opencode [--cwd DIR] [--write] [--json]",
    "  agent-bridge send <session_id> <message...> [--wait] [--json]",
    "  agent-bridge status [session_id] [--json]",
    "  agent-bridge result <session_id> [--json]",
    "  agent-bridge abort <session_id> [--json]",
    "  agent-bridge close <session_id> [--json]",
    "",
    "Codex should use the MCP server as the primary interface. The CLI facade is for",
    "human debugging, smoke tests, cleanup, and operational control.",
  ].join("\n");
}

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PID_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertAgent(agent) {
  if (!AGENTS[agent]) throw new Error(`Unsupported agent "${agent}". Use omp or opencode.`);
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

function appendLog(file, text) {
  if (!file || !text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  session.events.push({ at: nowIso(), event });
  while (session.events.length > MAX_EVENTS) session.events.shift();
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

function listChildPids(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\s+/)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 1);
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return stripAnsi(result.stdout || "").trim();
}

function roleMatchesCommand(role, command) {
  if (!command) return false;
  if (role === "omp-rpc") return /\bomp\b/.test(command) && /--mode\s+rpc|--mode.*\brpc\b/.test(command);
  if (role === "opencode-serve") return /\bopencode\b/.test(command) && /\bserve\b/.test(command);
  if (role === "opencode-run") {
    return /\bopencode\b/.test(command) && /\brun\b/.test(command) && /--attach\b/.test(command);
  }
  return false;
}

function ownerStillRunning(record) {
  const ownerPid = Number(record?.ownerPid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || ownerPid === process.pid) return false;
  const command = processCommand(ownerPid);
  const argv0LooksLikeNode = /^(?:\S*\/)?node(?:\s|$)/.test(command);
  return argv0LooksLikeNode && /agent-bridge\.mjs/.test(command) && /\b(?:mcp|daemon)\b/.test(command);
}

function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  for (const childPid of listChildPids(pid)) terminateProcessTree(childPid, signal);
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function cleanupStalePidRecords() {
  ensureDirs();
  const summary = {
    records: 0,
    removed: 0,
    skippedRunningOwners: 0,
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
    for (const child of processes) {
      const pid = Number(child.pid);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      const command = processCommand(pid);
      if (roleMatchesCommand(child.role, command)) {
        if (terminateProcessTree(pid)) {
          summary.terminated.push({ pid, role: child.role, command });
        }
      }
    }
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
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.lastAssistantText = "";
    this.lastError = null;
    this.sessionState = null;
    this.events = [];
    this.pending = new Map();
    this.requestCounter = 0;
    this.logFile = path.join(LOG_DIR, `${this.id}.log`);
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

    this.proc = spawn(agentBin("omp"), args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
      this.status = "failed";
      this.lastError = err.message;
      this.readyReject?.(err);
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });

    this.proc.on("close", (code, signal) => {
      appendLog(this.logFile, `[agent-bridge] OMP RPC exited code=${code} signal=${signal || ""}\n`);
      removePidRecord(this.pidFile);
      if (this.status === "closed") {
        this.isStreaming = false;
        return;
      }
      this.status = code === 0 && this.status !== "failed" ? "closed" : "failed";
      this.isStreaming = false;
      this.lastError = code === 0 ? this.lastError : `OMP RPC exited with code ${code}`;
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
    appendLog(this.logFile, `${line}\n`);
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      pushEvent(this, { type: "raw", line });
      return;
    }

    this.updatedAt = nowIso();
    if (message.type === "ready") {
      this.status = "idle";
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
      this.status = "running";
      this.isStreaming = true;
      this.lastAssistantText = "";
      return;
    }
    if (message.type === "agent_end" || message.type === "turn_end") {
      this.status = "idle";
      this.isStreaming = false;
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
    this.status = "running";
    this.isStreaming = true;
    await this.request("prompt", { message: String(message) });
    if (options.wait) {
      await this.waitIdle(options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS);
      return await this.result();
    }
    return { accepted: true, session_id: this.id, status: this.status };
  }

  async state() {
    const response = await this.request("get_state");
    this.sessionState = response.data || null;
    if (this.sessionState) {
      this.isStreaming = Boolean(this.sessionState.isStreaming);
      this.status = this.isStreaming ? "running" : "idle";
    }
    return this.sessionState;
  }

  async result() {
    let text = this.lastAssistantText;
    try {
      const response = await this.request("get_last_assistant_text");
      if (response.data && typeof response.data.text === "string") text = response.data.text;
    } catch {
      // Keep accumulated stream text when the helper command is unavailable.
    }
    this.lastAssistantText = clampText(text || this.lastAssistantText || "");
    return {
      session: this.summary(),
      text: this.lastAssistantText || null,
      recent_events: this.events.slice(-20),
      log_file: this.logFile,
    };
  }

  async abort() {
    await this.request("abort");
    this.status = "idle";
    this.isStreaming = false;
    return { aborted: true, session_id: this.id };
  }

  async waitIdle(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(750);
      try {
        const state = await this.state();
        if (!state?.isStreaming && !state?.queuedMessageCount) return;
      } catch {
        if (!this.isStreaming) return;
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
      isStreaming: this.isStreaming,
      pid: this.proc?.pid || null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      sessionState: this.sessionState
        ? {
            sessionId: this.sessionState.sessionId,
            sessionFile: this.sessionState.sessionFile,
            messageCount: this.sessionState.messageCount,
            queuedMessageCount: this.sessionState.queuedMessageCount,
            model: this.sessionState.model,
          }
        : null,
    };
  }

  close(options = {}) {
    this.status = "closed";
    this.isStreaming = false;
    try {
      this.proc?.stdin?.end();
    } catch {}
    terminateProcessTree(this.proc?.pid);
    if (options.removePidRecord !== false) removePidRecord(this.pidFile);
    return { closed: true, session_id: this.id };
  }
}

class OpenCodeServerSession {
  constructor(options) {
    this.id = makeId("opencode");
    this.agent = "opencode";
    this.cwd = assertCwd(options.cwd);
    this.write = Boolean(options.write);
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.status = "starting";
    this.isStreaming = false;
    this.server = null;
    this.serverUrl = null;
    this.currentClient = null;
    this.openCodeSessionId = null;
    this.turnCount = 0;
    this.lastAssistantText = "";
    this.lastRawOutput = "";
    this.lastError = null;
    this.events = [];
    this.logFile = path.join(LOG_DIR, `${this.id}.log`);
    this.pidFile = pidRecordPath(this.id);
    this.serverArgs = null;
    this.currentClientArgs = null;
    this.expectedClientExit = false;
  }

  async start() {
    const port = await getFreePort();
    this.serverUrl = `http://127.0.0.1:${port}`;
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
    this.serverArgs = args;
    appendLog(this.logFile, `$ ${[agentBin("opencode"), ...args.map(shellQuote)].join(" ")}\n`);
    this.server = spawn(agentBin("opencode"), args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#writePidRecord();

    this.server.stdout.on("data", chunk => appendLog(this.logFile, chunk.toString("utf8")));
    this.server.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      appendLog(this.logFile, text);
      this.lastError = clampText(stripAnsi(text), 4000);
    });
    this.server.on("close", code => {
      if (!this.currentClient) removePidRecord(this.pidFile);
      else this.#writePidRecord();
      if (this.status === "closed") return;
      if (this.status !== "closed") {
        this.status = "failed";
        this.lastError = `opencode serve exited with code ${code}`;
        this.isStreaming = false;
      }
    });

    try {
      await waitForHttp(this.serverUrl, 20000, () => this.server?.exitCode !== null);
      this.status = "idle";
      this.#writePidRecord();
      return this;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.close();
      throw err;
    }
  }

  async send(message, options = {}) {
    if (!message || !String(message).trim()) throw new Error("message is required.");
    if (this.currentClient) throw new Error(`OpenCode session ${this.id} already has a running turn.`);

    const args = [
      "run",
      "--attach",
      this.serverUrl,
      "--dir",
      this.cwd,
      "--format",
      "json",
    ];
    if (this.openCodeSessionId) args.push("--session", this.openCodeSessionId);
    else if (this.turnCount > 0) args.push("--continue");
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--variant", this.effort);
    if (this.write) args.push("--dangerously-skip-permissions");
    args.push(String(message));

    appendLog(this.logFile, `$ ${[agentBin("opencode"), ...args.map(shellQuote)].join(" ")}\n`);
    this.status = "running";
    this.isStreaming = true;
    this.lastAssistantText = "";
    this.lastRawOutput = "";

    const done = new Promise((resolve, reject) => {
      const child = spawn(agentBin("opencode"), args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.currentClient = child;
      this.currentClientArgs = args;
      this.#writePidRecord();

      child.stdout.on("data", chunk => {
        const text = chunk.toString("utf8");
        this.lastRawOutput = clampText(this.lastRawOutput + text);
        appendLog(this.logFile, text);
        this.#consumeJsonLines(text);
      });
      child.stderr.on("data", chunk => {
        const text = chunk.toString("utf8");
        appendLog(this.logFile, text);
        this.lastError = clampText(stripAnsi(text), 4000);
      });
      child.on("error", err => {
        this.currentClient = null;
        this.currentClientArgs = null;
        this.#writePidRecord();
        this.status = "failed";
        this.isStreaming = false;
        this.lastError = err.message;
        reject(err);
      });
      child.on("close", code => {
        const expectedExit = this.expectedClientExit || this.status === "closed";
        this.expectedClientExit = false;
        this.currentClient = null;
        this.currentClientArgs = null;
        if (this.server && this.server.exitCode === null) this.#writePidRecord();
        else removePidRecord(this.pidFile);
        this.isStreaming = false;
        this.updatedAt = nowIso();
        this.turnCount += 1;
        if (expectedExit) {
          resolve(this.result());
          return;
        }
        if (code === 0) {
          this.status = "idle";
          if (!this.lastAssistantText) this.lastAssistantText = extractLikelyText(this.lastRawOutput);
          if (!this.lastAssistantText && this.openCodeSessionId) {
            this.lastAssistantText = readOpenCodeAssistantTextFromDb(this.openCodeSessionId);
          }
          resolve(this.result());
        } else {
          this.status = "failed";
          const err = new Error(this.lastError || `opencode run --attach exited with code ${code}`);
          reject(err);
        }
      });
    });

    if (options.wait) {
      return await withTimeout(done, options.timeout_ms || DEFAULT_WAIT_TIMEOUT_MS, "Timed out waiting for OpenCode turn.");
    }
    done.catch(err => {
      this.lastError = err.message;
    });
    return { accepted: true, session_id: this.id, status: this.status, server_url: this.serverUrl };
  }

  #writePidRecord() {
    const processes = [];
    if (this.server?.pid && this.server.exitCode === null) {
      processes.push({
        role: "opencode-serve",
        pid: this.server.pid,
        command: [agentBin("opencode"), ...(this.serverArgs || [])],
      });
    }
    if (this.currentClient?.pid) {
      processes.push({
        role: "opencode-run",
        pid: this.currentClient.pid,
        command: [agentBin("opencode"), ...(this.currentClientArgs || [])],
      });
    }

    if (!processes.length) {
      removePidRecord(this.pidFile);
      return;
    }
    writePidRecord(this.pidFile, {
      id: this.id,
      agent: this.agent,
      ownerPid: process.pid,
      cwd: this.cwd,
      serverUrl: this.serverUrl,
      createdAt: this.createdAt,
      processes,
    });
  }

  #consumeJsonLines(text) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("{") && !line.startsWith("[")) continue;
      try {
        const parsed = JSON.parse(line);
        pushEvent(this, compactEvent(parsed));
        const sessionId = findFirstKey(parsed, ["sessionID", "sessionId", "session_id"]);
        if (typeof sessionId === "string") this.openCodeSessionId = sessionId;
        const assistantText = extractAssistantText(parsed);
        if (assistantText) this.lastAssistantText = clampText(this.lastAssistantText + assistantText);
      } catch {
        // OpenCode may emit non-JSON framing even in json mode; keep raw log.
      }
    }
  }

  result() {
    if (!this.lastAssistantText && this.openCodeSessionId) {
      this.lastAssistantText = readOpenCodeAssistantTextFromDb(this.openCodeSessionId);
    }
    return {
      session: this.summary(),
      text: this.lastAssistantText || extractLikelyText(this.lastRawOutput) || null,
      raw_output_tail: clampText(stripAnsi(this.lastRawOutput), 20000),
      recent_events: this.events.slice(-20),
      log_file: this.logFile,
    };
  }

  async abort() {
    if (this.currentClient) {
      this.expectedClientExit = true;
      terminateProcessTree(this.currentClient.pid);
      this.currentClient = null;
    }
    this.status = "idle";
    this.isStreaming = false;
    return { aborted: true, session_id: this.id };
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
      isStreaming: this.isStreaming,
      serverPid: this.server?.pid || null,
      currentClientPid: this.currentClient?.pid || null,
      serverUrl: this.serverUrl,
      openCodeSessionId: this.openCodeSessionId,
      turnCount: this.turnCount,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
    };
  }

  close(options = {}) {
    this.status = "closed";
    this.isStreaming = false;
    if (this.currentClient) this.expectedClientExit = true;
    terminateProcessTree(this.currentClient?.pid);
    terminateProcessTree(this.server?.pid);
    if (options.removePidRecord !== false) removePidRecord(this.pidFile);
    return { closed: true, session_id: this.id };
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

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readOpenCodeAssistantTextFromDb(sessionId) {
  if (!sessionId || !fs.existsSync(OPENCODE_DB_PATH)) return "";
  const sql = [
    "select",
    "  m.id as message_id,",
    "  m.time_created as message_time,",
    "  m.data as message_data,",
    "  p.id as part_id,",
    "  p.time_created as part_time,",
    "  p.data as part_data",
    "from message m",
    "join part p on p.message_id = m.id",
    `where m.session_id = ${sqlString(sessionId)}`,
    "order by m.time_created asc, p.time_created asc, p.id asc;",
  ].join("\n");
  const result = spawnSync("sqlite3", ["-json", OPENCODE_DB_PATH, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return "";

  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    return "";
  }

  const assistantMessages = new Map();
  for (const row of rows) {
    let messageData;
    let partData;
    try {
      messageData = JSON.parse(row.message_data);
      partData = JSON.parse(row.part_data);
    } catch {
      continue;
    }
    if (messageData?.role !== "assistant") continue;
    if (partData?.type !== "text" || typeof partData.text !== "string") continue;
    const existing = assistantMessages.get(row.message_id) || {
      time: Number(row.message_time) || 0,
      parts: [],
    };
    existing.parts.push(partData.text);
    assistantMessages.set(row.message_id, existing);
  }

  let latest = "";
  let latestTime = -1;
  for (const value of assistantMessages.values()) {
    const text = value.parts.join("");
    if (text && value.time >= latestTime) {
      latest = text;
      latestTime = value.time;
    }
  }
  return clampText(latest);
}

function findFirstKey(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findFirstKey(child, keys);
      if (found) return found;
    }
  }
  return null;
}

async function openSession(params) {
  ensureDirs();
  assertAgent(params.agent);
  const session = params.agent === "omp" ? new OmpRpcSession(params) : new OpenCodeServerSession(params);
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
  if (!sessionId) return { sessions: [...sessions.values()].map(session => session.summary()) };
  const session = getSession(sessionId);
  if (session instanceof OmpRpcSession && session.status !== "closed" && session.status !== "failed") {
    await session.state().catch(() => null);
  }
  return { session: session.summary(), recent_events: session.events.slice(-20) };
}

async function sendMessage(params) {
  const session = getSession(params.session_id);
  return await session.send(params.message, {
    wait: Boolean(params.wait),
    timeout_ms: params.timeout_ms,
  });
}

async function result(sessionId) {
  const session = getSession(sessionId);
  return await session.result();
}

async function abortSession(sessionId) {
  return await getSession(sessionId).abort();
}

function closeSession(sessionId) {
  const session = getSession(sessionId);
  const closed = session.close();
  sessions.delete(sessionId);
  return closed;
}

function doctor() {
  return {
    bridgeVersion: BRIDGE_VERSION,
    node: process.version,
    stateRoot: STATE_ROOT,
    logDir: LOG_DIR,
    agents: Object.entries(AGENTS).map(([agent, config]) => {
      const bin = agentBin(agent);
      const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
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

function connectDaemon(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(DAEMON_SOCKET);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to Agent Bridge daemon at ${DAEMON_SOCKET}.`));
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function requestDaemon(method, params = {}, options = {}) {
  if (options.autoStart !== false) await ensureDaemon();
  const socket = await connectDaemon(options.connectTimeoutMs || 2000);
  const request = { id: makeId("cli"), method, params };
  return await new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS + 30000;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for daemon response to ${method}.`));
    }, timeoutMs);
    timer.unref?.();

    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    rl.once("line", line => {
      clearTimeout(timer);
      socket.end();
      let response;
      try {
        response = JSON.parse(line);
      } catch (err) {
        reject(new Error(`Invalid daemon response: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (response.ok === false) reject(new Error(response.error || "Daemon request failed."));
      else resolve(response.result);
    });
    socket.once("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function tryDaemonPing() {
  try {
    return await requestDaemon("ping", {}, { autoStart: false, timeoutMs: 2000, connectTimeoutMs: 1000 });
  } catch {
    return null;
  }
}

async function ensureDaemon() {
  const existing = await tryDaemonPing();
  if (existing) return existing;
  cleanupStaleDaemons();
  try {
    fs.rmSync(DAEMON_SOCKET, { force: true });
  } catch {}

  ensureDirs();
  const logFile = path.join(LOG_DIR, "daemon.log");
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1], "daemon"], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  const started = Date.now();
  while (Date.now() - started < 20000) {
    await sleep(250);
    const ping = await tryDaemonPing();
    if (ping) return ping;
  }
  throw new Error(`Timed out starting Agent Bridge daemon. See ${logFile}.`);
}

function daemonPid() {
  try {
    return Number(fs.readFileSync(DAEMON_PID_FILE, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function listDaemonPids() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(row => {
      if (!row || row.pid === process.pid) return false;
      const argv0LooksLikeNode = /^(?:\S*\/)?node(?:\s|$)/.test(row.command);
      return argv0LooksLikeNode && /agent-bridge\.mjs/.test(row.command) && /\bdaemon\b/.test(row.command);
    });
}

function cleanupStaleDaemons() {
  const terminated = [];
  for (const row of listDaemonPids()) {
    if (terminateProcessTree(row.pid)) terminated.push(row);
  }
  try {
    fs.rmSync(DAEMON_SOCKET, { force: true });
  } catch {}
  try {
    fs.rmSync(DAEMON_PID_FILE, { force: true });
  } catch {}
  return { terminated };
}

async function serveDaemon() {
  ensureDirs();
  cleanupStalePidRecords();
  installProcessHandlers();

  const existing = await tryDaemonPing();
  if (existing) throw new Error(`Agent Bridge daemon is already running at ${DAEMON_SOCKET}.`);
  cleanupStaleDaemons();
  try {
    fs.rmSync(DAEMON_SOCKET, { force: true });
  } catch {}

  daemonServer = net.createServer(socket => {
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", line => {
      if (!line.trim()) return;
      let request;
      try {
        request = JSON.parse(line);
      } catch (err) {
        socket.write(`${JSON.stringify({ id: null, ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` })}\n`);
        return;
      }
      handleDaemonRequest(request)
        .then(result => socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`))
        .catch(err =>
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })}\n`,
          ),
        );
    });
  });

  daemonServer.on("error", err => cleanupAndExit(1, "daemon server error", err));

  await new Promise((resolve, reject) => {
    daemonServer.once("error", reject);
    daemonServer.listen(DAEMON_SOCKET, () => {
      daemonServer.off("error", reject);
      fs.chmodSync(DAEMON_SOCKET, 0o600);
      fs.writeFileSync(DAEMON_PID_FILE, `${process.pid}\n`, "utf8");
      resolve();
    });
  });

  appendLog(path.join(LOG_DIR, "daemon.log"), `[${nowIso()}] Agent Bridge daemon ${BRIDGE_VERSION} listening at ${DAEMON_SOCKET}\n`);
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    await new Promise(resolve => daemonServer.once("close", resolve));
  } finally {
    clearInterval(keepAlive);
  }
}

async function handleDaemonRequest(request) {
  const params = request.params || {};
  switch (request.method) {
    case "ping":
      return {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        pid: process.pid,
        socket: DAEMON_SOCKET,
        sessions: [...sessions.values()].map(session => session.summary()),
      };
    case "doctor":
      return doctor();
    case "cleanup":
      return cleanupStalePidRecords();
    case "open":
      return await openSession(params);
    case "send":
      return await sendMessage(params);
    case "sessions":
      return await status(undefined);
    case "status":
      return await status(params.session_id);
    case "result":
      return await result(params.session_id);
    case "abort":
      return await abortSession(params.session_id);
    case "close":
      return closeSession(params.session_id);
    case "stop": {
      const sessionCount = sessions.size;
      cleanupSessions({ removePidRecord: false });
      setTimeout(() => {
        try {
          daemonServer?.close();
        } catch {}
        try {
          fs.rmSync(DAEMON_SOCKET, { force: true });
        } catch {}
        try {
          fs.rmSync(DAEMON_PID_FILE, { force: true });
        } catch {}
        process.exit(0);
      }, 25).unref?.();
      return { stopping: true, sessions_closed: sessionCount };
    }
    default:
      throw new Error(`Unknown daemon method: ${request.method}`);
  }
}

function cliOpenParams(args) {
  const agent = args.agent || args._[0];
  if (!agent) throw new Error("open requires --agent omp|opencode.");
  return {
    agent,
    cwd: args.cwd || process.cwd(),
    write: Boolean(args.write),
    model: args.model,
    effort: args.effort,
    initial_prompt: args.initialPrompt,
    wait: Boolean(args.wait),
    timeout_ms: parseNumber(args.timeoutMs, undefined),
  };
}

function cliSessionId(args, command) {
  const sessionId = args.sessionId || args._[0];
  if (!sessionId) throw new Error(`${command} requires a session_id.`);
  return sessionId;
}

async function runCli(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case "mcp":
    case "serve-mcp":
      serveMcp();
      return;
    case "daemon":
    case "serve-daemon":
      await serveDaemon();
      return;
    case "doctor": {
      const value = doctor();
      process.stdout.write(args.json ? `${JSON.stringify(value, null, 2)}\n` : renderDoctor(value));
      return;
    }
    case "cleanup": {
      const ping = await tryDaemonPing();
      printCliResult(
        {
          daemon: ping ? { running: true, pid: ping.pid, socket: ping.socket } : { running: false, ...cleanupStaleDaemons() },
          child_processes: cleanupStalePidRecords(),
        },
        args,
      );
      return;
    }
    case "start":
      printCliResult(await ensureDaemon(), args);
      return;
    case "stop": {
      const ping = await tryDaemonPing();
      if (!ping) {
        cleanupStaleDaemons();
        printCliResult({ stopping: false, running: false, socket: DAEMON_SOCKET, pid: daemonPid() }, args);
        return;
      }
      printCliResult(await requestDaemon("stop", {}, { autoStart: false, timeoutMs: 5000 }), args);
      return;
    }
    case "sessions":
      printCliResult(await requestDaemon("sessions", {}, { timeoutMs: 10000 }), args);
      return;
    case "open":
      printCliResult(await requestDaemon("open", cliOpenParams(args), { timeoutMs: 30000 }), args);
      return;
    case "send": {
      const sessionId = cliSessionId(args, "send");
      const message = args.message || args._.slice(1).join(" ");
      if (!message.trim()) throw new Error("send requires a message.");
      printCliResult(
        await requestDaemon(
          "send",
          {
            session_id: sessionId,
            message,
            wait: Boolean(args.wait),
            timeout_ms: parseNumber(args.timeoutMs, undefined),
          },
          { timeoutMs: parseNumber(args.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS) + 30000 },
        ),
        args,
      );
      return;
    }
    case "status":
      printCliResult(
        await requestDaemon("status", { session_id: args.sessionId || args._[0] }, { timeoutMs: 10000 }),
        args,
      );
      return;
    case "result":
      printCliResult(await requestDaemon("result", { session_id: cliSessionId(args, "result") }, { timeoutMs: 10000 }), args);
      return;
    case "abort":
      printCliResult(await requestDaemon("abort", { session_id: cliSessionId(args, "abort") }, { timeoutMs: 10000 }), args);
      return;
    case "close":
      printCliResult(await requestDaemon("close", { session_id: cliSessionId(args, "close") }, { timeoutMs: 10000 }), args);
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
      return mcpText(await sendMessage(args || {}));
    case "agent_bridge_status":
      return mcpText(await status(args?.session_id));
    case "agent_bridge_result":
      return mcpText(await result(args?.session_id));
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
  ensureDirs();
  cleanupStalePidRecords();
  installProcessHandlers();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
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
    handleMcp(message).catch(err => rpcError(message.id, -32000, err instanceof Error ? err.message : String(err)));
  });
  rl.on("close", () => cleanupAndExit(0, "stdin closed"));
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
  appendLog(path.join(LOG_DIR, "daemon.log"), `[${nowIso()}] Agent Bridge shutdown code=${code} reason=${reason}\n`);
  if (error) {
    process.stderr.write(`${reason}: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  }
  cleanupSessions({ removePidRecord: false });
  try {
    daemonServer?.close();
  } catch {}
  const ownsDaemonState = Boolean(daemonServer) || daemonPid() === process.pid;
  try {
    if (ownsDaemonState && fs.existsSync(DAEMON_SOCKET)) fs.rmSync(DAEMON_SOCKET, { force: true });
  } catch {}
  try {
    if (ownsDaemonState && fs.existsSync(DAEMON_PID_FILE) && daemonPid() === process.pid) fs.rmSync(DAEMON_PID_FILE, { force: true });
  } catch {}
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
    appendLog(path.join(LOG_DIR, "daemon.log"), `[${nowIso()}] Agent Bridge beforeExit code=${code}\n`);
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, timeoutMs, exited) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (exited?.()) throw new Error("OpenCode server exited before becoming ready.");
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

runCli(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  cleanupSessions({ removePidRecord: false });
  process.exit(1);
});
