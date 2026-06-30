// Proves that a claude backend spawned by agent-bridge is NEVER left running after the
// bridge exits — neither gracefully (watchdog → cleanupAndExit → terminateProcessTree)
// nor on hard-kill (claude self-exits on stdin EOF; backstopped by `cleanup` CLI reaper).
//
// Scenario 1 — graceful watchdog exit reaps claude:
//   A "victim" process is watched by AGENT_BRIDGE_PARENT_WATCHDOG_MS=1000. The bridge's
//   stdin is kept OPEN so only the watchdog can end it. After killing the victim, the bridge
//   self-exits cleanly and terminateProcessTree() must reap claude within ~4s.
//
// Scenario 2 — SIGKILL of bridge never leaves claude alive:
//   The bridge is hard-killed (no cleanup runs). Two backstops are verified in order:
//   (a) claude self-exits when its stdin pipe is broken by the parent SIGKILL (stdin EOF);
//   (b) if still alive, the `cleanup` CLI reads stale pid records and reaps it.
//   An isolated AGENT_BRIDGE_STATE_DIR is used so the cleanup CLI only sees this test.
//
// SKIPS (exit 0) if `claude --version` fails. Opening a session costs NO model tokens —
// the idle CLI is spawned but no turns are sent.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");

// ── SKIP gate ─────────────────────────────────────────────────────────────────────────────
if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log(">>> SKIP: claude not on PATH");
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pidAlive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

// ── shared check accounting ───────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
  return ok;
};

// ── RPC helper factory (one per bridge process) ───────────────────────────────────────────
function makeRpc(srv) {
  let buf = "";
  const responses = new Map();
  let exited = null;

  srv.on("close", (code, signal) => {
    exited = { code, signal };
    console.log(`[srv-close] code=${code} signal=${signal}`);
  });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));
  srv.stdout.on("data", d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) responses.set(m.id, m);
      } catch {}
    }
  });

  let nextId = 1;
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  const send = (method, params) => {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method, params });
    return id;
  };
  const sendNotif = method => rpc({ jsonrpc: "2.0", method });
  const waitResp = async (id, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (responses.has(id)) return responses.get(id);
      if (exited) return null;
      await sleep(40);
    }
    return undefined;
  };
  return { send, sendNotif, waitResp, getExited: () => exited };
}

// ── Scenario 1: graceful watchdog-triggered exit reaps claude ─────────────────────────────
async function scenario1() {
  console.log("\n═══ Scenario 1: graceful watchdog exit reaps claude ═══");

  // Victim: the bridge watches this pid; when it dies the watchdog triggers cleanupAndExit.
  const victim = spawn(process.execPath, ["-e", "setInterval(()=>{}, 2147483647)"], { stdio: "ignore" });
  console.log(`[s1] victim pid=${victim.pid}`);

  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_BRIDGE_PARENT_PID: String(victim.pid),
      AGENT_BRIDGE_PARENT_WATCHDOG_MS: "1000",
    },
  });
  console.log(`[s1] bridge pid=${srv.pid} (watching victim ${victim.pid})`);

  const { send, sendNotif, waitResp, getExited } = makeRpc(srv);

  let claudePid = null;
  let scenarioPassed = false;
  try {
    // Initialize
    const initId = send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orphan-claude-s1", version: "0" },
    });
    if (!await waitResp(initId, 10000)) {
      check("s1: bridge initialized", false, "no response within 10s");
      return false;
    }
    sendNotif("notifications/initialized");

    // Open a read-only claude session — spawns the idle CLI, spends no model tokens.
    const openId = send("tools/call", {
      name: "agent_bridge_open_session",
      arguments: { agent: "claude", cwd: CWD, write: false },
    });
    const openResp = await waitResp(openId, 60000);
    const openData = openResp?.result?.content?.[0]?.text
      ? JSON.parse(openResp.result.content[0].text)
      : null;
    claudePid = openData?.session?.pid;
    if (!check("s1: open_session returned claude pid", !!claudePid, `pid=${claudePid}`)) return false;
    if (!check("s1: claude alive after open", pidAlive(claudePid), `pid=${claudePid}`)) return false;
    console.log(`[s1] claude pid=${claudePid} confirmed alive`);

    // Kill victim — bridge stdin stays OPEN; only the watchdog can now end the bridge.
    console.log(`[s1] killing victim ${victim.pid}; stdin stays open (watchdog is the only exit path)`);
    try { victim.kill("SIGKILL"); } catch {}

    // Expect the bridge to self-exit cleanly within ~14s (watchdog fires after 1s, cleanup takes a moment).
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline && !getExited()) await sleep(50);
    const exited = getExited();
    if (!check("s1: bridge self-exited after victim death", !!exited, `exited=${JSON.stringify(exited)}`)) return false;
    check("s1: bridge exited cleanly (code 0)", exited.code === 0, JSON.stringify(exited));

    // terminateProcessTree() runs inside cleanupSessions before the process exits.
    // Give it a few seconds to propagate (async on Windows).
    await sleep(4000);
    const reaped = !pidAlive(claudePid);
    if (!check("s1: claude reaped after bridge graceful exit", reaped, `pid=${claudePid} alive=${!reaped}`)) {
      try { process.kill(claudePid, "SIGKILL"); } catch {} // avoid leak
      return false;
    }
    console.log(`[s1] claude ${claudePid} dead — reaped by cleanupSessions/terminateProcessTree`);
    scenarioPassed = true;
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
    try { srv.kill("SIGKILL"); } catch {}
    if (claudePid && pidAlive(claudePid)) { try { process.kill(claudePid, "SIGKILL"); } catch {} }
  }
  return scenarioPassed;
}

// ── Scenario 2: hard-kill (SIGKILL) — claude never survives (self-exit or cleanup CLI) ──
async function scenario2() {
  console.log("\n═══ Scenario 2: hard-kill (SIGKILL) — claude never survives ═══");

  // Isolated state dir: ensures `cleanup` CLI only sees THIS test's pid records.
  const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ab-orphan-claude-"));
  console.log(`[s2] isolated state dir: ${STATE}`);

  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE },
  });
  console.log(`[s2] bridge pid=${srv.pid}`);

  const { send, sendNotif, waitResp, getExited } = makeRpc(srv);

  let claudePid = null;
  let scenarioPassed = false;
  try {
    // Initialize
    const initId = send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orphan-claude-s2", version: "0" },
    });
    if (!await waitResp(initId, 10000)) {
      check("s2: bridge initialized", false, "no response within 10s");
      return false;
    }
    sendNotif("notifications/initialized");

    // Open read-only claude session.
    const openId = send("tools/call", {
      name: "agent_bridge_open_session",
      arguments: { agent: "claude", cwd: CWD, write: false },
    });
    const openResp = await waitResp(openId, 60000);
    const openData = openResp?.result?.content?.[0]?.text
      ? JSON.parse(openResp.result.content[0].text)
      : null;
    claudePid = openData?.session?.pid;
    if (!check("s2: open_session returned claude pid", !!claudePid, `pid=${claudePid}`)) return false;
    if (!check("s2: claude alive before bridge kill", pidAlive(claudePid), `pid=${claudePid}`)) return false;
    console.log(`[s2] claude pid=${claudePid} alive — about to hard-kill bridge`);

    // SIGKILL the bridge: no cleanup runs, stdin pipe breaks.
    console.log(`[s2] hard-killing bridge ${srv.pid} (SIGKILL)`);
    try { srv.kill("SIGKILL"); } catch {}
    await sleep(500); // let the OS signal propagate

    // Backstop (a): claude should self-exit when stdin EOF reaches it (pipe closed by parent exit).
    await sleep(3000);
    const selfExited = !pidAlive(claudePid);
    if (selfExited) {
      console.log(`[s2] claude ${claudePid} self-exited on stdin EOF (pipe broken by SIGKILL) — no orphan`);
    } else {
      console.log(`[s2] claude ${claudePid} still alive after 3s — running cleanup CLI (backstop b)`);
    }

    // Backstop (b): `cleanup` CLI reads stale pid records and reaps confirmed orphans.
    console.log(`[s2] running: node ${BRIDGE} cleanup (STATE=${STATE})`);
    const cleanupResult = spawnSync(process.execPath, [BRIDGE, "cleanup"], {
      env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE },
      encoding: "utf8",
    });
    if (cleanupResult.stdout) process.stdout.write(`[s2-cleanup-stdout] ${cleanupResult.stdout}`);
    if (cleanupResult.stderr) process.stdout.write(`[s2-cleanup-stderr] ${cleanupResult.stderr}`);
    console.log(`[s2] cleanup CLI exit code: ${cleanupResult.status}`);

    // Final settle window.
    await sleep(2000);
    const finallyDead = !pidAlive(claudePid);

    let mechanism;
    if (selfExited) {
      mechanism = "self-exit on stdin EOF (pipe broken by SIGKILL)";
    } else if (finallyDead) {
      mechanism = "reaped by cleanup CLI (stale pid record matched matchesCommand)";
    } else {
      mechanism = "STILL ALIVE — orphan bug confirmed";
    }
    console.log(`[s2] kill mechanism: ${mechanism}`);

    if (!check("s2: claude dead after hard-kill + cleanup", finallyDead, `mechanism=${mechanism}`)) {
      // This is the real orphan concern the user asked to verify.
      console.log("");
      console.log("!!! ORPHAN BUG: claude pid=" + claudePid + " survived SIGKILL of bridge AND cleanup CLI !!!");
      console.log("!!! A spawned claude child can outlive the bridge — the orphan concern is REAL.        !!!");
      console.log("!!! Investigate: does claude exit on stdin EOF? Is the pid record written in time?     !!!");
      return false;
    }
    console.log(`[s2] claude ${claudePid} confirmed dead — no orphan`);
    scenarioPassed = true;
  } finally {
    // Force-kill claude if somehow still alive to avoid leaking.
    if (claudePid && pidAlive(claudePid)) {
      console.log(`[s2] force-killing claude ${claudePid} in finally block`);
      try { process.kill(claudePid, "SIGKILL"); } catch {}
    }
    try { srv.kill("SIGKILL"); } catch {}
    // Windows retry loop: delete-pending race when a process still has a handle open on the dir.
    let lastErr = null;
    for (let i = 0; i < 40 && fs.existsSync(STATE); i++) {
      try { fs.rmSync(STATE, { recursive: true, force: true }); break; }
      catch (e) { lastErr = e; await sleep(250); }
    }
    if (fs.existsSync(STATE)) {
      console.log(`[s2] warning: STATE dir still present after retries (${lastErr?.message})`);
    }
  }
  return scenarioPassed;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("[harness] orphan-claude.mjs — verifying bridge never orphans a claude child");
  console.log(`[harness] bridge: ${BRIDGE}`);
  console.log(`[harness] cwd:    ${CWD}`);

  const s1 = await scenario1().catch(e => {
    console.log(`[FAIL] scenario1 threw: ${e.message}`);
    return false;
  });
  const s2 = await scenario2().catch(e => {
    console.log(`[FAIL] scenario2 threw: ${e.message}`);
    return false;
  });

  const ok = s1 && s2;
  console.log("");
  console.log(`[harness] Scenario 1 (graceful watchdog reap):         ${s1 ? "PASS" : "FAIL"}`);
  console.log(`[harness] Scenario 2 (hard-kill self-exit/cleanup):    ${s2 ? "PASS" : "FAIL"}`);
  console.log(`\n>>> ${ok ? "PASS" : "FAIL"}: ${pass} checks passed, ${fail} failed`);
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.log(`[FAIL] harness top-level error: ${e.message}`);
  process.exit(1);
});
