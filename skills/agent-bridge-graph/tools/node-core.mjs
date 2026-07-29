// Agent Bridge Graph — 内核(零依赖,仅 Node 内建)
//
// 这是本 skill 的**主角**:一个可被 `import` 的模块,让你为某次任务临时写几十行 JS 编排,
// 节点可以是 codex / omp / claude / cursor / kimi 任意组合(异构 = 原生 Workflow 给不了的东西)。
//
//   import { withBridge } from ".../node-core.mjs";
//   await withBridge(async (bridge) => {
//     const rs = await Promise.all(FILES.map(f =>                 // 扇出:普通 Promise.all
//       bridge.runNode({ id: `audit-${f}`, agent: "codex", cwd, prompt: `审计 ${f}`,
//                        timeoutMs: 600000, outDir })));
//     const ok = rs.filter(r => r.status === "ok");               // 过滤:普通代码,不叫 AI
//     return bridge.runNode({ id: "sum", agent: "kimi", cwd, outDir, timeoutMs: 600000,
//                             prompt: `汇总:${ok.map(r => r.artifactPath).join(" ")}` });
//   });
//
// 设计边界(刻意为之,别加):
//   · **不做流程引擎** —— 没有 plan/DAG 格式、没有依赖解析、没有调度器。循环用 `for`、分支用 `if`、
//     过滤用 `filter`,都是你自己那段 JS 的事。本模块只提供「跑一个环节」和「管好桥进程」。
//   · **一个 withBridge = 一个桥进程**,里面爱跑几个环节都行(桥原生支持一进程多会话)。
//   · **runNode 不为「环节失败」抛异常**,而是返回带 status 的回执 —— 因为「一个环节挂了怎么办」
//     是策略,归调用方(项目里 roundtable 是带缺口继续、loop 是换引擎重开,没有统一答案)。
//     只有**用法错**(spec 非法)才抛 UsageError。
//   · **遇到没预料到的状态 → status:"unknown" 并保留现场,绝不自动重跑。**
//
// 失败分类的关键区分(异引擎复审 R1 的核心修正):
//   **只有桥「明确回报」的失败才算 backend_failed(=调用方可安全换人重跑);
//     本地 RPC 超时 / 断管 / 不认识的返回形状一律 unknown(=停下等人)。**
//   理由:send 的 ACK 在本地超时之后才到,turn 其实**已经在后端跑起来了** —— 这时报
//   「后端挂了」会诱导调用方重跑,等于把同一个任务干两遍(还可能同时写同一批文件)。
//   分不清「干没干」的时候,唯一安全的答案是 unknown。
//
// 与桥的关系:自己 spawn 一个私有 `agent-bridge mcp` 子进程走 stdio(桥是零导出单文件,没法直接
// import 它的会话机制;而 MCP 边界已被 docs/repro-mcp-hang/ 下几十个脚本长期验证)。这个私有进程
// 与主 agent 自己的桥连接**互不可见**:好处是互不干扰,坏处是出事主 agent 帮不上忙 ——
// 所以本模块必须自己收干净(见 close())。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { createGraphScope, NOT_APPLICABLE } from "./viz-graph.mjs";
import { createNodeViz, toTurnSummaries } from "./viz-node.mjs";

/**
 * 回执版本。**复用闸是严格等值比较**(`prev.receiptVersion !== RECEIPT_VERSION` 直接拒)。
 *
 * ⚠️ **1 → 2 是破坏性变更:磁盘上所有 v1 回执就此失去 `reuseIfSame` 资格。**
 * 不升不行 —— v2 新增了 `turns[].attempts[]` 与几个相对 `*Ref`,而一张缺 `attempts` 的
 * v1 回执若被当成"支持新 UI 的回执",页面只能显示空。那是又一次「字段缺失＝静默降级」,
 * 这个仓库已经栽过三次。**宁可让旧回执响亮地失去复用资格,也不要它静默地显示成空白。**
 */
export const RECEIPT_VERSION = 2;

/** 单次 wait 请求的上限。短的是「单次请求」不是任务本身 —— 超时了就再 wait,任务在后台继续跑。
 *  压掉「长请求 × 机器重载 → 客户端 teardown 整个 MCP 连接」这个最危险组合的暴露面。 */
const WAIT_SLICE_MS = 300000;
/** 桥自身 RPC(open/close/status 这类)的**默认**上限。注意:实际用的是它与「本环节剩余总预算」
 *  的较小值 —— 总预算是硬上限,不允许任何一次 RPC 把它顶穿。 */
const RPC_TIMEOUT_MS = 60000;
/** 关桥时等它自己退出的时间,超了杀进程树。 */
const BRIDGE_EXIT_GRACE_MS = 8000;
/** bulk close 之后、关 stdin 之前,留给桥回收后端的时间。
 *  **必须大于桥自己的强杀定时器(`scheduleForceKill` 默认 3000ms,见 agent-bridge.mjs)** ——
 *  桥对 SIGTERM 收不掉的后端是"先 TERM、3 秒后再 KILL 整棵树";我们要是提前关 stdin,
 *  桥立刻退出,那个还没到点的 KILL 定时器就跟着一起消失,**抗 TERM 的后端就此逃生继续烧钱**。 */
const REAP_GRACE_MS = 4000;
/** 收尾动作(保现场/关会话)的固定预算 —— 这些必须在总预算耗尽后仍能执行。 */
const FINALIZE_BUDGET_MS = 30000;

const IS_WINDOWS = process.platform === "win32";
/** 每个 bridge 正在跑的 `<outDir,id>` 集合。**放模块私有 WeakMap 而不是 bridge 上的公开属性** ——
 *  公开属性能被外部赋成 null 把保护关掉;WeakMap 拿不到、也随 bridge 一起被 GC。
 *  注意这只挡得住**同一个 bridge 内**的撞 id;跨 bridge / 跨进程靠下面的锁文件。 */
const ACTIVE_NODES = new WeakMap();
/** 每个 bridge 的"收尾窗口"状态:`{ lastCloseAt, unconfirmedClose }`。
 *  桥对关掉的会话是"先 TERM、3 秒后再 KILL 整棵树";只要我们在那 3 秒窗口内让桥退出,
 *  没到点的 KILL 定时器就随进程一起消失,抗 TERM 的后端逃生。所以关桥前要把窗口等完。
 *
 *  两个坑都要防:
 *  ① **不能用"bulk close 关掉了几个"当判据** —— 正常路径下每个 runNode 自己关了会话,
 *     bulk close 返回 0,但那些后端可能才刚进入强杀窗口。
 *  ② **close RPC 本地超时时,我们记的是"客户端放弃等待"的时刻,不是桥真正处理它的时刻** ——
 *     桥可能稍后才处理那条 close 并从那时才开始计时。所以这种 close 要标成"未确认",
 *     并在 bulk close 拿到响应(证明桥已经追上进度)时,**以那一刻为准重新起算**窗口。 */
const BRIDGE_REAP_STATE = new WeakMap();

function noteSessionClosed(bridge, confirmed) {
  const st = BRIDGE_REAP_STATE.get(bridge) || {};
  st.lastCloseAt = monoNow();
  if (!confirmed) st.unconfirmedClose = true;
  BRIDGE_REAP_STATE.set(bridge, st);
}
/** 单调时钟:不受系统时间回拨影响(用墙钟算 deadline 会被改表拉长/缩短任务)。 */
const monoNow = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/** 给一个 `UsageError` 打上「是哪一关拦下的」。
 *
 *  ⚠️ **在抛出点打标,不在捕获点猜。** `phase` 的全部价值是"该去看哪儿"
 *  (撞 id → 先分辨是不是有人在跑;workspace-setup → 去看残留),猜错就把人指到错的地方。
 *  ⚠️ **只补第一个**:内层已经标过的不覆盖 —— 同关同义的两个抛点共用一个 phase 是对的,
 *  但外层的粗粒度标签不许盖掉内层的精确标签。 */
async function taggedPhase(phase, fn) {
  try { return await fn(); }
  catch (e) { if (e instanceof UsageError && !e.phase) e.phase = phase; throw e; }
}

/** 用法错(spec 非法、文件不存在、后端不支持某能力)。与「环节失败」区分:后者进回执不抛。 */
export class UsageError extends Error {
  constructor(msg) { super(msg); this.name = "UsageError"; }
}
/** 桥**明确回报**的错误(MCP 返回了 error / 明确拒绝)—— 这类才算 backend_failed。 */
class BridgeReportedError extends Error {
  constructor(msg) { super(msg); this.name = "BridgeReportedError"; }
}
/** 本地 RPC 超时:**不知道对面干没干** —— 一律按 unknown 处理,绝不诱导重跑。 */
class RpcTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = "RpcTimeoutError"; }
}
/** 传输层死亡(桥退出 / 管道断)。同样「不知道干没干」→ unknown。 */
class TransportError extends Error {
  constructor(msg) { super(msg); this.name = "TransportError"; }
}

/** 定位桥本体。优先环境变量(装在别处/软链场景),否则按本文件相对位置回溯。 */
function resolveBridgePath(explicit) {
  const candidates = [
    explicit,
    process.env.AGENT_BRIDGE_MJS,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/agent-bridge.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return path.resolve(c); } catch {}
  }
  throw new UsageError(
    `找不到 agent-bridge.mjs。试过:\n  ${candidates.join("\n  ")}\n` +
    `用环境变量 AGENT_BRIDGE_MJS 指到桥本体的绝对路径。`,
  );
}

/** 杀掉整棵进程树。**Windows 上 child.kill() 只杀直接子进程**,孙进程(.cmd → node → 模型 CLI)
 *  会继续烧 —— 桥本体自己也是用 taskkill /T 解决这件事的。 */
async function killProcessTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 1) return;
  // ⚠️ **只在桥还活着时才凭 pid 强杀。** 我们持有 child 句柄,进程没被回收前 pid 不会被复用,
  // 所以此时 pid 一定还指向它本人,杀树是安全的。
  // 桥**已经退出**时,`child.pid` 只是个历史数字 —— 操作系统可能已经把它分配给别的进程,
  // 这时 `taskkill /PID x /T /F` 或 `kill(-x)` 会**误杀一棵陌生的进程树**。
  // 那种情况一律改走桥自带的、**带身份校验**的 cleanup(见 reclaimOrphans):
  // 宁可漏收一个孤儿(它还有 pid 记录、下次启动会被回收),也不能凭一个过期数字乱杀。
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WINDOWS) {
    await new Promise((resolve) => {
      try {
        const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        tk.on("close", () => resolve());
        tk.on("error", () => { try { child.kill("SIGKILL"); } catch {} resolve(); });
      } catch { try { child.kill("SIGKILL"); } catch {} resolve(); }
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

/** 桥死了之后回收它遗留的后端子进程。
 *  用桥**自带的** `cleanup` 子命令 —— 它本来就是为"回收被 kill 的 server 残留的子进程"造的,
 *  按 pid 记录做身份校验,比我们在这里自己发明一套(Windows 上还得 Job Object)更稳、也不重复造轮子。
 *  继承同一套 env(含 AGENT_BRIDGE_STATE_DIR),所以扫的就是本次用的那个 state 目录。 */
function reclaimOrphans(bridgePath, env) {
  return new Promise((resolve) => {
    try {
      const c = spawn(process.execPath, [bridgePath, "cleanup"], {
        windowsHide: true, stdio: "ignore", env,
      });
      const t = setTimeout(() => { try { c.kill(); } catch {} resolve(false); }, 15000);
      c.on("close", () => { clearTimeout(t); resolve(true); });
      c.on("error", () => { clearTimeout(t); resolve(false); });
    } catch { resolve(false); }
  });
}

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function requireString(v, field) {
  if (typeof v !== "string" || v.length === 0) throw new UsageError(`${field} 必须是非空字符串`);
  return v;
}

/** 规范化 + 校验一张任务单。返回带 specHash 的 spec。**所有可预知的错都在这里变成 UsageError**。
 *
 *  `kind:"conversation"` 走对话档:**逐轮才有的那几样(prompt / timeoutMs / schema /
 *  outputShape / reask)不许出现在顶层**。它们出现在顶层 = 调用方以为自己给整段定了规矩,
 *  而实际每轮各定各的 —— 静默忽略比报错坏得多(同 send_message.timeout_ms 在 wait:false
 *  下静默无效那个教训)。**这两档共用同一个函数**,不为对话另抄一份校验。 */
export function normalizeSpec(raw, { kind = "node" } = {}) {
  if (!raw || typeof raw !== "object") throw new UsageError("任务单必须是一个对象");
  const s = { ...raw };
  const isConv = kind === "conversation";
  if (isConv) {
    for (const k of ["prompt", "promptFile", "timeoutMs", "schema", "outputShape", "reask"]) {
      if (s[k] !== undefined) {
        throw new UsageError(
          `${k} 是**每一轮**的参数,不能放在 conversation 的顶层任务单上 —— 请写进 turn({ ${k}: … })。\n` +
          `(顶层再来一个预算/格式,就多出一处"两个说了算的谁管谁"的解释,而每轮各自声明已经够用。)`,
        );
      }
    }
  }

  for (const k of ["id", "agent", "cwd", "outDir"]) {
    if (s[k] === undefined || s[k] === null || s[k] === "") throw new UsageError(`任务单缺必填字段:${k}`);
    requireString(s[k], k);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(s.id)) {
    throw new UsageError(`id 只能用字母数字和 . _ -(拿来做文件名):${s.id}`);
  }
  if (!["omp", "codex", "claude", "cursor", "kimi"].includes(s.agent)) {
    throw new UsageError(`agent 必须是 omp|codex|claude|cursor|kimi,拿到:${s.agent}`);
  }

  if (!isConv) {
    // prompt / promptFile 二选一
    const hasPrompt = typeof s.prompt === "string" && s.prompt.length > 0;
    const hasFile = s.promptFile !== undefined && s.promptFile !== null && s.promptFile !== "";
    if (hasPrompt === hasFile) throw new UsageError("prompt 和 promptFile 必须二选一(不能都给、也不能都不给)");
    if (hasFile) {
      s.promptFile = path.resolve(requireString(s.promptFile, "promptFile"));
      const st = statSafe(s.promptFile);
      if (!st) throw new UsageError(`promptFile 不存在:${s.promptFile}`);
      if (!st.isFile()) throw new UsageError(`promptFile 不是普通文件:${s.promptFile}`);
    }

    // timeoutMs 必填 —— 「wait 必传超时」这条纪律从此由代码保证,不再靠人记
    const t = Number(s.timeoutMs);
    if (!Number.isFinite(t) || t <= 0) throw new UsageError(`timeoutMs 必须是正数(毫秒),拿到:${s.timeoutMs}`);
    s.timeoutMs = Math.floor(t);
  }

  s.cwd = path.resolve(s.cwd);
  const cwdStat = statSafe(s.cwd);
  if (!cwdStat) throw new UsageError(`cwd 不存在:${s.cwd}`);
  if (!cwdStat.isDirectory()) throw new UsageError(`cwd 不是目录:${s.cwd}`);
  s.outDir = path.resolve(s.outDir);
  const outStat = statSafe(s.outDir);
  if (outStat && !outStat.isDirectory()) throw new UsageError(`outDir 已存在但不是目录:${s.outDir}`);

  // ⚠️ 只有 codex 的 read 是 OS 沙箱硬只读,另外四家是软的(shell 能写盘,
  // cursor/kimi 连原生写工具都还在)—— 要硬保证不写盘就点名 codex。
  s.access = s.access ?? "read";
  if (!["read", "write"].includes(s.access)) {
    throw new UsageError(`access 只能是 "read" 或 "write",拿到:${JSON.stringify(s.access)}`);
  }

  // write 档**恒定**跑在自己的 git worktree 里,没有"在主工作区写"这个选项。
  // 这是本 skill 里 write 唯一安全的形态:扇出是核心用法,N 个环节共享一个 cwd 同时改文件必然互相踩;
  // worktree 是**文件系统级硬隔离**(写互不碰撞、主工作区不脏),不是靠提示词压着。
  // ⚠️ 隔离的是**写**,不是**读**:桥没有 OS 沙箱,有 shell 的环节技术上仍能 `../..` 读到主工作区。
  if (s.access === "write") {
    s.baseRef = s.baseRef === undefined || s.baseRef === null || s.baseRef === "" ? "HEAD" : requireString(s.baseRef, "baseRef");
    if (s.allowDirtyBase === undefined || s.allowDirtyBase === null) s.allowDirtyBase = false;
    if (typeof s.allowDirtyBase !== "boolean") {
      throw new UsageError(`allowDirtyBase 必须是布尔值(true/false),拿到 ${typeof s.allowDirtyBase}:${JSON.stringify(s.allowDirtyBase)}`);
    }
  } else {
    // 只对 write 有意义的参数出现在 read 环节上 = 调用方以为自己安排了什么而其实没有。
    // 当场拒绝,不静默忽略(同 send_message.timeout_ms 在 wait:false 下静默无效那个教训)。
    for (const k of ["baseRef", "allowDirtyBase"]) {
      if (s[k] !== undefined) throw new UsageError(`${k} 只在 access:"write" 时有意义,当前 access="${s.access}"`);
    }
    s.baseRef = undefined;
    s.allowDirtyBase = undefined;
  }

  if (s.roleFile !== undefined && s.roleFile !== null && s.roleFile !== "") {
    s.roleFile = path.resolve(requireString(s.roleFile, "roleFile"));
    const st = statSafe(s.roleFile);
    if (!st) throw new UsageError(`roleFile 不存在:${s.roleFile}`);
    if (!st.isFile()) throw new UsageError(`roleFile 不是普通文件:${s.roleFile}`);
  } else s.roleFile = undefined;

  if (s.model !== undefined && s.model !== null) requireString(s.model, "model");
  if (s.effort !== undefined && s.effort !== null) requireString(s.effort, "effort");

  // schema 只有 codex 后端能强制。传给别人桥会直接报错 —— 这里先拦,给人话提示。
  if (s.schema !== undefined && s.agent !== "codex") {
    throw new UsageError(
      `schema(强制输出格式)只有 codex 支持,当前 agent=${s.agent}。` +
      `别的后端请改用 outputShape(工具做弱检查:能否 parse + 顶层必需键在不在)。`,
    );
  }
  if (s.outputShape !== undefined) {
    if (typeof s.outputShape !== "object" || s.outputShape === null) throw new UsageError("outputShape 必须是对象");
    const rk = s.outputShape.requiredKeys;
    if (rk !== undefined && !(Array.isArray(rk) && rk.every((k) => typeof k === "string"))) {
      throw new UsageError("outputShape.requiredKeys 必须是字符串数组");
    }
  }
  // schema / outputShape 会进指纹,必须是**能安全序列化的纯 JSON 值**:
  // 循环引用会让序列化抛原生 RangeError(不是 UsageError),函数/BigInt 之类也无法进指纹。
  for (const k of ["schema", "outputShape"]) {
    if (s[k] === undefined) continue;
    try { JSON.stringify(s[k]); }
    catch (e) { throw new UsageError(`${k} 必须是可序列化的纯 JSON 值(${e.message})`); }
  }

  // 契约不合格时「打回重说」的次数 —— 全系统唯一的 retry,且只在环节内部、不改变流程往下怎么走。
  if (!isConv) {
    const re = s.reask === undefined ? 1 : Number(s.reask);
    if (![0, 1].includes(re)) throw new UsageError(`reask 只能是 0 或 1,拿到:${s.reask}`);
    s.reask = re;
  }

  // 严格布尔:`Boolean("false")` 是 true —— 从命令行/配置文件流过来的字符串会把开关**反着**打开
  for (const k of ["force", "reuseIfSame"]) {
    if (s[k] === undefined || s[k] === null) { s[k] = false; continue; }
    if (typeof s[k] !== "boolean") throw new UsageError(`${k} 必须是布尔值(true/false),拿到 ${typeof s[k]}:${JSON.stringify(s[k])}`);
  }
  // 两个语义相反(一个"无条件重跑"一个"能复用就复用"),同传说明调用方没想清楚 → 当场拒绝,
  // 不靠隐式优先级替人做决定。
  if (s.force && s.reuseIfSame) throw new UsageError("force 与 reuseIfSame 语义冲突,不能同时设置");

  // A 档拓扑:调用方声明的依赖。**系统既不校验也不执行** —— 执行路径上没有任何代码读它。
  s.declaredDeps = normalizeDeps(s.deps);
  delete s.deps;

  s.kind = isConv ? "conversation" : "node";
  s.specHash = computeSpecHash(s); // 顺带把 promptBody / roleBody 冻在这一刻

  // B 档拓扑:扫**冻结后的正文**。
  // ⚠️ 对话节点在这一刻**一个字的正文都没有**(提问是逐轮的),所以恒 `[]`。
  //    这**不等于**"这个节点没有推断出来的依赖" —— 那会把"这一层没得扫"
  //    伪装成"扫过了,没有"。对话的推断边由逐轮的 `node:turn.inferredDeps` 给出,
  //    而那恰恰是对话的头号用法(第 2 轮的提问通常就是照着另一个节点的产出写的)。
  const inf = inferDeps(isConv ? "" : s.promptBody, s.id);
  s.inferredDeps = inf.deps;
  s.inferredDepsTruncated = inf.truncated;
  return s;
}

/** `declaredDeps` 上限。**超了当场 `UsageError`,不截断** —— 声明是**用户写的**,
 *  截掉就是改用户的意思;而让一个注解把整个 run 的记录报废更荒唐。 */
const MAX_DECLARED_DEPS = 200;
/** `inferredDeps` 上限。推断是**我们猜的**,截掉只损失猜测 —— 但**必须说出来**。 */
const MAX_INFERRED_DEPS = 200;

/** A 档:校验并规范化调用方声明的 `deps`。
 *
 *  ⚠️ **不校验它指向的节点存不存在。** 那是拓扑的事;在入口拒绝会让"先声明、后创建"
 *  这种完全合法的写法跑不起来。 */
function normalizeDeps(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UsageError(`deps 必须是字符串数组,拿到 ${typeof raw}`);
  if (raw.length > MAX_DECLARED_DEPS) {
    throw new UsageError(
      `deps 最多 ${MAX_DECLARED_DEPS} 项,拿到 ${raw.length} 项。\n` +
      `(这是**用法错**,不是记录故障 —— 所以当场拒绝,而不是截断到 200 再悄悄跑下去。)`,
    );
  }
  const out = [];
  const seen = new Set();
  for (const d of raw) {
    if (typeof d !== "string" || d === "") throw new UsageError(`deps 每项必须是非空字符串,拿到 ${JSON.stringify(d)}`);
    if (!/^[A-Za-z0-9._-]+$/.test(d)) {
      throw new UsageError(`deps 每项只能用字母数字和 . _ -(与 id 同一字符集),拿到:${JSON.stringify(d)}`);
    }
    if (seen.has(d)) continue; // 去重后**保持声明顺序**
    seen.add(d);
    out.push(d);
  }
  return out;
}

/**
 * B 档:从**冻结后的正文**里扫出"这段话引用了哪些别的节点的产出"。
 *
 * ⚠️ **输入必须是冻结后的正文,不是原文件** —— 文件可能在排队期间被改,
 * 拿改后的文件推断,得到的边描述的是一份**没被派发过**的输入。
 *
 * ⚠️ 这是**启发式**:会漏也会多。页面上它与 `declaredDeps` 必须画得不一样
 * (推断边虚线 + 可点开"为什么推断出这条边"),因为把推断当事实展示
 * 是这个页面最容易造成的误导。
 *
 * @returns {{deps: string[], truncated: boolean}}
 */
export function inferDeps(text, selfId) {
  const out = [];
  const seen = new Set();
  let truncated = false;
  if (typeof text !== "string" || text.length === 0) return { deps: out, truncated };
  // `/` 与 `\` 两种分隔符都认;`<id>` 与 spec.id 同一字符集。
  const re = /nodes[/\\]([A-Za-z0-9._-]+)\.md/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // **只认相对形式** —— 绝对路径不是本图的边(它指向另一个 out-dir)。
    // 判据:往回走到分隔符之前那一段,看它是不是以 `/`、`\` 或盘符开头。
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const before = text.slice(lineStart, m.index);
    const token = before.split(/[\s"'`(<\[]/).pop() || "";
    if (token.startsWith("/") || token.startsWith("\\") || /^[A-Za-z]:[/\\]/.test(token)) continue;
    const id = m[1];
    if (id === selfId) continue;      // 去掉自依赖
    if (seen.has(id)) continue;       // 去重,按首次出现顺序排
    seen.add(id);
    if (out.length >= MAX_INFERRED_DEPS) { truncated = true; break; }
    out.push(id);
  }
  return { deps: out, truncated };
}

/** 把「要发出去的那段正文」**在算指纹的同一刻定死**,之后一律发这份字节。
 *
 *  ⚠️ 这不是优化,是修一条**确定性的错误复用**:指纹在规范化那一刻按内容 A 算好,
 *  而 `message_file` 发的是**路径**——桥要到几个 await 之后(拿闸、建工作树、开会话)才去读它。
 *  这中间调用方把文件改成 B、跑完再改回 A,回执里就成了「指纹 H(A) + 产出是 B 的答案」;
 *  下次拿着 A 来复用,指纹、路径、SHA 全对得上,于是**把 B 的答案当成 A 的结果交出去**。
 *  静默、可稳定复现,而且正是本工具存在的理由那一类错。
 *
 *  ⚠️ 为什么不"把文件复制一份快照再发那个路径":桥要求 `message_file` **必须在会话 cwd 里面**。
 *  read 档的 cwd 就是用户的工作区(往里写盘直接破了只读的承诺),write 档的 cwd 是 worktree
 *  (写进去会混进这次的 diff)。两边都不能写 —— 所以正确的做法是**根本不发路径,发字节**。 */
function freezePromptBody(o, what) {
  if (!o.promptFile) return o.prompt;
  try { return fs.readFileSync(o.promptFile, "utf8"); }
  catch (e) { throw new UsageError(`读 ${what} 失败:${e.message}`); }
}

/** 输入指纹:决定「这张旧回执记的,是不是当前这份任务单的结果」。
 *  少了它,改了 prompt/模型后重跑会把上一版结果当成这一版 —— 静默出错,最难查的一类。
 *  **凡是会改变执行结局的字段都要进指纹**(含 timeoutMs / reask:超时时长和重说次数都会改变结局)。 */
function computeSpecHash(s) {
  let roleBody = "";
  // ⚠️ 读一次、存下来、以后就发这一份 —— 见 freezePromptBody 里那条错误复用路径。
  const promptBody = s.promptBody = freezePromptBody(s, "promptFile");
  if (s.roleFile) {
    try { roleBody = fs.readFileSync(s.roleFile, "utf8"); }
    catch (e) { throw new UsageError(`读 roleFile 失败:${e.message}`); }
  }
  // 与 prompt 同一个理由:**冻在算指纹的这一刻**。归档里那份 `role.md` 必须就是
  // 真派发出去的那份字节,否则事件在撒谎(它描述的是一份从未被派发过的输入)。
  s.roleBody = s.roleFile ? roleBody : null;
  const ident = {
    v: RECEIPT_VERSION,
    agent: s.agent, model: s.model ?? null, effort: s.effort ?? null,
    access: s.access, cwd: s.cwd, prompt: promptBody, role: roleBody,
    schema: s.schema === undefined ? null : stableStringify(s.schema),
    outputShape: s.outputShape === undefined ? null : stableStringify(s.outputShape),
    timeoutMs: s.timeoutMs, reask: s.reask,
    // baseRef 会改变执行结局(对着哪个基线改代码),进指纹。
    // ⚠️ allowDirtyBase **不进**:它只决定"要不要拒绝开跑",跑起来之后不影响结果。
    // ⚠️ 但 baseRef="HEAD" 会随时间解析到不同 commit —— 指纹管不了这件事,
    //    所以复用时还要**另外**比对回执里记下的 baseCommit(见 runNode 的复用闸)。
    baseRef: s.baseRef ?? null,
  };
  return crypto.createHash("sha256").update(stableStringify(ident)).digest("hex").slice(0, 32);
}

/** 键序无关的 JSON 序列化 —— 否则 `{a,b}` 与 `{b,a}` 会算出两个指纹。
 *  注意 `undefined` 必须与 `null` **区分开**:`JSON.stringify(undefined)` 返回 undefined,
 *  早先用 `?? "null"` 兜底会让 `{x:undefined}` 与 `{x:null}` 撞成同一个指纹。 */
function stableStringify(v) {
  if (v === undefined) return "#undef";
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? `#unser:${typeof v}` : s;
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** 起一个私有桥进程并握手。返回 bridge 句柄;**用完必须 close()**(推荐用 withBridge 自动收尾)。 */
export async function startBridge(opts = {}) {
  const bridgePath = resolveBridgePath(opts.bridgePath);
  // 留着:桥死后要用同一套 env(含 AGENT_BRIDGE_STATE_DIR)去跑它自带的 cleanup 回收孤儿
  const spawnEnv = { ...process.env, ...(opts.env || {}) };
  const child = spawn(process.execPath, [bridgePath, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !IS_WINDOWS, // POSIX 下自建进程组,方便整组回收
    env: spawnEnv,
  });

  const state = {
    child, exited: null, stderrTail: "", waiters: new Map(),
    nextId: 1, closed: false, lateResponses: 0, activeNodes: new Set(),
  };

  /** 幂等 teardown。**握手之前就先建好** —— 否则 initialize 卡死时,句柄还没返回给调用方,
   *  withBridge 的 finally 也还没建立,桥进程就成了没人认领的孤儿。 */
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    try { child.stdin.end(); } catch {}
    const t0 = monoNow();
    while (!state.exited && monoNow() - t0 < BRIDGE_EXIT_GRACE_MS) await sleep(50);
    if (!state.exited) await killProcessTree(child);
    failAllWaiters(new TransportError("桥进程已被回收"));
  };

  function failAllWaiters(err) {
    for (const [, w] of state.waiters) w.reject(err);
    state.waiters.clear();
  }

  child.on("close", (code, signal) => {
    state.exited = { code, signal };
    failAllWaiters(new TransportError(`桥进程在请求进行中退出 code=${code} signal=${signal}`));
  });
  child.on("error", (e) => {
    state.exited = state.exited || { code: null, signal: null };
    failAllWaiters(new TransportError(`桥进程起不来:${e.message}`));
  });
  // stdin 的异步 EPIPE 必须变成 waiter 的 reject,不能冒泡成进程级未捕获异常
  child.stdin.on("error", (e) => failAllWaiters(new TransportError(`向桥写入失败:${e.message}`)));
  child.stderr.on("data", (d) => {
    state.stderrTail = (state.stderrTail + d.toString()).slice(-4000);
    if (opts.onStderr) opts.onStderr(d.toString());
  });

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      const w = state.waiters.get(msg.id);
      if (w) { state.waiters.delete(msg.id); w.resolve(msg); }
      // 没人等的迟到响应(请求已超时):**直接丢弃**并只计数。
      // 早先版本把它塞进一个从没人读的 Map —— 那是确定的内存泄漏。
      else state.lateResponses++;
    }
  });

  function request(method, params, timeoutMs) {
    // 预算已经是 0 就**根本不要把请求发出去**。否则会出现"检查时还剩 0.2ms、构造完参数变 0,
    // 消息照样发给后端"——任务真的跑起来了,而我们立刻按超时收场,等于凭空制造一个失控的 turn。
    if (!(timeoutMs > 0)) {
      return Promise.reject(new RpcTimeoutError(`${method} 未发出:本环节预算已耗尽`));
    }
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      if (state.exited) return reject(new TransportError("桥进程已退出,无法发送请求"));
      const timer = setTimeout(() => {
        state.waiters.delete(id);
        reject(new RpcTimeoutError(`${method} 在 ${Math.round(timeoutMs)}ms 内没有响应`));
      }, Math.max(1, timeoutMs));
      state.waiters.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        clearTimeout(timer); state.waiters.delete(id);
        reject(new TransportError(`向桥写入失败:${e.message}`));
      }
    });
  }

  /** 调一个 MCP 工具。桥把结果放在 content[0].text 里;桥**明确回报**的错误抛 BridgeReportedError。 */
  async function callTool(name, args, timeoutMs = RPC_TIMEOUT_MS) {
    const resp = await request("tools/call", { name, arguments: args }, timeoutMs);
    if (resp.error) throw new BridgeReportedError(`${name} 报错:${JSON.stringify(resp.error)}`);
    const content = resp?.result?.content?.[0];
    const text = content?.text;
    if (typeof text !== "string") return null;
    // MCP 的 isError=true 也是「桥明确说这次不行」
    if (resp.result?.isError) throw new BridgeReportedError(`${name} 返回错误:${text.slice(0, 500)}`);
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  }

  try {
    const initResp = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-bridge-graph", version: String(RECEIPT_VERSION) },
    }, opts.initTimeoutMs ?? 30000);
    // 桥明确拒绝初始化时不能当成握手成功
    if (initResp?.error) throw new BridgeReportedError(`桥拒绝初始化:${JSON.stringify(initResp.error)}`);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  } catch (e) {
    // 握手失败也必须把桥收干净,再把错抛给调用方
    await teardown();
    throw e;
  }

  // 并发闸。默认 4 —— 不是机器扛不住,是怕挤垮主 agent 自己那条桥连接(SKILL §组合纪律)。
  // 从"写在文档里的纪律"改成"代码保证",调用方照写 Promise.all 即可,超限的自动排队。
  const maxConcurrent = opts.maxConcurrent === undefined ? 4 : opts.maxConcurrent;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    await teardown();
    throw new UsageError(`maxConcurrent 必须是 ≥1 的整数,拿到:${JSON.stringify(opts.maxConcurrent)}`);
  }
  const gate = makeSemaphore(maxConcurrent);
  // 第二把闸,界的是**跨轮活着的会话**(一段对话从首轮到收尾一直持着一个)。
  // ⚠️ **不能与执行闸合成一把**:对话在回调期间(轮与轮之间)不持执行闸,好让回调里嵌套的
  // runNode 拿得到 —— 那正是"复审发生在两轮之间"这个头号用法。合成一把要么自锁,
  // 要么活会话数无上限(开 20 段对话 = 20 个常驻后端)。
  // ⚠️ 也**不是**"全局活会话上限":4 段对话停在轮间 + 4 个独立 runNode 在跑 = 桥里 8 个会话。
  // 真实上限是 maxConversations + maxConcurrent。
  const maxConversations = opts.maxConversations === undefined ? maxConcurrent : opts.maxConversations;
  if (!Number.isSafeInteger(maxConversations) || maxConversations < 1) {
    await teardown();
    throw new UsageError(`maxConversations 必须是 ≥1 的整数,拿到:${JSON.stringify(opts.maxConversations)}`);
  }
  const scopeGate = makeSemaphore(maxConversations);

  const bridge = {
    callTool,
    get stderrTail() { return state.stderrTail; },
    get exited() { return state.exited; },
    get lateResponses() { return state.lateResponses; },
    get pid() { return child.pid; },
    get maxConcurrent() { return maxConcurrent; },
    get maxConversations() { return maxConversations; },
    _activeNodes: state.activeNodes,
    _gate: gate,
    _scopeGate: scopeGate,
    doctor: (timeoutMs = RPC_TIMEOUT_MS) => callTool("agent_bridge_doctor", {}, timeoutMs),
    runNode: (spec) => runNode(bridge, spec),
    conversation: (spec, fn) => conversation(bridge, spec, fn),
    async close() {
      if (state.closed) return;
      state.closed = true;
      // 兜底:把本进程还没关的会话一次清掉(正常路径里每个 runNode 都自己关了)
      const st = BRIDGE_REAP_STATE.get(bridge) || {};
      let bulkFailed = false;
      try {
        // force:true —— 这是**私有**桥进程的最终清场,后面紧跟着就是杀进程树,没有"留着待收"这回事。
        // 不加 force 的话,桥的在途闸门(批量是原子的:任一会话还在跑就一个都不关)会让这次兜底
        // 变成空操作,反而把本该回收的会话留成孤儿。逐节点那次 close 仍然**不**加 force:那里
        // 节点已经收尾(超时路径也先 abort 过),被拒就该如实记进回执,而不是硬杀。
        const bulk = await callTool("agent_bridge_close_session", { force: true }, 20000);
        // 拿到 bulk 响应 = 桥已经把之前排队的请求都处理完了(包括那条我们本地等超时的 close)。
        // 所以只要"关掉了会话"或"存在未确认的 close",都以**此刻**为准重新起算强杀窗口。
        if (Number(bulk?.count) > 0 || st.unconfirmedClose) {
          st.lastCloseAt = monoNow();
          st.unconfirmedClose = false;
        }
      } catch {
        // bulk close 自己都超时/断管了:桥的状态不可知,客户端时间戳更不可信 ——
        // 别再"优雅退出"赌它会自己收干净,直接杀掉整棵私有进程树。
        bulkFailed = true;
      }
      BRIDGE_REAP_STATE.set(bridge, st);

      if (bulkFailed) {
        // 桥状态不可知(多半是它自己死了),它的后端可能还活着。两条路的分界线是
        // **此刻还能不能相信 child.pid 这个数字**:
        if (!state.exited) {
          // 桥还活着 → 我们攥着它的句柄,pid 不会被回收复用,一定还指向它本人,杀树安全。
          await killProcessTree(child);
        }
        // 桥已经退出 → `child.pid` 只是个历史数字,操作系统可能已把它分给别的进程,
        // 凭它强杀会误伤陌生进程树。这种情况**只走桥自带的 cleanup**:它对每条 pid 记录
        // 先做身份校验(classifyChild)再动手,是这里唯一可信的回收方式。
        //
        // 代价要说清楚:omp/codex/claude 三家在 close 时会**先删 pid 记录再等后端真退出**,
        // 若桥恰好在那个缝里死掉,cleanup 就没有可校验的目标 → 可能漏收一个孤儿。
        // 这是桥本身的口径问题(该由桥改成 cursor/kimi 那样等真 close 事件再删),
        // 不该用"无校验强杀"来遮 —— 漏收一个自己会超时退出的后端,远好过杀错一棵陌生的树。
        await reclaimOrphans(bridgePath, spawnEnv);
      } else if (st.lastCloseAt !== undefined) {
        // 把桥的强杀窗口**等完**再关 stdin。按"最后一次关会话到现在过了多久"算剩余量:
        // 刚关完就等满 REAP_GRACE_MS;早就关完了(比如节点跑了几分钟)则一秒都不等 ——
        // 既堵住抗 TERM 后端逃生,又不给每次 withBridge 平白加延迟。
        const waitLeft = REAP_GRACE_MS - (monoNow() - st.lastCloseAt);
        if (waitLeft > 0) await sleep(waitLeft);
      }
      await teardown();
    },
  };
  return bridge;
}

/** 起桥 → 跑你的编排 → **收尾一定会跑**(异常路径也跑)。日常用这个,别手工 startBridge。
 *  说清楚边界:凡是能安全回收的路径都收干净;唯一收不到的是「桥先删了 pid 记录、又恰好在后端真退出前死掉」
 *  那个窗口 —— 那时没有可校验身份的目标,我们**宁可漏收也不乱杀**(见 close() 里的说明)。 */
export async function withBridge(fn, opts = {}) {
  const bridge = await startBridge(opts);

  // ── viz 初始化。**在用户回调之前做完,任何一步失败都 fail-fast。**
  //    (回调之前失败没有业务结局可改;回调之后失败有 —— 那时一律降级成资产状态,
  //     绝不外溢,见 viz-node.mjs 里那条 `guard`。)
  let scope = null, viewer = null, recordingFailed = false;
  if (opts.viz) {
    try {
      scope = createGraphScope({ outDir: opts.outDir, maxConcurrent: bridge.maxConcurrent });
    } catch (e) {
      await bridge.close();
      throw new UsageError(`viz 起不来:${e.message}`);
    }
    bridge._viz = scope;
    // 生命管道:fork viewer,拿 IPC 当控制通道。**起不来就 fail-fast**(仍在回调之前)。
    try {
      viewer = await startViewer(scope, opts);
      bridge.vizUrl = viewer.url;
    } catch (e) {
      try { scope.close(); } catch { /* 起不来时的清理失败不改结论 */ }
      await bridge.close();
      throw new UsageError(`viz viewer 起不来:${e.message}`);
    }
    // recorder 一坏就立刻从控制通道说出去 —— transcript 写不下去之后,它是唯一还能说话的通道。
    scope.onRecordingFailed((info) => {
      recordingFailed = true;
      viewer?.send({
        kind: "recording-failed",
        atSeq: info.atSeq,
        lastGoodOffset: info.lastGoodOffset ?? 0,
        error: String(info.error?.message ?? info.error),
      });
    });
    // `seq === 0`,且**排在用户回调之前**。
    await scope.emit("run:started", { outDir: scope.canonicalOutDir, maxConcurrent: bridge.maxConcurrent });
  }

  const t0 = monoNow();
  let callbackThrew = false;
  try {
    return await fn(bridge);
  } catch (e) {
    callbackThrew = true;
    throw e;
  } finally {
    // ── 收尾协议(§8.3)。**每一步各自 try/catch,前一步失败绝不跳过后面的步骤。**
    //    ① 封 admission:此后迟到的节点级调用一律拒,它们不属于这次 run ——
    //       放行的话它们会在 `run:final` 写完之后往 transcript 里追加事件,
    //       而"`run:final` 是最后一条"这条保证当场作废。
    if (scope) bridge._vizSealed = true;
    let closeFailed = false;
    try {
      await bridge.close();
    } catch (e) {
      closeFailed = true;
      if (!callbackThrew) throw e;      // 回调自己抛了的话,**根因优先**,不许被收尾的异常盖掉
    } finally {
      if (scope) {
        // ② 定 result。⚠️ **只由三样决定,不看节点回执** —— 观测台不裁决业务成败。
        //    "回调正常返回、排空期间看到 failed/unknown 回执" 仍是 completed:
        //    节点结局不是 run 结局(`allSettled` 甚至看不出那个 contract_error
        //    是不是回调有意接住并处理掉的)。
        const result = (callbackThrew || closeFailed) ? "failed" : "completed";
        // ③ 写 run:final 并**确认落盘**(`await append` 成功就是确认,不需要第二个 flush 概念)。
        let finalLanded = false;
        try {
          finalLanded = await scope.emit("run:final", {
            result,
            counts: bridge._vizCounts ?? EMPTY_COUNTS(),
            durationMs: Math.max(0, Math.round(monoNow() - t0)),
          });
        } catch { /* emit 本来就不抛 */ }
        // ④ 关 transcript。⚠️ 它**不再宣布 recording failure**:viewer 的判定第 1 档是
        //    "transcript 里有 run:final 就按它算",所以"关 fd 失败也转 recording-failed"
        //    这条分支**永远显示不出来**。关 fd 失败只是清理诊断。
        try { scope.close(); } catch { /* 见上 */ }
        // ⑤ 关生命管道 —— **无条件**。
        //    ⚠️ 两件事的条件性不一样,必须分开记:**发 `owner-final` 是条件性的,关管道是无条件的。**
        //    把"关管道"写进"writer 已损坏"的分支里,健康路径就**永远不关管道** ——
        //    于是同一个脚本顺序跑多波时,第一波的 viewer 永远等不到 EOF、`ownerEnded` 永远为 false、
        //    进程赖着不走。
        //    而**有** `owner-final` 时**完整消息必须先于 EOF**:反过来 viewer 就只剩
        //    "EOF 且没有 final",会把一次受控收场显示成事故。
        if (viewer) {
          if (recordingFailed || !finalLanded) {
            viewer.send({ kind: "owner-final", result, endedAt: Date.now() });
          }
          viewer.disconnect();
        }
      }
    }
  }
}

/**
 * 起 viewer 子进程,并把 IPC 通道当**生命管道**用。
 *
 * ⚠️ **管道必须由 `withBridge` 自己在收尾时显式关闭,不能等整个 Node 进程退出** ——
 * 同一个脚本顺序跑多波时,第一波的 viewer 会永远等不到 EOF。
 */
async function startViewer(scope, opts) {
  const serve = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "viz", "serve.mjs");
  if (!statSafe(serve)) throw new Error(`找不到 viewer:${serve}`);
  const { fork } = await import("node:child_process");
  const child = fork(serve, [], {
    // `ipc` 就是那条生命管道 —— `fork` 自带,天然是消息边界。
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      VIZ_OUT_DIR: scope.canonicalOutDir,
      VIZ_GRAPH_ID: scope.graphId,
      VIZ_PORT: String(opts.vizPort ?? 0),
    },
    windowsHide: true,
  });
  child.unref?.();
  // 等它真的在听 —— 起不来要在用户回调之前就知道。
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("viewer 15 秒内没报出端口")), 15000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`viewer 提前退出(code=${code})`)); });
    child.on("message", (m) => {
      if (m?.kind === "viz-listening") { clearTimeout(timer); resolve(m.url); }
    });
  });
  // ⚠️ **URL/port 是打印给人看的信息,不进 transcript**(已删 `viz:started`):
  //    页面能收到事件本身就证明 viewer 起来了。
  console.error(`[viz] 观测台 ${url}  (graph ${scope.graphId})`);
  return {
    url, child,
    send(msg) { try { if (child.connected) child.send(msg); } catch { /* 管道已断 */ } },
    disconnect() { try { if (child.connected) child.disconnect(); } catch { /* 已断 */ } },
  };
}

/** `run:final.counts` 的九个键。**固定键集,全部恒在。**
 *  ⚠️ `callback_error` 最容易被漏掉,而漏了它,每一个"轮都好好的、编排那段 JS 自己炸了"
 *  的节点都会让恒等式差 1 —— 于是一次**正常**记录被判成"记录不完整"。 */
const EMPTY_COUNTS = () => ({
  observed: 0, rejected: 0, ok: 0, contract_error: 0,
  backend_failed: 0, timeout: 0, unknown: 0, callback_error: 0, reused: 0,
});

/** 记一笔计数。⚠️ **数的是节点,不是轮** —— 一个 12 轮的节点仍然只占一格。 */
function vizCount(bridge, bucket, alsoReused = false) {
  if (!bridge?._viz) return;
  if (!bridge._vizCounts) bridge._vizCounts = EMPTY_COUNTS();
  if (bucket in bridge._vizCounts) bridge._vizCounts[bucket] += 1;
  // ⚠️ `reused` 是 `ok` 的**子集**,不是并列的桶(复用返回的就是一张 status:"ok" 的旧回执)。
  //    所以九项加起来不等于总数 —— 恒等式里没有它。
  if (alsoReused) bridge._vizCounts.reused += 1;
}

/** 弱检查(非 codex 后端用):只做「能不能 parse + 顶层必需键在不在」。
 *  **刻意不做完整 JSON Schema 校验** —— 桥本身就因为「不想有第二套跟 codex 不一致的判定标准」
 *  而不带校验器,这里同理。指望它给出 codex 那种保证是自欺。 */
function weakCheck(text, outputShape) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return { ok: false, reason: `输出不是合法 JSON:${e.message}` }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "输出必须是一个 JSON 对象(不是数组/标量)" };
  }
  // 用 Object.hasOwn 而不是 `in`:`"constructor" in {}` 是 true,会让空对象通过必需键检查
  const missing = (outputShape.requiredKeys || []).filter((k) => !Object.hasOwn(parsed, k));
  if (missing.length) return { ok: false, reason: `缺少必需的顶层字段:${missing.join(", ")}` };
  return { ok: true, parsed };
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

/** 字节直传复制。不读出来再写 —— 不改字节、不花内存、不踩 Windows 编码转换的坑。 */
function copyBytes(src, dest) {
  try { fs.copyFileSync(src, dest); return true; } catch { return false; }
}

/** 产出的内容指纹,用来判断"复用时这份文件还是当初那份吗"。读不到就是 null。
 *  ⚠️ **必须流式异步**。`readFileSync` 会把整份文件塞进堆,而且**同步读会冻住事件循环** ——
 *  本模块刻意让所有 git 都走异步 spawn,正是为了不让一个环节的收尾卡死其它并发环节的 wait 循环;
 *  在收尾处用一次同步整文件读,就把那份努力当场抵消了(write 环节的 diff 含二进制时并不小)。 */
function sha256File(p) {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("error", () => resolve(null));
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** 字符串指纹。用来把"一个可能重名的标签"变成"一个不会重的资源名"。 */
function sha256Text(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

/** 把一段人类可读的标签洗成 git 分支名认得的样子。
 *  **唯一性由后面拼上的全路径哈希保证**,所以这里怎么洗都不会把两个不同的 outDir 洗成同一个 ——
 *  洗掉的只是可读性,换来的是"一个完全合法的 outDir(比如目录名带空格)不会让 write 档直接不可用"。 */
function gitSafeSlug(s) {
  let t = String(s).replace(/[^A-Za-z0-9._-]+/g, "-"); // 空格、@{、控制字符等一律换掉
  t = t.replace(/\.{2,}/g, "-");                       // 分支名里不能出现 `..`
  t = t.replace(/^[-._]+|[-._]+$/g, "");               // 不能以 . 或 - 开头/结尾
  t = t.replace(/\.lock$/i, "");                       // 不能以 .lock 结尾
  return t || "run";
}

/** 原子写:同目录临时文件 + rename。避免崩在半路留下一个不可 parse 的回执。 */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(monoNow())}`;
  fs.writeFileSync(tmp, data, "utf8");
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// ─────────────────────────────────────────────────────────────────────────────
// git / worktree —— `access:"write"` 的硬隔离
// ─────────────────────────────────────────────────────────────────────────────

/** 单次 git 调用的硬超时。**必须有**:仓库损坏、`index.lock` 竞争、凭据提示都会让 git 一直挂着。 */
const GIT_TIMEOUT_MS = 120000;
/** 建/拆工作区的固定预算。**刻意不受环节总预算约束** ——
 *  超时收场的环节同样要把已经改出来的代码保住,否则"预算耗尽"就等于"工作白干"。 */
const WORKSPACE_BUDGET_MS = 180000;

/** 异步跑一条 git。**绝不能用 spawnSync**:`git worktree add` 在大仓上要好几秒,
 *  同步调用会冻住整个事件循环 —— 连带把并发跑的其它环节的 wait 循环一起卡死,
 *  制造出一批莫名其妙的超时。("异步不等于不阻塞"的反面:同步 OS 调用就是真的阻塞。) */
function git(args, cwd, { timeoutMs = GIT_TIMEOUT_MS, toFile = null } = {}) {
  return new Promise((resolve) => {
    let fd = null;
    if (toFile) {
      try { fd = fs.openSync(toFile, "w"); }
      catch (e) { return resolve({ ok: false, stdout: "", stderr: `打不开输出文件 ${toFile}:${e.message}`, code: null }); }
    }
    let child;
    try {
      child = spawn("git", args, {
        cwd,
        windowsHide: true,
        // 大 diff 直接写文件,不在内存里攒 —— 一个几十 MB 的 diff 不该进 Node 堆。
        stdio: ["ignore", fd ?? "pipe", "pipe"],
        // 禁掉任何交互式凭据提示,否则 git 会挂到超时才被杀。
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      });
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      return resolve({ ok: false, stdout: "", stderr: `起不了 git:${e.message}`, code: null });
    }
    let out = "", err = "", done = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    if (!fd) child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
    const settle = (code, spawnErr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      resolve({
        ok: !spawnErr && !timedOut && code === 0,
        code, stdout: out, stderr: err.trim(), timedOut,
        spawnError: spawnErr ? spawnErr.message : null,
      });
    };
    child.on("error", (e) => settle(null, e));
    child.on("close", (code) => settle(code, null));
  });
}

/** 跑一条必须成功的 git,失败就变成人话 UsageError。用于开跑前的体检。 */
async function gitMust(args, cwd, what) {
  const r = await git(args, cwd);
  if (!r.ok) {
    const why = r.timedOut ? `超过 ${GIT_TIMEOUT_MS}ms 没返回` : (r.spawnError || r.stderr || `退出码 ${r.code}`);
    throw new UsageError(`${what} 失败(git ${args.join(" ")}):${why}`);
  }
  return r.stdout.trim();
}

/** 把 runKey / nodeId 拼成一个**git 认的**分支名。不自己写正则猜规则 —— 交给 git 自己判。 */
async function makeBranchName(repoRoot, runKey, nodeId) {
  const branch = `graph/${runKey}/${nodeId}`;
  const r = await git(["check-ref-format", "--branch", branch], repoRoot);
  if (!r.ok) {
    throw new UsageError(
      `拼出来的分支名 git 不认:"${branch}"(由 outDir 目录名+指纹 "${runKey}" 与环节 id "${nodeId}" 组成)。\n` +
      `outDir 目录名那段已经洗成 git 合法形式了,所以问题多半出在环节 id "${nodeId}" 上 ——\n` +
      `换一个不含 ".."、不以 "." 或 "-" 开头、不以 "." 或 ".lock" 结尾的 id。`,
    );
  }
  return branch;
}

/** 开跑前的仓库体检。**只做只读探查**,不改任何东西。 */
async function inspectRepo(cwd, baseRef) {
  const probe = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!probe.ok) {
    throw new UsageError(
      `access:"write" 要求 cwd 是一个 git 仓库(要用 worktree 做隔离),但 ${cwd} 不是。\n` +
      `原因:${probe.spawnError || probe.stderr || `git 退出码 ${probe.code}`}`,
    );
  }
  // realpath 一次:后面所有"某路径在不在仓库里"的比较都以它为基准(见 realpathSafe 的说明)
  const repoRoot = realpathSafe(path.resolve(probe.stdout.trim()));
  // `<ref>^{commit}` 强制解析成 commit:传 tag 或 annotated tag 时不会拿到一个 tag 对象。
  const baseCommit = await gitMust(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot, `解析基线 "${baseRef}"`);
  return { repoRoot, baseCommit };
}

/** 主树是否有未提交改动。未跟踪文件**照样算脏** —— 它们同样不在 HEAD 里,节点同样看不见。
 *
 *  ⚠️ 必须排除**我们自己造的脚手架**(worktree 根目录与本次 outDir),否则会自己咬自己 ——
 *  第一个 write 环节跑完就在主树里留下这些东西,主树变"脏",第二个 write 环节被自己拦下。
 *  用 git 原生 pathspec 排除(而不是回来自己解析 porcelain 的路径串,那还要处理带空格/被引号包住的路径)。
 *  **只排这两条具体路径,不排整个 `.graph/`** —— 用户仓库里 `.graph/` 下若真有他自己跟踪的东西,
 *  那是他的改动,不该被我们悄悄忽略掉。
 *
 *  ⚠️ **探不出来时 fail-closed**(返回 null,由调用方拒绝):这是一道安全闸,
 *  探测失败就放行等于"闸坏了默认开门" —— 使用者以为自己被保护着,其实没有。 */
async function dirtyEntries(repoRoot, scaffoldRels = []) {
  // ⚠️ 必须是 `-uall`(逐文件),不能用默认的 `-unormal`:后者会把整个未跟踪目录**折叠成一条**
  // `?? .graph/`,按具体路径的判断**根本匹配不上那条折叠项**,于是我们自己的脚手架被当成用户的改动、
  // 把每个 write 环节都拦下。(代价是大仓上逐文件列举更慢一点;每个 write 环节只跑这一次。)
  // ⚠️ `-z`:输出以 NUL 分隔且**完全不做引号转义**,带空格/非 ASCII 的路径原样出现,
  //    不用再跟 `core.quotePath` 和 `"\344\270\255"` 那套转义较劲。
  const r = await git(["status", "--porcelain", "--untracked-files=all", "-z"], repoRoot);
  if (!r.ok) return null;
  const toks = r.stdout.split("\0");
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const xy = t.slice(0, 2);
    const p = t.slice(3); // 格式是 `XY<空格>路径`
    // 重命名/复制会**多带一个「来源路径」token**;不跳过它就会被当成一条独立的脏条目。
    if (xy[0] === "R" || xy[0] === "C") i++;
    // ⚠️ **只排掉「未跟踪的脚手架」,绝不排掉任何被跟踪文件的改动。**
    // 早先的写法是 pathspec `:(exclude)<outDir>/**` 整片排 —— 而 outDir 是调用方给的**任意目录**,
    // 设成 `repo/src` 之类就把 `src/nodes/**` 里**真实的源码改动**一起吞了:
    // 一道安全闸被自己的排除项悄悄关掉,比压根没有这道闸更危险。
    // 我们写出去的东西必然是未跟踪的(产出/回执/diff/现场/锁、以及 worktree 目录本身),
    // 所以"未跟踪 + 在我们的目录下"就是精确的判据,不多排一个字节。
    if (xy === "??" && scaffoldRels.some((s) => p === s || p.startsWith(`${s}/`))) continue;
    entries.push(`${xy} ${p}`);
  }
  return entries;
}

/** worktree 都放在仓库根下的这个相对目录里(用 POSIX 分隔符 —— git pathspec 只认 `/`)。 */
const WT_ROOT_REL = ".graph/wt";

/** 解析成真实路径。**跨 git 与 Node 比较路径前必须做** ——
 *  `git rev-parse --show-toplevel` 给的是**解析后的长路径**,而调用方传进来的 cwd/outDir 可能是
 *  8.3 短名(Windows 的 `LEO~1.WAN\…`)或经过符号链接。两者直接 `path.relative` 会算出一串 `../..`,
 *  于是"outDir 在仓库里吗"判成否 —— 排除项失效,我们自己写的脚手架被当成用户的未提交改动。
 *  (实测:临时目录走 `os.tmpdir()` 拿到 8.3 短名时必现。) */
function realpathSafe(p) {
  try { return (fs.realpathSync.native || fs.realpathSync)(p); }
  catch { return path.resolve(p); }
}

/** 脏树闸。**真跑与复用都要过** —— 见调用处的说明。`allowDirtyBase` 时整条跳过。 */
async function assertCleanBase({ repoRoot, spec, baseCommit, nodesDir }) {
  if (spec.allowDirtyBase) return;
  // 把**我们自己写东西的那个目录**排掉(它通常就在仓库里):产出/回执/diff/现场/锁都在这儿,
  // 是脚手架不是用户的改动。
  // ⚠️ 排的是 `outDir/nodes`,**不是整个 outDir** —— 后者是调用方给的任意目录,
  // 传成 `repo/src` 这类源码目录时就会把 `src/**` 整片排掉,于是真有未提交改动也被判成干净:
  // 一道安全闸被它自己的排除项悄悄关掉,比没有这道闸更危险。本工具只往 `outDir/nodes` 下写,
  // 排除范围就该正好等于这个事实。
  const relOut = path.relative(repoRoot, realpathSafe(nodesDir)).split(path.sep).join("/");
  const insideRepo = relOut && !relOut.startsWith("../") && relOut !== ".." && !path.isAbsolute(relOut);
  const dirty = await dirtyEntries(repoRoot, [WT_ROOT_REL, ...(insideRepo ? [relOut] : [])]);
  if (dirty === null) {
    // fail-closed:这是一道安全闸,探测失败就放行 = 闸坏了默认开门,
    // 使用者以为自己被保护着、其实没有。宁可停下让人看一眼。
    throw new UsageError(
      `查不出主工作区是否干净(git status 失败),而这道闸的作用正是防止环节对着错误的基线干活。\n` +
      `先确认仓库状态正常;确实要继续请显式加 allowDirtyBase:true。`,
    );
  }
  if (!dirty.length) return;
  throw new UsageError(
    `主工作区有未提交改动,而 worktree 只能基于已提交的 ${spec.baseRef}(${baseCommit.slice(0, 8)})——\n` +
    `**这个环节将完全看不到下面这些改动**:\n` +
    dirty.slice(0, 20).map((l) => `    ${l}`).join("\n") +
    (dirty.length > 20 ? `\n    …还有 ${dirty.length - 20} 条` : "") +
    `\n\n先 git commit / git stash 定住基线,或者明确接受这一点:给该环节加 allowDirtyBase:true。`,
  );
}

/** 建 worktree。返回给回执用的工作区信息。 */
async function createWorktree({ repoRoot, wtPath, branch, baseCommit, force }) {
  if (fs.existsSync(wtPath)) {
    if (!force) {
      throw new UsageError(
        `工作区目录已存在:${wtPath}\n` +
        `要么上次异常退出留下了它,要么 id 撞了。确认没人在用后:\n` +
        `  git -C "${repoRoot}" worktree remove --force "${wtPath}"`,
      );
    }
    // **必须看返回值**:清不掉旧残留时,下面的 `worktree add` 会因为目录已存在而失败,
    // 报出来的却是"建 worktree 失败" —— 根因(上次的残留清不掉)被埋掉,人会查错方向。
    const rmOld = await removeWorktree(repoRoot, wtPath);
    if (!rmOld.ok) {
      throw new UsageError(`force:true 想覆盖,但清不掉上次残留的工作区 ${wtPath}:${rmOld.note}`);
    }
  }
  // 分支已存在:同样不猜,让调用方决定(force 才覆盖)。
  const exists = await git(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
  if (exists.ok) {
    if (!force) {
      throw new UsageError(`分支已存在:${branch}(上次跑过同名环节?)。要覆盖请给该环节加 force:true,或先 git branch -D "${branch}"`);
    }
    const delOld = await git(["branch", "-D", branch], repoRoot);
    if (!delOld.ok) throw new UsageError(`force:true 想覆盖,但删不掉旧分支 ${branch}:${delOld.stderr || delOld.code}`);
  }
  ensureDir(path.dirname(wtPath));
  // 用**解析后的 commit** 而不是 baseRef:一次运行里所有环节钉在同一个基线上,
  // 就算跑到一半主树的 HEAD 动了,也不会有的环节基于旧的、有的基于新的。
  const add = await git(["worktree", "add", "--quiet", wtPath, "-b", branch, baseCommit], repoRoot, { timeoutMs: WORKSPACE_BUDGET_MS });
  if (!add.ok) {
    // ⚠️ `worktree add` 可能**已经建了分支、写了登记**才失败。此刻 runNode 里的 `workspace`
    // 还没被赋值,外层 finally 的兜底清理够不着它 —— 不在这里收干净就会永久留下垃圾。
    await removeWorktree(repoRoot, wtPath);
    await git(["branch", "-D", branch], repoRoot);
    const why = add.timedOut ? `超过 ${WORKSPACE_BUDGET_MS}ms 没建完` : (add.spawnError || add.stderr || `退出码 ${add.code}`);
    throw new UsageError(`建 worktree 失败(${wtPath}):${why}`);
  }
  return { mode: "worktree", path: wtPath, branch, baseCommit };
}

/** 删掉一棵 worktree。**必须能扛住"目录被占着"** ——
 *  关会话只是把 SIGTERM 送到,后端进程真正退出是异步的;Windows 上只要它还握着 worktree 的句柄,
 *  `git worktree remove` 就会**注销掉登记、却删不掉文件**(留下一个目录和一个假的失败)。
 *  所以:先让 git 正常删一次,然后**退出去异步等 + 从外面反复重删**。
 *  ⚠️ 不能靠 `fs.rm` 自带的 `maxRetries`:那是同步自旋,而阻塞条件是**别的进程**的句柄,
 *     自旋不让出事件循环,那个进程也就永远退不出去 —— 自己把自己锁死。 */
async function removeWorktree(repoRoot, wtPath) {
  const rm = await git(["worktree", "remove", "--force", wtPath], repoRoot, { timeoutMs: WORKSPACE_BUDGET_MS });
  let lastErr = rm.ok ? null : (rm.stderr || `退出码 ${rm.code}`);
  let waited = false;
  for (let i = 0; i < 40 && fs.existsSync(wtPath); i++) {
    waited = true;
    await sleep(250);
    try { fs.rmSync(wtPath, { recursive: true, force: true }); }
    catch (e) { lastErr = e.message; }
  }
  // 上面若是我们自己删的,git 那边的登记可能还留着 —— prune 掉,否则 `git worktree list` 会有幽灵条目。
  await git(["worktree", "prune"], repoRoot);
  if (!fs.existsSync(wtPath)) {
    return { ok: true, note: waited ? "worktree 目录被后端进程占着,等它退出后才删掉" : null };
  }
  return { ok: false, note: `删 worktree 失败(目录留着了):${lastErr}` };
}

/** 收工作区:提交 → 导出 diff → 删 worktree(**保留分支**)。
 *  **不抛异常** —— 它跑在收尾路径上,环节可能已经失败了;这里再抛会盖掉真正的死因。
 *  所有问题记进 notes,由调用方并进 diagnostics。 */
async function finalizeWorktree({ repoRoot, ws, diffPath, nodeId, runKey, closeConfirmed }) {
  const notes = [];
  const out = {
    ...ws, committed: false, headCommit: null, filesChanged: [],
    diffPath: null, diffSha256: null, removed: false,
    // 「我们**确知**这棵工作树里有没有改动」。false = git 探测失败,既不能说有也不能说没有。
    changesKnown: false,
    // **这个环节到底交付了什么**,唯一权威结论。调用方(finish 的降级判断、复用闸)一律只看它,
    // 不各自拿 committed/filesChanged 再推一遍 —— 三处各推一遍,迟早推出三种结论。
    //   "delivered"   改动已提交到本环节分支,且 head/diff/摘要齐全
    //   "no-changes"  确知一个字都没动(HEAD 仍在基线上、索引为空)
    //   "unknown"     其余一切:探测失败、提交失败、交付物残缺、agent 自己动了 git
    outcome: "unknown",
  };
  /** 说不清的岔子:什么都不删,原样保留,由人来判。 */
  const preserve = (why) => {
    notes.push(
      `${why} —— 已**原样保留** worktree 与分支,什么都没删:${ws.path}\n` +
      `        请人工确认后自行处理:git -C "${ws.path}" status && git -C "${ws.path}" log --oneline`,
    );
    return { ...out, notes };
  };
  /** `name-status` 的一行 → {status, path}。 */
  const parseNameStatus = (stdout) =>
    stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean)
      .map((l) => {
        // ⚠️ 按**第一个制表符**切,不能 `split(/\s+/)` —— `name-status` 的分隔符是 TAB,
        // 而路径里**允许有空格**;按空白切会把 "src/my file.ts" 拆坏。
        // 重命名是 `R100<TAB>旧<TAB>新`,这里如实把两段都留在 path 里(用 → 连接)。
        const i = l.indexOf("\t");
        if (i < 0) return { status: "?", path: l.trim() };
        return { status: l.slice(0, i), path: l.slice(i + 1).split("\t").join(" → ") };
      });

  try {
    // ── 0) 先弄清 agent 把 HEAD 放哪了。**这一步不能省**。
    // ⚠️ 只看 `git add -A` 之后的暂存区是**不够**的:agent 完全可能自己 `git commit`(很多编码
    //    后端就是这么干的),那时暂存区是空的。照着"零改动"去删 worktree + `branch -D`,
    //    删掉的正是它刚提交的成果 —— 提交只剩悬空对象,静默、不可恢复。
    //    所以「零改动」必须**同时**证明两件事:索引里没东西 **且** HEAD 还停在基线上。
    const symref = await git(["symbolic-ref", "--quiet", "HEAD"], ws.path);
    const head0 = await git(["rev-parse", "HEAD"], ws.path);
    if (!head0.ok) return preserve("读不出这棵工作树的 HEAD(git 探测失败)");
    const headNow = head0.stdout.trim();
    // agent 若切了分支或进了 detached HEAD,它的提交就不在我们声称的那条分支上;
    // 此时任何"删树"都可能抹掉唯一还引用着那些提交的东西。
    if (!symref.ok || symref.stdout.trim() !== `refs/heads/${ws.branch}`) {
      return preserve(
        `工作区的 HEAD 已经不在本环节的分支 ${ws.branch} 上` +
        `(现在是 ${symref.ok ? symref.stdout.trim() : `detached @ ${headNow.slice(0, 8)}`})` +
        ` —— agent 自己动过 git,交付物落在哪已经无法判定`,
      );
    }

    // ── 1) 还没提交的改动
    // ⚠️ `-A` 会把 agent 在工作树里留下的**一切未被 gitignore 的东西**都提交进来 ——
    // 跑测试产生的 coverage/、临时文件、它自己写的 .env 都算。这是刻意的(它写的新文件通常正是产物),
    // 但**不是"天然安全"**:仓库 gitignore 不全时,噪声甚至敏感文件会进提交、并被导出到 diff 里。
    // 所以 `filesChanged` 一定要如实回报,而 SKILL 要求主 agent 合并前自己看 diff。
    const add = await git(["add", "-A"], ws.path, { timeoutMs: WORKSPACE_BUDGET_MS });
    if (!add.ok) notes.push(`工作区 git add 失败:${add.stderr || add.code}`);
    // `-c core.quotePath=false`:否则含非 ASCII 的路径会被 git 转义成 "\344\270\255" 那种鬼样子。
    const staged = add.ok
      ? await git(["-c", "core.quotePath=false", "diff", "--cached", "--name-status"], ws.path)
      : null;
    if (staged && !staged.ok) notes.push(`列暂存改动失败:${staged.stderr || staged.code}`);
    // **把"不知道"当成"没有"是这里最贵的一个错**:磁盘满、索引损坏、worktree 的 git 链接被弄坏时
    // 列出来同样是空,若照着"零改动"分支走就会把代码连同分支一起删掉。
    if (!staged?.ok) return preserve("无法确认工作区里有没有未提交的改动(git 探测失败)");
    out.changesKnown = true;
    const pending = parseNameStatus(staged.stdout);

    // ── 2) 真的一个字都没动?**两个条件都成立**才敢下这个结论
    if (pending.length === 0 && headNow === ws.baseCommit) {
      out.outcome = "no-changes";
      notes.push("这个环节没有改动任何文件");
      // ⚠️ 同样要过「关会话已确认」那道闸:关闭没被确认 = 后端可能还活着、还在写。
      // 此刻它虽然一个字都没改,删了树之后它再写的东西就没地方落了 —— 留着只是脏,删错是丢代码。
      if (closeConfirmed !== true) {
        notes.push(`关会话未被确认,后端可能仍在写 —— **保留**这棵(当前为空的)工作区与分支不删:${ws.path}`);
        return { ...out, notes };
      }
      // 不留空提交,也不留一条指向基线的垃圾分支。
      const rmEmpty = await removeWorktree(repoRoot, ws.path);
      out.removed = rmEmpty.ok;
      if (rmEmpty.note) notes.push(rmEmpty.note);
      const del = await git(["branch", "-D", ws.branch], repoRoot);
      if (del.ok) out.branch = null;
      // 删不掉就**如实说**:留着一条指向基线的空分支不影响正确性,但悄悄留下就没人知道该去清。
      else notes.push(`空分支删除失败,${ws.branch} 留在仓库里了(指向基线,可自行 git branch -D):${del.stderr || del.code}`);
      return { ...out, notes };
    }

    // ── 3) 有东西。先把还没提交的那部分提上去
    if (pending.length > 0) {
      // 仓库没配 user.email 时 commit 会直接失败 —— 那等于把改好的代码丢了。
      // 有身份就用仓库自己的,没有才补一个明确标着来源的兜底身份。
      const idc = await git(["config", "user.email"], ws.path);
      const idFlags = idc.ok && idc.stdout.trim()
        ? []
        : ["-c", "user.name=agent-bridge-graph", "-c", "user.email=graph@agent-bridge.local"];
      if (idFlags.length) notes.push("仓库未配置 user.email,本次提交用了兜底身份 graph@agent-bridge.local");

      const msg = `graph(${runKey}): ${nodeId}`;
      // ⚠️ `--no-verify` **只**跳过 pre-commit 与 commit-msg,**挡不住 post-commit**。
      // 而这是一次纯机械的"把 agent 干的活拍个快照"的提交,让仓库的任意钩子在这时候跑,
      // 就等于允许它在我们刚清点完之后再改工作树、甚至切走 HEAD —— 紧接着我们就
      // `worktree remove --force`,它写的东西一并没了。所以把 hooksPath 指到一个不存在的目录,
      // 让"不跑钩子"这件事是完整的,而不是只做了一半。
      const noHooks = ["-c", `core.hooksPath=${path.join(ws.path, "__agent_bridge_no_hooks__")}`];
      const commit = await git([...idFlags, ...noHooks, "commit", "--no-verify", "-m", msg], ws.path, { timeoutMs: WORKSPACE_BUDGET_MS });
      if (!commit.ok) {
        return preserve(`提交失败(改动还在工作区里,删了就没了):${commit.stderr || commit.code}`);
      }
    } else {
      notes.push(`agent 自己提交过(HEAD 已从基线移到 ${headNow.slice(0, 8)}),本环节没有额外要提交的东西`);
    }

    // ── 4) 记 head、列交付的改动、导出 diff
    const head1 = await git(["rev-parse", "HEAD"], ws.path);
    if (!head1.ok) return preserve("提交之后反而读不出 HEAD 了(git 探测失败)");

    // ⚠️ **提交完要再看一眼,别假设"提交成功 = 树就静止了"。**
    // 钩子、后台进程、还没退干净的后端都可能在这之后继续动这棵树。这里若不复查就直接
    // 判 delivered 并删树,新写出来的东西既不在 diff 里、也没了。
    const leftover = await dirtyEntries(ws.path, []);
    if (leftover === null) return preserve("提交之后查不出工作区是否还有残留改动(git 探测失败)");
    if (leftover.length) {
      return preserve(
        `提交之后工作区里又出现了改动(共 ${leftover.length} 条,如 ${leftover.slice(0, 3).join(" / ")})` +
        ` —— 它们不在 base..HEAD 里,删树就没了。**不自动再提交一次**:说不清是谁写的,交给人判`,
      );
    }
    const symref1 = await git(["symbolic-ref", "--quiet", "HEAD"], ws.path);
    if (!symref1.ok || symref1.stdout.trim() !== `refs/heads/${ws.branch}`) {
      return preserve(`提交之后 HEAD 被切走了(现在是 ${symref1.ok ? symref1.stdout.trim() : "detached"}),交付坐标已不可信`);
    }

    out.headCommit = head1.stdout.trim();
    out.committed = true;
    // **交付的改动 = 基线到 HEAD 的全部**,不是"我们刚提交的那一笔"。
    // agent 自己提交过时,后者是空的 —— 拿它当 filesChanged 就是在回执里撒谎说"没改任何文件"。
    const names = await git(
      ["-c", "core.quotePath=false", "diff", "--name-status", ws.baseCommit, "HEAD"], ws.path,
      { timeoutMs: WORKSPACE_BUDGET_MS },
    );
    if (names.ok) out.filesChanged = parseNameStatus(names.stdout);
    else notes.push(`列交付改动失败:${names.stderr || names.code}`);
    // --binary:二进制改动也要能被 git apply 还原,否则 diff 是残的
    const dr = await git(["diff", "--binary", ws.baseCommit, "HEAD"], ws.path, { timeoutMs: WORKSPACE_BUDGET_MS, toFile: diffPath });
    if (dr.ok) {
      out.diffPath = diffPath;
      // 内容指纹:复用时要能确认"这份 diff 还是当初那份"(同 artifactSha256 的道理)
      out.diffSha256 = await sha256File(diffPath);
    } else notes.push(`导出 diff 失败:${dr.stderr || dr.code}`);

    // ── 5) **交付物齐了吗?四样缺一不可。**
    // 只查 `committed` 是不够的:提交成功、但 rev-parse / 列改动 / 导出 diff / 算摘要任一步失败时,
    // 回执里就少了 headCommit 或 diffPath/diffSha256 —— 这种残回执**首跑会报 ok**,
    // 要等到下次复用才被闸拦下。等于"第一次骗你,第二次才告诉你"。
    if (/^[0-9a-f]{40}$/.test(out.headCommit) && names.ok
        && out.diffPath && /^[0-9a-f]{64}$/.test(out.diffSha256 || "")) {
      out.outcome = "delivered";
      // HEAD 前进了但净改动为零(agent 建了空提交,或提交完又 revert)。分支上只有历史、没有内容变化,
      // diff 于是是 0 字节 —— 这是合法结局,复用闸那边也**不拿 0 字节当失败**(两边判据必须一致)。
      if (out.filesChanged.length === 0) {
        notes.push(`HEAD 相对基线前进了(${ws.baseCommit.slice(0, 8)} → ${out.headCommit.slice(0, 8)}),但净改动为空 —— 分支上只有历史,没有内容变化`);
      }
    } else {
      return preserve("提交成功了,但交付物不完整(head / 改动清单 / diff / 摘要有一样没拿到)");
    }

    // ── 6) 删 worktree 是最后一步(**保留分支**)。
    if (closeConfirmed !== true) {
      // ⚠️ 关会话**没被确认**意味着后端进程可能还活着、还在往这棵树里写。
      // 此刻删树 = 把它后续的写入连同目录一起抹掉,而我们刚提交的只是个半成品。
      // 提交保住了已有的部分;树留着,让人能看到它后来又写了什么。
      notes.push(
        `关会话未被确认,后端可能仍在写这棵树 —— 已提交当前状态到 ${ws.branch},但**保留**工作区不删:${ws.path}`,
      );
    } else {
      const rm = await removeWorktree(repoRoot, ws.path);
      out.removed = rm.ok;
      if (rm.note) notes.push(rm.note);
    }
  } catch (e) {
    // 这里兜的是**任何**没预料到的异常。finalize 跑在收尾路径上,环节可能已经失败了;
    // 让它抛出去会盖掉真正的死因。⚠️ 兜底覆盖整个函数体(含删树),不是只覆盖前半段。
    notes.push(`收工作区时出错(已停在当前状态,不再删任何东西):${e?.message || String(e)}`);
  }
  return { ...out, notes };
}

/** 并发闸:把「一次并行别超过 4 个」从纪律变成机制。
 *  超限的 runNode **排队等待**,而不是报错 —— 调用方照写 `Promise.all`,不用自己搓限流。
 *
 *  ⚠️ 释放时必须把名额**直接交接**给队首,不能"先 `active--`、等队首醒来再 `active++`"。
 *  后者在这两步之间留了一个 `active` 偏低的空窗:唤醒队首只是排了个微任务,而任何**早于它入队**的
 *  微任务里若有一次新的 `acquire()`,就会看到 `active < max` 直接放行 —— 队首随后再 `++`,
 *  于是同时在跑的比 max 多一个。实测 max=2 时峰值到 3(见 W16 的最小复现)。
 *  交接式写法让 `active` 在有人排队时**恒等于真实在跑的数量**,空窗不存在。 */
function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < max) { active++; return; }
      await new Promise((resolve) => queue.push(resolve));
      // 名额是 release() 直接转手过来的,这里**绝不能**再 ++(否则又把空窗补回去了)
    },
    release() {
      const next = queue.shift();
      if (next) { next(); return; } // 名额转手,active 不变
      active--;
    },
  };
}

/** 一次运行的可变状态。
 *
 *  ⚠️ **为什么必须是一个对象,不能继续用闭包里的 `let`**:`prepare / turn / finalize` 原本是
 *  同一个函数体里的三段,拆成三个函数之后,`sessionId` / `openOutcome` / `workspace` 这些 `let`
 *  就不再被共享 —— 每个函数各自捕获一份副本。而"收工作区时读到的 `openOutcome` 必须是开会话
 *  那一刻写下的那个"正是**删不删 worktree** 的判据(见 finalizeRun)。放进同一个对象里,
 *  共享是**结构上的事实**,不是"碰巧调用顺序对了"。
 *
 *  ⚠️ 时钟与现场保留挂成 `run.remaining()` 这样的闭包,而不是 `remainingOf(run)` 这样的自由函数:
 *  这样搬进 `runTurn` 的那几百行**一个字符都不用改**(里面仍写 `remaining()` / `budget()` / `finish()`)。
 *  改动越少,行为漂移的机会越少 —— 这次重构的硬指标是"`runNode` 行为零变化"。
 */

/**
 * ① 准备:规范化 spec → 进程内防撞 → 锁文件 → 仓库体检 + 脏树查 → 幂等/复用闸。
 *
 * **这一段里没有一件事需要预算**,所以它全部排在并发闸之前(与今天一致)。
 * 命中复用时把结果放在 `run.reusedReceipt` 上返回,资源已在返回前收干净。
 * 抛错(用法错/复用闸不过)时同样先收干净再抛。
 */
export async function prepareRun(bridge, rawSpec, { kind = "node", hold = null } = {}) {
  const spec = normalizeSpec(rawSpec, { kind });

  // ── viz:outDir 闸。**必须早于任何落盘**(早于 ensureDir、早于快照、早于建 `<id>.lock`)——
  //    否则"拒绝"之前已经在别人的目录里留了垃圾。
  const scope = bridge?._viz || null;
  if (scope) {
    try {
      scope.assertSameOutDir(spec.outDir, kind === "conversation" ? "conversation()" : "runNode()");
    } catch (e) { throw new UsageError(e.message); }
  }

  ensureDir(spec.outDir);
  const nodesDir = path.join(spec.outDir, "nodes");
  ensureDir(nodesDir);

  // ── viz:分配 `nodeSeq` 并建本节点的归档目录。
  //    ⚠️ **同步分配,中间不让出事件循环** —— 这样号与调用顺序一致;
  //    并且**拿到号的调用一定会发 `node:observed`**,所以走 `node:rejected` 的节点照样有号。
  let viz = null;
  if (scope) viz = createNodeViz(scope, scope.nextNodeSeq(), spec);
  // ⚠️ **立刻交给调用方**:`prepareRun` 后面几关(lock / preflight / reuse-check)都可能抛,
  //    而那时调用方还没拿到 `run`,拿不到 viz 就发不出 `node:rejected` ——
  //    于是这个节点在页面上会**只有一条 `node:observed`、永远等不到终态**,
  //    被 §10.1 合成一个假的 `abandoned`。
  if (hold) hold.viz = viz;

  const artifactPath = path.join(nodesDir, `${spec.id}.md`);
  const receiptPath = path.join(nodesDir, `${spec.id}.receipt.json`);
  const sceneDir = path.join(nodesDir, `${spec.id}.scene`);
  // `runId` 只是给人看的标签。**资源唯一性不能只靠它** —— 它取自 outDir 的目录名,
  // 而 `D:/a/run-1` 与 `D:/b/run-1` 的目录名一模一样:两次运行会映射到同一条 worktree 路径
  // 和同一个分支名。默认情况下第二个撞上"目录已存在/分支已存在"报 UsageError(还算安全),
  // 但只要有一边带 `force:true`,就会把另一边**正在写**的工作树连同分支一起删掉 —— 静默丢代码。
  // 拼上 outDir 全路径的短哈希,让「不同 outDir = 不同资源」成为事实而不是巧合。
  const runId = path.basename(spec.outDir);
  const runKey = `${gitSafeSlug(runId)}-${sha256Text(realpathSafe(spec.outDir)).slice(0, 8)}`;

  const isConv = spec.kind === "conversation";
  const run = {
    isConv,
    bridge, spec, nodesDir, artifactPath, receiptPath, sceneDir, runKey,
    // 一轮的产出/现场落在哪。**单轮节点不是特例,是 N=1** —— 它走的是同一条路,
    // 只不过路径投影回 `<id>.md` / `<id>.scene`,保证既有断言逐字节不变。
    artifactPathFor: (key) => (isConv ? path.join(nodesDir, `${spec.id}.t-${key}.md`) : artifactPath),
    sceneDirFor: (key) => (isConv ? path.join(nodesDir, `${spec.id}.t-${key}.scene`) : sceneDir),
    /** **每次尝试恒写一份产出原件**,与 viz 开关无关。
     *
     *  ⚠️ 早先每次尝试都覆盖该轮那一个 `artifactPath` —— 于是第一次的产出被第二次冲掉,
     *  而第一次那份**正是「打回重说」这个自动决策的唯一依据**:没有它,事后谁也说不清
     *  当初为什么判它不合格。这是**数据丢失**,不是"少存一份"。
     *
     *  ⚠️ `<n>` 在**每一轮内**从 1 重新开始,所以对话必须带 `.t-<key>` 这一段:
     *  否则 `draft` 轮的第 1 次与 `fix` 轮的第 1 次会写进同一个文件,后写的把前一份审计原件盖掉。
     *  投影按**调用的是哪个 API** 分派,不按 `key` 的字面量分派 —— 一段对话里的某一轮
     *  完全可以也叫 `main`,它照样写 `<id>.t-main.a<n>.md`。 */
    attemptArtifactPathFor: (key, n) => (isConv
      ? path.join(nodesDir, `${spec.id}.t-${key}.a${n}.md`)
      : path.join(nodesDir, `${spec.id}.a${n}.md`)),
    turnRec: null,     // 这一轮往哪儿写。runNode 时**就是回执本身**
    currentKey: null,
    /** 这个节点的观测适配器(见 `viz-node.mjs`)。**viz 关着时恒为 null**,
     *  于是全模块的插桩点都是 `if (run.viz)` 一句 —— 没有第二条代码路径。 */
    viz,
    nodeSeq: viz ? viz.nodeSeq : null,
    scopeHeld: false,
    turns: [],
    poisonedAfter: null,
    turnKeys: new Set(),
    turnCalls: 0,            // 回调调用过几次 turn()。**与 turns.length 是两回事**:入场被拒的
                             // 那几次不进 turns[],但它们证明"编排不是空转"。
    lastTurnFailure: null,   // 最后一次「调了 turn() 却没进 turns[]」的真实原因(校验错 / 四道闸 /
                             // 开过头才失败,一律记)。回调吞了异常时,收尾靠它说人话。
    activeTurn: false, // §3.1 串行闸:同步查+置位,不许有第二轮同时进来
    sealed: false,     // fn 返回后封 admission
    diffPath: path.join(nodesDir, `${spec.id}.diff`),
    lockPath: path.join(nodesDir, `${spec.id}.lock`),
    lockFd: null, active: null, activeKey: null,
    repoRoot: null, baseCommit: null,
    gateHeld: false,
    workspaceFinalized: false, // 收过工作区没有。**不能靠 workspace.removed 推断** ——
                               // "提交失败所以故意留着目录"也是 removed:false,那种情况绝不能再收一次。
    workspace: null,           // write 环节的 worktree 信息(read 环节恒为 null)
    opened: false,             // 首轮入场(worktree + open_session)做过没有
    clockStarted: false,
    sessionId: null,
    logFile: null,
    lastTextRef: null,
    /** open_session 这一步的结局。**「没拿到 sessionId」≠「后端没起来」** ——
     *  请求可能已经发出去、桥那边真把会话建起来了,只是响应超时或管道断了,我们没拿到句柄。
     *  收工作区时把这两种情况混为一谈,就会在后端可能还活着的时候把工作树删掉。
     *    "not-attempted" 请求压根没发(还没发预算就耗尽了)
     *    "refused"       桥**明确回报**开不起来 —— 确定没有后端(最常见:后端没装/起不来)
     *    "unknown"       发出去了但结局不明(本地超时 / 断管 / 返回形状不认识)
     *    "opened"        拿到了 sessionId */
    openOutcome: "not-attempted",
    receipt: null,
    reusedReceipt: null,
    // ⚠️ 计时**从拿到并发闸之后**才起算(见 startClock)——排队等待不算进环节预算。
    // 否则扇出 20 个、闸开 4 个时,排在后面的会带着一个已经烧掉大半的 timeoutMs 开跑,
    // 于是"同一张任务单,排第几位决定它超不超时"——那不是超时,那是抽签。
    startedAt: nowIso(),
    t0: monoNow(),
    nodeT0: null,   // 整个环节的起点(= 首轮起钟那一刻)。durationMs 用它,不用最后一轮的 t0。
    deadline: 0,
    /** 上一次 RPC 的期限**是不是由本轮的预算决定的**(而不是那类调用的默认上限)。
     *  用来精确区分两种本地超时,不靠事后比 `remaining()<=0`——那是个竞态:
     *  计时器到点时剩余量可能还是个微小正数,同一件事会时而判 timeout、时而判 unknown。 */
    rpcDeadlineFromBudget: false,
  };
  run.deadline = run.t0 + (spec.timeoutMs ?? 0);

  /** 起钟。**每一轮在自己被 admit 的那一刻**用自己的 `timeoutMs` 起算(对话方案 §2.1);
   *  `runNode` 只有一轮,所以它与今天逐字节相同。 */
  run.startClock = (ms) => {
    run.startedAt = nowIso();
    run.t0 = monoNow();
    run.deadline = run.t0 + ms;
    // 回执的 startedAt 说的是**这个环节什么时候开跑**,只认第一轮 —— 后面的轮各自起钟,
    // 但不该把环节的起点往后推。
    if (!run.clockStarted) {
      run.clockStarted = true;
      run.nodeT0 = run.t0;
      if (run.receipt) run.receipt.startedAt = run.startedAt;
    }
  };
  /** 本轮还剩多少预算。**每一次 RPC 都受它约束** —— 否则 open/send 卡住就能把「总上限」顶穿。 */
  run.remaining = () => run.deadline - monoNow();
  /** 给某次 RPC 的预算:本轮预算与该类调用默认上限的较小值。 */
  run.budget = (cap = RPC_TIMEOUT_MS) => {
    const ms = Math.min(cap, Math.max(0, run.remaining()));
    run.rpcDeadlineFromBudget = ms < cap;
    return ms;
  };

  // ── viz:`node:observed`。**排在并发撞车检查与建 `<id>.lock` 之前** ——
  //    输入三件套(spec / prompt / role)的资产状态由它承担,而不能挂在 `node:settled` 上:
  //    这个节点接下来完全可能直接走 `node:rejected`,**那条路上没有 `node:settled` 可挂**。
  if (viz) { await viz.observed(); vizCount(bridge, "observed"); }

  // 同一个 <outDir,id> 在同一个 bridge 里并发跑 = 两个环节写同一个产出,后写者覆盖前者,
  // 而两张回执都可能声称成功。当场拒绝(这是调用方的 id 用重了,属用法错)。
  const activeKey = JSON.stringify([spec.outDir, spec.id]);
  let active = ACTIVE_NODES.get(bridge);
  if (!active) { active = new Set(); ACTIVE_NODES.set(bridge, active); }
  if (active.has(activeKey)) {
    throw Object.assign(
      new UsageError(`同一个 outDir 里的环节 id "${spec.id}" 正在并发运行 —— id 必须唯一`),
      { phase: "lock" },
    );
  }
  active.add(activeKey);
  run.active = active;
  run.activeKey = activeKey;

  // 跨 bridge / 跨进程的防撞:原子创建锁文件(wx = 已存在就失败)。
  // 上面那个 Set 只看得见自己这个 bridge;两个 withBridge、两个 node 进程照样能撞同一份产出。
  const lockPath = run.lockPath;
  try {
    run.lockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(run.lockFd, `${process.pid} ${nowIso()}\n`, "utf8");
  } catch (e) {
    active.delete(activeKey);
    // ⚠️ openSync 成功、writeFileSync 才失败(磁盘满等)时,**外层的收尾还没接管** ——
    // 不在这里收就会同时泄漏一个 fd 和一把永远解不开的锁。
    if (run.lockFd !== null) {
      try { fs.closeSync(run.lockFd); } catch {}
      try { fs.rmSync(lockPath, { force: true }); } catch {}
      run.lockFd = null;
    }
    if (e.code === "EEXIST") {
      throw Object.assign(new UsageError(
        `环节 "${spec.id}" 的锁文件已存在:${lockPath}\n` +
        `要么另一个进程正在跑同一个环节(id 撞了),要么上次异常退出留下了它 —— 确认没人在跑后删掉它再来。`,
      ), { phase: "lock" });
    }
    throw Object.assign(new UsageError(`无法创建环节锁文件 ${lockPath}:${e.message}`), { phase: "lock" });
  }

  run.receipt = {
    receiptVersion: RECEIPT_VERSION,
    id: spec.id, specHash: spec.specHash,
    agent: spec.agent, model: spec.model ?? null, effort: spec.effort ?? null,
    status: "unknown", artifactPath: null, charCount: null, byteCount: null,
    contextUsage: null, reaskCount: 0, durationMs: null,
    startedAt: run.startedAt, endedAt: null, diagnostics: [], error: null, scene: null,
    sessionId: null, abortConfirmed: null, closeConfirmed: null, artifactSha256: null,
    // v2:**每次尝试各自一条**。第一次的产出不再被第二次覆盖(见 attemptArtifactPathFor)。
    attempts: [],
    // read 环节恒为 null;write 环节在入场时填 worktree 信息,收尾时被 finalizeWorktree 的结果填满
    // (branch / baseCommit / headCommit / filesChanged / diffPath / committed / removed)。
    access: spec.access, workspace: null,
  };
  if (isConv) {
    run.receipt.kind = "conversation";
    run.receipt.turns = [];
    run.receipt.poisonedAfter = null;
    // 逐轮才有的那几样在对话的**顶层回执**上没有意义 —— 留着就是一排恒为 null 的字段,
    // 而"没有消费者的字段"这个坑本仓踩过好几次。它们全在 turns[] 里各归各轮。
    for (const k of ["artifactPath", "charCount", "byteCount", "artifactSha256",
                     "reaskCount", "contextUsage", "abortConfirmed", "scene", "attempts"]) {
      delete run.receipt[k];
    }
  } else {
    // runNode:这一轮**就是**回执本身,于是顶层字段一个都不用投影(§2.2)
    run.turnRec = run.receipt;
  }

  /** 现场保留(三件套):桥干净退出会删掉本次 run 的日志目录、close_session 会删 textRef,
   *  所以**必须在关会话/关桥之前**把现场 cp 出来。缺哪件就在 diagnostics 里说明原因。 */
  run.saveScene = async (tag, rec = run.receipt, dir = run.sceneDir) => {
    const receipt = rec; // 现场与它的诊断都记在**这一轮**名下(runNode 时它就是回执本身)
    try {
      ensureDir(dir);
      const files = [];
      if (run.logFile) {
        if (copyBytes(run.logFile, path.join(dir, "session.log"))) files.push("session.log");
        else receipt.diagnostics.push(`现场:复制 session.log 失败(${run.logFile})`);
      } else receipt.diagnostics.push("现场:没有 logFile 可复制(会话可能没开起来)");

      // 超时/失败时答案可能仍然拿得到(abort 之后 textRef 往往还在)—— 尽力取一次
      if (!run.lastTextRef && run.sessionId) {
        try {
          const r = await run.bridge.callTool("agent_bridge_result", { session_id: run.sessionId }, FINALIZE_BUDGET_MS / 3);
          if (r?.textRef) run.lastTextRef = r.textRef;
        } catch (e) { receipt.diagnostics.push(`现场:补取 result 失败(${e.name})`); }
      }
      if (run.lastTextRef) {
        if (copyBytes(run.lastTextRef, path.join(dir, "answer.txt"))) files.push("answer.txt");
        else receipt.diagnostics.push(`现场:复制 answer.txt 失败(${run.lastTextRef})`);
      }

      if (run.sessionId) {
        try {
          const st = await run.bridge.callTool("agent_bridge_status", { session_id: run.sessionId }, FINALIZE_BUDGET_MS / 3);
          writeAtomic(path.join(dir, "status.json"), JSON.stringify(st, null, 2) + "\n");
          files.push("status.json");
        } catch (e) { receipt.diagnostics.push(`现场:取 status 失败(${e.name})`); }
      }
      /* `hadSession` 是给 §3.2 那张**逐槽表**用的:三个槽里**只有 `status` 有
         `not-applicable` 这一档**,判据正是「**当时有没有 sessionId**」——
         没有会话就无状态可查(本来就不该有),有会话却没拿到才是"该保没保成"。
         ⚠️ 不记下来的话,viz 那边只能看到"文件不在",两种情况分不开;
            一律说成"该保没保成"会把一次**正常**的缺席报成故障。 */
      const scene = { dir, tag, savedAt: nowIso(), files, hadSession: !!run.sessionId };
      receipt.scene = scene;
      return scene;
    } catch (e) {
      receipt.diagnostics.push(`保留现场失败:${e.message}`);
      return null;
    }
  };

  run.closeSession = async () => {
    const receipt = run.receipt;
    if (!run.sessionId) return;
    try {
      const r = await run.bridge.callTool("agent_bridge_close_session", { session_id: run.sessionId }, FINALIZE_BUDGET_MS / 2);
      // **看返回内容,不是"没抛异常就算成"**:`null` / `{closed:false}` 都不是关成功了
      receipt.closeConfirmed = r?.closed === true;
      if (!receipt.closeConfirmed) {
        receipt.diagnostics.push(`关会话未被确认(返回:${JSON.stringify(r).slice(0, 200)})`);
      }
    } catch (e) {
      receipt.closeConfirmed = false;
      receipt.diagnostics.push(`关会话失败(${e.name}):${e.message}`);
    } finally {
      // 记下"刚关过一个会话":桥要到 3 秒后才对收不掉的后端补刀,bridge.close() 得把这个窗口等完。
      // close **没被确认**时(本地超时/断管),这个时刻不可信 —— 桥可能稍后才处理那条 close,
      // 标记出来,让 bridge.close() 在 bulk 响应时重新起算窗口。
      noteSessionClosed(run.bridge, receipt.closeConfirmed === true);
    }
  };

  let reused = null;
  try {
    // --- write 环节的仓库体检(只读探查)。**排在幂等闸之前** —— 复用时要拿 baseCommit 去比对。
    if (spec.access === "write") {
      const info = await inspectRepo(spec.cwd, spec.baseRef);
      run.repoRoot = info.repoRoot;
      run.baseCommit = info.baseCommit;
      // ⚠️ 脏树闸也**排在幂等闸之前** —— 否则它只保护"真跑",不保护"复用":
      // 同一个脏工作区下,新跑会被拒绝,而命中复用却照样交货,且调用方分不出这两种情况。
      // 复用出来的结果同样是对着 HEAD 做的、同样看不见那些未提交改动,该拦就得一起拦。
      await taggedPhase("preflight", () =>
        assertCleanBase({ repoRoot: run.repoRoot, spec, baseCommit: run.baseCommit, nodesDir }));
    }

    // --- 幂等闸
    if (fs.existsSync(receiptPath) && !spec.force) {
      reused = await taggedPhase("reuse-check", () => checkReuse(run));
    }
  } catch (e) {
    await releaseRun(run);
    throw e;
  }
  if (reused) {
    run.reusedReceipt = reused;
    // ⚠️ 对话命中复用时**不在这里放锁**:回放要把回调整段跑一遍(里面可能还有嵌套节点),
    // 这段时间同一个 id 不该被第二个进程同时开工。由 conversation() 的收尾统一释放。
    // `runNode` 保持今天的行为(复用即返回,锁当场还回去)。
    if (!run.isConv) await releaseRun(run);
  }
  return run;
}

/**
 * 复用前逐一坐实**每次尝试的审计原件**,以及 `attempts[]` 本身是不是一份**完好的 v2 清单**。
 *
 * ⚠️ **这道闸不是可有可无的。** 复用命中时 `emitReusedSettled` 会把每一次尝试的
 * `artifactPath` 重新归档进本次的 graph、**按当前磁盘字节现算一个 sha** 发到 wire 上。
 * 页面据此说"这就是当初第 n 次尝试写下的东西"。若这里不核对,首跑之后手改一下
 * `<id>.a1.md`(或者把回执里那条路径指到别的文件),复用照样成功,而第二个 graph
 * 会把**篡改过的字节**包装成一份崭新的 `present` —— 指纹与篡改后的内容自洽,
 * **页面上一点红都不会有**。而"被打回的那一次到底写了什么"正是复审时最想看的东西。
 *
 * ⚠️ **只逐项验文件是不够的,`attempts[]` 的「形状」本身也是承重的。**
 * `emitReusedSettled` 按**数组顺序**归档、并把**最后一个**当成该轮最终产出;
 * 不变式③也按同一个数组顺序取"最后一项"。所以把 `[#1 rejected, #2 accepted]`
 * **对调一下**,两个文件、两个 sha 全都对得上,而页面会把**被打回的那一份**
 * 当成最终交付物挂出来 —— 生产者与校验器**一起假绿**。
 * 所以下面把 `n` 定死成 **1..k 严格递增**(顺手也堵死了 `n` 被塞成
 * `"../../x"` 之类:那会经 `path.join` 逃出 `nodesDir`,而"本次算出来的路径"
 * 是用同一个 `n` 算的,自己和自己比当然相等)。
 *
 * 逐项判定:
 *   - 有 `artifactPath` ⇒ 它就是一句"我在这里留了一份、指纹是这个"的断言:路径必须是
 *     **本次算出来的**那个、文件必须在、指纹必须是合法 hex64 且**逐字节对得上**。
 *   - 没有 `artifactPath` ⇒ 放行。⚠️ **这不是"当初没开 viz"** —— v2 的逐次原件与 viz
 *     开关无关(见 `attemptArtifactPathFor`),真正会留下无路径项的只有**当时那次复制失败**。
 *     ⚠️ **老实说清残留风险**:回执里"复制当时就失败"与"事后把证据字段删掉"**长得一模一样**,
 *     现有结构没有字段能区分,所以这里拒不了。但它的后果是**有界的** —— 那一项会被投影成
 *     `fingerprint-only`,页面**不会拿到任何字节**,也就不存在"把伪造内容当证据展示"。
 *     换句话说:删字段能让证据**消失**,不能让证据**变假**。
 *
 * ⚠️ **不要求非空**:一次尝试的产出确实可能是零字节(`status:"no-output"` 就是
 *    「**已经确认**产出是零字节」这一档),空文件的 sha256 是良定义的,照常比对即可。
 */
const ATTEMPT_STATUS = new Set(["accepted", "rejected", "no-output", "failed"]);

async function assertAttemptsIntact(run, turnKey, attempts, reask, bail) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    throw bail(`这一轮的回执里没有 attempts[] —— v2 的每一轮都至少有一次尝试,拿不到就没有任何可比对的判据`);
  }
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    // `n` 必须是 1..k 严格递增。**顺序错了不是小事**:见上面那段"对调"。
    if (!a || a.n !== i + 1) {
      throw bail(`attempts[] 的次序坏了(第 ${i} 项的 n 是 ${JSON.stringify(a?.n)},应当是 ${i + 1}) —— ` +
        `顺序决定了"哪一次是最终产出",错位会把被打回的那一份当成交付物挂出来`);
    }
  }
  /* ⚠️ **尝试次数有硬上界**:`reask` 只能是 0 或 1 ⇒ 最多 `reask + 1` 次。
        而 `reask` 进了 specHash / turnSpecHash,复用时必然与原运行相同 —— 所以这是**可验的**。
        少了它,往回执里**塞第三次尝试**能一路走到事件层才被 schema 拒,而那里被 `guard()`
        吞掉:业务照常返回"复用成功",页面却**永远等不到 node:settled**(见下面那条注释)。 */
  const cap = (reask === 0 || reask === 1 ? reask : 1) + 1;
  if (attempts.length > cap) {
    throw bail(`这一轮记了 ${attempts.length} 次尝试,而 reask=${reask} 最多只可能有 ${cap} 次`);
  }
  /* ⚠️ **逐字段的形状先查,再查字段之间的关系。** 顺序反了的后果不是"结论不同",
        而是**下面那几道闸永远考不出来**:一个枚举外的 status 会先被"非末次只能是 rejected"
        拦下,于是枚举那道闸有没有效**永远没人知道**(测试里它天然撞不到)。 */
  for (const a of attempts) {
    // 状态是**封闭枚举**(§5.6)。塞一个枚举外的值同样只会在事件层被拒、而那里被吞掉。
    if (!ATTEMPT_STATUS.has(a.status)) {
      throw bail(`第 ${a.n} 次尝试的 status 不在封闭枚举里:${JSON.stringify(a.status)}`);
    }
    // 输入指纹是这一次尝试**唯一**能自证的东西(输入原文可能压根没落盘),形状必须合法。
    if (!/^[0-9a-f]{64}$/.test(a.inputSha256 || "")) {
      throw bail(`第 ${a.n} 次尝试没有合法的输入指纹(inputSha256):${JSON.stringify(a.inputSha256)}`);
    }
    // `no-output` 的字面意思就是「**已经确认**产出是零字节」——它与非零字节数自相矛盾。
    if (a.status === "no-output" && a.byteCount != null && a.byteCount !== 0) {
      throw bail(`第 ${a.n} 次尝试记成 no-output,却又记了 ${a.byteCount} 字节 —— 自相矛盾`);
    }
  }

  // 一轮收在 ok,**最后那一次必然是被采纳的那一次**(§5.6 的四档判定表:ok ⇒ accepted / no-output)。
  const last = attempts[attempts.length - 1];
  if (last.status !== "accepted" && last.status !== "no-output") {
    throw bail(`这一轮收在 ok,但最后一次尝试是 ${JSON.stringify(last.status)}(应当是 accepted 或 no-output)`);
  }
  /* ⚠️ **非末次只可能是 `rejected`。** 走到下一次尝试的**唯一**出口就是"这一次被判不合格"
        (`settleAttempt(…, "rejected")` 之后才 `continue`)。所以把第 1 次从 `rejected`
        改成 `accepted`,会生成一份**合法形状、内容却是假的**审计记录:
        页面上两次都显示"被采纳",而当初真实发生的是"第一稿被打回"。 */
  for (let i = 0; i < attempts.length - 1; i++) {
    if (attempts[i].status !== "rejected") {
      throw bail(`第 ${i + 1} 次尝试记的是 ${JSON.stringify(attempts[i].status)} —— ` +
        `只有"被判不合格"才会有下一次,所以非末次只可能是 rejected`);
    }
  }
  for (const a of attempts) {
    if (!a.artifactPath) continue;              // 当时那次复制失败 —— 见上面的残留风险说明
    const want = run.attemptArtifactPathFor(turnKey, a.n);
    if (a.artifactPath !== want) {
      throw bail(`第 ${a.n} 次尝试的审计原件路径与本次算出来的不一致(${a.artifactPath} ≠ ${want})`);
    }
    const st = statSafe(want);
    if (!st || !st.isFile()) throw bail(`第 ${a.n} 次尝试的审计原件缺失:${want}`);
    // 同顶层那道闸:**"字段缺失就跳过校验"这个坑本仓踩过三次**,所以这里要求指纹
    // 必须是合法的 64 位 hex —— 回执说"我留了一份"却给不出指纹,就是给不出判据。
    if (!/^[0-9a-f]{64}$/.test(a.artifactSha256 || "")) {
      throw bail(`第 ${a.n} 次尝试记了原件路径却没有合法的内容指纹:${want}`);
    }
    if (await sha256File(want) !== a.artifactSha256) {
      throw bail(`第 ${a.n} 次尝试的审计原件内容与回执记录的不一致(可能被改过):${want}`);
    }
  }
}

/** 幂等闸:上一张回执还能不能当成这一次的结果。
 *  ⚠️ **每一条不匹配都是 `throw new UsageError`,没有一条回退去重跑** —— 静默重跑会把
 *  "上一版任务的结果"和"这一版"混在一起,是最难查的一类错。要重跑请显式加 `force`。 */
async function checkReuse(run) {
  const { spec, receiptPath, artifactPath, diffPath, runKey } = run;
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch {}
  if (!spec.reuseIfSame) {
    throw new UsageError(`回执已存在:${receiptPath}(要覆盖请加 force,要按指纹复用请加 reuseIfSame)`);
  }
  if (!prev || prev.receiptVersion !== RECEIPT_VERSION) {
    const got = prev ? JSON.stringify(prev.receiptVersion) : "(回执读不出来或不是合法 JSON)";
    throw new UsageError(
      `回执存在但版本对不上,不能安全复用:${receiptPath}\n` +
      `  这张回执是 v${got},当前是 v${RECEIPT_VERSION}。\n` +
      (prev && prev.receiptVersion === 1
        ? `  v1 → v2 加了 turns[].attempts[](每次尝试各一份产出与输入指纹)与几个相对 ref。\n` +
          `  **旧回执里没有这些字段**,拿它当"支持新 UI 的回执"用,页面上那一段只会是空白 ——\n` +
          `  所以这里响亮地拒掉,而不是静默降级。\n`
        : "") +
      `  处置:加 force 重跑一次(会覆盖上次那次执行的产出)。`,
    );
  }
  if (prev.specHash !== spec.specHash) {
    throw new UsageError(
      `回执已存在但任务单变了(旧 ${prev.specHash} ≠ 新 ${spec.specHash}):${receiptPath}\n` +
      `复用会把上一版任务的结果当成这一版。要重跑请加 force。`,
    );
  }
  // 只有成功的回执才值得复用 —— 复用一张失败回执等于把上次的失败凭空延续下去
  if (prev.status !== "ok") {
    throw new UsageError(`回执存在但上次是 ${prev.status}(不是 ok),不复用失败结果。要重跑请加 force。`);
  }
  if (run.isConv) {
    // ⚠️ **`kind` 这道闸只属于 conversation()。** `runNode` 的复用闸绝不能开始查它 ——
    // 历史回执没有这个键,加上去等于把所有旧回执一次判死。**按调用的是哪个 API 分派,
    // 不按回执里有没有某个字段分派。**
    if (prev.kind !== "conversation") {
      throw new UsageError(
        `回执存在但它不是一段对话(kind=${JSON.stringify(prev.kind)}):${receiptPath}\n` +
        `同一个 id 先后当过节点和对话 —— 这两种产出形状不一样,不能互相复用。要重跑请加 force。`,
      );
    }
    if (!Array.isArray(prev.turns) || prev.turns.length === 0) {
      throw new UsageError(`回执说是对话且成功,却没有 turns[] —— 没有任何可比对的判据:${receiptPath}。要重跑请加 force。`);
    }
    // 逐轮的产出与指纹在回放时一轮一轮比对(见 replayTurn),这里只坐实整段的前提。
    // ⚠️ 下面那段节点级的产出校验对**对话**不适用(对话回执顶层压根没有 artifactPath),
    // 所以走 else 跳过它;而 write 的那几道闸(基线没漂、分支还在、diff 没被换)两档共用同一套,
    // 就在这个 if/else 之后 —— **不在这里提前 return**,那会变成"同一个结论两个出口"。
  } else {
  // 产出还在不在?回执说 ok 但文件被删/被截断的话,复用就是在骗下游。
  // 而且产出路径必须就是**本次算出来的**那个,不能听信回执里写的任意路径。
  if (prev.artifactPath !== artifactPath) {
    throw new UsageError(`回执里的产出路径与本次不一致(${prev.artifactPath} ≠ ${artifactPath}),不复用。`);
  }
  const st = statSafe(artifactPath);
  /* ⚠️ **不拿"零字节"当失败。** §5.6 有 `no-output` 这一档:「**已经确认**产出是零字节」——
        那是一次**合法的成功**(status 仍是 ok)。把它拒掉的后果是:同一个任务第二次
        **永远复用不了**,只能 `force` 覆盖上一次的结果 —— 而 `force` 会销毁旧产出。
        空文件的 sha256 是良定义的,下面那道内容指纹闸照常管得住"被换成另一份文件"。 */
  if (!st || !st.isFile()) {
    throw new UsageError(`回执说成功,但产出文件缺失:${artifactPath}。要重跑请加 force。`);
  }
  // 内容指纹:只查"非空"挡不住产出被**换成另一份非空文件**。
  // **这道闸不是可选的** —— 写成 `if (prev.artifactSha256)` 会让"回执里没这个字段"
  // (旧回执 / 字段被删 / 上次算哈希失败写了 null)**静默跳过校验**,等于没有这道闸。
  if (!/^[0-9a-f]{64}$/.test(prev.artifactSha256 || "")) {
    throw new UsageError(
      `回执里没有合法的产出内容指纹(artifactSha256),无法确认产出还是当初那份:${receiptPath}。要重跑请加 force。`,
    );
  }
  const nowSha = await sha256File(artifactPath);
  if (nowSha !== prev.artifactSha256) {
    throw new UsageError(`产出文件内容与回执记录的不一致(可能被改过或被覆盖):${artifactPath}。要重跑请加 force。`);
  }
  /* ⚠️ 上面查的是**这一轮最终那一份**。复用还会把**每一次尝试的审计原件**重新归档
        并当成"当初第 n 次写下的东西"发到 wire 上 —— 那些必须在这里一起坐实,
        否则被查的和被用的不是同一批文件。 */
  await assertAttemptsIntact(run, "main", prev.attempts, spec.reask,
    (m) => new UsageError(`${m}。要重跑请加 force。`));
  }
  // write 环节还要多一道:**指纹管不住基线漂移**。baseRef 通常是 "HEAD",
  // 它今天和上周解析到的是两个 commit,而 specHash 里只有字符串 "HEAD" —— 一模一样。
  // 不比对解析后的 baseCommit,就会把"对着上周代码改出来的结果"当成这次的答案。
  if (spec.access === "write") {
    const pw = prev.workspace;
    if (pw?.baseCommit !== run.baseCommit) {
      throw new UsageError(
        `回执可复用,但基线变了(旧 ${pw?.baseCommit ?? "(无记录)"} ≠ 今 ${run.baseCommit}):${receiptPath}\n` +
        `上次的改动是对着另一份代码做的,复用等于把过期的 diff 当成本次结果。要重跑请加 force。`,
      );
    }
    // write 环节的**交付物是分支和 diff**,不只是那段文字。只校验文字产出的 sha 就复用,
    // 等于宣称"上次那份改动还在" —— 而分支可能早被 `git branch -D` 掉了,diff 文件可能被换过。
    // 这道闸与 artifactSha256 是同一个道理,不能只做一半。
    //
    // ⚠️ **按 outcome 分派,而不是 `if (pw?.committed)`**。后者是同一族缺陷的第三次出现:
    // 字段缺失(null/undefined)时条件为假,**整段校验被静默跳过** —— 而字段缺失恰恰说明
    // 上次收尾出过问题,正是最该拦住的那种回执。这里两个分支都要求 outcome 是**明确的字面量**,
    // 缺字段 / 旧回执 / 手改过的回执一律落到最后那个 else,结构上没有"跳过"这条路可走。
    if (pw?.outcome === "delivered") {
      // 交付物齐全的那条路:分支、head、diff 三样逐个坐实,每一条都**不是可选的**。
      //
      // ⚠️ **先查字段齐不齐,再查对不对**,顺序不能反。缺字段说明上次收尾没走完;
      // 若先做等值比较,`diffPath: null` 会被报成"路径不一致",把"上次就没写完"
      // 说成"有人动过你的文件" —— 两种根因完全不同,报错指错方向比不报还费事。
      const missing = [];
      if (!pw.branch) missing.push("branch");
      if (!/^[0-9a-f]{40}$/.test(pw.headCommit || "")) missing.push("headCommit");
      if (!pw.diffPath) missing.push("diffPath");
      if (!/^[0-9a-f]{64}$/.test(pw.diffSha256 || "")) missing.push("diffSha256");
      // 「四样齐全」里的**改动清单**也要查:回执缺它/它不是数组,交付物同样是残的,
      // 而且下游拿它 `.map`/`.length` 会直接崩。`changesKnown:false` 更是自相矛盾
      // ——都不确知有没有改动了,凭什么说 delivered。
      if (pw.changesKnown !== true) missing.push("changesKnown");
      if (!Array.isArray(pw.filesChanged)) missing.push("filesChanged");
      if (missing.length) {
        throw new UsageError(
          `回执声称已交付(outcome=delivered),却缺字段:${missing.join("、")}(${receiptPath})\n` +
          `字段不全说明上次收尾那几步没走完 —— 交付物是残的,不复用。要重跑请加 force。`,
        );
      }
      // 字段齐了,再看是不是**本次**该有的那份 —— 不能听信回执里写的任意分支名/路径。
      const expectBranch = `graph/${runKey}/${spec.id}`;
      if (pw.branch !== expectBranch) {
        throw new UsageError(
          `回执里的分支名与本次算出来的不一致(回执 ${JSON.stringify(pw.branch)} ≠ 本次 ${expectBranch}):${receiptPath}。要重跑请加 force。`,
        );
      }
      if (pw.diffPath !== diffPath) {
        throw new UsageError(
          `回执里的 diff 路径与本次算出来的不一致(回执 ${JSON.stringify(pw.diffPath)} ≠ 本次 ${diffPath}):${receiptPath}。要重跑请加 force。`,
        );
      }
      const head = await git(["rev-parse", "--verify", `refs/heads/${pw.branch}^{commit}`], run.repoRoot);
      if (!head.ok) {
        throw new UsageError(`回执说改动在分支 ${pw.branch} 上,但那条分支已经不存在了:${receiptPath}。要重跑请加 force。`);
      }
      if (head.stdout.trim() !== pw.headCommit) {
        throw new UsageError(
          `分支 ${pw.branch} 已经不指向回执记的那个提交(回执 ${pw.headCommit} ≠ 现在 ${head.stdout.trim()}):${receiptPath}。要重跑请加 force。`,
        );
      }
      const dst = statSafe(pw.diffPath);
      // ⚠️ **不拿 `size === 0` 当失败。** HEAD 前进了但净改动为零(agent 建了空提交、
      // 或提交完又 revert)时 diff 本来就是 0 字节,而首跑那边判的是 delivered ——
      // 两边判据不一致就会出现"首跑成功、复用必拒"这种同一结局前后打架。
      // 「内容还是不是当初那份」由 sha 负责,它对空文件同样有效。
      if (!dst || !dst.isFile()) {
        throw new UsageError(`回执说导出过 diff,但文件不在了:${pw.diffPath}。要重跑请加 force。`);
      }
      if (await sha256File(pw.diffPath) !== pw.diffSha256) {
        throw new UsageError(`diff 文件内容与回执记录的不一致(可能被改过):${pw.diffPath}。要重跑请加 force。`);
      }
    } else if (pw?.outcome === "no-changes") {
      // "确知一个字都没改"也是一种合法的成功。它没有分支、没有 diff 可查,
      // 但**必须坐实当初真的探测成功过** —— 否则 `changesKnown:false`(探测失败、什么都没结论)
      // 也会被当成"没改动"复用掉,那正是第 1 轮修掉的那个错换了个地方重演。
      if (pw.changesKnown !== true || !Array.isArray(pw.filesChanged) || pw.filesChanged.length !== 0) {
        throw new UsageError(
          `回执说"没有改动",但它自己的记录对不上(changesKnown=${JSON.stringify(pw.changesKnown)}, ` +
          `filesChanged=${JSON.stringify(pw.filesChanged)}):${receiptPath}。要重跑请加 force。`,
        );
      }
    } else {
      throw new UsageError(
        `回执是 ok,但 write 环节的交付结论无法确认(workspace.outcome=${JSON.stringify(pw?.outcome)}):${receiptPath}\n` +
        `只有 "delivered"(改动已落到分支)与 "no-changes"(确知没改动)两种结论可以复用;\n` +
        `缺这个字段说明它是旧版回执或上次收尾没走完 —— 不复用。要重跑请加 force。`,
      );
    }
  }
  return { ...prev, reused: true };
}

/** 结束**这一轮**:定状态 +(非 ok 时)立刻冻结现场。
 *
 *  ⚠️ 它**不关会话、不收工作区、不写回执** —— 那三件是**环节级**的,归 `finalizeRun`。
 *  现场必须在这里就冻住:桥的 `textRef` 是**会话级的单一路径**,每轮结果覆盖同一个文件,
 *  延到整段收尾再取,拿到的就是**后面某一轮**的答案,却被标成"这一轮失败的现场"。 */
async function settleTurn(run, status, extra = {}) {
  const rec = run.turnRec;
  Object.assign(rec, extra);
  rec.status = status;
  if (status !== "ok") await run.saveScene(extra._sceneTag || status, rec, run.sceneDirFor(run.currentKey));
  delete rec._sceneTag;
  // 这一轮之后这个会话还能不能接着用。**由工具判,不靠回调自觉** ——
  // 破了这条的后果是两个 turn 在同一会话里并发,远超"回调写得不好"。
  // ⚠️ 只给对话加:`runNode` 的回执**不许多出新字段**,那是既有调用方与 reuseIfSame 的合同。
  if (run.isConv) {
    rec.sessionReusable = status === "ok" || status === "contract_error"
      || (status === "timeout" && rec.abortConfirmed === true);
  }
  // 这一轮的耗时。**在这里定而不是等 liveTurn 的 finally** —— 事件要带着它出去,
  // 而两处用的是同一个公式(`monoNow() - run.t0`),不会分家。
  rec.durationMs = Math.round(monoNow() - run.t0);
  /* ⚠️ **单轮节点的回执就是这一轮的 rec,而它的 `durationMs` 稍后会被节点收尾覆写成
        「节点耗时」**(那是另一个口径:含轮与轮之间回调在干别的事的时间)。
        于是 `projectMainTurn` 再去读它,投影出来的 `turns[0].durationMs` 就变成了节点耗时 ——
        与刚刚发出去的 `node:turn-settled.durationMs` **同名不同值**。
        两个时钟一旦在同一个字段名下混用,页面上"这一轮跑了多久"就永远对不上。
        所以这里把**轮的**那个值单独存一份。 */
  run.mainTurnMs = rec.durationMs;
  /* ⚠️ 同一个数在回执上也留一份:**复用**命中时,这次压根没跑轮,
        `run.mainTurnMs` 不存在,而要显示的恰恰是**当初那一轮**跑了多久。
        退回 `receipt.durationMs` 会拿到「当初那个**节点**从头到尾多久」——
        两者差着关会话与收尾那几步,而页面上它们叫同一个名字。 */
  rec.turnDurationMs = rec.durationMs;
  // ⚠️ 排在**释放执行闸之前**:定完 status、(非 ok 时)冻结完现场、归档完产出之后。
  //    这一条是**该轮产出与现场唯一的公布渠道** —— 一段 6 轮的对话在第 6 轮被强杀时,
  //    前 5 轮的产出全靠它,`node:settled` 那份 `turns[]` 永远不会来。
  /* ⚠️ **回执与 wire 在这一格上口径不同,而且是刻意的。**
        `rec.sessionReusable` 只给对话算(上面那个 `if (run.isConv)`)—— `runNode` 的**回执**
        不许多出新字段,那是既有调用方与 `reuseIfSame` 的合同。
        但 **wire 上这一格是必填的**,而 `liveTurn` 给 rec 的初值是 `false` ——
        直接发出去,**每一个正常完成的单轮节点**都会在事件流里说"这个会话不能再用了",
        与 §5.4 的判定表正好相反。所以这里**不改回执**,只在发事件时按表补上。 */
  if (run.viz) {
    await run.viz.turnSettled({ key: run.currentKey },
      run.isConv ? rec : { ...rec, sessionReusable: wireReusable(status, rec.abortConfirmed) });
  }
  return rec;
}

/**
 * ③ 一轮:(首轮)入场 → send → wait 切片 → 校验 → 不合格则打回重说(≤1) → 复制产出 → 算 SHA。
 *
 * **入场(拿闸 / 起钟 / 脏树复查 / worktree / open_session)挂在第一轮上**:
 * 顶层不一定有 `timeoutMs`(对话就没有),预算要到 `turn()` 才知道,所以拿闸那一刻必须已经有它。
 * `runNode` 只有一轮、且那一轮的 `timeoutMs` 就是 `spec.timeoutMs` ⇒ 因果顺序与今天逐字节相同。
 */
/** 宣布「这一轮被受理了」。**必须排在取任何闸之前** ——
 *  `node:turn` 已发、`node:started` 未发 这个区间**就是**「这一轮在等名额、一个字都还没发给 AI」,
 *  发晚了那段等待就从页面上消失了。
 *
 *  ⚠️ **幂等,且幂等标志挂在这一轮身上**:对话在 `liveTurn` 里先取对话闸,所以它要更早宣布;
 *  `runNode` 没有那道闸,由 `runTurn` 自己宣布。两处调用**同一个函数**,不留第二份实现。 */
async function announceTurn(run, t) {
  if (!run.viz || t.announced) return;
  t.announced = true;
  await run.viz.turnStarted(t);
}

/**
 * 用一条 `node:turn-settled{status:"not-started"}` 闭合「没能开始的那一轮」。
 *
 * ⚠️ **这条不变式(`node:turn` 与 `node:turn-settled` 一一对应)比"少一档 status"值钱。**
 * 少一个终态 = 那一轮永远悬着,页面只能把它合成 `abandoned`,于是"这个节点还在跑吗"整个判不出来。
 * ⚠️ **不为它新造事件类型** —— 多一个事件类型 = 页面多一条解析路径,而两条路径迟早只有一条被改。
 * ⚠️ 它**不进 `turns[]`**:那是复用判据,塞一条从没跑过的轮进去,下一次回放就会拿它去比对
 * 一份**根本不存在的产出**,把一张好回执判死。**事件流记"发生过什么",`turns[]` 记"哪几轮真跑了"
 * —— 两者都为真,页面必须同时接受。**
 */
async function closeNotStartedTurn(run, t, e) {
  if (!run.viz || !t?.announced) return;
  await run.viz.turnSettled(t, {
    status: "not-started",
    /* ⚠️ **不封口**(EVENTS.md §5.4 判定表):这一轮**一条消息都没发出去**,
          会话(如果已经有)根本没被碰过,工具也确实允许回调换一个 key 再来一轮。
          写成 false 就是在 wire 上宣布"这段对话已经毒化" —— 而毒化的判据正是
          「第一个 sessionReusable === false 的轮」,页面会据此说"从这里之后都不能再聊了"。
          (它不进 turns[],所以对那条派生没有影响;但事件流上这句话本身是假的。) */
    sessionReusable: true,
    artifactPath: null, scene: null, charCount: null,
    durationMs: Math.round(monoNow() - (run.t0 ?? monoNow())),
    error: e instanceof Error ? e.message : String(e),
  });
}

export async function runTurn(run, t) {
  const { bridge, spec, remaining, budget } = run;
  await announceTurn(run, t);
  // 这一轮往哪儿写。`runNode` 时 `turnRec` **就是回执本身**,于是下面几百行搬过来之后
  // 写进去的还是那张回执、字段一个不变;对话时它是 `turns[]` 里的那一条。
  const receipt = run.turnRec;
  const artifactPath = run.artifactPathFor(t.key);
  run.currentKey = t.key;
  // 推断边**记进回执**,不只是发进事件。
  // ⚠️ 少了这一步,**复用命中的节点整段推断边会凭空消失**:命中复用时一条 `node:turn`
  //    都不发,页面只能从 `node:settled.turns[].inferredDeps` 拿 —— 而那份来自回执。
  receipt.inferredDeps = t.inferredDeps ?? [];
  receipt.inferredDepsTruncated = t.inferredDepsTruncated ?? false;

  /** 此刻在飞的那次尝试(没有就是 null)。
   *
   *  ⚠️ **它的结局必须收在一处。** 这个循环里有十一个 `return await finish(...)`,
   *  在每一处各写一遍"顺手把这次尝试也记上"= 迟早漏一个,而漏掉的那一次会**永远悬着**:
   *  `node:attempt` 发过、`node:attempt-settled` 永远不来,页面只能把它显示成"还在跑"。
   *  所以下面把它挂进 `finish` —— **只要收了这一轮,就一定收了在飞的那次尝试。** */
  let liveAttempt = null;

  /** 轮的结局 → 这一次尝试的结局(§5.6 四档判定表)。 */
  const attemptStatusFor = (turnStatus, att) => {
    if (turnStatus === "ok") {
      // ⚠️ `no-output` 是「**已经确认**产出是零字节」,不是「没拿到」——
      //    没拿到走的是 `failed`(见下),两者的区别是一句真话与一句谎话。
      return att.byteCount === 0 ? "no-output" : "accepted";
    }
    if (turnStatus === "contract_error") return "rejected";
    // timeout / backend_failed / unknown 一律 failed。
    // ⚠️ 「拿不到 textRef」也落在这里而**不是** `no-output`:拿不到不等于对方没说话,
    //    运行时无法证明"它确实什么都没输出",只能证明"我取不回来"。
    return "failed";
  };

  /** 落下一次尝试的结局。**幂等** —— reask 那条路会先显式收一次,`finish` 再来就 no-op。 */
  const settleAttempt = async (att, status, reason = null) => {
    if (!att || att.settled) return;
    att.settled = true;
    att.status = status;
    att.durationMs = Math.round(monoNow() - att.t0);
    if (status === "rejected" && reason != null) att.rejectedReason = reason;
    if (run.viz) await run.viz.attemptSettled(t, att);
  };

  // 让搬过来的这几百行**一个字符都不用改**:里面仍然写 `finish(...)`。
  const finish = async (status, extra) => {
    if (liveAttempt) await settleAttempt(liveAttempt, attemptStatusFor(status, liveAttempt));
    return settleTurn(run, status, extra);
  };

  // --- 并发闸:到这里才排队。前面几步(体检/幂等)都是本地 I/O,不占桥的连接,不该被排队拖慢。
  const queuedFrom = monoNow();
  await bridge._gate.acquire();
  run.gateHeld = true;
  run.startClock(t.timeoutMs); // 预算从**真正开跑**这一刻起算,不含排队时间
  // 「**这一轮**拿到执行名额、开始烧预算」。⚠️ 不是「这个节点第一次开跑」——
  // 每一轮各自排队、各自起钟,所以一个节点有几轮就有几条。
  if (run.viz) await run.viz.turnGateAcquired(t, monoNow() - queuedFrom);

  // --- write 环节:建隔离工作区(只在首轮)
  if (!run.opened && spec.access === "write") {
    // ⚠️ 脏树**再查一次**。上面那次跑在排队之前,而扇出时一个环节可能在闸外等上几分钟;
    // 这中间用户完全可能动了主树。只查一次 = 拿一个几分钟前的结论给现在放行。
    // (基线 commit 不重新解析:一次运行里各环节钉在各自开跑前解析的那个 commit 上,
    //  重解析会让"排在后面"变成"基于另一份代码",反而更难解释。)
    await taggedPhase("preflight", () =>
      assertCleanBase({ repoRoot: run.repoRoot, spec, baseCommit: run.baseCommit, nodesDir: run.nodesDir }));
    const branch = await taggedPhase("workspace-setup", () => makeBranchName(run.repoRoot, run.runKey, spec.id));
    // 与 dirtyEntries 的排除项共用同一个常量 —— 两处写死会各自漂,漂了就变成"自己把主树弄脏、
    // 再被自己的脏树闸拦下"这种最难查的自伤。
    const wtPath = path.join(run.repoRoot, ...WT_ROOT_REL.split("/"), run.runKey, spec.id);
    // ⚠️ **发在 `git worktree add` 紧之前**。中断时它决定了页面说「**可能**已经开始创建,
    //    位置未确认」还是「**还没开始创建,不会有工作副本**」—— 这两句话必须相反:
    //    把后者并进前者,就是让用户去找一个可以证明不存在的目录。
    if (run.viz) await run.viz.workspaceIntent({ path: wtPath, branch, baseCommit: run.baseCommit });
    run.workspace = await taggedPhase("workspace-setup", () => createWorktree({
      repoRoot: run.repoRoot, wtPath, branch, baseCommit: run.baseCommit, force: spec.force,
    }));
    if (run.viz) await run.viz.workspaceCreated({ path: wtPath, branch, baseCommit: run.baseCommit });
    run.receipt.workspace = { ...run.workspace }; // 工作区是**环节级**的:N 轮共享一棵树、一条分支
  }

  /** 超时收场:**先 abort 打断这一轮**(桥的 wait 超时本身不打断,任务还在后台烧),
   *  abort 成没成如实记录 —— 不能未确认就在回执里写"已 abort"。 */
  const finishTimeout = async (why) => {
    if (run.sessionId) {
      try {
        const r = await bridge.callTool("agent_bridge_abort", { session_id: run.sessionId }, FINALIZE_BUDGET_MS / 2);
        // 同上:必须看返回里确实说打断了。`{aborted:false}` 意味着那一轮**还在后台跑**,
        // 谎报"已 abort"会让调用方以为现场已经静止。
        receipt.abortConfirmed = r?.aborted === true;
        if (!receipt.abortConfirmed) {
          receipt.diagnostics.push(`abort 未被确认(返回:${JSON.stringify(r).slice(0, 200)})——那一轮可能仍在后台运行`);
        }
      } catch (e) {
        receipt.abortConfirmed = false;
        receipt.diagnostics.push(`abort 失败(${e.name}):${e.message}`);
      }
    }
    return await finish("timeout", {
      error: `${why}(abort ${receipt.abortConfirmed === true ? "已确认" : receipt.abortConfirmed === false ? "未确认" : "无需执行"})`,
    });
  };

  try {
    // --- 开会话(只在首轮)
    if (!run.opened) {
      const openArgs = {
        agent: spec.agent,
        // write 环节跑在自己的 worktree 里,**不是**调用方给的 cwd —— 这就是隔离本身。
        // ⚠️ 隔离的是写:桥没有 OS 沙箱,有 shell 的环节技术上仍能 `../..` 读回主工作区。
        cwd: run.workspace ? run.workspace.path : spec.cwd,
        access: spec.access,
        // 结果走 textRef + cp,不把几 MB 正文塞进 JSON-RPC 管道
        return_mode: "ref",
        name: `graph-${spec.id}-${spec.specHash.slice(0, 6)}`,
      };
      if (spec.model) openArgs.model = spec.model;
      if (spec.effort) openArgs.effort = spec.effort;
      if (spec.roleFile) openArgs.append_system_prompt_file = spec.roleFile;

      if (remaining() <= 0) return await finish("timeout", { error: `还没开会话,总预算 ${t.timeoutMs}ms 就已耗尽` });
      let opened;
      try {
        // 一旦发出去,结局就默认按**不明**记 —— 只有下面两条路能把它改掉。
        run.openOutcome = "unknown";
        opened = await bridge.callTool("agent_bridge_open_session", openArgs, budget());
      } catch (e) {
        // 桥**明确回报**的错(BridgeReportedError)= 会话确定没建起来,后端确定没在跑;
        // 其余(本地 RPC 超时、断管)= 请求可能已经生效,只是我们不知道 —— 维持 "unknown"。
        if (e instanceof BridgeReportedError) run.openOutcome = "refused";
        throw e;
      }
      run.sessionId = opened?.session?.id ?? null;
      if (run.sessionId) run.openOutcome = "opened";
      run.logFile = opened?.session?.logFile ?? null;
      run.receipt.sessionId = run.sessionId; // 会话是**环节级**的:一段对话共用一个
      if (!run.sessionId) {
        // 桥没抛错、却也没给 session id —— 这不是"桥明确说后端不行",是我们不认识的返回形状。
        // 按 unknown 停下(可能后端其实开起来了,只是我们没拿到句柄)。
        return await finish("unknown", { error: `开会话返回里没有 session id(形状不认识):${JSON.stringify(opened).slice(0, 500)}` });
      }
      run.opened = true;
    }

    let attempt = 0;
    let lastReason = null;

    while (true) {
      if (remaining() <= 0) {
        return await finish("timeout", { error: `总预算 ${t.timeoutMs}ms 耗尽(还没来得及发第 ${attempt + 1} 轮)` });
      }

      // --- 发消息(默认非阻塞,立刻拿 ack)
      const msgArgs = { session_id: run.sessionId };
      if (attempt === 0) {
        // **发的就是算指纹时冻下来的那份字节**(不发 message_file 那条路径,见 freezePromptBody)
        msgArgs.message = t.promptBody;
      } else {
        msgArgs.message =
          `上一条回复不符合约定的输出格式:${lastReason}\n` +
          `请**只输出**符合要求的 JSON 本体,不要任何解释文字、不要 markdown 代码围栏。`;
      }
      if (t.schema) msgArgs.schema = t.schema;

      // ⚠️ **记账点锚死在这里**:剩余预算检查**通过之后**、`send_message` **紧之前**。
      //    一进 `while` 就写 `attempts[]` 会凭空造出一次**从未发送**的假尝试 ——
      //    上面那道 `remaining() <= 0` 的出口明说"还没来得及发第 N 轮",而那句话是真的。
      const n = attempt + 1;
      liveAttempt = {
        n,
        // 悲观默认:**任何**提前 return 都会留下一条 `failed`,而不是一条永远悬着的尝试。
        status: "failed",
        inputSha256: sha256Text(msgArgs.message),
        inputRef: null,          // 只有开了 viz 才有归档可指(见 §3.1a 的隐私口径)
        artifactPath: null, artifactSha256: null, charCount: null, byteCount: null,
        rejectedReason: null, durationMs: null,
        settled: false, t0: monoNow(),
      };
      receipt.attempts.push(liveAttempt);
      // 先把输入归档、再发引用它的事件 —— 顺序反了页面会读到 404 并当成"文件丢了"。
      if (run.viz) await run.viz.attemptStarted(t, liveAttempt, msgArgs.message);

      const ack = await bridge.callTool("agent_bridge_send_message", msgArgs, budget());
      // 必须**明确**被接收。桥对 send 的回执里 accepted 应为 true;拿到别的形状说明我们不认识
      // 这个返回 → 按 unknown 停下,不猜。
      if (ack && ack.accepted === false) {
        return await finish("backend_failed", { error: `后端拒收消息:${JSON.stringify(ack).slice(0, 500)}` });
      }
      if (!ack || ack.accepted !== true) {
        return await finish("unknown", { error: `send 返回了不认识的形状(无法确认任务是否已开始):${JSON.stringify(ack).slice(0, 500)}` });
      }

      // --- 短切片 wait 循环(超时不中断 turn,任务继续在后台跑,再 wait 即可接着等)
      let settled = null;
      let nonTerminalSettles = 0; // 桥说"结束了"但状态仍是非终态的次数(后端自己多轮),记进回执供事后看
      while (!settled) {
        const remain = remaining();
        if (remain <= 0) break;
        // 本地 RPC 预算必须**略大于**告诉桥的 timeout_ms,否则两个计时器同时到点、本地那个先响,
        // 会把一次正常的「桥回 timedOut」变成 RpcTimeoutError。容差**含在**总预算里,不额外相加。
        const tolerance = Math.min(2000, remain / 2);
        const slice = Math.min(WAIT_SLICE_MS, remain - tolerance);
        if (slice <= 0) break; // 剩下的时间不够做一次有意义的等待了
        // slice 被总预算卡住(而不是被 5 分钟切片上限卡住)时,这一次的本地超时就等于"环节预算用完"
        run.rpcDeadlineFromBudget = slice < WAIT_SLICE_MS;
        const w = await bridge.callTool(
          "agent_bridge_wait",
          { session_ids: [run.sessionId], mode: "all", timeout_ms: Math.max(1, Math.floor(slice)) },
          slice + tolerance,
        );
        if (w?.timedOut) {
          const snap = w.pendingSnapshots?.[0];
          if (snap && snap.contextUsage !== undefined) receipt.contextUsage = snap.contextUsage ?? null;
          // 活进度。**快照取不到就不发**;节流 5 秒 —— 它是唯一允许整条丢的事件。
          // ⚠️ 传的是**本轮**第几次尝试(1-based) —— 打回重说时,在途正文要贴到对的那一次上。
          if (run.viz) await run.viz.progress(t, snap, monoNow(), attempt + 1);
          continue; // 还在跑,接着等
        }
        const got = w?.results?.[0] ?? null;
        if (!got) {
          return await finish("unknown", { error: `wait 返回了没预料到的形状:${JSON.stringify(w).slice(0, 800)}` });
        }
        // 桥说"这一轮结束了",可它同时报会话还在 `running`/`starting`。两句话对不上时以**状态**为准:
        // 这不是"不认识的状态",而是**认识的非终态** —— 认识的非终态该做的事是接着等,不是放弃。
        //
        // 为什么会对不上(真机根因,omp + deepseek-v4-pro 实测):后端把一次委托拆成多个内部 turn,
        // 干完一段就 turn_end、紧接着自己 turn_start 继续。桥在 turn_end 处就认为可以收结果了,
        // 而它是**先判定已结束、再 await 去取正文**的(waitSessions 的 summarize),后端恰好在那个
        // await 窗口里重开了下一轮。此时收下的正文只是刚吐出的头几个字符 —— 当成答案就是**假成功**。
        if (got.status === "running" || got.status === "starting") {
          nonTerminalSettles++;
          if (nonTerminalSettles === 1) {
            receipt.diagnostics.push(
              `桥报「已结束」但会话仍是 "${got.status}"(后端在自己开下一轮),按非终态继续等`,
            );
          }
          // 这种 wait 是**立刻**返回的,不歇一下会变成空转打桥。歇一小会儿再问,节奏与桥自己的轮询一致。
          // 歇多久也**夹在总预算里**:否则最后一次歇息会让实际耗时越出 timeoutMs 最多 250ms,
          // 和"timeoutMs 是硬上限"这个说法对不上(T9 立的就是这条规矩)。
          await sleep(Math.min(250, Math.max(0, remaining())));
          continue;
        }
        settled = got;
      }

      // --- 总时长用尽:先 abort 打断这一轮(wait 超时本身不打断,任务还在后台烧),再收尾。
      //     abort 成没成要**如实记录**,不能未确认就在回执里写"已 abort"。
      if (!settled) return await finishTimeout(`超过 ${t.timeoutMs}ms 未完成`);

      if (settled.contextUsage !== undefined) receipt.contextUsage = settled.contextUsage ?? null;
      if (settled.textRef) run.lastTextRef = settled.textRef;

      // 「跑完了」在桥这里表现为会话回到 idle。**只认列举出来的终态**:
      // failed/closed/gone = 桥明确回报的失败;idle = 正常收场;其它(如 running 漏出来)= 不认识 → unknown。
      if (settled.gone || settled.status === "failed" || settled.status === "closed") {
        return await finish("backend_failed", {
          _sceneTag: `turn-${settled.status}`,
          error: `会话以 ${settled.status} 收场:${settled.error ?? settled.lastError ?? "(无错误详情)"}`,
        });
      }
      // 跑到这里 status 只可能是 idle,或者一个我们**压根没见过**的值(running/starting 已在循环里当非终态处理了)
      if (settled.status !== "idle") {
        return await finish("unknown", {
          error: `wait 说这个会话已结束,但状态是不认识的 "${settled.status}"(不敢当成功):${JSON.stringify(settled).slice(0, 500)}`,
        });
      }
      if (nonTerminalSettles > 0) {
        receipt.diagnostics.push(`后端自己多开了 ${nonTerminalSettles} 轮,等到真正结束才收结果`);
      }

      // --- 结果落盘(字节直传;必须在 close_session 之前 —— 关会话会删 textRef)
      const attemptPath = run.attemptArtifactPathFor(t.key, liveAttempt.n);
      /** 把刚落到该轮 `artifactPath` 的那份字节,再留一份**本次尝试的审计原件**。
       *
       *  ⚠️ **落在 `readFileSync` 之前**是刻意的:源码里存在"文件已经复制成功、后续本地处理
       *  才失败"这个窗口(读不回来 → 判 `unknown`)。在那个窗口里磁盘上**确实躺着**一份证据,
       *  这一次尝试的 `output` 就该是 `present`;把它一律写死成 `unavailable`,
       *  等于把一份**已经保住的**证据说成没保住。 */
      const keepAudit = () => { if (copyBytes(artifactPath, attemptPath)) liveAttempt.artifactPath = attemptPath; };

      let text = null;
      if (settled.textRef && copyBytes(settled.textRef, artifactPath)) {
        keepAudit();
        try { text = fs.readFileSync(artifactPath, "utf8"); }
        catch (e) { receipt.diagnostics.push(`产出已复制但读不回来:${e.message}`); }
      }
      if (text === null) {
        // 拿不到 textRef:再 result 一次(不设 max_chars 拿全文)
        try {
          const r = await bridge.callTool("agent_bridge_result", { session_id: run.sessionId }, budget());
          if (r?.textRef) {
            run.lastTextRef = r.textRef;
            if (copyBytes(r.textRef, artifactPath)) {
              keepAudit();
              try { text = fs.readFileSync(artifactPath, "utf8"); } catch {}
            }
          }
        } catch (e) { receipt.diagnostics.push(`补取 result 失败(${e.name}):${e.message}`); }
      }
      if (text === null) {
        return await finish("unknown", { error: "本轮完成了,但取不到任何答案正文(textRef 拿不到或复制失败)" });
      }
      receipt.artifactPath = artifactPath;
      receipt.charCount = typeof settled.charCount === "number" ? settled.charCount : text.length;
      receipt.byteCount = typeof settled.byteCount === "number" ? settled.byteCount : Buffer.byteLength(text, "utf8");
      receipt.artifactSha256 = await sha256File(artifactPath);
      // 算不出产出的哈希 = 刚写下的文件读不回来,本地落盘完整性有问题。
      // 这时不能报 ok:否则会写出一张**没有指纹**的成功回执,让下次复用绕过内容校验。
      if (!receipt.artifactSha256) {
        return await finish("unknown", { error: `产出已落盘但算不出内容指纹(读不回来):${artifactPath}` });
      }
      // 这一次尝试的产出与该轮 `artifactPath` 是**同一份字节**(上面 `keepAudit` 就是从它拷的),
      // 所以指纹直接沿用 —— 再算一遍只是把同样的字节读第二次。
      liveAttempt.charCount = receipt.charCount;
      liveAttempt.byteCount = receipt.byteCount;
      if (liveAttempt.artifactPath) liveAttempt.artifactSha256 = receipt.artifactSha256;

      // --- 契约校验:codex 走后端强制(桥回 json / schemaError),其余四家走弱检查
      let bad = null;
      if (t.schema) {
        if (settled.schemaError) bad = `codex 强制格式未通过:${settled.schemaError.error ?? JSON.stringify(settled.schemaError)}`;
      } else if (t.outputShape) {
        const chk = weakCheck(text, t.outputShape);
        if (!chk.ok) bad = chk.reason;
      }

      if (!bad) return await finish("ok");

      // 不合格:按声明打回重说一次,再不行就停(**绝不无限重试**)
      // ⚠️ 两条路都要**带着原因**收掉这一次尝试 —— `rejectedReason` 是"当初为什么判它不合格"
      //    的唯一记录,而它正是「打回重说」这个自动决策的依据。靠 `finish` 兜底会丢掉这句话。
      await settleAttempt(liveAttempt, "rejected", bad);
      if (attempt < t.reask && remaining() > 0) {
        receipt.diagnostics.push(`第 ${attempt + 1} 次输出不合格,打回重说:${bad}`);
        receipt.reaskCount = attempt + 1;
        lastReason = bad;
        attempt++;
        liveAttempt = null; // 这一次已经收了;下一圈会新建一条
        continue;
      }
      return await finish("contract_error", {
        error: bad + (remaining() <= 0 && attempt < t.reask ? "(预算已耗尽,没能打回重说)" : ""),
      });
    }
  } catch (e) {
    if (e instanceof UsageError) throw e;
    const detail = `${e?.name || "Error"}:${e?.message || String(e)}`;

    // **失败分类的要害**,三档:
    // ① 桥「明确回报」的错 → backend_failed(=调用方可安全换人重跑)。
    // ② 本地 RPC 超时**且总预算已耗尽** → 就是这个环节的 timeout(不是什么神秘状态):
    //    我们给的时间用光了,该走 abort + 保现场的超时路径。
    // ③ 其余(总预算还有余量却不响应、管道断)→ unknown:分不清后端到底干没干,
    //    停下等人,**绝不**报成可重试的失败去诱导重跑。
    if (e instanceof BridgeReportedError) {
      return await finish("backend_failed", { error: detail });
    }
    if (e instanceof RpcTimeoutError && (run.rpcDeadlineFromBudget || remaining() <= 0)) {
      return await finishTimeout(`总预算 ${t.timeoutMs}ms 耗尽(${detail})`);
    }
    return await finish("unknown", {
      error: `${detail}(无法确认后端是否已经开始/完成了工作,故按未知状态停下)`,
    });
  }
}

/**
 * ④ 收尾(**环节级**):关会话 → 收工作区 → 定顶层 status → 原子写回执。顺序不能换。
 *
 * 现场已经在 `settleTurn` 里冻过了,这里**不再补取**。
 */
export async function finalizeRun(run, { callbackError = null, callbackThrew = false } = {}) {
  const { spec, receipt } = run;
  if (run.isConv) {
    receipt.turns = run.turns;
    receipt.poisonedAfter = run.poisonedAfter;
    receipt.status = worstTurnStatus(run.turns);
    // ⚠️ 判据是**抛没抛**,不是"抛出来的东西真不真"。写成 `if (callbackError)` 时
    // `throw null` / `throw 0` / `throw ""` 会让这段整个跳过 —— 于是一次崩掉的编排
    // 落下一张 `status:"ok"` 的回执,下次 reuseIfSame 还会命中它。
    if (callbackThrew) {
      const detail = describeThrown(callbackError);
      if (receipt.status === "ok") {
        // 全轮都成了、回调自己炸了 —— 绝不能落一张 ok 回执:那等于把一次崩掉的编排缓存起来,
        // 下次 reuseIfSame 还会命中它。
        receipt.status = "callback_error";
        receipt.error = detail;
      } else {
        // 轮先挂了、回调多半是因此才炸的(`r1.text.trim()` 之类)——轮的结局更接近根因,
        // 不许被 callback_error 盖掉。⚠️ **但这件事不许因此消失**:进程一退,
        // 回执里就再也没有"回调也炸了"这个事实。
        receipt.diagnostics.push(`回调抛出异常(顶层结局已由第 ${receipt.status} 的那一轮决定):${detail}`);
      }
    }
  }
  // 这一轮**自己**的结局。下面工作区那道闸可能把 receipt.status 改写成 unknown,
  // 而回执写失败时报的"原始结局"说的是改写**之前**那个 —— 先存下来,别事后去读已经被改过的值。
  const turnStatus = receipt.status;
  // ⚠️ **收尾自己出错也绝不能把异常抛出去。** 旧版所有 `finish(...)` 都在那个大 catch 里面,
  // 收尾抛错会被接住、再走一次 `finish("unknown")`,最终**仍然落一张回执**。
  // 抽取之后 finalize 跑在 catch 外面,不包这一层就成了"抛异常 + 没有回执" ——
  // 既改了 `runNode` 的既有行为,也破了"只有用法错才抛"这条对外合同。
  // (`finalizeWorktree` 是这里唯一真会抛的一步:close 与 writeAtomic 各自内部已经接住了。)
  try {
  await run.closeSession();
  // 收工作区排在**关会话之后**:后端进程还活着时它可能还握着 worktree 里的文件句柄,
  // Windows 上那会让 `git worktree remove` 直接失败。
  // **不受 remaining() 约束** —— 环节可能正是因为预算耗尽才走到这里,
  // 而"把已经改出来的代码保住"不能因为超时就放弃。
  if (run.workspace && !run.workspaceFinalized) {
    run.workspaceFinalized = true;
    const fin = await finalizeWorktree({
      repoRoot: run.repoRoot, ws: run.workspace, diffPath: run.diffPath, nodeId: spec.id, runKey: run.runKey,
      // 「后端确定不会再往这棵树里写了」。三种情况成立:关会话被确认、请求压根没发出去、
      // 或桥**明确回报**开不起来(后者最常见:后端没装/起不来;若也按"关闭未确认"保留,
      // 每次失败都白留一棵空工作树和一条空分支,越攒越多)。
      // ⚠️ 判据是 openOutcome 而**不是** `sessionId === null` —— 后者把"桥说没建成"
      // 和"我们没拿到句柄但它可能已经建成了"混成一谈,于是在后端可能还活着时删树。
      closeConfirmed: receipt.closeConfirmed === true
        || run.openOutcome === "not-attempted" || run.openOutcome === "refused",
    });
    const { notes, ...rest } = fin;
    run.workspace = rest;
    receipt.workspace = rest;
    for (const n of notes) receipt.diagnostics.push(`工作区:${n}`);
    // **write 环节的交付物不只是那段文字,还包括"改动确实落到了分支上"。**
    // 有改动却没提交、或压根不知道有没有改动 —— 这时报 ok,调用方(以及 reuseIfSame 的
    // "只复用 ok"那道闸)就会把一个**没有产出的 write 环节**当成功,并在此之上继续往下建。
    // 降级成 unknown 而不是某种失败:我们确实不知道后端干了多少,按纪律停下等人、不诱导重跑。
    // (不补 saveScene:会话已关,现场三件套只能取到残缺的一份;真正的证据是**被保留下来的
    //  worktree 与分支**,路径就在 diagnostics 里。)
    // 判据只有一个:finalizeWorktree 给出的 outcome。**不在这里拿 committed/filesChanged
    // 自己再推一遍** —— 同一件事在两处各推一次,迟早推出两种结论(第 3 轮复审就是这么被抓到的:
    // 提交成功但 diff/head 没拿到时,这里按 `committed` 判成功,回执里却缺字段)。
    // ⚠️ **不限于原本是 `ok` 的情况。** `backend_failed` / `timeout` 在本工具的契约里是
    // "可以安全换个人重跑"的档;而重跑通常带 `force`,`force` 会把**正因为说不清才被保留下来**的
    // 那棵工作树连同分支一起删掉。工作区状态不明时宣称"可安全重跑",等于亲手安排了一次数据销毁。
    // 所以只要 outcome 不明,顶层一律按 unknown(停下等人),原始结局记进 diagnostics 不丢信息。
    if (rest.outcome !== "delivered" && rest.outcome !== "no-changes") {
      const was = receipt.status;
      receipt.status = "unknown";
      if (was !== "ok") {
        receipt.diagnostics.push(
          `原始结局是 ${was},但工作区状态无法确认 —— 已按 unknown 处理(${was} 会被理解成"可安全重跑",` +
          `而重跑加 force 会删掉这棵保留下来的工作树)`,
        );
      }
      receipt.error = `${receipt.error ? `${receipt.error};` : ""}write 环节的交付物没能确认落到分支上` +
        `(outcome=${rest.outcome})——工作区已保留:${rest.path},详见 diagnostics`;
    }
  }
  } catch (e) {
    // 分不清收尾走到哪一步就断了 ⇒ 按 unknown 停下等人,**绝不**报成"可安全重跑"
    // (重跑常带 force,而 force 会把可能刚保留下来的工作树连同分支一起删掉)。
    receipt.status = "unknown";
    receipt.error = `收尾时出错(${e?.name || "Error"}:${e?.message || String(e)});原始结局=${turnStatus}` +
      (receipt.error ? `;${receipt.error}` : "");
    receipt.diagnostics.push(`收尾异常:${e?.stack || e}`.slice(0, 2000));
  }
  receipt.endedAt = nowIso();
  // ⚠️ 用**环节**的起点(首轮起钟那一刻),不是最后一轮的 t0 —— 多轮时后者只算得出最后一轮的耗时。
  receipt.durationMs = Math.round(monoNow() - (run.nodeT0 ?? run.t0));
  try {
    writeAtomic(run.receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  } catch (e) {
    // 回执落盘是成功的**前提**:回执写不下去,下一次就无法靠它做幂等判断。
    // 绝不能"退出 0 但没有回执"。
    receipt.status = "unknown";
    receipt.error = `回执写入失败(${e.message});原始结局=${turnStatus}${receipt.error ? `;${receipt.error}` : ""}`;
  }
  // ── viz:节点终态。**排在归档 receipt.json 写完之后**(见 viz.settled 里那一步)。
  if (run.viz) {
    // `diff` 三态皆可:read 节点、以及 `outcome === "no-changes"` 的 write 节点 → not-applicable。
    // ⚠️ 这两种是**先天不适用**,不是"给不出" —— 标成 unavailable 就是把"从来不适用"
    //    谎报成"本该拿得到、现在拿不到"。
    let diffAsset = NOT_APPLICABLE;
    const wsOutcome = receipt.workspace?.outcome;
    if (spec.access === "write" && wsOutcome !== "no-changes" && receipt.workspace?.diffPath) {
      diffAsset = await run.viz.putDiff(receipt.workspace.diffPath);
    }
    // `outcome` 是 write 节点交付结论的**唯一权威判据**,页面不得自己拿 committed/filesChanged 再推一遍。
    if (spec.access === "write") receipt.outcome = wsOutcome ?? "unknown";
    receipt.execution = run.reusedReceipt ? "reused" : "fresh";
    const summaries = toTurnSummaries(run.isConv ? run.turns : [projectMainTurn(run, receipt)], run.viz);
    await run.viz.settled(receipt, summaries, diffAsset);
    vizCount(run.bridge, receipt.status, false);
  }
  return receipt;
}

/**
 * 本地闸拒绝 / 准备失败 → `node:rejected`。
 *
 * ⚠️ **只在「这个节点确实以抛异常结束、并且没有写出回执」那一刻发一条。**
 * 只要有一轮真的跑起来过,节点就一定写回执、一定以 `node:settled` 收场 ——
 * 哪怕后面某次 `turn()` 又抛了校验错、哪怕回调自己炸了(那时是 `status:"callback_error"`)。
 * **同一个 `UsageError`,落在哪一层取决于「这个节点有没有回执」。**
 */
async function rejectNode(bridge, viz, e, fallbackPhase = "lock") {
  if (!viz || !(e instanceof UsageError)) return;
  // ⚠️ `phase` 与 `error` 是**两个独立的事实**:`error` 恒是抛出去那个异常的消息(根因优先),
  //    `phase` 是"哪一关拦下的"。渲染时不许互相推断,这里也不许互相推断。
  await viz.rejected(e.phase || fallbackPhase, e);
  vizCount(bridge, "rejected");
}

/**
 * 复用命中的节点也要有终态,否则页面上它永远停在 `node:observed`。
 *
 * ⚠️ **归档时机在复用闸之后**:那道闸刚刚逐项坐实了每一轮的产出 sha、diff sha、
 * 基线 commit 与分支现状,所以归档下来的是**刚被验证过**的东西。
 */
async function emitReusedSettled(run) {
  const prev = run.reusedReceipt, viz = run.viz;
  const turnRecs = Array.isArray(prev.turns) ? prev.turns : [projectMainTurn(run, prev)];
  for (const tr of turnRecs) {
    /* ⚠️ **逐次尝试各归档一份,不是只归档"最后那一份"。**
          canonical 区里**每次尝试各存一份**审计原件(`attemptArtifactPathFor`:
          `<id>.a<n>.md` / `<id>.t-<key>.a<n>.md`)——v2 起第一次的产出**不再**被第二次覆盖。
          所以一轮 `#1 rejected / #2 accepted` 复用回来时,**两份原件都还在磁盘上**。
          早先这里只归档 `tr.artifactPath`(该轮最终那一份)、把其余几次标成"只剩指纹",
          等于**否认一份确实存在的证据** —— 而"被打回的那一次到底写了什么"正是复审时最想看的东西。
          ⚠️ 更早的一版还把它无条件塞给 `attempt 1`,于是页面会在**被打回的那次**下面
          挂出**最终正确答案**:两条信息都错,还互相印证。 */
    /* ⚠️ **按 `n` 排一遍再走,不吃数组的原始顺序。** 复用闸已经把 `n` 定死成 1..k 严格
          递增,所以正常情况下两者一致;这里再排一次是**纵深防御** —— 顺序一旦错位,
          "最后一次"就会指向被打回的那一份,而它会一路当成该轮产出与顶层交付物挂出去。 */
    const atts = [...(tr.attempts || [])].sort((x, y) => (x.n ?? 0) - (y.n ?? 0));
    for (const a of atts) {
      if (!a.artifactPath) continue;
      await viz.putTurnOutput(tr.key, a.artifactPath, a.n);
    }
    /* 该轮的最终产出 **恒等于最后那一次尝试的产出**(闸已坐实:收在 ok 的轮,末次必是
       accepted / no-output)。它自己那份审计原件够不着时,退回 `tr.artifactPath` 这一份
       整轮产出,并**挂在它名下**。

       ⚠️ **判据必须是"最后那一次有没有原件",不是"有没有任何一次有原件"。**
          早先这里写的是 `if (lastN === null && tr.artifactPath)` —— 只要**任意一次**归档到了,
          回退就整个不跑。于是把**末次(accepted)那一项的 `artifactPath` 单独删掉**、
          留着前一次 rejected 的:闸门放行(缺路径是允许的),归档器只归档了 rejected 那一份,
          而"该轮产出 = 最后一份成功复制的 attempt 产出"于是选中了**被打回的那一稿** ——
          它一路升成轮产出与顶层交付物,不变式③按同一口径选中同一项,**两边一起假绿**。
          **一个字段被删掉,一份被否决的草稿就成了交付物。**
          (这也推翻了"删字段只能让证据消失、不能让证据变假"那句话 —— 见 DRIFT §9。) */
    const last = atts.length ? atts[atts.length - 1] : null;
    if (last && !last.artifactPath && tr.artifactPath) {
      await viz.putTurnOutput(tr.key, tr.artifactPath, last.n);
    } else if (!last && tr.artifactPath) {
      await viz.putTurnOutput(tr.key, tr.artifactPath, 1);
    }
    /* ⚠️ 复用一张**原运行没开 viz** 的回执时,输入原文当初压根没落盘,只剩指纹。
          那是**当时的选择,不是故障** —— `fingerprint-only` 这个 code 没有任何"出错了"的含义。
          ⚠️ 产出同理:**只对当初真的没留下原件的那几次**这么标(`!a.artifactPath`)。
          留空则会被投影成 `source-missing`——那句话是"从来没有过产出",而事实是
          "有过,只是这一层够不着"。两者对复审的人是完全不同的指示。 */
    /* ⚠️ 输入:**attempt 1 能找回来,n≥2 只剩指纹**(§5.9)。
          早先这里只有"没有 inputRef 就标 fingerprint-only"这一句,于是
          **每一次输入都成了「只剩指纹」** —— 连 attempt 1 那份这一次刚冻结好、
          就躺在归档里的正文也不例外。 */
    const body = run.replayBodies?.get(tr.key) ?? run.spec.promptBody;
    for (const a of atts) {
      if (a.n === 1) await viz.recoverAttemptInput(tr.key, 1, body, a.inputSha256);
      else viz.markFingerprintOnly(tr.key, a.n);
      if (!a.artifactPath) viz.markOutputFingerprintOnly(tr.key, a.n);
    }
  }
  let diffAsset = NOT_APPLICABLE;
  const wo = prev.workspace?.outcome;
  if (run.spec.access === "write" && wo !== "no-changes" && prev.workspace?.diffPath) {
    diffAsset = await viz.putDiff(prev.workspace.diffPath);
  }
  // ⚠️ `execution:"reused"` 是**正交标记,不是 status** —— 复用返回的就是旧回执的 `status:"ok"`。
  const receipt = { ...prev, execution: "reused" };
  if (run.spec.access === "write") receipt.outcome = wo ?? "unknown";
  await viz.settled(receipt, toTurnSummaries(turnRecs, viz), diffAsset);
  // `reused` 是 `ok` 的子集:两个桶都要 +1。
  vizCount(run.bridge, prev.status, true);
}

/**
 * §5.4 那张**封闭**判定表。
 *
 * ⚠️ 早先这里硬编码 `false` —— 于是**每一个正常完成的单轮节点**都在 wire 上说
 * "这个会话不能再用了"。合同对这一档写得很死:`ok` 与 `contract_error` 都是 `true`
 * (后端好好的,只是答得不合格)。
 * ⚠️ 表里 `timeout` 分两行(abort 被明确回报打断 ⇒ true,没被确认 ⇒ false),
 * 而**回执上没有这个信号**。拿不准时只能取 `false` —— 那句话的意思是
 * "那一轮可能还在后台跑,别再往这个会话里发",**误报为 true 会导致一次真正的并发发送**,
 * 误报为 false 只是保守。方向不对称,所以往保守那边取。
 * ⚠️ 另外:`runNode` **不是对话节点**,页面那条"封口"派生前面有一道闸
 * (`node:observed.prompt.state === "not-applicable"` 才是对话),所以这个值在页面上
 * 根本不会被读成"对话被封口"——它只是把合同要求的事实如实写出来。
 */
function wireReusable(status, abortConfirmed) {
  if (status === "ok" || status === "contract_error" || status === "not-started") return true;
  if (status === "timeout") return abortConfirmed === true;   // 表里这一档分两行
  return false;                                               // backend_failed / unknown
}

/** `runNode` 的回执 → 那一轮的记录。**投影,不是第二份实现**:
 *  单轮节点的回执顶层字段**就是** `main` 这一轮的字段(§2.2 的兼容投影)。 */
function projectMainTurn(run, receipt) {
  return {
    key: "main",
    status: receipt.status, sessionReusable: wireReusable(receipt.status, receipt.abortConfirmed),
    turnSpecHash: run.spec.specHash,
    artifactPath: receipt.artifactPath, charCount: receipt.charCount,
    /* ⚠️ `receipt.durationMs` 在**节点收尾**时会被覆写成「节点耗时」(含关会话、收尾那几步),
          所以这里优先用轮自己那个读数。
          ⚠️ 复用路径没有 `run.mainTurnMs`(这次压根没跑轮),但**旧回执里那一轮的耗时**
             才是要显示的东西 —— 退回 `receipt.durationMs` 会把"原来那一轮跑了多久"
             显示成"原来那个节点从头到尾多久"，两个口径差着关会话与收尾的时间。 */
    durationMs: run.mainTurnMs ?? receipt.turnDurationMs ?? receipt.durationMs,
    attempts: receipt.attempts || [],
    /* ⚠️ **本次重算的那份优先**(§5.9)。`run.spec.inferredDeps` 是 `normalizeSpec` 刚用
          同一个算法扫这一次的提问正文得到的,而 specHash 已经比对过 ⇒ 正文与原运行相同。
          退回 `receipt.` 那份只是为了兼容"这次压根没扫"(理论上不会发生)。 */
    inferredDeps: run.spec.inferredDeps ?? receipt.inferredDeps ?? [],
    inferredDepsTruncated: run.spec.inferredDepsTruncated ?? receipt.inferredDepsTruncated ?? false,
  };
}

/** 一段对话的顶层结局 = **各轮里最严重的那一个**。
 *
 *  ⚠️ 既不是"第一个非 ok"也不是"最后一轮",两者都会遮住真相:
 *   - 取第一个:第 1 轮 `contract_error`(后端好好的、可以改改 prompt 重跑)会遮住第 2 轮
 *     那个 `abortConfirmed:false` 的超时(**那一轮可能还在后台跑**)—— 顶层报成"安全可重跑"。
 *   - 取最后一个:"第 2 轮挂了、第 3 轮碰巧成了"会报成功。
 *  取最严重的一次把两个方向一起修掉,而且 **N=1 时与今天恒等** ⇒ `runNode` 零变化。
 *
 *  严重度序**直接用仓里已有的 `STATUS_EXIT`**,不另发明一套:
 *  ok(0) < contract_error(2) < backend_failed(3) < timeout(4) < unknown(6)。
 *  认不出来的状态一律按最严重处理(**不认识 ≠ 没事**)。 */
function worstTurnStatus(turns) {
  const sev = (s) => (Object.prototype.hasOwnProperty.call(STATUS_EXIT, s) ? STATUS_EXIT[s] : STATUS_EXIT.unknown);
  let worst = "ok";
  for (const t of turns) if (sev(t.status) > sev(worst)) worst = t.status;
  return worst;
}

/** 无条件释放这一次占用的东西。**一件都不许漏** —— 漏了下一个同 id 的环节永远起不来。 */
export async function releaseRun(run) {
  // ⚠️ 建了 worktree 却没走到 finalizeRun() 的路径(UsageError 抛在中途、或桥本身崩了):
  // 这里必须兜底,否则每次异常都在磁盘上留一个工作树和一条分支,越攒越多。
  // 与 finalizeRun() 里那次是幂等关系:finalize 成功后 workspaceFinalized=true,不会重复删。
  if (run.workspace && !run.workspaceFinalized) {
    run.workspaceFinalized = true;
    // 走到这条兜底路径 = 没经过 finalizeRun(),会话大概率没被正常关过 → 按"关闭未确认"对待,
    // **保留**工作区不删。这里宁可留脏也不能删掉可能还在被写的树。
    try {
      run.workspace = await finalizeWorktree({
        repoRoot: run.repoRoot, ws: run.workspace, diffPath: run.diffPath,
        nodeId: run.spec.id, runKey: run.runKey, closeConfirmed: false,
      });
    } catch {}
  }
  if (run.gateHeld) { run.bridge._gate.release(); run.gateHeld = false; }
  if (run.scopeHeld) { run.bridge._scopeGate.release(); run.scopeHeld = false; }
  if (run.active && run.activeKey) run.active.delete(run.activeKey);
  try { if (run.lockFd !== null) fs.closeSync(run.lockFd); } catch {}
  run.lockFd = null;
  try { fs.rmSync(run.lockPath, { force: true }); } catch {}
}

/**
 * 跑一个环节的完整生命周期,一步不落:
 *   开会话 → 发任务(非阻塞) → 短切片 wait 循环到 deadline → cp 结果 → 校验 → (必要时打回重说一次) → 关会话 → 写回执
 *
 * **不为环节失败抛异常**,返回带 status 的回执:
 *   ok | contract_error | backend_failed | timeout | unknown
 * 只有用法错(spec 非法)抛 UsageError。
 *
 * ⚠️ 它就是 `prepare → runTurn ×1 → finalize`,**N=1 的那条路**。别为单轮留第二份实现 ——
 * "同一件事两处各写一遍,迟早漂成两种行为",本仓在 `artifactSha256` / `diffPath` / `committed`
 * 上已经栽过三次。
 */
export async function runNode(bridge, rawSpec) {
  const hold = {};
  let run;
  try {
    run = await prepareRun(bridge, rawSpec, { hold });
  } catch (e) {
    await rejectNode(bridge, hold.viz, e);
    throw e;
  }
  if (run.reusedReceipt) {
    // 复用命中也要有终态 —— 否则页面上这个节点永远停在 `node:observed`。
    if (run.viz) await emitReusedSettled(run);
    return run.reusedReceipt;
  }
  // ⚠️ 单轮节点**不是特例,是 N=1**:它那一轮的 `key` 恒为 `"main"`,归档布局里
  //    同样有 `turns/main/`,事件流里同样有 `node:turn` 与 `node:turn-settled`。
  //    **不留"没有轮的旧路径"** —— 留一条,页面就要为两种布局各写一遍解析,而两套迟早只有一套被改。
  const mainTurn = {
    key: "main",
    prompt: run.spec.prompt, promptBody: run.spec.promptBody,
    timeoutMs: run.spec.timeoutMs,
    schema: run.spec.schema, outputShape: run.spec.outputShape, reask: run.spec.reask,
    turnSpecHash: run.spec.specHash,
    // 单轮节点这一轮的正文**就是**节点的正文,所以推断边直接沿用 —— 同一段正文
    // 扫两遍只会得到同一份结果,而两处各扫一遍迟早会漂成两种算法。
    inferredDeps: run.spec.inferredDeps, inferredDepsTruncated: run.spec.inferredDepsTruncated,
  };
  try {
    await runTurn(run, mainTurn);
    return await finalizeRun(run);
  } catch (e) {
    // 入场那几关(二次脏树复查 / 算分支名 / 建工作树)抛出来的 —— 单轮节点一旦不过
    // 就当场结束。**先闭合那一轮**(它的 `node:turn` 已经发出去了),再发节点级的 `node:rejected`。
    await closeNotStartedTurn(run, mainTurn, e);
    await rejectNode(bridge, run.viz, e);
    throw e;
  } finally {
    // ⚠️ **执行闸在这里放,不在 runTurn 结束时放。** `runNode` 的 close_session /
    // finalizeWorktree / 写回执都排在轮之后,提前放闸会让"同时活着的会话数"越过 maxConcurrent
    // ——W8 量的就是这个。(对话的每一轮按轮放闸,那是另一种 lease,见对话方案 §1.1。)
    await releaseRun(run);
  }
}

// ───────────────────────── 多轮对话(可选的记忆) ─────────────────────────
// 真理源:docs/DESIGN-graph-conversation-2026-07-28.md
//
// 一段对话 = 一个 id + 一个会话 + 一棵 worktree + 一条分支 + N 轮,作用域退出时统一收尾。
// `runNode` 是它的 **N=1**,两条路共用 prepare / runTurn / finalize —— 别为单轮留第二份实现。

/** 一段对话最多几轮。超了**响亮报错,不静默截断**。
 *  理由:viz 的 `node:settled` 要内联一份有界的轮摘要,N 无上限就顶穿事件的行上限。
 *  20 对"复审→修订"这类用法足够宽(实测 2~6 轮)。 */
const MAX_TURNS = 20;

/** 「我此刻是不是在某段对话的回调里」——**必须是调用上下文,不能是一个全局标志**。
 *
 *  ⚠️ 用桥级布尔写过一版,两个方向都是错的(复审当场抓出、C17 能稳定复现):
 *   - **兄弟对话被误判成嵌套**:`A` 进了回调把标志置上,平级的 `B` 一来就被拒 ——
 *     而"要并行就开多段对话"正是本设计给出的唯一并行办法,等于把它堵死了。
 *   - **真嵌套反而漏过去**:两段兄弟对话都进了回调,先结束的那个把标志清零,
 *     此后真正的嵌套就检查不出来,`maxConversations=1` 下变成确定性自锁。
 *
 *  `AsyncLocalStorage` 顺着 await 链传递,天生就是"调用上下文"这个语义。
 *  存的是**这条链上已经占了哪几座桥的对话闸**:同一座桥再来一段 = 成环,拒;
 *  另一座桥有它自己的闸、不成环,放行(拒了就是误报)。 */
const CONV_CTX = new AsyncLocalStorage();

/** 安全地把"被抛出来的东西"变成一句话。
 *  ⚠️ **不能直接 `String(x)`**:`throw Object.create(null)` 抛出来的东西没有 `toString`,
 *  `String(x)` 自己会再抛一个 TypeError —— 那会盖掉原始异常,还把收尾拦腰打断(会话没关成)。 */
function describeThrown(e) {
  try {
    if (e instanceof Error) return `${e.name || "Error"}:${e.message || "(无消息)"}`;
    if (e === null) return "null";
    if (typeof e === "object") return `${Object.prototype.toString.call(e)}:${JSON.stringify(e) ?? "(无法序列化)"}`;
    return `${typeof e}:${String(e)}`;
  } catch { return "(抛出来的东西连描述都取不出来)"; }
}

/** 一个**已经被"认领"过的** rejected promise:调用方 await 它照样拿到异常,
 *  但调用方**忘了 await** 时不会变成 unhandled rejection。
 *  ⚠️ Node 默认 unhandled rejection = 进程直接退出,会在收尾跑完之前把锁和工作树留在盘上 ——
 *  一个"用法错"不该有这种杀伤力。 */
function quietReject(err) {
  const p = Promise.reject(err);
  p.catch(() => {});
  return p;
}

/** 每一轮的指纹。**凡是会改变这一轮执行结局的都要进去** —— v1 漏掉后四项时,
 *  改了 timeoutMs / 换了 schema 的重跑会命中复用,把上一版的答案当成这一版。 */
function computeTurnSpecHash(t) {
  const promptBody = t.promptBody = freezePromptBody(t, "promptFile");
  const ident = {
    v: RECEIPT_VERSION, key: t.key, prompt: promptBody, timeoutMs: t.timeoutMs,
    schema: t.schema === undefined ? null : stableStringify(t.schema),
    outputShape: t.outputShape === undefined ? null : stableStringify(t.outputShape),
    reask: t.reask,
  };
  return crypto.createHash("sha256").update(stableStringify(ident)).digest("hex").slice(0, 32);
}

/** 规范化一轮的参数。校验口径与 `normalizeSpec` 里逐轮那几样**保持一致**(同样的错同样的话)。 */
function normalizeTurn(run, raw) {
  if (!raw || typeof raw !== "object") throw new UsageError("turn(...) 的参数必须是一个对象");
  const t = { ...raw };

  if (t.key === undefined || t.key === null || t.key === "") throw new UsageError("turn 缺必填字段:key");
  requireString(t.key, "key");
  if (!/^[A-Za-z0-9._-]+$/.test(t.key)) throw new UsageError(`key 只能用字母数字和 . _ -(拿来做文件名):${t.key}`);
  if (Buffer.byteLength(t.key, "utf8") > 200) throw new UsageError(`key 太长(超过 200 字节,拿来做文件名):${t.key}`);
  if (run.turnKeys.has(t.key)) {
    throw new UsageError(
      `同一段对话里 key 重复了:"${t.key}" —— 每一轮的 key 必须唯一(它是这一轮的身份,也是产出文件名)。\n` +
      `⚠️ **一轮入场失败(脏树 / 建工作树失败之类)之后,它的 key 也不还回来**:` +
      `事件流里那一轮已经开过头了,同一个 key 再来一次会让页面把前一条直接盖掉。\n` +
      `确实要重试,请换一个 key(例如 "${t.key}-retry")。`,
    );
  }

  const hasPrompt = typeof t.prompt === "string" && t.prompt.length > 0;
  const hasFile = t.promptFile !== undefined && t.promptFile !== null && t.promptFile !== "";
  if (hasPrompt === hasFile) throw new UsageError("prompt 和 promptFile 必须二选一(不能都给、也不能都不给)");
  if (hasFile) {
    t.promptFile = path.resolve(requireString(t.promptFile, "promptFile"));
    const st = statSafe(t.promptFile);
    if (!st) throw new UsageError(`promptFile 不存在:${t.promptFile}`);
    if (!st.isFile()) throw new UsageError(`promptFile 不是普通文件:${t.promptFile}`);
  }

  const ms = Number(t.timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) throw new UsageError(`timeoutMs 必须是正数(毫秒),拿到:${t.timeoutMs}`);
  t.timeoutMs = Math.floor(ms);

  if (t.schema !== undefined && run.spec.agent !== "codex") {
    throw new UsageError(
      `schema(强制输出格式)只有 codex 支持,当前 agent=${run.spec.agent}。` +
      `别的后端请改用 outputShape(工具做弱检查:能否 parse + 顶层必需键在不在)。`,
    );
  }
  if (t.outputShape !== undefined) {
    if (typeof t.outputShape !== "object" || t.outputShape === null) throw new UsageError("outputShape 必须是对象");
    const rk = t.outputShape.requiredKeys;
    if (rk !== undefined && !(Array.isArray(rk) && rk.every((k) => typeof k === "string"))) {
      throw new UsageError("outputShape.requiredKeys 必须是字符串数组");
    }
  }
  for (const k of ["schema", "outputShape"]) {
    if (t[k] === undefined) continue;
    try { JSON.stringify(t[k]); }
    catch (e) { throw new UsageError(`${k} 必须是可序列化的纯 JSON 值(${e.message})`); }
  }

  const re = t.reask === undefined ? 1 : Number(t.reask);
  if (![0, 1].includes(re)) throw new UsageError(`reask 只能是 0 或 1,拿到:${t.reask}`);
  t.reask = re;

  t.turnSpecHash = computeTurnSpecHash(t); // 顺带把 promptBody 冻在这一刻
  // B 档拓扑:**同一个算法、同一段代码**,只是输入换成这一轮的正文。
  // 对话的推断边主要来自这里 —— 第 2 轮的提问通常就是照着另一个节点的产出写的。
  {
    const inf = inferDeps(t.promptBody, run.spec.id);
    t.inferredDeps = inf.deps;
    t.inferredDepsTruncated = inf.truncated;
  }
  // ⚠️ `schema` / `outputShape` 只做浅拷贝不够:它们已经在指纹里被 stableStringify 定型,
  // 而真正发出去的是对象引用 —— 调用方在 await 之前改掉嵌套字段,"算的"与"发的"就分家了。
  if (t.schema !== undefined) t.schema = JSON.parse(JSON.stringify(t.schema));
  if (t.outputShape !== undefined) t.outputShape = JSON.parse(JSON.stringify(t.outputShape));
  return t;
}

/** 真跑一轮。 */
async function liveTurn(run, t) {
  const rec = {
    key: t.key, status: "unknown", sessionReusable: false, turnSpecHash: t.turnSpecHash,
    artifactPath: null, artifactSha256: null, charCount: null, byteCount: null,
    reaskCount: 0, durationMs: null, startedAt: null, endedAt: null,
    contextUsage: null, abortConfirmed: null, scene: null, error: null, diagnostics: [],
    attempts: [], // v2:这一轮的每次尝试各一条(`n` 在**每一轮内**从 1 重新开始)
  };
  // ⚠️ 先宣布、再取闸:对话闸也是一道闸,等它的那段时间同样属于「这一轮在排队」。
  await announceTurn(run, t);
  // 首轮才取对话闸。**不在 prepare 取** —— 那时一个会话都还没有,占的是个空名额:
  // 回调若在第一次 turn() 之前先去等一件长事,就会白白把别的对话堵在门外。
  // 顺序恒为 scope → exec(执行闸在 runTurn 里取),于是不存在"持 exec 等 scope",依赖图无环。
  if (!run.scopeHeld) { await run.bridge._scopeGate.acquire(); run.scopeHeld = true; }
  run.turnRec = rec;
  run.turns.push(rec);
  try {
    await runTurn(run, t);
  } catch (e) {
    // 走到这里几乎只有**用法错**(脏树复查、建工作树、分支名)——那意味着这一轮**压根没跑**:
    // 没发过消息,多半连会话都没开。把它从 turns[] 里撤掉,别留一条 status:"unknown" 的幽灵轮
    // 去污染顶层结局(顶层取最严重的一轮,unknown 正好是最严重的那个)。
    run.turns.pop();
    // ⚠️ **但 key 不还回去。** 早先这里 `turnKeys.delete(t.key)`,于是回调 catch 之后可以拿
    // **同一个 key** 再来一轮 —— 事件流里就出现两条 `node:turn{turnKey:"draft"}`,而第一条
    // 永远等不到自己的终态;页面按 key 建 map 会把前一条直接盖掉。
    // key 是这一轮的**身份**(也是产出文件名),用过就不能再用,哪怕那一轮没跑成。
    // (EVENTS.md 复审 BLOCKER 1 顺着文档指回来的实现问题。)
    // ⚠️ **在释放执行闸之前**把这一轮闭合掉 —— 它有开头(`node:turn`)就必须有结尾。
    await closeNotStartedTurn(run, t, e);
    // 会话根本没开起来时,对话名额界的那个东西不存在 —— 还给别人,别让一段跑不起来的对话
    // 把 maxConversations 一直占着。下一轮真跑起来时 liveTurn 会重新取。
    if (!run.opened && run.scopeHeld) { run.bridge._scopeGate.release(); run.scopeHeld = false; }
    throw e;
  } finally {
    rec.startedAt = run.startedAt;
    rec.endedAt = nowIso();
    /* ⚠️ **别覆盖已经播出去的那个读数。**
          正常路径上,`node:turn-settled` 在这之前就带着 `rec.durationMs` 发出去了;
          这里再读一次时钟,拿到的是**几毫秒之后**的另一个值 —— 于是同一轮的耗时,
          事件里一个数、回执 `turns[]` 里另一个数,**同名不同值**。
          页面按事件画时间线、按回执补复用节点的轮,两处一对账就永远差那么一点,
          而这种"差一点"最容易被当成正常抖动放过去。
          只有**没走到那一步就抛了**的路径这里才第一次给它赋值。 */
    if (rec.durationMs == null) rec.durationMs = Math.round(monoNow() - run.t0);
    // ⚠️ **执行闸按轮放**:回调期间不持有,好让回调里嵌套的 runNode 拿得到 ——
    // 那正是"复审发生在两轮之间"这个头号用法。(`runNode` 是另一种 lease:持到写完回执,
    // 因为它的 close/finalize 都排在轮之后,提前放会让活会话数越过 maxConcurrent。)
    if (run.gateHeld) { run.bridge._gate.release(); run.gateHeld = false; }
  }
  // 毒化:这一轮之后会话不能再用了 ⇒ 整段封口(判据在工具里,不靠回调自觉)
  if (rec.sessionReusable !== true && run.poisonedAfter === null) run.poisonedAfter = t.key;
  return rec;
}

/** 回放校验一轮:**不发任何消息**,只把本轮参数与旧回执里对应的那一轮逐项比对。 */
async function replayTurn(run, t, prev) {
  const i = run.turns.length;
  const old = prev.turns[i];
  const bail = (why) => new UsageError(
    `回放不匹配(第 ${i + 1} 轮,key="${t.key}"):${why}\n` +
    `⚠️ **整段不复用,也不会自动重跑一遍** —— 与 runNode 的复用闸同一口径。\n` +
    `轮序列变了就换一个新 id;确实要覆盖上次那一次执行就加 force(且别同时传 reuseIfSame)。`,
  );
  if (!old) throw bail(`旧回执只有 ${prev.turns.length} 轮,这次多出来了`);
  if (old.key !== t.key) throw bail(`旧回执这一位是 "${old.key}"`);
  if (old.status !== "ok") throw bail(`旧回执这一轮是 ${old.status},不是 ok`);
  if (old.turnSpecHash !== t.turnSpecHash) throw bail("这一轮的任务单变了(prompt / timeoutMs / schema / outputShape / reask 有一样不同)");

  const p = run.artifactPathFor(t.key);
  if (old.artifactPath !== p) throw bail(`旧回执里的产出路径与本次算出来的不一致(${old.artifactPath} ≠ ${p})`);
  const st = statSafe(p);
  // 同 runNode:零字节是 `no-output` 那一档**合法的成功**,不是"文件坏了"。
  if (!st || !st.isFile()) throw bail(`产出文件缺失:${p}`);
  // 与 runNode 的复用闸同一个道理:只查"非空"挡不住产出被**换成另一份非空文件**,
  // 而"字段缺失就跳过校验"这个坑本仓踩过三次 —— 这里要求指纹**必须是合法的 64 位 hex**。
  if (!/^[0-9a-f]{64}$/.test(old.artifactSha256 || "")) throw bail(`旧回执里没有合法的产出内容指纹:${p}`);
  if (await sha256File(p) !== old.artifactSha256) throw bail(`产出文件内容与回执记录的不一致(可能被改过):${p}`);
  // 同 runNode 那道闸:复用会逐次重新归档审计原件,所以逐次都要在这里坐实。
  await assertAttemptsIntact(run, t.key, old.attempts, t.reask, bail);

  /* 复用收尾时要靠它把 attempt 1 的输入找回来 —— `old` 是**旧回执**里那一项,
     而这一次冻结的正文在 `t` 上(两者的 `turnSpecHash` 刚比对过 ⇒ 同一份字节)。 */
  (run.replayBodies ??= new Map()).set(t.key, t.promptBody);

  /* ⚠️ **推断边用本次重算的那份,不用旧回执里存的。**(§5.9 明写「`inferredDeps` 本次重算」)
        `normalizeTurn` 刚刚用**同一个算法**扫过这一轮的正文,而正文与原运行必然是同一份字节
        (`turnSpecHash` 逐项比对过)。用旧回执那份的后果是:**推断算法改了之后,
        复用命中的节点会继续画早已不成立的虚线边** —— 而虚线本来就是"系统按文件名猜的",
        再叠一层"猜的是上一版算法的结论",页面上没有任何线索能看出来。 */
  old.inferredDeps = t.inferredDeps ?? [];
  old.inferredDepsTruncated = t.inferredDepsTruncated ?? false;

  run.turns.push(old);
  return old;
}

/**
 * 一段多轮对话。`fn` 拿到的 `turn` 就是"再说一句"。
 *
 *   await bridge.conversation({ id, agent, access, cwd, outDir }, async (turn) => {
 *     const r1 = await turn({ key: "draft", prompt: FIRST, timeoutMs: 600000 });
 *     if (!r1.sessionReusable) return;              // ← 会话还能不能接着用,工具说了算
 *     const rev = await bridge.runNode({ … });      // ← 两轮之间跑别的节点:支持,不自锁
 *     const r2 = await turn({ key: "fix", prompt: fixPrompt(rev), timeoutMs: 600000 });
 *   });
 *
 * **不为某一轮失败抛异常**(同 `runNode`),失败进 `turnResult.status`;只有**用法错**抛。
 */
export async function conversation(bridge, rawSpec, fn) {
  if (typeof fn !== "function") throw new UsageError("conversation(spec, fn):第二个参数必须是回调函数");
  // ⚠️ 嵌套 conversation 要的是**同一座桥的同一把对话闸**,那才会成环 —— 当场拒。
  // 嵌套 **runNode** 是支持的(它只要执行闸,而对话在回调期间不持执行闸)。
  // **平级的兄弟对话不是嵌套**,必须放行:那是本设计给出的唯一并行办法。
  // 这条判据在 live 与 replay 两条路上完全一致,不许一边禁一边放。
  const outer = CONV_CTX.getStore();
  if (outer?.bridges.has(bridge)) {
    throw new UsageError(
      "不能在 conversation 的回调里,对**同一座桥**再开一段 conversation —— 两段都要那把对话闸,必然自锁。\n" +
      "(回调里跑**普通节点**是支持的,那正是「复审发生在两轮之间」这个用法;\n" +
      " 平级的兄弟对话也照常支持,那是这里唯一的并行办法。)",
    );
  }
  const ctx = { bridges: new Set(outer ? [...outer.bridges, bridge] : [bridge]) };
  return await CONV_CTX.run(ctx, () => conversationBody(bridge, rawSpec, fn));
}

async function conversationBody(bridge, rawSpec, fn) {
  const hold = {};
  let run;
  try {
    run = await prepareRun(bridge, rawSpec, { kind: "conversation", hold });
  } catch (e) {
    await rejectNode(bridge, hold.viz, e);
    throw e;
  }
  const prev = run.reusedReceipt; // 非 null ⇒ 走回放:不拿任何闸、不开会话、不建 worktree

  // ⚠️ 刻意**不是** async 函数:入场被拒时要返回一个"已认领"的 rejected promise(quietReject),
  //    否则调用方忘了 await 的那次拒绝会变成 unhandled rejection 把整个进程打死 ——
  //    一个用法错不该有这种杀伤力,而且它会在收尾跑完之前就把锁和工作树留在盘上。
  const turn = (raw) => {
    // 「回调调用过 turn() 吗」必须**独立于「有没有一轮跑起来」**记账:回调完全可以把入场异常
    // 吞掉(`try { await turn(...) } catch {}`),那时 `run.turns` 仍是空的,但"编排一轮都没起过"
    // 是**假话** —— 它起过,只是参数写错了。两者的处置完全不同(一个去看那次 turn() 的参数,
    // 一个去看编排那段 JS 为什么空转),所以下面收尾时要能分辨。
    run.turnCalls += 1;
    // 记下"这一次为什么没进去"。⚠️ 口径是**最后一次失败的真实原因**,不是"最后一次校验错" ——
    // 早先只在 normalizeTurn 那一处记,于是被并发闸/毒化闸拒掉的那些次一个字都留不下,
    // 收尾合成的那句会说"每次都死在参数校验上……原因:(没记到)",两句都是假话。
    // 所以凡是**调用了 turn() 却没能进 turns[]** 的路径,都要在这里留下痕迹。
    const rejectTurn = (err) => { run.lastTurnFailure = err; return quietReject(err); };
    // ── 同步闸区:这一段到 `run.activeTurn = true` 之间**一个 await 都没有**,
    //    JS 又是单线程 ⇒ "查 + 置位"是原子的。
    //    ⚠️ 谁也别往中间插 await(比如把校验改成 `await validate(...)`)—— 那会当场废掉这道闸,
    //    而它挡的是 `Promise.all([turn(a), turn(b)])` 同时穿过毒化 guard、两轮向同一会话并发 send。
    if (run.sealed) {
      return rejectTurn(new UsageError(`fn 已经返回了,这一轮("${raw?.key}")来晚了 —— 作用域退出后不能再 turn()`));
    }
    if (run.poisonedAfter !== null) {
      return rejectTurn(new UsageError(
        `这段对话在第 "${run.poisonedAfter}" 轮之后已经不能再用了(sessionReusable=false):\n` +
        `那一轮要么可能还在后台跑(abort 未确认),要么会话已经没了 —— 再 send 就是同一会话并发。\n` +
        `要接着聊请另起一段对话。`,
      ));
    }
    if (run.activeTurn) {
      return rejectTurn(new UsageError("同一段对话里不能并发 turn() —— 上一轮还没结束。要并行请开多段对话。"));
    }
    if (run.turns.length >= MAX_TURNS) {
      return rejectTurn(new UsageError(`一段对话最多 ${MAX_TURNS} 轮,已经到顶了 —— 请把它切成几段。`));
    }
    run.activeTurn = true;
    // ── 同步闸区结束 ──
    const p = (async () => {
      let t;
      try {
        t = normalizeTurn(run, raw); // 到这里都还没有任何副作用
      } catch (e) { run.lastTurnFailure = e; throw e; }
      run.turnKeys.add(t.key);
      try {
        return prev ? await replayTurn(run, t, prev) : await liveTurn(run, t);
      } catch (e) { run.lastTurnFailure = e; throw e; } // 开过头才失败的那些也算(脏树复查、建工作树…)
    })();
    run.inFlight = p.finally(() => { run.activeTurn = false; });
    // 收尾一定会 `await run.inFlight`,所以 p 的拒绝总有人接 —— 调用方忘了 await 也不炸进程。
    run.inFlight.catch(() => {});
    return p;
  };

  let callbackError = null;
  let threw = false;
  // 「这个节点有没有终态事件」。⚠️ **它就是 `node:rejected` 与 `node:settled` 的分界判据**
  //    (§5.3:同一个 `UsageError` 落在哪一层,取决于这个节点有没有回执)。
  let settledEmitted = false;
  try {
    try {
      await fn(turn);
    } catch (e) { callbackError = e; threw = true; }
    // ⚠️ 从这里往下一律看 `threw`,**不看 callbackError 真不真** —— `throw null` 也是抛。

    // ① 封 admission:此后任何 turn() 立刻 rejected,不产生任何事件、文件、消息
    run.sealed = true;
    // ② 排空在途轮:回调忘了 await 时可能还有一轮在跑。它有自己的钟,必然终止。
    if (run.inFlight) { try { await run.inFlight; } catch {} }

    if (prev) {
      // ── 回放:**只读收尾**。不关不存在的会话、不 finalize 工作区、**绝不改 canonical 回执** ──
      // 改了就是在毁掉自己刚验证过的那份缓存:轻则把历史耗时覆盖成本次验证的时间,
      // 重则一次回放期的回调 bug 把一张 ok 回执永久改写成失败。
      if (threw) throw callbackError;
      if (run.turns.length !== prev.turns.length) {
        throw Object.assign(new UsageError(
          `回放不匹配:旧回执有 ${prev.turns.length} 轮,这次只消费了 ${run.turns.length} 轮 —— 整段不复用。\n` +
          `⚠️ 回放**不是事务**:回调里别的副作用(嵌套节点、写文件)已经发生了,拒绝不会回滚它们。\n` +
          `所以回放模式下的回调必须是可重放的:嵌套节点一律带 reuseIfSame,绝不用 force。`,
        ), { phase: "reuse-check" });
      }
      // 复用命中的对话**一条 `node:turn` 都不发** —— 它的终态与推断边全靠这一条。
      if (run.viz) { await emitReusedSettled(run); settledEmitted = true; }
      return { ...prev, reused: true };
    }

    if (run.turns.length === 0) {
      // ⚠️ 回调已经抛出的异常才是根因,零轮检查只是"你什么都没干"的兜底诊断 —— **兜底不许盖根因**。
      if (threw) throw callbackError;
      // 两种「零轮」的处置完全不同,所以报两句不同的话(事件层据此分 zero-turn / turn-validation)。
      if (run.turnCalls > 0) {
        // ⚠️ 只说得出口的事:调了几次、最后一次为什么没进去。**别替它归类**
        //    ——"每次都死在参数校验上"就曾经是假话(并发闸/毒化闸拒掉的那些也在这个计数里)。
        throw Object.assign(new UsageError(
          `这段对话调用了 ${run.turnCalls} 次 turn(),但没有一轮进得去 —— 每次都被拒了,` +
          `而回调把异常吞了(\`try { await turn(...) } catch {}\`),于是外面什么都没看见。\n` +
          `最后一次没进去的原因是:${run.lastTurnFailure?.message ?? "(没记到)"}\n` +
          `⚠️ 别在回调里静默吞 turn() 的用法错 —— 那会让"这一轮被拒了"看起来像"编排空转"。`,
        // 判据写死:`turnCalls > 0` 且 `turns[]` 为空。⚠️ 枚举名比语义窄 ——
        // 它涵盖参数不合法**与**用法/状态不允许(并发/来晚/毒化后/超 20 轮)两类。
        ), { phase: "turn-validation" });
      }
      throw Object.assign(new UsageError(
        "这段对话一轮都没跑(回调一次 turn() 都没调)。**不写空回执** —— " +
        "一张 turns:[] 的回执会让下次的复用闸面对一个没有任何判据的对象。",
      ), { phase: "zero-turn" });
    }

    const receipt = await finalizeRun(run, { callbackError, callbackThrew: threw });
    settledEmitted = true;
    // 回执是记录,异常是控制流 —— 顶层 status 怎么定都不改变"原样重抛回调的异常"。
    // ⚠️ 收尾过程中产生的诊断**不许盖掉它**:回调的异常才是根因。
    if (threw) throw callbackError;
    return receipt;
  } catch (e) {
    // ⚠️ **判据是「这个节点有没有终态」,不是「抛的是什么」。**
    //    有回执的节点(哪怕回调自己炸了)走的是 `node:settled{status:"callback_error"}`;
    //    只有一轮都没跑起来的才发 `node:rejected`。两条路都发 = 那个节点被数两次,
    //    §5.10 的恒等式当场作废。
    if (!settledEmitted) await rejectNode(bridge, run.viz, e, "zero-turn");
    throw e;
  } finally {
    await releaseRun(run);
  }
}

/** status → node-turn 的退出码。脚本用法用不到这个(直接看 receipt.status)。 */
export const STATUS_EXIT = {
  ok: 0,
  contract_error: 2,
  backend_failed: 3,
  timeout: 4,
  unknown: 6,
};
