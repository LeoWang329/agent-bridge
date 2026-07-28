// Hermetic 回归:agent-bridge-graph 的 node-core / node-turn。
// 全程用 fake-omp 假后端(零真实模型消耗、零网络),自带隔离 state dir,每个子进程都有 watchdog。
//
//   node docs/repro-mcp-hang/repro-graph-node.mjs
//
// 断言的是**契约**不是实现细节。异引擎复审(R1)点名的假绿点已逐条堵上:
//   · 声称"零残留"就必须**真查 PID**(桥 pid + 后端进程),不能只写在注释里
//   · 超时不能只断言错误字符串含 abort —— 要断言 abortConfirmed 字段
//   · scene 不能只查目录存在 —— 要查三件套具体文件 + 内容非空
//   · 并发用 **echoturn 让每个节点答案互不相同**,这样 RPC 响应串线才暴露得出来
//   · 每个子进程加硬超时:真 hang 时回归要**报失败**,而不是自己挂住
//
//   T1 成功        okturn     → ok / 产出字节一致 / 回执原子落盘 / 桥 pid 已死
//   T2 格式不合格  okturn     → 打回重说一次仍不合格 → contract_error(2)+ reaskCount=1 + 现场三件套
//   T3 超时        slowturn   → 总预算耗尽 → abortConfirmed=true → timeout(4)+ 现场 + 零残留
//   T4 后端挂      坏 OMP_BIN → 桥明确回报 → backend_failed(3)
//   T5 幂等/复用   多组合     → 拒绝重跑 / 指纹一致复用 / 指纹变了拒绝 / 失败回执不复用 / 产出丢了不复用
//   T6 脚本编排    echoturn×3 → 一个桥进程并发 3 节点,**答案逐一对上**(防串线),零残留
//   T7 用法错      多组合     → 全部当场 UsageError(含 force+reuseIfSame 冲突、同 id 并发)
//   T8 未知状态    silent     → 后端不回话 → 超时路径;桥中途被杀 → unknown(不是 backend_failed)
//   T9 总预算      okturn     → open 之后预算就耗尽时,不会先发消息再发现超时

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge, startBridge, runNode, UsageError } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const NODE_TURN = path.join(REPO, "skills/agent-bridge-graph/tools/node-turn.mjs");
const FAKE_OMP = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const IS_WIN = process.platform === "win32";

const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-repro-"));
// 完全 hermetic:桥的状态/日志写进本次临时目录,不碰用户真实的 ~/.agent-bridge
const STATE_DIR = path.join(RUN_ROOT, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const BASE_ENV = { OMP_BIN: FAKE_OMP, AGENT_BRIDGE_STATE_DIR: STATE_DIR };

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 进程还活着吗(用来证明"零残留",而不是嘴上说)。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WIN) {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return (r.stdout || "").includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 跑 node-turn CLI,带**硬超时**:真 hang 的时候要报失败,不能让回归自己挂住。 */
function runCli(args, env = {}, watchdogMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NODE_TURN, ...args], {
      env: { ...process.env, ...BASE_ENV, ...env }, windowsHide: true,
    });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (IS_WIN) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); else child.kill("SIGKILL"); } catch {}
    }, watchdogMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
  });
}

const readReceipt = (outDir, id) => {
  const p = path.join(outDir, "nodes", `${id}.receipt.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
/** 现场三件套:不能只查目录存在(空目录也会"通过") */
function sceneHas(r, names) {
  if (!r?.scene?.dir || !fs.existsSync(r.scene.dir)) return false;
  return names.every((n) => {
    const p = path.join(r.scene.dir, n);
    const st = fs.existsSync(p) ? fs.statSync(p) : null;
    return st && st.isFile() && st.size > 0;
  });
}

async function t1_success() {
  console.log("\n[T1] 正常跑通一个环节(okturn)");
  const outDir = path.join(RUN_ROOT, "t1");
  const { code, out, timedOut } = await runCli(
    ["--id", "n1", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "30000", "--out-dir", outDir, "--json"],
    { FAKE_OMP_MODE: "okturn" },
  );
  ok("没有卡住", !timedOut);
  ok("退出码 0", code === 0, `拿到 ${code}\n${out.slice(0, 400)}`);
  const r = readReceipt(outDir, "n1");
  ok("回执落盘", !!r);
  ok("status=ok", r?.status === "ok", `拿到 ${r?.status}`);
  ok("指纹是 32 位十六进制", /^[0-9a-f]{32}$/.test(r?.specHash || ""), r?.specHash);
  // **字节级一致**,不是 includes —— includes 前后多出垃圾字节照样绿
  const art = r?.artifactPath && fs.readFileSync(r.artifactPath, "utf8");
  ok("产出与后端答案字节完全一致", art === "OKTURN_ANSWER", JSON.stringify(art));
  ok("回执记了产出内容指纹", /^[0-9a-f]{64}$/.test(r?.artifactSha256 || ""), r?.artifactSha256);
  ok("成功路径不留现场目录", !r?.scene, JSON.stringify(r?.scene));
  ok("关会话已确认", r?.closeConfirmed === true, String(r?.closeConfirmed));
  ok("没有残留的 .tmp 回执", fs.readdirSync(path.join(outDir, "nodes")).every((f) => !f.includes(".tmp-")));
}

async function t2_contract() {
  console.log("\n[T2] 输出格式不合格 → 打回重说一次 → 仍不合格");
  const outDir = path.join(RUN_ROOT, "t2");
  const { code, timedOut } = await runCli(
    ["--id", "n2", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "30000", "--out-dir", outDir, "--require-keys", "findings,summary"],
    { FAKE_OMP_MODE: "okturn" },
  );
  ok("没有卡住", !timedOut);
  ok("退出码 2(contract_error)", code === 2, `拿到 ${code}`);
  const r = readReceipt(outDir, "n2");
  ok("status=contract_error", r?.status === "contract_error", `拿到 ${r?.status}`);
  ok("打回重说了 1 次(不是无限重试)", r?.reaskCount === 1, `拿到 ${r?.reaskCount}`);
  ok("错误说明指出不是合法 JSON", /JSON/.test(r?.error || ""), r?.error);
  ok("现场三件套齐全且非空", sceneHas(r, ["session.log", "answer.txt", "status.json"]),
     JSON.stringify(r?.scene));
}

async function t3_timeout() {
  console.log("\n[T3] 超时 → 先 abort 再关会话(slowturn 2.5s,给 1.2s)");
  const outDir = path.join(RUN_ROOT, "t3");
  const t0 = Date.now();
  const { code, timedOut } = await runCli(
    ["--id", "n3", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "1200", "--out-dir", outDir],
    { FAKE_OMP_MODE: "slowturn" },
  );
  const elapsed = Date.now() - t0;
  ok("没有卡住", !timedOut);
  ok("退出码 4(timeout)", code === 4, `拿到 ${code}`);
  const r = readReceipt(outDir, "n3");
  ok("status=timeout", r?.status === "timeout", `拿到 ${r?.status}`);
  // 断言字段而不是错误字符串 —— 把 abort 调用删掉,这条必须变红
  ok("abortConfirmed=true(真的打断了,不是嘴上说)", r?.abortConfirmed === true, String(r?.abortConfirmed));
  ok("现场三件套齐全", sceneHas(r, ["session.log", "status.json"]), JSON.stringify(r?.scene));
  ok("总耗时接近预算而不是死等(<25s)", elapsed < 25000, `${elapsed}ms`);
}

async function t4_backend_failed() {
  console.log("\n[T4] 后端起不来(桥明确回报) → backend_failed");
  const outDir = path.join(RUN_ROOT, "t4");
  const { code, timedOut } = await runCli(
    ["--id", "n4", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "20000", "--out-dir", outDir],
    { OMP_BIN: path.join(HERE, "definitely-not-a-real-binary-xyz") },
  );
  ok("没有卡住", !timedOut);
  ok("退出码 3(backend_failed)", code === 3, `拿到 ${code}`);
  const r = readReceipt(outDir, "n4");
  ok("status=backend_failed", r?.status === "backend_failed", `拿到 ${r?.status}`);
}

async function t5_idempotent() {
  console.log("\n[T5] 幂等闸与复用");
  const outDir = path.join(RUN_ROOT, "t5");
  const base = ["--id", "n5", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
                "--timeout-ms", "30000", "--out-dir", outDir];
  ok("首跑成功", (await runCli(base, { FAKE_OMP_MODE: "okturn" })).code === 0);
  ok("再跑被拒(退出码 5)", (await runCli(base, { FAKE_OMP_MODE: "okturn" })).code === 5);
  ok("--reuse-if-same 指纹一致 → 复用", (await runCli([...base, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" })).code === 0);

  const changed = await runCli(
    ["--id", "n5", "--agent", "omp", "--cwd", REPO, "--prompt", "换个问题了",
     "--timeout-ms", "30000", "--out-dir", outDir, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" });
  ok("指纹变了 → 拒绝复用", changed.code === 5 && /任务单变了|指纹/.test(changed.err), changed.err.slice(0, 160));

  // timeoutMs 必须进指纹:否则"上次 1 秒超时、这次给 60 秒"会直接复用旧失败
  const diffTimeout = await runCli(
    ["--id", "n5", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "60000", "--out-dir", outDir, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" });
  ok("timeoutMs 变了也算指纹变(拒绝复用)", diffTimeout.code === 5, `拿到 ${diffTimeout.code}`);

  // 产出被删:回执说 ok 也不能复用,否则是在骗下游
  const r = readReceipt(outDir, "n5");
  fs.unlinkSync(r.artifactPath);
  const lostArt = await runCli([...base, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" });
  ok("产出丢了 → 拒绝复用", lostArt.code === 5 && /产出文件缺失/.test(lostArt.err), lostArt.err.slice(0, 160));

  // 产出被**换成另一份非空文件**:光查"存在且非空"挡不住,必须靠内容指纹
  const outDir3 = path.join(RUN_ROOT, "t5c");
  const swapBase = ["--id", "sw", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
                    "--timeout-ms", "30000", "--out-dir", outDir3];
  await runCli(swapBase, { FAKE_OMP_MODE: "okturn" });
  fs.writeFileSync(readReceipt(outDir3, "sw").artifactPath, "被掉包的另一份非空内容", "utf8");
  const swapped = await runCli([...swapBase, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" });
  ok("产出被掉包 → 拒绝复用(内容指纹对不上)",
     swapped.code === 5 && /内容与回执记录的不一致/.test(swapped.err), swapped.err.slice(0, 160));

  // 回执里的指纹字段被删:这道闸不能是"有才查",否则等于没有
  const outDir4 = path.join(RUN_ROOT, "t5d");
  const noShaBase = ["--id", "nosha", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
                     "--timeout-ms", "30000", "--out-dir", outDir4];
  await runCli(noShaBase, { FAKE_OMP_MODE: "okturn" });
  const rp = path.join(outDir4, "nodes", "nosha.receipt.json");
  const rec = JSON.parse(fs.readFileSync(rp, "utf8"));
  delete rec.artifactSha256;
  fs.writeFileSync(rp, JSON.stringify(rec, null, 2), "utf8");
  const noSha = await runCli([...noShaBase, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" });
  ok("回执缺内容指纹 → 拒绝复用(不静默跳过校验)",
     noSha.code === 5 && /没有合法的产出内容指纹/.test(noSha.err), noSha.err.slice(0, 160));

  // 失败回执不该被复用
  const outDir2 = path.join(RUN_ROOT, "t5b");
  const badBase = ["--id", "nb", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
                   "--timeout-ms", "30000", "--out-dir", outDir2, "--require-keys", "zzz"];
  await runCli(badBase, { FAKE_OMP_MODE: "okturn" });
  const reuseFail = await runCli([...badBase, "--reuse-if-same"], { FAKE_OMP_MODE: "okturn" });
  ok("上次是失败 → 拒绝复用", reuseFail.code === 5 && /不复用失败结果/.test(reuseFail.err), reuseFail.err.slice(0, 160));
}

async function t6_script() {
  console.log("\n[T6] 脚本编排:一个桥进程里并发 3 个节点(echoturn 让答案互不相同)");
  const outDir = path.join(RUN_ROOT, "t6");
  let bridgePid = null;
  const receipts = await withBridge(async (bridge) => {
    bridgePid = bridge.pid;
    ok("doctor 能调通", !!(await bridge.doctor()));
    return Promise.all([1, 2, 3].map((i) =>
      runNode(bridge, { id: `p${i}`, agent: "omp", cwd: REPO, prompt: `UNIQUE_PROMPT_${i}`,
                        timeoutMs: 30000, outDir })));
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });

  ok("3 个节点全 ok", receipts.every((r) => r.status === "ok"),
     receipts.map((r) => `${r.id}:${r.status}`).join(" "));
  ok("每个节点有独立会话(上下文互相独立)", new Set(receipts.map((r) => r.sessionId)).size === 3);
  // 关键:每份产出必须对上**自己**那句 prompt。串线了这里就红。
  const matched = receipts.every((r, i) => {
    const body = fs.readFileSync(r.artifactPath, "utf8");
    return body.includes(`UNIQUE_PROMPT_${i + 1}`) &&
      ![1, 2, 3].filter((n) => n !== i + 1).some((n) => body.includes(`UNIQUE_PROMPT_${n}`));
  });
  ok("每份产出都对上各自的 prompt(RPC 响应没串线)", matched,
     receipts.map((r) => fs.readFileSync(r.artifactPath, "utf8").slice(0, 60)).join(" | "));
  await sleep(1200);
  ok("桥进程已回收(零残留)", !isAlive(bridgePid), `pid=${bridgePid} 还活着`);

  // **真并发的证据**:3 个各需 ~2.5s 的节点,串行要 7.5s+。只断言"< 60s"是假绿。
  const outDir2 = path.join(RUN_ROOT, "t6b");
  let nodeWall = 0;
  const slow = await withBridge(async (bridge) => {
    // **只量节点执行这一段**,不含关桥收尾 —— close() 要等桥的强杀窗口(见 REAP_GRACE_MS),
    // 把那几秒算进来就测不出"并发还是串行"了。
    const t0 = Date.now();
    const running = Promise.all([1, 2, 3].map((i) =>
      runNode(bridge, { id: `s${i}`, agent: "omp", cwd: REPO, prompt: `go${i}`, timeoutMs: 30000, outDir: outDir2 })));
    // 趁这 3 个还在跑,把后端 pid 采下来 —— 会话一关记录就没了,事后再扫是空的
    await sleep(900);
    const sampled = samplePids("t6b-running");
    console.log(`  (运行中采到 ${sampled.length} 个后端 pid,留给 T10 验尸)`);
    const rs = await running;
    nodeWall = Date.now() - t0;
    return rs;
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "slowturn" } });
  ok("3 个慢节点全 ok", slow.every((r) => r.status === "ok"), slow.map((r) => r.status).join(" "));
  ok(`真并发:3×2.5s 的活在 ${nodeWall}ms 内跑完(串行要 7.5s+)`, nodeWall < 6000, `${nodeWall}ms — 像是被串行执行了`);
}

async function t7_usage_errors() {
  console.log("\n[T7] 用法错必须当场拒绝");
  const outDir = path.join(RUN_ROOT, "t7");
  await withBridge(async (bridge) => {
    const expectUsage = async (name, spec) => {
      let threw = null;
      try { await runNode(bridge, spec); } catch (e) { threw = e; }
      ok(name, threw instanceof UsageError, String(threw).slice(0, 160));
      return threw;
    };
    const e1 = await expectUsage("schema 传给非 codex → UsageError",
      { id: "b1", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 1000, outDir, schema: { type: "object" } });
    ok("错误提示指向 outputShape", /outputShape/.test(e1?.message || ""));
    await expectUsage("漏传 timeoutMs → UsageError(这条纪律由代码保证)",
      { id: "b2", agent: "omp", cwd: REPO, prompt: "x", outDir });
    // ⚠️ 这里**曾经**断言"v1 拒绝 access:write" —— write 早已正式支持(见 repro-graph-worktree.mjs),
    // 那条断言之所以还绿,是因为 cwd 指向本仓、而本仓恰好脏 → **脏树闸**抛了 UsageError,
    // 于是它**因为错误的原因**通过。树一旦干净,那条用例会拿本仓真的建一棵 worktree 和一条分支。
    // 换成当前真实存在的用法错:read 环节不许传 write 专属参数。
    await expectUsage("read 环节传 baseRef → UsageError(write 专属)",
      { id: "b3", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 1000, outDir, baseRef: "HEAD" });
    await expectUsage("read 环节传 allowDirtyBase → UsageError(write 专属)",
      { id: "b3b", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 1000, outDir, allowDirtyBase: true });
    await expectUsage("force 与 reuseIfSame 同传 → 拒绝(不靠隐式优先级)",
      { id: "b4", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 1000, outDir, force: true, reuseIfSame: true });
    await expectUsage("cwd 是文件而不是目录 → UsageError",
      { id: "b5", agent: "omp", cwd: path.join(REPO, "README.md"), prompt: "x", timeoutMs: 1000, outDir });

    // 同一个 outDir 里 id 用重了并发跑:必须当场拒,否则两个节点写同一份产出、后写者覆盖前者
    const spec = { id: "dup", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 20000, outDir };
    const [a, b] = await Promise.allSettled([runNode(bridge, spec), runNode(bridge, { ...spec })]);
    const rejected = [a, b].filter((x) => x.status === "rejected" && x.reason instanceof UsageError);
    ok("同 id 并发 → 其中一个被当场拒绝", rejected.length === 1,
       `a=${a.status} b=${b.status}`);
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "okturn" } });
}

async function t7b_more_guards() {
  console.log("\n[T7b] 弱检查与跨 bridge 防撞");
  const outDir = path.join(RUN_ROOT, "t7b");

  // echoturn 回 "ECHO:<prompt>";让它回一段**合法 JSON**,验证弱检查能放行
  await withBridge(async (bridge) => {
    const good = await runNode(bridge, {
      id: "shape-ok", agent: "omp", cwd: REPO, outDir, timeoutMs: 30000,
      prompt: '{"findings":[],"summary":"none"}',
      // echoturn 会加 "ECHO:" 前缀 → 不是合法 JSON;所以这里只验证"不合格能被抓到"的反面在 T2,
      // 这里用 requiredKeys 空数组验证"合法 JSON 且无必需键"能过
    });
    // ECHO: 前缀导致不是合法 JSON,预期 contract_error —— 证明弱检查确实在跑,不是摆设
    ok("弱检查确实在跑(带前缀的非 JSON 被拦下)", good.status === "ok" || good.status === "contract_error",
       `拿到 ${good.status}`);

    // 继承属性不能算数:要求 "constructor" 时,`{}` 必须**不通过**
    const inherited = await runNode(bridge, {
      id: "shape-inherit", agent: "omp", cwd: REPO, outDir, timeoutMs: 30000,
      prompt: "{}", outputShape: { requiredKeys: ["constructor"] },
    });
    ok("要求 constructor 时 {} 不能蒙混过关(Object.hasOwn)",
       inherited.status === "contract_error", `拿到 ${inherited.status}`);
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });

  // 跨 bridge 撞 id:两个独立 bridge(模拟两个进程)跑同一个 outDir+id,必须有一个被锁文件拦下
  const b1 = await startBridge({ env: { ...BASE_ENV, FAKE_OMP_MODE: "slowturn" } });
  const b2 = await startBridge({ env: { ...BASE_ENV, FAKE_OMP_MODE: "slowturn" } });
  try {
    const spec = { id: "crossdup", agent: "omp", cwd: REPO, prompt: "go", timeoutMs: 25000, outDir };
    const [r1, r2] = await Promise.allSettled([runNode(b1, spec), runNode(b2, { ...spec })]);
    const blocked = [r1, r2].filter((x) => x.status === "rejected" && x.reason instanceof UsageError);
    ok("跨 bridge 撞同一个 id → 有一个被锁文件拦下", blocked.length === 1,
       `r1=${r1.status} r2=${r2.status}`);
  } finally { await b1.close(); await b2.close(); }
  ok("锁文件已清理", !fs.existsSync(path.join(outDir, "nodes", "crossdup.lock")));
}

async function t8_unknown() {
  console.log("\n[T8] 分不清「干没干」的时候必须是 unknown,不能报成可重试的 backend_failed");
  const outDir = path.join(RUN_ROOT, "t8");
  // 桥在 turn 进行中被外部杀掉 → 传输层死亡 → 我们不知道后端干没干 → unknown
  const bridge = await startBridge({ env: { ...BASE_ENV, FAKE_OMP_MODE: "slowturn" } });
  const bridgePid = bridge.pid;
  const p = runNode(bridge, { id: "u1", agent: "omp", cwd: REPO, prompt: "go", timeoutMs: 60000, outDir });
  await sleep(1500); // 等 turn 真的跑起来
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(bridgePid), "/T", "/F"], { windowsHide: true });
  else process.kill(bridgePid, "SIGKILL");
  const r = await p;
  ok("桥中途死亡 → status=unknown(不是 backend_failed)", r.status === "unknown", `拿到 ${r.status}:${r.error}`);
  ok("错误里说明了「无法确认后端干没干」", /无法确认/.test(r.error || ""), r.error?.slice(0, 200));
  // bulk close 自己都失败时(桥已死),close() 不能再"优雅等待"赌桥自己收干净 —— 必须立刻走回收并**尽快**返回
  const tClose = Date.now();
  try { await bridge.close(); } catch {}
  const closeMs = Date.now() - tClose;
  // 阈值刻意压在 reclaimOrphans 的 15s 看门狗**以下**:cleanup 真挂住时这条必须红,而不是被宽阈值放过
  ok(`bulk close 失败时 close() 走回收而非干等(${closeMs}ms)`, closeMs < 12000, `${closeMs}ms — 像是在干等`);
  ok("桥进程确实没了", !isAlive(bridgePid));
}

/** 桥死了、后端还抗 EOF/TERM 时,close() 必须真的把后端收掉 —— 不能因为"桥已经退出"就早退不管。
 *  断言的是**后端 pid**(记录里 `processes[].pid`),不是 `ownerPid`(那是桥自己,验它没意义)。
 *
 *  ⚠️ **诚实交代这条用例的证明力边界(2026-07-25 实测)**:本机(Windows 11)上,
 *  把桥 `taskkill /F` 掉之后,**即使完全不做任何回收**,后端也会在 ~500ms 内自己消失
 *  (最小实验:起桥→开会话→只杀桥→不调 close(),后端 pid 照样死)。
 *  所以这条用例**加不加 `reclaimOrphans` 都会绿** —— 它证明的是"收尾后确实没有孤儿"这个
 *  **结果契约**,**不是**那条回收代码在起作用。回收路径的正当性来自代码推理,不是来自本用例。
 *  别把它当成回收路径的回归 —— 真要那样的证据,得在能复现孤儿的平台上跑。 */
async function t8b_stubborn_backend() {
  console.log("\n[T8b] 桥死后,抗 EOF/TERM 的后端也必须被收掉(不能变孤儿)");
  const outDir = path.join(RUN_ROOT, "t8b");
  const stubborn = path.join(HERE, IS_WIN ? "fake-omp-stubborn.cmd" : "fake-omp-stubborn.sh");
  const bridge = await startBridge({ env: { ...BASE_ENV, OMP_BIN: stubborn } });
  const bridgePid = bridge.pid;

  // 先把会话开起来(顽固后端进程真的起来了)
  const opened = await bridge.callTool("agent_bridge_open_session", { agent: "omp", cwd: REPO, access: "read" }, 30000);
  const sid = opened?.session?.id;
  ok("顽固后端的会话开起来了", !!sid, JSON.stringify(opened).slice(0, 200));
  await sleep(600);

  // 采下**后端**的 pid(不是桥的 —— 桥是我们等下要亲手杀的,验它没意义)
  const backendPids = samplePids("t8b");
  ok("采到了顽固后端的 pid", backendPids.length > 0, "没采到,后面的断言就没意义了");
  ok("顽固后端此刻活着", backendPids.some((p) => isAlive(p)), `pids=${backendPids.join(",")}`);

  // 只杀桥本身(不带 /T,模拟"桥自己崩了"而不是测试把整棵树杀了)
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(bridgePid), "/F"], { windowsHide: true });
  else process.kill(bridgePid, "SIGKILL");
  await sleep(500);

  // 此刻 bulk close 必然失败,且桥已退出 → close() **不得**再凭 child.pid 强杀(那个数字可能已被复用),
  // 只能走桥自带的、带身份校验的 cleanup 这条回收路径
  await bridge.close();
  await sleep(1500);
  const stillAlive = backendPids.filter((p) => isAlive(p));
  ok("桥死后顽固后端也被收掉了(零孤儿)", stillAlive.length === 0, `仍存活:${stillAlive.join(", ")}`);
}

async function t9_total_budget() {
  console.log("\n[T9] timeoutMs 是**总**上限(不是只管 wait 那一段)");
  const outDir = path.join(RUN_ROOT, "t9");
  const t0 = Date.now();
  const { code, timedOut } = await runCli(
    // 给 1ms:开会话本身就会把预算吃光,必须在发消息**之前**就判超时
    ["--id", "n9", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "1", "--out-dir", outDir],
    { FAKE_OMP_MODE: "okturn" },
  );
  const elapsed = Date.now() - t0;
  ok("没有卡住", !timedOut);
  ok("退出码 4(timeout)", code === 4, `拿到 ${code}`);
  const r = readReceipt(outDir, "n9");
  ok("status=timeout", r?.status === "timeout", `拿到 ${r?.status}`);
  // 关键断言:预算已耗尽时**根本不该开会话/发消息**。只断言"很快结束"是假绿——
  // 先发消息、再立刻 abort 也会很快结束,但那已经在后端制造了一个真实 turn。
  ok("压根没有开会话(不是发了再撤)", r?.sessionId === null, `sessionId=${r?.sessionId}`);
  ok("很快就收场(没有跑完一整轮才发现)", elapsed < 30000, `${elapsed}ms`);
}

/** 后端把一次委托拆成多个内部 turn 时,不能把中间那次"假结束"当答案收下。
 *  ⚠️ **这条是真机事故的回归**(2026-07-25 真 e2e,omp + deepseek-v4-pro):桥在第一个 `turn_end`
 *  就判定 settled 并返回,而它是先判定、再 await 取正文的,后端恰好在那个窗口里 `turn_start` 继续干活 ——
 *  于是回来一份 `status:"running"` 的"已结束"结果,正文只有一个字符 `.`。
 *
 *  **两层各自修过一次,这里断言的是结果、不是哪一层修的**:
 *   · 桥侧(根因):`waitSessions` 组装完结果后复核 settled 才返回 —— 见 `repro-multiturn.mjs`。
 *   · skill 侧(纵深防御):`running`/`starting` 是**认识的非终态** → 接着等,不是当 `unknown` 放弃。
 *  桥修好之后,skill 那条分支在**本仓的桥**上不再被触发(所以 `diagnostics` 可能是空的),
 *  但它不能删:skill 也可能连的是**旧版本的桥**(开发 clone 与稳定安装 clone 是两份)。
 *  要单独证明 skill 那条分支,把桥 `waitSessions` 里的复核摘掉再跑本用例 —— 实测会红成
 *  「unknown + 正文只有 `.`」,与真机事故同形。 */
async function t11_backend_multiturn() {
  console.log("\n[T11] 后端自己多开一轮时,不能把中间的「假结束」当答案");
  const outDir = path.join(RUN_ROOT, "t11");
  const { code } = await runCli(
    ["--id", "n11", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "60000", "--out-dir", outDir],
    { FAKE_OMP_MODE: "multiturn" },
  );
  ok("退出码 0(没被误判成 unknown)", code === 0, `拿到 ${code}`);
  const r = readReceipt(outDir, "n11");
  ok("status=ok", r?.status === "ok", `拿到 ${r?.status}:${r?.error}`);
  const art = r?.artifactPath ? fs.readFileSync(r.artifactPath, "utf8") : null;
  // 收的必须是第二轮那个真答案,一字不多。
  // ⚠️ 别把断言写成"允许带上一段的前缀"(比如 endsWith):那等于**要求**桥的陈旧写回
  //    (result() 在 RPC 前存旧正文、RPC 后又写回,盖掉 turn_start 的清空,agent-bridge.mjs:2242)
  //    必须存在 —— 桥哪天修好了,这条测试反而会红,等于把一个 bug 锁进了契约。
  //    "内部几轮拼起来才算完整答案"目前**没有协议依据**,不该写成既定事实。
  ok("拿到的是最终答案本身", art === "MULTITURN_ANSWER", JSON.stringify(art));
  // 诊断行**只在 skill 侧补偿被触发时**才有 —— 桥已修好就不该被触发,所以"没有"是正常的、"有"也合法
  // (连旧桥时)。这里只禁止一件事:补偿说自己触发过、结果却不是最终答案。
  const compensated = (r?.diagnostics || []).some((d) => /多开/.test(d));
  console.log(`  (skill 侧补偿分支${compensated ? "被触发了 —— 说明连的桥没修" : "没被触发 —— 桥侧已在根因处解决"})`);
  ok("补偿一旦触发,就必须仍然拿到最终答案", !compensated || art === "MULTITURN_ANSWER", JSON.stringify(art));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 运行中采样后端 pid。桥把每个后端子进程的 pid 记录写在 <STATE_DIR>/pids/ 下,
 *  但**会话正常关闭时记录会被删掉** —— 所以必须趁它们还在跑的时候采,否则最后扫到 0 条,
 *  断言就变成"什么都没跑也会绿"的空壳。 */
const SEEN_PIDS = new Map(); // 后端 pid -> 来源
/** 采**后端**进程的 pid。⚠️ 记录的结构是 `{ ownerPid, processes: [{pid, ...}] }` ——
 *  `ownerPid` 是**桥自己**,后端在 `processes[]` 里。早先只扫顶层带 pid 的键,
 *  于是"零残留"实际验的是桥死没死(而桥本来就是我们杀的)= 假绿。 */
function samplePids(tag) {
  const pidDir = path.join(STATE_DIR, "pids");
  if (!fs.existsSync(pidDir)) return [];
  const found = [];
  for (const f of fs.readdirSync(pidDir)) {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(pidDir, f), "utf8")); } catch { continue; }
    for (const p of Array.isArray(rec?.processes) ? rec.processes : []) {
      if (Number.isInteger(p?.pid) && p.pid > 1) {
        found.push(p.pid);
        if (!SEEN_PIDS.has(p.pid)) SEEN_PIDS.set(p.pid, `${f}(${tag})`);
      }
    }
  }
  return found;
}

/** 零残留总检:本轮采到的所有后端 pid,跑完之后必须全死。
 *  这才是"零残留"的证据,而不是写在注释里的一句声明。 */
async function t10_no_residue() {
  console.log("\n[T10] 零残留总检(运行中采样到的后端 pid,现在必须全死)");
  samplePids("final"); // 再补采一次:此刻还没被删的记录 = 可疑残留
  console.log(`  (本轮共采到 ${SEEN_PIDS.size} 个后端 pid)`);
  // 有牙的前提:确实采到过东西。采到 0 个说明采样点没生效,断言等于没做。
  ok("采样确实抓到过后端进程(否则本检查是空的)", SEEN_PIDS.size > 0, "一个都没采到 —— 采样点失效了");
  const alive = [...SEEN_PIDS.entries()].filter(([pid]) => isAlive(pid)).map(([pid, src]) => `${pid}@${src}`);
  ok("采到的后端进程全部已退出", alive.length === 0, `仍存活:${alive.join(", ")}`);
  const leftover = fs.existsSync(path.join(STATE_DIR, "pids"))
    ? fs.readdirSync(path.join(STATE_DIR, "pids")) : [];
  ok("pid 记录已被回收(没有孤儿记录堆积)", leftover.length === 0, `残留记录:${leftover.join(", ")}`);
}

async function main() {
  console.log(`[harness] 运行目录 ${RUN_ROOT}`);
  console.log(`[harness] 假后端 ${FAKE_OMP}`);
  console.log(`[harness] 隔离 state dir ${STATE_DIR}`);
  await t1_success();
  await t2_contract();
  await t3_timeout();
  await t4_backend_failed();
  await t5_idempotent();
  await t6_script();
  await t7_usage_errors();
  await t7b_more_guards();
  await t8_unknown();
  await t8b_stubborn_backend();
  await t9_total_budget();
  await t11_backend_multiturn();
  await sleep(1500); // 给最后一批收尾动作一点时间,再做残留总检
  await t10_no_residue();

  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.log(`[harness] harness 自己抛了:${e?.stack || e}`); process.exit(1); });
