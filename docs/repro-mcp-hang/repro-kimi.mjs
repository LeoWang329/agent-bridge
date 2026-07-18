// Hermetic test suite for the Kimi Code backend (Shape B: a LOCAL session id + a per-turn short-lived
// process; no bridge-side create-chat). The bridge spawns the native `kimi.exe` DIRECTLY as
//   kimi.exe --output-format stream-json [-S session_<uuid>] [-m <model>] -p <prompt>
// so a renamed node.exe copy can't stand in (node chokes on `--output-format` as argv[1]), and
// resolveKimiBin + the cleanup matcher both REQUIRE argv0's basename to be literally `kimi.exe`. So this
// suite compiles a tiny REAL `kimi.exe` forwarder stub (C# console app via the in-box .NET compiler) that
// re-execs `node fake-kimi.js <the bridge's verbatim args>`; KIMI_BIN points the bridge at it. One server
// per FAKE_KIMI_MODE (mode is a server-wide env). Windows-only backend (v1).
//
// Covers (design §8): basic first turn (meta → chatId); multi-line assistant accumulation + tool_call;
// delayed-exit (close, not a `result` line, is the settlement boundary); exit0-without-meta → failed;
// nonzero exit → failed; continuation meta id mismatch → failed AND chatId NOT overwritten; abort tree-kill
// + reuse (stale close safe); first-turn abort → dead + send throws; concurrent send rejected; close during
// a turn; contextUsage null everywhere; the five health states; schema rejected / effort ignored;
// append_system first-turn user-prefix; resolveKimiBin (KIMI_BIN / default %USERPROFILE% / PATH; shim &
// non-file rejected); doctor kimi row; cleanup matcher (replica negatives + REAL cleanup path).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE_KIMI = path.join(HERE, "fake-kimi.js");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }

if (process.platform !== "win32") {
  console.log("[harness] kimi backend is Windows-only (v1); skipping repro-kimi on this platform.");
  process.exit(0);
}

// ── Build a temp workspace + compile the fake kimi.exe forwarder stub ────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fake-kimi-"));
const binDir = path.join(tmpRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
const stubExe = path.join(binDir, "kimi.exe");
const stateDir = path.join(tmpRoot, "state");
function cleanupTmp() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }

// A real console `kimi.exe` (argv0 must be kimi.exe for resolveKimiBin + the matcher) that forwards its
// VERBATIM command-line tail to `node fake-kimi.js …` — verbatim so a prompt's quoting/metachars round-trip
// through CreateProcess exactly, never re-parsed.
const CS_SRC = `using System;
using System.Diagnostics;
class KimiStub {
  static int Main() {
    string full = Environment.CommandLine;
    int idx;
    if (full.Length > 0 && full[0] == '"') { int q = full.IndexOf('"', 1); idx = (q < 0) ? full.Length : q + 1; }
    else { int sp = full.IndexOf(' '); idx = (sp < 0) ? full.Length : sp; }
    string tail = full.Substring(idx);
    string script = Environment.GetEnvironmentVariable("FAKE_KIMI_SCRIPT");
    string node = Environment.GetEnvironmentVariable("FAKE_KIMI_NODE");
    if (node == null || node.Length == 0) node = "node";
    var psi = new ProcessStartInfo(node, "\\"" + script + "\\"" + tail);
    psi.UseShellExecute = false;
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}`;
{
  const csFile = path.join(tmpRoot, "kimi-stub.cs");
  fs.writeFileSync(csFile, CS_SRC, "utf8");
  const ps = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${csFile}') -OutputType ConsoleApplication -OutputAssembly '${stubExe}'`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
  if (!fs.existsSync(stubExe)) { cleanupTmp(); fail(`could not compile fake kimi.exe stub (need the in-box .NET C# compiler):\n${r.stdout}\n${r.stderr}`); }
}

// Base env shared by fake-kimi turns: point the stub at the fake script + a deterministic node.
const FAKE_ENV = { FAKE_KIMI_SCRIPT: FAKE_KIMI, FAKE_KIMI_NODE: process.execPath };

// ── Minimal MCP client over one bridge server ────────────────────────────────────────────────────────
function makeServer(mode, extraEnv = {}, spawnOpts = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...spawnOpts,
    env: { ...process.env, KIMI_BIN: stubExe, FAKE_KIMI_MODE: mode, AGENT_BRIDGE_STATE_DIR: stateDir, ...FAKE_ENV, ...extraEnv },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr:${mode}] ${d}`));
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {}
    }
  });
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  let nextId = 1;
  const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(20); } return undefined; };
  const call = async (name, args, ms = 15000) => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await waitResp(id, ms);
    if (r === null) return fail(`${name}: server exited (mode ${mode}) exit=${JSON.stringify(exited)}`);
    if (r === undefined) return fail(`${name}: no response within ${ms}ms (mode ${mode})`);
    if (r.error) return { __error: r.error.message || JSON.stringify(r.error) };
    const t = r.result?.content?.[0]?.text;
    if (!t) return null;
    try { return JSON.parse(t); } catch { return t; } // doctor renders plain text, not JSON
  };
  // Fire-and-forget a tool call WITHOUT awaiting its response — used to race a `send` and an `abort`
  // (M3): the bridge dispatches each MCP line as it arrives, and a `send` handler runs synchronously to
  // its spawn-await before the next line is read, so an abort written right after lands in the pre-begin
  // window deterministically.
  const fire = (name, args) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); return id; };
  const init = async () => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-kimi", version: "0" } } });
    if (!await waitResp(id, 10000)) return fail(`no init (mode ${mode})`);
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  // Write TWO tool-calls in a SINGLE stdin write so the server's readline emits both lines synchronously
  // from one chunk: the first handler runs synchronously to its spawn-await before the second line is read.
  // This makes the send→close (or send→abort) ordering DETERMINISTIC (guaranteed pre-begin). Returns
  // [promise-for-resp1, promise-for-resp2].
  const fireBoth = (c1, c2, ms = 15000) => {
    const id1 = nextId++, id2 = nextId++;
    const line1 = JSON.stringify({ jsonrpc: "2.0", id: id1, method: "tools/call", params: { name: c1.name, arguments: c1.args } });
    const line2 = JSON.stringify({ jsonrpc: "2.0", id: id2, method: "tools/call", params: { name: c2.name, arguments: c2.args } });
    srv.stdin.write(`${line1}\n${line2}\n`); // ONE write → one chunk → ordered, in-tick delivery
    const grab = async id => { const r = await waitResp(id, ms); if (r === null || r === undefined) return fail(`fireBoth: no response for id ${id} (mode ${mode})`); if (r.error) return { __error: r.error.message || JSON.stringify(r.error) }; const t = r.result?.content?.[0]?.text; if (!t) return null; try { return JSON.parse(t); } catch { return t; } };
    return [grab(id1), grab(id2)];
  };
  return { srv, call, fire, fireBoth, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

const SESSION_ID_RE = /^session_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const openKimi = async (s, access = "read", extra = {}) => (await s.call("agent_bridge_open_session", { agent: "kimi", cwd: CWD, access, ...extra }, 30000));
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };
function cimCommandLine(pid) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}
// Exercise the REAL registry matcher / health derivation via the bridge's read-only `diag` entry — NOT a
// hand-copied replica (a replica hid M1). `diag match` returns the booleans AGENTS.kimi.matchesCommand
// (the exact function cleanup uses) yields for each command-line string; `diag health` returns
// deriveHealth() for a synthetic session object.
function realMatch(cmds) {
  const r = spawnSync("node", [BRIDGE, "diag", "match", "kimi-stream-json"], { input: JSON.stringify(cmds), encoding: "utf8", windowsHide: true });
  try { return JSON.parse(r.stdout); } catch { return fail(`diag match did not return JSON: ${r.stdout}\n${r.stderr}`); }
}
function realHealth(obj) {
  const r = spawnSync("node", [BRIDGE, "diag", "health"], { input: JSON.stringify(obj), encoding: "utf8", windowsHide: true });
  try { return JSON.parse(r.stdout); } catch { return fail(`diag health did not return JSON: ${r.stdout}\n${r.stderr}`); }
}

// Drive one turn to completion and return the wait result.
async function runTurn(s, sessId, message, ms = 12000) {
  await s.call("agent_bridge_send_message", { session_id: sessId, message });
  const w = await s.call("agent_bridge_wait", { session_ids: [sessId], mode: "all", timeout_ms: ms });
  return w?.results?.[0];
}

async function main() {
  // ── S1: basic first turn — meta captures chatId; contextUsage/effort/pid null; health healthy ──────
  {
    const s = makeServer("ok"); await s.init();
    const open = await openKimi(s);
    const sess = open?.session;
    if (!sess?.id) return fail(`open kimi (ok) failed: ${JSON.stringify(open)}`);
    if (sess.health !== "healthy") return fail(`fresh kimi session should be healthy, got ${JSON.stringify(sess.health)}`);
    if (sess.status !== "idle") return fail(`fresh kimi session should be idle, got ${sess.status}`);
    if (sess.contextUsage !== null) return fail(`kimi contextUsage must be null, got ${JSON.stringify(sess.contextUsage)}`);
    if (sess.effort !== null) return fail(`kimi effort must echo null, got ${JSON.stringify(sess.effort)}`);
    if (sess.agentSpecific?.chatId !== null) return fail(`fresh kimi chatId should be null (minted on first turn), got ${JSON.stringify(sess.agentSpecific?.chatId)}`);
    if (sess.pid !== null) return fail(`idle kimi session should have pid null, got ${JSON.stringify(sess.pid)}`);

    const rc = await runTurn(s, sess.id, "hi");
    if (rc?.text !== "hello from kimi") return fail(`turn text should be "hello from kimi", got ${JSON.stringify(rc?.text)}`);
    if (rc?.health !== "healthy") return fail(`completed turn health should be healthy, got ${JSON.stringify(rc?.health)}`);
    if (rc?.contextUsage !== null) return fail(`wait result contextUsage must be null, got ${JSON.stringify(rc?.contextUsage)}`);
    const res = await s.call("agent_bridge_result", { session_id: sess.id });
    if (res?.contextUsage !== null) return fail(`result() contextUsage must be null, got ${JSON.stringify(res?.contextUsage)}`);
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (st?.status !== "idle") return fail(`after turn, status should be idle, got ${st?.status}`);
    if (st?.contextUsage !== null) return fail(`status contextUsage must be null, got ${JSON.stringify(st?.contextUsage)}`);
    if (!SESSION_ID_RE.test(st?.agentSpecific?.chatId || "")) return fail(`chatId should be a session_<uuid>, got ${JSON.stringify(st?.agentSpecific?.chatId)}`);
    if (st?.health !== "healthy") return fail(`idle + chatId should be healthy, got ${JSON.stringify(st?.health)}`);
    if (st?.pid !== null) return fail(`between turns pid should be null, got ${JSON.stringify(st?.pid)}`);
    if (st?.agentSpecific?.turnCount !== 1) return fail(`turnCount should be 1, got ${JSON.stringify(st?.agentSpecific?.turnCount)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S1 OK — first turn mints chatId from meta; contextUsage null (4 places); healthy idle; pid null between turns; turnCount=1");
  }

  // ── S2: multi-line assistant accumulation + tool_call surfaced ─────────────────────────────────────
  {
    const s = makeServer("multiline"); await s.init();
    const sess = (await openKimi(s))?.session;
    const rc = await runTurn(s, sess.id, "do it");
    if (rc?.text !== "part one part two") return fail(`multiline final text should accumulate to "part one part two", got ${JSON.stringify(rc?.text)}`);
    const st = await s.call("agent_bridge_status", { session_id: sess.id });
    const evTypes = (st?.recentEvents || []).map(e => e.type);
    if (!evTypes.includes("tool_call")) return fail(`recentEvents should include a tool_call, got ${JSON.stringify(evTypes)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S2 OK — multi-line assistant content accumulates; tool_call surfaced");
  }

  // ── S3: delayed exit → CLOSE (not a result line) is the settlement boundary ────────────────────────
  {
    const s = makeServer("delayexit"); await s.init();
    const sess = (await openKimi(s))?.session;
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "slow finish" });
    await sleep(300); // meta emitted ~50ms in, but the process stays alive ~600ms more
    const mid = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (mid?.status !== "running") return fail(`turn must stay running until the process closes (settlement boundary), got status=${mid?.status}`);
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 5000 });
    const rc = w?.results?.[0];
    if (rc?.text !== "slow") return fail(`delayexit final text should be "slow", got ${JSON.stringify(rc?.text)}`);
    if (rc?.status !== "idle") return fail(`after the process exits, status should be idle, got ${rc?.status}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S3 OK — turn settles only on process close (still running after meta, before exit)");
  }

  // ── S4: exit0 WITHOUT meta → failed; first-turn (no chatId) → dead + send throws ───────────────────
  {
    const s = makeServer("nometa"); await s.init();
    const sess = (await openKimi(s))?.session;
    const rc = await runTurn(s, sess.id, "will not resume");
    if (rc?.status !== "failed") return fail(`exit0-without-meta should mark the turn failed, got ${rc?.status}`);
    if (rc?.health !== "dead") return fail(`a first turn with no meta captures no chatId → not reusable → dead, got ${JSON.stringify(rc?.health)}`);
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (!/without a session meta|resume hint|no session meta/i.test(st?.lastError || "")) return fail(`lastError should explain the missing meta, got ${JSON.stringify(st?.lastError)}`);
    if (st?.agentSpecific?.chatId !== null) return fail(`no meta → chatId stays null, got ${JSON.stringify(st?.agentSpecific?.chatId)}`);
    const send2 = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "again" });
    if (!send2?.__error || !/no chat to resume|reopen/i.test(send2.__error)) return fail(`send after a first-turn protocol failure should throw (no chat to resume), got ${JSON.stringify(send2)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S4 OK — exit0-without-meta → failed; first-turn no-chatId → dead + send throws");
  }

  // ── S5: nonzero exit → failed; but meta captured → degraded (reusable via chatId) ──────────────────
  {
    const s = makeServer("exitnonzero"); await s.init();
    const sess = (await openKimi(s))?.session;
    const rc = await runTurn(s, sess.id, "will exit nonzero");
    if (rc?.status !== "failed") return fail(`nonzero exit should mark the turn failed, got ${rc?.status}`);
    if (rc?.health !== "degraded") return fail(`nonzero exit but chatId captured → degraded (reusable), got ${JSON.stringify(rc?.health)}`);
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (!SESSION_ID_RE.test(st?.agentSpecific?.chatId || "")) return fail(`meta was emitted before the nonzero exit → chatId should be captured, got ${JSON.stringify(st?.agentSpecific?.chatId)}`);
    if (!/code 3|exit/i.test(st?.lastError || "")) return fail(`lastError should mention the nonzero exit, got ${JSON.stringify(st?.lastError)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S5 OK — nonzero exit → failed + degraded; chatId still captured from meta");
  }

  // ── S6: continuation meta id MISMATCH → failed AND chatId NOT overwritten ──────────────────────────
  {
    const s = makeServer("mismatch"); await s.init();
    const sess = (await openKimi(s))?.session;
    const rc1 = await runTurn(s, sess.id, "turn one");
    if (rc1?.text !== "first") return fail(`mismatch turn1 should succeed with "first", got ${JSON.stringify(rc1?.text)}`);
    const st1 = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    const chat1 = st1?.agentSpecific?.chatId;
    if (!SESSION_ID_RE.test(chat1 || "")) return fail(`turn1 should capture a chatId, got ${JSON.stringify(chat1)}`);
    const rc2 = await runTurn(s, sess.id, "turn two");
    if (rc2?.status !== "failed") return fail(`a continuation meta with a different session id must fail the turn, got ${rc2?.status}`);
    const st2 = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (st2?.agentSpecific?.chatId !== chat1) return fail(`chatId must NOT be overwritten by a mismatched continuation id (was ${chat1}, now ${st2?.agentSpecific?.chatId})`);
    if (st2?.health !== "degraded") return fail(`mismatch turn keeps the original chatId → reusable → degraded, got ${JSON.stringify(st2?.health)}`);
    if (!/protocol|mismatch|session id/i.test(st2?.lastError || "")) return fail(`lastError should explain the id mismatch, got ${JSON.stringify(st2?.lastError)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S6 OK — continuation id mismatch → failed, chatId preserved (never overwritten), degraded");
  }

  // ── S7: abort tree-kills a resumable turn → healthy idle + reusable ─────────────────────────────────
  // (Honest scope: abort() settles ONLY on the killed child's close, so the old child is fully gone before
  // the follow-up send — this is abort+reuse, NOT a late stale-close race. The genuine late stale-close
  // where an old child's close arrives AFTER a new turn began is exercised in S26 via the ENOENT-retry.)
  let capturedTurnCmd = "";
  {
    const s = makeServer("okthenhang"); await s.init();
    const sess = (await openKimi(s))?.session;
    const rc1 = await runTurn(s, sess.id, "establish chat"); // turn1 succeeds → chatId set
    if (rc1?.status !== "idle") return fail(`okthenhang turn1 should succeed, got ${rc1?.status}`);
    // turn2 (continuation) hangs; abort must tree-kill and keep the session reusable (chatId preserved).
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "long running" });
    let backendPid = null;
    for (let i = 0; i < 60; i++) { await sleep(150); const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.pid) { backendPid = st.pid; if (st.status === "running") break; } }
    if (!backendPid) return fail("S7: never observed a running turn process pid");
    capturedTurnCmd = cimCommandLine(backendPid);
    const ab = await s.call("agent_bridge_abort", { session_id: sess.id });
    if (!ab?.aborted) return fail(`abort should report aborted, got ${JSON.stringify(ab)}`);
    let post = null;
    for (let i = 0; i < 40; i++) { await sleep(150); post = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (post?.status === "idle") break; }
    if (post?.status !== "idle") return fail(`after abort, status should be idle, got ${post?.status}`);
    if (post?.health !== "healthy") return fail(`after abort, health should be healthy (chatId preserved, lastTurnError cleared), got ${JSON.stringify(post?.health)}`);
    let dead = false;
    for (let i = 0; i < 40; i++) { if (!pidAlive(backendPid)) { dead = true; break; } await sleep(150); }
    if (!dead) return fail(`abort must tree-kill the turn process; pid ${backendPid} still alive`);
    // Reusable: a follow-up send spawns a FRESH process (the stale close of the killed child must not clobber it).
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "again" });
    let reused = null;
    for (let i = 0; i < 40; i++) { await sleep(150); reused = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (reused?.pid && reused.status === "running") break; }
    if (!reused?.pid) return fail("after abort the session should be reusable (a new send spawns a new process)");
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S7 OK — abort tree-kills a resumable turn → healthy idle; session reusable (real late stale-close is S26)");
  }

  // ── S8: FIRST-turn abort (before any meta) → idle but dead (chatId null) + send throws ─────────────
  {
    const s = makeServer("hang"); await s.init();
    const sess = (await openKimi(s))?.session;
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "hang on turn one" });
    let bpid = null;
    for (let i = 0; i < 60; i++) { await sleep(150); const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.pid) { bpid = st.pid; break; } }
    if (!bpid) return fail("S8: never observed a running turn pid");
    await s.call("agent_bridge_abort", { session_id: sess.id });
    let post = null;
    for (let i = 0; i < 40; i++) { await sleep(150); post = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (post?.status === "idle") break; }
    if (post?.status !== "idle") return fail(`after first-turn abort, status should be idle (aborted), got ${post?.status}`);
    if (post?.agentSpecific?.turnCount !== 1) return fail(`first-turn abort should bump turnCount to 1, got ${JSON.stringify(post?.agentSpecific?.turnCount)}`);
    if (post?.agentSpecific?.chatId !== null) return fail(`first-turn abort → chatId still null, got ${JSON.stringify(post?.agentSpecific?.chatId)}`);
    if (post?.health !== "dead") return fail(`first-turn abort (no chatId, turnCount 1) → not reusable → dead, got ${JSON.stringify(post?.health)}`);
    const send2 = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "again" });
    if (!send2?.__error || !/no chat to resume|reopen/i.test(send2.__error)) return fail(`send after a first-turn abort should throw, got ${JSON.stringify(send2)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S8 OK — first-turn abort → idle+dead (turnCount 1, chatId null); send throws (needs reopen)");
  }

  // ── S9: concurrent send on a busy session is rejected ──────────────────────────────────────────────
  {
    const s = makeServer("hang"); await s.init();
    const sess = (await openKimi(s))?.session;
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "occupy the turn" });
    for (let i = 0; i < 40; i++) { await sleep(150); const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.status === "running") break; }
    const second = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "should be rejected" });
    if (!second?.__error || !/already has a running turn/i.test(second.__error)) return fail(`concurrent send should be rejected with "already has a running turn", got ${JSON.stringify(second)}`);
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S9 OK — concurrent send on a busy kimi session is rejected");
  }

  // ── S10: close DURING an in-flight turn → tree-kill + pid record removed ────────────────────────────
  {
    const s = makeServer("hang"); await s.init();
    const sess = (await openKimi(s))?.session;
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "long task" });
    let bpid = null;
    for (let i = 0; i < 40; i++) { await sleep(150); const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.pid) { bpid = st.pid; break; } }
    if (!bpid) return fail("S10: never observed a turn process pid");
    const pidFile = path.join(stateDir, "pids", `${sess.id}.json`);
    if (!fs.existsSync(pidFile)) return fail(`S10: pid record should exist during a turn (${pidFile})`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    let dead = false;
    for (let i = 0; i < 40; i++) { if (!pidAlive(bpid)) { dead = true; break; } await sleep(150); }
    if (!dead) return fail(`S10: close must tree-kill the in-flight turn; pid ${bpid} still alive`);
    let recGone = false;
    for (let i = 0; i < 60; i++) { if (!fs.existsSync(pidFile)) { recGone = true; break; } await sleep(150); }
    if (!recGone) return fail("S10: pid record should be removed after close (deferred to child close)");
    s.kill(); await sleep(150);
    console.log("[harness] S10 OK — close during a turn tree-kills the process and removes the pid record");
  }

  // ── S11: pid-record prompt privacy — the persisted command must NOT contain the prompt ─────────────
  {
    const marker = "SECRET_KIMI_PROMPT_7c1a";
    const s = makeServer("hang"); await s.init();
    const sess = (await openKimi(s))?.session;
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: `please ${marker} do work` });
    let rec = null;
    const pidFile = path.join(stateDir, "pids", `${sess.id}.json`);
    for (let i = 0; i < 40; i++) { await sleep(150); if (fs.existsSync(pidFile)) { rec = fs.readFileSync(pidFile, "utf8"); if ((await s.call("agent_bridge_status", { session_id: sess.id }))?.session?.status === "running") break; } }
    if (!rec) return fail("S11: no pid record captured");
    if (rec.includes(marker)) return fail(`S11: pid record LEAKED the prompt — must be redacted. record:\n${rec}`);
    if (!/<prompt:redacted>/.test(rec)) return fail(`S11: pid record command should carry the <prompt:redacted> placeholder, got:\n${rec}`);
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S11 OK — pid record redacts the prompt (<prompt:redacted>, no marker)");
  }

  // ── S12: capability gates — schema rejected (open + send), effort ignored (echoes null) ────────────
  {
    const s = makeServer("ok"); await s.init();
    const schemaOpen = await s.call("agent_bridge_open_session", { agent: "kimi", cwd: CWD, schema: { type: "object" } }, 30000);
    if (!schemaOpen?.__error || !/not supported for backend/i.test(schemaOpen.__error)) return fail(`kimi must reject schema at open, got ${JSON.stringify(schemaOpen)}`);
    const effOpen = await s.call("agent_bridge_open_session", { agent: "kimi", cwd: CWD, effort: "high" }, 30000);
    if (effOpen?.session?.effort !== null) return fail(`kimi must ignore effort and echo null, got ${JSON.stringify(effOpen?.session?.effort)}`);
    const sendSchema = await s.call("agent_bridge_send_message", { session_id: effOpen.session.id, message: "hi", schema: { type: "object" } });
    if (!sendSchema?.__error || !/not supported for backend/i.test(sendSchema.__error)) return fail(`kimi send must reject schema, got ${JSON.stringify(sendSchema)}`);
    await s.call("agent_bridge_close_session", { session_id: effOpen.session.id });
    s.kill(); await sleep(150);
    console.log("[harness] S12 OK — schema rejected (open + send); effort ignored (echoes null)");
  }

  // ── S13: append_system_prompt_file → first-turn user-prefix (turn 1 only), summary honest ──────────
  {
    const s = makeServer("echoprompt"); await s.init();
    const marker = "MARKER_KIMI_SYS_a1b2c3";
    const sysFile = path.join(tmpRoot, "role.md");
    fs.writeFileSync(sysFile, `You are the ${marker} reviewer. Stay in role.\n`, "utf8");
    const open = await s.call("agent_bridge_open_session", { agent: "kimi", cwd: CWD, access: "read", append_system_prompt_file: sysFile }, 30000);
    if (open?.__error) return fail(`kimi must ACCEPT append_system_prompt_file, got ${JSON.stringify(open)}`);
    const sess = open?.session;
    if (!sess?.appendSystemPrompt || sess.appendSystemPrompt.injectionMode !== "first-turn-user-prefix") return fail(`summary.appendSystemPrompt should report the injection honestly, got ${JSON.stringify(sess?.appendSystemPrompt)}`);
    const t1 = (await runTurn(s, sess.id, "USER_MSG_ONE"))?.text || "";
    if (!t1.includes(marker)) return fail(`turn 1 prompt should carry the injected system marker, got: ${JSON.stringify(t1.slice(0, 240))}`);
    if (!t1.includes("USER_MSG_ONE")) return fail(`turn 1 prompt should still carry the user message, got: ${JSON.stringify(t1.slice(0, 240))}`);
    const t2 = (await runTurn(s, sess.id, "USER_MSG_TWO"))?.text || "";
    if (t2.includes(marker)) return fail(`turn 2 must NOT re-inject the system prefix (first-turn only), got: ${JSON.stringify(t2.slice(0, 240))}`);
    if (!t2.includes("USER_MSG_TWO")) return fail(`turn 2 should carry its user message, got: ${JSON.stringify(t2.slice(0, 240))}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S13 OK — append_system injected as a first-turn user-prefix (turn 1 only); summary honest");
  }

  // ── S14: doctor reports the kimi row ok via the resolved native kimi.exe ────────────────────────────
  {
    const s = makeServer("ok"); await s.init();
    const doc = await s.call("agent_bridge_doctor", {});
    const text = typeof doc === "string" ? doc : JSON.stringify(doc);
    if (!/kimi:\s*ok/i.test(text) || !/0\.27\.0/.test(text)) return fail(`doctor should show kimi ok with the resolved kimi.exe version, got:\n${text}`);
    s.kill(); await sleep(150);
    console.log("[harness] S14 OK — doctor resolves the native kimi.exe and reports kimi ok 0.27.0");
  }

  // ── S15: resolveKimiBin rejections — missing file / .cmd shim / directory named kimi.exe ────────────
  {
    const missing = path.join(tmpRoot, "nope", "kimi.exe"); // parent dir absent
    const shim = path.join(tmpRoot, "shim", "kimi.cmd");
    fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.writeFileSync(shim, "@echo off\n", "utf8");
    const dirExe = path.join(tmpRoot, "asdir", "kimi.exe");
    fs.mkdirSync(dirExe, { recursive: true }); // a DIRECTORY literally named kimi.exe
    const cases = [
      ["missing", missing, /not an existing file|not found|no such/i],
      ["cmd shim", shim, /native kimi\.exe|kimi\.exe/i],
      ["directory", dirExe, /not an existing file|not a file|kimi\.exe/i],
    ];
    for (const [label, bin, re] of cases) {
      const s = makeServer("ok", { KIMI_BIN: bin }); await s.init();
      const open = await s.call("agent_bridge_open_session", { agent: "kimi", cwd: CWD, access: "read" }, 30000);
      if (!open?.__error || !re.test(open.__error)) { s.kill(); return fail(`resolveKimiBin should reject ${label} (${bin}); got ${JSON.stringify(open)}`); }
      s.kill(); await sleep(120);
    }
    console.log("[harness] S15 OK — resolveKimiBin rejects a missing file, a .cmd shim, and a directory named kimi.exe");
  }

  // ── S16: resolveKimiBin fallbacks — default %USERPROFILE%\.kimi-code\bin, and PATH (kimi.exe only) ──
  {
    // (a) default install path via USERPROFILE (KIMI_BIN unset). Isolate home so the box's real kimi
    //     install can't interfere; the stub lives under the fake home's .kimi-code\bin\kimi.exe.
    const homeA = path.join(tmpRoot, "homeA");
    const kimiHome = path.join(homeA, ".kimi-code", "bin");
    fs.mkdirSync(kimiHome, { recursive: true }); fs.copyFileSync(stubExe, path.join(kimiHome, "kimi.exe"));
    const sA = makeServer("ok", { KIMI_BIN: "", USERPROFILE: homeA }); await sA.init();
    const rcA = await runTurn(sA, (await openKimi(sA))?.session?.id, "hi");
    if (rcA?.text !== "hello from kimi") return fail(`default %USERPROFILE% resolution should work, got ${JSON.stringify(rcA?.text)}`);
    sA.kill(); await sleep(120);
    // (b) PATH fallback (KIMI_BIN unset, home has NO .kimi-code so path 2 misses → path 3 finds kimi.exe on PATH).
    const homeB = path.join(tmpRoot, "homeB"); fs.mkdirSync(homeB, { recursive: true });
    const sB = makeServer("ok", { KIMI_BIN: "", USERPROFILE: homeB, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }); await sB.init();
    const rcB = await runTurn(sB, (await openKimi(sB))?.session?.id, "hi");
    if (rcB?.text !== "hello from kimi") return fail(`PATH-fallback resolution should work, got ${JSON.stringify(rcB?.text)}`);
    sB.kill(); await sleep(120);
    console.log("[harness] S16 OK — resolveKimiBin resolves via default %USERPROFILE%\\.kimi-code\\bin and via PATH (kimi.exe only)");
  }

  // ── S17: cleanup matcher — REAL matcher (diag) incl. argv0 edge cases + REAL cleanup path (reap vs NOT-reap) ──
  {
    // Assert the REAL registry matcher (via `diag match`, NOT a replica — M4) on a matrix including the M1
    // argv0-faithfulness cases that no LIVE process can reproduce (embedded quote / leading whitespace).
    const matrix = [
      [capturedTurnCmd, true, "a REAL spawned turn command line (from S7)"],
      [`"C:\\other\\node.exe" fake.js --output-format stream-json -S session_x -p "hi"`, false, "argv0 not kimi.exe"],
      [`"C:\\tools\\kimi.exe" --output-format stream-json --note "hello -p world"`, false, "only `-p` is inside a quoted arg (M1)"],
      [`"C:\\tools\\kimi.exe" --output-format stream-json -p`, false, "dangling -p with no prompt"],
      [`C:\\Tmp\\ki"mi.exe" --output-format stream-json -p x`, false, "embedded `\"` in an UNQUOTED argv0 is literal → basename ki\"mi.exe\" (M1 argv0)"],
      [`   "C:\\tools\\kimi.exe" --output-format stream-json -p x`, false, "leading whitespace → empty argv0 (M1 argv0)"],
      [`C:\\tools\\kimi.exe --output-format stream-json -p realprompt`, true, "unquoted argv0, well-formed turn"],
      [`"C:\\tools\\kimi.exe" --output-format stream-json -S session_11111111-2222-4333-8444-555555555555 -m kimi-code/k3 -p "do work"`, true, "quoted argv0, well-formed turn"],
    ];
    const got = realMatch(matrix.map(m => m[0]));
    for (let i = 0; i < matrix.length; i++) if (got[i] !== matrix[i][1]) return fail(`S17: real matcher on «${matrix[i][2]}» → ${got[i]}, expected ${matrix[i][1]} (cmd=${JSON.stringify(matrix[i][0])})`);

    // A typo'd role must be REJECTED (exit≠0, error on stderr) — never read stdin and return all-false + exit 0,
    // which would pass a broken diagnostic off as a valid negative result ([review R4 — diag role allowlist]).
    const badRole = spawnSync("node", [BRIDGE, "diag", "match", "kimi-stream-jsom"], { input: JSON.stringify([capturedTurnCmd]), encoding: "utf8", windowsHide: true });
    if (badRole.status === 0) return fail(`S17: diag match with an unknown role must exit non-zero, got ${badRole.status} stdout=${JSON.stringify(badRole.stdout)}`);
    if (badRole.stdout.trim()) return fail(`S17: diag match with an unknown role must NOT emit a result to stdout, got ${JSON.stringify(badRole.stdout)}`);
    if (!/known <role>/i.test(badRole.stderr)) return fail(`S17: diag match should explain the unknown-role rejection on stderr, got ${JSON.stringify(badRole.stderr)}`);

    // Run a REAL cleanup over TWO live orphans: (P) a genuine turn shape that MUST be reaped, and (N) the
    // M1 false-positive shape (argv0=kimi.exe, --output-format stream-json, but `-p` only inside a quoted
    // arg) that MUST NOT be reaped. This drives the REAL registry matcher end-to-end (M4).
    const pArgs = ["--output-format", "stream-json", "-S", "session_22222222-3333-4444-8555-666666666666", "-m", "kimi-code/k3", "-p", "orphan work"];
    const nArgs = ["--output-format", "stream-json", "--note", "hello -p world"]; // no top-level -p
    const spawnOrphan = args => spawn(stubExe, args, { windowsHide: true, env: { ...process.env, FAKE_KIMI_MODE: "hang", ...FAKE_ENV }, stdio: "ignore" });
    const pOrphan = spawnOrphan(pArgs);
    const nOrphan = spawnOrphan(nArgs);
    await sleep(800);
    if (!pOrphan.pid || !pidAlive(pOrphan.pid) || !nOrphan.pid || !pidAlive(nOrphan.pid)) { for (const o of [pOrphan, nOrphan]) try { o.kill("SIGKILL"); } catch {}; return fail("S17: could not start both live orphans"); }
    if (!realMatch([cimCommandLine(pOrphan.pid)])[0]) { for (const o of [pOrphan, nOrphan]) try { o.kill("SIGKILL"); } catch {}; return fail(`S17: positive orphan's real cmdline should match: ${JSON.stringify(cimCommandLine(pOrphan.pid))}`); }
    const pidsDir = path.join(stateDir, "pids"); fs.mkdirSync(pidsDir, { recursive: true });
    const mkRec = (id, pid, args) => { const f = path.join(pidsDir, `${id}.json`); fs.writeFileSync(f, JSON.stringify({ id, agent: "kimi", ownerPid: 999999, cwd: CWD, createdAt: new Date().toISOString(), processes: [{ role: "kimi-stream-json", pid, command: [stubExe, ...args.slice(0, -1), "<prompt:redacted>"], spawnedAt: new Date().toISOString() }] }, null, 2)); return f; };
    const pRec = mkRec("kimi-orphan-pos", pOrphan.pid, pArgs);
    const nRec = mkRec("kimi-orphan-neg", nOrphan.pid, nArgs);
    const out = spawnSync("node", [BRIDGE, "cleanup", "--json"], { encoding: "utf8", windowsHide: true, env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir } });
    let summary = null;
    try { summary = JSON.parse(out.stdout).childProcesses; } catch { for (const o of [pOrphan, nOrphan]) try { o.kill("SIGKILL"); } catch {}; return fail(`S17: cleanup --json did not return JSON: ${out.stdout}\n${out.stderr}`); }
    const terminated = summary?.terminated || [];
    const reapedPos = terminated.some(t => t.pid === pOrphan.pid);
    const reapedNeg = terminated.some(t => t.pid === nOrphan.pid);
    const negAlive = pidAlive(nOrphan.pid); // the M1-shape process must be UNTOUCHED (security boundary)
    for (const o of [pOrphan, nOrphan]) { try { o.kill("SIGKILL"); } catch {} }
    for (let i = 0; i < 20 && (pidAlive(pOrphan.pid) || pidAlive(nOrphan.pid)); i++) await sleep(100);
    if (!reapedPos) return fail(`S17: real cleanup must identify the genuine kimi turn orphan (matcher miss?). summary=${JSON.stringify(summary)}`);
    if (reapedNeg) return fail(`S17: real cleanup must NOT terminate the M1 false-positive shape (quoted -p) — SECURITY BOUNDARY. summary=${JSON.stringify(summary)}`);
    if (!negAlive) return fail("S17: the M1 false-positive process was killed by cleanup — matcher over-matched (M1 regression)");
    if (fs.existsSync(pRec)) return fail("S17: cleanup should remove the reaped positive pid record");
    console.log("[harness] S17 OK — REAL matcher (diag) correct on the full matrix incl. argv0 edge cases (embedded quote / leading ws); live cleanup reaps a genuine turn AND leaves the M1 quoted-`-p` shape UNTOUCHED");
  }

  // ── S18: concurrent abort DURING send's spawn-await (pre-begin) must not be lost (M3) ──────────────
  {
    // send + abort in ONE stdin write → the server runs send synchronously to its spawn-await before reading
    // the abort line, so abort DETERMINISTICALLY lands in the pre-begin window (this.turn/this.proc set,
    // turnChild not yet). Before the M3 fix, #beginTurn reset userAborted → the killed child settled as a
    // phantom FAILED turn; after the fix it settles as aborted/idle. Repeat to be robust.
    const s = makeServer("hang"); await s.init();
    for (let attempt = 0; attempt < 10; attempt++) {
      const sess = (await openKimi(s))?.session;
      if (!sess?.id) return fail(`S18 attempt ${attempt}: open failed`);
      const [sp, ap] = s.fireBoth(
        { name: "agent_bridge_send_message", args: { session_id: sess.id, message: `race ${attempt}` } },
        { name: "agent_bridge_abort", args: { session_id: sess.id } },
      );
      await Promise.all([sp.catch(() => {}), ap.catch(() => {})]);
      let post = null;
      for (let i = 0; i < 80; i++) { await sleep(100); post = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (post && post.status !== "running" && post.status !== "starting") break; }
      if (!post) return fail(`S18 attempt ${attempt}: no settled status`);
      if (post.status === "failed") return fail(`S18 attempt ${attempt}: a concurrent abort during send was LOST → turn settled FAILED (lastError=${JSON.stringify(post.lastError)}); must settle aborted/idle (M3)`);
      if (post.status !== "idle") return fail(`S18 attempt ${attempt}: expected idle (aborted) after the race, got ${post.status}`);
      if (post.pid) return fail(`S18 attempt ${attempt}: backend pid ${post.pid} should be dead after the aborted turn`);
      if (post.agentSpecific?.turnCount !== 1) return fail(`S18 attempt ${attempt}: aborted first turn should bump turnCount to 1, got ${JSON.stringify(post.agentSpecific?.turnCount)}`);
      await s.call("agent_bridge_close_session", { session_id: sess.id });
    }
    s.kill(); await sleep(150);
    console.log("[harness] S18 OK — concurrent abort during send's spawn-await settles aborted/idle, never a phantom-failed turn (M3) ×10");
  }

  // ── S19: real OS spawn ENOENT (binary removed after start) → send fails, re-resolves, reusable ──────
  {
    // A dedicated kimi.exe we can delete mid-session (KIMI_BIN pins it). start() resolves+caches it; then
    // we delete it so the NEXT send's spawn hits a REAL ENOENT (not a resolver-at-start rejection). The
    // send must fail cleanly and the session must stay reusable; restoring the file lets a later send work.
    const delDir = path.join(tmpRoot, "delbin"); fs.mkdirSync(delDir, { recursive: true });
    const delKimi = path.join(delDir, "kimi.exe"); fs.copyFileSync(stubExe, delKimi);
    const s = makeServer("ok", { KIMI_BIN: delKimi }); await s.init();
    const sess = (await openKimi(s))?.session;
    if (!sess?.id) return fail("S19: open failed");
    fs.rmSync(delKimi, { force: true }); // vanish between turns (proc is null → deletable on Windows)
    const bad = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "will ENOENT" });
    if (!bad?.__error || !/exist|enoent|not found|kimi\.exe/i.test(bad.__error)) return fail(`S19: send should fail with a clear spawn/resolve error, got ${JSON.stringify(bad)}`);
    const midHealth = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session?.health;
    if (midHealth === "dead") return fail(`S19: a spawn-failed first turn must stay reusable (no turnCount bump), got health ${JSON.stringify(midHealth)}`);
    fs.copyFileSync(stubExe, delKimi); // restore → the session re-resolves and works
    const rc = await runTurn(s, sess.id, "now works");
    if (rc?.text !== "hello from kimi") return fail(`S19: after restoring the binary the session should work, got ${JSON.stringify(rc?.text)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S19 OK — real spawn ENOENT fails the send cleanly, session stays reusable, re-resolves after the binary returns");
  }

  // ── S20: cmdline over-limit + NUL prompts rejected; session stays reusable ──────────────────────────
  {
    const s = makeServer("ok"); await s.init();
    const sess = (await openKimi(s))?.session;
    const nul = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "bad prompt" });
    if (!nul?.__error || !/NUL/i.test(nul.__error)) return fail(`S20: a prompt containing NUL should be rejected, got ${JSON.stringify(nul)}`);
    const huge = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "x".repeat(40000) });
    if (!huge?.__error || !/too long/i.test(huge.__error)) return fail(`S20: an over-limit prompt should be rejected, got ${JSON.stringify(huge)}`);
    const rc = await runTurn(s, sess.id, "ok now");
    if (rc?.text !== "hello from kimi") return fail(`S20: session should still work after rejected sends, got ${JSON.stringify(rc?.text)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S20 OK — NUL + over-limit prompts rejected pre-spawn (turn released, no bump); session still usable");
  }

  // ── S21: a `role:"user"` prompt-echo line must never reach the log or events (privacy, Min1) ────────
  {
    const marker = "SECRET_USER_ECHO_MARKER_5e2d";
    const s = makeServer("userecho"); await s.init();
    const sess = (await openKimi(s))?.session;
    const rc = await runTurn(s, sess.id, `investigate ${marker} thoroughly`);
    if (rc?.text !== "ack") return fail(`S21: turn should complete with "ack", got ${JSON.stringify(rc?.text)}`);
    const evJson = JSON.stringify((await s.call("agent_bridge_status", { session_id: sess.id }))?.recentEvents || []);
    if (evJson.includes(marker)) return fail(`S21: the user prompt-echo leaked into events: ${evJson}`);
    const logText = fs.existsSync(sess.logFile) ? fs.readFileSync(sess.logFile, "utf8") : "";
    if (logText.includes(marker)) return fail(`S21: the user prompt-echo leaked into the log file ${sess.logFile}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S21 OK — a role:\"user\" echo line is dropped: no marker in events or the log (privacy)");
  }

  // ── S22: resolvedBin is ABSOLUTE — a RELATIVE KIMI_BIN works even when the session cwd ≠ server cwd (M2) ──
  {
    // Server cwd = tmpRoot; KIMI_BIN = "bin/kimi.exe" (relative to tmpRoot). The session cwd is CWD (the
    // repo, a DIFFERENT dir). If resolveKimiBin returned the relative string, send()'s spawn({cwd:session})
    // would resolve it against CWD and ENOENT. With absolutization it spawns correctly regardless.
    const s = makeServer("ok", { KIMI_BIN: path.join("bin", "kimi.exe") }, { cwd: tmpRoot }); await s.init();
    const sess = (await openKimi(s))?.session; // session cwd defaults to CWD (openKimi passes cwd: CWD)
    if (!sess?.id) return fail("S22: open with a relative KIMI_BIN failed at start (resolver)");
    const rc = await runTurn(s, sess.id, "relative bin");
    if (rc?.text !== "hello from kimi") return fail(`S22: a relative KIMI_BIN must resolve to an ABSOLUTE path so send works under a different session cwd; got ${JSON.stringify(rc?.text)} (M2)`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S22 OK — resolvedBin is absolutized: a relative KIMI_BIN works even when session cwd ≠ server cwd (M2)");
  }

  // ── S23: closed → dead — deriveHealth(closed)="dead" AND the session is removed (gone to the caller) ──
  {
    // Assert the design's health invariant directly against the REAL deriveHealth (a closed session is
    // removed from the map, so it can't be observed via status — use the read-only diag entry).
    if (realHealth({ status: "closed", chatId: "session_x", turnCount: 2 }) !== "dead") return fail(`S23: deriveHealth(closed) must be "dead", got ${JSON.stringify(realHealth({ status: "closed" }))}`);
    const s = makeServer("ok"); await s.init();
    const sess = (await openKimi(s))?.session;
    await runTurn(s, sess.id, "hi");
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    const after = await s.call("agent_bridge_status", { session_id: sess.id });
    if (!after?.__error || !/unknown session/i.test(after.__error)) return fail(`S23: a closed session should be gone (Unknown session), got ${JSON.stringify(after)}`);
    s.kill(); await sleep(150);
    console.log("[harness] S23 OK — deriveHealth(closed)=\"dead\"; a closed session is removed (status → Unknown session)");
  }

  // ── S24: send(wait:true) with a short timeout → the turn is aborted (not left running) ──────────────
  {
    const s = makeServer("hang"); await s.init();
    const sess = (await openKimi(s))?.session;
    // wait:true blocks inline; on timeout send() aborts its own turn and throws the timeout error.
    const r = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "will hang", wait: true, timeout_ms: 1200 }, 15000);
    if (!r?.__error || !/tim(e|ed) ?out/i.test(r.__error)) return fail(`S24: a wait:true send that times out should error with a timeout, got ${JSON.stringify(r)}`);
    let post = null;
    for (let i = 0; i < 50; i++) { await sleep(120); post = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (post && post.status !== "running" && post.status !== "starting") break; }
    if (post?.status !== "idle") return fail(`S24: after a wait timeout the turn must be aborted (idle), got ${post?.status}`);
    if (post?.pid) return fail(`S24: the timed-out turn's process should be tree-killed, pid ${post.pid} still set`);
    s.kill(); await sleep(150);
    console.log("[harness] S24 OK — send(wait:true) timeout aborts the turn (idle, process tree-killed), never left running");
  }

  // ── S25: concurrent close() DURING send's spawn-await (pre-begin) — NON-FAKE-PASSABLE ────────────────
  {
    const s = makeServer("hang"); await s.init();
    const sess = (await openKimi(s))?.session;
    // Send + close in ONE stdin write → the server runs send synchronously to its spawn-await (this.turn +
    // this.proc set, turn NOT begun) before reading the close line, so close DETERMINISTICALLY lands in the
    // pre-begin window: it sets status=closed + nulls this.turn, and send's post-spawn guard throws "was
    // closed during send". Capturing that exact error is the PROOF of pre-begin (a post-begin close would
    // return accepted:true then abort — a DIFFERENT branch — so this cannot silently pass on the wrong ordering).
    const [sendP, closeP] = s.fireBoth(
      { name: "agent_bridge_send_message", args: { session_id: sess.id, message: "pre-begin close" } },
      { name: "agent_bridge_close_session", args: { session_id: sess.id } },
    );
    const sendResp = await sendP; await closeP;
    if (!sendResp?.__error || !/closed during send/i.test(sendResp.__error)) return fail(`S25: send must hit the pre-begin "was closed during send" branch (proof of the spawn-await race); got ${JSON.stringify(sendResp)} — a post-begin close would have returned accepted:true`);
    const after = await s.call("agent_bridge_status", { session_id: sess.id });
    if (!after?.__error || !/unknown session/i.test(after.__error)) return fail(`S25: after a pre-begin close the session should be gone (no revival), got ${JSON.stringify(after)}`);
    // No double-settle / wedge: the SAME server still opens a fresh session cleanly.
    const reopened = await openKimi(s);
    if (!reopened?.session?.id) return fail(`S25: server should stay responsive after a pre-begin close race (reopen failed): ${JSON.stringify(reopened)}`);
    await s.call("agent_bridge_close_session", { session_id: reopened.session.id });
    s.kill(); await sleep(150);
    console.log("[harness] S25 OK — pre-begin close PROVEN via the \"was closed during send\" branch (non-fake-passable); session gone, no double-settle/revival, server responsive");
  }

  // ── S26: late stale-close — a superseded child's close arrives AFTER a new turn began; identity gate holds ─
  {
    // DETERMINISTIC + NON-FAKE-PASSABLE. The natural ENOENT-retry produces a superseded child whose close
    // predominantly arrives BEFORE the new child begins (harmless ordering), so it can't reliably exercise
    // the dangerous "old close AFTER new begin" case. Instead the bridge's env-gated test hook
    // (AGENT_BRIDGE_KIMI_TEST_STALE_CLOSE) synthesizes exactly that: right after #beginTurn it drives a
    // SUPERSEDED child's late close (dummy child !== this.proc, ENOENT code -4058) through #onChildClose.
    // The `this.proc===child` gate MUST ignore it — keep this.proc set (pid non-null) and NOT settle the
    // live turn. Non-fake-passable: with the gate removed, the injected close nulls this.proc (pid → null),
    // and the live child's own later close is then dropped (this.proc!==child) → the turn HANGS → wait fails.
    // Hermetic: normal KIMI_BIN=stub, no PATH/default-path resolution, so the real installed kimi can't leak in.
    const s = makeServer("hang", { AGENT_BRIDGE_KIMI_TEST_STALE_CLOSE: "1" }); await s.init();
    const sess = (await openKimi(s))?.session;
    if (!sess?.id) return fail("S26: open failed");
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "hold while a stale close is injected" });
    // Let the turn come up; the stale close was injected synchronously during send()'s begin.
    let st = null, backendPid = null;
    for (let i = 0; i < 60; i++) { await sleep(120); st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.pid) { backendPid = st.pid; if (st.status === "running") break; } }
    if (!backendPid) return fail("S26: never observed a running turn pid (the injected stale close may have nulled this.proc — gate removed?)");
    if (st?.status === "failed") return fail(`S26: the injected stale close must NOT settle the live turn (turnChild gate), but status=failed lastError=${JSON.stringify(st?.lastError)}`);
    if (st?.status !== "running") return fail(`S26: turn should still be running after the injected stale close, got ${st?.status}`);
    // The live child must NOT have been tree-killed by the injection; confirm it and that its log recorded
    // the superseded close (proving the stale close really flowed through #onChildClose and was gated out).
    if (!pidAlive(backendPid)) return fail(`S26: the live turn process must survive an injected stale close, pid ${backendPid} dead`);
    const logText = fs.existsSync(sess.logFile) ? fs.readFileSync(sess.logFile, "utf8") : "";
    if (!/kimi exited code=-4058/.test(logText)) return fail(`S26: the injected stale close should be recorded by #onChildClose (kimi exited code=-4058) in ${sess.logFile}`);
    // The session stays healthy/reusable: abort the (still hanging) live turn cleanly.
    const ab = await s.call("agent_bridge_abort", { session_id: sess.id });
    if (!ab?.aborted) return fail(`S26: abort after the injected stale close should succeed, got ${JSON.stringify(ab)}`);
    let post = null;
    for (let i = 0; i < 40; i++) { await sleep(120); post = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (post?.status === "idle") break; }
    if (post?.status !== "idle") return fail(`S26: after aborting the live turn, status should be idle, got ${post?.status}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(150);
    console.log("[harness] S26 OK — injected late stale-close (dummy child !== this.proc) is gated out (this.proc===child): pid preserved, live turn NOT settled/killed, superseded close logged");
  }

  cleanupTmp();
  console.log("[harness] >>> PASS: Kimi backend — Shape B lifecycle, meta state machine, close-settlement, abort tree-kill (pre-begin race + wait-timeout), spawn-ENOENT reuse, late stale-close, pre-begin close, cmdline limits, user-echo privacy, absolute bin resolution, health incl. closed→dead, doctor, cleanup matcher (REAL matcher incl. argv0 edge cases + live reap/not-reap)");
  await sleep(150);
  process.exit(0);
}

main().catch(e => { cleanupTmp(); fail(String(e?.stack || e)); });
