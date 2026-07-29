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

// ── 2. 转成 module（测试与页面共用 reconcile.mjs 的前提） ───────────────────
html = html.replace("<script>\n/* ===", `<script type="module">
/* ⚠️ 这是 module：DOM 已就绪才执行，所以顶部直接取元素是安全的。 */
import {
  statusKind, permKind, contextLevel, isUncollected, shortName,
  OUTCOME_LABEL, BODY_LABEL,
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

const NEW_2 = mk(2, "数据层：wire 快照 → 展示模型（合同见同目录 STATE.md）", `
/* ⚠️ **页面不改写快照。** 快照是 writer 的产物、\`contract-invariants.mjs\` 验的就是它；
      页面在这里做的是**另建一份展示模型**，两者并存、互不覆盖。
      viewer 一旦就地改写快照，页面吃的就不再是"那份快照"，中间那道缝正是漂移的产地。 */

var SESSIONS = [];                 /* 展示模型，由 applyState() 整体重建 */
var SNAP = null;                   /* 最近一份快照原文（只读） */
var RUN = { runId:null, vizDir:null, degraded:false, recordingErrors:[], gone:false,
            readFailure:false, startedAt:null };
var PROGRESS = new Map();          /* vizTurnId -> §5 sidecar */
var BODY = new Map();              /* ref -> {text} | {pending:true} | {tamper:true} | {error} */

var ENGINE = {
  omp:    { name:"Oh My Pi",     eb:"OM" },
  codex:  { name:"Codex",        eb:"CX" },
  claude: { name:"Claude Code",  eb:"CC" },
  cursor: { name:"Cursor Agent", eb:"CU" },
  kimi:   { name:"Kimi Code",    eb:"KM" },
};

function hhmmss(iso){
  if(!iso) return "--:--:--";
  var d=new Date(iso); if(isNaN(d)) return "--:--:--";
  var p=function(x){return String(x).padStart(2,"0");};
  return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
}
function secsSince(iso){
  if(!iso) return 0;
  var t=Date.parse(iso); if(!isFinite(t)) return 0;
  return Math.max(0, Math.round((Date.now()-t)/1000));
}
function mb(bytes){
  if(!isFinite(bytes)) return "?";
  if(bytes >= 1048576) return (bytes/1048576).toFixed(1)+" MB";
  if(bytes >= 1024) return Math.round(bytes/1024)+" KB";
  return bytes+" B";
}

/* ---- 正文按需取，并**当场对证** ---- */
/* ⚠️ 服务端会用**实际发出去的字节**实时算一遍 SHA-256 放在 X-Viz-Sha256 里；
      这里拿它和快照里 writer 记下的指纹比。不一致 = 文件在落盘之后被改过 ——
      这时候**绝不能照常展示**，否则页面等于替一份被篡改的内容背书。 */
function bodyOf(ref, expectSha){
  if(!ref) return { text:"" };
  var hit = BODY.get(ref);
  if(hit) return hit;
  BODY.set(ref, { pending:true });
  fetch("/file?ref="+encodeURIComponent(ref)).then(function(r){
    if(!r.ok) throw new Error("HTTP "+r.status);
    var got = r.headers.get("X-Viz-Sha256");
    var truncated = r.headers.get("X-Viz-Truncated") === "1";
    var fullBytes = Number(r.headers.get("X-Viz-Full-Bytes") || 0);
    return r.text().then(function(text){
      if(expectSha && got && !truncated && got !== expectSha){
        BODY.set(ref, { tamper:true, expected:expectSha, actual:got });
      }else{
        BODY.set(ref, { text:text, truncated:truncated, fullBytes:fullBytes });
      }
    });
  }).catch(function(e){
    BODY.set(ref, { error:String(e && e.message || e) });
  }).then(function(){ scheduleRender(); });
  return BODY.get(ref);
}

var PLACEHOLDER = "（正在读取原文…）";
function textFrom(b){
  if(!b) return "";
  if(b.pending) return PLACEHOLDER;
  if(b.tamper)  return "⚠️ 这份文件在落盘之后被改动过（指纹对不上），已拒绝展示。";
  if(b.error)   return "⚠️ 读取失败：" + b.error;
  return b.text || "";
}
function isUsable(b){ return !!(b && !b.pending && !b.tamper && !b.error); }

/* ---- 一轮 ---- */
function adaptTurn(s, t){
  /* run gone 时把仍是 dispatched 的轮次**合成**为 abandoned（STATE.md §9）。
     快照永远发不出终态——run.status 只有一档，终态是传输层的一帧。 */
  var synthesized = RUN.gone && t.state === "dispatched";
  var running = t.state === "dispatched" && !synthesized;
  var result = running ? "running" : (synthesized ? "abandoned" : t.outcome);
  var body = running ? "none" : (synthesized ? "none" : t.bodyKind);

  var inB = bodyOf(t.input.ref, t.input.sha256);
  var o = {
    n: t.turnNo,
    result: result,
    body: body,
    from: hhmmss(t.dispatchedAt),
    to: t.settledAt ? hhmmss(t.settledAt) : null,
    dur: Math.round((t.durationMs || 0) / 1000),
    elapsed: running ? secsSince(t.dispatchedAt) : 0,
    /* 「未取结果」——UIREQ §2 场景 3，这套系统里最常见的一类事故。 */
    unfetched: isUncollected(t) && !synthesized,
    error: t.error || null,
    __vizTurnId: t.vizTurnId,
    __pending: false,
    input: {
      chars: t.input.chars || 0,
      text: textFrom(inB),
      truncated: t.input.truncated
        ? { orig: mb(t.input.originalBytes), saved: mb(t.input.bytes) } : null,
    },
  };
  if(!isUsable(inB)) o.__pending = true;

  if(running){
    /* §5 的四条前提：只有仍是 dispatched、且 sidecar 的 vizTurnId 对得上才合并。
       快照一旦标 settled，迟到的 sidecar **永远无法让它回退**。 */
    var p = PROGRESS.get(t.vizTurnId);
    var ok = p && p.vizTurnId === t.vizTurnId;
    o.live = {
      chars: ok ? (p.charCount || 0) : 0,
      draft: (ok ? p.generationCount : t.generationCount) || 1,
      preview: ok ? (p.tail || "") : "",
      age: ok ? secsSince(p.updatedAt) : 0,
      bump: ok && LAST_DRAFT.get(t.vizTurnId) != null && LAST_DRAFT.get(t.vizTurnId) !== p.generationCount,
    };
    if(ok) LAST_DRAFT.set(t.vizTurnId, p.generationCount);
  } else if(body !== "none"){
    var ob = bodyOf(t.output.ref, t.output.sha256);
    o.output = { chars: t.output.chars || 0, md: textFrom(ob) };
    if(ob && ob.truncated){
      o.output.capped = {
        shown: mb((o.output.md || "").length),
        total: mb(ob.fullBytes),
        path: (RUN.vizDir ? RUN.vizDir + "\\\\" : "") + String(t.output.ref).replace(/\\//g, "\\\\"),
      };
    }
    if(!isUsable(ob)) o.__pending = true;
  } else {
    o.output = { chars: 0, md: "" };
  }
  return o;
}
var LAST_DRAFT = new Map();

/* ---- 一个会话 ---- */
function adaptSession(s){
  var eng = ENGINE[s.agent] || { name: s.agent || "未知", eb: "??" };
  var turns = (s.turns || []).map(function(t){ return adaptTurn(s, t); });
  /* ⚠️ 存活**只看 status + health**，绝不看 backendPid：cursor / kimi 在两轮之间
        不占任何进程，但会话完全健康、随时可以继续。 */
  var kind = statusKind(s);
  return {
    id: s.sessionId,
    alias: s.name || null,
    engine: s.agent, engineName: eng.name, eb: eng.eb,
    model: s.model || null,
    effort: s.effort || null,
    perm: permKind(s),
    state: s.status, health: s.health,
    /* ⚠️ null 是**未知**，不是 0。显示成 0 会让人以为"很空闲、很安全"——是反的。 */
    ctx: (s.contextUsage && isFinite(s.contextUsage.tokens)) ? s.contextUsage.tokens : null,
    cwd: s.cwd || "",
    createdAt: hhmmss(s.createdAt),
    lastActive: kind === "run" ? 0 : secsSince(s.updatedAt),
    incomplete: RUN.degraded,
    startupError: s.openFailed ? s.openFailed.error : null,
    logFile: s.logFile || null,
    turns: turns,
  };
}

function applyState(snap){
  SNAP = snap;
  RUN.degraded = !!(snap.run && snap.run.degraded);
  RUN.recordingErrors = (snap.run && snap.run.recordingErrors) || [];
  RUN.startedAt = snap.run && snap.run.startedAt;
  SESSIONS = (snap.sessions || []).map(adaptSession);
  /* 已结算的轮次立刻忘掉 sidecar——留着它只会让迟到的内容有机会回来。 */
  var alive = new Set();
  (snap.sessions || []).forEach(function(s){
    (s.turns || []).forEach(function(t){ if(t.state === "dispatched") alive.add(t.vizTurnId); });
  });
  for(var k of Array.from(PROGRESS.keys())) if(!alive.has(k)) PROGRESS.delete(k);
  scheduleRender();
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

// 复制按钮：正文还没读回来（或指纹对不上）时**不许复制**——
// 否则「复制原文」会把占位符或一份被篡改的内容当原文交出去。
out = out.replace(
  "function bindDetail(s){",
  `function bindDetail(s){
  /* ⚠️ 正文未就绪时禁用复制。这是用户唯一的留档手段，交出去的必须是真东西。 */
  Array.prototype.forEach.call(elDetail.querySelectorAll("[data-copy]"), function(el){
    var n = el.getAttribute("data-copy").split("|")[1];
    var t = s.turns.filter(function(x){ return String(x.n) === n; })[0];
    if(t && t.__pending){ el.disabled = true; el.title = "原文尚未读取完成"; }
  });`);

if (/UI\.proto/.test(out)) throw new Error("仍残留 UI.proto 引用：" + (out.match(/.*UI\.proto.*/g) || []).join(" | "));
if (/data-od-id/.test(out)) throw new Error("仍残留 data-od-id");
if (/PREVIEW_STEPS|MD_REVIEW|IN_LONG/.test(out)) throw new Error("仍残留样本数据");

fs.writeFileSync(path.join(HERE, "index.html"), out);
console.log(`index.html 已生成：${before} → ${out.length} 字节`);
