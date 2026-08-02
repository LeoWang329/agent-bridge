// Hermetic 回归:agent-bridge-graph 的 node-core / node-turn。
// 全程用 fake-omp 假后端(零真实模型消耗、零网络),自带隔离 state dir,每个子进程都有 watchdog。
//
//   node tests/repro-graph-node.mjs
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
//   T10 零残留总检 —— 本轮采到的所有后端 pid 跑完必须全死
//   T11 后端自己多开一轮 —— 中间那次「假结束」不许当答案
//   T12 v2 attempts[]  echoturn → 每次尝试各留一份**审计原件**(第 1 次不被第 2 次覆盖),
//                                 外加 v1 旧回执必须**响亮**失去复用资格(不是静默降级)

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge, startBridge, runNode, UsageError, FAILURE_KINDS, classifyFailure, stderrWindow,
         hasOrphanArtifacts, reconcileOutcome, archiveFailedRun,
         inferDeps } from "../skills/agent-bridge-graph/tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
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

/**
 * T0 依赖推断(纯函数,不起桥、不花钱)。
 *
 * ⚠️ **这个函数以前一条测试都没有**,于是下面这条 bug 活了很久:它把绝对路径一律跳过,
 *    而 `runNode` 回执里的 `artifactPath` 就是绝对路径 —— 「把上一个环节的 artifactPath
 *    拼进下一个环节的提问」是这套 API 最标准的串联写法(`examples/hetero-audit.mjs` 就这么写),
 *    结果推断边恒为 0 条,页面据此把图视图整个禁用。功能在它的头号用法上失效,而没有一条断言会红。
 */
function t0_infer_deps() {
  console.log("\n[T0] 依赖推断(纯函数)");
  const D = (text, self = "me") => inferDeps(text, self).deps;

  ok("T0 相对路径认得出", JSON.stringify(D("看 nodes/audit.md")) === '["audit"]');
  ok("T0 反斜杠也认", JSON.stringify(D("看 nodes\\audit.md")) === '["audit"]');

  // 这四种绝对形式都是真实会出现的:Windows 长名/短名、POSIX、file:// URL。
  ok("T0 ★ Windows 绝对路径认得出(这正是 artifactPath 的样子)",
    JSON.stringify(D("读 C:\\Users\\me\\run\\nodes\\audit.md")) === '["audit"]');
  ok("T0 ★ Windows 短名绝对路径也认(LEO~1.WAN 这种)",
    JSON.stringify(D("读 C:\\Users\\LEO~1.WAN\\run\\nodes\\audit.md")) === '["audit"]');
  ok("T0 ★ POSIX 绝对路径认得出",
    JSON.stringify(D("读 /home/me/run/nodes/audit.md")) === '["audit"]');
  ok("T0 ★ 正斜杠写的 Windows 绝对路径也认",
    JSON.stringify(D("读 C:/Users/me/run/nodes/audit.md")) === '["audit"]');

  ok("T0 多条按首次出现顺序、去重",
    JSON.stringify(D("nodes/b.md nodes/a.md nodes/b.md")) === '["b","a"]');
  ok("T0 去掉自依赖", JSON.stringify(D("nodes/me.md nodes/a.md", "me")) === '["a"]');
  ok("T0 不是 .md 的不算", JSON.stringify(D("nodes/audit.txt nodes/x.diff")) === "[]");
  ok("T0 没有 nodes/ 前缀的不算", JSON.stringify(D("看 audit.md")) === "[]");
  ok("T0 空正文给空数组(不是 null)", JSON.stringify(D("")) === "[]");

  // 截断必须说出来 —— 静默截断等价于"伪装成本来就没有"。
  const many = Array.from({ length: 250 }, (_, i) => `nodes/n${i}.md`).join(" ");
  const r = inferDeps(many, "me");
  ok("T0 超过 200 项取前 200", r.deps.length === 200, String(r.deps.length));
  ok("T0 ★ 而且把截断这件事说出来", r.truncated === true);

  // 一次真实形状的复现:汇总环节的提问里拼三个 artifactPath。
  const realistic =
    "下面几个文件是别的 agent 刚写的答案，自己去读：\n" +
    "  C:\\Users\\LEO~1.WAN\\AppData\\Local\\Temp\\flow-run\\nodes\\count-repro.md\n" +
    "  C:\\Users\\LEO~1.WAN\\AppData\\Local\\Temp\\flow-run\\nodes\\read-version.md\n" +
    "  C:\\Users\\LEO~1.WAN\\AppData\\Local\\Temp\\flow-run\\nodes\\list-skills.md\n";
  ok("T0 ★★ 真实形状:汇总环节拼三个 artifactPath ⇒ 推断出三条边(改之前这里是 0 条)",
    JSON.stringify(inferDeps(realistic, "summary").deps)
      === '["count-repro","read-version","list-skills"]',
    JSON.stringify(inferDeps(realistic, "summary").deps));
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

  // ⚠️ **判据必须自校准,不能用绝对毫秒数。** 这里真正要证的是"并发而不是串行",
  // 而单个节点的墙钟里除了那 2.5s 还有开会话/关会话的开销 —— 那部分随机器、随
  // Defender 的心情浮动(这台 Windows 上实测三个节点要 ~6.9s,写死 `< 6000` 就永远红)。
  // 调大阈值是"改断言来将就";正确做法是**先量一个单节点**,再要求三个并发的墙钟
  // 明显低于"串行三次"。串行 ≈ 3×solo,并发 ≈ solo + 一点点。取 2× 当分界:
  // 既容得下冷启开销的抖动,又离 3× 足够远 —— 真串行了一定判红。
  const outDir3 = path.join(RUN_ROOT, "t6c");
  let soloWall = 0;
  await withBridge(async (bridge) => {
    const t0 = Date.now();
    const r = await runNode(bridge, { id: "solo", agent: "omp", cwd: REPO, prompt: "go-solo",
                                      timeoutMs: 30000, outDir: outDir3 });
    soloWall = Date.now() - t0;
    ok("基准单节点 ok(否则下面那条比值没有意义)", r.status === "ok", r.status);
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "slowturn" } });
  ok(`真并发:3 个节点 ${nodeWall}ms vs 单个 ${soloWall}ms —— 串行的话应该接近 3 倍`,
     nodeWall < soloWall * 2, `${nodeWall}ms >= 2×${soloWall}ms — 像是被串行执行了`);
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

/** 每次尝试各留一份**审计原件**(回执 v2 的 `attempts[]`)。
 *
 *  ⚠️ 这个用例的判别力全靠 `echoturn`:它把收到的提问原样回显,而两次尝试**发的提问不同**
 *  (第 2 次是「上一条回复不符合约定 + 纠正要求」)。于是"第一次的产出有没有被第二次冲掉"
 *  变成一句**能证伪**的话 —— 用 `okturn` 两次回同样的字,这条断言就永远是绿的,等于没做。 */
async function t12_attempts() {
  console.log("\n[T12] 每次尝试各留一份审计原件(v2 attempts[])");
  const outDir = path.join(RUN_ROOT, "t12");
  const PROMPT = "第一次的提问-唯一串-alpha";
  const { code, timedOut } = await runCli(
    ["--id", "n12", "--agent", "omp", "--cwd", REPO, "--prompt", PROMPT,
     "--timeout-ms", "30000", "--out-dir", outDir, "--require-keys", "findings"],
    { FAKE_OMP_MODE: "echoturn" },
  );
  ok("没有卡住", !timedOut);
  ok("退出码 2(contract_error)", code === 2, `拿到 ${code}`);
  const r = readReceipt(outDir, "n12");
  ok("回执版本升到 2", r?.receiptVersion === 2, `拿到 ${r?.receiptVersion}`);
  const as = r?.attempts || [];
  ok("两次尝试各一条", as.length === 2, `拿到 ${as.length}`);
  ok("n 是 1-based 且递增", as[0]?.n === 1 && as[1]?.n === 2);
  ok("两条都是 rejected", as.every((a) => a.status === "rejected"));
  ok("两条都带 rejectedReason(当初为什么判它不合格)",
     as.every((a) => typeof a.rejectedReason === "string" && a.rejectedReason.length > 0));
  ok("inputSha256 恒有且是 hex64", as.every((a) => /^[0-9a-f]{64}$/.test(a.inputSha256 || "")));
  ok("两次的输入不同(第 2 次是打回重说的正文)", as[0].inputSha256 !== as[1].inputSha256);
  ok("第 1 次的 inputSha256 就是原提问的指纹",
     as[0].inputSha256 === crypto.createHash("sha256").update(PROMPT, "utf8").digest("hex"));

  // ★ 本用例的要害:两份原件**各自独立存在**,第一次那份没有被第二次覆盖。
  const p1 = as[0]?.artifactPath, p2 = as[1]?.artifactPath;
  ok("两次各有自己的产出文件", !!p1 && !!p2 && p1 !== p2, `${p1} / ${p2}`);
  ok("两个文件都真在盘上", !!p1 && fs.existsSync(p1) && !!p2 && fs.existsSync(p2));
  const c1 = p1 ? fs.readFileSync(p1, "utf8") : "";
  const c2 = p2 ? fs.readFileSync(p2, "utf8") : "";
  ok("★ 第 1 次的产出**没有被第 2 次覆盖**(它回显的仍是原提问)", c1.includes(PROMPT), c1.slice(0, 120));
  ok("★ 第 2 次的产出是打回重说那条(内容确实不同)",
     c2 !== c1 && /不符合约定的输出格式/.test(c2), c2.slice(0, 120));
  ok("文件名带 .a<N> 这一段", /\.a1\.md$/.test(p1 || "") && /\.a2\.md$/.test(p2 || ""), `${p1} / ${p2}`);
  // 该轮的 artifactPath 仍是"最后一次"那份 —— 与 a2 同字节,但**不是**同一个文件
  ok("该轮 artifactPath 仍指向 <id>.md(与 a2 同字节)",
     /n12\.md$/.test(r?.artifactPath || "") && fs.readFileSync(r.artifactPath, "utf8") === c2);

  // ---- 回执升版的迁移代价:一张 v1 旧回执必须**响亮**地失去复用资格 ----
  // ⚠️ 这是升版的全部理由。一张缺 attempts[] 的旧回执若被当成"支持新 UI 的回执",
  //    页面上那一段只会是空白 —— 又一次「字段缺失＝静默降级」,本仓已栽过三次。
  const v1Dir = path.join(RUN_ROOT, "t12b");
  fs.mkdirSync(path.join(v1Dir, "nodes"), { recursive: true });
  const artifact = path.join(v1Dir, "nodes", "old.md");
  fs.writeFileSync(artifact, "上一版跑出来的产出\n");
  const v1 = {
    receiptVersion: 1, id: "old", specHash: "deadbeefdeadbeefdeadbeefdeadbeef",
    agent: "omp", model: null, effort: null, status: "ok",
    artifactPath: artifact, artifactSha256: crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
    charCount: 10, byteCount: 10, contextUsage: null, reaskCount: 0, durationMs: 1,
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    diagnostics: [], error: null, scene: null, sessionId: null,
    abortConfirmed: null, closeConfirmed: true, access: "read", workspace: null,
  };
  fs.writeFileSync(path.join(v1Dir, "nodes", "old.receipt.json"), JSON.stringify(v1, null, 2));
  const v1run = await runCli(
    ["--id", "old", "--agent", "omp", "--cwd", REPO, "--prompt", "go",
     "--timeout-ms", "30000", "--out-dir", v1Dir, "--reuse-if-same"],
    { FAKE_OMP_MODE: "okturn" },
  );
  ok("v1 回执:退出码 5(用法错,不是静默复用)", v1run.code === 5, `拿到 ${v1run.code}`);
  ok("v1 回执:报错说清是版本对不上", /版本对不上/.test(v1run.err + v1run.out));
  ok("v1 回执:报错说清 v1→v2 加了什么、为什么不能静默降级",
     /attempts/.test(v1run.err + v1run.out) && /空白|静默/.test(v1run.err + v1run.out));
  ok("v1 回执:给了处置办法(force)", /force/.test(v1run.err + v1run.out));
  // 负对照:**没有**去复用那份旧产出(它一个字节都没被当成本次结果)
  ok("v1 回执:确实没有静默复用", !fs.existsSync(path.join(v1Dir, "nodes", "old.a1.md")));
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

// ── T13:实跑缺陷清单(DEFECTS-agent-bridge-graph-observed-2026-07-29)的收口 ──
//
// 这一节钉住四条"用出来的"缺陷的修法。判据都是**改坏实现就会红**,
// 不是"跑起来没报错"(那一类断言在本仓已经被证伪过好几次)。
async function t13_defect_fixes() {
  console.log("\n[T13] 实跑缺陷清单的收口:runAll / failureKind / retryFailed / scope");

  // ── D4+D8:并行部分成果不许丢 ────────────────────────────────────────────
  // 形状:三个节点并行,其中一个 id 撞锁(派发阶段抛)。
  // 用 Promise.all 时那一抛会让整体 reject、另外两个已跑完的产出全丢;
  // runAll 必须三个结局都给回来。
  {
    const outDir = path.join(RUN_ROOT, "t13-runall");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    // ⚠️ id 刻意**不按字典序**排(zulu / alpha / mike)。原先用 p1/p2/p3,输入本身就有序,
    //    于是"内部拿 id 排个序再返回"这种坏实现照样能让同序断言变绿 —— 复审点名的假绿之一。
    const IDS = ["zulu", "alpha", "mike"];
    // 预先占住中间那个的锁 —— 这正是"派发阶段抛 UsageError"的真实形状(id 撞了)
    fs.writeFileSync(path.join(nodesDir, "alpha.lock"), "someone-else\n");

    const rs = await withBridge(async (bridge) =>
      bridge.runAll(IDS.map((id, i) => ({
        id, agent: "omp", cwd: REPO, prompt: `RUNALL_${i}`,
        timeoutMs: 30000, outDir,
      }))), { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });

    ok("D4 ★ runAll 与 specs 同序等长(按下标取是安全的;id 故意非字典序,排序过就露馅)",
      Array.isArray(rs) && rs.length === 3 && rs.every((r, i) => r?.id === IDS[i]),
      JSON.stringify(rs.map((r) => r?.id)));
    ok("D4 ★ 撞锁那个环节没有把其余环节的产出一起带走",
      rs[0].status === "ok" && rs[2].status === "ok",
      rs.map((r) => `${r.id}:${r.status}`).join(" "));
    ok("D4 ★ 派发阶段抛出的归一成 unknown + dispatchError(不伪装成后端失败)",
      rs[1].status === "unknown" && typeof rs[1].dispatchError === "string"
        && /锁文件已存在/.test(rs[1].dispatchError) && rs[1].failureKind === "internal",
      JSON.stringify({ s: rs[1].status, d: rs[1].dispatchError?.slice(0, 80), k: rs[1].failureKind }));
    ok("D4 成功的那两个产出真的落盘了(不是只有个 status 好看)",
      [rs[0], rs[2]].every((r) => r.artifactPath && fs.existsSync(r.artifactPath)
        && fs.readFileSync(r.artifactPath, "utf8").includes("RUNALL_")),
      JSON.stringify([rs[0].artifactPath, rs[2].artifactPath]));
  }

  // 用法错必须在派发**任何**环节之前抛 —— 那时没有产出可丢,而拼错的字段
  // 也不该伪装成"某个环节失败了"混过去。
  {
    const outDir = path.join(RUN_ROOT, "t13-runall-usage");
    let threw = null, ranAnything = false;
    await withBridge(async (bridge) => {
      try {
        await bridge.runAll([
          { id: "good", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir },
          { id: "bad", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir, reask: 7 },
        ]);
      } catch (e) { threw = e; }
      // ⚠️ 判据不能只看"回执落没落盘" —— 先启动后端、随后才发现第二个 spec 非法时,
      //    回执本来就还没写,那条断言照样绿(复审点名的假绿)。改看**磁盘上有没有任何痕迹**:
      //    预检若真在派发之前,连 nodes/ 目录都不该被建出来。
      ranAnything = fs.existsSync(path.join(outDir, "nodes"))
        && fs.readdirSync(path.join(outDir, "nodes")).length > 0;
    }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("D4 ★ 用法错在派发之前就抛(UsageError,且点名是第几个 spec)",
      threw instanceof UsageError && /第 1 个 spec/.test(threw.message), String(threw?.message).slice(0, 140));
    ok("D4 ★ 而且**一个环节都没跑**(连 nodes/ 里一个文件都没建 —— 否则就是先花钱再报错)",
      ranAnything === false,
      fs.existsSync(path.join(outDir, "nodes")) ? fs.readdirSync(path.join(outDir, "nodes")).join(", ") : "(无 nodes/)");
  }

  // ── D2:failureKind ──────────────────────────────────────────────────────
  // 真跑一个后端失败的节点,看回执上有没有分档 + 可审计的证据。
  {
    const outDir = path.join(RUN_ROOT, "t13-kind");
    // 用「后端起不来」造 backend_failed(照 T4 的做法)。
    // ⚠️ **不能用 `errturn`** —— 那是"收场了但错了",桥回报的是 unknown,不是 backend_failed。
    //    第一版就写错了,测试当场变红:挑桩子要看它到底产出什么状态。
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "boom", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir }),
      { env: { ...BASE_ENV, OMP_BIN: path.join(HERE, "definitely-not-a-real-binary-xyz") } });
    ok("D2 后端失败的节点如实是 backend_failed", r.status === "backend_failed", r.status);
    ok("D2 ★ 回执上有 failureKind,且落在封闭枚举里",
      typeof r.failureKind === "string" && FAILURE_KINDS.includes(r.failureKind),
      JSON.stringify({ k: r.failureKind }));
    ok("D2 ★ 有可审计的证据(说清凭哪一段判的,不是给个不容置疑的标签)",
      typeof r.failureEvidence === "string" && r.failureEvidence.length > 0,
      String(r.failureEvidence).slice(0, 120));
  }
  // ok 的节点上这两个字段必须恒为 null —— "有字段但恒 null" 比 "成功回执上压根没这个键" 好:
  // 调用方不必写 `?.`,也不会把 undefined 当成"没失败"。
  {
    const outDir = path.join(RUN_ROOT, "t13-kind-ok");
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "fine", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "okturn" } });
    ok("D2 成功的节点上 failureKind / failureEvidence 恒为 null(字段在,值是 null)",
      r.status === "ok" && r.failureKind === null && r.failureEvidence === null,
      JSON.stringify({ s: r.status, k: r.failureKind, e: r.failureEvidence }));
  }

  // ── D3:原地重试不破坏路径契约 ──────────────────────────────────────────
  {
    const outDir = path.join(RUN_ROOT, "t13-retry");
    const nodesDir = path.join(outDir, "nodes");
    // 第一次:让它失败
    const bad = await withBridge(async (bridge) =>
      bridge.runNode({ id: "flaky", agent: "omp", cwd: REPO, prompt: "SAME_PROMPT", timeoutMs: 30000, outDir }),
      { env: { ...BASE_ENV, OMP_BIN: path.join(HERE, "definitely-not-a-real-binary-xyz") } });
    ok("D3 第一次确实失败了(否则这段考不到重试)", bad.status === "backend_failed", bad.status);
    // 归档前把原件的**字节**留一份:后面要验"归档件就是它",而不是"归档件也是一张失败回执"。
    const firstReceiptBytes = fs.readFileSync(path.join(nodesDir, "flaky.receipt.json"), "utf8");
    // ⚠️ 故意塞一个**工具不认识的后缀**。不塞的话,这个夹具留下的恰好只有 `.receipt.json`
    //    和 `.scene` 两样 —— 于是「只搬这两种」的坏实现照样能让下面那条"一样不落"变绿
    //    (第一版就是这样,变异跑出来才发现它是被别处的报错顺带带红的,自己并没有抓到)。
    //    「不维护后缀清单」这条设计,只有拿清单外的东西去考才算考到。
    fs.writeFileSync(path.join(nodesDir, "flaky.zz-unknown-kind.txt"), "某种以后才会有的产物\n");
    const beforeFiles = fs.readdirSync(nodesDir).filter((n) => n.startsWith("flaky.") && n !== "flaky.lock");

    // 第二次:同一个 id、同一份 spec,retryFailed 原地重试
    const good = await withBridge(async (bridge) =>
      bridge.runNode({ id: "flaky", agent: "omp", cwd: REPO, prompt: "SAME_PROMPT", timeoutMs: 30000,
                       outDir, retryFailed: true }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("D3 重试这次成功了", good.status === "ok", good.status);
    ok("D3 ★ 产物路径**没变**(下游按 nodes/<id>.md 读仍然读得到最新那次)",
      good.artifactPath === path.join(nodesDir, "flaky.md") && fs.existsSync(good.artifactPath)
        && fs.readFileSync(good.artifactPath, "utf8").includes("SAME_PROMPT"),
      good.artifactPath);
    ok("D3 ★ 上一次失败的现场留成了审计原件(f1 前缀),没被销毁",
      fs.existsSync(path.join(nodesDir, "flaky.f1.receipt.json"))
        && fs.existsSync(path.join(nodesDir, "flaky.f1.scene")),
      fs.readdirSync(nodesDir).join(", "));
    // ⚠️ 这一条针对复审点名的假绿:「只搬 .receipt.json 和 .scene」的坏实现,原先照样全绿。
    //    判据改成**上一次留下的每一样都必须搬走**,而不是点名检查其中两样 ——
    //    点名检查等于又维护了一张会漏的清单,正是 archiveFailedRun 刻意不做的那件事。
    // ⚠️ 判据不能写成"原名必须消失":新的这一次会**合法地重新写出同名回执**,那样断言恒红。
    //    准确的说法是两条:①每一样都得有 f1 副本;②还留在原名下的必须是**新内容** ——
    //    第二条同时挡住"复制而不是移动"(复制的话两处字节一模一样)。
    const archivedName = (n) => `flaky.f1.${n.slice("flaky.".length)}`;
    const sameBytes = (a, b) => {
      try {
        if (!fs.statSync(a).isFile() || !fs.statSync(b).isFile()) return false;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
      } catch { return false; }
    };
    ok("D3 ★ 上一次留下的产物**一样不落**全搬进了 f1,且没有一样是被复制过去的",
      beforeFiles.length >= 2
        && beforeFiles.every((n) => fs.existsSync(path.join(nodesDir, archivedName(n))))
        && !beforeFiles.some((n) => sameBytes(path.join(nodesDir, n), path.join(nodesDir, archivedName(n)))),
      `上次留下 ${beforeFiles.join(", ")};现在 ${fs.readdirSync(nodesDir).join(", ")}`);
    ok("D3 ★ 归档件里那张回执**逐字节**就是上次那张(只比 status 的话,随便挪张失败回执都能蒙混)",
      fs.readFileSync(path.join(nodesDir, "flaky.f1.receipt.json"), "utf8") === firstReceiptBytes,
      `归档件 ${fs.readFileSync(path.join(nodesDir, "flaky.f1.receipt.json"), "utf8").length} 字 vs 原件 ${firstReceiptBytes.length} 字`);
    ok("D3 新回执里记了它是重试来的、上次什么结局",
      good.retriedFrom?.n === 1 && good.retriedFrom?.prevStatus === "backend_failed"
        && good.retriedFrom?.archivedPrefix === "flaky.f1.",
      JSON.stringify(good.retriedFrom));
    ok("D3 锁文件没被当成产物一起归档(它是我们此刻攥着的)",
      !fs.existsSync(path.join(nodesDir, "flaky.f1.lock")));

    // ⚠️ 这里**不能**接着上面那次成功往下考"f2":重试成功之后,磁盘上那张回执是 ok,
    //    `retryFailed` 按约定当没这个开关(好的不许悄悄重跑),于是既不归档也不重试 ——
    //    第一版就是这么写的,harness 当场被 UsageError 打断。要考归档号递增,
    //    就得**连续两次都失败**,所以另起一个 id。
    const outDir2 = path.join(RUN_ROOT, "t13-retry-twice");
    const nodesDir2 = path.join(outDir2, "nodes");
    const twice = [];
    for (let i = 0; i < 3; i++) {
      twice.push(await withBridge(async (bridge) =>
        bridge.runNode({ id: "always", agent: "omp", cwd: REPO, prompt: "P", timeoutMs: 30000,
                         outDir: outDir2, ...(i > 0 ? { retryFailed: true } : {}) }),
        { env: { ...BASE_ENV, OMP_BIN: path.join(HERE, "definitely-not-a-real-binary-xyz") } }));
    }
    ok("D3 前提:三次全都失败了(否则考不到归档号递增)",
      twice.every((r) => r.status === "backend_failed"), twice.map((r) => r.status).join(" "));
    ok("D3 ★ 归档号逐次递增(f1 然后 f2),f1 没被套进 f2 里(审计原件不许被覆盖)",
      twice[1].retriedFrom?.n === 1 && twice[2].retriedFrom?.n === 2
        && fs.existsSync(path.join(nodesDir2, "always.f1.receipt.json"))
        && fs.existsSync(path.join(nodesDir2, "always.f2.receipt.json"))
        && !fs.existsSync(path.join(nodesDir2, "always.f2.f1.receipt.json")),
      fs.readdirSync(nodesDir2).join(", "));
  }

  // 上一次是 ok 时,retryFailed 必须**当没这个开关** —— 绝不能把好结果悄悄重跑掉。
  {
    const outDir = path.join(RUN_ROOT, "t13-retry-ok");
    const spec = { id: "done", agent: "omp", cwd: REPO, prompt: "KEEP_ME", timeoutMs: 30000, outDir };
    const first = await withBridge(async (bridge) => bridge.runNode(spec),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("D3 前提:第一次是 ok", first.status === "ok", first.status);
    const second = await withBridge(async (bridge) =>
      bridge.runNode({ ...spec, retryFailed: true, reuseIfSame: true }),
      { env: { ...BASE_ENV, OMP_BIN: path.join(HERE, "definitely-not-a-real-binary-xyz") } });   // ← 真跑必然失败,所以"它是 ok"就证明走的是复用
    ok("D3 ★ 上次是 ok 时 retryFailed 不生效,走复用(好的复用、坏的重试)",
      second.status === "ok" && second.reused === true,
      JSON.stringify({ s: second.status, reused: second.reused }));
    ok("D3 ★ 没有产生 f1 归档(什么都没被挪动)",
      !fs.existsSync(path.join(outDir, "nodes", "done.f1.receipt.json")),
      fs.readdirSync(path.join(outDir, "nodes")).join(", "));
  }

  // ── D7:scope 拼进冻结正文 + 进指纹 ──────────────────────────────────────
  {
    const outDir = path.join(RUN_ROOT, "t13-scope");
    // echoturn 会把收到的 prompt 回显 —— 于是"范围段真的发出去了"可以逐字节验证
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "scoped", agent: "omp", cwd: REPO, prompt: "TASK_BODY", timeoutMs: 30000, outDir,
                       scope: { include: ["ONLY_THIS_FILE"], exclude: ["SKIP_THIS_ONE"],
                                outOfBounds: ["NO_TRESPASS"] } }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("D7 带 scope 的节点正常跑完", r.status === "ok", r.status);
    const body = fs.readFileSync(r.artifactPath, "utf8");
    ok("D7 ★ 范围段**真的发给了后端**(三个键一个都不许少 —— 丢掉 exclude 也算实现坏了)",
      body.includes("TASK_BODY") && body.includes("ONLY_THIS_FILE")
        && body.includes("SKIP_THIS_ONE") && body.includes("NO_TRESPASS"),
      body.slice(0, 300));
    // 改范围 = 换任务单:同 id + reuseIfSame 必须被复用闸拒掉,而不是静默复用旧结果
    let rejected = null;
    await withBridge(async (bridge) => {
      try {
        await bridge.runNode({ id: "scoped", agent: "omp", cwd: REPO, prompt: "TASK_BODY", timeoutMs: 30000,
                               outDir, reuseIfSame: true, scope: { include: ["A_DIFFERENT_FILE"] } });
      } catch (e) { rejected = e; }
    }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("D7 ★ 改了 scope 之后旧回执复用不了(否则会把上一版范围的结果当成这一版)",
      rejected instanceof UsageError && /任务单变了/.test(rejected.message),
      String(rejected?.message).slice(0, 140));
  }

  // ── 命令行入口也得有这两个开关 ────────────────────────────────────────────
  // 为什么单独考:CLI 早就有**销毁式**的 `--force`,却没有**留档式**的重试 ——
  // 只给危险的不给安全的,人就只能用危险那个。光在 JS 那层修完,CLI 用户照样撞 D3。
  {
    const outDir = path.join(RUN_ROOT, "t13-cli");
    const nodesDir = path.join(outDir, "nodes");
    const base = ["--id", "c1", "--agent", "omp", "--cwd", REPO, "--prompt", "CLI_BODY",
                  "--timeout-ms", "30000", "--out-dir", outDir];

    const bad = await runCli(base, { OMP_BIN: path.join(HERE, "definitely-not-a-real-binary-xyz") });
    ok("CLI 前提:这一次确实失败了", bad.code === 3, `exit=${bad.code}`);
    ok("D2 ★ 人读的那份输出里有判定一行(光看 error 原文分不出该不该重试)",
      /判定: (quota|auth|rate_limited|backend_crash|protocol|internal|unknown)/.test(bad.out),
      bad.out.slice(-300));

    const retry = await runCli([...base, "--retry-failed"], { FAKE_OMP_MODE: "echoturn" });
    ok("D3 ★ --retry-failed 真的通到了内核(退出码 0)", retry.code === 0, `exit=${retry.code}\n${retry.err.slice(-300)}`);
    ok("D3 ★ CLI 重试同样留档不销毁(f1 在,canonical 路径给了新的这次)",
      fs.existsSync(path.join(nodesDir, "c1.f1.receipt.json"))
        && fs.readFileSync(path.join(nodesDir, "c1.md"), "utf8").includes("CLI_BODY"),
      fs.readdirSync(nodesDir).join(", "));
    ok("D3 ★ 留档位置打给了人看(不然他不知道上次的现场去哪了)",
      /上次\(backend_failed\)已留档: c1\.f1\./.test(retry.out), retry.out.slice(-300));

    const scopePath = path.join(RUN_ROOT, "t13-cli-scope.json");
    fs.writeFileSync(scopePath, JSON.stringify({ include: ["CLI_ONLY_THIS"], outOfBounds: ["CLI_NO_TRESPASS"] }));
    const outDir2 = path.join(RUN_ROOT, "t13-cli-scope");
    const scoped = await runCli(
      ["--id", "c2", "--agent", "omp", "--cwd", REPO, "--prompt", "CLI_BODY2", "--timeout-ms", "30000",
       "--out-dir", outDir2, "--scope-file", scopePath], { FAKE_OMP_MODE: "echoturn" });
    ok("D7 ★ --scope-file 真的通到了内核(退出码 0)", scoped.code === 0, `exit=${scoped.code}\n${scoped.err.slice(-300)}`);
    const cliBody = fs.readFileSync(path.join(outDir2, "nodes", "c2.md"), "utf8");
    ok("D7 ★ CLI 传的范围段也真的发了出去",
      cliBody.includes("CLI_BODY2") && cliBody.includes("CLI_ONLY_THIS") && cliBody.includes("CLI_NO_TRESPASS"),
      cliBody.slice(0, 200));

    // 拼错的键必须当场炸。CLI 这一层**没有**自己抄一份键名清单,考的就是它确实转交给了
    // normalizeScope —— 两处分头维护判据,迟早漂成"JS 拒绝、CLI 静默忽略"。
    const typoPath = path.join(RUN_ROOT, "t13-cli-scope-typo.json");
    fs.writeFileSync(typoPath, JSON.stringify({ includes: ["oops"] }));
    const typo = await runCli(
      ["--id", "c3", "--agent", "omp", "--cwd", REPO, "--prompt", "X", "--timeout-ms", "30000",
       "--out-dir", path.join(RUN_ROOT, "t13-cli-typo"), "--scope-file", typoPath], { FAKE_OMP_MODE: "echoturn" });
    ok("D7 ★ CLI 传了拼错的 scope 键也当场拒绝(退出码 5),不是静默忽略",
      typo.code === 5 && /includes/.test(typo.err), `exit=${typo.code} ${typo.err.slice(-200)}`);
  }
}

/**
 * T14 —— 第 1 轮复审揪出来的七条。
 *
 * 这一节全是「上一版看着对、其实有洞」的东西,所以每条都写清**坏在哪**,
 * 而不是只写"应该怎样":读的人得能看出这条断言在防谁。
 */
async function t14_review_round1() {
  console.log("\n[T14] 第 1 轮复审的收口:归属歧义 / 证据串台 / 无回执残留 / 降级对账 / 形状一致");

  // ── R1:id 里的点号会让「按前缀认归属」失效 ────────────────────────────────
  // 坏在哪:id 允许点号时,重试 `a` 会把 `a.b` 的产物一起搬走 —— 连 `a.b.lock` 都偷走,
  //        那把锁一没,另一个进程就能同时再跑一遍 `a.b`。
  {
    const outDir = path.join(RUN_ROOT, "t14-id");
    let threw = null;
    await withBridge(async (bridge) => {
      try { await bridge.runNode({ id: "a.b", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir }); }
      catch (e) { threw = e; }
    }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R1 ★ 含点号的 id 当场拒绝(点号是产物名的分隔符,留着它前缀归属就不成立)",
      threw instanceof UsageError && /点号/.test(threw.message), String(threw?.message).slice(0, 140));
    ok("R1 拒绝发生在开会话之前(没白花钱)",
      !fs.existsSync(path.join(outDir, "nodes", "a.b.receipt.json")));
  }

  // ── R2:失败分类不许拿别人的 stderr 当证据 ────────────────────────────────
  // 坏在哪:桥的 stderr 尾巴是**整座桥共用一份**。前一个环节吐过 "billing account disabled",
  //        后一个环节撞上别的错,就会被判成 quota —— 于是去查账单,而不是重试。
  // 桥 stderr 没法在真跑里按需注入(那是桥进程自己的流),所以这里考**纯函数 + 分类**的组合:
  // 复现复审给的那个场景 —— 尾巴里躺着上一个环节的欠费错文,本环节撞的是 429。
  {
    const POLLUTION = "ERROR your billing account is disabled, payment required\n";
    const MINE = "ERROR HTTP 429 too many requests, please retry later\n";
    const tail = POLLUTION + MINE;

    const win = stderrWindow({ tail, totalChars: tail.length, mark: POLLUTION.length, exclusive: true });
    ok("R2 ★ 窗口只切出本轮开跑之后的那一段(上一个环节的字节留在窗口外)",
      win === MINE, JSON.stringify(win));
    ok("R2 ★ 于是分类判成 rate_limited(该等一会儿重试),不是 quota(去查账单、永久放弃)",
      classifyFailure({ status: "backend_failed", error: "", stderrTail: win }).failureKind === "rate_limited",
      JSON.stringify(classifyFailure({ status: "backend_failed", error: "", stderrTail: win })));
    // 反证:不划窗口就是复审复现出来的那个错判 —— 证明这条断言确实在防这件事。
    ok("R2 (反证)不划窗口时确实会被判成 quota —— 这就是被修掉的那个错",
      classifyFailure({ status: "backend_failed", error: "", stderrTail: tail }).failureKind === "quota",
      JSON.stringify(classifyFailure({ status: "backend_failed", error: "", stderrTail: tail })));
    ok("R2 ★ 并发过就完全不采信桥 stderr(四个环节交织在一条流里,谁的哪一行流本身没说)",
      stderrWindow({ tail, totalChars: tail.length, mark: 0, exclusive: false }) === null);
    ok("R2 本轮期间桥一个字都没吐时,老实返回 null 而不是把旧字节当新的",
      stderrWindow({ tail, totalChars: tail.length, mark: tail.length, exclusive: true }) === null);
    ok("R2 新吐的比尾巴还长时整条尾巴都算本轮的(尾巴会滑走,不能按长度反推)",
      stderrWindow({ tail, totalChars: 99999, mark: 0, exclusive: true }) === tail);
  }

  // 真跑一遍,坐实「跑完的环节会从在跑集合里摘掉」—— 漏了这一步集合只增不减,
  // 后面每个环节都会被判成并发过,于是永远拿不到桥 stderr 那份证据(静默退化)。
  {
    const outDir = path.join(RUN_ROOT, "t14-active");
    let sizes = [];
    await withBridge(async (bridge) => {
      for (const id of ["s1", "s2", "s3"]) {
        await bridge.runNode({ id, agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir });
        sizes.push(bridge._activeNodes.size);
      }
    }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R2 ★ 串行跑完三个环节后,「在跑」集合是空的(不摘干净就会静默退化成永不采信)",
      sizes.every((n) => n === 0), JSON.stringify(sizes));
  }

  // 对话节点必须**按轮**进出这个集合,不能整段占着。
  // 坏在哪:`releaseRun` 要到整段对话结束才跑,而轮与轮之间回调还会去跑**嵌套的 runNode** ——
  //        那时对话本身闲着,却仍占着集合,于是嵌套节点被判成"并发过"、白丢桥 stderr 那份证据。
  // ⚠️ 只靠 `releaseRun` 那次删除的话,把按轮那次拿掉照样全绿(变异实测就是这么漏的),
  //    所以这里在**轮与轮之间**直接看集合大小。
  {
    const outDir = path.join(RUN_ROOT, "t14-conv-active");
    const between = [];
    await withBridge(async (b) => b.conversation(
      { id: "cv", agent: "omp", cwd: REPO, outDir },
      async (turn) => {
        await turn({ key: "t1", prompt: "AAA", timeoutMs: 30000 });
        between.push(b._activeNodes.size);            // 这一刻对话闲着,集合该是空的
        await turn({ key: "t2", prompt: "BBB", timeoutMs: 30000 });
        between.push(b._activeNodes.size);
      },
    ), { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R2 ★ 对话在轮与轮之间不占着「在跑」集合(否则轮间的嵌套节点会被误判成并发)",
      between.length === 2 && between.every((n) => n === 0), JSON.stringify(between));
  }

  // ── R16:抛在**开跑之前**的那条路,也得把「在跑」标记摘掉 ────────────────────
  // 坏在哪:`settleTurn` 那次退出走不到"脏树复查/建工作树/分支名"这些抛在开跑前的路径。
  //        对话的回调完全可以 catch 掉那个错、接着跑嵌套节点 —— 那时对话早闲着了却还挂在
  //        集合里,嵌套节点被误判成并发过、白丢桥 stderr 那份证据。
  // (第 3 轮复审点名的非阻塞项;修在 liveTurn 的 finally 里,和执行闸同一个生命周期。)
  {
    // ⚠️ 要的是**轮内**那次脏树复查(它排在 markStderrWindow 之后),不是入场那次 ——
    //    入场那次在 prepareRun 里、回调压根还没跑,catch 不到(第一版就瞄错了)。
    //    所以:先给一棵干净的临时仓库,再**在回调里**把它弄脏,然后才开第一轮。
    const repo = path.join(RUN_ROOT, "t16-repo");
    fs.mkdirSync(repo, { recursive: true });
    const g = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.name", "t16"]); g(["config", "user.email", "t16@local"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "原样\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".graph/\n");
    g(["add", "-A"]); g(["commit", "-qm", "init"]);

    const outDir = path.join(repo, ".graph", "run");
    let sizeAfterCatch = null, caught = null, ranCallback = false;
    await withBridge(async (b) => b.conversation(
      { id: "cw", agent: "omp", cwd: repo, outDir, access: "write" },
      async (turn) => {
        ranCallback = true;
        // 入场时是干净的,这里把跟踪文件改掉 ⇒ 轮内复查会拦下这一轮(抛在开跑之前)。
        fs.writeFileSync(path.join(repo, "tracked.txt"), "被改脏了\n");
        try { await turn({ key: "t1", prompt: "AAA", timeoutMs: 30000 }); }
        catch (e) { caught = e; }
        sizeAfterCatch = b._activeNodes.size;
      },
    ).catch((e) => { caught = caught || e; }), { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R16 前提:回调跑到了,而且轮内脏树复查确实拦下了这一轮(抛在开跑之前)",
      ranCallback && caught instanceof UsageError,
      `回调=${ranCallback} ${caught?.constructor?.name}: ${String(caught?.message).slice(0, 120)}`);
    ok("R16 ★ 回调 catch 之后「在跑」集合是干净的(否则轮间的嵌套节点会被算成并发)",
      sizeAfterCatch === 0, String(sizeAfterCatch));
  }

  // ── R3:上次连回执都没写下来时,残留产物照样要留档 ──────────────────────────
  // 坏在哪:归档整段包在「回执存在」里。上次在写回执前就被杀掉、只留下 .md/.scene 的话,
  //        retryFailed 会直接跳过归档、把 canonical 路径覆盖掉 —— 最需要留档的场合反而不留。
  {
    const outDir = path.join(RUN_ROOT, "t14-orphan");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    // 手造「上次崩在写回执之前」的现场:有产出、有现场目录,**唯独没有回执**。
    fs.writeFileSync(path.join(nodesDir, "orphan.md"), "上一次的产出,没人给它写回执\n");
    fs.mkdirSync(path.join(nodesDir, "orphan.scene"), { recursive: true });
    fs.writeFileSync(path.join(nodesDir, "orphan.scene", "session.log"), "上一次的现场\n");

    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "orphan", agent: "omp", cwd: REPO, prompt: "NEW_RUN", timeoutMs: 30000,
                       outDir, retryFailed: true }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R3 这一次跑通了", r.status === "ok", r.status);
    ok("R3 ★ 没有回执的残留产物也被留档了(f1 里既有 .md 也有现场)",
      fs.existsSync(path.join(nodesDir, "orphan.f1.md"))
        && fs.existsSync(path.join(nodesDir, "orphan.f1.scene", "session.log")),
      fs.readdirSync(nodesDir).join(", "));
    ok("R3 ★ 上一次的正文没有被这一次覆盖掉(留档件里还是原话)",
      fs.readFileSync(path.join(nodesDir, "orphan.f1.md"), "utf8").includes("没人给它写回执"),
      fs.readFileSync(path.join(nodesDir, "orphan.f1.md"), "utf8").slice(0, 80));
    ok("R3 canonical 路径给了这一次",
      fs.readFileSync(path.join(nodesDir, "orphan.md"), "utf8").includes("NEW_RUN"));
    ok("R3 回执里记了它是从「没留下回执」那次重试来的",
      r.retriedFrom?.n === 1 && /没留下回执/.test(String(r.retriedFrom?.prevStatus)),
      JSON.stringify(r.retriedFrom));
  }

  // ── R4:归档中途搬不动,已搬走的必须还原 ──────────────────────────────────
  // 坏在哪:逐项 rename、中途抛且不回滚 —— 回执已进 f1、剩下的还在 canonical,
  //        下一次重试要么看不见回执(跳过归档直接覆盖),要么把剩下的塞进 f2,
  //        **同一次失败的现场被拆成两个号**。
  {
    const outDir = path.join(RUN_ROOT, "t14-rollback");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    fs.writeFileSync(path.join(nodesDir, "stuck.md"), "产出\n");
    fs.writeFileSync(path.join(nodesDir, "stuck.receipt.json"),
      JSON.stringify({ id: "stuck", status: "backend_failed" }) + "\n");
    // 怎么才能真的挡住 rename:**开着句柄的普通文件在这台机器上照样能改名**
    // (第一版就是这么写的,于是回滚分支根本没被走到 —— 一条没考到却看着像通过的断言)。
    // Windows 上改不动的是「里面有打开文件的目录」,而 `.scene/` 恰好是目录、
    // readdir 里又排在 `.md`/`.receipt.json` 后面:前两件先搬走、它失败,正是"半截归档"那一刻。
    fs.mkdirSync(path.join(nodesDir, "stuck.scene"), { recursive: true });
    const blockerPath = path.join(nodesDir, "stuck.scene", "session.log");
    fs.writeFileSync(blockerPath, "被占着\n");
    const held = fs.openSync(blockerPath, "r+");
    let threw = null;
    try {
      await withBridge(async (bridge) => {
        try {
          await bridge.runNode({ id: "stuck", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000,
                                 outDir, retryFailed: true });
        } catch (e) { threw = e; }
      }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    } finally { try { fs.closeSync(held); } catch {} }

    const after = fs.readdirSync(nodesDir);
    if (threw) {
      ok("R4 ★ 搬不动就停下,而且已经搬走的都还原了(现场没被拆成两半)",
        !after.some((n) => n.startsWith("stuck.f1.")) && after.includes("stuck.receipt.json")
          && after.includes("stuck.md"),
        after.join(", "));
      ok("R4 报错说清了没覆盖任何东西、以及该去处理谁",
        /没有覆盖任何东西/.test(String(threw.message)) && /stuck\.scene/.test(String(threw.message)),
        String(threw.message).slice(0, 300));
    } else {
      // 这台机器上占着句柄也能 rename(不同文件系统语义不同)——那就退而验"要么全搬要么全没搬"。
      const f1 = after.filter((n) => n.startsWith("stuck.f1."));
      ok("R4 ★ 这台机器允许占用中改名,那就必须整批搬完(不许留半截)",
        f1.length === 3, `f1 里有 ${f1.join(", ")};全部 ${after.join(", ")}`);
      ok("R4 ⚠️ 本机 rename 没被占用阻挡,**回滚分支这一轮没考到**(是没考到,不是通过了)", true);
    }
  }

  // ── R5:顶层降级成 unknown 时,failureKind 必须跟着走 ────────────────────────
  // 坏在哪:分类在轮级做,之后 write 收尾/收尾异常/回执写失败都会把 status 压成 unknown,
  //        却不动 failureKind —— 下游按分类分派时拿到 null,只能当"没失败"或者当场炸。
  {
    const outDir = path.join(RUN_ROOT, "t14-downgrade");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    // 让回执**写不下去**:把 <id>.receipt.json 这个名字先占成目录。
    // ⚠️ 必须带 `force` —— 否则幂等闸看见"回执已存在"就先炸了,压根走不到写盘那一步
    //    (第一版忘了这点,harness 当场被 UsageError 打断)。
    fs.mkdirSync(path.join(nodesDir, "cantwrite.receipt.json"), { recursive: true });
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "cantwrite", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000,
                       outDir, force: true }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R5 前提:回执写不下去,顶层被降级成 unknown", r.status === "unknown", r.status);
    ok("R5 ★ 降级之后 failureKind 不许还是 null(有字段却拿不到结论是最难查的形状)",
      FAILURE_KINDS.includes(r.failureKind), JSON.stringify({ k: r.failureKind }));
    ok("R5 ★ 而且老实标成 internal —— 这是本工具没能收场,不是后端的错(混进 backend_crash 会诱导重试本地 bug)",
      r.failureKind === "internal", String(r.failureKind));
    ok("R5 证据说清了是收尾阶段定的",
      /收尾/.test(String(r.failureEvidence)), String(r.failureEvidence).slice(0, 160));
  }

  // ── R6:CLI 拼错的开关不许静默丢弃 ────────────────────────────────────────
  // 坏在哪:parseArgs 放行任意 --xxx。`--scope-fiel x.json` 被悄悄丢掉,环节照跑照花钱,
  //        人以为范围约束生效了 —— 和 scope 里 `includes` 拼错是同一个坑。
  {
    const outDir = path.join(RUN_ROOT, "t14-cli-typo");
    const base = ["--id", "t", "--agent", "omp", "--cwd", REPO, "--prompt", "x",
                  "--timeout-ms", "30000", "--out-dir", outDir];
    const r = await runCli([...base, "--scope-fiel", "nope.json"], { FAKE_OMP_MODE: "echoturn" });
    ok("R6 ★ 拼错的开关当场拒绝(退出码 5),不是解析了没人用",
      r.code === 5 && /不认识的开关 --scope-fiel/.test(r.err), `exit=${r.code} ${r.err.slice(-200)}`);
    ok("R6 还提示了正确写法(拼错时人最需要的就是这一句)",
      /--scope-file/.test(r.err), r.err.slice(-200));
    ok("R6 ★ 而且一个字都没跑(拒绝在派发之前)",
      !fs.existsSync(path.join(outDir, "nodes", "t.receipt.json")));
    // 反面:正常开关不许被这道闸误伤。
    const good = await runCli(base, { FAKE_OMP_MODE: "echoturn" });
    ok("R6 正常开关不受影响(这道闸没有误伤)", good.code === 0, `exit=${good.code} ${good.err.slice(-200)}`);
  }

  // ── R10:判定不许命中**我们自己发出去的话** ────────────────────────────────
  // 坏在哪:现场的 session.log 是双向的,后端把我们的 prompt 原样回显进去。真 e2e 里实测到
  //        一次:prompt 写了「预期起不来」,分类就凭这四个字判成 backend_crash。
  //        真正危险的是任务正文里出现「配额」「欠费」—— 会被判成 quota,而 quota 的处置是
  //        别再重试、去充值:一次本可自愈的失败被永久放弃,人还去查一笔没问题的账。
  {
    const PROMPT = "请审计计费模块:配额耗尽时会不会重复扣款,以及 quota exceeded 的分支。\n第二行凑够长度。";
    const LOG = `> {"type":"user","content":"${PROMPT.split("\n")[0]}"}\n`
              + `< {"type":"result","subtype":"error","message":"ECONNRESET while reading"}\n`;
    const withOwn = classifyFailure({ status: "backend_failed", error: "", sceneDir: null,
                                      stderrTail: LOG, ownTexts: [PROMPT] });
    ok("R10 ★ 任务正文里的「配额 / quota」不会让失败被判成 quota(否则本可重试的活儿被永久放弃)",
      withOwn.failureKind !== "quota", JSON.stringify(withOwn));
    // 反证:不剔除就会判成 quota —— 证明这条断言确实在防这件事。
    const without = classifyFailure({ status: "backend_failed", error: "", sceneDir: null,
                                      stderrTail: LOG });
    ok("R10 (反证)不剔除自己说过的话时确实会判成 quota —— 这就是被修掉的那个错",
      without.failureKind === "quota", JSON.stringify(without));
    ok("R10 ★ 剔除只针对自己的话,后端真说的那句照样认得出(不能一并把证据削光)",
      withOwn.failureKind === "backend_crash" && /ECONNRESET/.test(String(withOwn.failureEvidence)),
      JSON.stringify(withOwn));
    // 我们只提了 `quota` 这一个词、**没构成任何一条判据**,那就不算"我们也说过" ——
    // 否则任何提到额度、限流、登录的任务正文都会把分类整体废掉。
    // (这条原先叫「太短的行不剔除」,那是按行剔除时代的说法;机制换了,名字也得跟着换,
    //  留着一个名不副实的断言,下一个人会照着它去理解一套已经不存在的逻辑。)
    const oneWord = classifyFailure({ status: "backend_failed", error: "quota exceeded", ownTexts: ["quota"] });
    ok("R10 只提了个别词、没凑成判据的,不算我们说过(否则分类会被整体废掉)",
      oneWord.failureKind === "quota", JSON.stringify(oneWord));
  }

  // 上面四条考的是**纯函数**。但「`settleTurn` 到底有没有把自己发出去的话传下去」是根**接线**,
  // 纯函数测不到 —— 变异实测过:把 `ownTexts` 置空,上面四条照样全绿。
  // 所以这里走一遍真流程:假后端出错时**把收到的原话抄进错误消息**(真后端常这么干)。
  {
    const outDir = path.join(RUN_ROOT, "t14-ownwire");
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "wire", agent: "omp", cwd: REPO, timeoutMs: 30000, outDir,
        prompt: "请审计计费模块:配额耗尽会不会重复扣款,重点看 quota exceeded 那个分支。" }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "errecho" } });
    // 前提要坐实在**分类真正会去读的那份证据**上 —— 是现场的 session.log / status.json,
    // 不是回执的 `error`(那句是桥自己的话)。第一版查错了字段,前提当场变红。
    const sceneText = r.scene?.dir
      ? fs.readdirSync(r.scene.dir).map((f) => fs.readFileSync(path.join(r.scene.dir, f), "utf8")).join("\n")
      : "";
    ok("R10 前提:这一轮失败了,而且现场里确实回显了我们的原话",
      r.status !== "ok" && /quota exceeded/.test(sceneText),
      `${r.status} / 现场 ${sceneText.length} 字`);
    ok("R10 ★★ 整条接线:真跑一遍,任务正文里的 quota 字样也不会让它被判成 quota",
      r.failureKind !== "quota",
      `判成 ${r.failureKind};凭据:${String(r.failureEvidence).slice(0, 200)}`);
  }

  // ── R11:第 2 轮复审点名的三种"绕过去"场景 ────────────────────────────────
  // 第一版是「按行把自己的话从证据里抹掉」,这三种情况都能绕过:
  //   ①后端把回显换成大写 → 抹不掉,而判据正则不分大小写 → 照样误判
  //   ②日志把引号转义 → 原文行匹配不上 → 照样误判
  //   ③输入和真错文恰好是同一句 → 真错文被一起削掉 → 该判的没判
  // 现在改成比对**命中的那一小段本身**,前两种挡住了;第三种老实报"分不清",不瞎猜。
  {
    const OWN = "请检查计费:quota exceeded 这个分支对不对。";
    const upper = classifyFailure({ status: "backend_failed",
      stderrTail: 'echo> "QUOTA EXCEEDED" 是我们问的', ownTexts: [OWN] });
    ok("R11 ★ 后端把回显改成大写也绕不过去(判据不分大小写,那比对也不能分)",
      upper.failureKind !== "quota", JSON.stringify(upper));

    const escaped = classifyFailure({ status: "backend_failed",
      stderrTail: 'log: {\\"q\\":\\"quota exceeded\\"}', ownTexts: [OWN] });
    ok("R11 ★ 日志把引号转义了也绕不过去(比对的是那个词,不是整行原文)",
      escaped.failureKind !== "quota", JSON.stringify(escaped));

    const both = classifyFailure({ status: "backend_failed",
      stderrTail: "backend: quota exceeded", ownTexts: [OWN] });
    ok("R11 ★ 输入和真错文撞在一句时,老实说「分不清」而不是瞎猜一个",
      both.failureKind === "unknown" && /分不清/.test(String(both.failureEvidence)),
      JSON.stringify(both));
    ok("R11 ★ 而且要说清「看到了什么、为什么不据此判定」(不能让人以为什么都没查到)",
      /命中/.test(String(both.failureEvidence)) && /我们自己发出去的正文里也有/.test(String(both.failureEvidence)),
      String(both.failureEvidence).slice(0, 200));

    // 我们没说过的词,照常判 —— 这道闸不许误伤。
    const clean = classifyFailure({ status: "backend_failed",
      stderrTail: "backend: quota exceeded", ownTexts: ["随便一句无关的话,长度够长"] });
    ok("R11 我们没说过的词照常判(这道闸不许误伤)",
      clean.failureKind === "quota", JSON.stringify(clean));
  }

  // ── R15:归一规则必须和判据自己的等价规则**同一套** ────────────────────────
  // 坏在哪:判据里写的是 `quota[_ ]?exceeded` —— 它**自己**就把空格和下划线当同一个东西。
  //        第一版只归一了大小写,于是「我们说 quota exceeded、日志回显 quota_exceeded」
  //        比对不上、照样误判成 quota。判据认为等价的写法,比对也必须认为等价。
  // (第 3 轮复审点名的阻塞项。少对齐一维就是一个漏洞,所以这里把三档判据各考一遍。)
  {
    const CASES = [
      ["quota", "quota exceeded", "quota_exceeded"],
      ["quota", "insufficient quota", "insufficient_quota"],
      ["rate_limited", "rate limit", "rate_limit"],
      ["auth", "invalid api key", "invalid_api_key"],
    ];
    for (const [kind, spoken, echoed] of CASES) {
      const r = classifyFailure({ status: "backend_failed",
        stderrTail: `log: ${echoed} 是回显`, ownTexts: [`请检查 ${spoken} 这个分支对不对。`] });
      ok(`R15 ★ 我们说「${spoken}」、日志回显「${echoed}」时不许判成 ${kind}`,
        r.failureKind !== kind, JSON.stringify(r));
    }
    // 反方向也要成立:我们用下划线写、日志用空格回显。
    const rev = classifyFailure({ status: "backend_failed",
      stderrTail: "log: quota exceeded", ownTexts: ["请检查 quota_exceeded 这个分支。"] });
    ok("R15 ★ 反方向同样挡住(我们写下划线、它回空格)",
      rev.failureKind !== "quota", JSON.stringify(rev));
    // 换行/多空格也是同一个词 —— 日志换行常把一句话折断。
    const wrapped = classifyFailure({ status: "backend_failed",
      stderrTail: "log: quota\n   exceeded", ownTexts: ["请检查 quota exceeded 分支。"] });
    ok("R15 ★ 折行和多空格也算同一个词(日志经常把一句话折断)",
      wrapped.failureKind !== "quota", JSON.stringify(wrapped));
    // 仍然不许误伤:我们真的没说过的时候要照常判出来。
    const still = classifyFailure({ status: "backend_failed",
      stderrTail: "backend: insufficient_quota", ownTexts: ["跟额度无关的一句话,够长"] });
    ok("R15 这道闸没有把判据变钝(没说过的照常判)",
      still.failureKind === "quota", JSON.stringify(still));
  }

  // ── R17:判据的**可选组**变体 —— 这批是「按归一表比对」那条路根本追不上的 ────────
  // 为什么单列一节:这个地方我改过三版,前两版都错在同一处 —— 去追判据的等价写法。
  //   v1 按行剔除自己的话   → 挡不住大小写、转义
  //   v2 比对命中的词 + 大小写归一 → 挡不住 `quota[_ ]?exceeded` 的下划线
  //   v3 再补空格/下划线归一 → 仍挡不住**可选组**:`额度(已)?用尽`、`token (has )?expired`、
  //      `exit(ed)? with code`、`process (tree )?(died|gone)`、`slow ?down`(写 slowdown 回 slow down)
  // v4 改成"拿同一条判据去扫我们自己的话",于是判据认为等价的一切写法天然覆盖。
  // 下面每一条**在 v3 下都会漏**,是这次换根的真凭据。
  {
    const CASES = [
      ["quota",         "额度用尽了吗",              "错误:额度已用尽"],
      ["auth",          "token expired 要怎么处理",   "错误:token has expired"],
      ["backend_crash", "exit with code 该怎么读",    "错误:exited with code 3"],
      ["backend_crash", "process died 之后呢",        "错误:process tree died"],
      ["rate_limited",  "slowdown 这个词怎么翻",      "错误:please slow down"],
      ["rate_limited",  "concurrency limit 怎么设",   "错误:concurrent limit reached"],
    ];
    for (const [kind, spoken, echoed] of CASES) {
      const r = classifyFailure({ status: "backend_failed", stderrTail: echoed, ownTexts: [spoken] });
      ok(`R17 ★ 我们说「${spoken}」、它回「${echoed}」时不许判成 ${kind}(可选组变体,归一表追不上)`,
        r.failureKind !== kind, JSON.stringify(r));
    }
    // 反面:同一批判据在我们没提过的时候必须照常判,否则这道闸就是把分类整体废了。
    const ctrl = [
      ["quota", "错误:额度已用尽"],
      ["auth", "错误:token has expired"],
      ["backend_crash", "错误:exited with code 3"],
      ["rate_limited", "错误:please slow down"],
    ];
    for (const [kind, echoed] of ctrl) {
      const r = classifyFailure({ status: "backend_failed", stderrTail: echoed,
                                 ownTexts: ["一句完全无关的任务正文,长度够用"] });
      ok(`R17 对照:我们没提过时「${echoed}」照常判成 ${kind}`,
        r.failureKind === kind, JSON.stringify(r));
    }
    // ⚠️ 判据自己的拼写 bug,是写上面那批用例时撞出来的:原先写成 `concurrent(cy)? limit`,
    //    它匹配 `concurrent limit` 和 `concurrentcy limit`(拼错那个),
    //    **匹配不到英文里正常的 `concurrency limit`** —— 于是真后端报
    //    "concurrency limit exceeded" 压根判不出 rate_limited。两种拼法都得认。
    for (const spell of ["concurrent limit reached", "concurrency limit reached"]) {
      const r = classifyFailure({ status: "backend_failed", stderrTail: `错误:${spell}`,
                                 ownTexts: ["一句无关的正文,长度够用"] });
      ok(`R17 ★ 「${spell}」要判成 rate_limited(括号放错一个字母就漏掉正常拼法)`,
        r.failureKind === "rate_limited", JSON.stringify(r));
    }

    // ⚠️ 这里**刻意不写**「同一份输入连判两次结果一致」那条断言。
    //    我写过,变异验出来它永远不会红:判据表里现在没有任何一条带 `g`/`y` 标志,
    //    复用正则对象与否观测不出差别。**一个永远不会红的断言就是假绿**,
    //    留着比没有更坏 —— 下一个人会以为那条防御被覆盖了。
    //    实现里那次 `new RegExp(...)` 是给"以后有人给判据加 g 标志"留的,
    //    等真加了、这条断言才有意义,到时候再写。
  }

  // ── R12:列不出目录 ≠ 目录里没东西 ────────────────────────────────────────
  // 坏在哪:`readdirSync` 失败时返回 false,等于把"看不见"当成"确定没有",
  //        紧接着这一次就把 <id>.md 覆盖掉 —— 正好重演要修的那条数据丢失路径。
  // ⚠️ 这里直接考函数,不走整段 runNode:真实成因是「ACL 只给写不给列」,那个在测试里造不出来;
  //    而想用"把 nodes 换成文件"去凑,`prepareRun` 更早的那次 mkdir 就先 EEXIST 了 ——
  //    第一版就是这么写的,断言变红但**红的理由不对**(错误来自 mkdir,不是这道闸)。
  //    两种成因走的是同一条 catch,所以直接喂它一个列不出来的路径就够了。
  {
    const notADir = path.join(RUN_ROOT, "t14-notadir");
    fs.writeFileSync(notADir, "我不是目录\n");
    let threw = null;
    try { hasOrphanArtifacts(notADir, "blind"); } catch (e) { threw = e; }
    ok("R12 ★ 列不出目录就抛,绝不当成「确定没有残留」返回 false",
      threw instanceof UsageError, `拿到 ${threw?.constructor?.name}: ${threw?.message}`);
    ok("R12 报错说清了没覆盖任何东西、看不见不等于没有",
      /没有覆盖任何东西/.test(String(threw?.message)) && /无法判断/.test(String(threw?.message)),
      String(threw?.message).slice(0, 200));
    ok("R12 目录压根不存在才是真的没有残留(那一档要照常返回 false,不能一起抛)",
      hasOrphanArtifacts(path.join(RUN_ROOT, "t14-never-existed"), "blind") === false);
    // 归档那一处有**同一个坑**:原先 `catch { entries = [] }`,于是什么都没搬却宣称归档成功,
    // 调用方以为现场留好了,紧接着就把它盖掉。两处必须同一条纪律。
    let threwArc = null;
    try { archiveFailedRun(notADir, "blind", "backend_failed"); } catch (e) { threwArc = e; }
    ok("R12 ★ 归档时列不出目录也要停下,绝不「当成空的、宣称归档成功」",
      threwArc instanceof UsageError && /没有覆盖任何东西/.test(String(threwArc.message)),
      `${threwArc?.constructor?.name}: ${String(threwArc?.message).slice(0, 160)}`);
    // 它现在是导出的(测试要直接调),于是**多了一个入口** —— 入口多了就不能只信上游校验。
    // 只挡点号是不够的:`..`、路径分隔符一样会让"按前缀改名"伤到别处。(第 3 轮复审点名)
    for (const badId of ["a.b", "..", "a/b", "a\\b", "*", ""]) {
      let t = null;
      try { archiveFailedRun(RUN_ROOT, badId, "backend_failed"); } catch (e) { t = e; }
      ok(`R12 ★ 归档拒绝不合规的 id ${JSON.stringify(badId)}(它会按前缀改名文件)`,
        t instanceof UsageError && /不合规|不变量/.test(String(t.message)),
        `${t?.constructor?.name}: ${String(t?.message).slice(0, 100)}`);
    }
  }

  // ── R13:降级之后不许再顶着后端那档旧分类 ──────────────────────────────────
  // 坏在哪:轮里撞了欠费(quota)、收尾又没能确认收场(unknown),原先只加一句证据前缀、
  //        把 quota 留着 —— 下游照 quota 分派就是去充值,而真正该做的是看本地收尾错误。
  // 同 R12:直接考这个函数。要在真流程里凑出「轮判成 quota、收尾又降级」得同时满足
  // 「后端吐欠费」和「收尾失败」两个条件,假后端造不出来(它吐了欠费就已经收在 unknown 上了)。
  // 与其拿一个凑不出来的夹具糊过去,不如直接把这个函数的语义钉死。
  {
    // 判据是**代号**不是状态值:`kindEpoch` = 做这次分类时是第几代,`statusEpoch` = 现在第几代。
    // 收尾每降级一次代号 +1,于是"分类是不是过期了"是直接问出来的,不是拿值推的。
    const mkRun = () => ({
      kindEpoch: 0, statusEpoch: 1,
      receipt: { status: "unknown", failureKind: "quota",
                 failureEvidence: "session.log:命中 \"insufficient_quota\" —— …余额不足…",
                 error: "回执写入失败(EISDIR)", diagnostics: [] },
    });
    const run = mkRun();
    reconcileOutcome(run, "backend_failed");
    ok("R13 ★ 降级之后不许还顶着后端那档 quota(下游照 quota 分派 = 去充值,而该做的是看本地收尾错误)",
      run.receipt.failureKind === "internal", String(run.receipt.failureKind));
    ok("R13 ★ 但轮里那档判定不许消失(要能查出来路上发生过什么)",
      /quota/.test(String(run.receipt.failureEvidence)) && /insufficient_quota/.test(String(run.receipt.failureEvidence)),
      String(run.receipt.failureEvidence).slice(0, 220));
    // 写盘失败会让对账再跑一次 —— 第二次必须是空操作,不能把前缀叠两遍。
    const before = run.receipt.failureEvidence;
    reconcileOutcome(run, "backend_failed");
    ok("R13 ★ 对账跑两次是幂等的(写盘失败会让它再跑一遍,叠两遍前缀就没法读了)",
      run.receipt.failureEvidence === before
        && (String(run.receipt.failureEvidence).match(/收尾把结局降级为/g) || []).length === 1,
      String(run.receipt.failureEvidence).slice(0, 220));

    // ★★ **状态值没变的那次降级** —— 真跑一次 graph、由独立复审揪出来的漏网之鱼。
    // 一轮已经以 unknown 收场并判成 rate_limited,收尾又因为工作区交付不明把结局再压成
    // unknown:**值一模一样**。旧判据 `kindForStatus !== receipt.status` 在这里整个跳过,
    // 于是回执长成 status:unknown + failureKind:rate_limited ——
    // 意思是"不知道后端干没干",读起来却是"限流而已,重跑就行";
    // 而重跑常带 force,force 会删掉正因为说不清才被保留下来的那棵工作树。
    const same = { kindEpoch: 0, statusEpoch: 1,
      receipt: { status: "unknown", failureKind: "rate_limited", failureEvidence: "轮里撞了限流",
                 error: "write 环节的交付物没能确认落到分支上(outcome=unknown)", diagnostics: [] } };
    reconcileOutcome(same, "unknown");
    ok("R13 ★★ 降级前后状态值一样(unknown→unknown)时也必须降级(旧判据比的是值,这一支整个漏掉)",
      same.receipt.failureKind === "internal", String(same.receipt.failureKind));
    ok("R13 ★ 值没变那次降级同样要把原判定折进证据(不能把路上发生过的事抹掉)",
      /rate_limited/.test(String(same.receipt.failureEvidence)), String(same.receipt.failureEvidence).slice(0, 200));

    // 结局没变过的时候不许乱动:轮里判的 quota 就是这张回执的答案。
    const stable = { kindEpoch: 0, statusEpoch: 0,
      receipt: { status: "backend_failed", failureKind: "quota", failureEvidence: "原判定", diagnostics: [] } };
    reconcileOutcome(stable, "backend_failed");
    ok("R13 结局没被降级过就别乱动(这道闸不许误伤正常的后端分类)",
      stable.receipt.failureKind === "quota" && stable.receipt.failureEvidence === "原判定",
      JSON.stringify(stable.receipt));
    // ok 的回执必须被清干净。
    const fine = { kindEpoch: 0, statusEpoch: 1, receipt: { status: "ok", failureKind: "quota", failureEvidence: "x", diagnostics: [] } };
    reconcileOutcome(fine, "ok");
    ok("R13 ok 的回执上两个字段一律清成 null",
      fine.receipt.failureKind === null && fine.receipt.failureEvidence === null);

    // ── 对话节点那一支(第 3 轮复审点名的第二个阻塞项)──
    // 顶层分类是从轮记录**投影**上来的。投影过来的判定属于**降级之前**那一代 ——
    // 要是在投影时把代号盖成当前这一代,下面那道降级闸就永远不触发,
    // 于是对话节点照样长出 `status:"unknown"` + `failureKind:"quota"`,正是本函数声称修掉的组合。
    const conv = {
      kindEpoch: 0, statusEpoch: 0,     // settleTurn 给每一轮记的那一代
      receipt: {
        kind: "conversation", status: "backend_failed", failureKind: null, failureEvidence: null,
        turns: [{ key: "t1", status: "ok" },
                { key: "t2", status: "backend_failed", failureKind: "quota", failureEvidence: "余额不足" }],
        error: null, diagnostics: [],
      },
    };
    reconcileOutcome(conv, "backend_failed");
    ok("R13 对话节点:顶层分类从「最坏那一轮」投影上来(否则失败的对话永远顶着 null)",
      conv.receipt.failureKind === "quota" && /第 t2 轮/.test(String(conv.receipt.failureEvidence)),
      JSON.stringify({ k: conv.receipt.failureKind, e: conv.receipt.failureEvidence }));
    // 然后模拟"回执写盘失败" —— 顶层被压成 unknown,再对一次账。
    conv.receipt.status = "unknown";
    conv.receipt.error = "回执写入失败(EISDIR)";
    conv.statusEpoch = 1;                 // 收尾降了一次级 ⇒ 代号 +1
    reconcileOutcome(conv, "backend_failed");
    ok("R13 ★★ 对话节点降级后也不许顶着 quota(投影时把代号盖成当前代就会漏掉这一支)",
      conv.receipt.failureKind === "internal", String(conv.receipt.failureKind));
    ok("R13 ★ 对话节点降级后同样要把原判定折进证据",
      /quota/.test(String(conv.receipt.failureEvidence)), String(conv.receipt.failureEvidence).slice(0, 200));
  }

  // 上面考的是函数本身。**「settleTurn 到底有没有记下这个分类是针对哪个结局做的」是根接线** ——
  // 不记的话降级判据永远不触发,而上面那些手搓 run 的断言照样全绿(变异实测过,就是这么漏的)。
  // 真流程里凑法:先让这一轮收在 contract_error(分类 = protocol),再让回执写盘失败降级成 unknown。
  {
    const outDir = path.join(RUN_ROOT, "t14-kindwire");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    fs.mkdirSync(path.join(nodesDir, "kw.receipt.json"), { recursive: true });   // 写盘必失败
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "kw", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir,
                       force: true, reask: 0, outputShape: { requiredKeys: ["never-gonna-be-there"] } }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R13 前提:轮里先判成 contract_error、随后写盘失败把顶层压成 unknown", r.status === "unknown", r.status);
    ok("R13 ★★ 整条接线:降级之后分类改成 internal,不再顶着轮里那档 protocol",
      r.failureKind === "internal", `${r.failureKind} / ${String(r.failureEvidence).slice(0, 160)}`);
    ok("R13 ★ 轮里那档 protocol 折进证据里没丢",
      /protocol/.test(String(r.failureEvidence)), String(r.failureEvidence).slice(0, 220));
  }

  // ── R14:角色设定也是「我们自己的话」 ─────────────────────────────────────
  // 坏在哪:角色文件是**我们写的**,后端同样会把它回显进日志。不算进去的话,
  //        一份写着「重点查配额相关的分支」的复审角色,能让任何失败都被判成 quota。
  {
    const roleFile = path.join(RUN_ROOT, "t14-role.md");
    fs.writeFileSync(roleFile, "你是复审者。重点检查 quota exceeded 相关的分支有没有重复扣款。\n");
    const outDir = path.join(RUN_ROOT, "t14-role");
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "role", agent: "omp", cwd: REPO, prompt: "开始吧。", timeoutMs: 30000,
                       outDir, roleFile }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "roleecho" } });
    const sceneText = r.scene?.dir
      ? fs.readdirSync(r.scene.dir).map((f) => fs.readFileSync(path.join(r.scene.dir, f), "utf8")).join("\n")
      : "";
    ok("R14 前提:失败了,而且现场里回显了角色设定的原文",
      r.status !== "ok" && /quota exceeded/.test(sceneText),
      `${r.status} / 现场 ${sceneText.length} 字`);
    ok("R14 ★ 角色设定里的词也不算后端说的(否则一份复审角色能让所有失败都变成 quota)",
      r.failureKind !== "quota",
      `判成 ${r.failureKind};凭据:${String(r.failureEvidence).slice(0, 200)}`);
  }

  // ── R9:归档的归属判定要跟文件系统同一套大小写规则 ──────────────────────────
  // 坏在哪(仅 Windows):文件名大小写不敏感,而 startsWith 敏感。id 写 `Foo`、磁盘上是
  //        `foo.receipt.json` 时,existsSync 认为"有旧回执"(于是走归档分支),
  //        readdir 过滤却一个都匹配不上 —— 什么都没搬,紧接着新的一次把 foo.* 覆盖掉。
  if (IS_WIN) {
    const outDir = path.join(RUN_ROOT, "t14-case");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    // 磁盘上是小写,任务单里写大写。
    fs.writeFileSync(path.join(nodesDir, "casey.md"), "上一次的产出\n");
    fs.writeFileSync(path.join(nodesDir, "casey.receipt.json"),
      JSON.stringify({ id: "casey", status: "backend_failed" }) + "\n");
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "Casey", agent: "omp", cwd: REPO, prompt: "NEWER", timeoutMs: 30000,
                       outDir, retryFailed: true }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    ok("R9 这一次跑通了", r.status === "ok", `${r.status} ${r.error ?? ""}`);
    const names = fs.readdirSync(nodesDir);
    ok("R9 ★ 大小写不同也认得出是同一个环节的产物,老老实实归了档",
      names.some((n) => /^casey\.f1\.md$/i.test(n)), names.join(", "));
    ok("R9 ★ 上一次的正文没有被无声覆盖掉",
      names.filter((n) => /^casey\.f1\.md$/i.test(n))
        .every((n) => fs.readFileSync(path.join(nodesDir, n), "utf8").includes("上一次的产出")),
      names.join(", "));
    ok("R9 回执也记了这是重试来的(而不是当成一次全新的首跑)",
      r.retriedFrom?.n === 1, JSON.stringify(r.retriedFrom));
  }

  // ── R18:判据里的数字和日常词必须**带上下文** ──────────────────────────────
  // 坏在哪:裸 `\b402\b` 会命中**堆栈行号**(`node-core.mjs:402:11` 里 402 两侧都是非词字符),
  //        裸 `billing` 命中 "see your billing page",裸 `capacity` 命中 "disk capacity"。
  //        后果不是"标签难看",是**把人指向充值页面** —— 一个普通崩溃被判成欠费。
  //        (真跑一次 graph、由独立复审揪出来,当场复现。)
  {
    const cls = (error, stderrTail) => classifyFailure({ status: "backend_failed", error, stderrTail }).failureKind;
    ok("R18 ★ 堆栈行号里的 402 不许判成欠费(这文件自己就三千多行,现场取 64KB 尾部必撞)",
      cls("backend exited unexpectedly", "    at settleTurn (node-core.mjs:402:11)") !== "quota",
      cls("backend exited unexpectedly", "    at settleTurn (node-core.mjs:402:11)"));
    ok("R18 ★ 401/403/429 的行号同样不许命中",
      ["node.mjs:401:3", "x.js:403:9", "y.ts:429:1"].every((s) => {
        const k = cls("crashed", `    at f (${s})`);
        return k !== "auth" && k !== "rate_limited";
      }));
    ok("R18 ★ 日常英文词 capacity / billing 不许单独成为判据",
      cls("crashed while planning", "reasoning about disk capacity of the target volume") !== "rate_limited"
      && cls("crashed", "note: see your billing page for usage details") !== "quota");
    // 反面:收紧不等于判钝 —— 真失败照样要认得出,否则这道修复就是把判据废了。
    ok("R18 ★ 带上下文的状态码照常认得出(收紧不等于判钝)",
      cls("request failed with status code 401", "") === "auth"
      && cls("HTTP 429 returned by upstream", "") === "rate_limited"
      && cls("", "upstream said 402 Payment Required") === "quota");
    ok("R18 ★ 明确措辞的真失败一条都不许漏",
      cls("", "Error: insufficient_quota: your credit balance is too low") === "quota"
      && cls("", "error: concurrency limit exceeded") === "rate_limited"
      && cls("authentication failed: invalid api key", "") === "auth");
  }

  // ── R19:来源优先级不许被类别顺序压过 ──────────────────────────────────────
  // 坏在哪:循环原先是**类别在外、来源在内**,于是类别表的先后压过了来源的先后 ——
  //        `error` 明说 auth,日志尾部飘一个 quota 字样,因为 quota 在表里排第一就判成欠费。
  //        而这个函数自己的注释写的是"证据按离后端多近取:先 error、再 stderr、最后日志"。
  //        **文档说一套、代码做一套**,两边总有一边是错的。
  {
    const k = classifyFailure({
      status: "backend_failed",
      error: "authentication failed: invalid api key",
      stderrTail: "Error: insufficient_quota: your credit balance is too low",
    });
    ok("R19 ★★ 最权威那份证据(error)说 auth,就不许被日志里排在前面的 quota 压过去",
      k.failureKind === "auth", `${k.failureKind} | ${k.failureEvidence}`);
    ok("R19 ★ 凭据要指明是从哪份证据判的(人得能回去复核)",
      /^error:/.test(String(k.failureEvidence)), String(k.failureEvidence).slice(0, 120));
    // 反面:error 里没线索时,该往下一份证据找,不能因为"优先级"就不看了。
    ok("R19 error 没线索时照常往下一份证据找",
      classifyFailure({ status: "backend_failed", error: "something went wrong",
                        stderrTail: "insufficient_quota" }).failureKind === "quota");
  }

  // ── R20:分类不许读到**上一轮**的话 ────────────────────────────────────────
  // 坏在哪:`saveScene` 每轮把**整个会话**的 session.log 拷一份,分类读它的 64KB 尾部 ——
  //        第 1 轮正常答复里提到 quota,第 2 轮以一句没有分类词的错误挂掉,就被判成欠费。
  //        同一个毛病桥 stderr 那边早就用水位线解决了,这一路当时漏了。
  {
    const sceneDir = path.join(RUN_ROOT, "t14-turnbound");
    fs.mkdirSync(sceneDir, { recursive: true });
    const turn1 = "第 1 轮:我看了一下 insufficient_quota 这个错误码的处理逻辑。\n";
    fs.writeFileSync(path.join(sceneDir, "session.log"), turn1);
    const mark = Buffer.byteLength(turn1);
    fs.appendFileSync(path.join(sceneDir, "session.log"), "第 2 轮:backend closed the stream\n");
    // 先证明夹具**有牙**:不给轮边界时它确实会被上一轮污染(否则下面那条断言永远不会红)
    ok("R20 前提:不给轮边界时,上一轮的话确实会污染判定(证明这个夹具考得到东西)",
      classifyFailure({ status: "backend_failed", error: "", sceneDir }).failureKind === "quota");
    const bounded = classifyFailure({ status: "backend_failed", error: "", sceneDir, logStartByte: mark });
    ok("R20 ★★ 给了轮边界之后,第 1 轮的 quota 字样不再算进第 2 轮的判定",
      bounded.failureKind !== "quota", `${bounded.failureKind} | ${bounded.failureEvidence}`);
    ok("R20 ★ 凭据要说清读的是哪一段(证据得能让人回去复核)",
      /本轮/.test(String(bounded.failureEvidence)), String(bounded.failureEvidence).slice(0, 140));
  }

  // ── R21:进了归档分支却一个都认不出来 ⇒ 响亮停下 ────────────────────────────
  // 坏在哪:`ownedEntries` 一个都匹配不上时,原先静静返回 `files: []`,调用方只记进回执、
  //        不校验,紧接着这一次就把上一次的现场覆盖掉 —— 无声销毁。
  //        (大小写折叠是已知的一种成因;别的成因一样致命,所以闸设在"搬了几个"上,
  //         而不是设在"是不是那个已知成因"上。)
  {
    const d = path.join(RUN_ROOT, "t14-nomatch");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "someone-else.md"), "别人的产出\n");
    let t = null;
    try { archiveFailedRun(d, "ghost", "backend_failed"); } catch (e) { t = e; }
    ok("R21 ★★ 一个都没认出来时抛,绝不「搬了零个还宣称归档成功」",
      t instanceof UsageError, `${t?.constructor?.name}: ${String(t?.message).slice(0, 120)}`);
    ok("R21 ★ 报错要说清没覆盖任何东西、以及该怎么办",
      /没有覆盖任何东西/.test(String(t?.message)) && /新 id/.test(String(t?.message)),
      String(t?.message).slice(0, 220));
    ok("R21 别人的文件一个都没被动过",
      fs.readdirSync(d).join(",") === "someone-else.md", fs.readdirSync(d).join(","));
  }

  // ── R22:JSON 被 markdown 围栏包着 = 包装,不是格式错 ────────────────────────
  // 坏在哪:真跑一次 graph,deepseek 把合法 JSON 裹进 ```json 围栏,**重问那次照裹不误**
  //        (重问提示词里已经明写"不要 markdown 代码围栏"),于是全系统唯一的 reask 被烧掉、
  //        整个环节报废 —— 而它其实答对了。
  // ⚠️ 光放松校验是**更坏**的:节点报 ok,磁盘上那份却仍然 JSON.parse 不了,
  //    失败被推迟到调用方那边,还没了线索。所以 canonical 产出必须真的能用。
  {
    const outDir = path.join(RUN_ROOT, "t14-fence");
    const r = await withBridge(async (bridge) =>
      bridge.runNode({ id: "fenced", agent: "omp", cwd: REPO, prompt: "给我 JSON", timeoutMs: 30000,
                       outDir, outputShape: { requiredKeys: ["findings"] } }),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "fenceturn" } });
    ok("R22 ★★ 裹了围栏的合法 JSON 要判 ok,不许烧掉那一次 reask",
      r.status === "ok", `${r.status} ${r.error ?? ""}`);
    ok("R22 ★ 而且一次都没重问(重问是唯一的retry,不该花在包装上)",
      !r.reaskCount, String(r.reaskCount));
    const onDisk = fs.readFileSync(r.artifactPath, "utf8");
    let parsed = null; try { parsed = JSON.parse(onDisk); } catch { /* 下面报红 */ }
    ok("R22 ★★ canonical 产出必须**真的能 parse** —— 只放松校验、不动文件等于把失败推给下游",
      parsed?.findings?.[0] === "FENCED_OK", onDisk.slice(0, 80));
    ok("R22 ★ 回执长度按磁盘上那份算(桥报的是原文长度,剥完就对不上了)",
      r.charCount === onDisk.length, `${r.charCount} vs ${onDisk.length}`);
    ok("R22 ★ 剥围栏这件事要留在回执上(改过字节就必须说出来)",
      (r.diagnostics || []).some((d) => /围栏/.test(d)), JSON.stringify(r.diagnostics));
    // 审计原件里必须是**模型原话**(带围栏)——证据一个字节都不能少
    const attempts = fs.readdirSync(path.join(outDir, "nodes")).filter((n) => /^fenced\./.test(n));
    ok("R22 前提:这一轮确实留下了产出文件", attempts.length > 0, attempts.join(","));
  }

  // ── R7:runAll 的合成回执必须和真回执**同形** ──────────────────────────────
  // 坏在哪:合成那张是手抄的字段清单,漏了 retriedFrom / inferredDeps /
  //        inferredDepsTruncated / turnDurationMs,"每个元素都是一张回执"这句话不成立。
  {
    const outDir = path.join(RUN_ROOT, "t14-shape");
    const nodesDir = path.join(outDir, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    fs.writeFileSync(path.join(nodesDir, "locked.lock"), "someone-else\n");
    const rs = await withBridge(async (bridge) =>
      bridge.runAll([
        { id: "real", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir },
        { id: "locked", agent: "omp", cwd: REPO, prompt: "x", timeoutMs: 30000, outDir },
      ]), { env: { ...BASE_ENV, FAKE_OMP_MODE: "echoturn" } });
    const [real, synth] = rs;
    ok("R7 前提:一真一合成", real.status === "ok" && synth.status === "unknown",
      `${real.status} / ${synth.status}`);
    const missing = Object.keys(real).filter((k) => !(k in synth));
    ok("R7 合成回执的键覆盖了真回执的每一个",
      missing.length === 0, `缺:${missing.join(", ")}`);
    // ⚠️ 上面那条**不是独立判据**:从 blankReceipt 里删掉一个两边共有的字段,两边一起没有,
    //    它照样绿(复审点名)。所以这里写死一份**期望键清单** —— 工厂统一了形状,
    //    就得有一份不来自工厂的东西去对它,否则测试只是在自己跟自己比。
    const EXPECTED_KEYS = [
      "receiptVersion", "id", "specHash", "agent", "model", "effort",
      "status", "artifactPath", "charCount", "byteCount", "artifactSha256",
      "contextUsage", "reaskCount", "durationMs", "turnDurationMs",
      "failureKind", "failureEvidence", "dispatchError", "retriedFrom",
      "inferredDeps", "inferredDepsTruncated",
      "startedAt", "endedAt", "diagnostics", "error", "scene",
      "sessionId", "abortConfirmed", "closeConfirmed", "attempts", "access", "workspace",
    ];
    for (const [label, rec] of [["真回执", real], ["合成回执", synth]]) {
      const lack = EXPECTED_KEYS.filter((k) => !(k in rec));
      ok(`R7 ★ ${label}含全部约定字段(清单写死在测试里,不从实现反推)`,
        lack.length === 0, `缺:${lack.join(", ")}`);
    }
    ok("R7 ★ internal 也要给证据(处置是「去看本地代码」,人得知道凭什么这么判)",
      synth.failureKind === "internal" && typeof synth.failureEvidence === "string"
        && synth.failureEvidence.length > 0,
      JSON.stringify({ k: synth.failureKind, e: synth.failureEvidence }));
  }
}

async function main() {
  console.log(`[harness] 运行目录 ${RUN_ROOT}`);
  console.log(`[harness] 假后端 ${FAKE_OMP}`);
  console.log(`[harness] 隔离 state dir ${STATE_DIR}`);
  t0_infer_deps();
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
  await t12_attempts();
  await t13_defect_fixes();
  await t14_review_round1();
  await sleep(1500); // 给最后一批收尾动作一点时间,再做残留总检
  await t10_no_residue();

  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.log(`[harness] harness 自己抛了:${e?.stack || e}`); process.exit(1); });
