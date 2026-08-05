// `scripts/viz-inbox.mjs` 的机器验收 —— 零消耗，不拉任何后端、不起 HTTP 服务。
//
// 对应 docs/DESIGN-session-viz-send-lock-2026-08-04.md 的接线方案 B（inbox/outbox 信箱）。
// 只测这个模块自己的合同：claim-before-process 顺序、请求校验、handler 成功/失败两条路径、
// 积压截断。serve.mjs 那一侧的锁（token/Origin/方法/大小）在 repro-viz-send-lock.mjs 里；
// `sendFollowupFromViz` 的闸门在真桥进程里的端到端行为在 repro-viz-followup-gate.mjs 里。
//
// 跑法：node tests/repro-viz-inbox.mjs

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, "../scripts/viz-inbox.mjs");
const { createVizInbox, INBOX_DIRNAME, OUTBOX_DIRNAME, REQUEST_MAX_BYTES } = await import(`file://${MODULE}`);

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vizinboxtest-"));
  return Promise.resolve(fn(dir)).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
}

async function writeReq(dir, sessionId, reqId, body) {
  const d = path.join(dir, INBOX_DIRNAME, sessionId);
  await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(d, `req-${reqId}.json`), typeof body === "string" ? body : JSON.stringify(body));
}

async function readResp(dir, sessionId, reqId) {
  const p = path.join(dir, OUTBOX_DIRNAME, sessionId, `resp-${reqId}.json`);
  try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; }
}

/** 轮询到条件成立，不 sleep 定值。 */
async function waitUntil(fn, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  return null;
}

/* ============================================================ */
async function t1_happy_path() {
  sect("T1 合法请求 → handler 被调用 → outbox 写出 ok:true");
  await withTmp(async (dir) => {
    const calls = [];
    const inbox = createVizInbox({
      dir,
      handler: async (sessionId, message, meta) => {
        calls.push({ sessionId, message, reqId: meta.reqId });
        return { accepted: true };
      },
      intervalMs: 9999999, // 手动 _tickOnce，不依赖定时器
    });
    await writeReq(dir, "s1", "r1", { message: "hello" });
    await inbox._tickOnce();
    ok("T1 handler 收到了正确的 sessionId/message", calls.length === 1 && calls[0].sessionId === "s1" && calls[0].message === "hello", JSON.stringify(calls));
    const resp = await readResp(dir, "s1", "r1");
    ok("T1 outbox 写出 ok:true + handler 的返回值", resp?.ok === true && resp.result?.accepted === true, JSON.stringify(resp));
    ok("T1 inbox 请求文件被删掉", !fs.existsSync(path.join(dir, INBOX_DIRNAME, "s1", "req-r1.json")));
  });
}

async function t2_claim_before_process() {
  sect("T2 ★ 先认领再处理——handler 执行期间原名已经不在扫描范围里了");
  await withTmp(async (dir) => {
    let sawFileDuringHandler = "unknown";
    const inbox = createVizInbox({
      dir,
      handler: async () => {
        sawFileDuringHandler = fs.existsSync(path.join(dir, INBOX_DIRNAME, "s1", "req-r1.json"));
        return {};
      },
      intervalMs: 9999999,
    });
    await writeReq(dir, "s1", "r1", { message: "hi" });
    await inbox._tickOnce();
    ok("T2 ★ handler 跑的时候原请求名已经不在了（不是处理完才认领）", sawFileDuringHandler === false, String(sawFileDuringHandler));
  });
}

async function t2b_claim_failure_must_not_execute() {
  sect("T2b ★★ 认领失败(rename 抛错)时,handler 一次都不许被调用——否则就是「可能执行两次」");
  await withTmp(async (dir) => {
    let calls = 0;
    let claimAttempts = 0;
    /**
     * ⚠️ **rename 与 unlink 必须一起注入失败,缺一条这个用例就没有牙。**
     *    要挡住的是「认领没成功却照样执行」这一类,而**认领用哪个系统调用是实现细节**:
     *    第一版实现用 unlink 认领、失败只记一行诊断就继续(那正是被抓出来的 bug),
     *    现在用 rename 认领。只让 rename 失败的话,一个 unlink 版的错误实现根本不受影响、
     *    照样全绿 —— 而变异测试当场证实过这一点(把「认领失败就返回」去掉,用例仍然全通过,
     *    因为它被另一条偶然的屏障挡住了,不是被这条断言挡住的)。
     *    两个都失败,才是在考「任何一种认领方式失败时,都一次都不许执行」。
     */
    const failClaim = (name) => async () => {
      claimAttempts++;
      throw Object.assign(new Error(`EBUSY (${name})`), { code: "EBUSY" });
    };
    const io = {
      readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
      readFile: (p) => fsp.readFile(p, "utf8"),
      mkdir: (p) => fsp.mkdir(p, { recursive: true }),
      writeFile: (p, d) => fsp.writeFile(p, d),
      rename: failClaim("rename"),
      unlink: failClaim("unlink"),
    };
    const inbox = createVizInbox({ dir, handler: async () => { calls++; return {}; }, intervalMs: 9999999, io });
    await writeReq(dir, "s1", "r1", { message: "这条绝不能被执行" });

    await inbox._tickOnce();
    await inbox._tickOnce();
    await inbox._tickOnce();

    ok("T2b ★★ 认领失败 ⇒ handler 零调用(反复三拍也是零)", calls === 0, `calls=${calls}`);
    ok("T2b 确实反复尝试过认领(否则上面那条是空考)", claimAttempts >= 3, `claimAttempts=${claimAttempts}`);
    ok("T2b ★ 请求文件仍在原地(没被吞掉,下次还能再试)",
      fs.existsSync(path.join(dir, INBOX_DIRNAME, "s1", "req-r1.json")));
    ok("T2b 没有凭空写出回执(什么都没发生过)", !fs.existsSync(path.join(dir, OUTBOX_DIRNAME, "s1", "resp-r1.json")));
  });
}

async function t2c_claimed_file_not_rescanned() {
  sect("T2c ★ 认领件不会被下一拍当成新请求重扫");
  await withTmp(async (dir) => {
    let calls = 0;
    const inbox = createVizInbox({
      dir,
      // handler 里故意不返回,拖到我们检查完认领件之后——但更简单的做法是跑完再看目录。
      handler: async () => { calls++; return {}; },
      intervalMs: 9999999,
    });
    await writeReq(dir, "s1", "r1", { message: "hi" });
    await inbox._tickOnce();
    await inbox._tickOnce();
    await inbox._tickOnce();
    ok("T2c ★ 三拍下来 handler 只被调用了一次", calls === 1, `calls=${calls}`);
    const leftovers = fs.existsSync(path.join(dir, INBOX_DIRNAME, "s1"))
      ? fs.readdirSync(path.join(dir, INBOX_DIRNAME, "s1")) : [];
    ok("T2c 正常路径跑完不留认领件", leftovers.length === 0, JSON.stringify(leftovers));
  });
}

async function t3_handler_throws() {
  sect("T3 handler 抛异常 → outbox 写 ok:false + 错误原样透传，且不重试");
  await withTmp(async (dir) => {
    let calls = 0;
    const inbox = createVizInbox({
      dir,
      handler: async () => { calls++; throw new Error("session is busy right now"); },
      intervalMs: 9999999,
    });
    await writeReq(dir, "s1", "r1", { message: "hi" });
    await inbox._tickOnce();
    const resp = await readResp(dir, "s1", "r1");
    ok("T3 outbox 记的是 ok:false + 原始错误信息", resp?.ok === false && resp.error === "session is busy right now", JSON.stringify(resp));
    await inbox._tickOnce(); // 再跑一拍
    ok("T3 ★ 不重试——inbox 文件已经没了，第二拍 handler 不会再被调", calls === 1, String(calls));
  });
}

async function t4_malformed_requests_rejected_without_calling_handler() {
  sect("T4 畸形请求：handler 完全不被调用，outbox 给出人话原因");
  await withTmp(async (dir) => {
    let calls = 0;
    const inbox = createVizInbox({ dir, handler: async () => { calls++; return {}; }, intervalMs: 9999999 });

    await writeReq(dir, "s1", "bad-json", "{not json");
    await writeReq(dir, "s1", "no-message", { foo: "bar" });
    await writeReq(dir, "s1", "empty-message", { message: "   " });
    await writeReq(dir, "s1", "too-big", { message: "x".repeat(REQUEST_MAX_BYTES + 10) });
    await inbox._tickOnce();

    ok("T4 handler 一次都没被调用", calls === 0, String(calls));
    const rBad = await readResp(dir, "s1", "bad-json");
    ok("T4 非法 JSON → ok:false", rBad?.ok === false, JSON.stringify(rBad));
    const rNo = await readResp(dir, "s1", "no-message");
    ok("T4 缺 message → ok:false", rNo?.ok === false, JSON.stringify(rNo));
    const rEmpty = await readResp(dir, "s1", "empty-message");
    ok("T4 message 全是空白 → ok:false", rEmpty?.ok === false, JSON.stringify(rEmpty));
    const rBig = await readResp(dir, "s1", "too-big");
    ok("T4 超过单条上限 → ok:false", rBig?.ok === false, JSON.stringify(rBig));
  });
}

async function t4b_size_cap_counts_bytes_not_utf16_units() {
  sect("T4b ★★ 上限量的是 UTF-8 字节,不是 String.length —— 否则中文能超三倍还一路放行");
  // ⚠️ 这条只有多字节字符才照得出来:纯 ASCII 时两个数相等,T4 那条 `"x".repeat(cap+10)`
  //    在按字符数量的实现下也一样会红,所以它证明不了口径。汉字每个 3 字节:
  //    取 cap/2 个汉字 ⇒ 字符数只有 cap 的一半(按字符量 ⇒ 放行),字节数 1.5×cap(按字节量 ⇒ 拒)。
  await withTmp(async (dir) => {
    let calls = 0;
    const inbox = createVizInbox({ dir, handler: async () => { calls++; return {}; }, intervalMs: 9999999 });

    const cjk = "汉".repeat(Math.floor(REQUEST_MAX_BYTES / 2));
    ok("T4b 前提:这份请求按字符数没超、按字节数超了(否则这条是空考)",
      cjk.length < REQUEST_MAX_BYTES && Buffer.byteLength(cjk, "utf8") > REQUEST_MAX_BYTES,
      `chars=${cjk.length} bytes=${Buffer.byteLength(cjk, "utf8")} cap=${REQUEST_MAX_BYTES}`);

    await writeReq(dir, "s1", "cjk-big", { message: cjk });
    await inbox._tickOnce();

    const r = await readResp(dir, "s1", "cjk-big");
    ok("T4b ★★ 被拒", r?.ok === false, JSON.stringify(r)?.slice(0, 160));
    ok("T4b ★★ handler 一次都没被调用(不是「拒了但已经办了」)", calls === 0, String(calls));
    // 量的是**整个请求文件**的字节数(含 JSON 外壳),不是 message 本身——报出来的数必须就是它。
    const fileBytes = Buffer.byteLength(JSON.stringify({ message: cjk }), "utf8");
    ok("T4b 报的字节数就是这份请求文件的真字节数", new RegExp(`\\b${fileBytes}\\b`).test(r?.error || ""),
      `expected ${fileBytes} in: ${r?.error}`);

    // 反向:恰好卡在上限之内的多字节请求必须放行,否则上面那条可能只是"把中文全拒了"。
    const okCjk = "汉".repeat(Math.floor((REQUEST_MAX_BYTES - 64) / 3));
    await writeReq(dir, "s2", "cjk-ok", { message: okCjk });
    await inbox._tickOnce();
    const r2 = await readResp(dir, "s2", "cjk-ok");
    ok("T4b ★ 限内的多字节请求照常放行(不是一刀切拒中文)", r2?.ok === true, JSON.stringify(r2)?.slice(0, 160));
  });
}

async function t5_multiple_sessions_and_backlog_cap() {
  sect("T5 多会话 + 单 tick 处理上限（超出的留到下一拍，不丢）");
  await withTmp(async (dir) => {
    const seen = [];
    const inbox = createVizInbox({
      dir,
      handler: async (sessionId, message, meta) => { seen.push(meta.reqId); return {}; },
      intervalMs: 9999999,
    });
    // 12 条跨 3 个会话的请求，超过 MAX_PER_TICK(8)。
    for (let i = 0; i < 12; i++) {
      await writeReq(dir, `s${i % 3}`, `r${i}`, { message: `msg${i}` });
    }
    await inbox._tickOnce();
    const afterFirstTick = seen.length;
    ok("T5 单 tick 不超过上限（≤8）", afterFirstTick > 0 && afterFirstTick <= 8, String(afterFirstTick));
    await inbox._tickOnce();
    ok("T5 ★ 剩下的没丢——第二拍补上了", seen.length === 12, `first=${afterFirstTick} total=${seen.length}`);
  });
}

async function t6_start_stop_lifecycle() {
  sect("T6 start/stop 生命周期：真定时器跑起来、stop 之后不再处理新请求");
  await withTmp(async (dir) => {
    let calls = 0;
    const inbox = createVizInbox({ dir, handler: async () => { calls++; return {}; }, intervalMs: 50 });
    ok("T6 建好但没 start 之前不 running", inbox.running === false);
    inbox.start();
    ok("T6 start 之后 running", inbox.running === true);
    await writeReq(dir, "s1", "r1", { message: "hi" });
    const got = await waitUntil(async () => (await readResp(dir, "s1", "r1")) ? true : null, 2000);
    ok("T6 真定时器轮询到并处理了请求", !!got, JSON.stringify(got));
    inbox.stop();
    ok("T6 stop 之后 running 变 false", inbox.running === false);
    const callsAtStop = calls;
    await writeReq(dir, "s1", "r2", { message: "should not be processed" });
    await sleep(200);
    ok("T6 ★ stop 之后不再处理新请求", calls === callsAtStop, `before=${callsAtStop} after=${calls}`);
  });
}

async function t7_missing_dir_is_not_an_error() {
  sect("T7 空副作用：没建过 inbox 目录时轮询是安静的 no-op");
  await withTmp(async (dir) => {
    const inbox = createVizInbox({ dir, handler: async () => ({}), intervalMs: 9999999 });
    let threw = false;
    try { await inbox._tickOnce(); } catch { threw = true; }
    ok("T7 inbox 目录不存在时不抛异常", !threw);
  });
}

async function t8_zero_side_effect_until_start() {
  sect("T8 零副作用：createVizInbox() 本身不碰文件系统");
  await withTmp(async (dir) => {
    createVizInbox({ dir, handler: async () => ({}) });
    ok("T8 建对象不 start 就不建任何目录", !fs.existsSync(path.join(dir, INBOX_DIRNAME)) && !fs.existsSync(path.join(dir, OUTBOX_DIRNAME)));
  });
}

/* ============================================================ */
await t1_happy_path();
await t2_claim_before_process();
await t2b_claim_failure_must_not_execute();
await t2c_claimed_file_not_rescanned();
await t3_handler_throws();
await t4_malformed_requests_rejected_without_calling_handler();
await t4b_size_cap_counts_bytes_not_utf16_units();
await t5_multiple_sessions_and_backlog_cap();
await t6_start_stop_lifecycle();
await t7_missing_dir_is_not_an_error();
await t8_zero_side_effect_until_start();

console.log(`\n${"=".repeat(56)}\n  repro-viz-inbox: ${pass} passed, ${fail} failed\n${"=".repeat(56)}`);
process.exit(fail ? 1 : 0);
