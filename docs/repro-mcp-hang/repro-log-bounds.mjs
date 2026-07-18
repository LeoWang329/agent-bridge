// Repro/verify for the diagnostic-log size fix: appendLog's per-write byte cap (root cause) + the
// redactForLog body elision that aligns codex/omp with the three stream-json backends.
//
// Why this exists: a single log line was unbounded. The only defence was a per-backend "don't log event
// type X" list, extended twice after the fact (message_update's O(n^2) re-serialization; get_state /
// get_last_assistant_text at ~1GB per log, issue #1) and still wide open on codex — a real session log
// measured 8.7 MB / 2688 lines with a longest single line of 1,583,143 bytes (an item/completed carrying
// a command's aggregatedOutput). Type exclusions are whack-a-mole; the cap is the floor underneath them.
//
// Scenarios (all zero-token, driven by fake-codex.mjs FAKE_CODEX_MODE=bigoutput):
//   S1 line cap      — a 2 MB NON-JSON stdout line (the raw-line path no redaction touches) lands in the
//                      log truncated to the cap + a self-describing marker, on a UTF-8 boundary.
//   S2 redaction     — the commandExecution item/completed keeps its skeleton (item type, the command
//                      itself, cwd, status, exitCode, durationMs) and elides aggregatedOutput; the
//                      agentMessage body is elided too. No raw payload survives anywhere in the log.
//   S3 short lines   — the `$ <cmd>` line and `[agent-bridge] …` structural lines are byte-identical to
//                      what they were before (nothing short is affected).
//   S4 contract      — answerFile still holds the COMPLETE untruncated answer, and the MCP `text` matches
//                      it. The cap is diagnostics-only; "必读内容绝不静默丢失" is unchanged.
//   S5 rotation      — the per-file rotation counter counts POST-truncation bytes. Run with a 1 MB file
//                      cap and a 100 KB line cap until rotation fires: the rotated .1.log must be ~1 MB.
//                      If the counter had used pre-truncation sizes (2 MB/turn) it would have rotated
//                      after the FIRST turn, leaving a ~100 KB .1.log — the discriminating assertion.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const win = process.platform === "win32";
const FAKE_CODEX = path.join(HERE, win ? "fake-codex.cmd" : "fake-codex.sh");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };
const die = msg => { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); };

function makeServer(env) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "bigoutput", ...env },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {} } });
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  let nextId = 1;
  const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; };
  const call = async (name, args, ms = 30000) => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await waitResp(id, ms);
    if (!r) return die(`${name} no response`);
    const t = r?.result?.content?.[0]?.text;
    return t ? JSON.parse(t) : null;
  };
  const init = async () => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-log-bounds", version: "0" } } });
    if (!await waitResp(id, 10000)) return die("no init");
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { srv, call, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

// One codex turn against the bigoutput fake; returns {sess, result}.
async function oneTurn(s, sessionId) {
  let id = sessionId;
  if (!id) {
    const open = await s.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000);
    id = open?.session?.id;
    if (!id) return die(`open codex failed: ${JSON.stringify(open)?.slice(0, 400)}`);
  }
  const result = await s.call("agent_bridge_send_message", { session_id: id, message: "run the big command", wait: "all" }, 30000);
  return { id, result };
}

const LINE_CAP = 4096; // AGENT_BRIDGE_LOG_LINE_MAX_BYTES default
const STATE_A = fs.mkdtempSync(path.join(os.tmpdir(), "ab-logbounds-a-"));
const STATE_B = fs.mkdtempSync(path.join(os.tmpdir(), "ab-logbounds-b-"));

try {
  // ---------- S1-S4: default caps ----------
  const s = makeServer({ AGENT_BRIDGE_STATE_DIR: STATE_A });
  await s.init();
  const { id, result } = await oneTurn(s);
  const status = await s.call("agent_bridge_status", { session_id: id });
  const logFile = status?.session?.logFile;
  const answerFile = result?.textRef; // the file the product contract promises holds the FULL answer
  if (!logFile || !fs.existsSync(logFile)) die(`no log file (${logFile})`);

  const raw = fs.readFileSync(logFile);
  const lines = raw.toString("utf8").split("\n").filter(Boolean);
  const byteLens = lines.map(l => Buffer.byteLength(l, "utf8"));
  const maxLine = Math.max(...byteLens);

  // What the SAME event would have cost before the fix, for the record.
  const beforeBytes = 2_000_000 + "fake-codex banner ".length;
  console.log(`[evidence] log=${raw.length}B lines=${lines.length} maxLine=${maxLine}B (pre-fix: one raw line alone was ${beforeBytes}B)`);

  // S1 — line cap
  check("S1 no line exceeds the cap (+marker slack)", maxLine <= LINE_CAP + 64, `maxLine=${maxLine}B cap=${LINE_CAP}B`);
  const truncated = lines.filter(l => /…\[\+\d+B truncated\]$/.test(l));
  check("S1 the 2MB raw line is present and marked truncated", truncated.length >= 1, `${truncated.length} truncated line(s)`);
  const bannerLine = truncated.find(l => l.startsWith("fake-codex banner"));
  check("S1 truncation keeps the HEAD (event identity survives)", Boolean(bannerLine), bannerLine ? bannerLine.slice(0, 40) : "missing");
  const dropped = bannerLine && Number(bannerLine.match(/\+(\d+)B truncated/)[1]);
  check("S1 marker reports the dropped byte count honestly",
    Boolean(dropped) && Math.abs(dropped + LINE_CAP - (beforeBytes + 1)) <= 8, `dropped=${dropped}B`);
  check("S1 log is valid UTF-8 (no split multi-byte sequence)", !raw.toString("utf8").includes("�"));

  // S2 — redaction: skeleton kept, bodies gone
  const cmdLine = lines.find(l => l.includes('"commandExecution"'));
  if (!cmdLine) die("no commandExecution line in the log");
  const cmdEvent = JSON.parse(cmdLine);
  const item = cmdEvent.params.item;
  check("S2 skeleton kept: item type", item.type === "commandExecution", item.type);
  check("S2 skeleton kept: exitCode", item.exitCode === 0, String(item.exitCode));
  check("S2 skeleton kept: durationMs", item.durationMs === 1234, String(item.durationMs));
  check("S2 skeleton kept: status/cwd/processId", item.status === "completed" && Boolean(item.cwd) && item.processId === 4242);
  check("S2 skeleton kept: the command itself", typeof item.command === "string" && item.command.includes("process.stdout.write"), item.command);
  check("S2 body dropped: aggregatedOutput elided to a size marker", item.aggregatedOutput === "<elided 2000000c>", String(item.aggregatedOutput).slice(0, 60));
  const msgLine = lines.find(l => l.includes('"agentMessage"') && l.includes("item/completed"));
  check("S2 body dropped: agentMessage text elided", Boolean(msgLine) && JSON.parse(msgLine).params.item.text === "<elided 50008c>",
    msgLine ? String(JSON.parse(msgLine).params.item.text).slice(0, 40) : "missing");
  check("S2 no raw payload anywhere in the log", !raw.includes("x".repeat(600)) && !raw.includes("y".repeat(600)));

  // S3 — short structural lines untouched
  const dollar = lines.find(l => l.startsWith("$ "));
  check("S3 `$ <cmd>` line intact (no marker)", Boolean(dollar) && !dollar.includes("truncated"), dollar);
  const spawned = lines.find(l => l.startsWith("[agent-bridge] spawned codex"));
  check("S3 `[agent-bridge]` structural line intact", Boolean(spawned) && !spawned.includes("truncated"), spawned);

  // S4 — product contract: the answer is NOT truncated
  const answer = fs.readFileSync(answerFile, "utf8");
  check("S4 answerFile holds the COMPLETE answer", answer.length === 50_008 && answer.endsWith("y"), `${answer.length} chars`);
  check("S4 MCP text matches the answerFile in full", result?.text === answer, `text=${result?.text?.length} answer=${answer.length}`);
  check("S4 answer carries no truncation marker", !answer.includes("truncated") && !answer.includes("<elided"));

  await s.call("agent_bridge_close_session", { session_id: id });
  s.kill();
  await sleep(400);

  // ---------- S5: rotation counter counts post-truncation bytes ----------
  const s2 = makeServer({
    AGENT_BRIDGE_STATE_DIR: STATE_B,
    AGENT_BRIDGE_LOG_LINE_MAX_BYTES: "100000",
    AGENT_BRIDGE_LOG_FILE_MAX_MB: "1",
  });
  await s2.init();
  let sid = null, rotated = null;
  for (let i = 0; i < 20 && !rotated; i++) {
    const r = await oneTurn(s2, sid);
    sid = r.id;
    const st = await s2.call("agent_bridge_status", { session_id: sid });
    const lf = st?.session?.logFile;
    const rot = lf && lf.replace(/(\.[^.\\/]+)$/, ".1$1");
    if (rot && fs.existsSync(rot)) rotated = rot;
  }
  if (!rotated) die("rotation never fired in 20 turns");
  const rotatedBytes = fs.statSync(rotated).size;
  console.log(`[evidence] rotated at ${rotatedBytes}B against a 1048576B file cap`);
  check("S5 rotation fired at the real 1MB file size (counter is post-truncation)",
    rotatedBytes > 900_000 && rotatedBytes <= 1_048_576 + 200_000,
    `${rotatedBytes}B — a pre-truncation counter would have rotated at ~100KB after turn 1`);
  await s2.call("agent_bridge_close_session", { session_id: sid });
  s2.kill();
  await sleep(300);
} finally {
  for (const d of [STATE_A, STATE_B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n[harness] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
