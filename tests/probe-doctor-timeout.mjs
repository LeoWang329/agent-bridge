// Repro/verify for T2 (P3): doctor()'s per-backend `--version` probe must be timeout-bounded so a
// hung backend binary can't block doctor() (and therefore the synchronous MCP request) forever.
//
// Points ALL FIVE backend bins (OMP_BIN/CODEX_BIN/CLAUDE_BIN/CURSOR_AGENT_BIN/KIMI_BIN) at a wrapper that HANGS instead of
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
const BRIDGE = path.resolve(HERE, "../scripts/agent-bridge.mjs");
const HANG = path.join(HERE, process.platform === "win32" ? "hang-bin.cmd" : "hang-bin.sh");
const PID_FILE = path.join(os.tmpdir(), `hang-pids-${process.pid}.txt`);
try { fs.rmSync(PID_FILE, { force: true }); } catch {}

// cursor **不能**像别的后端那样拿一个 .cmd 壳去顶:它的 launcher 解析要求
// `<root>/versions/<v>/{node.exe, index.js}`,顶不上就在**探版本之前**先失败 ——
// 那样测出来的是「路径没配对」,不是「探版本挂住了」。所以这里按它真实的安装形状
// 造一个:真 node + 一个永不返回的 index.js。
const CURSOR_ROOT = path.join(os.tmpdir(), `hang-cursor-${process.pid}`);
{
  // 直接放在根目录:`cursorPickLauncherFromDir` 先试 `both(dir)`,命中就不去解析
  // `versions/<v>` 的版本号了 —— 省掉一个跟本用例无关的格式约束。
  const vdir = CURSOR_ROOT;
  fs.mkdirSync(vdir, { recursive: true });
  const nodeTarget = path.join(vdir, "node.exe");
  try { fs.linkSync(process.execPath, nodeTarget); } catch { fs.copyFileSync(process.execPath, nodeTarget); }
  // 记下自己的真实 pid 再挂住 —— 这样它也进「超时之后有没有留下孤儿孙进程」那道检查。
  fs.writeFileSync(path.join(vdir, "index.js"),
    `const f=process.env.HANG_PID_FILE;\n` +
    `if(f){try{require("node:fs").appendFileSync(f, process.pid+"\\n");}catch{}}\n` +
    `setTimeout(()=>{},1e9);\n`);
}

const PROBE_TIMEOUT_MS = 800;
// Generous ceiling: 5 backends × 800ms serial ≈ 4s of probing + node startup. Pre-fix this would be
// ~5 × 30000ms (the hang duration) = 150s+. A pass well under BUDGET proves the timeout fires.
const BUDGET_MS = 8000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }

const t0 = Date.now();
const child = spawn("node", [BRIDGE, "doctor", "--json"], {
  windowsHide: true,
  // ⚠️ **每加一个后端,这里必须跟着加一条。** 漏掉的那个会去探真的 CLI、报 available=true,
//    于是「所有后端都必须被超时挡住」这条断言当场红 —— 而红的不是产品,是这份夹具没跟上。
//    (cursor 与 kimi 就是这么让它红了很久:v1 写的时候只有三个后端。)
  env: { ...process.env, OMP_BIN: HANG, CODEX_BIN: HANG, CLAUDE_BIN: HANG,
         CURSOR_AGENT_BIN: CURSOR_ROOT, KIMI_BIN: HANG, HANG_PID_FILE: PID_FILE, AGENT_BRIDGE_DOCTOR_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_MS) },
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

  // ⚠️ **kimi 只能考到「不可用 + 不拖慢 doctor」,考不到「探针被超时挡住」。**
  //    `resolveKimiBin` **刻意只接受一个真名叫 `kimi.exe` 的原生文件**、拒绝 `.cmd`/`.bat` 壳
  //    (prompt 走 argv,经 shim 就会绕进 cmd.exe,是元字符注入面)。那条拒绝本身是安全属性,
  //    而它同时意味着:不编译一个真的 PE,就造不出「会挂住的 kimi.exe」。
  //    把 node.exe 改名顶上也不行 —— 它对 `--version` 秒答,那考的是"没挂",不是"挂了被挡住"。
  //    所以这里如实分档,而不是把断言放宽到所有后端(那会让另外四个也失去牙)。
  const HANGABLE = new Set(["omp", "codex", "claude", "cursor"]);
  for (const a of agents) {
    if (a.available !== false) return fail(`agent ${a.agent} should be unavailable (hung probe), got available=${a.available}`);
    if (HANGABLE.has(a.agent) && !/timed out/i.test(a.error || "")) {
      return fail(`agent ${a.agent} error should mention timeout, got ${JSON.stringify(a.error)}`);
    }
    console.log(`[harness] ${a.agent}: available=${a.available} error=${JSON.stringify(a.error)}`);
  }
  for (const name of HANGABLE) {
    if (!agents.some(a => a.agent === name)) return fail(`expected agent ${name} in doctor output — 后端改名了就得同步这份清单`);
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
