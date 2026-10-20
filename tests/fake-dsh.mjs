// Fake `dsh` CLI (DeepSeek Harness 0.2.1-rc.2, `--profile acp`) for hermetic agent-bridge tests.
// ============================================================================================
// The real backend is `dsh --profile acp`: an ACP v1 server speaking NEWLINE-DELIMITED JSON-RPC
// 2.0 over stdio. This fake speaks the same wire so tests/repro-dsh.mjs can drive a full bridge
// session without the real DSH tree, credentials, DSH_HOME, the Electron host, or any model call.
//
// LAUNCH
//   Windows: the bridge resolves DSH_BIN and spawns  cmd.exe /d /s /c <fake-dsh.cmd> <args>;
//            point DSH_BIN at the ABSOLUTE path of tests\fake-dsh.cmd (spawnPlan handles .cmd shims).
//   POSIX:   point DSH_BIN at tests/fake-dsh.sh (chmod +x); spawn is <fake-dsh.sh> <args>.
//   argv in both cases:  --profile acp --patch <patchPath>   (plus possibly other launcher flags).
//   Args other than the fast paths below are recorded in the trace and otherwise ignored; the fake
//   always behaves as an ACP server. FAST PATHS (exit 0 without ever reading stdin):
//     -V | --version              -> "0.2.1-rc.2\n"
//     -h | --help                 -> short ACP help text
//     --dump-config | --dump-default-config -> tiny fake composed-config YAML
//   (doctor()-style probes can therefore use the same DSH_BIN.)
//
// WIRE SURFACE IMPLEMENTED (exact shapes from the live ACP spike, see docs/DESIGN-dsh-*):
//   client -> fake requests : initialize, session/new, session/set_config_option, session/prompt,
//                             session/close
//   client -> fake notif.   : session/cancel  (notification, no id; settles the in-flight prompt
//                             with {stopReason:"cancelled"} and leaves the session reusable)
//   fake -> client notif.   : session/update {sessionId, update:{sessionUpdate: ...}} with
//                             agent_thought_chunk | agent_message_chunk | tool_call |
//                             tool_call_update | usage_update
//   fake -> client request  : session/request_permission (ONLY in `perm` mode); the client must
//                             answer {result:{outcome:{outcome:"selected",optionId:"allow-once"|
//                             "reject-once"}}}. The turn continues (end_turn) either way and the
//                             reply is recorded in the trace.
//   Errors: unknown method -> -32601 "Method not found"; unknown session -> -32602
//   "unknown session: <id>"; a second prompt while one is in flight -> -32602 "a prompt is already
//   in flight for this session"; set_config_option with an unknown configId/value or a missing value
//   -> -32602 "Invalid params" (+ data.reason). Prompt failures use -32603 "turn failed: ...".
//   session/new/session/prompt responses carry result objects (never bare {}), matching real ACP.
//   stdout is protocol-only (unless `noisy`/`badjson` asks for a non-JSON line); stderr is
//   diagnostics-only. stdin EOF -> exit 0; SIGTERM -> exit 0; SIGINT -> 130; a 120 s unref'd safety
//   timer guarantees the fake can never outlive a stuck test run.
//
// DETERMINISTIC CONTENT (assert against these strings, never against timings):
//   default answer          "FAKE_DSH_OK"
//   echo answer             "FAKE_DSH_OK:<first 60 chars of prompt text>"  (`echo` mode)
//   thought chunk text      "FAKE_DSH_THOUGHT"      (agent_thought_chunk; never part of the answer)
//   late marker text        "FAKE_DSH_LATE"         (`lateevents` mode; must be ignored by the bridge)
//   partial crash text      "FAKE_DSH_PARTIAL"      (`exitnonzero` mode; turn never settles)
//   tool                    toolCallId "call-1", title "pwsh", kind "other";
//                           completed output "fake tool output", rejected output "fake tool rejected"
//   usage_update            size always 1000000; used: default 8816, `usageonly` 1000 -> 5000 -> 8816
//   session ids             "00000000-0000-4000-8000-000000000001", "...0002", ... (deterministic)
//   messageId               "msg-<turnSeq>" (turnSeq is process-global, starts at 1)
//   prompt text             all prompt blocks with type:"text" concatenated; the fake is deliberately
//                           lenient about cwd/mcpServers (no validation) — use the trace to assert
//                           what the bridge actually sent.
//
// MODES — FAKE_DSH_MODES (comma-separated; the legacy single-var FAKE_DSH_MODE is also read and
// merged; unknown names are ignored). A mode is a *behavior switch*, and flags combine:
//   ok                explicit no-op (the default behavior); alias of an empty mode list.
//   echo              answer == "FAKE_DSH_OK:" + first 60 chars of the received prompt text.
//   streamchunks      split the answer into 3 agent_message_chunk frames (accumulation test).
//   slow              split the answer into 2 chunks, 300 ms between chunks.
//   slowfirsttoken    delay the FIRST answer chunk by 800 ms (thought chunk stays immediate).
//   toolcall          emit tool_call(in_progress) + tool_call_update(completed) around the answer.
//   perm              server->client session/request_permission round-trip mid-turn; emits the tool
//                     lifecycle too, waits for the client reply (an unanswered request leaves the
//                     turn in flight, as in real ACP), then streams the answer and settles end_turn.
//                     alias: permission
//   perm_always       like perm, but the ONLY offered option is allow_always. A read-tier bridge
//                     MUST answer `{outcome:"cancelled"}` (never select an allow kind).
//   cancel            the FIRST prompt per session hangs after its thought chunk (cancel window);
//                     session/cancel settles it cancelled; later prompts settle normally.
//   hangprompt        EVERY prompt hangs after its thought chunk; session/cancel still settles it
//                     with cancelled (and the session stays usable). alias: hang
//   ignorecancel      like hangprompt BUT session/cancel is silently ignored (a WEDGED server): the
//                     bridge must fail the turn, kill the process tree and mark the session
//                     non-reusable — it must NOT claim the cancel succeeded.
//   hanginit          never answer initialize (client-side open timeout path).
//   initfail          initialize -> JSON-RPC error -32603 (clean open failure).
//   slowinit          delay the initialize response by 1500 ms.
//   newfail           session/new -> JSON-RPC error -32603. alias: sessionnewfail
//   promptfail        the FIRST prompt per session -> JSON-RPC error -32603 "turn failed: ...";
//                     later prompts settle normally (proves the session stays usable after an error).
//   crashturn         during a prompt: thought chunk, then process.exit(1) at +1000 ms, never settling.
//   exitnonzero       during a prompt: thought + one "FAKE_DSH_PARTIAL" chunk, then process.exit(1)
//                     at +150 ms, never settling.
//   crashready        answer initialize, then process.exit(1) at +150 ms ("crashes after ready").
//   stoprefusal       a normal turn that settles with {stopReason:"refusal"} instead of end_turn.
//   sameflush         write the WHOLE turn (thought/chunks/tool/usage + prompt result) in ONE stdout
//                     write with no event-loop yield; chunk delays (slow*) are ignored.
//   lateevents        after a turn settles, emit one more agent_message_chunk "FAKE_DSH_LATE" at
//                     +120 ms; a correct bridge must not fold it into the finished answer.
//   nochunks          settle the prompt with NO agent_message_chunk at all (thought only).
//   empty             settle with a single agent_message_chunk whose text is "".
//   usageonly         emit several usage_update frames with increasing used (last 8816) + answer.
//   nousage           emit no usage_update at all (bridge contextUsage must be null/absent).
//   ctxusage          accepted for compatibility with the contract-doc mode list: the default turn
//                     already emits one usage_update {used:8816,size:1000000}.
//   noisy             print EXACTLY this non-JSON line once on stdout at startup (before the first
//                     response), verbatim:
//     [llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
//   badjson           print one deliberately non-JSON garbage line on stdout at startup.
//                     alias: badline
//   stderrwarn        write one benign diagnostic line to stderr at startup containing the exact
//                     substring "fake benign stderr" (bounded-stderr tests assert on it); never fatal.
// Precedence when flags combine (first match wins; document-tested combos are explicit):
//   initialize:  hanginit > initfail > slowinit > immediate
//   prompt:      promptfail(first) > crashturn > exitnonzero > hangprompt > cancel(first) >
//                perm > normal
//   chunks:      empty > nochunks > streamchunks > slow > single chunk
//   usage:       usageonly > nousage > default(8816)
//
// TRACE — when FAKE_DSH_TRACE is set, append UTF-8 JSON Lines (one complete JSON object per line;
// `ts` = Date.now() ms, `pid` = fake process id). The trace is the source of truth for launch
// args/env/patch assertions:
//   startup line (written before any request is read):
//     {ts, pid, seq, ev:"start", argv:[...], envSubset:{DSH_PERMISSION_MODE, ELECTRON_RUN_AS_NODE},
//      envProbe:{DSH_HOME, DSH_SESSION_ID, DSH_PROFILE, DSH_PROFILE_DIR, DSH_WEB_URL,
//                DSH_PERMISSION_MODE, ELECTRON_RUN_AS_NODE, AGENT_BRIDGE_SESSION_ID,
//                AGENT_BRIDGE_OWNER_PID, AGENT_BRIDGE_AGENT, AGENT_BRIDGE_STATE_DIR},   (all ?? null)
//      patchPath, patchPaths, patchContent (<=16 KiB raw bytes; null if unreadable),
//      patchBytes, patchExists}
//   one line per received request/notification:
//     {ts, pid, seq, ev:"request", method, id, notification, ...}
//       initialize               -> protocolVersion, clientInfo, clientCapabilities
//       session/new              -> cwd, mcpServers (the value the bridge sent), additionalDirectories
//       session/prompt           -> sessionId, promptText (first 2000 chars), promptChars
//       session/set_config_option-> sessionId, configId, value
//       session/close/cancel     -> sessionId
//   one line per client reply to session/request_permission:
//     {ts, pid, seq, ev:"permission_reply", id, outcome, optionId, allowed, result, error}
//   Concurrent fake processes may interleave lines; each line is complete — filter by pid.
//   Trace I/O failures are logged once to stderr and otherwise ignored (never hang/fail a test).
//
// Kept dependency-free and deterministic on purpose: no random ids, no wall-clock content, no
// generation of model traffic. See tests/fake-omp.mjs / fake-claude.mjs for the repo's fake conventions.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------------------------
// tiny stdout/stderr/timer helpers
// ---------------------------------------------------------------------------------------------
function warn(msg) {
  try { process.stderr.write(`[fake-dsh] ${msg}\n`); } catch { /* stderr may be gone */ }
}
function writeRaw(s) {
  try { process.stdout.write(s); } catch (e) {
    if (e && (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED")) process.exit(0);
    warn(`stdout write failed: ${e && e.message}`);
  }
}
function say(obj) { writeRaw(JSON.stringify(obj) + "\n"); }
function lineOf(obj) { return JSON.stringify(obj) + "\n"; }
process.stdout.on("error", () => process.exit(0));

const allTimers = new Set();
function schedule(fn, ms) {
  const t = setTimeout(() => {
    allTimers.delete(t);
    try { fn(); } catch (e) { warn(`timer callback failed: ${e && e.message}`); }
  }, ms);
  allTimers.add(t);
  return t;
}
/** Schedule on a turn: cleared when that turn settles/is cancelled, so late frames never leak. */
function later(turn, fn, ms) {
  const t = schedule(fn, ms);
  if (turn) turn.timers.add(t);
  return t;
}
function clearTurnTimers(turn) {
  for (const t of turn.timers) { clearTimeout(t); allTimers.delete(t); }
  turn.timers.clear();
}
function clearAllTimers() {
  for (const t of allTimers) clearTimeout(t);
  allTimers.clear();
}

// ---------------------------------------------------------------------------------------------
// argv: --patch paths (trace), then help/version fast paths (no stdin needed)
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const patchPaths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--patch") {
    if (argv[i + 1] !== undefined) patchPaths.push(argv[++i]);
  } else if (argv[i].startsWith("--patch=")) {
    patchPaths.push(argv[i].slice("--patch=".length));
  }
}
const patchPath = patchPaths.length ? patchPaths[patchPaths.length - 1] : null;

function readPatchInfo(p) {
  if (!p) return { content: null, bytes: 0, exists: false };
  try {
    const raw = fs.readFileSync(p);
    return { content: raw.subarray(0, 16 * 1024).toString("utf8"), bytes: raw.length, exists: true };
  } catch {
    return { content: null, bytes: 0, exists: false };
  }
}

const TRACE_FILE = process.env.FAKE_DSH_TRACE || "";
let traceSeq = 0;
let traceWarned = false;
/** Append one JSON-Lines record to FAKE_DSH_TRACE (if set). Never throws. */
function trace(rec) {
  if (!TRACE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(TRACE_FILE)), { recursive: true });
    fs.appendFileSync(
      TRACE_FILE,
      JSON.stringify({ ts: Date.now(), pid: process.pid, seq: ++traceSeq, ...rec }) + "\n",
      "utf8",
    );
  } catch (e) {
    if (!traceWarned) {
      traceWarned = true;
      warn(`trace write failed (${TRACE_FILE}): ${e && e.message}`);
    }
  }
}

function envOrNull(name) {
  const v = process.env[name];
  return v === undefined ? null : v;
}
const ENV_PROBE_KEYS = [
  "DSH_HOME", "DSH_SESSION_ID", "DSH_PROFILE", "DSH_PROFILE_DIR", "DSH_WEB_URL",
  "DSH_PERMISSION_MODE", "ELECTRON_RUN_AS_NODE",
  "AGENT_BRIDGE_SESSION_ID", "AGENT_BRIDGE_OWNER_PID", "AGENT_BRIDGE_AGENT", "AGENT_BRIDGE_STATE_DIR",
];
function collectEnvProbe() {
  const out = {};
  for (const k of ENV_PROBE_KEYS) out[k] = envOrNull(k);
  return out;
}

// Startup trace line: launch args + env subset + generated --patch content. Written before any
// stdin is consumed so it is guaranteed to exist as soon as the process is observable.
const patchInfo = readPatchInfo(patchPath);
trace({
  ev: "start",
  argv: argv.slice(),
  envSubset: {
    DSH_PERMISSION_MODE: envOrNull("DSH_PERMISSION_MODE"),
    ELECTRON_RUN_AS_NODE: envOrNull("ELECTRON_RUN_AS_NODE"),
  },
  envProbe: collectEnvProbe(),
  patchPath,
  patchPaths: patchPaths.slice(),
  patchContent: patchInfo.content,
  patchBytes: patchInfo.bytes,
  patchExists: patchInfo.exists,
});

const VERSION = "0.2.1-rc.2";
const HELP_TEXT = [
  "Serve automation clients over Agent Client Protocol stdio.",
  "",
  "Usage: dsh --profile acp [--patch <yaml>]",
  "",
  "Options:",
  "  -V, --version   Print the DSH version and exit",
  "  -h, --help      Print this help and exit",
  "      --patch     Apply a composition patch overlay (repeatable)",
  "",
].join("\n");
const DUMP_TEXT = [
  "# fake-dsh: minimal composed ACP profile (for --dump-config probes)",
  "- id: acp",
  "  config:",
  "    provider: deepseek-official",
  "    model: deepseek-v4-flash",
  "",
].join("\n");

if (argv.includes("-V") || argv.includes("--version")) {
  writeRaw(VERSION + "\n");
  process.exit(0);
}
if (argv.includes("-h") || argv.includes("--help")) {
  writeRaw(HELP_TEXT);
  process.exit(0);
}
if (argv.includes("--dump-config") || argv.includes("--dump-default-config")) {
  writeRaw(DUMP_TEXT);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------------------------
const MODES = new Set();
for (const src of [process.env.FAKE_DSH_MODES, process.env.FAKE_DSH_MODE]) {
  if (!src) continue;
  for (const part of src.split(",")) {
    const m = part.trim().toLowerCase();
    if (m) MODES.add(m);
  }
}
const has = (...names) => names.some((n) => MODES.has(n));
const F = {
  echo: has("echo"),
  streamchunks: has("streamchunks"),
  slow: has("slow"),
  slowfirsttoken: has("slowfirsttoken"),
  toolcall: has("toolcall"),
  perm: has("perm", "permission"),
  permAlways: has("perm_always"),
  cancel: has("cancel"),
  hangprompt: has("hangprompt", "hang"),
  ignorecancel: has("ignorecancel"),
  hanginit: has("hanginit"),
  initfail: has("initfail"),
  slowinit: has("slowinit"),
  newfail: has("newfail", "sessionnewfail"),
  promptfail: has("promptfail"),
  crashturn: has("crashturn"),
  exitnonzero: has("exitnonzero"),
  crashready: has("crashready"),
  stoprefusal: has("stoprefusal"),
  sameflush: has("sameflush"),
  lateevents: has("lateevents"),
  nochunks: has("nochunks"),
  empty: has("empty"),
  usageonly: has("usageonly"),
  nousage: has("nousage"),
  noisy: has("noisy"),
  badjson: has("badjson", "badline"),
  stderrwarn: has("stderrwarn"),
};

// Startup stdout noise, ONLY when explicitly requested. Real dsh printed the account line once
// during session/new; the bridge parser must skip non-JSON stdout lines either way.
const NOISY_LINE =
  "[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)";
const BADJSON_LINE = "[fake-dsh] this line is deliberately not JSON { not closed";
if (F.noisy) writeRaw(NOISY_LINE + "\n");
if (F.badjson) writeRaw(BADJSON_LINE + "\n");
if (F.stderrwarn) warn("fake benign stderr line (mode stderrwarn)");

// ---------------------------------------------------------------------------------------------
// ACP constants / response frames
// ---------------------------------------------------------------------------------------------
const MODEL_VALUES = [
  '["deepseek-official","deepseek-v4-flash"]',
  '["deepseek-official","deepseek-v4-pro"]',
];
const EFFORT_VALUES = ["off", "low", "high", "max"];
const DEFAULT_MODEL = MODEL_VALUES[0];
const DEFAULT_EFFORT = "high";
const INIT_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
  agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  authMethods: [],
};
const PERM_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

function configOptions(session) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: MODEL_VALUES.map((value, i) => ({
            value,
            name: i === 0 ? "deepseek-v4-flash" : "DeepSeek-V4-Pro",
          })),
        },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: session.effort,
      options: EFFORT_VALUES.map((value) => ({
        value,
        name: value === "off" ? "Off" : value === "low" ? "Low" : value === "high" ? "High" : "Max",
      })),
    },
  ];
}

function reply(id, result) { say({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  say({ jsonrpc: "2.0", id, error });
}
function updateFrame(session, update) {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update } };
}
function thoughtFrame(session, messageId) {
  return updateFrame(session, {
    sessionUpdate: "agent_thought_chunk",
    messageId,
    content: { type: "text", text: "FAKE_DSH_THOUGHT" },
  });
}
function chunkFrame(session, messageId, text) {
  return updateFrame(session, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });
}
function toolCallStartFrame(session) {
  return updateFrame(session, {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "pwsh",
    kind: "other",
    status: "in_progress",
    rawInput: { command: "echo fake-dsh" },
  });
}
function toolCallUpdateFrame(session, status, text) {
  return updateFrame(session, {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status,
    content: [{ type: "content", content: { type: "text", text } }],
  });
}
function usageFrame(session, used) {
  return updateFrame(session, { sessionUpdate: "usage_update", used, size: 1000000 });
}
function resultFrame(id, stopReason) {
  return { jsonrpc: "2.0", id, result: { stopReason } };
}

// ---------------------------------------------------------------------------------------------
// session state
// ---------------------------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> session state
let sessionSeq = 0;
let turnSeq = 0;
let serverReqSeq = 0;
const pendingPerms = new Map(); // server request id -> {session, turn}

function makeSession(id, params) {
  return {
    id,
    cwd: params && params.cwd !== undefined ? params.cwd : null,
    mcpServers: params && params.mcpServers !== undefined ? params.mcpServers : null,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    prompts: 0, // accepted prompt attempts on this session (drives promptfail/cancel modes)
    turn: null, // current in-flight turn state, or null
  };
}

function promptTextOf(params) {
  if (!params || !Array.isArray(params.prompt)) return "";
  return params.prompt
    .filter((block) => block && block.type === "text")
    .map((block) => String(block.text === undefined ? "" : block.text))
    .join("");
}
function makeAnswer(text) {
  return F.echo ? `FAKE_DSH_OK:${text.slice(0, 60)}` : "FAKE_DSH_OK";
}
function splitAnswer(s, parts) {
  if (parts <= 1 || !s) return [s];
  const size = Math.ceil(s.length / parts);
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
function chunkTexts(answer) {
  if (F.empty) return [""];
  if (F.nochunks) return [];
  if (F.streamchunks) return splitAnswer(answer, 3);
  if (F.slow) return splitAnswer(answer, 2);
  return [answer];
}
function usageValues() {
  if (F.usageonly) return [1000, 5000, 8816];
  if (F.nousage) return [];
  return [8816];
}

function settleBookkeeping(session, turn) {
  if (turn.settled) return;
  turn.settled = true;
  clearTurnTimers(turn);
  if (session.turn === turn) session.turn = null;
}
function finishTurn(session, turn, stopReason) {
  if (turn.settled) return;
  settleBookkeeping(session, turn);
  say(resultFrame(turn.reqId, stopReason));
}
function maybeLateEvents(session, turn, messageId) {
  if (!F.lateevents) return;
  schedule(() => say(chunkFrame(session, messageId, "FAKE_DSH_LATE")), 120);
}

/** Stream answer chunks (honouring slow/slowfirsttoken), then invoke done(). Never after settle. */
function emitChunksProgressive(session, turn, chunks, messageId, done) {
  let i = 0;
  const next = () => {
    if (turn.settled) return;
    if (i >= chunks.length) return done();
    const isFirst = i === 0;
    const delay = isFirst ? (F.slowfirsttoken ? 800 : 0) : (F.slow ? 300 : 0);
    const step = () => {
      if (turn.settled) return;
      say(chunkFrame(session, messageId, chunks[i]));
      i += 1;
      next();
    };
    if (delay > 0) later(turn, step, delay); else step();
  };
  next();
}

// ---------------------------------------------------------------------------------------------
// turn drivers
// ---------------------------------------------------------------------------------------------
function runNormalTurn(session, turn) {
  const messageId = `msg-${turn.seq}`;
  const chunks = chunkTexts(makeAnswer(turn.promptText));
  const usages = usageValues();
  const stopReason = F.stoprefusal ? "refusal" : "end_turn";

  // sameflush: every frame of the turn, including the prompt result, goes out in ONE stdout write
  // with no event-loop yield in between (bridge must not require an intermediate read tick).
  if (F.sameflush) {
    const frames = [thoughtFrame(session, messageId)];
    if (F.toolcall) frames.push(toolCallStartFrame(session));
    for (const text of chunks) frames.push(chunkFrame(session, messageId, text));
    if (F.toolcall) frames.push(toolCallUpdateFrame(session, "completed", "fake tool output"));
    for (const used of usages) frames.push(usageFrame(session, used));
    frames.push(resultFrame(turn.reqId, stopReason));
    writeRaw(frames.map(lineOf).join(""));
    settleBookkeeping(session, turn);
    maybeLateEvents(session, turn, messageId);
    return;
  }

  say(thoughtFrame(session, messageId));
  if (F.toolcall) say(toolCallStartFrame(session));
  emitChunksProgressive(session, turn, chunks, messageId, () => {
    if (turn.settled) return;
    if (F.toolcall) say(toolCallUpdateFrame(session, "completed", "fake tool output"));
    for (const used of usages) say(usageFrame(session, used));
    finishTurn(session, turn, stopReason);
    maybeLateEvents(session, turn, messageId);
  });
}

function runPermTurn(session, turn) {
  const messageId = `msg-${turn.seq}`;
  say(thoughtFrame(session, messageId));
  say(toolCallStartFrame(session));
  const permId = 1000000 + ++serverReqSeq; // server->client request id (client ids are 1,2,3...)
  turn.pendingPermId = permId;
  pendingPerms.set(permId, { session, turn });
  say({
    jsonrpc: "2.0",
    id: permId,
    method: "session/request_permission",
    params: {
      sessionId: session.id,
      toolCall: { toolCallId: "call-1" },
      options: F.permAlways ? [{ optionId: "allow-always", name: "Always allow", kind: "allow_always" }] : PERM_OPTIONS,
    },
  });
}

function handlePermissionReply(msg) {
  const outcome = msg.result && typeof msg.result === "object" ? msg.result.outcome ?? null : null;
  const optionId = outcome && typeof outcome.optionId === "string" ? outcome.optionId : null;
  trace({
    ev: "permission_reply",
    id: msg.id,
    outcome,
    optionId,
    allowed: optionId === "allow-once",
    result: msg.result ?? null,
    error: msg.error ?? null,
  });
  const pending = pendingPerms.get(msg.id);
  if (!pending) return; // late/unknown reply: trace it, ignore it
  pendingPerms.delete(msg.id);
  const { session, turn } = pending;
  turn.pendingPermId = null;
  if (turn.settled) return;
  const allowed = optionId === "allow-once";
  say(
    toolCallUpdateFrame(
      session,
      allowed ? "completed" : "failed",
      allowed ? "fake tool output" : "fake tool rejected",
    ),
  );
  const messageId = `msg-${turn.seq}`;
  emitChunksProgressive(session, turn, chunkTexts(makeAnswer(turn.promptText)), messageId, () => {
    if (turn.settled) return;
    for (const used of usageValues()) say(usageFrame(session, used));
    finishTurn(session, turn, F.stoprefusal ? "refusal" : "end_turn");
    maybeLateEvents(session, turn, messageId);
  });
}

// ---------------------------------------------------------------------------------------------
// request handlers
// ---------------------------------------------------------------------------------------------
function handleInitialize(msg) {
  if (F.hanginit) {
    warn("initialize hangs forever (mode hanginit)");
    return; // no response: the client-side open timeout path
  }
  if (F.initfail) {
    replyError(msg.id, -32603, "fake-dsh: initialize failed (mode initfail)");
    return;
  }
  const send = () => {
    reply(msg.id, INIT_RESULT);
    if (F.crashready) schedule(() => process.exit(1), 150);
  };
  if (F.slowinit) later(null, send, 1500); else send();
}

function handleSessionNew(msg) {
  if (F.newfail) {
    replyError(msg.id, -32603, "fake-dsh: session/new failed (mode newfail)");
    return;
  }
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  sessionSeq += 1;
  const id = `00000000-0000-4000-8000-${String(sessionSeq).padStart(12, "0")}`;
  const session = makeSession(id, params);
  sessions.set(id, session);
  reply(msg.id, { sessionId: id, configOptions: configOptions(session) });
}

function handleSetConfigOption(msg) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const session = sessions.get(params.sessionId);
  if (!session) {
    replyError(msg.id, -32602, `unknown session: ${String(params.sessionId)}`);
    return;
  }
  if (params.value === undefined) {
    replyError(msg.id, -32602, "Invalid params", { reason: `missing value for configId: ${String(params.configId)}` });
    return;
  }
  if (params.configId === "model") {
    if (typeof params.value !== "string" || !MODEL_VALUES.includes(params.value)) {
      replyError(msg.id, -32602, "Invalid params", { reason: `unknown model option: ${String(params.value)}` });
      return;
    }
    session.model = params.value;
  } else if (params.configId === "reasoning_effort") {
    if (!EFFORT_VALUES.includes(params.value)) {
      replyError(msg.id, -32602, "Invalid params", { reason: `unknown reasoning effort: ${String(params.value)}` });
      return;
    }
    session.effort = params.value;
  } else {
    replyError(msg.id, -32602, "Invalid params", {
      reason: `unknown session config option: ${String(params.configId)}`,
    });
    return;
  }
  reply(msg.id, { configOptions: configOptions(session) });
}

function handlePrompt(msg) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const session = sessions.get(params.sessionId);
  if (!session) {
    replyError(msg.id, -32602, `unknown session: ${String(params.sessionId)}`);
    return;
  }
  if (session.turn) {
    replyError(msg.id, -32602, "a prompt is already in flight for this session");
    return;
  }
  session.prompts += 1;
  if (F.promptfail && session.prompts === 1) {
    replyError(msg.id, -32603, "turn failed: fake-dsh simulated prompt failure (mode promptfail)");
    return;
  }
  const turn = {
    reqId: msg.id,
    seq: ++turnSeq,
    promptText: promptTextOf(params),
    timers: new Set(),
    settled: false,
    pendingPermId: null,
  };
  session.turn = turn;
  const messageId = `msg-${turn.seq}`;

  if (F.crashturn) { // crash mid-turn: never settle, exit 1 after ~1s
    say(thoughtFrame(session, messageId));
    later(turn, () => process.exit(1), 1000);
    return;
  }
  if (F.exitnonzero) { // partial output, then crash before the prompt result
    say(thoughtFrame(session, messageId));
    say(chunkFrame(session, messageId, "FAKE_DSH_PARTIAL"));
    later(turn, () => process.exit(1), 150);
    return;
  }
  if (F.hangprompt || F.ignorecancel) { // never settles on its own; session/cancel may (or may not) settle it
    say(thoughtFrame(session, messageId));
    return;
  }
  if (F.cancel && session.prompts === 1) { // first prompt: a deterministic cancel window
    say(thoughtFrame(session, messageId));
    return;
  }
  if (F.perm || F.permAlways) {
    runPermTurn(session, turn);
    return;
  }
  runNormalTurn(session, turn);
}

function handleClose(msg) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const session = sessions.get(params.sessionId);
  if (!session) {
    replyError(msg.id, -32602, `unknown session: ${String(params.sessionId)}`);
    return;
  }
  if (session.turn) {
    const turn = session.turn;
    if (turn.pendingPermId !== null) {
      pendingPerms.delete(turn.pendingPermId);
      turn.pendingPermId = null;
    }
    finishTurn(session, turn, "cancelled"); // real ACP: close cancels the in-flight prompt
  }
  sessions.delete(session.id);
  reply(msg.id, {});
}

function handleCancelNotification(msg) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const session = sessions.get(params.sessionId);
  if (!session || !session.turn) return; // no prompt in flight: silently ignore (real no-op)
  if (F.ignorecancel) return; // WEDGED-server mode: deliberately swallow the cancel
  const turn = session.turn;
  if (turn.pendingPermId !== null) {
    pendingPerms.delete(turn.pendingPermId);
    turn.pendingPermId = null;
  }
  finishTurn(session, turn, "cancelled"); // session stays usable for a following prompt
}

function handleRequest(msg) {
  switch (msg.method) {
    case "initialize": return handleInitialize(msg);
    case "session/new": return handleSessionNew(msg);
    case "session/set_config_option": return handleSetConfigOption(msg);
    case "session/prompt": return handlePrompt(msg);
    case "session/close": return handleClose(msg);
    default: return replyError(msg.id, -32601, "Method not found");
  }
}

function handleNotification(msg) {
  if (msg.method === "session/cancel") handleCancelNotification(msg);
  // Unknown notifications get no response (JSON-RPC).
}

// ---------------------------------------------------------------------------------------------
// trace for received requests / client replies
// ---------------------------------------------------------------------------------------------
function traceRequest(msg, isRequest) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const rec = {
    ev: "request",
    method: msg.method,
    id: msg.id !== undefined ? msg.id : null,
    notification: !isRequest,
  };
  switch (msg.method) {
    case "initialize":
      rec.protocolVersion = params.protocolVersion ?? null;
      rec.clientInfo = params.clientInfo ?? null;
      rec.clientCapabilities = params.clientCapabilities ?? null;
      break;
    case "session/new":
      rec.cwd = params.cwd ?? null;
      rec.mcpServers = params.mcpServers ?? null;
      rec.additionalDirectories = params.additionalDirectories ?? null;
      break;
    case "session/set_config_option":
      rec.sessionId = params.sessionId ?? null;
      rec.configId = params.configId ?? null;
      rec.value = params.value ?? null;
      break;
    case "session/prompt": {
      const text = promptTextOf(params);
      rec.sessionId = params.sessionId ?? null;
      rec.promptText = text.slice(0, 2000);
      rec.promptChars = text.length;
      break;
    }
    case "session/close":
    case "session/cancel":
      rec.sessionId = params.sessionId ?? null;
      break;
    default:
      break;
  }
  trace(rec);
}

function handleClientMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  if (typeof msg.method === "string") {
    const isRequest = Object.prototype.hasOwnProperty.call(msg, "id");
    traceRequest(msg, isRequest);
    if (isRequest) handleRequest(msg); else handleNotification(msg);
  } else if (Object.prototype.hasOwnProperty.call(msg, "id")) {
    handlePermissionReply(msg); // JSON-RPC response from the client to our request_permission
  }
}

// ---------------------------------------------------------------------------------------------
// stdin line loop / shutdown
// ---------------------------------------------------------------------------------------------
let stdinBuf = "";
function handleLine(line) {
  const text = line.replace(/\r$/, "").trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; } // client-side junk: ignore, never crash
  try {
    handleClientMessage(msg);
  } catch (e) {
    warn(`message handler failed: ${e && e.message}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, idx);
    stdinBuf = stdinBuf.slice(idx + 1);
    handleLine(line);
  }
});
process.stdin.on("end", () => {
  if (stdinBuf.trim()) handleLine(stdinBuf); // tolerate a final line without a newline
  stdinBuf = "";
  clearAllTimers();
  process.exitCode = 0; // let pending stdout flushes drain, then exit naturally
});
process.stdin.on("error", () => {});

process.on("SIGTERM", () => { clearAllTimers(); process.exit(0); });
process.on("SIGINT", () => { clearAllTimers(); process.exit(130); });

// Safety valve: never outlive a stuck test run. unref() so it cannot delay a clean stdin-EOF exit.
setTimeout(() => process.exit(0), 120000).unref();
