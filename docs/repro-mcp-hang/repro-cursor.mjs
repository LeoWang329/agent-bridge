// Hermetic test suite for the Cursor Agent backend (Shape B: cloud chat + per-turn short-lived
// process). Builds a FAKE install layout — <tmp>\cursor-agent\versions\<v>\{node.exe (hardlink of the
// real node), index.js (fake-cursor-index.js)} — points CURSOR_AGENT_BIN at it, and drives the real
// bridge over MCP. One server per FAKE_CURSOR_MODE (mode is a server-wide env). Windows-only backend.
//
// Covers (design §8): create-chat + basic turn; multi-block assistant + tool_call; result-then-delayed
// -exit (close is the settlement boundary, not result); exit-without-result (protocol error → failed);
// result is_error; abort tree-kill (→ idle, reusable, backend pid dead); concurrent send rejected;
// contextUsage null everywhere; doctor cursor row; cleanup matcher (both branches, against a REAL
// running turn command line + synthetic negatives).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }

if (process.platform !== "win32") {
  console.log("[harness] cursor backend is Windows-only (v1); skipping repro-cursor on this platform.");
  process.exit(0);
}

// ── Build the fake cursor install layout ───────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cursor-"));
const installRoot = path.join(tmpRoot, "cursor-agent");
const versionDir = path.join(installRoot, "versions", "2026.07.09-deadbeef");
// A stale/older version dir + a garbage dir to prove newest-wins + non-version dirs are ignored.
const olderDir = path.join(installRoot, "versions", "2026.07.08-cafe12");
fs.mkdirSync(versionDir, { recursive: true });
fs.mkdirSync(olderDir, { recursive: true });
fs.mkdirSync(path.join(installRoot, "versions", "not-a-version"), { recursive: true });
const nodeTarget = path.join(versionDir, "node.exe");
try { fs.linkSync(process.execPath, nodeTarget); } catch { fs.copyFileSync(process.execPath, nodeTarget); }
fs.copyFileSync(path.join(HERE, "fake-cursor-index.js"), path.join(versionDir, "index.js"));
// older dir intentionally has an index.js but NO node.exe → cursorPickLauncherFromDir must skip it and
// still pick the newest COMPLETE version dir (proves the both()-must-exist + newest-first logic).
fs.copyFileSync(path.join(HERE, "fake-cursor-index.js"), path.join(olderDir, "index.js"));

const stateDir = path.join(tmpRoot, "state"); // isolate pid records / logs from the real ~/.agent-bridge
const nodeTarget2 = nodeTarget; // alias for the direct-spawn cleanup test (S14)
function cleanupTmp() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }

// ── Minimal MCP client over one bridge server ──────────────────────────────────────────────────────
function makeServer(mode, extraEnv = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, CURSOR_AGENT_BIN: installRoot, FAKE_CURSOR_MODE: mode, AGENT_BRIDGE_STATE_DIR: stateDir, ...extraEnv },
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
  // Returns the parsed tool payload, or { __error } when the server returned a JSON-RPC error (e.g. a
  // rejected concurrent send), so callers can assert on rejections.
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
    rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-cursor", version: "0" } } });
    if (!await waitResp(id, 10000)) return fail(`no init (mode ${mode})`);
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  return { srv, call, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openCursor = async (s, access = "read") => (await s.call("agent_bridge_open_session", { agent: "cursor", cwd: CWD, access }, 30000))?.session;
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };
function cimCommandLine(pid) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}
// MUST mirror AGENTS.cursor.matchesCommand in scripts/agent-bridge.mjs (kept in sync by review). S9 also
// exercises the REAL cleanup path (cleanupStalePidRecords) against a live spawned turn.
function matcherReplica(cmd) {
  const head = String(cmd).split(/\s--\s/)[0];
  const isCursorEntry = /[\\/]cursor-agent[\\/](?:versions[\\/][^\\/]+[\\/])?index\.js/i.test(head);
  if (!isCursorEntry) return false;
  const turnBranch =
    /(?:^|\s)-p(?:\s|$)/.test(head) && /--output-format\s+stream-json/.test(head) && /(?:^|\s)--resume(?:\s|$)/.test(head);
  const startBranch = /(?:^|\s)create-chat(?:\s|$)/.test(head);
  return turnBranch || startBranch;
}

async function main() {
  // ── S1: create-chat + basic turn + contextUsage null ───────────────────────────────────────────
  {
    const s = makeServer("ok"); await s.init();
    const sess = await openCursor(s);
    if (!sess?.id) return fail("open cursor (ok) failed");
    if (sess.health !== "healthy") return fail(`fresh cursor session should be healthy, got ${JSON.stringify(sess.health)}`);
    if (sess.status !== "idle") return fail(`fresh cursor session should be idle, got ${sess.status}`);
    if (sess.contextUsage !== null) return fail(`cursor contextUsage must be null, got ${JSON.stringify(sess.contextUsage)}`);
    if (sess.effort !== null) return fail(`cursor effort must echo null, got ${JSON.stringify(sess.effort)}`);
    if (!UUID_RE.test(sess.agentSpecific?.chatId || "")) return fail(`chatId should be a UUID, got ${JSON.stringify(sess.agentSpecific?.chatId)}`);
    if (sess.pid !== null) return fail(`idle cursor session should have pid null (no process between turns), got ${JSON.stringify(sess.pid)}`);

    const ack = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "compute the answer" });
    if (!ack?.accepted) return fail(`send ack missing: ${JSON.stringify(ack)}`);
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    const rc = w?.results?.[0];
    if (rc?.text !== "FAKE_CURSOR_OK") return fail(`turn text should be "FAKE_CURSOR_OK", got ${JSON.stringify(rc?.text)}`);
    if (rc?.health !== "healthy") return fail(`completed turn health should be healthy, got ${JSON.stringify(rc?.health)}`);
    if (rc?.contextUsage !== null) return fail(`wait result contextUsage must be null, got ${JSON.stringify(rc?.contextUsage)}`);
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (st?.status !== "idle") return fail(`after turn, status should be idle, got ${st?.status}`);
    if (!st?.lastTurn?.endedAt) return fail(`lastTurn.endedAt should be set after a settled turn, got ${JSON.stringify(st?.lastTurn)}`);
    if (st?.pid !== null) return fail(`between turns pid should be null, got ${JSON.stringify(st?.pid)}`);
    if (st?.agentSpecific?.turnCount !== 1) return fail(`turnCount should be 1, got ${JSON.stringify(st?.agentSpecific?.turnCount)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S1 OK — create-chat→chatId, basic turn→FAKE_CURSOR_OK, contextUsage null, pid null between turns, turnCount=1");
  }

  // ── S2: multi-block assistant + tool_call; final text = result (not the AAA/BBB tail) ────────────
  {
    const s = makeServer("multiblock"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "do it" });
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    const rc = w?.results?.[0];
    if (rc?.text !== "FAKE_CURSOR_OK") return fail(`multiblock final text should be the result "FAKE_CURSOR_OK", got ${JSON.stringify(rc?.text)}`);
    const st = await s.call("agent_bridge_status", { session_id: sess.id });
    const evTypes = (st?.recentEvents || []).map(e => e.type);
    if (!evTypes.includes("tool_call")) return fail(`recentEvents should include a tool_call, got ${JSON.stringify(evTypes)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S2 OK — multi-block turn, tool_call surfaced, final text = result");
  }

  // ── S3: result-then-delayed-exit → CLOSE (not result) is the settlement boundary ────────────────
  {
    const s = makeServer("delayexit"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "slow finish" });
    await sleep(350); // result is emitted ~50ms in, but the process stays alive ~800ms more
    const mid = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (mid?.status !== "running") return fail(`turn must stay running after 'result' until the process closes, got status=${mid?.status} (close is the settlement boundary, §2.1)`);
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 5000 });
    const rc = w?.results?.[0];
    if (rc?.text !== "FAKE_CURSOR_OK") return fail(`delayexit final text should be "FAKE_CURSOR_OK", got ${JSON.stringify(rc?.text)}`);
    if (rc?.status !== "idle") return fail(`after the process exits, status should be idle, got ${rc?.status}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S3 OK — result emitted but turn settles only on process close (still running mid-flight)");
  }

  // ── S4: exit without a result → protocol error → failed/degraded, still reusable ────────────────
  {
    const s = makeServer("noresult"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "will not finish" });
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    const rc = w?.results?.[0];
    if (rc?.status !== "failed") return fail(`exit-without-result should mark the turn failed, got ${rc?.status}`);
    if (rc?.health !== "degraded") return fail(`failed-but-reusable cursor should be degraded (not dead — isReusable via chatId), got ${JSON.stringify(rc?.health)}`);
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    if (!/without a result/i.test(st?.lastError || "")) return fail(`lastError should explain the missing result, got ${JSON.stringify(st?.lastError)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S4 OK — exit-without-result → failed + degraded (reusable), lastError explains it");
  }

  // ── S5: result is_error → failed/degraded ───────────────────────────────────────────────────────
  {
    const s = makeServer("resulterror"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "will error" });
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    const rc = w?.results?.[0];
    if (rc?.status !== "failed") return fail(`result is_error should mark the turn failed, got ${rc?.status}`);
    if (rc?.health !== "degraded") return fail(`errored cursor turn should be degraded, got ${JSON.stringify(rc?.health)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S5 OK — result is_error → failed + degraded");
  }

  // ── S6: abort tree-kills the turn process → idle + reusable + pid dead; capture matcher input ────
  let capturedTurnCmd = "";
  {
    const s = makeServer("abort"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "long running task" });
    // Wait for the turn process to be up and streaming.
    let backendPid = null;
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
      if (st?.pid) { backendPid = st.pid; if (st.status === "running") break; }
    }
    if (!backendPid) return fail("abort: never observed a running turn process pid");
    capturedTurnCmd = cimCommandLine(backendPid); // real spawned turn command line (for S9 matcher)
    const ab = await s.call("agent_bridge_abort", { session_id: sess.id });
    if (!ab?.aborted) return fail(`abort should report aborted, got ${JSON.stringify(ab)}`);
    // Turn returns to a clean, reusable idle (aborted clears lastTurnError → healthy).
    let post = null;
    for (let i = 0; i < 40; i++) { await sleep(150); post = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (post?.status === "idle") break; }
    if (post?.status !== "idle") return fail(`after abort, status should be idle, got ${post?.status}`);
    if (post?.health !== "healthy") return fail(`after abort, health should be healthy (lastTurnError cleared), got ${JSON.stringify(post?.health)}`);
    // The tree was killed → backend pid gone.
    let dead = false;
    for (let i = 0; i < 40; i++) { if (!pidAlive(backendPid)) { dead = true; break; } await sleep(150); }
    if (!dead) return fail(`abort must tree-kill the turn process; pid ${backendPid} still alive`);
    // Reusable: a follow-up send starts a fresh process (the fake hangs again → abort it too).
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "again" });
    let reused = null;
    for (let i = 0; i < 40; i++) { await sleep(150); reused = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (reused?.pid) break; }
    if (!reused?.pid) return fail("after abort the session should be reusable (a new send spawns a new process)");
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S6 OK — abort tree-kills the turn (pid dead), returns to healthy idle, session reusable");
  }

  // ── S7: concurrent send on the same session is rejected ─────────────────────────────────────────
  {
    const s = makeServer("abort"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "occupy the turn" });
    // Wait until the turn is actually running so the second send hits the in-flight guard.
    for (let i = 0; i < 40; i++) { await sleep(150); const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.status === "running") break; }
    const second = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "should be rejected" });
    if (!second?.__error || !/already has a running turn/i.test(second.__error)) return fail(`concurrent send should be rejected with "already has a running turn", got ${JSON.stringify(second)}`);
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S7 OK — concurrent send on a busy cursor session is rejected");
  }

  // ── S8: doctor reports the cursor row available via the resolved node+index.js launcher ─────────
  {
    const s = makeServer("ok"); await s.init();
    const doc = await s.call("agent_bridge_doctor", {});
    // doctor returns rendered text via renderDoctor; assert the cursor line shows ok + our fake version.
    const text = typeof doc === "string" ? doc : JSON.stringify(doc);
    if (!/cursor:\s*ok/i.test(text) || !/fake-cursor 9\.9\.9/.test(text)) return fail(`doctor should show cursor ok with the resolved launcher version, got:\n${text}`);
    s.kill(); await sleep(200);
    console.log("[harness] S8 OK — doctor resolves node+index.js and reports cursor ok (never bare node.exe --version)");
  }

  // ── S9: cleanup matcher — REAL running turn cmd (turn branch) + synthetic start/negatives ────────
  {
    if (!matcherReplica(capturedTurnCmd)) return fail(`matcher must match a REAL spawned turn command line, did not: ${JSON.stringify(capturedTurnCmd)}`);
    const startCmd = `"${nodeTarget}" "${path.join(versionDir, "index.js")}" create-chat`;
    if (!matcherReplica(startCmd)) return fail(`matcher must match the create-chat start command, did not: ${startCmd}`);
    // Negatives:
    const notCursor = `"C:\\other\\node.exe" "C:\\other\\index.js" create-chat`; // no cursor-agent path segment
    if (matcherReplica(notCursor)) return fail("matcher must NOT match an unrelated node index.js create-chat");
    const cursorNoTurn = `"${nodeTarget}" "${path.join(versionDir, "index.js")}" -p --output-format stream-json --force`; // cursor entry but no --resume and not create-chat
    if (matcherReplica(cursorNoTurn)) return fail("matcher must NOT match a cursor index.js without --resume / create-chat");
    console.log("[harness] S9 OK — matcher matches real turn + create-chat, rejects non-cursor & incomplete cursor commands");
  }

  // ── S10: unresolvable launcher (bad CURSOR_AGENT_BIN) → open fails cleanly, no orphan ────────────
  {
    const badRoot = path.join(tmpRoot, "empty-install"); // exists but has no node.exe/index.js/versions\
    fs.mkdirSync(badRoot, { recursive: true });
    const s = makeServer("ok", { CURSOR_AGENT_BIN: badRoot }); await s.init();
    const open = await s.call("agent_bridge_open_session", { agent: "cursor", cwd: CWD, access: "read" }, 30000);
    if (!open?.__error || !/native launcher not found/i.test(open.__error)) return fail(`open with a bad CURSOR_AGENT_BIN should fail with "native launcher not found", got ${JSON.stringify(open)}`);
    s.kill(); await sleep(200);
    console.log("[harness] S10 OK — unresolvable launcher → open_session fails fast with a clear error");
  }

  // ── S11: NUL + over-limit prompt rejected; session stays reusable ────────────────────────────────
  {
    const s = makeServer("ok"); await s.init();
    const sess = await openCursor(s);
    const nul = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "bad\u0000prompt" });
    if (!nul?.__error || !/NUL/i.test(nul.__error)) return fail(`a prompt containing NUL should be rejected, got ${JSON.stringify(nul)}`);
    const huge = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "x".repeat(40000) });
    if (!huge?.__error || !/too long/i.test(huge.__error)) return fail(`an over-limit prompt should be rejected, got ${JSON.stringify(huge)}`);
    // Still reusable: a normal send completes.
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "ok now" });
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    if (w?.results?.[0]?.text !== "FAKE_CURSOR_OK") return fail(`session should still work after rejected sends, got ${JSON.stringify(w?.results?.[0]?.text)}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S11 OK — NUL + over-limit prompts rejected (turn released, no turnCount bump); session still usable");
  }

  // ── S12: close during an in-flight turn → process tree-killed, pid record gone, no residual ──────
  {
    const s = makeServer("abort"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "long task" });
    let bpid = null;
    for (let i = 0; i < 40; i++) { await sleep(150); const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session; if (st?.pid) { bpid = st.pid; break; } }
    if (!bpid) return fail("S12: never observed a turn process pid");
    const pidFile = path.join(stateDir, "pids", `${sess.id}.json`);
    if (!fs.existsSync(pidFile)) return fail(`S12: pid record should exist during a turn (${pidFile})`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    let dead = false;
    for (let i = 0; i < 40; i++) { if (!pidAlive(bpid)) { dead = true; break; } await sleep(150); }
    if (!dead) return fail(`S12: close must tree-kill the in-flight turn; pid ${bpid} still alive`);
    // The record removal is DEFERRED to the child's actual close (close() keeps a reap-able trail until
    // the kill is confirmed), so allow time for the 3s force-kill backstop to land on a windowless fake.
    let recGone = false;
    for (let i = 0; i < 60; i++) { if (!fs.existsSync(pidFile)) { recGone = true; break; } await sleep(150); }
    if (!recGone) return fail("S12: pid record should be removed after close (deferred to child close)");
    s.kill(); await sleep(200);
    console.log("[harness] S12 OK — close during a turn tree-kills the process and removes the pid record");
  }

  // ── S13: pid-record prompt privacy — the persisted command must NOT contain the prompt ───────────
  {
    const marker = "SECRET_PROMPT_MARKER_9f3a";
    const s = makeServer("abort"); await s.init();
    const sess = await openCursor(s);
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: `please ${marker} do work` });
    let rec = null;
    const pidFile = path.join(stateDir, "pids", `${sess.id}.json`);
    for (let i = 0; i < 40; i++) { await sleep(150); if (fs.existsSync(pidFile)) { rec = fs.readFileSync(pidFile, "utf8"); if ((await s.call("agent_bridge_status", { session_id: sess.id }))?.session?.status === "running") break; } }
    if (!rec) return fail("S13: no pid record captured");
    if (rec.includes(marker)) return fail(`S13: pid record LEAKED the prompt — must be redacted. record:\n${rec}`);
    if (!/<prompt:redacted>/.test(rec)) return fail(`S13: pid record command should carry the <prompt:redacted> placeholder, got:\n${rec}`);
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S13 OK — pid record redacts the prompt (<prompt:redacted>, no marker)");
  }

  // ── S14: REAL cleanup path reaps a live cursor-shaped orphan (not the copied regex) ──────────────
  {
    const uuid = "22222222-3333-4444-8555-666666666666";
    const turnArgs = [path.join(versionDir, "index.js"), "-p", "--resume", uuid, "--output-format", "stream-json", "--force", "--trust", "--workspace", CWD, "--", "orphan work"];
    const orphan = spawn(nodeTarget2, turnArgs, { windowsHide: true, env: { ...process.env, FAKE_CURSOR_MODE: "abort" }, stdio: "ignore" });
    await sleep(600); // let it come up
    if (!orphan.pid || !pidAlive(orphan.pid)) return fail("S14: could not start a live cursor-shaped orphan");
    const pidsDir = path.join(stateDir, "pids");
    fs.mkdirSync(pidsDir, { recursive: true });
    const recFile = path.join(pidsDir, "cursor-orphan-test.json");
    fs.writeFileSync(recFile, JSON.stringify({
      id: "cursor-orphan-test", agent: "cursor", ownerPid: 999999, cwd: CWD, createdAt: new Date().toISOString(),
      processes: [{ role: "cursor-stream-json", pid: orphan.pid, command: [nodeTarget2, ...turnArgs.slice(0, -1), "<prompt:redacted>"], spawnedAt: new Date().toISOString() }],
    }, null, 2));
    const out = spawnSync("node", [BRIDGE, "cleanup", "--json"], { encoding: "utf8", windowsHide: true, env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir } });
    let summary = null;
    try { summary = JSON.parse(out.stdout).childProcesses; } catch { try { orphan.kill("SIGKILL"); } catch {}; return fail(`S14: cleanup --json did not return JSON: ${out.stdout}\n${out.stderr}`); }
    // The load-bearing assertion: the REAL registry matcher (not the S9 replica) IDENTIFIED the bridge-
    // spawned cursor process and the cleanup path acted on it (terminated list + record removed). NOTE:
    // actual death is NOT asserted here — the one-shot `cleanup` CLI issues a graceful taskkill /T then
    // exits, so its 3s force-kill backstop can't fire; a windowless node can survive the graceful pass.
    // That is pre-existing, backend-agnostic CLI behavior (a long-lived MCP server's backstop DOES fire),
    // not a cursor concern. We kill the orphan ourselves below.
    const reaped = (summary?.terminated || []).some(t => t.role === "cursor-stream-json");
    const recGone = !fs.existsSync(recFile);
    try { orphan.kill("SIGKILL"); } catch {}
    for (let i = 0; i < 20 && pidAlive(orphan.pid); i++) await sleep(100);
    if (!reaped) return fail(`S14: real cleanup path did not identify the cursor orphan (matcher miss?). summary=${JSON.stringify(summary)}`);
    if (!recGone) return fail("S14: cleanup should remove the stale cursor pid record after acting on it");
    console.log("[harness] S14 OK — REAL cleanupStalePidRecords identifies+acts on a cursor orphan via the registry matcher, record removed");
  }

  // ── S15: capability gates — schema rejected, effort ignored; append_system ACCEPTED (see S16) ──────
  {
    const s = makeServer("ok"); await s.init();
    const schemaOpen = await s.call("agent_bridge_open_session", { agent: "cursor", cwd: CWD, schema: { type: "object" } }, 30000);
    if (!schemaOpen?.__error || !/schema .* not supported|not supported for backend/i.test(schemaOpen.__error)) return fail(`cursor must reject schema, got ${JSON.stringify(schemaOpen)}`);
    const effOpen = await s.call("agent_bridge_open_session", { agent: "cursor", cwd: CWD, effort: "high" }, 30000);
    if (effOpen?.session?.effort !== null) return fail(`cursor must ignore effort and echo null, got ${JSON.stringify(effOpen?.session?.effort)}`);
    const sendSchema = await s.call("agent_bridge_send_message", { session_id: effOpen.session.id, message: "hi", schema: { type: "object" } });
    if (!sendSchema?.__error || !/not supported for backend/i.test(sendSchema.__error)) return fail(`cursor send must reject schema, got ${JSON.stringify(sendSchema)}`);
    await s.call("agent_bridge_close_session", { session_id: effOpen.session.id });
    s.kill(); await sleep(200);
    console.log("[harness] S15 OK — capability gates: schema rejected pre-spawn; effort ignored (echoes null)");
  }

  // ── S16: append_system_prompt_file → injected as a first-turn user-prefix (NOT on turn 2) ─────────
  {
    const s = makeServer("echoprompt"); await s.init(); // fake echoes the received prompt back as the result
    const marker = "MARKER_SYSPROMPT_a1b2c3";
    const sysFile = path.join(tmpRoot, "role.md");
    fs.writeFileSync(sysFile, `You are the ${marker} reviewer. Stay in role.\n`, "utf8");
    const open = await s.call("agent_bridge_open_session", { agent: "cursor", cwd: CWD, access: "read", append_system_prompt_file: sysFile }, 30000);
    if (open?.__error) return fail(`cursor must ACCEPT append_system_prompt_file now, got ${JSON.stringify(open)}`);
    const sess = open?.session;
    if (!sess?.appendSystemPrompt || sess.appendSystemPrompt.injectionMode !== "first-turn-user-prefix") return fail(`summary.appendSystemPrompt should report the injection honestly, got ${JSON.stringify(sess?.appendSystemPrompt)}`);
    // Turn 1: the echoed prompt must contain the system marker AND the user message.
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "USER_MSG_ONE" });
    const w1 = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    const t1 = w1?.results?.[0]?.text || "";
    if (!t1.includes(marker)) return fail(`turn 1 prompt should carry the injected system marker, got: ${JSON.stringify(t1.slice(0, 200))}`);
    if (!t1.includes("USER_MSG_ONE")) return fail(`turn 1 prompt should still carry the user message, got: ${JSON.stringify(t1.slice(0, 200))}`);
    // Turn 2: the system marker must NOT reappear (first-turn only); the user message must.
    await s.call("agent_bridge_send_message", { session_id: sess.id, message: "USER_MSG_TWO" });
    const w2 = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 12000 });
    const t2 = w2?.results?.[0]?.text || "";
    if (t2.includes(marker)) return fail(`turn 2 must NOT re-inject the system prefix (first-turn only), got: ${JSON.stringify(t2.slice(0, 200))}`);
    if (!t2.includes("USER_MSG_TWO")) return fail(`turn 2 should carry its user message, got: ${JSON.stringify(t2.slice(0, 200))}`);
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill(); await sleep(200);
    console.log("[harness] S16 OK — append_system injected as a first-turn user-prefix (turn 1 only), summary reports it honestly");
  }

  cleanupTmp();
  console.log("[harness] >>> PASS: Cursor backend — Shape B create-chat/turn lifecycle, close-settlement state machine, abort tree-kill, concurrency guard, contextUsage null, doctor, cleanup matcher");
  await sleep(200);
  process.exit(0);
}

main().catch(e => { cleanupTmp(); fail(String(e?.stack || e)); });
