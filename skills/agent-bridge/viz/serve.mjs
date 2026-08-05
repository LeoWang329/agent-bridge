/**
 * 委托会话史观测台 —— viewer 侧。
 *
 * **合同在仓库的 `docs/STATE-session-viz.md`。** 本文件只做三件事：
 *   ① 按 §2 的双槽协议挑出最新合法快照，**原样透传**给页面
 *   ② 轮询活跃轮次的 sidecar，作为独立的 `progress` 帧发出去
 *   ③ 按 §6.3 的判据把归档文件安全地发出去
 *
 * ⚠️ **viewer 是搬运工，不是第二个 writer**（docs/STATE-session-viz.md §6）：`state` 帧是槽文件的
 *    字节原样透传，不重新序列化、不补字段、不把 sidecar 合进去。
 *
 * 起法：`VIZ_DIR=<目录> node serve.mjs [port]`
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  VIZ_FILE_MAX_BYTES, resolveWithin, sendArchivedFile, sendPlain, sendMethodNotAllowed,
} from "../../../scripts/viz-http.mjs";
// 只借三个常量(目录名 + 单条请求上限),不借轮询逻辑——那是桥进程那一侧的事(viz-inbox.mjs
// 的轮询器活在 agent-bridge.mjs 里)。这里只管把请求写进 inbox、把回执从 outbox 读出来发给页面。
import { INBOX_DIRNAME, OUTBOX_DIRNAME, REQUEST_MAX_BYTES } from "../../../scripts/viz-inbox.mjs";

/**
 * 起法（**两种都认**，docs/STATE-session-viz.md §1.2）：
 *   VIZ_DIR=<目录> node serve.mjs [端口]
 *   node serve.mjs <目录> [端口]
 *
 * ⚠️ 位置参数必须**先判是不是合法端口**再判是不是目录，且**非法输入要给人话**。
 *    早先这里是 `Number(process.argv[2] || …)` 一把梭：传进来任何非数字都变成 `NaN`，
 *    然后在 `server.listen` 里炸出一个 `ERR_SOCKET_BAD_PORT`——
 *    看到那条报错的人根本猜不到自己是把目录传到端口位上了。
 */
function isPort(s) {
  if (!/^\d+$/.test(String(s))) return false;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < 65536;
}
const argv = process.argv.slice(2).filter(Boolean);
let argDir = null, argPort = null;
for (const a of argv) {
  if (argPort === null && isPort(a)) { argPort = Number(a); continue; }
  if (argDir === null) { argDir = a; continue; }
  console.error(`多余的参数：${a}`); process.exit(2);
}

const VIZ_DIR = process.env.VIZ_DIR || argDir;
if (!VIZ_DIR) {
  console.error("用法：VIZ_DIR=<目录> node serve.mjs [端口]   或   node serve.mjs <目录> [端口]");
  process.exit(2);
}
if (!fs.existsSync(VIZ_DIR)) { console.error(`目录不存在：${VIZ_DIR}`); process.exit(2); }

const portEnv = process.env.VIZ_PORT ?? process.env.PORT;
if (portEnv != null && String(portEnv).trim() !== "" && !isPort(portEnv)) {
  console.error(`端口不合法：${portEnv}（要 0~65535 的整数）`); process.exit(2);
}
const port = argPort ?? (isPort(portEnv) ? Number(portEnv) : 0);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(HERE, "index.html");
const RECONCILE_MJS = path.join(HERE, "reconcile.mjs");

const PROTOCOL_VERSION = 1;
const SUPPORTED_SCHEMA = new Set([1]);

/** 状态轮询间隔。快照只在里程碑写，poll 只是"有没有新的一代"的探测。 */
const POLL_MS = 400;
/** sidecar 轮询间隔。UIREQ 要求约 1 秒一动。 */
const PROGRESS_MS = 900;
/** owner 没了且没有客户端之后的宽限期。 */
const GRACE_MS = 60000;
/** 安全 path segment 判据(sessionId / reqId 共用一套)。inbox 写入侧与 outbox 读取侧
 *  **各自**用它验一遍 —— 见 docs/STATE-session-viz.md §12.1「两侧互不信任」。
 *  ⚠️ 声明放在这儿而不是靠近路由:`pollOutbox()` 在文件里出现得更早,声明晚于它就是踩 TDZ
 *  (眼下只因为轮询是异步起的才没炸),这种"能跑但差一点就不能"的写法不留。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

// ── 身份与存活 ──────────────────────────────────────────────────────────────

let META = null;
try { META = JSON.parse(fs.readFileSync(path.join(VIZ_DIR, "meta.json"), "utf8")); }
catch { console.error("读不到 meta.json，目录不像一个 viz run"); process.exit(2); }

/**
 * 「追问」的凭证。docs/DESIGN-session-viz-send-lock-2026-08-04.md §5 第 2 条：
 * 不是要人记的密码，是这个进程随机生成、只活在内存里的一串长字符——进程一关就作废，
 * 不写文件、不写死在代码里。**「一次性」指「每次起一次服务重新生成一次」，不是用一次就失效的
 * 验证码语义。** 页面加载时被注入进 HTML(见 `sendIndexHtml`），不拼进 URL——
 * URL 里的东西会进浏览器历史、会经 Referer 头泄漏，注入进响应体不会,因为能拿到这个凭证的人
 * 本来就已经能读到这次运行的全部委托内容(今天所有 GET 路由都没有鉴权)。
 */
const VIZ_TOKEN = crypto.randomBytes(32).toString("hex");

/** `server.listen(0, ...)` 之后才知道真实端口，Origin 校验要用它。 */
let ACTUAL_PORT = null;

/**
 * owner 还在不在。
 *
 * ⚠️ 只按 pid 判会误判——操作系统会把号码回收再分给别的进程。
 *    但这里比 cleanup 宽松：判错的代价只是页面晚一点进终态，不是删错东西。
 *    所以 pid 存活 + 目录还在，两者都成立才算活着。
 */
function ownerAlive() {
  try { if (!fs.existsSync(VIZ_DIR)) return false; } catch { return false; }
  const pid = META?.pid;
  if (!Number.isSafeInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// ── 双槽读 ──────────────────────────────────────────────────────────────────

const isStr = (v) => typeof v === "string" && v.length > 0;
const isBool = (v) => typeof v === "boolean";

/**
 * §2.1 第 ④ 条：**必填字段全在、类型对**。
 *
 * ⚠️ 这不是把独立校验器搬进 viewer——语义矩阵（§4.9）仍然只归 `tests/contract-invariants-session.mjs`。
 *    viewer 这一层要回答的是另一个问题：**手上这坨字节，是不是一份快照。**
 *    早先只判 `run` 真值 + `sessions` 是数组，于是一个 `{run:{},sessions:[]}` 的空壳
 *    只要 generation 更大就能顶掉旁边那份完好的快照，页面当场清空——
 *    **而这正是双槽协议存在的理由**：另一个槽好端端的，却因为判据太浅没被选上。
 *
 * 深度就到「结构完整性」为止：每层的必填键在不在、基本类型对不对。
 * 再往里走会变成第二份语义校验器，两份实现迟早漂成两个答案（§11）。
 */
function looksLikeSnapshot(p) {
  const r = p.run;
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  if (!Number.isSafeInteger(r.pid)) return false;
  if (!isStr(r.bridgeVersion) || !isStr(r.startedAt)) return false;
  if (r.status !== "running") return false;                          // §4 只有这一档
  if (!isBool(r.degraded) || !Array.isArray(r.recordingErrors)) return false;
  if (!isStr(p.updatedAt)) return false;
  if (!Array.isArray(p.sessions)) return false;
  for (const s of p.sessions) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return false;
    if (!isStr(s.sessionId) || !isStr(s.agent) || !isStr(s.status)) return false;
    if (!Array.isArray(s.turns)) return false;
    for (const t of s.turns) {
      if (!t || typeof t !== "object" || Array.isArray(t)) return false;
      if (!Number.isSafeInteger(t.turnNo) || !isStr(t.vizTurnId)) return false;
      if (t.state !== "dispatched" && t.state !== "settled") return false;
      if (!t.input || typeof t.input !== "object") return false;
      if (!t.output || typeof t.output !== "object") return false;
    }
  }
  return true;
}

/**
 * 读一个槽。返回 `{ raw, parsed }` 或 `null`。
 *
 * **合法槽四条**（docs/STATE-session-viz.md §2.1）——缺一不可，且**「generation 更高但 runId 不符者不得胜出」**：
 * 上一个 run 被 SIGKILL 留下的槽 generation 可能远大于新 run，
 * 只按 generation 排序会让页面显示上一个 run 的内容。
 */
async function readSlot(i) {
  let raw;
  try { raw = await fsp.readFile(path.join(VIZ_DIR, `state.${i}.json`), "utf8"); }
  catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }          // 撕裂读 → 直接判非法
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.runId !== META.runId) return null;                     // ①
  if (!Number.isSafeInteger(parsed.generation) || parsed.generation < 1) return null;  // ②
  if (!SUPPORTED_SCHEMA.has(parsed.schemaVersion)) return null;     // ③
  if (!looksLikeSnapshot(parsed)) return null;                      // ④ 必填结构
  return { raw, parsed };
}

/**
 * ⚠️ **两槽 generation 相等 ⇒ 双方都不可信**（docs/STATE-session-viz.md §2.1）。
 *
 * 健康的 run 里到不了这个状态：写成功才推进代次并换槽，两槽必然差 1 以上。
 * 真出现就说明有东西在这个目录里乱写。静默择一（原来的 `>=` 就是静默择一）
 * 等于**在最该报警的时刻挑一份看着像的展示出来**——而这时候两份都可能是伪造的。
 * 返回 `null` 会走 `history-read-failure`：「我暂时读不到」，正是此刻唯一诚实的说法。
 */
async function readLatestState() {
  const [a, b] = await Promise.all([readSlot(0), readSlot(1)]);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  if (a.parsed.generation === b.parsed.generation) return null;
  return a.parsed.generation > b.parsed.generation ? a : b;
}

// ── SSE 客户端 ──────────────────────────────────────────────────────────────

const clients = new Set();

function frame(event, dataStr) { return `event: ${event}\ndata: ${dataStr}\n\n`; }

/**
 * 一个客户端。
 *
 * **背压**（docs/STATE-session-viz.md §6）：每客户端只保留**一份可合并的最新 `state`**，
 * 新的直接盖掉旧的、**不排队堆积**；progress 同理按 vizTurnId 合并。
 * 控制帧不合并（它们各说一件事，丢一个就丢了一个语义）。
 */
function makeClient(res) {
  const c = {
    res, writable: true,
    pendingState: null,                  // string | null —— 合并槽
    pendingProgress: new Map(),          // vizTurnId → string
    pendingControl: [],
    pendingSendResult: [],               // 追问回执:跟 control 同类,各说各的一件事,不合并
    dropped: 0,
    pumping: false,
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return c;
}

function kill(c) {
  c.writable = false;
  clients.delete(c);
  try { c.res.end(); } catch {}
  armGraceIfIdle();
}

function pushState(c, dataStr) {
  if (!c.writable) return;
  if (c.pendingState !== null) c.dropped++;      // 合并掉了一代
  c.pendingState = dataStr;
  pump(c);
}

function pushProgress(c, vizTurnId, dataStr) {
  if (!c.writable) return;
  c.pendingProgress.set(vizTurnId, dataStr);
  pump(c);
}

function pushControl(c, dataStr) {
  if (!c.writable) return;
  c.pendingControl.push(dataStr);
  pump(c);
}

function pushSendResult(c, dataStr) {
  if (!c.writable) return;
  c.pendingSendResult.push(dataStr);
  pump(c);
}

/** 广播给**所有**连着的客户端,不只是发起追问的那个标签页——开着两个标签页时两边都该看到。 */
function broadcastSendResult(dataStr) {
  for (const c of clients) pushSendResult(c, dataStr);
}

/** 遵守 `res.write()` 的背压：返回 false 就等 `drain`，**不无限缓冲**。 */
async function pump(c) {
  if (c.pumping || !c.writable) return;
  c.pumping = true;
  try {
    while (c.writable) {
      let chunk = null;
      if (c.pendingControl.length) {
        chunk = frame("control", c.pendingControl.shift());
      } else if (c.pendingSendResult.length) {
        chunk = frame("send-result", c.pendingSendResult.shift());
      } else if (c.pendingState !== null) {
        const s = c.pendingState; c.pendingState = null;
        if (c.dropped > 0) {
          const n = c.dropped; c.dropped = 0;
          chunk = frame("viz:overflow", JSON.stringify({ droppedFrames: n })) + frame("state", s);
        } else {
          chunk = frame("state", s);
        }
      } else if (c.pendingProgress.size) {
        const k = c.pendingProgress.keys().next().value;
        const v = c.pendingProgress.get(k); c.pendingProgress.delete(k);
        chunk = frame("progress", v);
      } else break;

      if (!c.res.write(chunk)) {
        await new Promise((r) => {
          const done = () => { c.res.off("drain", done); c.res.off("close", done); r(); };
          c.res.once("drain", done); c.res.once("close", done);
        });
      }
    }
  } catch { kill(c); }
  finally { c.pumping = false; }
}

// ── 控制态 ──────────────────────────────────────────────────────────────────

/**
 * 三种「看不到内容」必须严格区分（docs/STATE-session-viz.md §6.2）。混成一句话，页面就会做错事。
 *   - `run-gone`             ← owner 死了 / 目录没了：记录**已经没有了**
 *   - `history-read-failure` ← owner 还活着但两槽都读不出来：**我暂时读不到**
 *   - 断连                    ← 传输层的事，页面自己重连
 */
const control = { runGone: false, historyReadFailure: false };

function broadcastControl(kind) {
  const data = JSON.stringify({ kind });
  for (const c of clients) pushControl(c, data);
}

/**
 * 返回**是否发生了 true → false 的恢复沿**。调用方必须据此重发一次 state。
 *
 * ⚠️ 只清内部标志是不够的。页面收到 `history-read-failure` 之后会挂出「暂时读不到」，
 *    而清除这句话的**唯一**信号是下一帧 `state`——但 `pollState` 有一道
 *    `generation <= lastGeneration 就不发` 的去重闸。于是：短暂读不到、随后
 *    在**同一代**上恢复（快照根本没变过，这恰恰是最常见的情形——瞬时 IO 抖动），
 *    页面就永久停在那句话上，**而记录一直好端端地在那儿**。
 *    去重闸本身没错，错在拿它当"要不要发"的唯一判据；恢复沿是第二个判据。
 */
function setHistoryReadFailure(on) {
  if (control.historyReadFailure === on) return false;
  control.historyReadFailure = on;
  if (on) { broadcastControl("history-read-failure"); return false; }
  return true;
}

function setRunGone() {
  if (control.runGone) return;
  control.runGone = true;
  broadcastControl("run-gone");
  armGraceIfIdle();
}

/**
 * 补发给新连上的客户端。
 *
 * ⚠️ **控制态与实时预览都要补**——少了这一步，刷新一次页面就把终态和当前预览一起忘了。
 *    这不是锦上添花：一个卡住的轮次，sidecar 内容根本不会再变，
 *    不补发就等于**永远不给**。
 */
function replayFor(c) {
  if (control.runGone) pushControl(c, JSON.stringify({ kind: "run-gone" }));
  else if (control.historyReadFailure) pushControl(c, JSON.stringify({ kind: "history-read-failure" }));
  for (const [vizTurnId, p] of lastProgress) pushProgress(c, vizTurnId, p.data);
}

// ── 轮询 ────────────────────────────────────────────────────────────────────

let lastGeneration = 0;
let lastStateRaw = null;
/**
 * vizTurnId → `{ raw, data }`：`raw` 用来去重，`data` 用来**补发给新客户端**。
 *
 * ⚠️ 两个用途缺一不可。只留去重、不留补发，就会出现这个要命的组合：
 *    服务端发过一次（哪怕当时一个客户端都没有）→ 之后连上来的页面**永远收不到当前预览**，
 *    只能等下一次内容变化。而「内容长时间不动」恰恰是**卡住的轮次**的特征——
 *    于是「你因为怀疑它卡了才去开页面，页面偏偏这时候什么都不给你看」。
 *    （graph 那边同一形状的坑是「刷新一次就把『记录已损坏』忘了」。）
 */
const lastProgress = new Map();
/** 仍需轮询的 sidecar：vizTurnId → { sessionId, turnNo }。 */
let activeSidecars = new Map();

async function pollState() {
  if (!ownerAlive()) { setRunGone(); return; }
  const slot = await readLatestState();
  if (!slot) {
    // ⚠️ owner 还活着但读不出来 —— 这是**第三种情况**，不许冒充 degraded、
    //    不许假装断连、不许当成 run gone（那会让页面进"已清除"终态，而记录其实还在）。
    setHistoryReadFailure(true);
    return;
  }
  const recovered = setHistoryReadFailure(false);
  if (slot.parsed.generation <= lastGeneration) {
    // 代次没推进，但刚从「读不到」里恢复 —— 必须重发一次当前 state 把那句话冲掉。
    if (recovered && lastStateRaw) for (const c of clients) pushState(c, lastStateRaw);
    return;
  }
  lastGeneration = slot.parsed.generation;
  lastStateRaw = slot.raw;

  // 重算还要不要轮询哪些 sidecar：**只有快照里仍是 dispatched 的轮次**（docs/STATE-session-viz.md §5 前提 2）。
  const next = new Map();
  for (const s of slot.parsed.sessions || []) {
    for (const t of s.turns || []) {
      if (t.state === "dispatched" && t.vizTurnId) {
        next.set(t.vizTurnId, { sessionId: s.sessionId, turnNo: t.turnNo });
      }
    }
  }
  // 已经结算的立刻停轮询并忘掉——迟到的 sidecar 永远不该让它回退。
  for (const k of lastProgress.keys()) if (!next.has(k)) lastProgress.delete(k);
  activeSidecars = next;

  for (const c of clients) pushState(c, lastStateRaw);
}

/**
 * 「同一 sidecar 路径的读不并发」这句话，**光靠一个 `for await` 是保证不了的**。
 *
 * 定时器每 900ms 叫一次，而新客户端连进来时 `handleEvents` 也会叫一次——
 * 两条路径各自跑一遍循环，同一个文件就有两个 read 同时在飞。
 * 先发的那次晚返回时，`lastProgress` 被**旧内容**盖回去并广播出去，
 * 页面上的实时预览当场时间倒流。
 *
 * 修法是共用同一次在途读取（in-flight promise），而不是各跑各的：
 * 后来者拿到的是**同一个** Promise，读只发生一次，顺序也就只有一种。
 *
 * （`pollState` 不需要这道闸：它有 `generation <= lastGeneration 就返回` 的单调闸，
 *   晚到的旧代次过不去——判据本身就带序。这里没有这样的序，才必须靠互斥补上。）
 */
let progressInflight = null;
function pollProgress() {
  if (progressInflight) return progressInflight;
  progressInflight = doPollProgress().finally(() => { progressInflight = null; });
  return progressInflight;
}

async function doPollProgress() {
  if (control.runGone || activeSidecars.size === 0) return;
  for (const [vizTurnId, loc] of activeSidecars) {
    let raw;
    try {
      raw = await fsp.readFile(
        path.join(VIZ_DIR, "turns", loc.sessionId, `t${loc.turnNo}.progress.json`), "utf8");
    } catch { continue; }                      // 结算后会被删掉，读不到很正常
    let p;
    try { p = JSON.parse(raw); } catch { continue; }
    // 前提 3：sidecar 里的 vizTurnId 必须**等于**当前 turn 的。
    if (p?.vizTurnId !== vizTurnId) continue;
    if (lastProgress.get(vizTurnId)?.raw === raw) continue;
    const data = JSON.stringify({ sessionId: loc.sessionId, ...p });
    lastProgress.set(vizTurnId, { raw, data });
    for (const c of clients) pushProgress(c, vizTurnId, data);
  }
}

/**
 * 追问回执的轮询。**跟 `pollState` 同量级间隔**——见
 * docs/DESIGN-session-viz-send-lock-2026-08-04.md §5 第 3 条,不引入 `fs.watch`。
 *
 * serve.mjs 是 `outbox/` 的唯一读者(桥进程只写),读完立刻删——不删的话同一条回执会
 * 每一拍重发一次。**没有任何客户端在听时也照删**:那条回执对应的发送动作已经真的执行了
 * (桥那边先删 inbox 请求、再调用真正的发送逻辑),这里只是「通知」这一层，
 * 丢一次通知不等于丢一次发送——观测台正常的状态快照轮询里迟早会看到那一轮出现。
 */
async function pollOutbox() {
  const outboxRoot = path.join(VIZ_DIR, OUTBOX_DIRNAME);
  let sessionDirs;
  try { sessionDirs = await fsp.readdir(outboxRoot, { withFileTypes: true }); }
  catch { return; } // 目录还没建(还没有过一条回执)——正常
  for (const sEnt of sessionDirs) {
    if (!sEnt.isDirectory?.()) continue;
    const sessionId = sEnt.name;
    // 目录名也要自己验一遍字符集(§12.1「两侧各自校验」)。写方验过不代表读方可以不验——
    // 这条目录是文件系统给的,不是桥递过来的:任何进程都能在 outbox 底下建一个带空格/控制符
    // 的目录名。放它过去,那些帧会带着非法 sessionId 进到页面的缓冲里。
    if (!SAFE_SESSION_ID.test(sessionId) || sessionId === "." || sessionId === "..") continue;
    const dir = path.join(outboxRoot, sessionId);
    let files;
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const name of files) {
      const m = /^resp-(.+)\.json$/.exec(name);
      if (!m) continue;
      const fileReqId = m[1];
      if (!SAFE_SESSION_ID.test(fileReqId)) continue;   // reqId 同理:同一套安全 segment 判据
      const fp = path.join(dir, name);
      let raw;
      try { raw = await fsp.readFile(fp, "utf8"); } catch { continue; }
      try { await fsp.unlink(fp); } catch {}
      let body;
      try { body = JSON.parse(raw); } catch { continue; } // 撕裂读概率极小,跳过=丢一次通知,不致命(见上)
      /* ⚠️ **两侧互不信任**(docs/STATE-session-viz.md §12.1):这一层要自己把回执校验一遍,
            不能因为"写的人是桥"就把正文当可信输入。第一版写的是 `{ sessionId, ...body }` ——
            展开在后,**正文里的 `sessionId` 会盖掉目录来源**,一份 `outbox/A/resp-r.json`
            只要正文写 `{"sessionId":"B"}` 就会被广播成 B 的回执,落到别的会话的输入框上。
            所以:字段逐个校验,`sessionId` **只认目录名**,`reqId` 还要跟文件名对得上
            (对不上说明这份文件跟它的名字不是一回事,整份丢掉比按错的 reqId 认领安全)。 */
      if (!body || typeof body !== "object" || Array.isArray(body)) continue;
      if (body.reqId !== fileReqId) continue;
      if (typeof body.ok !== "boolean") continue;
      broadcastSendResult(JSON.stringify({
        sessionId,                       // 目录来源,不取正文
        reqId: fileReqId,
        ok: body.ok,
        error: typeof body.error === "string" ? body.error : null,
        result: body.result ?? null,
        respondedAt: typeof body.respondedAt === "string" ? body.respondedAt : null,
      }));
    }
  }
}

const statePoll = setInterval(() => { pollState().catch(() => {}); }, POLL_MS);
const progPoll = setInterval(() => { pollProgress().catch(() => {}); }, PROGRESS_MS);
const outboxPoll = setInterval(() => { pollOutbox().catch(() => {}); }, POLL_MS);
const hb = setInterval(() => {
  for (const c of clients) { if (c.writable) { try { c.res.write(":hb\n\n"); } catch { kill(c); } } }
}, 15000);

// ── 宽限退出 ────────────────────────────────────────────────────────────────

let graceTimer = null;

/**
 * ⚠️ **owner 存活期间绝不退出**，哪怕一个客户端都没有。
 *
 * 「无客户端满 N 分钟自灭」会让「提前起服务、晚点再看」的链接失效——
 * 而那恰恰是这个页面最常见的用法（先开着，出了事再去看）。
 */
function armGraceIfIdle() {
  if (graceTimer) return;
  if (!control.runGone) return;
  if (clients.size > 0) return;
  graceTimer = setTimeout(() => {
    if (clients.size === 0 && control.runGone) shutdown(0);
  }, GRACE_MS);
  graceTimer.unref?.();
}

function shutdown(code) {
  clearInterval(statePoll); clearInterval(progPoll); clearInterval(hb); clearInterval(outboxPoll);
  for (const c of clients) { try { c.res.end(); } catch {} }
  try { server.close(); } catch {}
  process.exit(code);
}

// ── 路由 ────────────────────────────────────────────────────────────────────

async function handleEvents(req, res) {
  if (req.method !== "GET") return sendMethodNotAllowed(res, "GET");
  const c = makeClient(res);
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  req.on("close", () => kill(c));

  // 连上先发 hello，再发**当前** state。**不回放历史**——快照本来就是全量当前态。
  try {
    c.res.write(frame("hello", JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, runId: META.runId, schemaVersion: 1,
      // 页面要能对用户说出「余下部分请直接打开这个文件」的**绝对路径**，
      // 而它手上只有相对 ref——这个字段就是为了补上那一截。
      vizDir: VIZ_DIR,
    })));
  } catch { return kill(c); }

  // ⚠️ 先把状态**刷新一次**再发。否则「服务先起、页面晚开」时，
  //    首帧发的是 `lastStateRaw` 那份陈旧快照，而 `activeSidecars` 也还没建好。
  //
  // ⚠️ **刷新期间这个客户端还没进 `clients`**，这是刻意的：
  //    进去了就会被 `pollState` 的广播扫到，紧接着自己又发一遍，
  //    于是同一代快照发两次。全量快照重发无害，但"无害"不是"对"——
  //    发两遍说明有两条路径在负责同一件事，早晚会漂成两个不同的答案。
  await pollState().catch(() => {});
  await pollProgress().catch(() => {});
  clients.add(c);

  const slot = lastStateRaw ? { raw: lastStateRaw } : await readLatestState();
  if (slot) pushState(c, slot.raw);
  else if (ownerAlive()) setHistoryReadFailure(true);
  replayFor(c);
}

// ── 追问:装锁 + 写 inbox ────────────────────────────────────────────────────


/**
 * 校验来源。**这不是唯一那道锁**——浏览器对带自定义头的跨站 POST 会先发一次 OPTIONS 预检,
 * 这里从不回放行别的来源的 CORS 头,预检不过浏览器根本不会把真正的 POST 发出来;
 * 这里的检查防的是**不遵守 CORS 的非浏览器客户端**(docs/DESIGN-session-viz-send-lock-2026-08-04.md §3)。
 */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin || ACTUAL_PORT == null) return false;
  return origin === `http://127.0.0.1:${ACTUAL_PORT}`;
}

/** 定长比较,避免时序侧信道——虽然本机单用户场景下这条攻击成本本来就很高，但做起来不贵。
 *
 *  ⚠️ **先比字节长度,不能比 `String.length`。** 后者是 UTF-16 码元数:一个 64 个非 ASCII 字符的
 *     token 头能跟 64 字符的真 token 长度相等,但 UTF-8 buffer 长度不同,`timingSafeEqual` 会
 *     直接抛 `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` —— 那就不是"拒绝"而是"路由抛异常"了。 */
function tokenOk(req) {
  const got = req.headers["x-viz-token"];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(VIZ_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 读请求体，超过上限就不再往内存里攒——但**照样把流排空到 `end`，不 `destroy()`**。
 *
 * ⚠️ 早先这里超限就 `req.destroy()`，客户端收到的是 `ECONNRESET`（socket hang up），
 *    永远看不到 413，也看不到「消息太长」这句人话——只有一个网络层的报错，
 *    分不清是自己写岔了还是页面本身坏了。本机单用户场景下，排空一份超大 body
 *    的代价可以接受，换来的是**响应总能正常发出去**。
 */
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let overLimit = false;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { overLimit = true; return; } // 继续排空，只是不再攒进内存
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overLimit) reject(Object.assign(new Error("request body too large"), { code: "too_large" }));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/**
 * `POST /send`——三道锁按顺序过(方法 → 来源 → 凭证),再限内容类型与体积,
 * 通过之后**只做一件事**:把 `{message}` 原子写进 `inbox/<sessionId>/req-<reqId>.json`,
 * 回 202 + reqId。**真正的发送逻辑不在这里**——那是桥进程里 `sendFollowupFromViz` 的事,
 * 这条路由只管把请求安全地递过去。
 */
async function handleSend(req, res) {
  // ⚠️ **这里不能用共用的 `sendMethodNotAllowed()`** —— 它回的是 `text/plain`(给 `/events`
  //    和 `/file` 那两个本来就是文本的端点用的),而 §12.6 说死了 `/send` 的**所有**响应都是 JSON。
  //    照着合同写的客户端会对每个响应调 `response.json()`,碰上 text/plain 就直接抛。
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
  if (!originOk(req)) return sendJson(res, 403, { error: "origin not allowed" });
  if (!tokenOk(req)) return sendJson(res, 401, { error: "missing or wrong token" });
  const ct = String(req.headers["content-type"] || "");
  if (!/^application\/json\b/i.test(ct)) return sendJson(res, 415, { error: "expected application/json" });

  let raw;
  try { raw = await readBodyCapped(req, REQUEST_MAX_BYTES); }
  catch (e) {
    if (e?.code === "too_large") return sendJson(res, 413, { error: "request body too large" });
    return sendJson(res, 400, { error: "failed to read request body" });
  }

  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { return sendJson(res, 400, { error: "body is not valid JSON" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, { error: "body must be an object" });
  }
  const sessionId = body.sessionId;
  const message = body.message;
  if (typeof sessionId !== "string" || sessionId === "." || sessionId === ".." || !SAFE_SESSION_ID.test(sessionId)) {
    return sendJson(res, 400, { error: "sessionId is missing or malformed" });
  }
  if (typeof message !== "string" || !message.trim()) {
    return sendJson(res, 400, { error: "message is required" });
  }

  const reqId = crypto.randomUUID();
  const dir = path.join(VIZ_DIR, INBOX_DIRNAME, sessionId);
  const finalPath = path.join(dir, `req-${reqId}.json`);
  const tmpPath = path.join(dir, `.tmp-${reqId}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmpPath, Buffer.from(JSON.stringify({ message }), "utf8"));
    await fsp.rename(tmpPath, finalPath);
  } catch {
    try { await fsp.unlink(tmpPath); } catch {}
    return sendJson(res, 500, { error: "failed to queue the message" });
  }
  sendJson(res, 202, { reqId });
}

function handleFile(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendMethodNotAllowed(res);
  // 放行范围就是这个 run 的目录。ref 只可能指向 `turns/<sid>/…`——
  // 但**不额外加前缀闸**：VIZ_DIR 是 mkdtemp 出来的专属目录，里面除了本 run 的东西什么都没有。
  const r = resolveWithin(VIZ_DIR, url.searchParams.get("ref"));
  if (r.code) return sendPlain(res, r.code, r.msg);
  sendArchivedFile(req, res, r.abs, { shaHeader: "X-Viz-Sha256", maxBytes: VIZ_FILE_MAX_BYTES });
}

function sendLocal(res, file, type) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return sendPlain(res, 500, "页面文件缺失"); }
  res.writeHead(200, {
    "Content-Type": type, "Content-Length": bytes.length,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

/**
 * index.html 单独一份发法：**读文件 + 替换占位符**,不是纯静态转发——把凭证注入进去。
 * 占位符是 HTML 注释,页面自身不受影响;找不到占位符（文件被换过）时**不吞错**，
 * 直接照原样发但记一行 stderr——总比悄悄发一份没有凭证、页面永远发不出追问的版本更好排查。
 */
function sendIndexHtml(res) {
  let html;
  try { html = fs.readFileSync(INDEX_HTML, "utf8"); } catch { return sendPlain(res, 500, "页面文件缺失"); }
  const marker = "<!--VIZ_TOKEN_INJECT:";
  const idx = html.indexOf(marker);
  if (idx === -1) {
    console.error("index.html 里找不到 VIZ_TOKEN_INJECT 占位符——凭证没注入，页面发不出追问");
  } else {
    const end = html.indexOf("-->", idx);
    if (end !== -1) {
      html = html.slice(0, idx) + `<script>window.__VIZ_TOKEN__=${JSON.stringify(VIZ_TOKEN)};</script>` + html.slice(end + 3);
    }
  }
  const bytes = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    // ⚠️ **禁止被别的站点套进 iframe。** 三道锁(方法/来源/凭证)挡的是"别的站点**自己**发请求"——
    //    但只要这个页面能被嵌进去,被嵌的仍然是 `127.0.0.1` 这个 origin:它读得到注入的凭证、
    //    它自己发的 fetch 也天然满足 Origin 检查。攻击者不需要绕过任何一道锁,
    //    只要把真实的输入框透明地盖在诱饵按钮下面,骗用户**亲手**打字并点发送即可(clickjacking)。
    //    两个头一起给:CSP 是现代浏览器的正解,X-Frame-Options 兜住老实现。
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
  res.end(bytes);
}

function sendJson(res, code, obj, extraHeaders = null) {
  const bytes = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(bytes);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return sendPlain(res, 400, "坏请求"); }
  if (url.pathname === "/events") return void handleEvents(req, res).catch(() => {});
  if (url.pathname === "/file") return handleFile(req, res, url);
  /* ⚠️ 吞掉异常但**必须还是回一个响应**。原来是 `.catch(() => {})` ——`handleSend` 里任何
        一处意外抛出,客户端就等到天荒地老(页面那边只会看到 fetch 一直挂着,连"失败"都不算),
        而这条链路上正好有过一个会抛的分支(token 长度不等时的 `timingSafeEqual`)。 */
  if (url.pathname === "/send") {
    return void handleSend(req, res).catch(() => {
      try { if (!res.headersSent) sendJson(res, 500, { error: "internal error" }); else res.end(); } catch {}
    });
  }
  if (url.pathname === "/reconcile.mjs") return sendLocal(res, RECONCILE_MJS, "text/javascript; charset=utf-8");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return sendIndexHtml(res);
  }
  sendPlain(res, 404, "没有这个地址");
});

server.listen(port, "127.0.0.1", () => {
  const a = server.address();
  ACTUAL_PORT = a.port;
  console.log(`session-viz  http://127.0.0.1:${a.port}/   run=${META.runId}`);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
