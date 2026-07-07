#!/usr/bin/env node
// 前端 e2e(零依赖):在 node:vm 里加载 index.html 的 <script>,喂事件给 handle(),断言渲染。
// 为什么零依赖:本仓无 package.json、刻意 zero-dep;不引 jsdom。用最小 DOM shim 跑 handle() 的真实分发路径。
// 跑法:node test-viz.mjs   (退出码 0=全绿,1=有红)
//
// 覆盖:① 全量回放策展 transcript 做回归(不崩、状态正确、seq 去重)
//       ② 新事件 val:script-defect 卡片渲染(sdefect 类 + 仲裁文案 + acId/discoveredBy/desc/evidence + XSS 转义)
//       ③ goal:stuck.reason 显示(iter-cap / script-defect-loop / 未知 reason 回退)
//       ④ DEMO_FILES 与 sample/ 字节同源(regen 不变式)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const VIZ = path.dirname(fileURLToPath(import.meta.url));
const IDX = path.join(VIZ, "index.html");
const SAMPLE = path.join(VIZ, "sample");

/* ---------- 最小 DOM shim(只实现 index.html 真正触达的面) ---------- */
function el() {
  const n = {
    _html: "", _text: "", className: "", id: "", hidden: false, href: "",
    dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    remove() {}, replaceChildren() { this.children = []; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelector() { return el(); }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  Object.defineProperty(n, "innerHTML", { get() { return this._html; }, set(v) { this._html = v; } });
  Object.defineProperty(n, "textContent", { get() { return this._text; }, set(v) { this._text = v; } });
  Object.defineProperty(n, "scrollHeight", { get() { return 0; } });
  return n;
}
const _byId = {};
const documentShim = {
  getElementById(id) { return _byId[id] || (_byId[id] = el()); },
  createElement() { return el(); },
  createTextNode() { return el(); },
  documentElement: el(),
  body: el(),
  addEventListener() {}, querySelector() { return el(); }, querySelectorAll() { return []; },
};
const localStorageShim = {
  _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};
class EventSourceShim { constructor() { this.onopen = this.onmessage = this.onerror = null; } addEventListener() {} close() {} }

/* ---------- 装载 index.html 的脚本 ---------- */
const html = fs.readFileSync(IDX, "utf8");
const s = html.indexOf("<script>"), e = html.indexOf("</script>");
if (s < 0 || e < 0) { console.error("无法定位 <script>"); process.exit(1); }
const scriptText = html.slice(s + "<script>".length, e);

const sandbox = {
  document: documentShim,
  localStorage: localStorageShim,
  location: { protocol: "http:", search: "" }, // 非 file:// 且无 demo=1 → 不自动回放
  EventSource: EventSourceShim,
  console,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  navigator: { userAgent: "node" },
};
vm.createContext(sandbox);
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.scrollTo = () => {};
sandbox.scrollY = 0;
sandbox.innerHeight = 800;

try {
  vm.runInContext(scriptText, sandbox, { filename: "index.html" });
} catch (err) {
  console.error("脚本装载抛错:", err && err.stack || err);
  process.exit(1);
}

/* ---------- 断言器 ---------- */
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } }
function has(hay, needle, name) { ok(typeof hay === "string" && hay.includes(needle), name + `  (缺 "${needle}")`); }
function no(hay, needle, name) { ok(typeof hay === "string" && !hay.includes(needle), name + `  (不该含 "${needle}")`); }

/* ========== ① 回归:全量回放策展 transcript ========== */
const events = sandbox.DEMO_EVENTS;
ok(Array.isArray(events) && events.length === 30, "DEMO_EVENTS 有 30 条");
let threw = null;
try { for (const ev of events) sandbox.handle(ev); } catch (err) { threw = err; }
ok(!threw, "全量回放不抛错" + (threw ? " → " + (threw.message || threw) : ""));
ok(sandbox.goalsTotal === 2, "goalsTotal=2");
ok(sandbox.goalsPassed === 2, "goalsPassed=2");
ok(sandbox.seen && sandbox.seen.size === 30, "seen 去重后 30 条");
// seq 去重:重放一条已见事件不改变 seen
const beforeSize = sandbox.seen.size;
sandbox.handle(events[0]);
ok(sandbox.seen.size === beforeSize, "重放已见 seq 不重复计数");

/* ========== ② 捕获式:新事件渲染 ========== */
// 打桩高层渲染出口,捕获参数(不依赖 DOM 树查询)
const cards = [];
const statuses = [];
sandbox.addCard = (key, cls, htmlStr) => { const c = el(); cards.push({ key, cls, html: htmlStr }); return c; };
sandbox.setGoalStatus = (gid, cls, label) => { statuses.push({ gid, cls, label }); };

// 先建一个 goal 让 currentKey/goals 就位
sandbox.handle({ v: 1, seq: 100, event: "goal:started", runId: "t", payload: { goalId: "GX", title: "demo goal", acCount: 3 } });

// --- val:script-defect ---
const sd = {
  v: 1, seq: 101, event: "val:script-defect", runId: "t",
  payload: { goalId: "GX", n: 2, acId: "AC3", desc: "探针连错端口把真实 PASS 判成 FAIL", evidence: "validation/probe.mjs 连了 :3000 应为 :8080", discoveredBy: "generator" },
};
sandbox.handle(sd);
const sdCard = cards.find(c => c.cls && c.cls.includes("sdefect"));
ok(!!sdCard, "val:script-defect 生成 sdefect 卡片");
if (sdCard) {
  has(sdCard.html, "尺子误判", "sdefect 卡含『尺子误判』标题");
  has(sdCard.html, "AC3", "sdefect 卡含 acId");
  has(sdCard.html, "生成者", "sdefect 卡含 discoveredBy 中文(生成者)");
  has(sdCard.html, "探针连错端口把真实 PASS 判成 FAIL", "sdefect 卡含 desc");
  has(sdCard.html, "validation/probe.mjs 连了 :3000 应为 :8080", "sdefect 卡含 evidence");
  has(sdCard.html, "不消耗生成者迭代配额", "sdefect 卡说明不耗配额");
}

// --- XSS 转义(desc 含标签) ---
cards.length = 0;
sandbox.handle({ v: 1, seq: 102, event: "val:script-defect", runId: "t", payload: { goalId: "GX", n: 3, acId: "AC1", desc: "<script>alert(1)</script>", evidence: "x", discoveredBy: "validator" } });
const xssCard = cards.find(c => c.cls && c.cls.includes("sdefect"));
ok(!!xssCard, "val:script-defect(XSS 用例)生成卡片");
if (xssCard) {
  has(xssCard.html, "&lt;script&gt;", "desc 中的 <script> 被转义");
  no(xssCard.html, "<script>alert(1)", "原始 <script> 未注入");
  has(xssCard.html, "验证者", "discoveredBy=validator 显示为『验证者』");
}

/* ========== ③ goal:stuck.reason ========== */
// script-defect-loop
statuses.length = 0; cards.length = 0;
sandbox.handle({ v: 1, seq: 110, event: "goal:stuck", runId: "t", payload: { goalId: "GX", reason: "script-defect-loop", policy: "halt", note: "尺子改了3版仍不稳" } });
const st1 = statuses.find(s => s.gid === "GX");
ok(!!st1, "goal:stuck 更新泳道状态");
if (st1) {
  has(st1.label, "尺子仲裁反复不收敛", "stuck 状态含 reason 文案(script-defect-loop)");
  has(st1.label, "无人值守中止", "stuck 状态含 policy 文案(halt)");
}
const stCard1 = cards.find(c => c.html && c.html.includes("goal 卡死"));
ok(!!stCard1, "goal:stuck 生成卡片");
if (stCard1) {
  has(stCard1.html, "尺子仲裁反复不收敛", "stuck 卡标题含 reason");
  has(stCard1.html, "尺子改了3版仍不稳", "stuck 卡含 note");
}

// iter-cap
statuses.length = 0;
sandbox.handle({ v: 1, seq: 111, event: "goal:stuck", runId: "t", payload: { goalId: "GX", reason: "iter-cap", policy: "user-abandon" } });
const st2 = statuses.find(s => s.gid === "GX");
if (st2) {
  has(st2.label, "达迭代上限", "stuck 状态含 reason 文案(iter-cap)");
  has(st2.label, "用户:放弃", "stuck 状态含 policy 文案(user-abandon)");
}

// 未知 reason 回退到原值(不吞)
statuses.length = 0;
sandbox.handle({ v: 1, seq: 112, event: "goal:stuck", runId: "t", payload: { goalId: "GX", reason: "weird-x", policy: "halt" } });
const st3 = statuses.find(s => s.gid === "GX");
if (st3) has(st3.label, "weird-x", "未知 reason 原样回退显示");

// 无 reason(旧事件兼容):不应崩、不应出现 undefined 文本
statuses.length = 0;
sandbox.handle({ v: 1, seq: 113, event: "goal:stuck", runId: "t", payload: { goalId: "GX", policy: "halt" } });
const st4 = statuses.find(s => s.gid === "GX");
if (st4) { has(st4.label, "无人值守中止", "无 reason 时仍显示 policy"); no(st4.label, "undefined", "无 reason 时不出现 undefined"); }

/* ========== ④ DEMO_FILES 与 sample/ 字节同源 ========== */
const refKeys = ["contractRef", "genRef", "verdictRef", "summaryRef", "reviewRef", "reportRef"];
const refs = [];
for (const ev of events) { const p = ev.payload || {}; for (const k of refKeys) if (p[k] && !refs.includes(p[k])) refs.push(p[k]); }
ok(refs.length > 0, "transcript 里提取到 *Ref 文件引用");
let drift = 0;
for (const r of refs) {
  const inHtml = sandbox.DEMO_FILES && sandbox.DEMO_FILES[r];
  let onDisk = null;
  try { onDisk = fs.readFileSync(path.join(SAMPLE, r), "utf8"); } catch { /* 缺文件 */ }
  if (inHtml == null || onDisk == null || inHtml !== onDisk) { drift++; console.error("  ✗ DEMO_FILES 漂移: " + r); }
}
ok(drift === 0, "DEMO_FILES 全部与 sample/ 字节同源(regen 不变式)");

/* ---------- 汇总 ---------- */
console.log(`\nfe-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
