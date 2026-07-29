/**
 * 委托会话史观测台 —— viewer 侧。
 *
 * **合同在同目录的 `STATE.md`。** 本文件只做三件事：
 *   ① 按 §2 的双槽协议挑出最新合法快照，**原样透传**给页面
 *   ② 轮询活跃轮次的 sidecar，作为独立的 `progress` 帧发出去
 *   ③ 按 §6.3 的判据把归档文件安全地发出去
 *
 * ⚠️ **viewer 是搬运工，不是第二个 writer**（STATE.md §6）：`state` 帧是槽文件的
 *    字节原样透传，不重新序列化、不补字段、不把 sidecar 合进去。
 *
 * 起法：`VIZ_DIR=<目录> node serve.mjs [port]`
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VIZ_FILE_MAX_BYTES, resolveWithin, sendArchivedFile, sendPlain, sendMethodNotAllowed,
} from "../../../scripts/viz-http.mjs";

/**
 * 起法（**两种都认**，STATE.md §1.2）：
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

// ── 身份与存活 ──────────────────────────────────────────────────────────────

let META = null;
try { META = JSON.parse(fs.readFileSync(path.join(VIZ_DIR, "meta.json"), "utf8")); }
catch { console.error("读不到 meta.json，目录不像一个 viz run"); process.exit(2); }

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
 * ⚠️ 这不是把独立校验器搬进 viewer——语义矩阵（§4.9）仍然只归 `contract-invariants.mjs`。
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
 * **合法槽四条**（STATE.md §2.1）——缺一不可，且**「generation 更高但 runId 不符者不得胜出」**：
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
 * ⚠️ **两槽 generation 相等 ⇒ 双方都不可信**（STATE.md §2.1）。
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
 * **背压**（STATE.md §6）：每客户端只保留**一份可合并的最新 `state`**，
 * 新的直接盖掉旧的、**不排队堆积**；progress 同理按 vizTurnId 合并。
 * 控制帧不合并（它们各说一件事，丢一个就丢了一个语义）。
 */
function makeClient(res) {
  const c = {
    res, writable: true,
    pendingState: null,                  // string | null —— 合并槽
    pendingProgress: new Map(),          // vizTurnId → string
    pendingControl: [],
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

/** 遵守 `res.write()` 的背压：返回 false 就等 `drain`，**不无限缓冲**。 */
async function pump(c) {
  if (c.pumping || !c.writable) return;
  c.pumping = true;
  try {
    while (c.writable) {
      let chunk = null;
      if (c.pendingControl.length) {
        chunk = frame("control", c.pendingControl.shift());
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
 * 三种「看不到内容」必须严格区分（STATE.md §6.2）。混成一句话，页面就会做错事。
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

  // 重算还要不要轮询哪些 sidecar：**只有快照里仍是 dispatched 的轮次**（STATE.md §5 前提 2）。
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

const statePoll = setInterval(() => { pollState().catch(() => {}); }, POLL_MS);
const progPoll = setInterval(() => { pollProgress().catch(() => {}); }, PROGRESS_MS);
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
  clearInterval(statePoll); clearInterval(progPoll); clearInterval(hb);
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

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return sendPlain(res, 400, "坏请求"); }
  if (url.pathname === "/events") return void handleEvents(req, res).catch(() => {});
  if (url.pathname === "/file") return handleFile(req, res, url);
  if (url.pathname === "/reconcile.mjs") return sendLocal(res, RECONCILE_MJS, "text/javascript; charset=utf-8");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return sendLocal(res, INDEX_HTML, "text/html; charset=utf-8");
  }
  sendPlain(res, 404, "没有这个地址");
});

server.listen(port, "127.0.0.1", () => {
  const a = server.address();
  console.log(`session-viz  http://127.0.0.1:${a.port}/   run=${META.runId}`);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
