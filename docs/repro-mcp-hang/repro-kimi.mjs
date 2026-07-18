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
function makeServer(mode, extraEnv = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
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
  const init = async () => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-kimi", version: "0" } } });
    if (!await waitResp(id, 10000)) return fail(`no init (mode ${mode})`);
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { srv, call, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

const SESSION_ID_RE = /^session_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const openKimi = async (s, access = "read", extra = {}) => (await s.call("agent_bridge_open_session", { agent: "kimi", cwd: CWD, access, ...extra }, 30000));
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };
function cimCommandLine(pid) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}
// MUST mirror AGENTS.kimi.matchesCommand in scripts/agent-bridge.mjs (kept in sync by review). S-cleanup
// also exercises the REAL registry matcher (cleanupStalePidRecords) against a live spawned turn.
function matcherReplica(cmd) {
  const s = String(cmd).trim();
  const m = s.match(/^(?:"([^"]+)"|(\S+))(?=\s|$)/);
  const argv0 = m && (m[1] ?? m[2]);
  if (!argv0) return false;
  if (argv0.split(/[\\/]/).pop().toLowerCase() !== "kimi.exe") return false;
  const rest = s.slice(m[0].length);
  const i = rest.search(/(?:^|\s)-p\s+(?=\S)/);
  if (i < 0) return false;
  const head = rest.slice(0, i);
  return /(?:^|\s)--output-format\s+stream-json(?:\s|$)/.test(head);
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

  // ── S7: abort tree-kills a resumable turn → healthy idle + reusable; stale close doesn't clobber ───
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
    console.log("[harness] S7 OK — abort tree-kills a resumable turn → healthy idle; session reusable; stale close doesn't clobber the new turn");
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

  // ── S17: cleanup matcher — replica negatives + REAL cleanup path reaps a live kimi-shaped orphan ────
  {
    // Replica against the REAL captured turn command line (from S7) + synthetic negatives.
    if (!matcherReplica(capturedTurnCmd)) return fail(`matcher must match a REAL spawned turn command line, did not: ${JSON.stringify(capturedTurnCmd)}`);
    const notKimi = `"C:\\other\\node.exe" fake.js --output-format stream-json -S session_x -p "hi"`; // argv0 not kimi.exe
    if (matcherReplica(notKimi)) return fail("matcher must NOT match a non-kimi.exe argv0 even with the right flags");
    const promptHasFlags = `"C:\\tools\\kimi.exe" -p "please run --output-format stream-json -p foo now"`; // flags only inside the prompt
    if (matcherReplica(promptHasFlags)) return fail("matcher must NOT match when --output-format lives only in the prompt (no real flag before -p)");
    const bareP = `"C:\\tools\\kimi.exe" --output-format stream-json -p`; // trailing -p, no prompt arg
    if (matcherReplica(bareP)) return fail("matcher must NOT match a dangling -p with no prompt");
    const realTurn = `"C:\\tools\\kimi.exe" --output-format stream-json -S session_11111111-2222-4333-8444-555555555555 -m kimi-code/k3 -p "do work"`;
    if (!matcherReplica(realTurn)) return fail("matcher must match a well-formed kimi turn command line");

    // REAL cleanup path: spawn a live kimi-shaped orphan (the stub, hang mode), register a stale pid
    // record, and run the one-shot `cleanup` CLI — the REAL registry matcher must identify it.
    const turnArgs = ["--output-format", "stream-json", "-S", "session_22222222-3333-4444-8555-666666666666", "-m", "kimi-code/k3", "-p", "orphan work"];
    const orphan = spawn(stubExe, turnArgs, { windowsHide: true, env: { ...process.env, FAKE_KIMI_MODE: "hang", ...FAKE_ENV }, stdio: "ignore" });
    await sleep(700);
    if (!orphan.pid || !pidAlive(orphan.pid)) return fail("S17: could not start a live kimi-shaped orphan");
    const orphanCmd = cimCommandLine(orphan.pid);
    if (!matcherReplica(orphanCmd)) { try { orphan.kill("SIGKILL"); } catch {}; return fail(`S17: the spawned orphan's real command line does not match the replica: ${JSON.stringify(orphanCmd)}`); }
    const pidsDir = path.join(stateDir, "pids"); fs.mkdirSync(pidsDir, { recursive: true });
    const recFile = path.join(pidsDir, "kimi-orphan-test.json");
    fs.writeFileSync(recFile, JSON.stringify({
      id: "kimi-orphan-test", agent: "kimi", ownerPid: 999999, cwd: CWD, createdAt: new Date().toISOString(),
      processes: [{ role: "kimi-stream-json", pid: orphan.pid, command: [stubExe, ...turnArgs.slice(0, -1), "<prompt:redacted>"], spawnedAt: new Date().toISOString() }],
    }, null, 2));
    const out = spawnSync("node", [BRIDGE, "cleanup", "--json"], { encoding: "utf8", windowsHide: true, env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir } });
    let summary = null;
    try { summary = JSON.parse(out.stdout).childProcesses; } catch { try { orphan.kill("SIGKILL"); } catch {}; return fail(`S17: cleanup --json did not return JSON: ${out.stdout}\n${out.stderr}`); }
    const reaped = (summary?.terminated || []).some(t => t.role === "kimi-stream-json");
    const recGone = !fs.existsSync(recFile);
    try { orphan.kill("SIGKILL"); } catch {}
    for (let i = 0; i < 20 && pidAlive(orphan.pid); i++) await sleep(100);
    if (!reaped) return fail(`S17: real cleanup path did not identify the kimi orphan (matcher miss?). summary=${JSON.stringify(summary)}`);
    if (!recGone) return fail("S17: cleanup should remove the stale kimi pid record after acting on it");
    console.log("[harness] S17 OK — matcher replica negatives hold; REAL cleanupStalePidRecords identifies+acts on a kimi orphan (argv0=kimi.exe), record removed");
  }

  cleanupTmp();
  console.log("[harness] >>> PASS: Kimi backend — Shape B local-id/turn lifecycle, meta state machine, close-settlement, abort tree-kill, concurrency guard, contextUsage null, health five-state, resolveKimiBin native-only, doctor, cleanup matcher");
  await sleep(150);
  process.exit(0);
}

main().catch(e => { cleanupTmp(); fail(String(e?.stack || e)); });
