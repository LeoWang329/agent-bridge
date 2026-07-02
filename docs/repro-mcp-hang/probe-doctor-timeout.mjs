// Repro/verify for T2 (P3): doctor()'s per-backend `--version` probe must be timeout-bounded so a
// hung backend binary can't block doctor() (and therefore the synchronous MCP request) forever.
//
// Points all three backend bins (OMP_BIN/CODEX_BIN/CLAUDE_BIN) at a wrapper that HANGS instead of
// answering --version, sets a short probe timeout, and runs `agent-bridge doctor --json`. Pre-fix
// this would block ~= number-of-backends × (hang duration). With the fix each probe is killed at the
// timeout and reported unavailable, so the whole call returns quickly.
//
// It ALSO proves no orphaned grandchild survives (the Windows .cmd-shim → cmd.exe → node case that a
// direct-child-only kill would leak): each hang invocation records its real pid to HANG_PID_FILE, and
// after doctor() returns we assert every recorded pid is dead. Zero real backend usage.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const HANG = path.join(HERE, process.platform === "win32" ? "hang-bin.cmd" : "hang-bin.sh");
const PID_FILE = path.join(os.tmpdir(), `hang-pids-${process.pid}.txt`);
try { fs.rmSync(PID_FILE, { force: true }); } catch {}

const PROBE_TIMEOUT_MS = 800;
// Generous ceiling: 3 backends × 800ms serial ≈ 2.4s of probing + node startup. Pre-fix this would be
// ~3 × 30000ms (the hang duration) = 90s+. A pass well under BUDGET proves the timeout fires.
const BUDGET_MS = 6000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }

const t0 = Date.now();
const child = spawn("node", [BRIDGE, "doctor", "--json"], {
  windowsHide: true,
  env: { ...process.env, OMP_BIN: HANG, CODEX_BIN: HANG, CLAUDE_BIN: HANG, HANG_PID_FILE: PID_FILE, AGENT_BRIDGE_DOCTOR_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_MS) },
});
let out = "";
let err = "";
child.stdout.on("data", d => { out += d; });
child.stderr.on("data", d => { err += d; });

// Hard safety net: if doctor() truly hangs (fix absent/broken), don't let the repro itself hang CI.
const guard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} fail(`doctor did not return within ${BUDGET_MS + 4000}ms — probe timeout not enforced`); }, BUDGET_MS + 4000);

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

child.on("close", async code => {
  clearTimeout(guard);
  const elapsed = Date.now() - t0;
  console.log(`[harness] doctor --json exited code=${code} in ${elapsed}ms`);
  if (code !== 0) return fail(`doctor exited non-zero (${code}); stderr: ${err.slice(0, 300)}`);
  if (elapsed >= BUDGET_MS) return fail(`doctor took ${elapsed}ms (>= ${BUDGET_MS}ms budget) — probe not bounded`);

  let value;
  try { value = JSON.parse(out); } catch (e) { return fail(`doctor --json output not parseable: ${e.message}\n${out.slice(0, 300)}`); }
  const agents = value?.agents;
  if (!Array.isArray(agents) || agents.length < 3) return fail(`expected >=3 agents, got ${JSON.stringify(agents)?.slice(0, 200)}`);

  for (const a of agents) {
    if (a.available !== false) return fail(`agent ${a.agent} should be unavailable (hung probe), got available=${a.available}`);
    if (!/timed out/i.test(a.error || "")) return fail(`agent ${a.agent} error should mention timeout, got ${JSON.stringify(a.error)}`);
    console.log(`[harness] ${a.agent}: available=${a.available} error=${JSON.stringify(a.error)}`);
  }

  // No-orphan proof: every hung probe process recorded its pid. The timeout must have killed the whole
  // tree, so all must now be dead. Retry briefly since taskkill/kill is asynchronous vs our check.
  let pids = [];
  try { pids = fs.readFileSync(PID_FILE, "utf8").split(/\s+/).map(Number).filter(Boolean); } catch {}
  if (pids.length < 3) return fail(`expected >=3 recorded probe pids, got ${JSON.stringify(pids)} (hang wrapper never ran?)`);
  let survivors = pids;
  for (let i = 0; i < 10 && survivors.length; i++) { await sleep(200); survivors = survivors.filter(alive); }
  if (survivors.length) { for (const p of survivors) { try { process.kill(p, "SIGKILL"); } catch {} } return fail(`orphaned probe grandchild(ren) survived the timeout: ${JSON.stringify(survivors)} — tree not killed`); }
  console.log(`[harness] no-orphan: all ${pids.length} probe pids dead after timeout`);

  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  console.log(`[harness] >>> PASS: doctor() bounded each hung --version probe at ~${PROBE_TIMEOUT_MS}ms, returned in ${elapsed}ms, and left no orphaned grandchild`);
  process.exit(0);
});
