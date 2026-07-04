#!/usr/bin/env node
// Agent Roundtable — 可视化 SSE 服务器(零依赖,仅 Node 内建)
//
// 用法:  node serve.mjs <run-dir> [--port N]
//   <run-dir>  一场圆桌的运行目录(含 transcript.jsonl),见 EVENTS.md
//   --port N   指定端口;省略用默认 7345,占用则回退到 OS 临时端口
//
// 契约:
//   - 只绑 127.0.0.1(不对外暴露)。
//   - GET /            → 内联前端(读同目录 index.html)
//   - GET /events      → SSE:连上先回放已有全部事件,再实时 tail 增量
//   - GET /file?ref=X  → 读 run-dir 内的旁挂产出(防目录穿越,只读)
//   - 自灭:transcript 出现 run:terminated 且最后一个客户端断开 + 宽限 60s → 退出;
//           始终无客户端满 10 分钟 → 退出。三重保险的第一重(另有 viz.pid + 主席显式 kill)。
//   - 启动成功打印一行  ROUNDTABLE_URL=http://127.0.0.1:<port>  供主席抓取。
//   - 服务器只读,绝不写 transcript.jsonl(真理源单一 writer = 主席)。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 7345;
const POLL_MS = 500;              // tail 轮询间隔(跨平台比 fs.watch 可靠,尤其 Windows)
const HEARTBEAT_MS = 25000;       // SSE 心跳注释,保活 + 探测死连接
const GRACE_AFTER_FINAL_MS = 60000;   // 终结后末个客户端断开的宽限
const IDLE_NO_CLIENT_MS = 600000;     // 始终无客户端的兜底自退(10 min)
const MAX_EVENTS = 20000;         // 内存里保留的事件行上限(防病态大文件 OOM)
const MAX_LINE_BYTES = 1 << 20;   // 单行 1MiB 上限,超长丢弃(真理源的行应很紧凑)

// ---- 参数 ----
const argv = process.argv.slice(2);
let runDir = null;
let wantPort = DEFAULT_PORT;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") { wantPort = parseInt(argv[++i], 10); if (!Number.isInteger(wantPort)) die("--port 需要整数"); }
  else if (!runDir) runDir = argv[i];
  else die(`多余参数: ${argv[i]}`);
}
if (!runDir) die("缺少 <run-dir>。用法: node serve.mjs <run-dir> [--port N]");
runDir = path.resolve(runDir);
if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) die(`run-dir 不存在或不是目录: ${runDir}`);
const TRANSCRIPT = path.join(runDir, "transcript.jsonl");

function die(msg) { process.stderr.write(`[roundtable-viz] ${msg}\n`); process.exit(1); }

// ---- 事件缓冲 + tail(单一 watcher,广播给所有 SSE 客户端)----
const events = [];        // 已见的原始 JSON 行(字符串),按序(见 MAX_EVENTS:有界窗口)
let bytesRead = 0;        // transcript.jsonl 已消费到的字节偏移
let pendingBuf = "";      // 不完整末行的缓冲(writer 崩溃可能留半行)
let decoder = new StringDecoder("utf8"); // 缓冲被 poll 切断的多字节 UTF-8 字符,避免半个字符解成 U+FFFD
let fileId = null;        // transcript 文件身份;变了 = 被替换 → 从头读
let terminated = false;   // 见到 run:terminated 后置真 → 触发自灭判定
const clients = new Set(); // 活跃 SSE 响应对象

// transcript 被截断/替换(异常;真理源本应严格 append-only)时,完整重置所有派生状态并让客户端也清空——
// 只重置偏移会让旧事件继续参与回放、旧 run:terminated 触发误退、前端按 seq 去重吞掉新文件的 seq=0。
function resetTail() {
  bytesRead = 0; pendingBuf = ""; decoder = new StringDecoder("utf8");
  events.length = 0; terminated = false;
  for (const res of clients) { try { res.write("event: reset\ndata: {}\n\n"); } catch {} } // 客户端收到后清空视图
  scheduleShutdownCheck(); // 清掉基于旧终态的 grace 计时
}
function identity(st) { return `${st.dev}:${st.ino}:${st.birthtimeMs}`; } // 跨平台文件身份(Windows 下 birthtimeMs 兜底)

function pushLine(raw) {
  const line = raw.trim();
  if (!line) return;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return; // 病态超长行,丢弃
  events.push(line);
  if (events.length > MAX_EVENTS) events.shift(); // 有界内存;回放对新客户端仍是当前保留窗口
  // 只为自灭判定做一次廉价 parse,失败忽略(前端负责真正的渲染解析)
  if (!terminated) {
    try { if (JSON.parse(line).event === "run:terminated") { terminated = true; scheduleShutdownCheck(); } }
    catch { /* 半行/坏行:忽略,不影响转发 */ }
  }
  broadcast(line);
}

// 轮询读增量:比 fs.watch 跨平台稳。处理文件尚未创建、以及异常截断。
function poll() {
  let st;
  try { st = fs.statSync(TRANSCRIPT); }
  catch { return; } // 文件还没出现(主席应先写 run:started 再起服务),下次再看
  const id = identity(st);
  if (fileId !== null && id !== fileId) resetTail(); // 文件被替换(即便同尺寸)→ 从头
  fileId = id;
  if (st.size < bytesRead) resetTail();              // 截断 → 从头
  if (st.size === bytesRead) return;
  let fd;
  try {
    fd = fs.openSync(TRANSCRIPT, "r");
    const len = st.size - bytesRead;
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, bytesRead);
    bytesRead += n;
    pendingBuf += decoder.write(buf.subarray(0, n)); // StringDecoder 缓冲不完整多字节,补齐才吐字符
    let nl;
    while ((nl = pendingBuf.indexOf("\n")) !== -1) {
      pushLine(pendingBuf.slice(0, nl));
      pendingBuf = pendingBuf.slice(nl + 1);
    }
    // 剩下的是不完整末行,留在 pendingBuf 等下一个 \n
  } catch { /* 读竞争,下轮重试 */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function broadcast(line) {
  const frame = `data: ${line}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch {} }
}

// ---- 自灭 ----
let graceTimer = null;
let idleTimer = null;
function scheduleShutdownCheck() {
  // 终结后且无客户端 → 宽限退出
  if (terminated && clients.size === 0) {
    if (!graceTimer) graceTimer = setTimeout(() => shutdown("final"), GRACE_AFTER_FINAL_MS);
  } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  // 始终无客户端 → 兜底空闲退出
  if (clients.size === 0) {
    if (!idleTimer) idleTimer = setTimeout(() => shutdown("idle"), IDLE_NO_CLIENT_MS);
  } else if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { fs.unlinkSync(path.join(runDir, "viz.pid")); } catch {}
  for (const res of clients) { try { res.end(); } catch {} }
  process.stderr.write(`[roundtable-viz] 退出(${reason})\n`);
  process.exit(0);
}

// ---- HTTP ----
function serveIndex(res) {
  let html;
  try { html = fs.readFileSync(path.join(HERE, "index.html")); }
  catch { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("index.html 缺失"); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function serveEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  // 回放已有全部(handler 同步执行,与轮询定时器不交错 → 无缺口/无重复)
  for (const line of events) res.write(`data: ${line}\n\n`);
  clients.add(res);
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, HEARTBEAT_MS);
  req.on("close", () => { clearInterval(hb); clients.delete(res); scheduleShutdownCheck(); });
}

// /file?ref=<run-dir 内相对路径>  —— 只读,严防目录穿越 + 符号链接逃逸
function serveFile(res, refRaw) {
  if (!refRaw) { res.writeHead(400, txt()).end("缺少 ref"); return; }
  let ref;
  try { ref = decodeURIComponent(refRaw); } catch { res.writeHead(400, txt()).end("ref 非法"); return; }
  if (path.isAbsolute(ref)) { res.writeHead(403, txt()).end("拒绝绝对路径"); return; }
  const resolved = path.resolve(runDir, ref);
  const root = runDir.endsWith(path.sep) ? runDir : runDir + path.sep;
  if (resolved !== runDir && !resolved.startsWith(root)) { res.writeHead(403, txt()).end("越界"); return; } // 词法先挡
  // 再用 realpath 解符号链接:真实目标必须仍在真实 runDir 内(挡 run-dir 内 symlink 指向外部)
  let realTarget, realRoot;
  try { realRoot = fs.realpathSync(runDir); realTarget = fs.realpathSync(resolved); }
  catch { res.writeHead(404, txt()).end("未找到"); return; } // 不存在的路径 realpath 会抛
  const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realTarget !== realRoot && !realTarget.startsWith(realRootSep)) { res.writeHead(403, txt()).end("越界(symlink)"); return; }
  let st;
  try { st = fs.statSync(realTarget); } catch { res.writeHead(404, txt()).end("未找到"); return; }
  if (!st.isFile()) { res.writeHead(403, txt()).end("非常规文件"); return; }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  fs.createReadStream(realTarget).on("error", () => { try { res.end(); } catch {} }).pipe(res);
}
const txt = () => ({ "Content-Type": "text/plain; charset=utf-8" });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "GET") { res.writeHead(405, txt()).end("仅 GET"); return; }
  if (u.pathname === "/") return serveIndex(res);
  if (u.pathname === "/events") return serveEvents(req, res);
  if (u.pathname === "/file") return serveFile(res, u.searchParams.get("ref"));
  res.writeHead(404, txt()).end("未找到");
});

// ---- 启动 + 端口回退 ----
function listen(port, isRetry) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && !isRetry) { listen(0, true); } // 回退 OS 临时端口
    else die(`监听失败: ${err.message}`);
  });
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address().port;
    try { fs.writeFileSync(path.join(runDir, "viz.pid"), String(process.pid)); } catch {}
    // 唯一约定输出:主席 grep 这一行拿 URL
    process.stdout.write(`ROUNDTABLE_URL=http://127.0.0.1:${actual}\n`);
    poll();                          // 立刻吃掉已有内容
    setInterval(poll, POLL_MS);      // 之后轮询增量
    scheduleShutdownCheck();         // 起步就挂空闲兜底(万一没人连)
  });
}

process.on("SIGINT", () => shutdown("signal"));
process.on("SIGTERM", () => shutdown("signal"));
listen(Number.isInteger(wantPort) ? wantPort : DEFAULT_PORT, false);
