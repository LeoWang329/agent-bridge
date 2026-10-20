// Hermetic test suite for the DSH (DeepSeek Harness) ACP backend.
//
// The bridge spawns `dsh --profile acp [--patch <tmp>]` (one persistent process per bridge session)
// and speaks newline-delimited JSON-RPC 2.0 over stdio. This suite points DSH_BIN at
// tests/fake-dsh.cmd|sh, which emulates that wire deterministically (see tests/fake-dsh.mjs for the
// mode list + trace format). No real DSH tree, Electron host, DSH_HOME or model call is touched.
//
// Covers: open/session shape, model+effort pinning through ACP config options, appended system prompt
// via a generated --patch (trace-asserted), read/write tier env, streaming accumulation, tool/usage
// events, contextUsage from usage_update, non-JSON stdout tolerance, benign stderr, abort/cancel with a
// reusable session, wait-timeout+abort recovery, busy-send rejection, close (idle / in-flight / forced),
// turn error + process crash paths, open-failure paths (init/new/hang) with no orphaned fake process,
// env-context scrubbing, late updates ignored, same-flush turns, schema rejection, doctor row, the real
// registry matcher (diag match), and orphan reclamation through the real cleanup CLI.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "..");
const IS_WINDOWS = process.platform === "win32";
const FAKE_DSH = path.join(HERE, IS_WINDOWS ? "fake-dsh.cmd" : "fake-dsh.sh");
if (!IS_WINDOWS) { try { fs.chmodSync(FAKE_DSH, 0o755); } catch {} }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }
function check(label, cond, detail = "") {
  console.log(`[check] ${label}: ${cond ? "OK" : "FAIL"}${cond || !detail ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repro-dsh-"));
const tracesDir = path.join(tmpRoot, "traces");
fs.mkdirSync(tracesDir, { recursive: true });
function cleanupTmp() { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } }
async function waitDead(pid, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!pidAlive(pid)) return true; await sleep(50); } return false; }

// ── minimal MCP client over one bridge server ────────────────────────────────────────────────────────
let serverSeq = 0;
function makeServer(tag, modes, extraEnv = {}, spawnOpts = {}) {
  serverSeq += 1;
  const stateDir = path.join(tmpRoot, `state-${tag}`);
  const traceFile = path.join(tracesDir, `${tag}.jsonl`);
  fs.mkdirSync(stateDir, { recursive: true });
  const srv = spawn(process.execPath, [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...spawnOpts,
    env: {
      ...process.env,
      DSH_BIN: FAKE_DSH,
      FAKE_DSH_MODES: modes,
      FAKE_DSH_TRACE: traceFile,
      AGENT_BRIDGE_STATE_DIR: stateDir,
      ...extraEnv,
    },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr:${tag}] ${d}`));
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
  let nextId = 1;
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(20); } return undefined; };
  const call = async (name, args, ms = 20000) => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await waitResp(id, ms);
    if (r === null) return fail(`${tag}: ${name}: server exited exit=${JSON.stringify(exited)}`);
    if (r === undefined) return fail(`${tag}: ${name}: no response within ${ms}ms`);
    if (r.error) return { __error: r.error.message || JSON.stringify(r.error) };
    const t = r.result?.content?.[0]?.text;
    if (!t) return null;
    try { return JSON.parse(t); } catch { return t; }
  };
  const fire = (name, args) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); return id; };
  const init = async () => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-dsh", version: "0" } } });
    if (!await waitResp(id, 10000)) return fail(`${tag}: no MCP init response`);
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  const trace = () => {
    try {
      return fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  return { srv, call, fire, init, trace, stateDir, traceFile, kill: () => { try { srv.kill("SIGKILL"); } catch {} }, exited: () => exited };
}

const openDsh = async (s, access = "read", extra = {}) => s.call("agent_bridge_open_session", { agent: "dsh", cwd: CWD, access, ...extra }, 40000);
const runTurn = async (s, sessionId, message, ms = 15000) => {
  await s.call("agent_bridge_send_message", { session_id: sessionId, message });
  const w = await s.call("agent_bridge_wait", { session_ids: [sessionId], mode: "all", timeout_ms: ms });
  return w?.results?.[0];
};
const fakeStartup = trace => trace.find(r => r && r.ev === "start");
const traceReqs = (trace, method) => trace.filter(r => r && r.ev === "request" && r.method === method);
const writePromptFile = (name, text) => { const p = path.join(tmpRoot, name); fs.writeFileSync(p, text); return p; };

async function main() {
  // ── S1: basic lifecycle — persistent pid, ACP session id, first turn, contextUsage ───────────────
  {
    const s = makeServer("s1", "ok"); await s.init();
    const open = await openDsh(s);
    const sess = open?.session;
    if (!sess?.id) return fail(`S1: open failed: ${JSON.stringify(open)}`);
    check("S1: fresh session idle + healthy", sess.status === "idle" && sess.health === "healthy", JSON.stringify({ status: sess.status, health: sess.health }));
    check("S1: persistent process has a pid while idle", Number.isInteger(sess.pid) && sess.pid > 0, JSON.stringify(sess.pid));
    check("S1: contextUsage null before any turn", sess.contextUsage === null, JSON.stringify(sess.contextUsage));
    check("S1: agentSpecific.acpSessionId is a uuid-ish string", typeof sess.agentSpecific?.acpSessionId === "string" && sess.agentSpecific.acpSessionId.length > 8);
    check("S1: model/effort echo null when unset", sess.model === null && sess.effort === null);
    const tr = s.trace();
    const start = fakeStartup(tr);
    check("S1: spawned with --profile acp", !!start && start.argv?.join(" ").includes("--profile acp"), JSON.stringify(start?.argv));
    check("S1: read tier → DSH_PERMISSION_MODE=read-only", start?.envSubset?.DSH_PERMISSION_MODE === "read-only", JSON.stringify(start?.envSubset));
    check("S1: no --patch when no append prompt", start?.patchPath == null || start?.patchPath === undefined || start?.patchPath === "", JSON.stringify(start?.patchPath));
    const newReq = traceReqs(tr, "session/new")[0];
    check("S1: session/new sent cwd + empty mcpServers", newReq && newReq.cwd === CWD && Array.isArray(newReq.mcpServers) && newReq.mcpServers.length === 0, JSON.stringify(newReq));
    const rc = await runTurn(s, sess.id, "hello");
    check("S1: turn text", rc?.text === "FAKE_DSH_OK", JSON.stringify(rc?.text));
    check("S1: turn is settled", rc?.turnSettled === true, JSON.stringify(rc?.turnSettled));
    check("S1: contextUsage from usage_update (8816, live:false)", rc?.contextUsage?.tokens === 8816 && rc?.contextUsage?.live === false, JSON.stringify(rc?.contextUsage));
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    check("S1: idle after turn + healthy + turnCount 1", st?.status === "idle" && st?.health === "healthy" && st?.agentSpecific?.turnCount === 1, JSON.stringify({ status: st?.status, health: st?.health, turnCount: st?.agentSpecific?.turnCount }));
    const closed = await s.call("agent_bridge_close_session", { session_id: sess.id });
    check("S1: close returns closed", closed?.closed === true, JSON.stringify(closed));
    check("S1: fake process gone after close", await waitDead(sess.pid));
    s.kill();
  }

  // ── S2: model/effort pinning + appended system prompt via generated --patch ─────────────────────
  {
    const roleFile = writePromptFile("role-s2.md", "You are Reviewer-7.\nReply in one short sentence.\nSECRET: R7-42\n");
    const s = makeServer("s2", "ok"); await s.init();
    const open = await openDsh(s, "read", { model: "deepseek-v4-pro", effort: "xhigh", append_system_prompt_file: roleFile });
    const sess = open?.session;
    if (!sess?.id) return fail(`S2: open failed: ${JSON.stringify(open)}`);
    check("S2: model echoes the friendly name", sess.model === "deepseek-v4-pro", JSON.stringify(sess.model));
    check("S2: effort echoes the friendly name", sess.effort === "xhigh", JSON.stringify(sess.effort));
    const ap = sess.appendSystemPrompt ?? null;
    const real = p => { try { return fs.realpathSync.native(p); } catch { return p; } };
    check(
      "S2: appendSystemPrompt summary is a true system prompt",
      ap?.injectionMode === "system" && real(ap?.file ?? "") === real(roleFile),
      JSON.stringify({ want: roleFile, got: ap, realWant: real(roleFile), realGot: real(ap?.file ?? "") }),
    );
    const tr = s.trace();
    const start = fakeStartup(tr);
    check("S2: --patch passed for the session prompt", typeof start?.patchPath === "string" && start.patchPath.length > 0, JSON.stringify(start?.patchPath));
    check("S2: patch carries personaPrefix + personaSuffix role text", String(start?.patchContent || "").includes("personaPrefix") && String(start?.patchContent || "").includes("Reviewer-7") && String(start?.patchContent || "").includes("SECRET: R7-42"), JSON.stringify(String(start?.patchContent || "").slice(0, 400)));
    const setModel = traceReqs(tr, "session/set_config_option").find(r => r.configId === "model");
    const setEffort = traceReqs(tr, "session/set_config_option").find(r => r.configId === "reasoning_effort");
    check("S2: model pinned to the advertised opaque value", setModel?.value === JSON.stringify(["deepseek-official", "deepseek-v4-pro"]), JSON.stringify(setModel?.value));
    check("S2: xhigh → max reasoning effort", setEffort?.value === "max", JSON.stringify(setEffort?.value));
    const rc = await runTurn(s, sess.id, "hi");
    check("S2: turn still works with pinned options", rc?.text === "FAKE_DSH_OK", JSON.stringify(rc?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill();
  }

  // ── S3: invalid model / effort fail fast, no orphaned fake process ──────────────────────────────
  for (const [tag, extra, needle] of [
    ["model", { model: "not-a-model" }, "not offered"],
    ["effort", { effort: "turbo" }, "reasoning effort"],
  ]) {
    const s = makeServer(`s3-${tag}`, "ok"); await s.init();
    const open = await openDsh(s, "read", extra);
    check(`S3: invalid ${tag} open fails`, typeof open?.__error === "string" && open.__error.includes(needle), JSON.stringify(open?.__error));
    const start = fakeStartup(s.trace());
    if (start?.pid) check(`S3: invalid ${tag} leaves no orphaned fake process`, await waitDead(start.pid));
    s.kill();
  }

  // ── S4: write tier → danger-full-access ─────────────────────────────────────────────────────────
  {
    const s = makeServer("s4", "ok"); await s.init();
    const open = await openDsh(s, "write");
    const sess = open?.session;
    if (!sess?.id) return fail(`S4: open write failed: ${JSON.stringify(open)}`);
    check("S4: write tier echoed", sess.access === "write" && sess.write === true);
    check("S4: write tier → DSH_PERMISSION_MODE=danger-full-access", fakeStartup(s.trace())?.envSubset?.DSH_PERMISSION_MODE === "danger-full-access", JSON.stringify(fakeStartup(s.trace())?.envSubset));
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill();
  }

  // ── S5: chunk accumulation + tool events + benign stderr + non-JSON stdout ──────────────────────
  {
    const s = makeServer("s5", "echo,streamchunks,toolcall,noisy,badjson,stderrwarn"); await s.init();
    const open = await openDsh(s);
    const sess = open?.session;
    if (!sess?.id) return fail(`S5: open failed: ${JSON.stringify(open)}`);
    const rc = await runTurn(s, sess.id, "split me");
    check("S5: split chunks concatenate in order", rc?.text === "FAKE_DSH_OK:split me", JSON.stringify(rc?.text));
    check("S5: benign stderr is captured, not fatal", rc?.health === "healthy", JSON.stringify(rc?.health));
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    check("S5: lastStderr records the benign line", typeof st?.lastStderr === "string" && /benign/i.test(st.lastStderr), JSON.stringify(st?.lastStderr));
    const events = (await s.call("agent_bridge_status", { session_id: sess.id }))?.recentEvents ?? [];
    check("S5: tool lifecycle events surfaced", events.some(e => e.type === "tool_call") && events.some(e => e.type === "tool_call_update"), JSON.stringify(events.map(e => e.type)));
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    s.kill();
  }

  // ── S6: usage variants — no usage → null; several usage → last value ────────────────────────────
  {
    const s = makeServer("s6a", "nousage"); await s.init();
    const o = await openDsh(s); const r = await runTurn(s, o.session.id, "x");
    check("S6: no usage → contextUsage null", r?.contextUsage === null, JSON.stringify(r?.contextUsage));
    await s.call("agent_bridge_close_session", { session_id: o.session.id }); s.kill();
  }
  {
    const s = makeServer("s6b", "usageonly"); await s.init();
    const o = await openDsh(s); const r = await runTurn(s, o.session.id, "x");
    check("S6: several usage updates → last used value", r?.contextUsage?.tokens === 8816 && r?.contextUsage?.live === false, JSON.stringify(r?.contextUsage));
    await s.call("agent_bridge_close_session", { session_id: o.session.id }); s.kill();
  }

  // ── S7: abort during a hung turn → cancelled, session stays usable (same process) ───────────────
  {
    const s = makeServer("s7", "cancel"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    s.fire("agent_bridge_send_message", { session_id: sess.id, message: "long one" });
    await sleep(700); // fake hangs after its thought chunk → turn is definitely in flight
    const ab = await s.call("agent_bridge_abort", { session_id: sess.id }, 15000);
    check("S7: abort returns aborted", ab?.aborted === true, JSON.stringify(ab));
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 10000 });
    const rc = w?.results?.[0];
    check("S7: cancelled turn settles as aborted (not failed)", rc && rc.turnSettled === true && !String(rc.lastError ?? "").includes("exited"), JSON.stringify({ text: rc?.text, health: rc?.health, lastError: rc?.lastError }));
    const st1 = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    check("S7: same persistent process after abort", st1?.pid === sess.pid, JSON.stringify({ before: sess.pid, after: st1?.pid }));
    const rc2 = await runTurn(s, sess.id, "again");
    check("S7: session reusable after abort", rc2?.text === "FAKE_DSH_OK", JSON.stringify(rc2?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }

  // ── S8: wait timeout triggers abort, session recovers ───────────────────────────────────────────
  {
    const s = makeServer("s8", "cancel"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    const r1 = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "hang please", wait: true, timeout_ms: 1200 }, 20000);
    check("S8: inline wait timeout surfaces an error", typeof r1?.__error === "string" || r1?.inProgress === true || r1?.turnSettled === false, JSON.stringify(r1));
    // The timeout path aborts; the fake's FIRST prompt is the cancel-mode one, so a second prompt settles.
    const rc2 = await runTurn(s, sess.id, "second");
    check("S8: session usable after wait-timeout abort", rc2?.text === "FAKE_DSH_OK", JSON.stringify(rc2?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }

  // ── S9: busy send rejected ──────────────────────────────────────────────────────────────────────
  {
    const s = makeServer("s9", "hangprompt"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    s.fire("agent_bridge_send_message", { session_id: sess.id, message: "one" });
    await sleep(500);
    const second = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "two" });
    check("S9: second send while a turn is running is rejected", typeof second?.__error === "string" && /already has a running turn/.test(second.__error), JSON.stringify(second?.__error));
    await s.call("agent_bridge_abort", { session_id: sess.id });
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }

  // ── S10: close during an in-flight turn (force) + close idle ────────────────────────────────────
  {
    const s = makeServer("s10", "hangprompt"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    s.fire("agent_bridge_send_message", { session_id: sess.id, message: "blocked" });
    await sleep(500);
    const blocked = await s.call("agent_bridge_close_session", { session_id: sess.id });
    check("S10: close during a running turn is refused (blocked)", blocked?.blocked === true && Array.isArray(blocked.runningSessionIds), JSON.stringify(blocked));
    const forced = await s.call("agent_bridge_close_session", { session_id: sess.id, force: true });
    check("S10: force close succeeds", forced?.closed === true, JSON.stringify(forced));
    check("S10: force close kills the fake process", await waitDead(sess.pid));
    s.kill();
  }

  // ── S11: turn-level JSON-RPC error then reuse; process crash → session failed ────────────────────
  {
    const s = makeServer("s11", "promptfail"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    const bad = await runTurn(s, sess.id, "fail once", 12000);
    check("S11: turn error surfaces as failed/aborted result", bad && (bad.turnSettled === true) && (bad.lastError != null || bad.health !== "healthy" || bad.status === "failed" || bad.__error != null), JSON.stringify(bad));
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    check("S11: lastError records the dsh turn error", typeof st?.lastError === "string" && st.lastError.includes("turn failed"), JSON.stringify(st?.lastError));
    const ok = await runTurn(s, sess.id, "second");
    check("S11: session reusable after a turn error", ok?.text === "FAKE_DSH_OK", JSON.stringify(ok?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }
  {
    const s = makeServer("s11b", "exitnonzero"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    const r = await runTurn(s, sess.id, "crash", 15000);
    check("S11b: process crash fails the turn (partial text kept)", r && String(r.text ?? "").includes("FAKE_DSH_PARTIAL"), JSON.stringify({ text: r?.text, health: r?.health }));
    check("S11b: fake process is gone after crash", await waitDead(sess.pid));
    const after = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "dead" });
    check("S11b: sending on a dead session is rejected", typeof after?.__error === "string" && /not running/.test(after.__error), JSON.stringify(after?.__error));
    s.kill();
  }

  // ── S12: open failures (init fail / new fail / init hang) — clean error, no orphan ──────────────
  for (const [tag, modes, env] of [
    ["initfail", "initfail", {}],
    ["newfail", "newfail", {}],
    ["hanginit", "hanginit", { AGENT_BRIDGE_DSH_READY_TIMEOUT_MS: "1500" }],
  ]) {
    const s = makeServer(`s12-${tag}`, modes, env); await s.init();
    const t0 = Date.now();
    const open = await openDsh(s);
    const ms = Date.now() - t0;
    check(`S12: ${tag} open fails with an error`, typeof open?.__error === "string" && open.__error.length > 0, JSON.stringify(open?.__error)?.slice(0, 240));
    if (tag === "hanginit") check("S12: hanginit respects the ready timeout (fails fast)", ms < 12000, `took ${ms}ms`);
    const start = fakeStartup(s.trace());
    if (start?.pid) check(`S12: ${tag} leaves no orphaned fake process`, await waitDead(start.pid, 8000));
    s.kill();
  }

  // ── S13: env scrubbing — host DSH run context is stripped, DSH_HOME kept ───────────────────────
  {
    const s = makeServer("s13", "ok", {
      DSH_SESSION_ID: "session-host-context",
      DSH_WEB_URL: "http://127.0.0.1:1",
      DSH_PROFILE: "desktop",
      DSH_PROFILE_DIR: "C:\\host\\profile",
      DSH_SHELL: "1",
      DSH_HOME: path.join(tmpRoot, "fake-dsh-home"),
    });
    await s.init();
    const open = await openDsh(s);
    const envProbe = fakeStartup(s.trace())?.envProbe ?? {};
    check("S13: host DSH_SESSION_ID stripped", envProbe.DSH_SESSION_ID == null, JSON.stringify(envProbe.DSH_SESSION_ID));
    check("S13: host DSH_PROFILE/DSH_PROFILE_DIR/DSH_WEB_URL stripped", envProbe.DSH_PROFILE == null && envProbe.DSH_PROFILE_DIR == null && envProbe.DSH_WEB_URL == null, JSON.stringify(envProbe));
    check("S13: host DSH_SHELL stripped", envProbe.DSH_SHELL == null, JSON.stringify(envProbe.DSH_SHELL));
    check("S13: DSH_HOME kept", envProbe.DSH_HOME === path.join(tmpRoot, "fake-dsh-home"), JSON.stringify(envProbe.DSH_HOME));
    check("S13: bridge diagnostic markers present", envProbe.AGENT_BRIDGE_AGENT === "dsh" && !!envProbe.AGENT_BRIDGE_SESSION_ID, JSON.stringify(envProbe));
    await s.call("agent_bridge_close_session", { session_id: open.session.id });
    s.kill();
  }

  // ── S14: late update after settle must not contaminate the next turn ────────────────────────────
  {
    const s = makeServer("s14", "lateevents"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    const first = await runTurn(s, sess.id, "first");
    check("S14: finished answer excludes the late marker", first?.text === "FAKE_DSH_OK", JSON.stringify(first?.text));
    await sleep(400); // let the late FAKE_DSH_LATE chunk arrive and be ignored
    const second = await runTurn(s, sess.id, "second");
    check("S14: next turn starts clean (late chunk not folded in)", second?.text === "FAKE_DSH_OK", JSON.stringify(second?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }

  // ── S15: same-flush turn (all frames in one stdout write) ───────────────────────────────────────
  {
    const s = makeServer("s15", "sameflush"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    const rc = await runTurn(s, sess.id, "one burst");
    check("S15: same-flush turn settles correctly", rc?.text === "FAKE_DSH_OK", JSON.stringify(rc?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }

  // ── S16: schema rejected for dsh (open + send) ──────────────────────────────────────────────────
  {
    const s = makeServer("s16", "ok"); await s.init();
    const open = await openDsh(s, "read", { schema: { type: "object", properties: { a: { type: "string" } } } });
    check("S16: schema rejected at open", typeof open?.__error === "string" && open.__error.includes('not supported for backend "dsh"'), JSON.stringify(open?.__error));
    const o2 = await openDsh(s); const sess = o2?.session;
    if (sess?.id) {
      const send = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "x", schema: { type: "object" } });
      check("S16: schema rejected at send", typeof send?.__error === "string" && send.__error.includes('not supported for backend "dsh"'), JSON.stringify(send?.__error));
      await s.call("agent_bridge_close_session", { session_id: sess.id });
    }
    s.kill();
  }

  // ── S17: real registry matcher (diag match dsh-acp) — positive + security negatives ─────────────
  {
    const cases = [
      ['"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" --expose-internals "C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" --profile acp --patch C:\\tmp\\x.yml', true],
      ["cmd.exe /d /s /c C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd --profile acp --patch C:\\tmp\\x.yml", true],
      ["dsh --profile acp", true],
      ['"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe"', false],
      ['"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\scripts\\agent-bridge.mjs mcp', false],
      ['dsh --profile headless "run tests"', false],
      ["dsh web", false],
      ['"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" --expose-internals "C:\\x\\app.asar\\dsh\\x\\cli.js" --profile headless "task"', false],
    ];
    const r = spawnSync(process.execPath, [BRIDGE, "diag", "match", "dsh-acp"], { input: JSON.stringify(cases.map(c => c[0])), encoding: "utf8", windowsHide: true });
    let got;
    try { got = JSON.parse(r.stdout); } catch { got = null; }
    check("S17: diag match returns booleans", Array.isArray(got) && got.length === cases.length, JSON.stringify(r.stdout));
    if (Array.isArray(got)) {
      cases.forEach(([cmd, want], i) => check(`S17: matcher ${want ? "accepts" : "rejects"} ${cmd.slice(0, 70)}…`, got[i] === want, `${JSON.stringify(cmd)} → ${got[i]}`));
    }
  }

  // ── S18: doctor reports dsh through the fake launcher ───────────────────────────────────────────
  {
    const r = spawnSync(process.execPath, [BRIDGE, "doctor", "--json"], {
      env: { ...process.env, DSH_BIN: FAKE_DSH, AGENT_BRIDGE_STATE_DIR: path.join(tmpRoot, "doctor-state") },
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch {}
    const row = j?.agents?.find(a => a.agent === "dsh");
    check("S18: doctor includes a dsh row", !!row, JSON.stringify(j?.agents?.map(a => a.agent)));
    check("S18: doctor dsh available with the fake version", row?.available === true && row?.version === "0.2.1-rc.2", JSON.stringify(row));
  }

  // ── S19: pid record written with the dsh role; removed on close ─────────────────────────────────
  {
    const s = makeServer("s19", "ok"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    const pidsDir = path.join(s.stateDir, "pids");
    const files = fs.existsSync(pidsDir) ? fs.readdirSync(pidsDir).filter(f => f.startsWith("dsh-")) : [];
    check("S19: pid record exists while the session is open", files.length >= 1, JSON.stringify(files));
    let record = null;
    try { record = JSON.parse(fs.readFileSync(path.join(pidsDir, files[0]), "utf8")); } catch {}
    check("S19: pid record carries the dsh-acp role + owner pid", record?.processes?.[0]?.role === "dsh-acp" && record?.ownerPid === s.srv.pid, JSON.stringify(record));
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    const left = fs.existsSync(pidsDir) ? fs.readdirSync(pidsDir).filter(f => f.startsWith("dsh-")) : [];
    check("S19: pid record removed after close", left.length === 0, JSON.stringify(left));
    s.kill();
  }

  // ── S20: crash-residue reclamation through the REAL cleanup CLI ─────────────────────────────────
  // A real ACP server exits on stdin EOF, so killing the parent bridge cannot leave a live dsh child
  // (unlike omp/codex). We therefore build the crash residue the way cleanup actually meets it: a live
  // fake dsh process + a pid record whose owner is dead. The launcher is renamed to `dsh.cmd` inside a
  // temp dir so the REAL registry matcher (which requires the dsh launcher token) classifies it.
  if (IS_WINDOWS) {
    const orphanDir = path.join(tmpRoot, "orphan");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.copyFileSync(path.join(HERE, "fake-dsh.mjs"), path.join(orphanDir, "fake-dsh.mjs"));
    fs.writeFileSync(
      path.join(orphanDir, "dsh.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.mjs" %*\r\n`,
    );
    const orphan = spawn("cmd.exe", ["/d", "/s", "/c", path.join(orphanDir, "dsh.cmd"), "--profile", "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, FAKE_DSH_MODES: "ok", FAKE_DSH_TRACE: path.join(tmpRoot, "orphan-trace.jsonl") },
    });
    const orphanState = path.join(tmpRoot, "state-orphan");
    const pidsDir = path.join(orphanState, "pids");
    fs.mkdirSync(pidsDir, { recursive: true });
    await sleep(600);
    check("S20: orphan precondition — fake dsh is alive", orphan.exitCode === null && pidAlive(orphan.pid), JSON.stringify({ pid: orphan.pid, exit: orphan.exitCode }));
    fs.writeFileSync(path.join(pidsDir, "dsh-orphan-test.json"), JSON.stringify({
      id: "dsh-orphan-test",
      agent: "dsh",
      ownerPid: 999999, // no such process → owner probe says "dead"
      cwd: CWD,
      createdAt: new Date().toISOString(),
      processes: [{ role: "dsh-acp", pid: orphan.pid, command: `cmd.exe /d /s /c ${path.join(orphanDir, "dsh.cmd")} --profile acp`, spawnedAt: new Date().toISOString() }],
    }, null, 2));
    const r = spawnSync(process.execPath, [BRIDGE, "cleanup", "--json"], {
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: orphanState },
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch {}
    check("S20: cleanup ran", !!(j && j.childProcesses), JSON.stringify(j)?.slice(0, 300));
    check("S20: cleanup reaped the orphaned fake dsh process", await waitDead(orphan.pid, 8000), JSON.stringify(j?.childProcesses));
    check("S20: orphan pid record removed", !fs.existsSync(path.join(pidsDir, "dsh-orphan-test.json")), JSON.stringify(fs.existsSync(pidsDir) ? fs.readdirSync(pidsDir) : []));
    try { orphan.kill("SIGKILL"); } catch {}
  } else {
    console.log("[check] S20: skipped on POSIX (launcher-shim cleanup scenario is Windows-shaped)");
  }

  // ── S21: close idle → closed status is NOT reusable ────────────────────────────────────────────
  {
    const s = makeServer("s21", "ok"); await s.init();
    const o = await openDsh(s); const sess = o.session;
    await s.call("agent_bridge_close_session", { session_id: sess.id });
    const send = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "after close" });
    check("S21: sending on a closed session is rejected", typeof send?.__error === "string" && /closed|Unknown session/.test(send.__error), JSON.stringify(send?.__error));
    s.kill();
  }

  // ── S22: wedged server (cancel ignored) → fail + kill, never a fake "cancelled" ─────────────────
  {
    const s = makeServer("s22", "ignorecancel", { AGENT_BRIDGE_DSH_ABORT_SETTLE_MS: "1200" }); await s.init();
    const o = await openDsh(s); const sess = o.session;
    s.fire("agent_bridge_send_message", { session_id: sess.id, message: "wedged" });
    await sleep(500);
    const t0 = Date.now();
    const ab = await s.call("agent_bridge_abort", { session_id: sess.id }, 20000);
    const ms = Date.now() - t0;
    check("S22: abort reports a kill (not a clean cancel)", ab?.aborted === true && ab?.killed === true && ab?.reusable === false, JSON.stringify(ab));
    check("S22: abort respected the settle timeout (no hang)", ms < 12000, `took ${ms}ms`);
    check("S22: wedged ACP process killed", await waitDead(sess.pid, 8000), String(sess.pid));
    const w = await s.call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 8000 });
    const r = w?.results?.[0];
    check("S22: turn settles failed, not a fake 'cancelled'", r && (r.lastError != null || r.health === "dead" || r.status === "failed" || r.__error != null), JSON.stringify({ lastError: r?.lastError, health: r?.health, status: r?.status }));
    const st = (await s.call("agent_bridge_status", { session_id: sess.id }))?.session;
    check("S22: session is failed + dead (a wedge must not look reusable)", st?.status === "failed" && st?.health === "dead", JSON.stringify({ status: st?.status, health: st?.health }));
    const again = await s.call("agent_bridge_send_message", { session_id: sess.id, message: "x" });
    check("S22: send on the wedged session is rejected", typeof again?.__error === "string" && /not running/.test(again.__error), JSON.stringify(again?.__error));
    s.kill();
  }

  // ── S23: DSH template braces in the appended prompt fail fast (before spawn) ────────────────────
  {
    const badFile = writePromptFile("role-brace.md", "You are the {{model}} helper.\n");
    const s = makeServer("s23", "ok"); await s.init();
    const open = await openDsh(s, "read", { append_system_prompt_file: badFile });
    check("S23: template braces rejected with a clear error", typeof open?.__error === "string" && open.__error.includes("{{"), JSON.stringify(open?.__error));
    check("S23: nothing was spawned for the rejected session", s.trace().length === 0, JSON.stringify(s.trace().length));
    s.kill();
  }

  // ── S24: ACP permission responder — the read-tier never-allow security fence ────────────────────
  {
    // read tier + normal options → reject-once
    const s = makeServer("s24a", "perm"); await s.init();
    const o = await openDsh(s, "read"); const sess = o.session;
    const rc = await runTurn(s, sess.id, "perm read");
    const reply = s.trace().find(r => r && r.ev === "permission_reply");
    check("S24: read tier answers a permission request with reject-once", reply?.outcome?.outcome === "selected" && reply?.optionId === "reject-once", JSON.stringify(reply));
    check("S24: read-tier turn still settles end_turn after the rejection", rc?.text === "FAKE_DSH_OK", JSON.stringify(rc?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }
  {
    // write tier + normal options → allow-once (danger-full-access normally never asks; keep it sane)
    const s = makeServer("s24b", "perm"); await s.init();
    const o = await openDsh(s, "write"); const sess = o.session;
    const rc = await runTurn(s, sess.id, "perm write");
    const reply = s.trace().find(r => r && r.ev === "permission_reply");
    check("S24: write tier answers a permission request with allow-once", reply?.outcome?.outcome === "selected" && reply?.optionId === "allow-once", JSON.stringify(reply));
    check("S24: write-tier turn settles end_turn", rc?.text === "FAKE_DSH_OK", JSON.stringify(rc?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }
  {
    // read tier + ONLY allow_always offered → MUST answer cancelled, never an allow kind
    const s = makeServer("s24c", "perm_always"); await s.init();
    const o = await openDsh(s, "read"); const sess = o.session;
    const rc = await runTurn(s, sess.id, "perm read always");
    const reply = s.trace().find(r => r && r.ev === "permission_reply");
    check("S24: read tier NEVER selects an allow_always option (answers cancelled)", reply?.outcome?.outcome === "cancelled" && reply?.outcome?.optionId == null, JSON.stringify(reply));
    check("S24: turn still settles end_turn after the safe cancellation", rc?.text === "FAKE_DSH_OK", JSON.stringify(rc?.text));
    await s.call("agent_bridge_close_session", { session_id: sess.id }); s.kill();
  }

  cleanupTmp();
  if (failures === 0) {
    console.log("[harness] >>> PASS: dsh ACP backend hermetic suite (open/turn/stream/contextUsage/model+effort/patch/abort/reuse/close/error paths/matcher/doctor/cleanup)");
    process.exit(0);
  }
  console.log(`[harness] >>> FAIL: ${failures} check(s) failed`);
  process.exit(1);
}

main().catch(e => { cleanupTmp(); console.error("[harness] CRASH", e); process.exit(1); });
