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

export const RECEIPT_VERSION = 1;

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

/** 规范化 + 校验一张任务单。返回带 specHash 的 spec。**所有可预知的错都在这里变成 UsageError**。 */
export function normalizeSpec(raw) {
  if (!raw || typeof raw !== "object") throw new UsageError("任务单必须是一个对象");
  const s = { ...raw };

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

  s.cwd = path.resolve(s.cwd);
  const cwdStat = statSafe(s.cwd);
  if (!cwdStat) throw new UsageError(`cwd 不存在:${s.cwd}`);
  if (!cwdStat.isDirectory()) throw new UsageError(`cwd 不是目录:${s.cwd}`);
  s.outDir = path.resolve(s.outDir);
  const outStat = statSafe(s.outDir);
  if (outStat && !outStat.isDirectory()) throw new UsageError(`outDir 已存在但不是目录:${s.outDir}`);

  // v1 只允许只读。⚠️ 只有 codex 的 read 是 OS 沙箱硬只读,另外四家是软的(shell 能写盘,
  // cursor/kimi 连原生写工具都还在)—— 要硬保证不写盘就点名 codex。
  s.access = s.access ?? "read";
  if (s.access !== "read") throw new UsageError(`v1 只支持 access:"read"(改文件的环节整块不在本版范围),拿到:${s.access}`);

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
  const re = s.reask === undefined ? 1 : Number(s.reask);
  if (![0, 1].includes(re)) throw new UsageError(`reask 只能是 0 或 1,拿到:${s.reask}`);
  s.reask = re;

  // 严格布尔:`Boolean("false")` 是 true —— 从命令行/配置文件流过来的字符串会把开关**反着**打开
  for (const k of ["force", "reuseIfSame"]) {
    if (s[k] === undefined || s[k] === null) { s[k] = false; continue; }
    if (typeof s[k] !== "boolean") throw new UsageError(`${k} 必须是布尔值(true/false),拿到 ${typeof s[k]}:${JSON.stringify(s[k])}`);
  }
  // 两个语义相反(一个"无条件重跑"一个"能复用就复用"),同传说明调用方没想清楚 → 当场拒绝,
  // 不靠隐式优先级替人做决定。
  if (s.force && s.reuseIfSame) throw new UsageError("force 与 reuseIfSame 语义冲突,不能同时设置");

  s.specHash = computeSpecHash(s);
  return s;
}

/** 输入指纹:决定「这张旧回执记的,是不是当前这份任务单的结果」。
 *  少了它,改了 prompt/模型后重跑会把上一版结果当成这一版 —— 静默出错,最难查的一类。
 *  **凡是会改变执行结局的字段都要进指纹**(含 timeoutMs / reask:超时时长和重说次数都会改变结局)。 */
function computeSpecHash(s) {
  let promptBody, roleBody = "";
  try { promptBody = s.promptFile ? fs.readFileSync(s.promptFile, "utf8") : s.prompt; }
  catch (e) { throw new UsageError(`读 promptFile 失败:${e.message}`); }
  if (s.roleFile) {
    try { roleBody = fs.readFileSync(s.roleFile, "utf8"); }
    catch (e) { throw new UsageError(`读 roleFile 失败:${e.message}`); }
  }
  const ident = {
    v: RECEIPT_VERSION,
    agent: s.agent, model: s.model ?? null, effort: s.effort ?? null,
    access: s.access, cwd: s.cwd, prompt: promptBody, role: roleBody,
    schema: s.schema === undefined ? null : stableStringify(s.schema),
    outputShape: s.outputShape === undefined ? null : stableStringify(s.outputShape),
    timeoutMs: s.timeoutMs, reask: s.reask,
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

  const bridge = {
    callTool,
    get stderrTail() { return state.stderrTail; },
    get exited() { return state.exited; },
    get lateResponses() { return state.lateResponses; },
    get pid() { return child.pid; },
    _activeNodes: state.activeNodes,
    doctor: (timeoutMs = RPC_TIMEOUT_MS) => callTool("agent_bridge_doctor", {}, timeoutMs),
    runNode: (spec) => runNode(bridge, spec),
    async close() {
      if (state.closed) return;
      state.closed = true;
      // 兜底:把本进程还没关的会话一次清掉(正常路径里每个 runNode 都自己关了)
      const st = BRIDGE_REAP_STATE.get(bridge) || {};
      let bulkFailed = false;
      try {
        const bulk = await callTool("agent_bridge_close_session", {}, 20000);
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
  try {
    return await fn(bridge);
  } finally {
    await bridge.close();
  }
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

/** 产出的内容指纹,用来判断"复用时这份文件还是当初那份吗"。 */
function sha256File(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
  catch { return null; }
}

/** 原子写:同目录临时文件 + rename。避免崩在半路留下一个不可 parse 的回执。 */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(monoNow())}`;
  fs.writeFileSync(tmp, data, "utf8");
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

/**
 * 跑一个环节的完整生命周期,一步不落:
 *   开会话 → 发任务(非阻塞) → 短切片 wait 循环到 deadline → cp 结果 → 校验 → (必要时打回重说一次) → 关会话 → 写回执
 *
 * **不为环节失败抛异常**,返回带 status 的回执:
 *   ok | contract_error | backend_failed | timeout | unknown
 * 只有用法错(spec 非法)抛 UsageError。
 */
export async function runNode(bridge, rawSpec) {
  const spec = normalizeSpec(rawSpec);
  ensureDir(spec.outDir);
  const nodesDir = path.join(spec.outDir, "nodes");
  ensureDir(nodesDir);

  const artifactPath = path.join(nodesDir, `${spec.id}.md`);
  const receiptPath = path.join(nodesDir, `${spec.id}.receipt.json`);
  const sceneDir = path.join(nodesDir, `${spec.id}.scene`);
  const startedAt = nowIso();
  const t0 = monoNow();
  const deadline = t0 + spec.timeoutMs;
  /** 本环节还剩多少总预算。**每一次 RPC 都受它约束** —— 否则 open/send 卡住就能把「总上限」顶穿。 */
  const remaining = () => deadline - monoNow();
  /** 上一次 RPC 的期限**是不是由本环节的总预算决定的**(而不是那类调用的默认上限)。
   *  用来精确区分两种本地超时,不靠事后比 `remaining()<=0`——那是个竞态:
   *  计时器到点时剩余量可能还是个微小正数,同一件事会时而判 timeout、时而判 unknown。 */
  let rpcDeadlineFromBudget = false;
  /** 给某次 RPC 的预算:总预算与该类调用默认上限的较小值。 */
  const budget = (cap = RPC_TIMEOUT_MS) => {
    const ms = Math.min(cap, Math.max(0, remaining()));
    rpcDeadlineFromBudget = ms < cap;
    return ms;
  };

  // 同一个 <outDir,id> 在同一个 bridge 里并发跑 = 两个环节写同一个产出,后写者覆盖前者,
  // 而两张回执都可能声称成功。当场拒绝(这是调用方的 id 用重了,属用法错)。
  const activeKey = JSON.stringify([spec.outDir, spec.id]);
  let active = ACTIVE_NODES.get(bridge);
  if (!active) { active = new Set(); ACTIVE_NODES.set(bridge, active); }
  if (active.has(activeKey)) {
    throw new UsageError(`同一个 outDir 里的环节 id "${spec.id}" 正在并发运行 —— id 必须唯一`);
  }
  active.add(activeKey);

  // 跨 bridge / 跨进程的防撞:原子创建锁文件(wx = 已存在就失败)。
  // 上面那个 Set 只看得见自己这个 bridge;两个 withBridge、两个 node 进程照样能撞同一份产出。
  const lockPath = path.join(nodesDir, `${spec.id}.lock`);
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(lockFd, `${process.pid} ${nowIso()}\n`, "utf8");
  } catch (e) {
    active.delete(activeKey);
    // ⚠️ openSync 成功、writeFileSync 才失败(磁盘满等)时,**外层 finally 还没生效** ——
    // 不在这里收就会同时泄漏一个 fd 和一把永远解不开的锁。
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.rmSync(lockPath, { force: true }); } catch {}
      lockFd = null;
    }
    if (e.code === "EEXIST") {
      throw new UsageError(
        `环节 "${spec.id}" 的锁文件已存在:${lockPath}\n` +
        `要么另一个进程正在跑同一个环节(id 撞了),要么上次异常退出留下了它 —— 确认没人在跑后删掉它再来。`,
      );
    }
    throw new UsageError(`无法创建环节锁文件 ${lockPath}:${e.message}`);
  }

  try {
    // --- 幂等闸
    if (fs.existsSync(receiptPath) && !spec.force) {
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch {}
      if (!spec.reuseIfSame) {
        throw new UsageError(`回执已存在:${receiptPath}(要覆盖请加 force,要按指纹复用请加 reuseIfSame)`);
      }
      if (!prev || prev.receiptVersion !== RECEIPT_VERSION) {
        throw new UsageError(`回执存在但版本对不上(无法安全复用):${receiptPath}`);
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
      // 产出还在不在?回执说 ok 但文件被删/被截断的话,复用就是在骗下游。
      // 而且产出路径必须就是**本次算出来的**那个,不能听信回执里写的任意路径。
      if (prev.artifactPath !== artifactPath) {
        throw new UsageError(`回执里的产出路径与本次不一致(${prev.artifactPath} ≠ ${artifactPath}),不复用。`);
      }
      const st = statSafe(artifactPath);
      if (!st || !st.isFile() || st.size === 0) {
        throw new UsageError(`回执说成功,但产出文件缺失或为空:${artifactPath}。要重跑请加 force。`);
      }
      // 内容指纹:只查"非空"挡不住产出被**换成另一份非空文件**。
      // **这道闸不是可选的** —— 写成 `if (prev.artifactSha256)` 会让"回执里没这个字段"
      // (旧回执 / 字段被删 / 上次算哈希失败写了 null)**静默跳过校验**,等于没有这道闸。
      if (!/^[0-9a-f]{64}$/.test(prev.artifactSha256 || "")) {
        throw new UsageError(
          `回执里没有合法的产出内容指纹(artifactSha256),无法确认产出还是当初那份:${receiptPath}。要重跑请加 force。`,
        );
      }
      const nowSha = sha256File(artifactPath);
      if (nowSha !== prev.artifactSha256) {
        throw new UsageError(`产出文件内容与回执记录的不一致(可能被改过或被覆盖):${artifactPath}。要重跑请加 force。`);
      }
      return { ...prev, reused: true };
    }

    const receipt = {
      receiptVersion: RECEIPT_VERSION,
      id: spec.id, specHash: spec.specHash,
      agent: spec.agent, model: spec.model ?? null, effort: spec.effort ?? null,
      status: "unknown", artifactPath: null, charCount: null, byteCount: null,
      contextUsage: null, reaskCount: 0, durationMs: null,
      startedAt, endedAt: null, diagnostics: [], error: null, scene: null,
      sessionId: null, abortConfirmed: null, closeConfirmed: null, artifactSha256: null,
    };

    let sessionId = null;
    let logFile = null;
    let lastTextRef = null;

    /** 现场保留(三件套):桥干净退出会删掉本次 run 的日志目录、close_session 会删 textRef,
     *  所以**必须在关会话/关桥之前**把现场 cp 出来。缺哪件就在 diagnostics 里说明原因。 */
    const saveScene = async (tag) => {
      try {
        ensureDir(sceneDir);
        const files = [];
        if (logFile) {
          if (copyBytes(logFile, path.join(sceneDir, "session.log"))) files.push("session.log");
          else receipt.diagnostics.push(`现场:复制 session.log 失败(${logFile})`);
        } else receipt.diagnostics.push("现场:没有 logFile 可复制(会话可能没开起来)");

        // 超时/失败时答案可能仍然拿得到(abort 之后 textRef 往往还在)—— 尽力取一次
        if (!lastTextRef && sessionId) {
          try {
            const r = await bridge.callTool("agent_bridge_result", { session_id: sessionId }, FINALIZE_BUDGET_MS / 3);
            if (r?.textRef) lastTextRef = r.textRef;
          } catch (e) { receipt.diagnostics.push(`现场:补取 result 失败(${e.name})`); }
        }
        if (lastTextRef) {
          if (copyBytes(lastTextRef, path.join(sceneDir, "answer.txt"))) files.push("answer.txt");
          else receipt.diagnostics.push(`现场:复制 answer.txt 失败(${lastTextRef})`);
        }

        if (sessionId) {
          try {
            const st = await bridge.callTool("agent_bridge_status", { session_id: sessionId }, FINALIZE_BUDGET_MS / 3);
            writeAtomic(path.join(sceneDir, "status.json"), JSON.stringify(st, null, 2) + "\n");
            files.push("status.json");
          } catch (e) { receipt.diagnostics.push(`现场:取 status 失败(${e.name})`); }
        }
        receipt.scene = { dir: sceneDir, tag, savedAt: nowIso(), files };
      } catch (e) {
        receipt.diagnostics.push(`保留现场失败:${e.message}`);
      }
    };

    const closeSession = async () => {
      if (!sessionId) return;
      try {
        const r = await bridge.callTool("agent_bridge_close_session", { session_id: sessionId }, FINALIZE_BUDGET_MS / 2);
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
        noteSessionClosed(bridge, receipt.closeConfirmed === true);
      }
    };

    /** 超时收场:**先 abort 打断这一轮**(桥的 wait 超时本身不打断,任务还在后台烧),
     *  abort 成没成如实记录 —— 不能未确认就在回执里写"已 abort"。 */
    const finishTimeout = async (why) => {
      if (sessionId) {
        try {
          const r = await bridge.callTool("agent_bridge_abort", { session_id: sessionId }, FINALIZE_BUDGET_MS / 2);
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

    /** 统一收尾:**先保现场 → 再关会话 → 最后原子写回执**。顺序不能换。 */
    const finish = async (status, extra = {}) => {
      Object.assign(receipt, extra);
      receipt.status = status;
      if (status !== "ok") await saveScene(extra._sceneTag || status);
      delete receipt._sceneTag;
      await closeSession();
      receipt.endedAt = nowIso();
      receipt.durationMs = Math.round(monoNow() - t0);
      try {
        writeAtomic(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
      } catch (e) {
        // 回执落盘是成功的**前提**:回执写不下去,下一次就无法靠它做幂等判断。
        // 绝不能"退出 0 但没有回执"。
        receipt.status = "unknown";
        receipt.error = `回执写入失败(${e.message});原始结局=${status}${receipt.error ? `;${receipt.error}` : ""}`;
      }
      return receipt;
    };

    try {
      // --- 开会话
      const openArgs = {
        agent: spec.agent, cwd: spec.cwd, access: spec.access,
        // 结果走 textRef + cp,不把几 MB 正文塞进 JSON-RPC 管道
        return_mode: "ref",
        name: `graph-${spec.id}-${spec.specHash.slice(0, 6)}`,
      };
      if (spec.model) openArgs.model = spec.model;
      if (spec.effort) openArgs.effort = spec.effort;
      if (spec.roleFile) openArgs.append_system_prompt_file = spec.roleFile;

      if (remaining() <= 0) return await finish("timeout", { error: `还没开会话,总预算 ${spec.timeoutMs}ms 就已耗尽` });
      const opened = await bridge.callTool("agent_bridge_open_session", openArgs, budget());
      sessionId = opened?.session?.id ?? null;
      logFile = opened?.session?.logFile ?? null;
      receipt.sessionId = sessionId;
      if (!sessionId) {
        // 桥没抛错、却也没给 session id —— 这不是"桥明确说后端不行",是我们不认识的返回形状。
        // 按 unknown 停下(可能后端其实开起来了,只是我们没拿到句柄)。
        return await finish("unknown", { error: `开会话返回里没有 session id(形状不认识):${JSON.stringify(opened).slice(0, 500)}` });
      }

      let attempt = 0;
      let lastReason = null;

      while (true) {
        if (remaining() <= 0) {
          return await finish("timeout", { error: `总预算 ${spec.timeoutMs}ms 耗尽(还没来得及发第 ${attempt + 1} 轮)` });
        }

        // --- 发消息(默认非阻塞,立刻拿 ack)
        const msgArgs = { session_id: sessionId };
        if (attempt === 0) {
          if (spec.promptFile) msgArgs.message_file = spec.promptFile;
          else msgArgs.message = spec.prompt;
        } else {
          msgArgs.message =
            `上一条回复不符合约定的输出格式:${lastReason}\n` +
            `请**只输出**符合要求的 JSON 本体,不要任何解释文字、不要 markdown 代码围栏。`;
        }
        if (spec.schema) msgArgs.schema = spec.schema;

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
          rpcDeadlineFromBudget = slice < WAIT_SLICE_MS;
          const w = await bridge.callTool(
            "agent_bridge_wait",
            { session_ids: [sessionId], mode: "all", timeout_ms: Math.max(1, Math.floor(slice)) },
            slice + tolerance,
          );
          if (w?.timedOut) {
            const snap = w.pendingSnapshots?.[0];
            if (snap && snap.contextUsage !== undefined) receipt.contextUsage = snap.contextUsage ?? null;
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
        if (!settled) return await finishTimeout(`超过 ${spec.timeoutMs}ms 未完成`);

        if (settled.contextUsage !== undefined) receipt.contextUsage = settled.contextUsage ?? null;
        if (settled.textRef) lastTextRef = settled.textRef;

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
        let text = null;
        if (settled.textRef && copyBytes(settled.textRef, artifactPath)) {
          try { text = fs.readFileSync(artifactPath, "utf8"); }
          catch (e) { receipt.diagnostics.push(`产出已复制但读不回来:${e.message}`); }
        }
        if (text === null) {
          // 拿不到 textRef:再 result 一次(不设 max_chars 拿全文)
          try {
            const r = await bridge.callTool("agent_bridge_result", { session_id: sessionId }, budget());
            if (r?.textRef) {
              lastTextRef = r.textRef;
              if (copyBytes(r.textRef, artifactPath)) {
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
        receipt.artifactSha256 = sha256File(artifactPath);
        // 算不出产出的哈希 = 刚写下的文件读不回来,本地落盘完整性有问题。
        // 这时不能报 ok:否则会写出一张**没有指纹**的成功回执,让下次复用绕过内容校验。
        if (!receipt.artifactSha256) {
          return await finish("unknown", { error: `产出已落盘但算不出内容指纹(读不回来):${artifactPath}` });
        }

        // --- 契约校验:codex 走后端强制(桥回 json / schemaError),其余四家走弱检查
        let bad = null;
        if (spec.schema) {
          if (settled.schemaError) bad = `codex 强制格式未通过:${settled.schemaError.error ?? JSON.stringify(settled.schemaError)}`;
        } else if (spec.outputShape) {
          const chk = weakCheck(text, spec.outputShape);
          if (!chk.ok) bad = chk.reason;
        }

        if (!bad) return await finish("ok");

        // 不合格:按声明打回重说一次,再不行就停(**绝不无限重试**)
        if (attempt < spec.reask && remaining() > 0) {
          receipt.diagnostics.push(`第 ${attempt + 1} 次输出不合格,打回重说:${bad}`);
          receipt.reaskCount = attempt + 1;
          lastReason = bad;
          attempt++;
          continue;
        }
        return await finish("contract_error", {
          error: bad + (remaining() <= 0 && attempt < spec.reask ? "(预算已耗尽,没能打回重说)" : ""),
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
      if (e instanceof RpcTimeoutError && (rpcDeadlineFromBudget || remaining() <= 0)) {
        return await finishTimeout(`总预算 ${spec.timeoutMs}ms 耗尽(${detail})`);
      }
      return await finish("unknown", {
        error: `${detail}(无法确认后端是否已经开始/完成了工作,故按未知状态停下)`,
      });
    }
  } finally {
    active.delete(activeKey);
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
    try { fs.rmSync(lockPath, { force: true }); } catch {}
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
