// Repro/verify for the watchdog "arm only if parent alive at startup" guard (v0.8.3 / F2). If our ppid
// is already gone when we start — the transient-launcher / shell-wrapper shape — that pid is NOT a
// trustworthy proxy for the client holding our stdin, so the watchdog must DISARM and let stdin EOF be
// the signal instead of self-reaping. This points the watchdog at an ALREADY-DEAD pid and asserts the
// server keeps running across several watchdog intervals; then a clean stdin EOF still exits it.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A pid that is definitely dead: spawn a no-op synchronously, then reuse its (now-exited) pid number.
const corpse = spawnSync(process.execPath, ["-e", "0"]);
const deadPid = corpse.pid;
console.log(`[harness] using already-dead pid ${deadPid} as the (gone-at-startup) parent`);

const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENT_BRIDGE_PARENT_PID: String(deadPid), AGENT_BRIDGE_PARENT_WATCHDOG_MS: "500" },
});
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); try { srv.kill("SIGKILL"); } catch {} process.exit(1); }

async function main() {
  // Watchdog interval 500ms; with the OLD (un-guarded) code it would see the parent gone and self-exit
  // within ~1s (two intervals). With the disarm guard it must stay alive. Watch for 4s (8 intervals).
  await sleep(4000);
  if (exited) return fail(`server self-exited (code=${exited?.code}) — watchdog NOT disarmed for a gone-at-startup parent`);
  console.log("[harness] server still alive after 4s with a dead parent pid — watchdog correctly disarmed");

  // Prove the normal exit path still works: stdin EOF must end it cleanly.
  try { srv.stdin.end(); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !exited) await sleep(50);
  if (!exited) return fail("server did not exit on stdin EOF after disarm");
  console.log(`[harness] >>> PASS: disarmed watchdog kept server alive; stdin EOF exited it cleanly (code=${exited.code})`);
  process.exit(0);
}
main().catch(e => fail(String(e)));
