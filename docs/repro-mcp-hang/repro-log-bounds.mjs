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
//   S6 omp hazards   — a multi-byte character split across two STDERR writes survives (stream-level
//                      decode, not per-chunk); a structured `content` keeps tool type/name/id while its
//                      text/output leaves are elided; a body nested past the depth guard never lands.
//   S7 claude result — `{type:"result", result:"<answer>"}` carries the answer VERBATIM. It must be
//                      elided outright, not left at 512 characters by the generic string clamp.
//   S8 exit journal  — the shutdown record must stay PARSEABLE JSON. appendLog gets no exemption, so the
//                      producer trims whole `sessions[]` entries to the write budget and reports
//                      sessionCount/sessionsOmitted. A byte-truncated record would fail JSON.parse.
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
const FAKE_OMP = path.join(HERE, win ? "fake-omp.cmd" : "fake-omp.sh");
const FAKE_CLAUDE = path.join(HERE, win ? "fake-claude.cmd" : "fake-claude.sh");
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
const [STATE_A, STATE_B, STATE_C, STATE_D, STATE_E] =
  ["a", "b", "c", "d", "e"].map(x => fs.mkdtempSync(path.join(os.tmpdir(), `ab-logbounds-${x}-`)));

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

  // S1 — line cap. The cap is the TOTAL write budget, marker included: every write is <= cap, so each
  // line (which is the write minus its trailing "\n") is <= cap - 1. No slack.
  check("S1 no write exceeds the cap — exactly, no slack", maxLine <= LINE_CAP - 1, `maxLine=${maxLine}B cap=${LINE_CAP}B`);
  const truncated = lines.filter(l => /…\[\+\d+B truncated\]$/.test(l));
  check("S1 both oversized raw lines are present and marked truncated", truncated.length >= 2, `${truncated.length} truncated line(s)`);
  const bannerLine = truncated.find(l => l.startsWith("fake-codex banner"));
  check("S1 truncation keeps the HEAD (event identity survives)", Boolean(bannerLine), bannerLine ? bannerLine.slice(0, 40) : "missing");
  // EXACT arithmetic, no tolerance: the write is `<banner>\n` (beforeBytes+1 bytes); the marker's
  // worst-case width is reserved out of the budget, so kept = cap - reserve and dropped = total - kept.
  const reserve = Buffer.byteLength(`…[+${beforeBytes + 1}B truncated]\n`, "utf8");
  const expectKept = LINE_CAP - reserve;
  const expectDropped = beforeBytes + 1 - expectKept;
  const dropped = bannerLine && Number(bannerLine.match(/\+(\d+)B truncated/)[1]);
  check("S1 marker reports the dropped byte count EXACTLY", dropped === expectDropped, `dropped=${dropped}B expected=${expectDropped}B`);
  const bannerWrite = Buffer.byteLength(bannerLine || "", "utf8") + 1;
  check("S1 the truncated write is exactly the cap", bannerWrite === LINE_CAP, `${bannerWrite}B vs cap ${LINE_CAP}B`);

  // S1b — the boundary back-off, proven on 4-byte characters (m4: an all-ASCII payload cannot prove it).
  // Four lines with prefixes differing by one byte, so the cut lands mid-character on at least three.
  const emojiLines = truncated.filter(l => l.startsWith("fake-codex emoji"));
  check("S1b all four emoji-padded lines are present and truncated", emojiLines.length === 4, `${emojiLines.length}/4`);
  let backedOff = 0, cleanCuts = 0;
  for (const l of emojiLines) {
    const kept = l.slice(0, l.indexOf("…[+"));
    const keptBytes = Buffer.byteLength(kept, "utf8");
    const prefixBytes = keptBytes - (kept.match(/🙂/gu) || []).length * 4;
    // Whole characters only: strip the emoji and what remains must be the pure-ASCII prefix.
    const wholeChars = /^fake-codex emoji!* (🙂)*$/u.test(kept);
    if (!wholeChars) { check(`S1b line(prefix ${prefixBytes}B) cut a character in half`, false, kept.slice(-8)); break; }
    const emojiReserve = Buffer.byteLength(`…[+${Buffer.byteLength(l, "utf8") + 1}B truncated]\n`, "utf8");
    if (keptBytes < LINE_CAP - emojiReserve) backedOff++; else cleanCuts++;
  }
  check("S1b every kept prefix is a WHOLE number of characters (nothing cut in half)",
    emojiLines.length === 4, `${backedOff} needed back-off, ${cleanCuts} landed on a boundary`);
  check("S1b the back-off path actually ran (not just lucky alignment)", backedOff >= 3, `${backedOff}/4 lines backed off`);
  check("S1b no replacement character anywhere in the log", !raw.toString("utf8").includes("�"));

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

  // ---------- S6: omp — cross-chunk UTF-8, structured `content`, past-depth bodies ----------
  const s3 = makeServer({ AGENT_BRIDGE_STATE_DIR: STATE_C, OMP_BIN: FAKE_OMP, FAKE_OMP_MODE: "logstress" });
  await s3.init();
  const oid = (await s3.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 60000))?.session?.id;
  if (!oid) die("open omp failed");
  await s3.call("agent_bridge_send_message", { session_id: oid, message: "stress the log", wait: "all" }, 60000);
  await sleep(400);
  const ost = await s3.call("agent_bridge_status", { session_id: oid });
  const oraw = fs.readFileSync(ost?.session?.logFile, "utf8");
  const olines = oraw.split("\n").filter(Boolean);

  // M3 — the emoji was split across two stderr writes; a per-chunk decode yields two U+FFFD.
  // The two stderr writes are ~80ms apart, so unrelated log lines land BETWEEN them — assert on the two
  // halves, not on a contiguous string. The character itself is emitted whole with the SECOND write
  // (the stream decoder held the lead bytes); pre-fix this read "��:end".
  const splitHead = oraw.includes("[fake-omp] split:");
  const splitTail = oraw.includes("🙂:end");
  check("S6 cross-chunk stderr character reassembled whole", splitHead && splitTail,
    splitHead && splitTail ? "lead bytes held by the stream decoder, emitted with the next chunk"
      : oraw.includes("�") ? "found replacement characters (per-chunk decode)" : `head=${splitHead} tail=${splitTail}`);
  check("S6 no replacement character in the omp log", !oraw.includes("�"));

  // m2 — structured `content` recurses: tool identity survives, leaf bodies do not.
  const toolLine = olines.find(l => l.includes("tool_execution_end"));
  if (!toolLine) die("no tool_execution_end line in the omp log");
  const tool = JSON.parse(toolLine);
  check("S6 tool identity kept: toolName", tool.toolName === "Bash", String(tool.toolName));
  check("S6 structured content kept as a structure (not elided wholesale)", Array.isArray(tool.result?.content),
    JSON.stringify(tool.result?.content)?.slice(0, 60));
  check("S6 content block keeps type/name/id", tool.result.content[0]?.type === "tool_use" && tool.result.content[0]?.name === "Bash" && tool.result.content[0]?.id === "tu_1",
    JSON.stringify(tool.result.content[0])?.slice(0, 80));
  check("S6 content leaf bodies elided", tool.result.content.every(b => String(b.text).startsWith("<elided ")),
    JSON.stringify(tool.result.content.map(b => b.text)));
  check("S6 sibling `output` leaf elided, sibling structure kept",
    String(tool.result.details?.output).startsWith("<elided ") && tool.result.details?.resolvedPath === "/tmp/x",
    JSON.stringify(tool.result.details));

  // m1 — a body nested past the depth guard must not reach disk verbatim.
  const deepClean = !oraw.includes("DEEP_SECRET_BODY") && !oraw.includes("DEEP_SECRET_SCALAR");
  check("S6 body nested past the depth guard never reaches disk", deepClean,
    deepClean ? "no past-depth body on disk" : "found a past-depth body in the log");
  check("S6 past-depth subtree is elided, not passed through", oraw.includes("<elided deep object>"));
  check("S6 no tool payload anywhere in the omp log", !oraw.includes("LEAK_BODY"));
  await s3.call("agent_bridge_close_session", { session_id: oid });
  s3.kill();
  await sleep(300);

  // ---------- S7: claude `result` is the answer verbatim — must not land on disk ----------
  const s4 = makeServer({ AGENT_BRIDGE_STATE_DIR: STATE_D, CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: "bigresult" });
  await s4.init();
  const cid = (await s4.call("agent_bridge_open_session", { agent: "claude", cwd: CWD }, 60000))?.session?.id;
  if (!cid) die("open claude failed");
  const cres = await s4.call("agent_bridge_send_message", { session_id: cid, message: "answer me", wait: "all" }, 60000);
  await sleep(300);
  const cst = await s4.call("agent_bridge_status", { session_id: cid });
  const craw = fs.readFileSync(cst?.session?.logFile, "utf8");
  const resultLine = craw.split("\n").filter(Boolean).find(l => l.includes('"type":"result"'));
  if (!resultLine) die("no claude result line in the log");
  const rmsg = JSON.parse(resultLine);
  check("S7 claude result event is still logged (skeleton kept)", rmsg.type === "result" && "subtype" in rmsg, JSON.stringify(rmsg).slice(0, 90));
  check("S7 claude `result` answer elided (not 512 chars of it)", String(rmsg.result).startsWith("<elided "), String(rmsg.result).slice(0, 60));
  const cansw = cres?.text || "";
  check("S7 the answer itself is intact in the MCP result", cansw.length > 0, `${cansw.length} chars`);
  check("S7 no leading fragment of the answer on disk",
    cansw.length < 24 || !craw.includes(cansw.slice(0, 24)), `answer head: ${JSON.stringify(cansw.slice(0, 24))}`);
  await s4.call("agent_bridge_close_session", { session_id: cid });
  s4.kill();
  await sleep(300);

  // ---------- S8: exit journal stays PARSEABLE JSON when sessions overflow the write budget ----------
  // A small line cap reproduces the >45-session overflow without spawning 45 backends: the property
  // under test ("the producer trims whole elements so the line parses") is cap-independent.
  const s5 = makeServer({ AGENT_BRIDGE_STATE_DIR: STATE_E, OMP_BIN: FAKE_OMP, FAKE_OMP_MODE: "okturn", AGENT_BRIDGE_LOG_LINE_MAX_BYTES: "420" });
  await s5.init();
  const opened = [];
  for (let i = 0; i < 5; i++) {
    const oid2 = (await s5.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 60000))?.session?.id;
    if (oid2) opened.push(oid2);
  }
  check("S8 opened 5 concurrent sessions", opened.length === 5, `${opened.length}/5`);
  s5.srv.stdin.end(); // stdin EOF -> clean shutdown -> exit journal
  await sleep(2500);
  const journal = path.join(STATE_E, "exit-journal.jsonl");
  const jlines = fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean);
  let parsedAll = true, rec = null;
  for (const l of jlines) { try { rec = JSON.parse(l); } catch { parsedAll = false; } }
  console.log(`[evidence] exit-journal line = ${Buffer.byteLength(jlines[jlines.length - 1], "utf8")}B under a 420B write cap; ` +
    `sessionCount=${rec?.sessionCount} kept=${rec?.sessions?.length} omitted=${rec?.sessionsOmitted}`);
  check("S8 every exit-journal line is parseable JSON", parsedAll && Boolean(rec), `${jlines.length} line(s)`);
  check("S8 no line carries a truncation marker", !jlines.some(l => l.includes("truncated")));
  check("S8 the record fits the write budget", jlines.every(l => Buffer.byteLength(l, "utf8") + 1 <= 420));
  check("S8 trimming actually engaged (this is not a vacuous pass)", rec?.sessionsOmitted > 0, `omitted=${rec?.sessionsOmitted}`);
  check("S8 the total session count is reported honestly despite trimming", rec?.sessionCount === 5, `sessionCount=${rec?.sessionCount}`);
  check("S8 kept + omitted == total", rec?.sessions?.length + rec?.sessionsOmitted === 5,
    `${rec?.sessions?.length} + ${rec?.sessionsOmitted}`);
  check("S8 kept session entries are whole objects, not fragments",
    Array.isArray(rec?.sessions) && rec.sessions.length > 0 && rec.sessions.every(x => x && typeof x === "object" && "id" in x && "status" in x),
    JSON.stringify(rec?.sessions)?.slice(0, 80));
  s5.kill();
  await sleep(200);
} finally {
  for (const d of [STATE_A, STATE_B, STATE_C, STATE_D, STATE_E]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n[harness] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
