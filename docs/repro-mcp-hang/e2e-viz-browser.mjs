#!/usr/bin/env node
/**
 * 两个观测台的**真浏览器** e2e:graph 观测台 + 委托会话观测台。
 *
 *   node docs/repro-mcp-hang/e2e-viz-browser.mjs
 *
 * ── 为什么要有这一份(它和既有的两份 test-viz 是什么分工)────────────────────
 *
 * 两个 skill 各自的 `viz/test-viz.mjs` 把页面脚本装进 **vm 沙箱**跑,断言 reducer 的 view-model 和
 * 渲染器**吐出来的 HTML 字符串**。那一层很有价值,但它有一整类照不出来的东西 ——
 * 因为它没有排版引擎、没有命中测试、没有焦点、也没有真的 JS 运行时:
 *
 *   · **元素自称可交互,实际点不着。** 真事:graph 的推断边线宽 1.4px 又是虚线,
 *     `pointer-events:stroke` 让命中区就是那条线本身 —— 曲线的数学中点都点不中
 *     (正落在虚线空隙里),瞄准 ±6px 的 49 个落点只中 4 次。图例上却写着"可点开看依据"。
 *     字符串断言看到的是"HTML 里有这条 path、有 data-edge",一路全绿。
 *   · **模块作用域的 ReferenceError。** 真事:会话观测台的 `updateHeader()` 调了一个
 *     **没有 export** 的 `secsSince`,于是每秒抛一次,连带把定时器里那句 `scheduleRender()`
 *     一起带走 —— 整个定时刷新死了。真浏览器一开就看见。
 *   · **横向溢出、焦点不可见、主题切换是空操作、页面偷偷发外网请求。**
 *
 * 所以这一份**只考"只有真浏览器答得上来"的问题**,不重复 test-viz 已经守住的内容断言。
 *
 * ── 要 playwright,所以是**选修**,不进推送前的闸 ─────────────────────────────
 *
 * 本仓没有 package.json,不为一份 e2e 引入依赖树。装不上就**如实跳过并退 0** ——
 * 装法(装在任意目录都行,本脚本按 NODE_PATH 找):
 *
 *   npm i playwright && npx playwright install chromium
 *   NODE_PATH=<那个目录>/node_modules node docs/repro-mcp-hang/e2e-viz-browser.mjs
 *
 * 零消耗:不起桥、不连后端、不花钱,喂的是两个 skill 各自仓里那份冻结样例。
 */

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const GRAPH_VIZ = path.join(REPO, "skills", "agent-bridge-graph", "viz");
const SESSION_VIZ = path.join(REPO, "skills", "agent-bridge", "viz");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ============================================================
   0. playwright 在不在
   ============================================================ */
let chromium = null;
const tried = [];
async function tryLoad(spec) {
  try {
    const m = await import(spec);
    return m.chromium ?? m.default?.chromium ?? null;
  } catch (e) { tried.push(`${spec} → ${String(e.message).split("\n")[0].slice(0, 90)}`); return null; }
}
// ① 常规解析:装在本仓、或者 npm link 过。
chromium = await tryLoad("playwright");
// ② ⚠️ **ESM 的 `import()` 不认 `NODE_PATH`**(只有 CommonJS 的 require 认)。
//    所以借 `createRequire` 用 CJS 那套规则解出真实路径,再按 file:// 导进来 ——
//    否则设了 NODE_PATH 的人会看到"没找到 playwright",而它明明就装在那儿。
if (!chromium) {
  try { chromium = await tryLoad(pathToFileURL(createRequire(import.meta.url).resolve("playwright")).href); }
  catch (e) { tried.push(`createRequire → ${String(e.message).split("\n")[0].slice(0, 90)}`); }
}
// ③ 直接指路:`PLAYWRIGHT_DIR=<含 node_modules 的目录>`。
if (!chromium && process.env.PLAYWRIGHT_DIR) {
  chromium = await tryLoad(pathToFileURL(
    path.join(process.env.PLAYWRIGHT_DIR, "node_modules", "playwright", "index.js")).href);
}
if (!chromium) {
  console.log("[SKIP] 没找到 playwright —— 这一份是选修的真浏览器 e2e,不进推送前的闸。");
  console.log("       装法:在任意目录 npm i playwright && npx playwright install chromium");
  console.log("       然后三选一:①装在本仓根目录 ②NODE_PATH=<那儿>/node_modules ③PLAYWRIGHT_DIR=<那个目录>");
  tried.forEach((t) => console.log(`       试过:${t}`));
  process.exit(0);
}

/* ============================================================
   1. 起服务(两个观测台各一个,喂各自仓里那份冻结样例)
   ============================================================ */

/** 先占一个空闲端口再放掉。有竞态,但两个 serve.mjs 都要求显式端口,这是仓里既有的做法。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitUp(url, child, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} 的 serve.mjs 提前退出,code=${child.exitCode}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      await r.arrayBuffer();
      if (r.status < 500) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} 的 serve.mjs 15 秒内没起来`);
}

const children = [], tmpDirs = [];
function spawnServe(file, args, env, label) {
  const c = spawn(process.execPath, [file, ...args], {
    cwd: path.dirname(file), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  c.stdout.on("data", () => {}); c.stderr.on("data", () => {});
  children.push({ c, label });
  return c;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** 把整份快照里的 ISO 时间戳**整体平移**同一个量。整体平移 ⇒ 各时刻的先后与间距一个都不变。 */
function shiftTimes(v, delta) {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = shiftTimes(x, delta);
    return o;
  }
  if (typeof v === "string" && ISO_RE.test(v)) return new Date(Date.parse(v) + delta).toISOString();
  return v;
}
function newestTime(v, acc = { t: -Infinity }) {
  if (Array.isArray(v)) { v.forEach((x) => newestTime(x, acc)); return acc.t; }
  if (v && typeof v === "object") { Object.values(v).forEach((x) => newestTime(x, acc)); return acc.t; }
  if (typeof v === "string" && ISO_RE.test(v)) acc.t = Math.max(acc.t, Date.parse(v));
  return acc.t;
}

/**
 * 会话观测台的样例是**一份快照 JSON**,得按 STATE.md §1 的布局摆成一个可服务的 VIZ_DIR。
 *
 * 三处夹具讲究,每一处都是被红灯逼出来的:
 *  ① **pid 用本进程自己的** —— `ownerAlive()` 拿它 `process.kill(pid, 0)`。写死 pid 的话页面
 *     直接进"该运行已结束"终态,主界面一个字不渲染,这份 e2e 就成了在考一块讣告页。
 *  ② **时间戳整体平移到"刚刚"** —— 样例的时间戳是过去某天的固定值,不平移的话
 *     「本次运行」显示成"49小时12分",分钟粒度,秒级的走字断言永远看不到变化。
 *     整体平移保住内部一致(这份样例本身只跨 205 秒)。
 *  ③ **快照引用的正文文件要真写出来,并回填真实 sha256** —— 只写快照的话页面去取会 404,
 *     而且哈希对不上时页面会(正确地)报篡改。夹具缺斤少两考出来的红,红的不是产品。
 */
function buildSessionVizDir(sampleName) {
  let snap = JSON.parse(fs.readFileSync(path.join(SESSION_VIZ, "sample", `${sampleName}.json`), "utf8"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sviz-"));
  tmpDirs.push(dir);

  const newest = newestTime(snap);
  if (Number.isFinite(newest)) snap = shiftTimes(snap, Date.now() - 2000 - newest);

  // 把每一处 ref 的正文落到盘上,并把 sha256 / 字节数改成**这份真实内容**的。
  for (const s of snap.sessions || []) {
    for (const t of s.turns || []) {
      for (const slot of ["input", "output"]) {
        const io = t[slot];
        if (!io?.ref) continue;
        const body = `# ${slot} · ${s.sessionId ?? "?"} · 第 ${t.turnNo ?? "?"} 轮\n\n` +
          `这是 e2e 夹具写下的正文,用来把"页面取正文 → 校验哈希 → 渲染"这条路真的走一遍。\n`;
        const abs = path.join(dir, io.ref);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body, "utf8");
        const bytes = Buffer.byteLength(body, "utf8");
        io.sha256 = createHash("sha256").update(body, "utf8").digest("hex");
        io.chars = body.length;
        io.bytes = bytes;
        if ("originalBytes" in io) io.originalBytes = bytes;
        if ("truncated" in io) io.truncated = false;
        if ("previewBytes" in io) io.previewBytes = null;
        if ("previewSha256" in io) io.previewSha256 = null;
      }
    }
  }

  const stamp = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(
    { runId: snap.runId, pid: process.pid, processStartedAt: stamp, bridgeVersion: "e2e", createdAt: stamp }));
  fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, processStartedAt: stamp }));
  fs.writeFileSync(path.join(dir, "state.0.json"), JSON.stringify(snap));
  // 把 run 的起点交出去 —— 页面上那个「本次运行 N」得**对得上**,不能只查非空。
  return { dir, startedMs: Date.parse(snap.run?.startedAt ?? "") };
}

/** 把 `fmtDur` 的输出解回秒数(`27秒` / `3分27秒` / `1小时2分`)。 */
function parseDur(s) {
  const t = String(s).trim();
  let m = /^(\d+)小时(\d+)分$/.exec(t); if (m) return +m[1] * 3600 + +m[2] * 60;
  m = /^(\d+)分(\d+)秒$/.exec(t); if (m) return +m[1] * 60 + +m[2];
  m = /^(\d+)秒$/.exec(t); if (m) return +m[1];
  return null;
}

const gPort = await freePort();
spawnServe(path.join(GRAPH_VIZ, "serve.mjs"), [], {
  VIZ_OUT_DIR: path.join(GRAPH_VIZ, "sample"), VIZ_GRAPH_ID: "gr-sample-main", VIZ_PORT: String(gPort),
}, "graph");
const GRAPH_URL = `http://127.0.0.1:${gPort}/`;

const { dir: sDir, startedMs: sStartedMs } = buildSessionVizDir("normal-completed-final-collected");
const sPort = await freePort();
spawnServe(path.join(SESSION_VIZ, "serve.mjs"), [sDir, String(sPort)], { VIZ_DIR: sDir, VIZ_PORT: String(sPort) }, "session");
const SESSION_URL = `http://127.0.0.1:${sPort}/`;

function cleanup() {
  for (const { c } of children) { try { c.kill(); } catch { /* 已经没了 */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 留着也只是脏 */ } }
}
process.on("exit", cleanup);

try {
  await waitUp(GRAPH_URL, children[0].c, "graph");
  await waitUp(SESSION_URL, children[1].c, "session");
} catch (e) {
  console.log(`[FAIL] 起服务失败:${e.message}`);
  cleanup(); process.exit(1);
}

/* ============================================================
   2. 通用体检:两个页面都要过
   ============================================================ */
const browser = await chromium.launch();

/** 开一个页面,并把**运行时出的事**都记下来。 */
async function openPage(url, viewport = { width: 1500, height: 950 }) {
  const page = await browser.newPage({ viewport });
  const rec = { pageErrors: [], consoleErrors: [], badRequests: [], offHost: [] };
  page.on("pageerror", (e) => rec.pageErrors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") rec.consoleErrors.push(m.text().slice(0, 200)); });
  page.on("requestfailed", (r) => rec.badRequests.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) rec.badRequests.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on("request", (r) => {
    const u = r.url();
    if (/^(data|blob|about):/.test(u)) return;
    try {
      const h = new URL(u).hostname;
      if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1") rec.offHost.push(u.slice(0, 160));
    } catch { rec.offHost.push(u.slice(0, 160)); }
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);
  return { page, rec };
}

/**
 * 「自称可交互的东西,是不是真的点得着」 —— 沙箱里照不出来的那一类。
 *
 * ⚠️ 每个元素**先滚进视野再问**。不滚的话,一个此刻正好压在固定页脚底下、
 *    但滚一下就够得着的方块会被判成缺陷 —— 那问的是"不滚够不够得着",
 *    而要问的是"用户够不够得到"。(第一版就是这么误报的。)
 */
async function hittability(page) {
  return page.evaluate(async () => {
    const out = { checked: 0, unreachable: [] };
    const els = document.querySelectorAll("button, a[href], input, select, [role=button], [role=tab]");
    for (const el of els) {
      // SVG 几何(曲线)另有专门的取样考法:一条曲线的外框中心本来就不在曲线上,
      // 拿外框中心去考它是**问错了问题**,不是发现了缺陷。
      if (el.ownerSVGElement || el.tagName === "path") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;                       // 不可见/零尺寸的不算
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || s.pointerEvents === "none") continue;
      if (el.disabled) continue;
      // 先滚进视野(`center` 让它尽量避开吸顶/吸底的固定条),等一帧让布局落定。
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const rr = el.getBoundingClientRect();
      const cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;   // 滚完仍在视口外的不算
      out.checked++;
      const hit = document.elementFromPoint(cx, cy);
      // 点中它自己、或它内部的任何一层,都算够得着。
      if (!hit || !(el === hit || el.contains(hit))) {
        out.unreachable.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}` +
          `.${String(el.className || "").split(" ")[0]} → ${hit ? hit.tagName.toLowerCase() + "." + String(hit.className || "").split(" ")[0] : "null"}`);
      }
    }
    return out;
  });
}

/** 焦点看不看得见 —— 键盘用户唯一的位置感。 */
async function focusVisible(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    el.focus();
    const s = getComputedStyle(el);
    const w = parseFloat(s.outlineWidth) || 0;
    const hasOutline = s.outlineStyle !== "none" && w > 0;
    const hasShadow = s.boxShadow && s.boxShadow !== "none";
    const hasStroke = s.stroke && s.stroke !== "none" && parseFloat(s.strokeOpacity || "1") > 0.05;
    return { found: true, focused: document.activeElement === el, hasOutline, hasShadow, hasStroke };
  }, selector);
}

async function commonChecks(label, url) {
  console.log(`\n[${label}] 通用体检`);
  const { page, rec } = await openPage(url);

  ok(`${label} 零 JS 运行时异常`, rec.pageErrors.length === 0, rec.pageErrors.join(" | "));
  ok(`${label} 零 console 报错`, rec.consoleErrors.length === 0, rec.consoleErrors.slice(0, 3).join(" | "));
  ok(`${label} 零失败/错误码请求`, rec.badRequests.length === 0, rec.badRequests.slice(0, 3).join(" | "));
  // 「本机、只读、不出网」是这两个页面写在文档里的承诺 —— 这是唯一能真验它的地方。
  ok(`${label} ★ 一个外网请求都不发(页面承诺"不出网",字符串断言验不了这个)`,
    rec.offHost.length === 0, rec.offHost.slice(0, 3).join(" | "));

  ok(`${label} 渲染出了实际内容(不是一张白纸)`,
    (await page.evaluate(() => document.body.innerText.trim().length)) > 60);

  // 横向溢出:宽内容该在自己的容器里滚,不该把整页顶横。
  for (const w of [1600, 1280, 900]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(600);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${label} ★ ${w}px 宽下整页不横向溢出(宽内容该在自己容器里滚)`, over <= 1, `溢出 ${over}px`);
  }
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.waitForTimeout(500);

  // 自称可交互的,得真够得着。
  const hit = await hittability(page);
  ok(`${label} 前提:确实考到了可交互元素(否则这条断言是空的)`, hit.checked >= 3, `只考到 ${hit.checked} 个`);
  ok(`${label} ★★ 每个自称可交互的元素都真的点得着(被盖住/零命中区都算缺陷)`,
    hit.unreachable.length === 0, hit.unreachable.slice(0, 4).join(" ; "));

  // 键盘:Tab 能走进这套界面,而且焦点看得见。
  // ⚠️ **别断言"第一下 Tab 就到控件"。** 页面里有可滚容器时,浏览器会先把滚动区本身
  //    纳入焦点序列(Chrome 的 keyboard-focusable scrollers),于是第一下落在文档上、
  //    第二下才到按钮 —— 那是浏览器的正常行为,不是缺陷。要问的是"键盘进不进得来",
  //    不是"第几下进来"。(第一版就是这么误报的,而同一份代码在没滚过的页面上是绿的 ——
  //    这种"看起来只在某一页红"的假红最费时间。)
  let stop = null;
  for (let i = 0; i < 5 && stop === null; i++) {
    await page.keyboard.press("Tab");
    stop = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) return null;
      const c = a.className;
      const cs = (c && c.baseVal !== undefined) ? c.baseVal : String(c || "");
      return `${a.tagName.toLowerCase()}#${a.id || "-"}.${cs.split(" ")[0]}`;
    });
  }
  ok(`${label} ★ 键盘 Tab 进得来(5 下之内落到真正的控件上)`, stop !== null, String(stop));
  const fv = await focusVisible(page, "#themeBtn");
  ok(`${label} ★ 焦点看得见(键盘用户唯一的位置感)`,
    fv.found && fv.focused && (fv.hasOutline || fv.hasShadow || fv.hasStroke), JSON.stringify(fv));

  // 主题切换必须**真的换了**,不是个空开关。
  const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.locator("#themeBtn").click();
  await page.waitForTimeout(900);
  const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(`${label} ★ 换主题真的换了底色(空开关也能让字符串断言全绿)`,
    bgBefore !== bgAfter, `${bgBefore} → ${bgAfter}`);
  ok(`${label} 换主题之后仍然零异常`, rec.pageErrors.length === 0, rec.pageErrors.join(" | "));

  await page.close();
  return rec;
}

await commonChecks("graph", GRAPH_URL);
await commonChecks("session", SESSION_URL);

/* ============================================================
   3. graph 观测台专有
   ============================================================ */
console.log("\n[graph] 专有");
{
  const { page } = await openPage(GRAPH_URL);

  // 两个视图都得能渲染、切换不出错。
  const tabOk = await page.locator("#tabGraph").isEnabled();
  ok("graph 前提:这份样例有依赖边,图视图是可用的", tabOk);
  if (tabOk) {
    await page.locator("#tabGraph").click();
    await page.waitForTimeout(1200);
    ok("graph 图视图画出了环节方块", (await page.locator(".nodebox").count()) > 0);
    ok("graph 图视图画出了依赖边", (await page.locator("path[data-edge]").count()) > 0);
  }
  await page.locator("#tabTimeline").click();
  await page.waitForTimeout(1000);
  ok("graph 时间轴视图也画得出来", (await page.locator(".tl-row").count()) > 0);
  await page.locator("#tabGraph").click();
  await page.waitForTimeout(1000);

  // ★ 边的命中率 —— 这一条就是那个真 bug 的看门狗。
  //
  // ⚠️ **按"人怎么瞄"取样,不是只取曲线上的数学精确点。** 用户是往线**附近**点的,
  //    而原来的缺陷正是:线宽 1.4px 又是虚线,命中区就是那条线本身 ——
  //    离线一两个像素、或者正好落在虚线空隙里,就点了个空。
  //    只取曲线上的精确点考不出这个(实测:去掉热区之后那种考法照样全绿),
  //    所以这里在中段沿线取点,每个点再取它 ±4px 的邻域。
  const rate = await page.evaluate(() => {
    const path0 = document.querySelector("path[data-edge]");
    if (!path0) return null;
    const L = path0.getTotalLength(), m = path0.getScreenCTM();
    let hit = 0, total = 0;
    for (let f = 0.3; f <= 0.7; f += 0.1) {
      const sp = path0.getPointAtLength(L * f);
      const q = new DOMPoint(sp.x, sp.y).matrixTransform(m);
      for (const dx of [-4, -2, 0, 2, 4]) for (const dy of [-4, -2, 0, 2, 4]) {
        total++;
        const el = document.elementFromPoint(q.x + dx, q.y + dy);
        if (el && el.getAttribute && el.getAttribute("data-edge") != null) hit++;
      }
    }
    return { hit, total, pct: Math.round(hit / total * 100) };
  });
  ok("graph 前提:取到了足够多的取样点", rate && rate.total >= 40, JSON.stringify(rate));
  // 门槛不设 100%:边的两端有箭头、拐弯处邻域会滑出热区,那是几何,不是缺陷。
  // 设 80% 是因为**真出问题时是 8%**,两者差着一个数量级,不会摇摆。
  ok("graph ★★ 照人瞄的方式点边,命中率要高(图例写着「可点开看依据」,就得真点得开)",
    rate && rate.pct >= 80, `命中率 ${rate?.pct}%(${rate?.hit}/${rate?.total}) —— 没有热区时实测只有 8%`);

  // 点开真的出弹窗,而且说清了「这是猜的」。
  const clicked = await page.evaluate(() => {
    const p0 = document.querySelector("path[data-edge]");
    const L = p0.getTotalLength(), m = p0.getScreenCTM();
    const sp = p0.getPointAtLength(L / 2);
    const q = new DOMPoint(sp.x, sp.y).matrixTransform(m);
    const el = document.elementFromPoint(q.x, q.y);
    if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: q.x, clientY: q.y }));
    return !!el;
  });
  await page.waitForTimeout(900);
  ok("graph 前提:点到了一条边", clicked);
  const popText = await page.evaluate(() => document.getElementById("edgePop")?.innerText || "");
  ok("graph ★ 点边真的弹出依据", popText.length > 20, popText.slice(0, 80));

  // 键盘也要够得到边(<path> 没有原生的"回车=点击",漏接就等于键盘用户看不到依据)。
  await page.evaluate(() => document.getElementById("edgePop")?.remove());
  const kb = await page.evaluate(() => {
    const e = document.querySelector("path.ehit");
    if (!e) return "没有热区元素";
    e.focus();
    return document.activeElement === e ? "ok" : "聚焦不上";
  });
  ok("graph ★ 边的热区可聚焦(<path> 默认不可聚焦,得显式给 tabindex)", kb === "ok", kb);
  if (kb === "ok") {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    ok("graph ★★ 键盘回车也能看依据(只支持鼠标 = 键盘用户永远看不到「这是猜的」那句话)",
      await page.evaluate(() => !!document.getElementById("edgePop")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    ok("graph ★ Esc 关得掉弹窗", await page.evaluate(() => !document.getElementById("edgePop")));
  }

  // 点环节出详情。
  await page.locator(".nodebox").first().click();
  await page.waitForTimeout(1000);
  ok("graph ★ 点环节方块出详情(详情面板真的填上了)",
    (await page.evaluate(() => document.getElementById("detail")?.innerText.trim().length || 0)) > 100);

  await page.close();
}

/* ============================================================
   4. 会话观测台专有
   ============================================================ */
console.log("\n[session] 专有");
{
  const { page, rec } = await openPage(SESSION_URL);

  // ⚠️ 先证明我们**没在考一块讣告页**:owner 活着时才会渲染主界面。
  const gone = await page.evaluate(() => /该运行已结束|已随之清除/.test(document.body.innerText));
  ok("session 前提:owner 活着,页面进的是主界面而不是「运行已结束」终态", !gone,
    gone ? "fixture 的 meta.json.pid 没指向一个活进程" : "");

  const cards = await page.locator(".scard").count();
  ok("session ★ 会话列表真的渲染出了卡片", cards > 0, `${cards} 张`);

  // 「本次运行 N」这个读数,正是那个没 export 的 secsSince 炸掉的地方。
  //
  // ⚠️ **查"值对不对",不是查"非空"。** 第一版只查非空 —— 变异实测:把两个缺陷一起还原
  //    (不 import + 静态占位是设计稿那份 `35分33秒`)之后,这条**照样全绿**,
  //    因为那个假读数看起来完全合理。**任何看起来合理的默认值都能骗过"非空"这种断言。**
  //    夹具知道这次 run 是多久前起的,那就拿它对 —— 假数字对不上,占位也对不上。
  const elapsed = (await page.locator("#runElapsed").textContent() || "").trim();
  const shown = parseDur(elapsed);
  const expect = (Date.now() - sStartedMs) / 1000;
  ok("session ★★ 顶部「本次运行」的读数**对得上夹具**(只查非空的话,一个假数字就能骗过去)",
    shown !== null && Math.abs(shown - expect) <= 10,
    `页面 ${JSON.stringify(elapsed)}(=${shown}s),按夹具应为 ~${Math.round(expect)}s`);
  const count = (await page.locator("#runCount").textContent() || "").trim();
  ok("session ★ 会话计数也是真渲染出来的(不是设计稿留下的样例数字)",
    count.length > 0 && count !== "--" && /会话/.test(count), JSON.stringify(count));

  // 定时器活着吗 —— 上面那个 ReferenceError 会把 setInterval 里后续的语句一起带走。
  const before = elapsed;
  await page.waitForTimeout(3500);
  const after = (await page.locator("#runElapsed").textContent() || "").trim();
  ok("session ★★ 每秒的定时刷新还活着(读数会自己走字;抛异常的话它整个死掉)",
    after !== before, `${before} → ${after}`);

  // ⚠️ 还**没点任何卡片**时,右栏说的话必须跟左栏一致。
  //    真跑一次抓到的:左栏列着 1 张卡片,右栏却写「还没有可查看的会话,主 agent 一旦把任务
  //    派出去,左侧会出现会话卡片」——页面自己跟自己打架,用户能得出的唯一结论是"它坏了"。
  //    根因是 `renderDetail()` 里 `if(!s)` 一个分支管两件事:「一个都没有」和「有但你没选」。
  //    (和写的那一侧「没写过快照」被当成「读不出来」是同一类错。)
  if (cards > 0) {
    const idle = await page.evaluate(() => document.getElementById("detail")?.innerText || "");
    ok("session ★★ 左栏有卡片时,右栏不许说「还没有可查看的会话」(两种空态不是一件事)",
      !/还没有可查看的会话/.test(idle), JSON.stringify(idle.slice(0, 80)));
    ok("session ★ 右栏空态改说「去左边选一个」,并报出真实会话数",
      /选一个会话/.test(idle) && new RegExp(`已经有\\s*${cards}\\s*个会话`).test(idle),
      JSON.stringify(idle.slice(0, 80)));
  }

  if (cards > 0) {
    await page.locator(".scard").first().click();
    await page.waitForTimeout(1000);
    ok("session ★ 点会话卡片出详情",
      (await page.evaluate(() => document.getElementById("detail")?.innerText.trim().length || 0)) > 60);
  }

  // 搜索框得**真的过滤**,不是个装饰。
  const n0 = await page.locator(".scard").count();
  await page.locator("#search").fill("zzz-不可能匹配的串-zzz");
  await page.waitForTimeout(900);
  const n1 = await page.locator(".scard").count();
  ok("session ★ 搜索真的过滤(填一个不可能匹配的串,列表得变短)", n1 < n0, `${n0} → ${n1}`);
  await page.locator("#search").fill("");
  await page.waitForTimeout(900);
  ok("session ★ 清空搜索后列表复原", (await page.locator(".scard").count()) === n0);

  ok("session 全程零 JS 异常", rec.pageErrors.length === 0, rec.pageErrors.join(" | "));
  await page.close();
}

await browser.close();
cleanup();

console.log(`\n========================================================`);
console.log(`  e2e-viz-browser: ${pass} passed, ${fail} failed`);
console.log(`========================================================`);
process.exit(fail ? 1 : 0);
