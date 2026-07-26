// 收口纪律加固的契约测试 —— 真理源 docs/PLAN-collect-discipline-hardening-2026-07-26.md。
//
// 背景(§1.3):主 agent 拿到非阻塞 ack 后经常不收口。根因不是"提示词没写",而是"写在会掉的那份里,
// 而桥在 agent 做决定的那一刻不提醒"。本文件锁的是**机制层**的契约:
//   · C2 wait 的 mode 默认 all→any(默认=推荐,且 any 的形状天然带 pending)
//   · C3 join 时钟与 inline 时钟分离(前者超时非破坏性、可短;后者超时会 abort,绝不能砍)
//   · C1 ack / 未完成收集带"必须收口"信号(B2 追加)
//
// hermetic:全程 fake-omp 桩,零真实 token。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const win = process.platform === "win32";
const FAKE = path.join(HERE, win ? "fake-omp.cmd" : "fake-omp.sh");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 一个绑定到给定 FAKE_OMP_MODE 的 MCP server。extraEnv 用于 C3 的 env 覆盖 ——
// ⚠️ 每个 env 组合必须是**独立进程**:DEFAULT_JOIN_TIMEOUT_MS 与 TOOLS 都在**模块加载时**求值,
// 改父进程的 env 再复用同一个 server 是假绿。
function makeServer(mode, extraEnv = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: mode, ...extraEnv },
  });
  let exited = null;
  srv.on("close", code => {
    exited = code;
  });
  srv.stderr.on("data", d => process.stdout.write(`[srv:${mode}] ${d}`));
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m && m.id !== undefined) responses.set(m.id, m);
      } catch {}
    }
  });
  let nextId = 1;
  const waitResp = async (id, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (responses.has(id)) return responses.get(id);
      if (exited !== null) return null;
      await sleep(25);
    }
    return undefined;
  };
  const raw = async (method, params, ms = 20000) => {
    const id = nextId++;
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return await waitResp(id, ms);
  };
  const call = async (name, args, ms = 30000) => {
    const r = await raw("tools/call", { name, arguments: args }, ms);
    const t = r?.result?.content?.[0]?.text;
    return t ? JSON.parse(t) : null;
  };
  const init = async () => {
    await raw(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-collect-discipline", version: "0" } },
      15000,
    );
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  const kill = async () => {
    try {
      srv.stdin.end();
    } catch {}
    await sleep(400);
    try {
      srv.kill("SIGKILL");
    } catch {}
  };
  return { srv, raw, call, init, kill };
}

const waitSchemaOf = list => list?.result?.tools?.find(t => t.name === "agent_bridge_wait")?.inputSchema?.properties;

/** T2/T3:schema 必须**如实**暴露实际默认值。
 *  只断言 env 覆盖生效是不够的 —— 那证明不了不传 env 时的默认真是 600000;
 *  只断言运行时行为也不够 —— 不加载 skill 的宿主看到的只有 schema。 */
async function t2_schema_defaults_no_env() {
  console.log("\n[T2] tools/list(无 env 覆盖)→ mode.default=any、timeout_ms.default=600000");
  const s = makeServer("okturn");
  await s.init();
  const props = waitSchemaOf(await s.raw("tools/list", {}, 15000));
  ok("拿到 agent_bridge_wait 的 inputSchema", !!props, JSON.stringify(props)?.slice(0, 120));
  ok("mode.default === 'any'", props?.mode?.default === "any", JSON.stringify(props?.mode?.default));
  ok("timeout_ms.default === 600000", props?.timeout_ms?.default === 600000, JSON.stringify(props?.timeout_ms?.default));
  await s.kill();
}

async function t3_schema_default_env_override() {
  console.log("\n[T3] tools/list(AGENT_BRIDGE_JOIN_TIMEOUT_MS=800,独立新进程)→ default 跟着变");
  const s = makeServer("okturn", { AGENT_BRIDGE_JOIN_TIMEOUT_MS: "800" });
  await s.init();
  const props = waitSchemaOf(await s.raw("tools/list", {}, 15000));
  ok("timeout_ms.default === 800(schema 不是写死的字面量)", props?.timeout_ms?.default === 800, JSON.stringify(props?.timeout_ms?.default));
  await s.kill();
}

/** C3 的输入边界:join 窗口只接受正整数毫秒。
 *  0 被**拒绝**而不是被赋予含义 —— 本仓其它 env 把 0 当"关闭该功能"(envByteCap),
 *  而"关闭 join 超时"读作"永远等",正是这个常量要消灭的死等陷阱;反过来读作"立刻返回"
 *  又会让每次 wait 变成收不到东西的空转。两种读法都不安全,所以拒收并说明。 */
async function t3b_env_boundaries() {
  console.log("\n[T3b] AGENT_BRIDGE_JOIN_TIMEOUT_MS 的边界:负数/小数/0/非数值都回退默认并告警");
  for (const [raw, why] of [["-5", "负数"], ["1.5", "小数"], ["0", "零"], ["abc", "非数值"]]) {
    const s = makeServer("okturn", { AGENT_BRIDGE_JOIN_TIMEOUT_MS: raw });
    let stderrBuf = "";
    s.srv.stderr.on("data", d => {
      stderrBuf += d.toString();
    });
    await s.init();
    const props = waitSchemaOf(await s.raw("tools/list", {}, 15000));
    ok(`${why}(${raw})回退到默认 600000`, props?.timeout_ms?.default === 600000, JSON.stringify(props?.timeout_ms?.default));
    ok(`${why}(${raw})打了 stderr 告警`, /AGENT_BRIDGE_JOIN_TIMEOUT_MS/.test(stderrBuf), JSON.stringify(stderrBuf.slice(0, 160)));
    await s.kill();
  }
}

/** T9/T10/T11/T12:mode 默认翻转后的四种形状。
 *  T9 必须用**两个错峰会话** —— 单会话时 any 与 all 的返回时机几乎一样,只能证形状、
 *  证不了"没有等齐之后伪装成 any"。同模式同时启动很容易同 tick 完成,所以错开发送时间。 */
async function t9_t12_wait_shapes() {
  const s = makeServer("slowturn");
  await s.init();
  const a = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  const b = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  ok("两个会话都开起来了", !!a && !!b, `${a} / ${b}`);

  console.log("\n[T9] 省略 mode → any:第一个完成就返回,另一个仍在跑");
  await s.call("agent_bridge_send_message", { session_id: a, message: "go" });
  await sleep(700); // 错峰:A 的 turn 2500ms,B 晚 700ms 开始 → A 先完成时 B 必然还在跑
  await s.call("agent_bridge_send_message", { session_id: b, message: "go" });
  const w9 = await s.call("agent_bridge_wait", { session_ids: [a, b], timeout_ms: 20000 }, 30000);
  ok("mode 回显为 any(省略即推荐值)", w9?.mode === "any", JSON.stringify(w9?.mode));
  ok("拿到的是 any 形状而不是 all 形状", !!w9?.completed && w9?.results === undefined, Object.keys(w9 || {}).join(","));
  ok("先完成的是 A", w9?.completed?.sessionId === a, `${w9?.completed?.sessionId} vs ${a}`);
  ok("A 的正文是本轮答案", w9?.completed?.text === "SLOW_DONE", JSON.stringify(w9?.completed?.text));
  ok("pending 里只剩 B", Array.isArray(w9?.pending) && w9.pending.length === 1 && w9.pending[0] === b, JSON.stringify(w9?.pending));
  ok(
    "B 此刻确实还在跑(证明不是等齐了才返回)",
    w9?.pendingSnapshots?.[0]?.status === "running",
    JSON.stringify(w9?.pendingSnapshots?.[0]?.status),
  );
  // C1:这次交付了 completed,所以只能声明"收集没做完",绝不能声明"没给你结果"。
  ok("有 collectionComplete:false", w9?.collectionComplete === false, JSON.stringify(w9?.collectionComplete));
  ok("有 mustCollectResult:true", w9?.mustCollectResult === true, JSON.stringify(w9?.mustCollectResult));
  ok("**没有** resultIncluded(这里确实给了结果,写 false 就是撒谎)", !("resultIncluded" in (w9 || {})), Object.keys(w9 || {}).join(","));
  ok("requiredAction 指向 wait", w9?.requiredAction?.tool === "agent_bridge_wait", JSON.stringify(w9?.requiredAction?.tool));
  ok("requiredAction 的 session_ids 就是 pending", JSON.stringify(w9?.requiredAction?.arguments?.session_ids) === JSON.stringify([b]), JSON.stringify(w9?.requiredAction?.arguments));
  ok("requiredAction 回显了 mode:any", w9?.requiredAction?.arguments?.mode === "any", JSON.stringify(w9?.requiredAction?.arguments?.mode));
  ok("续等条件写的是 pending 非空,不是 timedOut", /pending/.test(w9?.requiredAction?.repeatWhile || ""), JSON.stringify(w9?.requiredAction?.repeatWhile));

  console.log("\n[T10] 显式 mode:'all' 仍返回 {mode:'all', results:[…]}(回归保护)");
  const w10 = await s.call("agent_bridge_wait", { session_ids: [b], mode: "all", timeout_ms: 20000 }, 30000);
  ok("mode 回显为 all", w10?.mode === "all", JSON.stringify(w10?.mode));
  ok("是 all 形状:有 results、没有 completed", Array.isArray(w10?.results) && w10?.completed === undefined, Object.keys(w10 || {}).join(","));
  ok("results[0] 是 B 的答案", w10?.results?.[0]?.text === "SLOW_DONE", JSON.stringify(w10?.results?.[0]?.text));
  ok("全部完成 → 不挂 requiredAction/mustCollectResult", !w10?.requiredAction && !w10?.mustCollectResult, Object.keys(w10 || {}).join(","));

  console.log("\n[T11] 显式 all 且超时 → pending 只含没交付的那个,不是原始全集");
  await s.call("agent_bridge_send_message", { session_id: a, message: "go" }); // A 又跑 2500ms;B 空闲
  const w11 = await s.call("agent_bridge_wait", { session_ids: [a, b], mode: "all", timeout_ms: 900 }, 30000);
  ok("mode 回显仍是 all(没被新默认污染)", w11?.mode === "all", JSON.stringify(w11?.mode));
  ok("timedOut 为 true", w11?.timedOut === true, JSON.stringify(w11?.timedOut));
  ok("pending 只有仍在跑的 A", JSON.stringify(w11?.pending) === JSON.stringify([a]), JSON.stringify(w11?.pending));
  ok("已终态的 B 进了 settled", w11?.settled?.length === 1 && w11.settled[0].sessionId === b, JSON.stringify(w11?.settled?.map(x => x.sessionId)));
  // C1:回显的 mode 必须是调用方原来那个。递回裸参数 = 静默把 all 变成 any,连返回形状一起换掉。
  ok("requiredAction 回显 mode:'all'(没被新默认污染)", w11?.requiredAction?.arguments?.mode === "all", JSON.stringify(w11?.requiredAction?.arguments?.mode));
  ok("requiredAction 的 session_ids 是 pending 而非原始全集", JSON.stringify(w11?.requiredAction?.arguments?.session_ids) === JSON.stringify([a]), JSON.stringify(w11?.requiredAction?.arguments?.session_ids));

  console.log("\n[T12] timedOut:true 但 pending 为空(deadline 已过、候选全部二次确认通过)");
  // 确定性构造:会话已终态 + timeout_ms:0。any 分支的 for 循环第一句就撞上 deadline 而 break,
  // 直落超时分支;此时 firstPass(仍在跑的)为空、候选全部 stable → settled 满、pending 空。
  // 这正是"照着 timedOut 续等会把空数组传进去、撞上 session_ids 非空硬校验"的那条路径。
  const w12 = await s.call("agent_bridge_wait", { session_ids: [b], timeout_ms: 0 }, 30000);
  ok("timedOut 为 true", w12?.timedOut === true, JSON.stringify(w12?.timedOut));
  ok("pending 为空数组", Array.isArray(w12?.pending) && w12.pending.length === 0, JSON.stringify(w12?.pending));
  ok("settled 里有结果(不是空转)", w12?.settled?.length === 1 && w12.settled[0].sessionId === b, JSON.stringify(w12?.settled?.map(x => x.sessionId)));
  // 这条是 C1 的关键反例:pending 空 = 收集其实已经做完。此时挂 requiredAction 会把调用方支去用
  // 空数组再调一次,直接撞上 waitSessions 开头的 session_ids 非空硬校验。
  ok("pending 空 → 不挂 requiredAction", !w12?.requiredAction, JSON.stringify(w12?.requiredAction));
  ok("pending 空 → 不挂 mustCollectResult", !w12?.mustCollectResult, JSON.stringify(w12?.mustCollectResult));

  await s.call("agent_bridge_wait", { session_ids: [a], mode: "all", timeout_ms: 20000 }, 30000); // 收干净再关
  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

/** T13/T14:两个时钟必须互不污染。
 *  T13 —— join 时钟被压到 800ms:wait 省略 timeout_ms 时按它超时,且**不中断 turn**。
 *  T14 —— 同一个 800ms 环境下,send(wait:true) 省略 timeout_ms 必须仍走 30 分钟的 inline 时钟、
 *          正常跑完 2.5s,而不是 800ms 就被 abort 掉。这条是 C3 最容易改错的地方。
 *  ⚠️ T14 只直接覆盖 OMP;其余四后端由验收 grep 确认仍读 DEFAULT_WAIT_TIMEOUT_MS。 */
async function t13_t14_two_clocks() {
  // slowsettle 而不是 slowturn:后者的 get_state 恒报 isStreaming:true,inline wait:true 在它上面
  // 永远完不成(waitIdle 要 !isStreaming),T14 会退化成"卡满 30 分钟"而不是在考时钟隔离。
  const s = makeServer("slowsettle", { AGENT_BRIDGE_JOIN_TIMEOUT_MS: "800" });
  await s.init();
  const id = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  ok("会话开起来了", !!id, String(id));

  console.log("\n[T13] wait 省略 timeout_ms → 按 join 默认(800ms)超时,且不中断 turn");
  await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
  const t0 = Date.now();
  const w13 = await s.call("agent_bridge_wait", { session_ids: [id] }, 30000);
  const elapsed13 = Date.now() - t0;
  ok("按 join 默认超时返回(≈800ms,给足调度余量)", elapsed13 >= 500 && elapsed13 < 2200, `elapsed=${elapsed13}ms`);
  ok("timedOut 为 true", w13?.timedOut === true, JSON.stringify(w13?.timedOut));
  ok("turn 没有被中断:会话仍在跑", w13?.pendingSnapshots?.[0]?.status === "running", JSON.stringify(w13?.pendingSnapshots?.[0]?.status));
  const w13b = await s.call("agent_bridge_wait", { session_ids: [id], timeout_ms: 20000 }, 30000);
  ok("再 wait 一次就拿到了完整答案(超时确实非破坏性)", w13b?.completed?.text === "SLOW_DONE", JSON.stringify(w13b?.completed?.text));

  console.log("\n[T14] 同一 800ms 环境下 send(wait:true) 省略 timeout_ms → 走 inline 时钟,正常跑完");
  const t1 = Date.now();
  const r14 = await s.call("agent_bridge_send_message", { session_id: id, message: "go", wait: true }, 40000);
  const elapsed14 = Date.now() - t1;
  ok("inline 时钟没被 join 默认污染:跑满 turn 才返回", elapsed14 >= 2000 && elapsed14 < 6000, `elapsed=${elapsed14}ms`);
  ok("拿到的是完整答案而不是被 abort 的残局", r14?.text === "SLOW_DONE", JSON.stringify(r14?.text));

  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

const FAKE_CODEX = path.join(HERE, win ? "fake-codex.cmd" : "fake-codex.sh");

/** T1/T4/T7/T8/T15:ack 与未完成收集必须自报"你还没拿到结果"。 */
async function t1_t8_t15_ack_decoration() {
  const s = makeServer("okturn");
  await s.init();

  console.log("\n[T1] send_message(默认 wait:false)→ ack 自报未收口");
  const id = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  const ack = await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
  ok("ack 仍然是 accepted:true(没破坏既有字段)", ack?.accepted === true, JSON.stringify(ack?.accepted));
  ok("resultIncluded:false", ack?.resultIncluded === false, JSON.stringify(ack?.resultIncluded));
  ok("mustCollectResult:true", ack?.mustCollectResult === true, JSON.stringify(ack?.mustCollectResult));
  ok("requiredAction.tool === agent_bridge_wait", ack?.requiredAction?.tool === "agent_bridge_wait", JSON.stringify(ack?.requiredAction?.tool));
  ok("requiredAction 带上了这个会话的 id", JSON.stringify(ack?.requiredAction?.arguments?.session_ids) === JSON.stringify([id]), JSON.stringify(ack?.requiredAction?.arguments));
  // ack 没有"调用方原本的 mode"这个概念,而且省略即推荐值 —— 硬塞一个 mode 是无中生有。
  ok("ack 的 arguments **不带** mode", !("mode" in (ack?.requiredAction?.arguments || {})), JSON.stringify(ack?.requiredAction?.arguments));
  await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 15000 });

  console.log("\n[T4] send_message(wait:true)→ 返回就是结果,不许再说'你还没拿到'");
  const r4 = await s.call("agent_bridge_send_message", { session_id: id, message: "go", wait: true }, 30000);
  ok("拿到了正文", typeof r4?.text === "string" && r4.text.length > 0, JSON.stringify(r4?.text)?.slice(0, 60));
  ok("不含 mustCollectResult", !("mustCollectResult" in (r4 || {})), Object.keys(r4 || {}).join(","));
  ok("不含 requiredAction", !("requiredAction" in (r4 || {})), Object.keys(r4 || {}).join(","));
  ok("不含 resultIncluded", !("resultIncluded" in (r4 || {})), Object.keys(r4 || {}).join(","));

  console.log("\n[T7] open_session + initial_prompt 且不传 wait → 外层装饰、initial 不重复携带");
  const o7 = await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD, initial_prompt: "go" }, 30000);
  ok("initial.accepted === true", o7?.initial?.accepted === true, JSON.stringify(o7?.initial?.accepted));
  ok("外层 mustCollectResult:true", o7?.mustCollectResult === true, JSON.stringify(o7?.mustCollectResult));
  ok("外层 requiredAction 指向本会话", JSON.stringify(o7?.requiredAction?.arguments?.session_ids) === JSON.stringify([o7?.session?.id]), JSON.stringify(o7?.requiredAction?.arguments));
  ok("initial 里**不**重复携带装饰", !("mustCollectResult" in (o7?.initial || {})), Object.keys(o7?.initial || {}).join(","));
  await s.call("agent_bridge_wait", { session_ids: [o7?.session?.id], mode: "all", timeout_ms: 15000 });

  console.log("\n[T8] open_session + initial_prompt + wait:true → 外层与 initial 都不装饰");
  const o8 = await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD, initial_prompt: "go", wait: true }, 40000);
  ok("外层不含 mustCollectResult", !("mustCollectResult" in (o8 || {})), Object.keys(o8 || {}).join(","));
  ok("initial 不含 mustCollectResult", !("mustCollectResult" in (o8?.initial || {})), Object.keys(o8?.initial || {}).join(","));
  ok("initial 就是结果(有正文)", typeof o8?.initial?.text === "string" && o8.initial.text.length > 0, JSON.stringify(o8?.initial?.text)?.slice(0, 60));

  console.log("\n[T15] 把 pending 原样喂回去循环,最后一次不再要求继续收");
  const x = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  const y = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  await s.call("agent_bridge_send_message", { session_id: x, message: "go" });
  await s.call("agent_bridge_send_message", { session_id: y, message: "go" });
  let ids = [x, y];
  const collected = [];
  let rounds = 0;
  let last = null;
  while (ids.length && rounds < 5) {
    rounds += 1;
    last = await s.call("agent_bridge_wait", { session_ids: ids, timeout_ms: 15000 }, 25000);
    if (last?.completed) collected.push(last.completed.sessionId);
    else if (Array.isArray(last?.settled)) collected.push(...last.settled.map(r => r.sessionId));
    ids = Array.isArray(last?.pending) ? last.pending : [];
  }
  ok("两个会话都收齐了", collected.length === 2 && collected.includes(x) && collected.includes(y), JSON.stringify(collected));
  ok("循环真的收敛(没靠轮数上限兜底)", ids.length === 0, JSON.stringify(ids));
  ok("最后一次返回不再要求继续收", !last?.mustCollectResult, JSON.stringify(last?.mustCollectResult));

  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

/** T5:codex "结果其实已经 ready、只是没放进 ack" 的快速分支 —— 六处 ack 里唯一的那处。
 *  只断言"被装饰了"会在**普通异步路径**上假绿(那条路径也被装饰),所以必须additionally钉住
 *  `status === "idle"`:普通路径此刻是 running,只有快速分支才是 idle。 */
async function t5_codex_fast_settle() {
  console.log("\n[T5] codex 快速结算分支:结果已 ready 但没进 ack → 仍要装饰,且 status 是 idle");
  const s = makeServer("okturn", { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "sameflush" });
  await s.init();
  const id = (await s.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000))?.session?.id;
  ok("codex 会话开起来了", !!id, String(id));
  const ack = await s.call("agent_bridge_send_message", { session_id: id, message: "go" }, 20000);
  ok("accepted:true", ack?.accepted === true, JSON.stringify(ack));
  ok("命中的确实是快速分支(status 已是 idle,不是 running)", ack?.status === "idle", JSON.stringify(ack?.status));
  ok("仍然装饰:mustCollectResult:true", ack?.mustCollectResult === true, JSON.stringify(ack?.mustCollectResult));
  ok("字段名说的是'你还没拿到'而不是'还在跑'", ack?.resultIncluded === false, JSON.stringify(ack?.resultIncluded));
  const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 15000 }, 25000);
  ok("照着 requiredAction 去收,确实收得到", w?.results?.[0]?.text === "SAMEFLUSH_ANSWER", JSON.stringify(w?.results?.[0]?.text));
  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

/** T6:accepted:false 的分支不得装饰 —— 那轮压根没被接受,叫人去 wait 是把他支去等一个不存在的东西。
 *  用 slowstart 把 turn/start 的响应拖慢,在"turn id 还不知道"的窗口里插一次 abort。 */
async function t6_codex_not_accepted() {
  console.log("\n[T6] codex accepted:false(abort 抢在 turn/start 返回之前)→ 不装饰");
  const s = makeServer("okturn", { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "slowstart" });
  await s.init();
  const id = (await s.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000))?.session?.id;
  // 流水线发出:send 的 turn/start 会在后端压 600ms,abort 在这期间到达。
  const sendPromise = s.call("agent_bridge_send_message", { session_id: id, message: "go" }, 20000);
  await sleep(150);
  await s.call("agent_bridge_abort", { session_id: id }, 15000);
  const ack = await sendPromise;
  ok("命中了 accepted:false 分支", ack?.accepted === false, JSON.stringify(ack));
  ok("没有被装饰:无 mustCollectResult", !("mustCollectResult" in (ack || {})), Object.keys(ack || {}).join(","));
  ok("没有被装饰:无 requiredAction", !("requiredAction" in (ack || {})), Object.keys(ack || {}).join(","));
  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

/** T16~T21、T23:中途快照必须自报"这不是终态"。 */
async function t16_t23_turn_settled() {
  const s = makeServer("partialslow");
  await s.init();
  const id = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;

  console.log("\n[T16] turn 跑一半调 result → inProgress:true,textRef 指向的是片段");
  await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
  await sleep(900); // 已吐出 PARTIAL_,但离 2500ms 的收尾还早
  const mid = await s.call("agent_bridge_result", { session_id: id });
  ok("inProgress:true", mid?.inProgress === true, JSON.stringify(mid?.inProgress));
  ok("turnSettled:false", mid?.turnSettled === false, JSON.stringify(mid?.turnSettled));
  ok("确实取到了中途片段(不是空)", mid?.text === "PARTIAL_", JSON.stringify(mid?.text));
  ok("textRef 非空(否则下一条断言是空绿)", !!mid?.textRef, JSON.stringify(mid?.textRef));
  const midRef = mid?.textRef;

  console.log("\n[T17/T18] turn 结束后 → turnSettled:true;wait 交付的每个元素都是终态");
  const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 20000 }, 30000);
  ok("results[0].turnSettled === true", w?.results?.[0]?.turnSettled === true, JSON.stringify(w?.results?.[0]?.turnSettled));
  ok("results[0].inProgress === false", w?.results?.[0]?.inProgress === false, JSON.stringify(w?.results?.[0]?.inProgress));
  ok("正文是完整答案", w?.results?.[0]?.text === "PARTIAL_FINAL", JSON.stringify(w?.results?.[0]?.text));
  const done = await s.call("agent_bridge_result", { session_id: id });
  ok("result 也报 turnSettled:true / inProgress:false", done?.turnSettled === true && done?.inProgress === false, JSON.stringify([done?.turnSettled, done?.inProgress]));
  ok("同一个 textRef 路径已被最终全文覆盖", done?.textRef === midRef && done?.text === "PARTIAL_FINAL", JSON.stringify([done?.textRef === midRef, done?.text]));

  console.log("\n[T19] pendingSnapshots 不带这两个字段(它不经结果构造函数)");
  await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
  const w19 = await s.call("agent_bridge_wait", { session_ids: [id], timeout_ms: 700 }, 20000);
  const snap = w19?.pendingSnapshots?.[0];
  ok("确实拿到了一个 pendingSnapshot(否则下面是空绿)", !!snap, JSON.stringify(w19)?.slice(0, 160));
  ok("snapshot 不含 turnSettled", !("turnSettled" in (snap || {})), Object.keys(snap || {}).join(","));
  ok("snapshot 不含 inProgress", !("inProgress" in (snap || {})), Object.keys(snap || {}).join(","));
  await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 20000 }, 30000);

  console.log("\n[T20] abort / failed / 从未 prompt 三态:字段只承诺它承诺的那件事");
  const fresh = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  const never = await s.call("agent_bridge_result", { session_id: fresh });
  ok("从未 prompt 过的会话 → turnSettled:true(可交付,不代表有内容)", never?.turnSettled === true, JSON.stringify(never?.turnSettled));
  ok("而且正文确实是空的(证明 turnSettled 不承诺有正文)", !never?.text, JSON.stringify(never?.text));
  await s.call("agent_bridge_send_message", { session_id: fresh, message: "go" });
  await sleep(900);
  await s.call("agent_bridge_abort", { session_id: fresh }, 15000);
  const aborted = await s.call("agent_bridge_result", { session_id: fresh });
  ok("abort 后 turnSettled:true", aborted?.turnSettled === true, JSON.stringify(aborted?.turnSettled));
  ok("但正文其实是被中断的片段 —— 所以字段绝不能叫 complete", aborted?.text === "PARTIAL_", JSON.stringify(aborted?.text));

  console.log("\n[T23] return_mode:'ref' × running:标记不因 text:null 丢失");
  const refId = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD, return_mode: "ref" }))?.session?.id;
  await s.call("agent_bridge_send_message", { session_id: refId, message: "go" });
  await sleep(900);
  const refMid = await s.call("agent_bridge_result", { session_id: refId });
  ok("ref 模式下 text 被省略", refMid?.text === null, JSON.stringify(refMid?.text));
  ok("inProgress 仍然在(没被 text:null 带走)", refMid?.inProgress === true, JSON.stringify(refMid?.inProgress));
  ok("charCount 如实报片段长度", refMid?.charCount === "PARTIAL_".length, JSON.stringify(refMid?.charCount));
  await s.call("agent_bridge_wait", { session_ids: [refId], mode: "all", timeout_ms: 20000 }, 30000);

  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

/** T21:五后端的 settled 判定各是各的实现,共享构造函数的测试替代不了它们。
 *  这里逐个后端断言 running / terminal 两态。 */
async function t21_five_backends_settled() {
  console.log("\n[T21] 五后端 isSettled 矩阵:running 与 terminal 两态都要对");
  const FAKE_CLAUDE = path.join(HERE, win ? "fake-claude.cmd" : "fake-claude.sh");
  // 每个后端各自挑能造出该状态的桩 —— 有的后端"跑得慢"和"能干净收尾"不是同一个模式:
  // fake-claude 默认的 abortfallback 会**扣住**首轮结果(这正是它用来造 running 的手段),
  // 所以 claude 的 terminal 态要换 ctxturn(一个干净轮)。
  // cursor / kimi 的桩各自需要一整套安装目录 / stub exe,不在这里重复搭 —— 它们的
  // turnSettled 断言直接加在 repro-cursor.mjs 与 repro-kimi.mjs 里(那里 harness 现成)。
  const cases = [
    { agent: "omp", label: "omp", running: { mode: "partialslow", env: {} }, terminal: { mode: "partialslow", env: {} } },
    {
      agent: "codex",
      label: "codex",
      running: { mode: "okturn", env: { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "schemaslowpartial" } },
      terminal: { mode: "okturn", env: { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "schemaslowpartial" } },
    },
    {
      agent: "claude",
      label: "claude",
      running: { mode: "okturn", env: { CLAUDE_BIN: FAKE_CLAUDE } }, // 默认 abortfallback:扣住首轮
      terminal: { mode: "okturn", env: { CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: "ctxturn" } }, // 干净轮
    },
  ];
  for (const c of cases) {
    // running 态
    {
      const s = makeServer(c.running.mode, c.running.env);
      await s.init();
      const id = (await s.call("agent_bridge_open_session", { agent: c.agent, cwd: CWD }, 30000))?.session?.id;
      ok(`${c.label}:running 用例的会话开起来了`, !!id, String(id));
      if (id) {
        await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
        await sleep(600);
        const mid = await s.call("agent_bridge_result", { session_id: id });
        ok(`${c.label}:running 时 turnSettled:false`, mid?.turnSettled === false, JSON.stringify([mid?.turnSettled, mid?.session?.status]));
      }
      await s.kill();
    }
    // terminal 态
    {
      const s = makeServer(c.terminal.mode, c.terminal.env);
      await s.init();
      const id = (await s.call("agent_bridge_open_session", { agent: c.agent, cwd: CWD }, 30000))?.session?.id;
      ok(`${c.label}:terminal 用例的会话开起来了`, !!id, String(id));
      if (id) {
        await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
        const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 20000 }, 30000);
        ok(`${c.label}:wait 真的收到了终态(否则下一条是空绿)`, !w?.timedOut && !!w?.results?.[0], JSON.stringify(w)?.slice(0, 140));
        const fin = await s.call("agent_bridge_result", { session_id: id });
        ok(`${c.label}:terminal 时 turnSettled:true`, fin?.turnSettled === true, JSON.stringify([fin?.turnSettled, fin?.session?.status]));
        await s.call("agent_bridge_close_session", {});
      }
      await s.kill();
    }
  }
}

/** T22:running 时不许把半截 JSON 当最终结果去 parse。 */
async function t22_schema_pending() {
  console.log("\n[T22] codex + schema 跑一半调 result → json:null + schemaPending,不产 schemaError");
  const s = makeServer("okturn", { CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: "schemaslowpartial" });
  await s.init();
  const id = (await s.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000))?.session?.id;
  await s.call("agent_bridge_send_message", { session_id: id, message: "go", schema: { type: "object" } });
  await sleep(900); // 此刻 buffer 里是 '{"ok": tr' —— 一个必然 parse 失败的半截 JSON
  const mid = await s.call("agent_bridge_result", { session_id: id });
  ok("确实取到了半截 JSON(否则下面是空绿)", typeof mid?.text === "string" && mid.text.includes('{"ok"'), JSON.stringify(mid?.text));
  ok("turnSettled:false", mid?.turnSettled === false, JSON.stringify(mid?.turnSettled));
  ok("json 为 null", mid?.json === null, JSON.stringify(mid?.json));
  ok("schemaPending:true", mid?.schemaPending === true, JSON.stringify(mid?.schemaPending));
  ok("**没有** schemaError(否则调用方会以为最终失败了)", !mid?.schemaError, JSON.stringify(mid?.schemaError));
  const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 20000 }, 30000);
  ok("turn 结束后才给出真正的 json", JSON.stringify(w?.results?.[0]?.json) === JSON.stringify({ ok: true }), JSON.stringify(w?.results?.[0]?.json));
  ok("终态不再挂 schemaPending", !w?.results?.[0]?.schemaPending, JSON.stringify(w?.results?.[0]?.schemaPending));
  await s.call("agent_bridge_close_session", {});
  await s.kill();
}

/** T24~T28:对在途 turn 默认拒绝关闭。
 *  只断言"返回里有 blocked"是不够的 —— 必须证明**什么都没发生**(会话还在、进程还活、结果还能收),
 *  否则"拒绝了但其实已经关掉了"照样绿。 */
async function t24_t28_close_guard() {
  const s = makeServer("partialslow");
  await s.init();

  console.log("\n[T24] 对 running 会话单关(不传 force)→ 拒绝,且什么都没动");
  const id = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  const pid0 = (await s.call("agent_bridge_status", { session_id: id }))?.session?.pid;
  ok("拿到了后端 pid(否则后面的存活断言是空绿)", !!pid0, String(pid0));
  await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
  await sleep(600);
  const blocked = await s.call("agent_bridge_close_session", { session_id: id });
  ok("closed:false", blocked?.closed === false, JSON.stringify(blocked));
  ok("blocked:true", blocked?.blocked === true, JSON.stringify(blocked?.blocked));
  ok("runningSessionIds 指名道姓", JSON.stringify(blocked?.runningSessionIds) === JSON.stringify([id]), JSON.stringify(blocked?.runningSessionIds));
  const stillThere = await s.call("agent_bridge_status", { session_id: id });
  ok("会话还在,而且仍在跑", stillThere?.session?.status === "running", JSON.stringify(stillThere?.session?.status));
  ok("后端进程还活着", stillThere?.session?.pid === pid0, JSON.stringify([stillThere?.session?.pid, pid0]));
  const rescued = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 20000 }, 30000);
  ok("被拒之后照样能把结果收回来(这才是闸门存在的意义)", rescued?.results?.[0]?.text === "PARTIAL_FINAL", JSON.stringify(rescued?.results?.[0]?.text));

  console.log("\n[T26] 先 abort 再单关(不传 force)→ 放行(abort 是正当出口)");
  await s.call("agent_bridge_send_message", { session_id: id, message: "go" });
  await sleep(500);
  const ab = await s.call("agent_bridge_abort", { session_id: id }, 15000);
  ok("abort 成功", ab?.aborted === true, JSON.stringify(ab));
  const afterAbort = await s.call("agent_bridge_status", { session_id: id });
  ok("abort 之后是 idle", afterAbort?.session?.status === "idle", JSON.stringify(afterAbort?.session?.status));
  const closedAfterAbort = await s.call("agent_bridge_close_session", { session_id: id });
  ok("此时单关放行", closedAfterAbort?.closed === true, JSON.stringify(closedAfterAbort));

  console.log("\n[T25] running 会话 + force:true → 真的关掉(不只是返回 closed:true)");
  const id2 = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  await s.call("agent_bridge_send_message", { session_id: id2, message: "go" });
  await sleep(600);
  const pid2 = (await s.call("agent_bridge_status", { session_id: id2 }))?.session?.pid;
  ok("拿到了 pid", !!pid2, String(pid2));
  const forced = await s.call("agent_bridge_close_session", { session_id: id2, force: true });
  ok("closed:true", forced?.closed === true, JSON.stringify(forced));
  // 用**列表**判存活,别指望 status(id) 的错误响应能被解析出来(错误响应没有 result.content,
  // 解析后是 null —— 拿 null 去匹配 "unknown session" 会永远为假,那才是真的空绿)。
  const listAfter = await s.call("agent_bridge_status", {});
  ok("会话真的从列表里消失了", !(listAfter?.sessions || []).some(x => x.id === id2), JSON.stringify((listAfter?.sessions || []).map(x => x.id)));
  let dead = false;
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid2, 0);
    } catch {
      dead = true;
      break;
    }
    await sleep(150);
  }
  ok("后端进程真的没了", dead, `pid=${pid2}`);

  console.log("\n[T27] 有 running 会话时批量关(不传 force)→ 原子 preflight:一个都不关");
  const a = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  const b = (await s.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  await s.call("agent_bridge_send_message", { session_id: a, message: "go" }); // 只有 a 在跑,b 空闲
  await sleep(600);
  const pidB = (await s.call("agent_bridge_status", { session_id: b }))?.session?.pid;
  ok("空闲会话 b 也有 pid(否则下面的'没被殃及'是空绿)", !!pidB, String(pidB));
  // ⚠️ 基线必须在批量关**之前**量。放到之后再比,两次读数中间什么都没发生,断言恒真 = 空绿。
  const before = ((await s.call("agent_bridge_status", {}))?.sessions || []).map(x => x.id);
  ok("批量关之前记下基线(别写死数字:前面的用例可能留下会话)", before.length >= 2 && before.includes(a) && before.includes(b), JSON.stringify(before));
  const bulkBlocked = await s.call("agent_bridge_close_session", {});
  ok("closedAll:false 且 count:0", bulkBlocked?.closedAll === false && bulkBlocked?.count === 0, JSON.stringify(bulkBlocked));
  ok("blocked:true", bulkBlocked?.blocked === true, JSON.stringify(bulkBlocked?.blocked));
  ok("runningSessionIds 只点名真在跑的那个", JSON.stringify(bulkBlocked?.runningSessionIds) === JSON.stringify([a]), JSON.stringify(bulkBlocked?.runningSessionIds));
  const listed = await s.call("agent_bridge_status", {});
  ok("会话列表**没有**被清空", (listed?.sessions || []).length === before.length, `after=${JSON.stringify((listed?.sessions || []).map(x => x.id))} before=${JSON.stringify(before)}`);
  const bStill = await s.call("agent_bridge_status", { session_id: b });
  ok("空闲的 b 也一个没关(原子:要么全关要么都不关)", bStill?.session?.pid === pidB, JSON.stringify([bStill?.session?.pid, pidB]));

  console.log("\n[T28] 同上 + force:true → 全关掉");
  const pidA = (await s.call("agent_bridge_status", { session_id: a }))?.session?.pid;
  const bulkForced = await s.call("agent_bridge_close_session", { force: true });
  ok("closedAll:true", bulkForced?.closedAll === true, JSON.stringify(bulkForced));
  ok("count 等于当时的会话数", bulkForced?.count === before.length, `${bulkForced?.count} vs ${before.length}`);
  const emptied = await s.call("agent_bridge_status", {});
  ok("列表清空了", (emptied?.sessions || []).length === 0, JSON.stringify(emptied?.sessions));
  let bothDead = true;
  for (const p of [pidA, pidB]) {
    let d = false;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(p, 0);
      } catch {
        d = true;
        break;
      }
      await sleep(150);
    }
    if (!d) bothDead = false;
  }
  ok("两个后端进程都真的没了", bothDead, JSON.stringify([pidA, pidB]));

  await s.kill();
}

async function main() {
  await t2_schema_defaults_no_env();
  await t3_schema_default_env_override();
  await t3b_env_boundaries();
  await t9_t12_wait_shapes();
  await t13_t14_two_clocks();
  await t1_t8_t15_ack_decoration();
  await t5_codex_fast_settle();
  await t6_codex_not_accepted();
  await t16_t23_turn_settled();
  await t21_five_backends_settled();
  await t22_schema_pending();
  await t24_t28_close_guard();

  console.log(`\n[harness] ${passed} 通过 / ${failed} 失败`);
  if (failed) {
    console.log("[harness] >>> FAIL");
    process.exit(1);
  }
  console.log("[harness] >>> PASS: 收口纪律的机制契约成立(C2 默认形状 / C3 双时钟分离)");
  process.exit(0);
}

main().catch(e => {
  console.log(`[harness] >>> FAIL: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
