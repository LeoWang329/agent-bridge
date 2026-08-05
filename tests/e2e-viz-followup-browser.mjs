#!/usr/bin/env node
/**
 * 观测台「追问」输入框的**真浏览器** e2e。
 *
 * 跟 `tests/e2e-viz-browser.mjs` 分工:那一份考"只有真浏览器答得上来"的通用问题(焦点、命中、
 * 排版),喂的是**冻结样例**、不涉及任何写操作。这一份专考追问这个新功能自己的、同样"只有真
 * 浏览器答得上来"的角落——尤其是**输入框在背景状态更新时会不会丢焦点丢内容**,这类 bug
 * vm 沙箱测出来的字符串断言天生看不见(见 docs/session-viz 相关教训:测试有没有牙只能靠真跑)。
 *
 * 后端侧的权威闸门(忙/有未取结果)已经在 tests/repro-viz-followup-gate.mjs 里用真桥进程验过；
 * 这里手写 outbox 回执模拟"桥已经处理完"，不再起一个真桥——两边合起来才是这条功能的完整验收。
 *
 * 装不上 playwright 就跳过退 0（跟 e2e-viz-browser.mjs 同一条纪律，不进推送前的闸）：
 *   npm i playwright && npx playwright install chromium
 *   NODE_PATH=<那个目录>/node_modules node tests/e2e-viz-followup-browser.mjs
 *   或 PLAYWRIGHT_DIR=<那个目录> node tests/e2e-viz-followup-browser.mjs
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVE_FILE = path.join(REPO, "skills", "agent-bridge", "viz", "serve.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================ 0. playwright 在不在 */
let chromium = null;
const tried = [];
async function tryLoad(spec) {
  try { const m = await import(spec); return m.chromium ?? m.default?.chromium ?? null; }
  catch (e) { tried.push(`${spec} → ${String(e.message).split("\n")[0].slice(0, 90)}`); return null; }
}
chromium = await tryLoad("playwright");
if (!chromium) {
  try { chromium = await tryLoad(pathToFileURL(createRequire(import.meta.url).resolve("playwright")).href); }
  catch (e) { tried.push(`createRequire → ${String(e.message).split("\n")[0].slice(0, 90)}`); }
}
if (!chromium && process.env.PLAYWRIGHT_DIR) {
  chromium = await tryLoad(pathToFileURL(
    path.join(process.env.PLAYWRIGHT_DIR, "node_modules", "playwright", "index.js")).href);
}
if (!chromium) {
  console.log("[SKIP] 没找到 playwright —— 这一份是选修的真浏览器 e2e,不进推送前的闸。");
  console.log("       装法:在任意目录 npm i playwright && npx playwright install chromium");
  tried.forEach((t) => console.log(`       试过:${t}`));
  process.exit(0);
}

/* ============================================================ 1. 起 serve.mjs,喂一份手搭的快照 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function waitUp(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve.mjs 提前退出,code=${child.exitCode}`);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(800) }); await r.arrayBuffer(); if (r.status < 500) return; }
    catch {}
    await sleep(150);
  }
  throw new Error("serve.mjs 15 秒内没起来");
}

const SID = "e2e-followup-session";
let generation = 1;

function baseSession(overrides) {
  return Object.assign({
    sessionId: SID, name: null, agent: "omp", model: "gpt-test", effort: null, access: "write",
    cwd: REPO, returnMode: "full", logFile: null, appendSystemPrompt: null, backendPid: 999,
    status: "idle", health: "healthy", isStreaming: false, contextUsage: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    openFailed: null, closed: null, turns: [],
  }, overrides);
}
function turn(n, { collected = true, dispatched = false, source = "send_message" } = {}) {
  const now = new Date().toISOString();
  return {
    turnNo: n, vizTurnId: `vt-${SID}-${n}`, backendTurnId: null, backendTurnCount: null,
    state: dispatched ? "dispatched" : "settled", boundary: "rpc_ack",
    attemptedAt: now, dispatchedAt: now, settledAt: dispatched ? null : now,
    firstBackendEventAt: null, source, blocking: false, hasSchema: false,
    input: { state: "ready", ref: null, sha256: null, chars: 5, bytes: 5, truncated: false, originalBytes: null, error: null },
    output: dispatched
      ? { state: "pending", ref: null, sha256: null, chars: null, bytes: null, previewBytes: null, previewSha256: null, error: null }
      : { state: "ready", ref: null, sha256: null, chars: 3, bytes: 3, previewBytes: null, previewSha256: null, error: null },
    outcome: dispatched ? null : "completed", bodyKind: dispatched ? null : "final",
    generationCount: 1, collected: dispatched ? null : (collected ? { via: "wait", at: now } : null),
    error: null, durationMs: dispatched ? null : 1000,
  };
}
function snapshotWith(session) {
  const now = new Date().toISOString();
  generation++;
  return {
    schemaVersion: 1, runId: "mcp-e2efollowup", generation, updatedAt: now,
    run: { pid: process.pid, bridgeVersion: "e2e", startedAt: now, status: "running", degraded: false, recordingErrors: [] },
    sessions: [session],
  };
}
async function writeSnapshot(dir, session) {
  const snap = snapshotWith(session);
  await fsp.writeFile(path.join(dir, `state.${generation % 2}.json`), JSON.stringify(snap));
}
/** 多会话快照(T5c 要两个会话才能考出「回执串台」)。 */
async function writeSnapshotMulti(dir, sessionList) {
  const snap = snapshotWith(sessionList[0]);
  snap.sessions = sessionList;
  await fsp.writeFile(path.join(dir, `state.${generation % 2}.json`), JSON.stringify(snap));
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "e2e-followup-"));
  const startedAt = new Date().toISOString();
  await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(
    { runId: "mcp-e2efollowup", pid: process.pid, processStartedAt: startedAt, bridgeVersion: "e2e", createdAt: startedAt }));

  // 起手态:1 轮,已收口——追问框应该是**可用**的。
  await writeSnapshot(dir, baseSession({ turns: [turn(1, { collected: true })] }));

  const port = await freePort();
  const child = spawn(process.execPath, [SERVE_FILE, dir, String(port)], {
    cwd: path.dirname(SERVE_FILE), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUp(baseUrl + "/", child);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl + "/");
    await page.waitForSelector(`.scard[data-sid="${SID}"]`, { timeout: 8000 });
    await page.locator(`.scard[data-sid="${SID}"]`).click();
    await page.waitForSelector("[data-compose-text]", { timeout: 8000 });

    sect("T1 起手态(1 轮已收口):追问框可用");
    {
      const ta = page.locator("[data-compose-text]");
      const btn = page.locator("[data-compose-send]");
      ok("T1 输入框没被禁用", !(await ta.isDisabled()));
      ok("T1 发送按钮没被禁用", !(await btn.isDisabled()));
    }

    sect("T2 会话变忙(新轮次 dispatched):追问框变灰,且给出人话原因");
    {
      await writeSnapshot(dir, baseSession({
        status: "running",
        turns: [turn(1, { collected: true }), turn(2, { dispatched: true })],
      }));
      await page.waitForFunction(() => {
        const ta = document.querySelector("[data-compose-text]");
        return ta && ta.disabled;
      }, {}, { timeout: 5000 });
      const reason = await page.locator(".compose-reason").textContent();
      ok("T2 ★ 输入框被禁用", true); // waitForFunction 没超时就是过了
      ok("T2 原因里提到会话正忙", /忙/.test(reason || ""), reason);
    }

    sect("T3 有未取结果:追问框变灰,原因不同于「忙」");
    {
      await writeSnapshot(dir, baseSession({
        status: "idle",
        turns: [turn(1, { collected: true }), turn(2, { collected: false })],
      }));
      // ⚠️ 不能只等 `ta.disabled===true`——T2 已经是 disabled了,这个条件立刻成立,
      //    等不到「这一拍真的换了原因」。必须等**原因文案本身**变成这次要考的那句。
      await page.waitForFunction(() => {
        const el = document.querySelector(".compose-reason");
        return el && /取走|盖掉/.test(el.textContent || "");
      }, {}, { timeout: 5000 });
      const reason = await page.locator(".compose-reason").textContent();
      ok("T3 ★ 原因提到「未取走」而不是「忙」", /取走|盖掉/.test(reason || "") && !/正忙/.test(reason || ""), reason);
    }

    sect("T4 ★ 背景快照更新时,正在打的字与焦点不能丢");
    {
      // 收掉那笔欠账,回到可用态。
      await writeSnapshot(dir, baseSession({
        status: "idle",
        turns: [turn(1, { collected: true }), turn(2, { collected: true })],
      }));
      const ta = page.locator("[data-compose-text]");
      await ta.waitFor({ state: "visible", timeout: 5000 });
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-compose-text]");
        return el && !el.disabled;
      }, {}, { timeout: 5000 });
      await ta.click();
      await ta.type("这段话正在打到一半", { delay: 15 });

      // 背景来一次跟这个会话业务上无关的快照更新(只是 generation 往前走),
      // 逼一次 renderDetail() 重建 DOM——这正是没做焦点保护就会炸的场景。
      await writeSnapshot(dir, baseSession({
        status: "idle",
        turns: [turn(1, { collected: true }), turn(2, { collected: true })],
      }));
      await sleep(700); // 让 SSE 推过去、页面重画完

      const stillFocused = await page.evaluate(() => document.activeElement === document.querySelector("[data-compose-text]"));
      const val = await ta.inputValue();
      ok("T4 ★ 重建之后输入框还是原来那个焦点", stillFocused);
      ok("T4 ★ 打到一半的字没丢", val === "这段话正在打到一半", val);
    }

    sect("T5 ★ 点发送 → 真的 POST /send(带 token/Origin)→ 202 → 手写 outbox 回执 → 页面收到 send-result");
    {
      const [req] = await Promise.all([
        page.waitForRequest(r => r.url().endsWith("/send") && r.method() === "POST", { timeout: 5000 }),
        page.locator("[data-compose-send]").click(),
      ]);
      const headers = req.headers();
      ok("T5 带了 X-Viz-Token", !!headers["x-viz-token"] && headers["x-viz-token"].length === 64, JSON.stringify(headers["x-viz-token"]));
      const body = JSON.parse(req.postData() || "{}");
      ok("T5 body 带对了 sessionId 与 message", body.sessionId === SID && body.message === "这段话正在打到一半", JSON.stringify(body));

      const sendingNow = await page.locator("[data-compose-send]").isDisabled();
      ok("T5 发送中按钮变灰(防重复点)", sendingNow);

      const resp = await req.response();
      const respJson = await resp.json();
      ok("T5 拿到 202 + reqId", resp.status() === 202 && typeof respJson.reqId === "string", JSON.stringify(respJson));

      // 手写 outbox——模拟桥进程已经处理完这条追问(后端侧的真实闸门已经在
      // repro-viz-followup-gate.mjs 里用真桥验过,这里只考"页面收到回执之后做没做对")。
      const outDir = path.join(dir, "outbox", SID);
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(path.join(outDir, `resp-${respJson.reqId}.json`), JSON.stringify({
        reqId: respJson.reqId, ok: true, result: { accepted: true }, respondedAt: new Date().toISOString(),
      }));

      await page.waitForFunction(() => {
        const note = document.querySelector(".compose-note.ok");
        return !!note;
      }, {}, { timeout: 5000 });
      ok("T5 ★ 页面收到 send-result 后显示成功提示", true);
      const taVal = await page.locator("[data-compose-text]").inputValue();
      ok("T5 成功之后输入框被清空", taVal === "", JSON.stringify(taVal));
    }

    sect("T5b ★★ 回执**抢在** 202 回调之前到达时,输入框不许卡死(必然存在的竞态)");
    {
      // 让页面重新可发送。
      await writeSnapshot(dir, baseSession({
        status: "idle",
        turns: [turn(1, { collected: true }), turn(2, { collected: true })],
      }));
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-compose-text]");
        return el && !el.disabled;
      }, {}, { timeout: 5000 });

      // ⚠️ 关键手法:**把 202 响应压后**,同时在它落地之前就把回执塞进 outbox。
      //    这样 send-result 必定先于 `pendingReqId` 被写上 —— 正是会静默卡死的那条路。
      //    (不拦截的话这个顺序只在桥特别快的时候偶发,做不成稳定用例。)
      let capturedReqId = null;
      await page.route("**/send", async (route) => {
        const resp = await route.fetch();
        const body = await resp.json();
        capturedReqId = body.reqId;
        // 回执先写进 outbox,让 serve.mjs 的轮询先把 send-result 推给页面
        const outDir = path.join(dir, "outbox", SID);
        await fsp.mkdir(outDir, { recursive: true });
        await fsp.writeFile(path.join(outDir, `resp-${body.reqId}.json`), JSON.stringify({
          reqId: body.reqId, ok: true, result: { accepted: true }, respondedAt: new Date().toISOString(),
        }));
        await sleep(1200);            // 等 send-result 确实已经送达页面
        await route.fulfill({ response: resp, body: JSON.stringify(body) });  // 现在才放行 202
      });

      const ta = page.locator("[data-compose-text]");
      await ta.click();
      await ta.type("这条的回执会先到", { delay: 10 });
      await page.locator("[data-compose-send]").click();

      // 若竞态没被处理,这里会一直是「发送中」直到 30 秒超时兜底;
      // 正确实现应当**当场**从缓冲里认领到回执,给出成功提示。
      //
      // ⚠️ 超时**必须收成一条普通的 FAIL**,不能让异常炸穿出去。
      //    变异测试时实测过:直接 `await waitForFunction` 在回归时会把整个套件打断,
      //    于是既看不到这一条红、也看不到后面用例的结果和总计 —— 一次真回归会表现成
      //    "脚本崩了",而不是"这条断言失败了",排查的人第一反应会去怀疑测试环境。
      let claimed = false;
      try {
        await page.waitForFunction(() => !!document.querySelector(".compose-note.ok"), {}, { timeout: 8000 });
        claimed = true;
      } catch { claimed = false; }

      ok("T5b 前提:请求确实发出去了(否则下面两条是空考)", !!capturedReqId, String(capturedReqId));
      ok("T5b ★★ 抢跑的回执被认领,输入框没有卡在「发送中」", claimed,
        claimed ? "" : "8 秒内没等到成功提示 —— 回执先到时被丢掉了");
      const stillSending = await page.locator("[data-compose-send]").isDisabled();
      ok("T5b 发送按钮已恢复可用(不是还卡在发送中)", !stillSending);
      await page.unroute("**/send");
    }

    sect("T5c ★★ 另一个会话的回执带着相同的 reqId 抢先到达时,绝不能被本会话认领");
    {
      // 回执的身份是**(sessionId, reqId) 这一对**。缓冲是全页面共享的,只按 reqId 存的话:
      // 会话 B 的回执会盖掉/顶替 A 正在等的那一条,A 的 202 回调随后把 B 的成败当成自己的,
      // 还会顺手把 A 正在打的字清掉。这条只有真浏览器 + 两个会话 + 错序帧才考得出来。
      const SID2 = "e2e-followup-other";
      await writeSnapshotMulti(dir, [
        baseSession({ status: "idle", turns: [turn(1, { collected: true })] }),
        baseSession({ sessionId: SID2, status: "idle", turns: [turn(1, { collected: true })] }),
      ]);
      await page.waitForFunction(
        () => document.querySelectorAll(".scard").length >= 2, null, { timeout: 6000 });
      await page.locator(`.scard[data-sid="${SID}"]`).click();
      await page.waitForFunction(
        () => document.querySelector("[data-compose-text]")?.disabled === false, null, { timeout: 6000 });

      let stolenReqId = null;
      await page.route("**/send", async (route) => {
        const resp = await route.fetch();
        const body = await resp.json();
        stolenReqId = body.reqId;
        // ★ 用**同一个 reqId**、但挂在**另一个会话**名下,先把它推给页面。
        const otherDir = path.join(dir, "outbox", SID2);
        await fsp.mkdir(otherDir, { recursive: true });
        await fsp.writeFile(path.join(otherDir, `resp-${body.reqId}.json`), JSON.stringify({
          reqId: body.reqId, ok: false, error: "这是另一个会话的回执", respondedAt: new Date().toISOString(),
        }));
        await sleep(1200);   // 确保这一帧先到
        await route.fulfill({ response: resp, body: JSON.stringify(body) });
      });

      const ta2 = page.locator("[data-compose-text]");
      await ta2.click();
      await ta2.type("这条不该被别人的回执顶掉", { delay: 5 });
      await page.locator("[data-compose-send]").click();
      await sleep(2200);     // 202 已落地,页面应该仍在等自己那条回执

      ok("T5c 前提:请求确实发出去了", !!stolenReqId, String(stolenReqId));
      const note = await page.locator(".compose-note").count()
        ? await page.locator(".compose-note").textContent() : "";
      ok("T5c ★★ 没有把别的会话的回执当成自己的", !/另一个会话的回执/.test(note || ""), note);
      ok("T5c ★★ 正在打的字没有被别人的回执清掉",
        (await ta2.inputValue()) === "这条不该被别人的回执顶掉", await ta2.inputValue());

      // 反向:自己那条回执到了,还是要能正常认领(证明上面不是"把所有回执都拒了")。
      const ownDir = path.join(dir, "outbox", SID);
      await fsp.mkdir(ownDir, { recursive: true });
      await fsp.writeFile(path.join(ownDir, `resp-${stolenReqId}.json`), JSON.stringify({
        reqId: stolenReqId, ok: true, result: { accepted: true }, respondedAt: new Date().toISOString(),
      }));
      let ownClaimed = false;
      try {
        await page.waitForFunction(() => !!document.querySelector(".compose-note.ok"), {}, { timeout: 8000 });
        ownClaimed = true;
      } catch { ownClaimed = false; }
      ok("T5c ★ 自己那条回执照常被认领(不是一刀切全拒)", ownClaimed);
      await page.unroute("**/send");
    }

    sect("T6 ★ 归档里带 user_followup 的轮次挂「用户追问」标签");
    {
      await writeSnapshot(dir, baseSession({
        status: "idle",
        turns: [turn(1, { collected: true }), turn(2, { collected: true }), turn(3, { collected: true, source: "user_followup" })],
      }));
      await page.waitForSelector(".src-badge", { timeout: 5000 });
      const badgeText = await page.locator(".src-badge").last().textContent();
      ok("T6 标签文案是「用户追问」", /用户追问/.test(badgeText || ""), badgeText);
    }

    sect("T7 ★ 一轮都没跑过的会话:输入框置灰,而不是让人打完一整段字才被桥回绝");
    {
      // 桥侧闸门对这种会话是拒的(「这不是追问,而且可能抢在主 agent 首轮之前」),
      // 页面必须跟着置灰——否则用户的体验是"能打字、能点、然后被拒",白打一遍。
      await writeSnapshot(dir, baseSession({ status: "idle", turns: [] }));
      await page.waitForFunction(
        () => document.querySelector("[data-compose-text]")?.disabled === true,
        null, { timeout: 6000 },
      ).catch(() => {});
      const ta = page.locator("[data-compose-text]");
      ok("T7 ★ 输入框被禁用", await ta.isDisabled());
      const reason = await page.locator(".compose-reason").textContent();
      ok("T7 原因说的是「还没跑过任何一轮」", /还没跑过|派下去/.test(reason || ""), reason);
    }

    sect("T8 ★★ 网络层就失败时,话术必须是「结果未知」——绝不能说「发送失败」");
    {
      // ⚠️ 这条是**语义**问题,不是显示问题:fetch 抛异常只说明"我没收到回应",
      //    不说明请求没送到——请求体很可能已经原子落进 inbox 了。说死"发送失败",
      //    用户就会直接重发,于是同一句话问两遍。真浏览器里唯一能造出这个现场的办法
      //    就是让这次请求在网络层直接断掉(route.abort),沙箱里的字符串断言造不出来。
      await writeSnapshot(dir, baseSession({ status: "idle", turns: [turn(1, { collected: true })] }));
      await page.waitForFunction(
        () => document.querySelector("[data-compose-text]")?.disabled === false,
        null, { timeout: 6000 },
      );
      await page.route("**/send", route => route.abort("connectionrefused"));
      await page.locator("[data-compose-text]").fill("这一发会在网络层断掉");
      await page.locator("[data-compose-send]").click();
      await page.waitForSelector(".compose-note.err", { timeout: 8000 });
      const note = await page.locator(".compose-note").textContent();
      ok("T8 ★★ 说的是「结果未知 / 可能已经发出去了」", /结果未知/.test(note || "") && /可能已经发出/.test(note || ""), note);
      ok("T8 ★★ 绝不能出现「发送失败」这种说死的话", !/发送失败/.test(note || ""), note);
      ok("T8 ★ 也不能劝人直接重试", /不要直接重试|再决定/.test(note || ""), note);
      const btnBack = await page.locator("[data-compose-send]").isDisabled();
      ok("T8 输入框恢复可用(没卡在发送中)", !btnBack);
      ok("T8 ★★ 打的字**没有**被清掉(结果未知时清空等于暗示已成功)",
        (await page.locator("[data-compose-text]").inputValue()) === "这一发会在网络层断掉",
        await page.locator("[data-compose-text]").inputValue());
      await page.unroute("**/send");
    }
  } finally {
    await browser.close().catch(() => {});
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    try { child.kill("SIGKILL"); } catch {}
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
console.log(`\n${"=".repeat(56)}\n  e2e-viz-followup-browser: ${pass} passed, ${fail} failed\n${"=".repeat(56)}`);
process.exit(fail ? 1 : 0);
