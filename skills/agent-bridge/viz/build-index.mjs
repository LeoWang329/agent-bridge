/**
 * 把设计交付稿转成生产页面。
 *
 * **为什么是转换而不是重写**：`DESIGN-HANDOFF.md` 把导出件定义成**视觉合同**——
 * 「实现choice冲突时，先对齐导出的像素与行为，再重构内部」。
 * 从零重写会在移植过程中一点点磨掉那份合同（这正是它反复警告的
 * "flatten the design into generic cards / framework-default typography"）。
 * 所以这里**逐字保留** `<style>`、DOM 结构与全部渲染函数，只替换三段：
 *   §2 样本数据 → 数据层（wire 快照 → 展示模型）
 *   §8 实时模拟 → SSE 客户端
 *   §9 的原型态选择器 → 真实连接态
 * 外加删掉 Open Design 的原型控件（handoff 明令产品 UI 不许留 preview 控件）。
 *
 * 设计稿更新时重跑本脚本即可：
 *   node skills/agent-bridge/viz/build-index.mjs <设计稿.html>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
if (!SRC) { console.error("用法: node build-index.mjs <设计稿.html>"); process.exit(2); }

let html = fs.readFileSync(SRC, "utf8");
const before = html.length;

// ── 1. 删掉原型控件（design-process annotation，产品 UI 不许留） ─────────────
const protobox = /\n\s*<span class="protobox"[\s\S]*?<\/select>\s*<\/span>\n/;
if (!protobox.test(html)) throw new Error("找不到 protobox 标记，设计稿结构变了");
html = html.replace(protobox, "\n");

// data-od-id 是 Open Design 的埋点属性，产品 UI 不需要。
html = html.replace(/ data-od-id="[^"]*"/g, "");
html = html.replace(/ data-od-id='\+[^+]*\+'/g, "");
html = html.replace(/'\s*\+\s*esc\(slug\(s\)\)\s*\+\s*'/g, "");

// ── 1b. 把设计稿里的**样例读数**换成中性占位 ─────────────────────────────────
//
// ⚠️ 设计稿在 `#runElapsed` / `#runCount` 里写着 `35分33秒`、`7 个会话 · 2 进行中`。
//    它们本该在首帧被真实数据覆盖 —— 可一旦渲染那条路断了(模块没加载、某个函数抛了),
//    覆盖就不会发生,而页面**照旧显示这两个看起来完全合理的数**。
//    真事:`updateHeader()` 调了一个没 export 的 `secsSince`,于是每秒抛一次,
//    页面就一直挂着"本次运行 35分33秒" —— 一个纯属虚构的时长,用户无从察觉。
//
//    这和本仓到处那条纪律是同一条:**不知道就如实说不知道,不能编一个看起来对的数。**
//    中性占位让"渲染断了"长得像"渲染断了"。
// ⚠️ **一处都不能漏。** 第一版只换了 `runElapsed` / `runCount`,结果真跑一次打开页面,
//    左栏赫然写着「会话 7 · 全部 7 · 只看进行中 2 · 只看有问题 3」,而顶部是「0 个会话」——
//    页面同时给出两套互相矛盾的数字,后一套还配着"以下内容为断连前的最后状态"的横幅,
//    等于**把编造的数字当成真实历史呈现**。`retryN` 同病:第一次尝试就写着"第 2 次尝试"。
{
  const SLOTS = ["runElapsed", "runCount", "listCount", "fAll", "fRun", "fWarn", "retryN"];
  for (const id of SLOTS) {
    const re = new RegExp(`(<(?:b|span)[^>]*\\bid="${id}"[^>]*>)[^<]*(</(?:b|span)>)`);
    if (!re.test(html)) throw new Error(`找不到 #${id} 的样例读数，设计稿结构变了`);
    html = html.replace(re, "$1--$2");
  }
}

// ── 2. 转成 module（测试与页面共用 reconcile.mjs 的前提） ───────────────────
html = html.replace("<script>\n/* ===", `<script type="module">
/* ⚠️ 这是 module：DOM 已就绪才执行，所以顶部直接取元素是安全的。 */
import {
  statusKind, permKind, contextLevel, isUncollected, shortName,
  adaptSnapshot, refsOf, BODY_PLACEHOLDER, secsSince,
} from "./reconcile.mjs";

/* ===`);

// ── 3. 按 section 头切开 ────────────────────────────────────────────────────
const HEAD = /\/\* =+\n   (\d+)\. ([^\n]*)\n   =+ \*\//g;
const marks = [];
for (let m; (m = HEAD.exec(html));) marks.push({ n: Number(m[1]), title: m[2], start: m.index, end: HEAD.lastIndex });
if (marks.length !== 10) throw new Error(`预期 10 个 section，实际 ${marks.length}`);

const endOfScript = html.indexOf("</script>");
const sectionBody = (i) => html.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : endOfScript);
const mk = (n, title, body) => `/* ${"=".repeat(60)}\n   ${n}. ${title}\n   ${"=".repeat(60)} */\n${body}`;

const NEW_2 = mk(2, "数据层：正文取回与缓存（适配层在 reconcile.mjs，可单测）", `
/* ⚠️ **适配层不在这里，在 \`reconcile.mjs\`。**
      它内联在页面里的时候藏过一个正好说明问题的 bug：正文是异步从 \`/file\` 取的，
      取回来只触发了"重画 DOM"，而 DOM 是从**已构造好的展示模型**画的——
      那个模型里 \`input.text\` 早在构造时就被烘成了占位符「正在读取原文…」。
      于是缓存填上了、页面也重画了，**正文永远出不来**。
      这类 bug 在页面里查不出来：没有任何东西能单独喂它一份"缓存从空到满"的输入。

   ⚠️ **页面不改写快照。** 快照是 writer 的产物、\`contract-invariants.mjs\` 验的就是它；
      这里做的是**另建一份展示模型**，两者并存、互不覆盖。 */

var SESSIONS = [];                 /* 展示模型，由 rebuild() 整体重建 */
var SNAP = null;                   /* 最近一份快照原文（只读） */
var RUN = { runId:null, vizDir:null, degraded:false, recordingErrors:[], gone:false,
            readFailure:false, startedAt:null };
var PROGRESS = new Map();          /* vizTurnId -> §5 sidecar */
var BODY = new Map();              /* ref -> {text}|{pending}|{tamper}|{error} */

/* ---- 正文按需取，并**当场对证** ----
   服务端用**实际发出去的字节**实时算一遍 SHA-256 放在 X-Viz-Sha256 里；
   这里拿它和快照里 writer 记下的指纹比。不一致 = 文件在落盘之后被改过 ——
   这时**绝不能照常展示**，否则页面等于替一份被篡改的内容背书。 */
function fetchBody(ref, expectSha, expectPreviewSha){
  if(!ref || BODY.has(ref)) return;
  BODY.set(ref, { pending:true });
  fetch("/file?ref="+encodeURIComponent(ref)).then(function(r){
    if(!r.ok) throw new Error("HTTP "+r.status);
    var got = r.headers.get("X-Viz-Sha256");
    var truncated = r.headers.get("X-Viz-Truncated") === "1";
    var fullBytes = Number(r.headers.get("X-Viz-Full-Bytes") || 0);
    return r.text().then(function(text){
      /* ⚠️ **截断响应不是"没法验"，是"换一份指纹验"。**
            原来的判据是 \`!truncated\`，等于说"只要服务端说它截断了，就跳过对证"——
            那条路上任何被篡改的前缀都能原样显示出来，而页面还照常给出复制按钮。
            超限正文的 previewSha256 是 writer 用**同一个上限、同一个边界函数**算出来的，
            就是为这一刻准备的。缺了它则老实说自己验不了，而不是默认放行。 */
      var expect = truncated ? expectPreviewSha : expectSha;
      if(truncated && !expect){ BODY.set(ref, { unverified:true }); return; }
      if(expect && got && got !== expect){ BODY.set(ref, { tamper:true }); return; }
      if(expect && !got){ BODY.set(ref, { unverified:true }); return; }
      BODY.set(ref, { text:text, truncated:truncated, fullBytes:fullBytes });
    });
  }).catch(function(e){
    BODY.set(ref, { error:String((e && e.message) || e) });
  }).then(function(){
    /* ⚠️ **必须重建模型，不能只重画 DOM。** 占位符是烘在模型里的字符串，
          光重画只会把同一个占位符再画一遍——那正是原来那个 bug。 */
    rebuild();
  });
}

var LAST_DRAFT = new Map();
function rebuild(){
  if(!SNAP) return;
  SESSIONS = adaptSnapshot(SNAP, { progress:PROGRESS, bodyCache:BODY,
                                   runGone:RUN.gone, vizDir:RUN.vizDir });
  /* 「第 N 稿」的脉冲提示：稿次变了才闪一下。
     ⚠️ 这是**纯展示层的瞬态**（跟"上一帧"比出来的），不属于快照，
     所以留在页面这边，不进 adaptSnapshot——那是个纯函数，不该有记忆。 */
  SESSIONS.forEach(function(s){
    s.turns.forEach(function(t){
      if(!t.live) return;
      var prev = LAST_DRAFT.get(t.vizTurnId);
      t.live.bump = (prev != null && prev !== t.live.draft);
      LAST_DRAFT.set(t.vizTurnId, t.live.draft);
    });
  });
  scheduleRender();
}

function applyState(snap){
  SNAP = snap;
  RUN.degraded = !!(snap.run && snap.run.degraded);
  RUN.recordingErrors = (snap.run && snap.run.recordingErrors) || [];
  RUN.startedAt = snap.run && snap.run.startedAt;
  refsOf(snap).forEach(function(x){ fetchBody(x.ref, x.sha256, x.previewSha256); });
  /* 已结算的轮次立刻忘掉 sidecar——留着它只会让迟到的内容有机会回来。 */
  var alive = new Set();
  (snap.sessions || []).forEach(function(s){
    (s.turns || []).forEach(function(t){ if(t.state === "dispatched") alive.add(t.vizTurnId); });
  });
  for(var k of Array.from(PROGRESS.keys())) if(!alive.has(k)) PROGRESS.delete(k);
  rebuild();
}
`);

const NEW_8 = mk(8, "SSE 客户端 · 连接态 · 走字时钟", `
/* 渲染合并：一秒内多次 state/progress 只重画一次。
   ⚠️ 重画**必须保住滚动位置与展开态**——这个页面可能开着几个小时。 */
var renderPending = false;
function scheduleRender(){
  if(renderPending) return;
  renderPending = true;
  requestAnimationFrame(function(){
    renderPending = false;
    var keepTop = elDetail.scrollTop;
    var stick = UI.atBottom;
    renderList();
    renderDetail();
    elDetail.scrollTop = stick ? elDetail.scrollHeight : keepTop;
    updateHeader();
    updateJump();
  });
}

function updateHeader(){
  var nRun = SESSIONS.filter(function(s){ return statusOf(s) === "run"; }).length;
  document.getElementById("runCount").textContent = SESSIONS.length + " 个会话 · " + nRun + " 进行中";
  document.getElementById("runElapsed").textContent =
    RUN.startedAt ? fmtDur(secsSince(RUN.startedAt)) : "--";
}

/* ---- 三种"看不到内容"必须严格区分（STATE.md §6.2）----
   混成一句话，页面就会做错事：
     run-gone             = 它**已经没有了**   → 终态画面，语气是正常收尾
     history-read-failure = 我**暂时读不到**   → 提示条，记录其实还在
     断连                  = 传输层的事         → 提示条 + 自动重连          */
var conn = document.getElementById("conn"),
    connText = document.getElementById("connText"),
    connNotice = document.getElementById("connNotice"),
    retryN = document.getElementById("retryN");

function setConn(kind, extra){
  conn.setAttribute("data-s", kind === "live" ? "live" : (kind === "ended" ? "ended" : "reconnect"));
  connText.textContent = { live:"实时", reconnect:"重连中", ended:"已结束", stale:"读取中" }[kind] || kind;
  connNotice.hidden = (kind !== "reconnect" && kind !== "stale");
  if(extra) {
    var b = connNotice.querySelector("b");
    if(b) b.textContent = extra;
  }
}

var retries = 0, es = null;

function connect(){
  if(es) { try{ es.close(); }catch(e){} }
  es = new EventSource("/events");

  es.addEventListener("hello", function(ev){
    var h = JSON.parse(ev.data);
    RUN.runId = h.runId;
    RUN.vizDir = h.vizDir || null;
    retries = 0;
    if(!RUN.gone) setConn("live");
  });

  es.addEventListener("state", function(ev){
    RUN.readFailure = false;
    if(!RUN.gone) setConn("live");
    applyState(JSON.parse(ev.data));
  });

  es.addEventListener("progress", function(ev){
    var p = JSON.parse(ev.data);
    if(!p || !p.vizTurnId) return;
    PROGRESS.set(p.vizTurnId, p);
    if(SNAP) applyState(SNAP);
  });

  es.addEventListener("control", function(ev){
    var c = JSON.parse(ev.data);
    if(c.kind === "run-gone"){
      RUN.gone = true;
      document.body.classList.add("run-ended");
      setConn("ended");
      if(SNAP) applyState(SNAP);
    } else if(c.kind === "history-read-failure"){
      /* ⚠️ 这**不是** run.degraded（那是"桥没记下来"）、**不是**断连、**不是**已清除。
            当成后两者里任何一个，页面都会进入错误的终态，而记录其实还在。 */
      RUN.readFailure = true;
      setConn("stale", "暂时读不到记录，正在重试…");
    }
  });

  es.addEventListener("viz:overflow", function(){ /* 合并掉的代次，不必打扰用户 */ });

  es.onerror = function(){
    if(RUN.gone) return;
    retries++;
    retryN.textContent = String(retries);
    setConn("reconnect", "与本地服务的连接已断开，正在自动重连…");
    /* EventSource 自己会重连；这里只更新提示。 */
  };
}

/* 走字时钟：只动"已进行 / 多久前"这些跟着墙钟走的字，**不重新取数**。 */
setInterval(function(){
  if(RUN.gone) return;
  var hasRunning = SESSIONS.some(function(s){
    return s.turns.some(function(t){ return t.result === "running"; });
  });
  SESSIONS.forEach(function(s){
    if(statusOf(s) !== "run") s.lastActive++;
    s.turns.forEach(function(t){
      if(t.result === "running"){ t.elapsed++; if(t.live) t.live.age++; }
    });
  });
  updateHeader();
  if(hasRunning) scheduleRender();
}, 1000);
`);

// ── 4. 组装 ─────────────────────────────────────────────────────────────────
let out = html.slice(0, marks[1].start);                       // …到 §2 之前
out += NEW_2;
out += html.slice(marks[2].start, marks[7].start);             // §3~§7 原样
out += NEW_8;
out += html.slice(marks[8].start, marks[9].start);             // §9 原样（下面再补丁）
out += mk(10, "启动", `
if(!readHash()) UI.selected = null;
setConn("reconnect", "正在连接本地服务…");
connect();
`);
out += html.slice(endOfScript);

// §9 里那段原型态选择器整个换掉（真实连接态已在 §8 建立）。
const protoBlock = /\/\* 原型态（仅演示页面级状态） \*\/[\s\S]*?\}, *4000\);\n/;
if (!protoBlock.test(out)) throw new Error("找不到原型态处理块");
out = out.replace(protoBlock, "");

// UI.proto 是原型专用状态，真实页面不存在这个概念。
out = out.replace(/UI\.proto\s*===\s*'nosessions'\s*\|\|\s*/g, "");
out = out.replace(/\(UI\.proto==='nosessions'\?'还没有会话':'没有符合条件的会话'\)/,
  "(SESSIONS.length===0?'还没有会话':'没有符合条件的会话')");
out = out.replace(/\(UI\.proto==='nosessions'\n/, "(SESSIONS.length===0\n");
out = out.replace(/&&\s*UI\.proto!=='ended'/g, "&& !RUN.gone");
out = out.replace(/\n\s*proto:'live',/, "");

// 复制按钮：正文还没读回来 / 指纹对不上 / 只拿到截断前缀时**不许复制**——
// 否则「复制原文」会把占位符、一份被篡改的内容、或一个残件当原文交出去。
out = out.replace(
  "function bindDetail(s){",
  `function bindDetail(s){
  /* ⚠️ **按方向各判各的。** data-copy 的键是 \`会话|轮次|in|out\`，
        第三段就是方向——原来只取第二段（轮次号）拿一个轮次级布尔量一起禁，
        于是"输出还在路上"会连累已经验过的输入，而"输入压根没落盘"反倒放行。
        资格判定本身在 reconcile.mjs 的 copyable() 里，可单测；这里只负责照着关。 */
  Array.prototype.forEach.call(elDetail.querySelectorAll("[data-copy]"), function(el){
    var parts = el.getAttribute("data-copy").split("|");
    var t = s.turns.filter(function(x){ return String(x.n) === parts[1]; })[0];
    if(!t) return;
    var side = parts[2] === "in" ? t.input : t.output;
    if(!side || !side.copyable){
      el.disabled = true;
      el.title = "这份内容还不能当原文交出去（尚未读回、指纹对不上、或只拿到截断前缀）";
    }
  });`);

if (/UI\.proto/.test(out)) throw new Error("仍残留 UI.proto 引用：" + (out.match(/.*UI\.proto.*/g) || []).join(" | "));
if (/data-od-id/.test(out)) throw new Error("仍残留 data-od-id");
if (/PREVIEW_STEPS|MD_REVIEW|IN_LONG/.test(out)) throw new Error("仍残留样本数据");

fs.writeFileSync(path.join(HERE, "index.html"), out);
console.log(`index.html 已生成：${before} → ${out.length} 字节`);
