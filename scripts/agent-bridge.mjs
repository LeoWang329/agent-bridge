#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BRIDGE_VERSION = "0.2.1";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const MAX_TEXT = 400_000;
const STATE_ROOT = process.env.AGENT_BRIDGE_STATE_DIR || path.join(os.homedir(), ".agent-bridge");
const LOG_DIR = path.join(STATE_ROOT, "logs");
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
    "  agent-bridge doctor [--json]",
    "",
    "This adapter is intentionally session-first. Use MCP tools to open a persistent session,",
    "send messages, inspect status/result, abort turns, and close sessions.",
  ].join("\n");
}

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
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
  if (!event || typeof event !== "object") return event;
  const copy = { ...event };
  if (typeof copy.delta === "string" && copy.delta.length > 300) copy.delta = `${copy.delta.slice(0, 300)}...`;
  if (typeof copy.text === "string" && copy.text.length > 300) copy.text = `${copy.text.slice(0, 300)}...`;
  return copy;
}

function shellQuote(value) {
  const s = String(value);
  if (/^[a-zA-Z0-9_./:=,+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
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
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.proc = spawn(agentBin("omp"), args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

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

    this.proc.on("close", code => {
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

  close() {
    this.status = "closed";
    this.isStreaming = false;
    try {
      this.proc?.stdin?.end();
    } catch {}
    try {
      this.proc?.kill("SIGTERM");
    } catch {}
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
  }

  async start() {
    const port = await getFreePort();
    this.serverUrl = `http://127.0.0.1:${port}`;
    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
    appendLog(this.logFile, `$ ${[agentBin("opencode"), ...args.map(shellQuote)].join(" ")}\n`);
    this.server = spawn(agentBin("opencode"), args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.server.stdout.on("data", chunk => appendLog(this.logFile, chunk.toString("utf8")));
    this.server.stderr.on("data", chunk => {
      const text = chunk.toString("utf8");
      appendLog(this.logFile, text);
      this.lastError = clampText(stripAnsi(text), 4000);
    });
    this.server.on("close", code => {
      if (this.status !== "closed") {
        this.status = "failed";
        this.lastError = `opencode serve exited with code ${code}`;
        this.isStreaming = false;
      }
    });

    await waitForHttp(this.serverUrl, 20000, () => this.server?.exitCode !== null);
    this.status = "idle";
    return this;
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
        this.status = "failed";
        this.isStreaming = false;
        this.lastError = err.message;
        reject(err);
      });
      child.on("close", code => {
        this.currentClient = null;
        this.isStreaming = false;
        this.updatedAt = nowIso();
        this.turnCount += 1;
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
      try {
        this.currentClient.kill("SIGTERM");
      } catch {}
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

  close() {
    this.status = "closed";
    this.isStreaming = false;
    try {
      this.currentClient?.kill("SIGTERM");
    } catch {}
    try {
      this.server?.kill("SIGTERM");
    } catch {}
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
  const session =
    params.agent === "omp"
      ? await new OmpRpcSession(params).start()
      : await new OpenCodeServerSession(params).start();
  sessions.set(session.id, session);

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

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
      out[key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = inline !== undefined ? inline : argv[++i];
    } else {
      out._.push(arg);
    }
  }
  return out;
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
  process.on("SIGTERM", cleanupAndExit);
  process.on("SIGINT", cleanupAndExit);
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

function cleanupAndExit() {
  for (const session of sessions.values()) session.close();
  process.exit(0);
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
  process.exit(1);
});
