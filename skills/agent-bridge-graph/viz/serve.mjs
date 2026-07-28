/**
 * graph 观测台的数据面 —— SSE + `/file`。
 *
 * **只读。** 不提供暂停、重跑、改参数、合分支;不裁决、也不驱动业务。
 * **不写任何状态文件**(判活只有一条合同:生命管道)。
 *
 * 由 `withBridge({viz:true})` 用 `fork()` 拉起,靠 IPC 收控制消息、靠管道 EOF 判 owner 结束。
 * 合同全文见 `skills/agent-bridge-graph/EVENTS.md` §8 与 §10.4~§10.6。
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const OUT_DIR = process.env.VIZ_OUT_DIR;
const GRAPH_ID = process.env.VIZ_GRAPH_ID;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** 归档根:`/file` 只放行这底下的东西。 */
const ARCHIVE_ROOT = path.join(OUT_DIR, "nodes", ".runs", GRAPH_ID);
const TRANSCRIPT = path.join(ARCHIVE_ROOT, "transcript.jsonl");
const INDEX_HTML = path.join(HERE, "index.html");

/** 每客户端 outbound 队列上限,按下发 SSE 帧的 UTF-8 字节计(心跳不计入)。 */
const QUEUE_LIMIT = 33554432; // 32 MiB
/** 文件 tail 的轮询间隔。 */
const POLL_MS = 500;
/** owner 结束且没有客户端之后的宽限期。 */
const GRACE_MS = 60000;
/** 可降级字段的阈值(与 EVENTS.md §3.3 同档,不许更小)。 */
const DEGRADE_THRESHOLD = 2048;

/* ============================================================
   控制槽
   ============================================================ */

const state = {
  /** { atSeq, lastGoodOffset, error } —— **我们写不下去** */
  recordingFailure: null,
  /** { result, endedAt } */
  ownerFinal: null,
  /** { reason } —— **我们读不回来**。⚠️ 与 recordingFailure 是两回事,文案不许共用。 */
  historyReadFailure: null,
  pipeEnded: false,
  drainSettled: false,
};

/**
 * owner 结束了没有。**把这件事收成一处。**
 *
 * ⚠️ 第三条里「已结束」**不能读成「成功完成」**:drain 允许失败。要求"成功"就会出现一个死角 ——
 * 管道 EOF、没有 `run:final`、没有 `owner-final`、最终 drain 又失败:`ownerEnded` 永远为 false,
 * **viewer 永不退出**。一个读历史失败的进程赖着不走,是纯粹的资源泄漏,还谁都不报错。
 */
function ownerEnded() {
  if (sawRunFinal) return true;
  if (state.ownerFinal) return true;
  return state.pipeEnded && state.drainSettled;
}
let sawRunFinal = false;

/** 超过 2 KiB 才降级;≤2 KiB **必须原样留字符串**(§3.3 第 1、4 条)。 */
function boundReason(s) {
  const str = String(s ?? "");
  const total = Buffer.byteLength(str, "utf8");
  if (total <= DEGRADE_THRESHOLD) return str;
  const head = Buffer.from(str, "utf8").subarray(0, 1024).toString("utf8").replace(/�$/, "");
  const tail = Buffer.from(str, "utf8").subarray(total - 1024).toString("utf8").replace(/^�/, "");
  return {
    totalBytes: total,
    sha256: crypto.createHash("sha256").update(str, "utf8").digest("hex"),
    head, tail,
    omittedBytes: total - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
  };
}

/* ============================================================
   客户端
   ============================================================ */

const clients = new Set();
let graceTimer = null;

function armGrace() {
  if (graceTimer) return;
  // ⚠️ `ownerEnded === false` 时**绝不退出** —— 哪怕一直没人打开页面。
  //    **不许有"无客户端 N 分钟就退出"的兜底**:它不要求 run 已结束,
  //    于是两小时的运行只要前十分钟没人看,viewer 就在半途消失了。
  if (!ownerEnded() || clients.size > 0) return;
  graceTimer = setTimeout(() => process.exit(0), GRACE_MS);
  graceTimer.unref?.();
}
function cancelGrace() {
  // ⚠️ **同步**取消,且必须与"把客户端登记进 clients"处在同一个同步段里。
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
}

/** 一个 SSE 客户端。 */
function makeClient(res) {
  const c = {
    res,
    /** 待发帧。**回放缓存与 live 积压是同一条队列。** */
    queue: [],
    queuedBytes: 0,
    writing: false,
    dead: false,
    mode: "replaying",
    /** 回放期间缓存的 live 事件(endOffset > cutOffset 的那些)。 */
    pending: [],
    /** 已下发过的 seq —— 回放与 live 交界处按它去重。 */
    seen: new Set(),
  };

  c.frame = (event, dataLine) => {
    if (c.dead) return;
    // 一帧 = `event: <名字>\n` + `data: <一行 JSON>\n` + `\n`。
    // ⚠️ 结尾那个空行是**帧边界**,不是美观 —— 少了它浏览器会一直缓着,页面永远收不到东西。
    const s = `event: ${event}\ndata: ${dataLine}\n\n`;
    const bytes = Buffer.byteLength(s, "utf8");
    // ⚠️ 队列上限之外要给 `viz:overflow` 预留余量,否则"超限时发一帧"这件事自己就发不出去,
    //    页面看到的只有一次无声的断开。
    if (c.queuedBytes + bytes > QUEUE_LIMIT) {
      const over = JSON.stringify({ queuedBytes: c.queuedBytes, limitBytes: QUEUE_LIMIT });
      // **具名事件,不是注释帧** —— 注释帧浏览器根本不交给页面。
      try { res.write(`event: viz:overflow\ndata: ${over}\n\n`); } catch { /* 已经断了 */ }
      kill(c);
      return;
    }
    c.queue.push(s);
    c.queuedBytes += bytes;
    pump(c);
  };

  return c;
}

function kill(c) {
  if (c.dead) return;
  c.dead = true;
  clients.delete(c);
  try { c.res.end(); } catch { /* 已经断了 */ }
  armGrace();
}

/** 遵守 `res.write()` 的背压:返回 false 就等 `drain`,**不无限缓冲**。 */
async function pump(c) {
  if (c.writing || c.dead) return;
  c.writing = true;
  try {
    while (c.queue.length && !c.dead) {
      const s = c.queue.shift();
      c.queuedBytes -= Buffer.byteLength(s, "utf8");
      if (!c.res.write(s)) {
        await new Promise((r) => {
          const done = () => { c.res.off("drain", done); c.res.off("close", done); r(); };
          c.res.once("drain", done);
          c.res.once("close", done);
        });
      }
    }
  } catch { kill(c); }
  finally { c.writing = false; }
}

/** 控制槽固定按 `recordingFailure` → `ownerFinal` 的顺序发。 */
function controlFramesFor(c) {
  if (state.recordingFailure) {
    c.frame("control", JSON.stringify({
      kind: "recording-failed",
      atSeq: state.recordingFailure.atSeq,
      lastGoodOffset: state.recordingFailure.lastGoodOffset,
      error: state.recordingFailure.error,
    }));
  }
  if (state.historyReadFailure) {
    c.frame("control", JSON.stringify({ kind: "history-read-failure", reason: state.historyReadFailure.reason }));
  }
  if (state.ownerFinal) {
    c.frame("control", JSON.stringify({
      kind: "owner-final", result: state.ownerFinal.result, endedAt: state.ownerFinal.endedAt,
    }));
  }
}

/** 把一条控制消息广播给所有**已经转 live** 的客户端;还在回放的那些等回放完再补。 */
function broadcastControl() {
  for (const c of clients) if (c.mode === "live") controlFramesFor(c);
}

/* ============================================================
   唯一的 tail reader
   ============================================================ */

let bytesRead = 0;
let pendingBuf = Buffer.alloc(0);
/** 可读到的硬上限。已知损坏之后提到 `lastGoodOffset` —— 越过它的字节**永不解析**。 */
let hardCap = Infinity;
let pumping = null;

/** 广播一条 transcript 原始行。⚠️ **原样透传**,不重新序列化 —— viewer 是搬运工,不是第二个 writer。 */
function broadcastLine(line, endOffset) {
  let seq = null;
  try { seq = JSON.parse(line).seq; } catch { /* 坏行:仍然透传,让页面自己判 */ }
  if (seq !== null) sawRunFinalCheck(line);
  for (const c of clients) {
    if (c.mode === "replaying" && endOffset > c.cutOffset) { c.pending.push({ line, seq }); continue; }
    if (c.mode !== "live") continue;
    if (seq !== null) { if (c.seen.has(seq)) continue; c.seen.add(seq); }
    c.frame("tx", line);
  }
}
function sawRunFinalCheck(line) {
  if (!sawRunFinal && line.includes('"run:final"')) {
    try { if (JSON.parse(line).event === "run:final") sawRunFinal = true; } catch { /* 坏行不算 */ }
  }
}

/** 读一次到 `min(fileSize, hardCap)`。**全局只有这一个 reader** —— 两个 reader 同时从旧偏移读
 *  会重复广播、会把多字节字符拼坏,这是确定的竞态。 */
async function readOnce() {
  let st;
  try { st = await fsp.stat(TRANSCRIPT); } catch { return; }
  const limit = Math.min(st.size, hardCap);
  if (limit <= bytesRead) return;
  const fh = await fsp.open(TRANSCRIPT, "r");
  try {
    const len = limit - bytesRead;
    const buf = Buffer.alloc(len);
    const { bytesRead: got } = await fh.read(buf, 0, len, bytesRead);
    bytesRead += got;
    pendingBuf = Buffer.concat([pendingBuf, buf.subarray(0, got)]);
    // ⚠️ **缓冲到下一个 `\n` 再解析**,绝不 JSON.parse 半行。
    let idx;
    let consumed = 0;
    while ((idx = pendingBuf.indexOf(0x0a, consumed)) !== -1) {
      const line = pendingBuf.subarray(consumed, idx).toString("utf8");
      consumed = idx + 1;
      if (line.length) broadcastLine(line, bytesRead - (pendingBuf.length - consumed));
    }
    pendingBuf = pendingBuf.subarray(consumed);
  } finally { await fh.close(); }
}

function pumpReader() {
  if (pumping) return pumping;
  pumping = readOnce().catch((e) => {
    state.historyReadFailure = { reason: boundReason(`tail 读失败:${e?.message ?? e}`) };
    broadcastControl();
  }).finally(() => { pumping = null; });
  return pumping;
}

const poll = setInterval(() => { pumpReader(); }, POLL_MS);
poll.unref?.();

/**
 * 收到 `recording-failed` 之后的最终 drain。
 *
 * ⚠️ **不是另起一个 reader**,而是把那个唯一 reader 的上限提到 `lastGoodOffset` 并 await 它。
 * ⚠️ **drain 自己失败也必须有出口**:进「历史读取失败」态,**然后照样公开控制槽** ——
 * 不然页面会一直假装"还在运行中",而且不会有任何报错(假绿里最阴的一种)。
 */
async function drainTo(offset) {
  hardCap = Math.min(hardCap, offset);
  try {
    // 等当前这一轮读完,再补一轮到 hardCap。
    if (pumping) await pumping;
    await pumpReader();
  } catch (e) {
    state.historyReadFailure = { reason: boundReason(`最终 drain 失败:${e?.message ?? e}`) };
  } finally {
    state.drainSettled = true;   // ⚠️ 「已结束」不等于「成功完成」
    broadcastControl();
    armGrace();
  }
}

/* ============================================================
   控制通道(父 → 子)
   ============================================================ */

process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.kind === "recording-failed" && !state.recordingFailure) {
    state.recordingFailure = { atSeq: m.atSeq, lastGoodOffset: m.lastGoodOffset, error: m.error };
    // 先 drain 到 lastGoodOffset,drain 结束后才公开控制状态 ——
    // 否则终态控制消息会排到更早的正常事件前面(§8.1 那条必现的错误时序)。
    drainTo(m.lastGoodOffset);
  } else if (m.kind === "owner-final" && !state.ownerFinal) {
    state.ownerFinal = { result: m.result, endedAt: m.endedAt };
    broadcastControl();
    armGrace();
  }
});

// **管道 EOF ⟺ owner 结束。** 这是判活的唯一合同 —— 不看进程树、不看端口、不看时钟。
process.on("disconnect", async () => {
  state.pipeEnded = true;
  try { await pumpReader(); } catch { /* 已在 pumpReader 里转成 historyReadFailure */ }
  state.drainSettled = true;
  broadcastControl();
  armGrace();
});

/* ============================================================
   HTTP
   ============================================================ */

/** 找出 `[0, size)` 里最后一个完整换行之后的排他偏移。 */
async function lastCompleteNewline(cap) {
  let st;
  try { st = await fsp.stat(TRANSCRIPT); } catch { return 0; }
  const end = Math.min(st.size, cap);
  if (end <= 0) return 0;
  const fh = await fsp.open(TRANSCRIPT, "r");
  try {
    const CHUNK = 65536;
    let pos = end;
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos - len);
      const i = buf.lastIndexOf(0x0a);
      if (i !== -1) return pos - len + i + 1;
      pos -= len;
    }
    return 0;
  } finally { await fh.close(); }
}

async function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const c = makeClient(res);
  // ⚠️ 登记与取消 grace 必须在**同一个同步段**里。
  clients.add(c);
  cancelGrace();
  req.on("close", () => { kill(c); });

  c.frame("hello", JSON.stringify({ graphId: GRAPH_ID, v: 1 }));

  // 已知损坏时,cutOffset 取 min(最后完整换行, lastGoodOffset)。
  const cap = state.recordingFailure ? state.recordingFailure.lastGoodOffset : Infinity;
  // ⚠️ 第 1、2 步之间**不得让出事件循环**:先占位,再去算真实 cutOffset。
  c.cutOffset = Infinity; // 占位:此刻所有 live 事件都先进 pending
  let cut = 0;
  try { cut = await lastCompleteNewline(cap); }
  catch (e) { state.historyReadFailure = { reason: boundReason(`读历史失败:${e?.message ?? e}`) }; }
  c.cutOffset = cut;

  // 异步流式回放 `[0, cutOffset)`。⚠️ **不许同步整文件读** ——
  //    本设计只封了每行 1 MiB,**从没封过 transcript 的总行数或总字节**。
  try {
    if (cut > 0) {
      const stream = fs.createReadStream(TRANSCRIPT, { start: 0, end: cut - 1, highWaterMark: 65536 });
      let buf = Buffer.alloc(0);
      for await (const chunk of stream) {
        if (c.dead) break;
        buf = Buffer.concat([buf, chunk]);
        let idx, consumed = 0;
        while ((idx = buf.indexOf(0x0a, consumed)) !== -1) {
          const line = buf.subarray(consumed, idx).toString("utf8");
          consumed = idx + 1;
          if (!line.length) continue;
          let seq = null;
          try { seq = JSON.parse(line).seq; } catch { /* 非末尾坏行:历史损坏 */ }
          // 已知损坏时,冲刷出去的事件必须满足 seq < atSeq
          if (state.recordingFailure && seq !== null && seq >= state.recordingFailure.atSeq) continue;
          if (seq !== null) c.seen.add(seq);
          c.frame("tx", line);
        }
        buf = buf.subarray(consumed);
      }
    }
  } catch (e) {
    state.historyReadFailure = { reason: boundReason(`回放失败:${e?.message ?? e}`) };
  }
  if (c.dead) return;

  // 回放结束 → 先按 seq 去重冲刷缓存 → **再**补发当前控制槽(顺序不能反)。
  for (const { line, seq } of c.pending) {
    if (seq !== null) { if (c.seen.has(seq)) continue; c.seen.add(seq); }
    c.frame("tx", line);
  }
  c.pending.length = 0;
  // ⚠️ **每个新客户端都要补发控制状态** —— 少了这一步,刷新一次页面就把"记录已损坏"忘了。
  controlFramesFor(c);
  c.mode = "live";
}

/** `/file` 的放行判据,**顺序不能换**。 */
function resolveRef(rawRef) {
  if (!rawRef) return { code: 400, msg: "缺 ref" };
  let ref;
  try { ref = decodeURIComponent(rawRef); } catch { return { code: 400, msg: "ref 解码失败" }; }
  // 词法:拒绝绝对路径、拒绝 `..`
  if (path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref.split(/[/\\]/).includes("..")) {
    return { code: 400, msg: "ref 不是合法相对路径" };
  }
  // ⚠️ **收到 out-dir 就不够**:outDir 可能是仓库根,那时 `?ref=.env` 是一个
  //    "没有绝对路径、没有 `..`、确实在 out-dir 内"的合法请求。只接受当前 graph 的归档前缀。
  const prefix = `nodes/.runs/${GRAPH_ID}/`;
  if (!ref.replace(/\\/g, "/").startsWith(prefix)) return { code: 403, msg: "不在本次运行的归档范围内" };
  const abs = path.join(OUT_DIR, ref);
  // realpath 复核:挡符号链接逃逸(**只测词法越界是不够的**)
  let real, rootReal;
  try { rootReal = fs.realpathSync.native(ARCHIVE_ROOT); } catch { return { code: 500, msg: "归档根不可达" }; }
  try { real = fs.realpathSync.native(abs); }
  catch (e) { return e.code === "ENOENT" ? { code: 404, msg: "文件已不在" } : { code: 500, msg: "读取失败" }; }
  const rel = path.relative(rootReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { code: 403, msg: "不在本次运行的归档范围内" };
  let st;
  try { st = fs.statSync(real); } catch { return { code: 500, msg: "读取失败" }; }
  if (!st.isFile()) return { code: 403, msg: "不是普通文件" };  // 拒绝目录
  return { abs: real };
}

function handleFile(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    // 缺了 Allow 就不是一个合法的 405
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD" });
    return res.end("不支持的请求方法\n");
  }
  const r = resolveRef(url.searchParams.get("ref"));
  if (r.code) {
    res.writeHead(r.code, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`${r.msg}\n`);
  }
  let bytes;
  // ⚠️ **先把字节读进内存,再按这份内存里的字节同时算 Content-Length 与 X-Graph-Sha256**。
  //    不许"stat 拿长度、再流式读发":那两步之间文件仍可能被改,于是响应头描述的
  //    与响应体发出的是两份不同的字节 —— 这正是本条要消灭的东西。
  try { bytes = fs.readFileSync(r.abs); }
  catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(code === 404 ? "文件已不在\n" : "读取失败\n");
  }
  res.writeHead(200, {
    // ⚠️ **绝不按扩展名回 text/html** —— 归档里每一个字节都是模型写的。
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": bytes.length,
    "X-Graph-Sha256": crypto.createHash("sha256").update(bytes).digest("hex"),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  res.end(bytes);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/events") return void handleEvents(req, res);
  if (url.pathname === "/file") return handleFile(req, res, url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    let html;
    try { html = fs.readFileSync(INDEX_HTML); }
    catch { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("页面文件读不到\n"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("没有这个路径\n");
});

// ⚠️ **只监听 localhost。** 无鉴权只在这个前提下成立 —— 绑到 0.0.0.0 就等于把本机 graph 归档
//    (里面是完整的 prompt 明文与模型产出)对整个网段开放。
server.listen(Number(process.env.VIZ_PORT || 0), "127.0.0.1", () => {
  const { port } = server.address();
  // 只报给父进程打印给人看 —— **viewer 起来了不进 transcript**。
  process.send?.({ kind: "viz-listening", port, url: `http://127.0.0.1:${port}/` });
});

// 心跳:SSE 注释帧,自成一帧。**不计入积压队列。**
const hb = setInterval(() => {
  for (const c of clients) { try { c.res.write(": hb\n\n"); } catch { kill(c); } }
}, 15000);
hb.unref?.();

pumpReader();
