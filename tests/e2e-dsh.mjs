// REAL end-to-end test for the DSH (DeepSeek Harness) ACP backend — no fakes, no model stubs.
//
// Skips cleanly (exit 0) when `dsh` is not installed / `--profile acp` is unavailable. Otherwise it
// spawns the bridge MCP server from this working tree, opens a real `dsh` session (ACP profile, managed
// credentials from the user's DSH_HOME), runs real turns (small prompts), exercises abort + reuse,
// checks contextUsage from real usage_update frames, closes the session and verifies the process tree
// and pid records are gone. This is the acceptance test for the backend's live behavior; the hermetic
// suite (tests/repro-dsh.mjs, tests/fake-dsh.*) covers the wire/edge cases without API cost.
//
// Run: node tests/e2e-dsh.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(ROOT, "scripts/agent-bridge.mjs");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`[check] ${label}: ${cond ? "OK" : "FAIL"}${cond || !detail ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
};
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };
async function waitDead(pid, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!pidAlive(pid)) return true; await sleep(100); } return false; }

// ── availability preflight (same resolution the bridge uses, via doctor) ─────────────────────────────
function dshDoctor() {
  const r = spawnSync(process.execPath, [BRIDGE, "doctor", "--json"], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout)?.agents?.find(a => a.agent === "dsh") ?? null; } catch { return null; }
}
const availability = dshDoctor();
if (!availability?.available) {
  console.log(`[harness] SKIP: dsh backend unavailable (${availability?.error ?? "no dsh row"}); install DeepSeek Harness 0.2.x with --profile acp to run this e2e.`);
  process.exit(0);
}
console.log(`[harness] dsh available: ${availability.version}`);

const BOX = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-dsh-"));
const STATE = path.join(BOX, "state");
fs.mkdirSync(STATE, { recursive: true });
const cleanup = () => { try { fs.rmSync(BOX, { recursive: true, force: true }); } catch {} };

const srv = spawn(process.execPath, [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE, AGENT_BRIDGE_VIZ: "off" },
});
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));
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
const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; };
const call = async (name, args, ms = 60000) => {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const r = await waitResp(id, ms);
  if (r === null) throw new Error(`${name}: bridge server exited (${JSON.stringify(exited)})`);
  if (r === undefined) throw new Error(`${name}: no response in ${ms}ms`);
  if (r.error) return { __error: r.error.message || JSON.stringify(r.error) };
  const t = r.result?.content?.[0]?.text;
  return t ? JSON.parse(t) : null;
};
const init = async () => {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-dsh", version: "0" } } });
  if (!await waitResp(id, 10000)) throw new Error("no MCP init response");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
};
const runTurn = async (sid, message, ms = 240000) => {
  await call("agent_bridge_send_message", { session_id: sid, message }, 60000);
  const w = await call("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: ms }, ms + 30000);
  return w?.results?.[0] ?? null;
};

async function main() {
  await init();
  console.log("\n== E1: open a real dsh ACP session ==");
  const open = await call("agent_bridge_open_session", { agent: "dsh", cwd: ROOT, access: "read", effort: "low" }, 90000);
  if (open?.__error) return check("E1: open succeeds", false, open.__error);
  const sess = open?.session;
  if (!sess?.id) return check("E1: open succeeds", false, JSON.stringify(open)?.slice(0, 400));
  check("E1: session is idle + healthy", sess.status === "idle" && sess.health === "healthy", JSON.stringify({ status: sess.status, health: sess.health }));
  check("E1: persistent ACP process has a pid", Number.isInteger(sess.pid) && sess.pid > 0, String(sess.pid));
  check("E1: effort echoed; model defaulted by DSH", sess.effort === "low" && sess.model === null, JSON.stringify({ model: sess.model, effort: sess.effort }));
  check("E1: acp session id recorded", typeof sess.agentSpecific?.acpSessionId === "string" && sess.agentSpecific.acpSessionId.length > 8);
  if (process.platform === "win32") {
    // GAP-8: the production main path must be the space-safe Electron-as-node launch (not a .cmd shim).
    check("E1: production launcher is Electron-node (space-safe dsh.cmd bypass)", sess.agentSpecific?.launchVia === "electron-node", JSON.stringify(sess.agentSpecific?.launchVia));
  }

  console.log("\n== E2: real turn through ACP ==");
  const t0 = Date.now();
  const r1 = await runTurn(sess.id, "Reply with exactly this text and nothing else: DSH-E2E-OK");
  const turnMs = Date.now() - t0;
  check("E2: turn settles with the requested text", typeof r1?.text === "string" && r1.text.trim().includes("DSH-E2E-OK"), JSON.stringify(r1?.text)?.slice(0, 200));
  check("E2: turn is settled + completed", r1?.turnSettled === true, JSON.stringify({ settled: r1?.turnSettled, health: r1?.health }));
  check("E2: real contextUsage reported (tokens>0, live:false)", Number.isInteger(r1?.contextUsage?.tokens) && r1.contextUsage.tokens > 0 && r1.contextUsage.live === false, JSON.stringify(r1?.contextUsage));
  console.log(`[harness] first real turn took ${turnMs}ms`);
  const st1 = (await call("agent_bridge_status", { session_id: sess.id }))?.session;
  check("E2: session idle/healthy after turn (health=healthy)", st1?.status === "idle" && st1?.health === "healthy", JSON.stringify({ status: st1?.status, health: st1?.health }));
  check("E2: turnCount + lastTurn recorded", st1?.agentSpecific?.turnCount === 1 && !!st1?.lastTurn, JSON.stringify({ turnCount: st1?.agentSpecific?.turnCount, lastTurn: !!st1?.lastTurn }));

  console.log("\n== E2b: appended system prompt via generated --patch (real DSH boot) ==");
  {
    const roleFile = path.join(BOX, "e2b-role.md");
    fs.writeFileSync(roleFile, "You are ReviewBot-9. When the user asks for the codeword, answer with exactly: PINEAPPLE-42.\n");
    const openB = await call("agent_bridge_open_session", { agent: "dsh", cwd: ROOT, access: "read", append_system_prompt_file: roleFile }, 90000);
    if (openB?.__error) {
      check("E2b: DSH accepts the generated profile patch", false, openB.__error);
    } else {
      const sb = openB?.session;
      check("E2b: patch-injected session opens", !!sb?.id, JSON.stringify(openB)?.slice(0, 300));
      check("E2b: summary reports a true system prompt", sb?.appendSystemPrompt?.injectionMode === "system", JSON.stringify(sb?.appendSystemPrompt));
      const rb = await runTurn(sb.id, "What is the codeword? Reply with just the codeword.");
      check("E2b: the appended persona influences the real model (codeword follows)", typeof rb?.text === "string" && rb.text.toUpperCase().includes("PINEAPPLE-42"), JSON.stringify(rb?.text)?.slice(0, 200));
      await call("agent_bridge_close_session", { session_id: sb.id });
    }
  }

  console.log("\n== E3: multi-turn on the same ACP process ==");
  const r2 = await runTurn(sess.id, "Reply with exactly this text and nothing else: DSH-E2E-TWO");
  check("E3: second turn works on the same process", typeof r2?.text === "string" && r2.text.trim().includes("DSH-E2E-TWO"), JSON.stringify(r2?.text)?.slice(0, 200));
  check("E3: pid unchanged across turns", (await call("agent_bridge_status", { session_id: sess.id }))?.session?.pid === sess.pid);

  console.log("\n== E4: abort a running real turn, then reuse ==");
  const sendAck = await call("agent_bridge_send_message", { session_id: sess.id, message: "Count slowly from 1 to 40, one number per line, nothing else." }, 60000);
  const ab = await call("agent_bridge_abort", { session_id: sess.id }, 30000);
  check("E4: abort acknowledges", ab?.aborted === true, JSON.stringify(ab));
  const wa = await call("agent_bridge_wait", { session_ids: [sess.id], mode: "all", timeout_ms: 120000 }, 150000);
  const ra = wa?.results?.[0];
  check("E4: interrupted turn settles aborted (not completed)", ra?.turnSettled === true && ra?.text !== undefined && (ra?.status === "idle" || ra?.health === "healthy"), JSON.stringify({ text: ra?.text?.slice?.(0, 60), health: ra?.health }));
  const st2 = (await call("agent_bridge_status", { session_id: sess.id }))?.session;
  check("E4: same process still alive after abort", st2?.pid === sess.pid && st2?.status === "idle", JSON.stringify({ before: sess.pid, after: st2?.pid, status: st2?.status }));
  const r3 = await runTurn(sess.id, "Reply with exactly this text and nothing else: DSH-E2E-AFTER-ABORT");
  check("E4: session reusable after abort", typeof r3?.text === "string" && r3.text.trim().includes("DSH-E2E-AFTER-ABORT"), JSON.stringify(r3?.text)?.slice(0, 200));

  console.log("\n== E5: close + no residue ==");
  const pid = (await call("agent_bridge_status", { session_id: sess.id }))?.session?.pid ?? sess.pid;
  const closed = await call("agent_bridge_close_session", { session_id: sess.id });
  check("E5: close returns closed", closed?.closed === true, JSON.stringify(closed));
  check("E5: ACP process tree is gone", await waitDead(pid, 15000), String(pid));
  const pidsDir = path.join(STATE, "pids");
  const left = fs.existsSync(pidsDir) ? fs.readdirSync(pidsDir) : [];
  check("E5: no pid records left for the closed session", left.length === 0, JSON.stringify(left));
}

main()
  .catch(e => { console.error("[harness] CRASH", e); failures += 1; })
  .finally(async () => {
    try { srv.stdin.end(); } catch {}
    await sleep(300);
    try { srv.kill("SIGKILL"); } catch {}
    cleanup();
    if (failures === 0) { console.log("\n[harness] >>> PASS: real DSH ACP backend e2e (open/turn/multiturn/abort/reuse/contextUsage/close)"); process.exit(0); }
    console.log(`\n[harness] >>> FAIL: ${failures} check(s) failed`);
    process.exit(1);
  });
