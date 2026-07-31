// 收口台账(uncollected debt ledger)的回归。零真实模型消耗,全程 fake-omp。
//
// 要证明的三件事,对应三个改动:
//   ① `uncollected` 是一份**活账**:它出现在**后续每一次**工具调用上,而不是只在 ack 上说一遍。
//      这是整件事的根因 —— 义务持续整个 turn,而一次性提醒只存在于一个 tool result 里。
//   ② ack 上多了 `ifNotCollected`,讲的是**后果**(不收会怎样),不是第四遍"该调哪个"。
//   ③ 退出时把"还欠几轮"记进 exit-journal —— 拦不住销毁(那条路径加不了闸),但事后查得出来。
//
// ⚠️ 判别力在哪:光断言"欠的时候会报"是不够的,**换一个更差的实现照样过**。真正钉住它的是
//    那几条"**不该报的时候不许报**":跑着的不算欠(T6)、中途取半截不算收(T7)、
//    **对空闲会话 abort 不许清账**(T9 —— 清了就等于凭空抹掉一笔真实的债)。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uncollected-"));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 起一个真 MCP server,跑一段,收干净。 */
async function withServer(mode, fn, extraEnv = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: mode, AGENT_BRIDGE_STATE_DIR: STATE_DIR, ...extraEnv },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", () => {});
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {}
    }
  });
  let nextId = 1;
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  /** 返回 { payload, rpcError } —— **两者都要能拿到**:有的用例(未知工具名、对空闲会话 abort)
   *  考的正是错误那条路,把错误吞成 null 就分不出"没报"和"报错了"。 */
  async function call(name, args, timeoutMs = 30000) {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (responses.has(id)) {
        const r = responses.get(id);
        if (r.error) return { payload: null, rpcError: r.error, isError: true };
        const t = r.result?.content?.[0]?.text;
        let payload = null;
        try { payload = t ? JSON.parse(t) : null; } catch { payload = t; }
        return { payload, rpcError: null, isError: r.result?.isError === true };
      }
      if (exited) throw new Error("server exited mid-call");
      await sleep(30);
    }
    throw new Error(`${name} timed out after ${timeoutMs}ms`);
  }
  rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await sleep(200);
  try {
    return await fn({ call, srv, exitedRef: () => exited });
  } finally {
    try { srv.stdin.end(); } catch {}
    for (let i = 0; i < 60 && !exited; i++) await sleep(100);
    try { srv.kill("SIGKILL"); } catch {}
  }
}

const debtOf = (p, sid) => (p?.uncollected || []).find(x => x.sessionId === sid) || null;

/* ============================================================ */
async function t1_ack_and_live_debt() {
  console.log("\n[T1~T5] ack 讲后果 · 债务是活账 · 收完就消失");
  await withServer("okturn", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;

    const { payload: ack } = await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    // ② ack 上讲后果
    ok("T1 ack 仍带 mustCollectResult / requiredAction(既有行为没被拆坏)",
      ack.mustCollectResult === true && ack.requiredAction?.tool === "agent_bridge_wait");
    ok("T2 ★ ack 多了 ifNotCollected,而且讲的是**后果**不是指令",
      typeof ack.ifNotCollected === "string" && /gone for good/.test(ack.ifNotCollected), ack.ifNotCollected);

    await sleep(1200); // 让这一轮真的跑完

    // ① 活账:出现在**别的**工具调用上
    const { payload: st1 } = await call("agent_bridge_status", {});
    const d1 = debtOf(st1, sid);
    ok("T3 ★ 债务出现在一个**与收结果无关**的调用(status)上", !!d1, JSON.stringify(st1?.uncollected));
    ok("T3 债务条目认得出是哪一轮(turnId 非空)", !!d1?.turnId, JSON.stringify(d1));
    ok("T3 带了 uncollectedNote 说清后果", /gone for good/.test(st1?.uncollectedNote || ""));

    // ★ 反复出现 —— 这才是"活账"与"一次性提醒"的区别
    const { payload: st2 } = await call("agent_bridge_status", {});
    ok("T4 ★ 再调一次还在(活账,不是一次性提醒)", !!debtOf(st2, sid));

    // 顺序断言:先记账再挂账 —— 刚收完的那一次**自己**不许还报着
    const { payload: w } = await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });
    ok("T5 wait 确实拿到了结果", typeof w?.completed?.text === "string", JSON.stringify(Object.keys(w || {})));
    ok("T5 ★ **这一次** wait 的返回里不许还挂着它自己刚收掉的债(顺序:先记账后挂账)",
      !debtOf(w, sid), JSON.stringify(w?.uncollected));

    const { payload: st3 } = await call("agent_bridge_status", {});
    ok("T5 ★ 收完之后字段整个消失(空就不挂,所以'没有字段'= 不欠)",
      !("uncollected" in (st3 || {})), JSON.stringify(st3?.uncollected));

    await call("agent_bridge_close_session", { session_id: sid });
  });
}

/* ============================================================ */
async function t6_running_is_not_debt() {
  console.log("\n[T6] 还在跑的**不算欠** —— 它还没产出,报出来就是噪音");
  await withServer("slowturn", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(800); // 这个模式会一直 running
    const { payload: st } = await call("agent_bridge_status", {});
    ok("T6 ★ 正在跑的会话不出现在债务里", !debtOf(st, sid), JSON.stringify(st?.uncollected));
    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
async function t7_midturn_result_is_not_collection() {
  console.log("\n[T7] 中途 result() 取到的半截**不算收口**");
  await withServer("slowsettle", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(500); // 还在跑
    const { payload: mid } = await call("agent_bridge_result", { session_id: sid });
    ok("T7 前提:这次 result 拿到的确实是**没结算**的快照", mid?.turnSettled === false, JSON.stringify(mid?.turnSettled));
    await sleep(3500); // 等它真的settle
    const { payload: st } = await call("agent_bridge_status", {});
    ok("T7 ★ 轮次结算后仍然欠着 —— 中途那次 result 没把账清掉", !!debtOf(st, sid), JSON.stringify(st?.uncollected));
    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
async function t8_abort_discharges() {
  console.log("\n[T8] 显式 abort = 主动放弃这一轮,清账");
  await withServer("slowturn", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(600);
    const { payload: ab } = await call("agent_bridge_abort", { session_id: sid });
    ok("T8 前提:abort 成功", ab?.aborted === true, JSON.stringify(ab));
    await sleep(300);
    const { payload: st } = await call("agent_bridge_status", {});
    ok("T8 ★ 被 abort 的那一轮不再报成欠账", !debtOf(st, sid), JSON.stringify(st?.uncollected));
    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
async function t9_abort_on_idle_must_not_clear() {
  console.log("\n[T9] ★ 对**空闲**会话 abort 绝不许清账(否则凭空抹掉一笔真实的债)");
  await withServer("okturn", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(1200);
    const { payload: before } = await call("agent_bridge_status", {});
    ok("T9 前提:这一轮跑完了、且确实欠着", !!debtOf(before, sid), JSON.stringify(before?.uncollected));

    // 会话此刻是**空闲**的。对它 abort —— 成功也好报错也好,那笔债都必须还在。
    await call("agent_bridge_abort", { session_id: sid }).catch(() => {});
    await sleep(200);
    const { payload: after } = await call("agent_bridge_status", {});
    ok("T9 ★ abort 一个空闲会话之后,上一轮的债**依然在**", !!debtOf(after, sid), JSON.stringify(after?.uncollected));
    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
async function t10_exit_journal() {
  console.log("\n[T10] 退出时把'还欠几轮'记进 exit-journal(拦不住,但事后查得出来)");
  const journal = path.join(STATE_DIR, "exit-journal.jsonl");
  const before = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).length : 0;
  /* ⚠️ **开两个会话,而且要核对 sessionId。**
     第一版只断言"计数 ≥ 1、数组长度在 1~4 之间" —— 一个把 `uncollectedTurns` 写死成 1、
     `uncollectedSessions` 填个假 id 的实现**照样全绿**。要钉住它,数字得是**精确的 2**,
     id 得**逐个对得上**。 */
  const sids = [];
  await withServer("okturn", async ({ call }) => {
    for (let i = 0; i < 2; i++) {
      const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
      sids.push(opened.session.id);
      await call("agent_bridge_send_message", { session_id: opened.session.id, message: "hi" });
    }
    await sleep(1500); // 两轮都跑完、**都不收**,然后让 withServer 关掉 stdin 触发正常退出
  });
  await sleep(600);
  const lines = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").split("\n").filter(Boolean) : [];
  ok("T10 退出日志确实新增了一条", lines.length > before, `${before} → ${lines.length}`);
  let rec = null;
  try { rec = JSON.parse(lines[lines.length - 1]); } catch {}
  ok("T10 那条仍然是可解析的 JSON(有界纪律没被这个新字段破坏)", !!rec);
  ok("T10 ★ 轮数是**精确的 2**(不是'≥1' —— 写死成 1 的实现必须红)",
    rec?.uncollectedTurns === 2, JSON.stringify(rec?.uncollectedTurns));
  ok("T10 ★ 记的会话 id **逐个对得上**(填假 id 的实现必须红)",
    Array.isArray(rec?.uncollectedSessions) && rec.uncollectedSessions.length === 2 &&
      sids.every(id => rec.uncollectedSessions.includes(id)),
    `${JSON.stringify(rec?.uncollectedSessions)} vs ${JSON.stringify(sids)}`);
}

/* ============================================================ */
/**
 * ★ `closed` ≠ 救不回来。
 *
 * ⚠️ 第一版按 `status === "closed"` 过滤,漏掉一整类:**后端自己以 code 0 退出**时
 * (`process_close`),桥只是把会话**标成** closed,对象仍在注册表里、正文仍在内存里。
 * 这一格先证明"确实还取得回来",再断言"所以它必须还报成欠着" —— 两条缺一不可:
 * 只断言后者的话,换一个真的取不回来的实现也一样绿,而那时报欠账才是错的。
 */
async function t12_backend_exited_but_still_retrievable() {
  console.log("\n[T12] ★ 后端自己退出 → 会话标 closed,但正文还在 → 仍然算欠着");
  await withServer("okturn-exit", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(1500); // 跑完 + 后端自杀

    const { payload: st0 } = await call("agent_bridge_status", { session_id: sid });
    ok("T12 前提:会话确实被标成了 closed", st0?.session?.status === "closed", JSON.stringify(st0?.session?.status));

    const { payload: r } = await call("agent_bridge_result", { session_id: sid });
    ok("T12 ★ 前提:正文**确实还取得回来**(所以它是一笔真实的、还救得回来的债)",
      typeof r?.text === "string" && /OKTURN_EXIT_ANSWER/.test(r.text), JSON.stringify(r?.text));

    // 注意:上面那次 result 已经把账清了(它就是一次真正的交付) —— 所以这里要看的是
    // **result 之前**那个状态。用一个新会话重来一遍,只调 status。
    const { payload: opened2 } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid2 = opened2.session.id;
    await call("agent_bridge_send_message", { session_id: sid2, message: "hi" });
    await sleep(1500);
    const { payload: st } = await call("agent_bridge_status", {});
    ok("T12 ★ 后端已退出的会话仍然报成欠着(closed 只是标记,不代表救不回来)",
      !!debtOf(st, sid2), JSON.stringify(st?.uncollected));
  });
}

/* ============================================================ */
/**
 * ★ 一个**瞬时的错读数**绝不能造成**永久的**清账。
 *
 * OMP 有一个已知且可复现的不一致(FAKE_OMP_MODE=turnstate):`agent_end` 到了、结束戳也写了,
 * 但 `get_state` 之后一直报 `isStreaming:true`,于是一次**会刷新状态**的 `status(session_id)`
 * 把 `status` 翻回 `running`。此时若 abort 只信 `sessionSettled()`,就会判成"确有一轮在跑"
 * 并把这笔债**永久**清掉 —— 而那一轮其实早跑完、正文还在。
 */
async function t13_stale_running_must_not_clear_debt() {
  console.log("\n[T13] ★ 陈旧的 isStreaming 把状态翻回 running 之后,abort 不许清账");
  await withServer("turnstate", async ({ call }) => {
    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(1500);

    const { payload: before } = await call("agent_bridge_status", {});
    ok("T13 前提:这一轮跑完了、确实欠着", !!debtOf(before, sid), JSON.stringify(before?.uncollected));

    // ⚠️ **带 session_id 的 status 才会刷新 OMP 状态** —— 不带 id 那个读的是上次已知值。
    //    第一版测试全用不带 id 的形态,所以这条路径**天然撞不到**,更差的实现照样全绿。
    const { payload: refreshed } = await call("agent_bridge_status", { session_id: sid });
    ok("T13 前提:刷新之后状态确实被翻回了 running(病理读数已生效)",
      refreshed?.session?.status === "running", JSON.stringify(refreshed?.session?.status));

    await call("agent_bridge_abort", { session_id: sid }).catch(() => {});
    await sleep(300);

    const { payload: after } = await call("agent_bridge_status", {});
    ok("T13 ★ abort 之后那笔债**依然在**(瞬时错读数不许造成永久清账)",
      !!debtOf(after, sid), JSON.stringify(after?.uncollected));
    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
async function t11_dispatch_refactor_regressions() {
  console.log("\n[T11] 把 callTool 拆成 dispatchTool 之后,原有出口一个都不能变");
  await withServer("okturn", async ({ call }) => {
    const unknown = await call("agent_bridge_nope", {});
    ok("T11 ★ 未知工具名仍然是 isError(拆分后最容易悄悄变成'看起来成功')",
      unknown.isError === true, JSON.stringify(unknown));
    /* ⚠️ 只考"未知工具名"是不够的:那一条走的是我自己新加的 `UnknownToolError` 分支。
       真正容易在拆分里被吞掉的是**合法工具名 + 处理函数自己抛错**(`getSession` 找不到会话)——
       一个把所有异常都接住、包成普通成功文本的拆法,能通过上面那条却在这里翻车,
       而调用方会把一次无效操作当成成功。 */
    for (const tool of ["agent_bridge_result", "agent_bridge_status", "agent_bridge_abort"]) {
      const bad = await call(tool, { session_id: "no-such-session-xyz" });
      ok(`T11 ★ ${tool} 对不存在的会话必须报错,不能包成成功返回`,
        bad.isError === true || !!bad.rpcError, JSON.stringify(bad).slice(0, 160));
    }
    const { payload: doc } = await call("agent_bridge_doctor", {});
    ok("T11 doctor 返回的仍是那段文本,没被债务字段污染", typeof doc === "string" && doc.length > 0,
      typeof doc);
    // 债务为空时,任何返回都不许多出这个字段
    const { payload: st } = await call("agent_bridge_status", {});
    ok("T11 无债时 status 上没有 uncollected", !("uncollected" in (st || {})));
  });
}

/* ============================================================ */
/** ★ 承诺必须对**每一条成功返回**都成立 —— 包括那条返回纯文本的。 */
async function t14_doctor_carries_debt_as_text() {
  console.log("\n[T14] ★ doctor 返回纯文本,加不了字段 —— 那就追加一行,承诺不许只兑现一半");
  /* ⚠️ **针要足够specific,否则它会命中不该命中的东西。**
     第一版拿 `/uncollected/` 当针 —— 而 doctor 会打印 `State: <STATE_DIR>`,
     那个临时目录的前缀恰好就叫 `uncollected-`。于是:
       · "无债时不该有" 那条**假红**(命中的是路径);
       · "有债时应该有" 那条**假绿**(命中的还是路径,追加的那行根本没被验到)。
     一个针同时制造了假红和假绿。改用只有那行才会出现的短语。 */
  const DEBT_LINE = /finished turn\(s\) still uncollected:/;
  await withServer("okturn", async ({ call }) => {
    const { payload: clean } = await call("agent_bridge_doctor", {}, 60000);
    ok("T14 前提:无债时 doctor 干干净净,不追加任何东西",
      typeof clean === "string" && !DEBT_LINE.test(clean), `${typeof clean}: ${String(clean).slice(-100)}`);

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(1200);

    const { payload: dirty } = await call("agent_bridge_doctor", {}, 60000);
    ok("T14 ★ 有债时 doctor 末尾追加了提示,并点名了会话",
      typeof dirty === "string" && DEBT_LINE.test(dirty) && dirty.includes(sid),
      `${typeof dirty}: ${String(dirty).slice(-200)}`);
    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
async function main() {
  console.log(`[harness] STATE_DIR ${STATE_DIR}`);
  await t1_ack_and_live_debt();
  await t6_running_is_not_debt();
  await t7_midturn_result_is_not_collection();
  await t8_abort_discharges();
  await t9_abort_on_idle_must_not_clear();
  await t12_backend_exited_but_still_retrievable();
  await t13_stale_running_must_not_clear_debt();
  await t11_dispatch_refactor_regressions();
  await t14_doctor_carries_debt_as_text();
  await t10_exit_journal();   // 放最后:它会开两个不收的会话,别污染前面几格
  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail ? "[harness] >>> FAIL" : "[harness] >>> PASS");
  try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.log(`[harness] >>> FAIL: ${e?.stack || e}`); process.exit(1); });
