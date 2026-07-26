// Repro/verify: the `cleanup` sweep must confirm an orphan is actually DEAD before deleting its pid
// record — "the signal was delivered" is not "the process is gone".
//
// The bug: terminateProcessTree() returns true when the signal was DELIVERED (taskkill exiting 0/128,
// or process.kill not throwing), not when the target died. A backend that ignores SIGTERM therefore
// took the "graceful worked" branch: it was counted as terminated, unreapableOrphan stayed false, and
// the pid record — the ONLY handle anyone has on that orphan — was deleted. The orphan then survives
// every future sweep because nothing can find it any more. The SIGKILL backstop could not save it
// either: its timer is unref'd, and the one-shot `cleanup` CLI exits before any timer fires.
//
// Scenario per case: spawn a fake backend whose command line matches the omp matcher (`\bomp\b` +
// `--mode rpc`), write a pid record naming it, with a dead ownerPid so the sweep treats it as an
// orphan, then run the REAL `cleanup` CLI against a synthetic AGENT_BRIDGE_STATE_DIR.
//   · obedient orphan  → must be dead afterwards AND its record removed.
//   · stubborn orphan (ignores SIGTERM) → must ALSO be dead (the sweep escalates to SIGKILL and
//     waits for confirmation). Before the fix it survived with its record deleted.
// Zero real model usage.
//
// ⚠️ Proof-limit worth knowing (measured on Windows 11): both cases take ~5s, i.e. BOTH escalate.
// `taskkill /T` without `/F` is effectively a no-op against a console process, so the graceful pass
// never succeeds there and "obedient" is not actually distinguishable from "stubborn" on Windows.
// The two cases stay separate because on POSIX they DO differ (SIGTERM is honoured), and because the
// contract asserted here — never delete the record while the process lives — is the same either way.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const IS_WIN = process.platform === "win32";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (IS_WIN) {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return (r.stdout || "").includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; }
}

/** A dead pid we can put in `ownerPid`: spawn something trivial, let it exit, reuse its number.
 *  (Using a made-up number risks colliding with a live process, which would make the sweep skip
 *  the record for the WRONG reason and turn this whole test green without testing anything.) */
async function deadPid() {
  const p = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const pid = p.pid;
  await new Promise(r => p.on("close", r));
  await sleep(200);
  return pid;
}

/** Spawn a fake backend whose COMMAND LINE matches the omp matcher, so classifyChild calls it "ours".
 *  `stubborn` picks the SIGTERM-ignoring script. Returns its pid. */
function spawnFakeBackend({ stubborn, sessionId }) {
  const script = path.join(HERE, stubborn ? "fake-omp-stubborn.mjs" : "fake-omp.mjs");
  // `--mode rpc` is required by AGENTS.omp.matchesCommand; the fakes ignore argv entirely.
  const child = spawn(process.execPath, [script, "--mode", "rpc"], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    detached: !IS_WIN,
    // POSIX identity check reads this from /proc/<pid>/environ; on Windows it falls back to start time.
    env: { ...process.env, AGENT_BRIDGE_SESSION_ID: sessionId, FAKE_OMP_MODE: "okturn" },
  });
  child.unref?.();
  return child;
}

async function scenario(tag, { stubborn }) {
  console.log(`\n[${tag}] ${stubborn ? "抗 SIGTERM 的" : "听话的"}孤儿后端`);
  const STATE = fs.mkdtempSync(path.join(os.tmpdir(), `ab-reap-${tag}-`));
  fs.mkdirSync(path.join(STATE, "pids"), { recursive: true });
  const sessionId = `omp-reap-${tag}`;
  const child = spawnFakeBackend({ stubborn, sessionId });
  const pid = child.pid;
  await sleep(700); // let it come up
  ok("假后端起来了", isAlive(pid), `pid=${pid}`);

  const owner = await deadPid();
  // Two details the identity check is strict about — get either wrong and classifyChild says "gone",
  // the record is dropped as stale, and this test goes green without ever exercising the kill path:
  //   · role must be the REGISTRY role (`omp-rpc`), not the agent name (`omp`) — roleMatchesCommand
  //     looks the matcher up by it, and an unknown role matches nothing.
  //   · spawnedAt must be at or AFTER the process actually started (the real bridge writes the record
  //     right after spawn). Backdating it makes the start-time check read "this pid was recycled".
  const stampedAt = new Date().toISOString();
  const record = {
    id: sessionId,
    agent: "omp",
    ownerPid: owner,               // already exited → the sweep treats these as orphans
    cwd: process.cwd(),
    createdAt: stampedAt,
    processes: [{ pid, args: ["--mode", "rpc"], role: "omp-rpc", spawnedAt: stampedAt }],
    updatedAt: stampedAt,
  };
  const recFile = path.join(STATE, "pids", `${sessionId}.json`);
  fs.writeFileSync(recFile, JSON.stringify(record, null, 2), "utf8");

  const t0 = Date.now();
  const run = spawnSync(process.execPath, [BRIDGE, "cleanup", "--json"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE },
  });
  const elapsed = Date.now() - t0;
  let summary = null;
  try { summary = JSON.parse(run.stdout || "{}").childProcesses; } catch {}
  console.log(`  cleanup 用时 ${elapsed}ms → ${JSON.stringify(summary)}`);
  ok("cleanup 正常退出", run.status === 0, `exit=${run.status} stderr=${(run.stderr || "").slice(0, 300)}`);
  ok("这条记录被扫到了(否则本用例什么都没验)", summary?.records === 1, JSON.stringify(summary));
  // 反空绿:必须确认 sweep 真的把它**认成了自己的孤儿**并动了手。少了这条,身份校验一旦不匹配
  // (role 写错、时间戳方向反了),记录会被当"陈旧"直接删掉、进程根本没人碰,而上面那些断言照样能绿。
  ok("sweep 确实把它当成自己的孤儿处理了(不是当陈旧记录扔掉)",
     (summary?.terminated?.length || 0) + (summary?.unreaped?.length || 0) === 1,
     `terminated=${JSON.stringify(summary?.terminated)} unreaped=${JSON.stringify(summary?.unreaped)} — 多半是身份没匹配上`);

  await sleep(400);
  const stillAlive = isAlive(pid);
  const recordGone = !fs.existsSync(recFile);

  // The contract: the record may only disappear once the process really is gone. Both "killed it and
  // removed the record" and "could not kill it but KEPT the record" are acceptable; "still alive AND
  // record deleted" is the leak this test exists to catch.
  ok("孤儿确实被收掉了", !stillAlive, `pid=${pid} 仍然活着`);
  ok("记录只在进程真没了之后才被删", !(stillAlive && recordGone),
     stillAlive && recordGone ? "进程还活着,记录却被删了 —— 这个孤儿从此再也找不回来" : "");
  if (!stillAlive) ok("确认死亡后记录已回收", recordGone, "进程已死但记录还在");

  // Never leave a stray behind, whatever the assertions said.
  if (isAlive(pid)) {
    if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
  }
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
}

async function main() {
  await scenario("obedient", { stubborn: false });
  await scenario("stubborn", { stubborn: true });
  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.log(`[harness] >>> FAIL: ${e}`); process.exit(1); });
