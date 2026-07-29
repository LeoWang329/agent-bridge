// 桥插桩的机器验收 —— **零消耗**(假 OMP 后端),但走的是真 MCP server、真会话、真轮次。
//
// 它回答的是 `repro-viz-writer` 与 `test-viz` 都回答不了的那个问题:
// **桥把该记的都记下来了吗,记的和合同一致吗。**
//   - writer 的回归只证明"recorder 被这样调用时会写出什么";
//   - 这一份证明"桥真的会那样调用它"。
// 中间那条缝正是漂移的藏身处(§S1-X 已经抓到过一次:两侧全绿而口径不一致)。
//
// 判据一律是**整目录交给独立校验器** + 对快照内容的写死断言,不接受"跑起来没报错"。
//
// 跑法:node docs/repro-mcp-hang/repro-viz-bridge.mjs

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BRIDGE = path.join(ROOT, "scripts/agent-bridge.mjs");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const { checkVizDir } = await import(`file://${path.join(ROOT, "skills/agent-bridge/viz/contract-invariants.mjs")}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);

// ⚠️ 把 TMPDIR 指到一个专属目录:viz run 目录建在 `os.tmpdir()` 下,
//    不隔离的话就得在满是别人临时文件的目录里猜哪个是自己的。
const BOX = fs.mkdtempSync(path.join(os.tmpdir(), "ab-vizbridge-"));
const STATE = path.join(BOX, "state");
const TMP = path.join(BOX, "tmp");
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    AGENT_BRIDGE_STATE_DIR: STATE,
    OMP_BIN: FAKE,
    // ⚠️ 模式选 `partialslow` 不是随手挑的:它 200ms 吐一截、2500ms 才收尾,
    //    于是**存在一个真实的在途窗口**。快模式(multiturn-fast)下轮次在采样之前就结算了,
    //    "dispatched 阶段 output 必须是 pending" 这类断言会取到 settled 快照而假红/假绿——
    //    考在途状态,就必须真的有在途状态。
    FAKE_OMP_MODE: "partialslow",
    AGENT_BRIDGE_VIZ: "on",
    TEMP: TMP, TMP, TMPDIR: TMP,
  },
});
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));

const responses = new Map();
let buf = "";
srv.stdout.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m && m.id !== undefined) responses.set(m.id, m); } catch {}
  }
});
const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
let nextId = 1;
async function waitResp(id, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (responses.has(id)) return responses.get(id);
    if (exited) return null;
    await sleep(40);
  }
  return undefined;
}
const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
const call = async (name, args, ms = 30000) => {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return parse(await waitResp(id, ms));
};

/** 找出这个桥进程建的 viz 目录。TMPDIR 已隔离,所以只可能有一个。 */
function vizDir() {
  const hits = fs.readdirSync(TMP).filter(n => n.startsWith("agent-bridge-viz-"));
  return hits.length === 1 ? path.join(TMP, hits[0]) : null;
}
function snapshot(dir) {
  const read = i => { try { return JSON.parse(fs.readFileSync(path.join(dir, `state.${i}.json`), "utf8")); } catch { return null; } };
  const a = read(0), b = read(1);
  if (!a) return b; if (!b) return a;
  return a.generation >= b.generation ? a : b;
}

function finish(code) {
  try { srv.kill("SIGKILL"); } catch {}
  console.log(`\n========================================================`);
  console.log(`  repro-viz-bridge: ${pass} passed, ${fail} failed`);
  console.log(`========================================================\n`);
  try { fs.rmSync(BOX, { recursive: true, force: true }); } catch {}
  process.exit(code ?? (fail ? 1 : 0));
}

// ═══════════════════════════════════════════════════════════════════════════

rpc({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: {} });
await sleep(500);

sect("V1 观测目录与身份");

const dir = vizDir();
ok("V1 桥起服务时建了**恰好一个** viz run 目录", !!dir, `TMP 下: ${fs.readdirSync(TMP).join(", ")}`);
if (!dir) finish(1);

const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
ok("V1 meta.json 的 pid 就是桥进程自己", meta.pid === srv.pid, `meta=${meta.pid} srv=${srv.pid}`);
ok("V1 owner 文件在(viewer 靠它判 run 还活着)", fs.existsSync(path.join(dir, "owner")));

sect("V2 一轮完整委托");

const opened = await call("agent_bridge_open_session", { agent: "omp", cwd: ROOT });
const sid = opened?.session?.id;
ok("V2 会话开起来了", !!sid, JSON.stringify(opened)?.slice(0, 200));

await sleep(300);
{
  const snap = snapshot(dir);
  const s = snap?.sessions?.find(x => x.sessionId === sid);
  // ⚠️ 这句只证明"开完之后卡片在",**不**证明"登记发生在 start() 之前"——后端正常时
  //    两种实现写出来的快照一模一样。那个更强的命题由 V5 用 `deafstart` 来考。
  //    (原先这里挂着 ★ 说自己证了后者,是一句**不具判别力**的断言:插桩挪到 start() 之后它照样绿。)
  ok("V2 会话开完后在快照里有卡片",
    !!s, JSON.stringify(snap?.sessions?.map(x => x.sessionId)));
  ok("V2 会话字段是逐字段白名单来的(agent/cwd/access 都在,且没有多余键)",
    s?.agent === "omp" && s?.cwd === ROOT && s?.access === "read");
  ok("V2 logFile 已带上(页面的逃生门)", typeof s?.logFile === "string" && s.logFile.length > 0, String(s?.logFile));
}

await call("agent_bridge_send_message", { session_id: sid, message: "第一问" });
await sleep(700);   // 落在 200ms(有部分正文)与 2500ms(收尾)之间 —— 轮次此刻**确实在途**
{
  const snap = snapshot(dir);
  const t = snapshot(dir)?.sessions?.find(x => x.sessionId === sid)?.turns?.[0];
  ok("V2 ★ 轮次在 ACK 之后就公开了(dispatched)", t?.state === "dispatched", JSON.stringify({ state: t?.state }));
  ok("V2 ★ 边界是协议级的 `rpc_ack`(不是 pipe_enqueued 那种只证明写进管道的档)",
    t?.boundary === "rpc_ack", String(t?.boundary));
  ok("V2 输入正文已落盘且公布了 ref 与指纹",
    t?.input?.state === "ready" && /^turns\/.+\/t1\.in\.md$/.test(t?.input?.ref || "") && /^[0-9a-f]{64}$/.test(t?.input?.sha256 || ""),
    JSON.stringify(t?.input));
  ok("V2 输入的 originalBytes 与 bytes 恒等(未截断)",
    t?.input?.truncated === false && t.input.originalBytes === t.input.bytes,
    JSON.stringify(t?.input));
  ok("V2 dispatched 阶段 output 计数恒为 null(那时还没有正文可数)",
    t?.output?.state === "pending" && t.output.chars === null && t.output.bytes === null,
    JSON.stringify(t?.output));
  ok("V2 dispatched 阶段 outcome/bodyKind 必须是 null", t?.outcome === null && t?.bodyKind === null);

  // §5 的实时预览 sidecar。它是**独立文件**,不进快照——快照只在里程碑写,
  // 而预览是每 token 级的;混在一起就得为了一句预览推进一次代次。
  const side = path.join(dir, "turns", sid, "t1.progress.json");
  ok("V2 ★ 在途轮次有实时预览 sidecar(与快照分开的第三条通道)", fs.existsSync(side), side);
  if (fs.existsSync(side)) {
    const p = JSON.parse(fs.readFileSync(side, "utf8"));
    ok("V2 sidecar 的 vizTurnId 与当前轮次对得上(否则页面会把上一轮的预览贴到这一轮)",
      p.vizTurnId === t?.vizTurnId, JSON.stringify({ side: p.vizTurnId, turn: t?.vizTurnId }));
    ok("V2 ★ sidecar 里是**已经写出来的那一截**,不是空壳",
      typeof p.tail === "string" && p.tail.includes("PARTIAL_"), JSON.stringify(p).slice(0, 200));
  }
  const v = checkVizDir(dir);
  ok("V2 在途状态下目录也通过独立校验器", v.violations.length === 0, JSON.stringify(v.violations));
}

const waited = await call("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 20000 });
await sleep(600);
{
  const t = snapshot(dir)?.sessions?.find(x => x.sessionId === sid)?.turns?.[0];
  ok("V2 ★ 结算后 outcome=completed、bodyKind=final", t?.outcome === "completed" && t?.bodyKind === "final",
    JSON.stringify({ o: t?.outcome, k: t?.bodyKind }));
  ok("V2 输出正文落盘并公布 ref/指纹",
    t?.output?.state === "ready" && /\/t1\.out\.md$/.test(t?.output?.ref || "") && /^[0-9a-f]{64}$/.test(t?.output?.sha256 || ""),
    JSON.stringify(t?.output));
  ok("V2 ★ 落盘的正文与快照里的指纹逐字节对得上(页面「这就是记录里的那一份」的全部依据)", (() => {
    try {
      const buf = fs.readFileSync(path.join(dir, t.output.ref.split("/").join(path.sep)));
      return crypto.createHash("sha256").update(buf).digest("hex") === t.output.sha256
        && buf.length === t.output.bytes;
    } catch { return false; }
  })(), JSON.stringify(t?.output));
  ok("V2 ★ `collected` 记下了这次交付(wait 走 DELIVERED_TURN 通道)",
    t?.collected?.via === "wait", JSON.stringify(t?.collected));
  ok("V2 settledAt / durationMs 都有值", !!t?.settledAt && Number.isInteger(t?.durationMs));
  // 结算即销毁 sidecar:留着它,viewer 会一直轮询一个永远不再更新的死文件,
  // 页面上那条"实时预览"就永久停在最后一帧,看起来像卡住了。
  ok("V2 ★ 结算之后 sidecar 被删掉(不留一个永远不再更新的死文件)",
    !fs.existsSync(path.join(dir, "turns", sid, "t1.progress.json")));
  ok("V2 正文是**完整**的最终答复,不是中途那一截",
    (() => { try { return fs.readFileSync(path.join(dir, t.output.ref.split("/").join(path.sep)), "utf8") === "PARTIAL_FINAL"; } catch { return false; } })(),
    "期望 PARTIAL_FINAL");
  ok("V2 wait 确实拿到了结果", Array.isArray(waited?.results) && waited.results.length === 1, JSON.stringify(waited)?.slice(0, 200));
}

sect("V3 独立校验器判整个目录");

{
  const v = checkVizDir(dir);
  ok("V3 ★ 桥产出的 viz 目录通过独立校验器", v.violations.length === 0 && v.chosen !== null,
    JSON.stringify({ chosen: v.chosen, violations: v.violations }));
}

sect("V4 关会话与退出");

await call("agent_bridge_close_session", { session_id: sid });
await sleep(300);
{
  const s = snapshot(dir)?.sessions?.find(x => x.sessionId === sid);
  ok("V4 ★ 关会话被记成 `closed` 对象(区别于后端自己退出)",
    !!s?.closed && s.closed.forced === false && typeof s.closed.at === "string", JSON.stringify(s?.closed));
  ok("V4 关会话后 status 也是 closed", s?.status === "closed", String(s?.status));
  const v = checkVizDir(dir);
  ok("V4 关会话之后目录仍然合法", v.violations.length === 0, JSON.stringify(v.violations));
}

// 正常退出必须把整个目录删掉 —— 里面是全量委托明文。
srv.stdin.end();
for (let i = 0; i < 100 && !exited; i++) await sleep(100);
ok("V4 桥干净退出", !!exited && exited.code === 0, JSON.stringify(exited));
ok("V4 ★ 正常退出把整个 viz 目录删掉(里面是全量委托明文)", !fs.existsSync(dir), dir);

// ═══════════════════════════════════════════════════════════════════════════
// 通用台架:起一个独立的桥进程(自带 TMPDIR/STATE 隔离)、开一个会话、跑一轮、把
// 快照交回来。V5~V9 五段各要一个不同后端的真桥进程,**照抄五遍 MCP 客户端就等于
// 维护一张会漏的清单**——本仓在"每处都记得改"上已经栽过好几次,不再重来一次。
async function bridgeRun({ tag, env, agent, openArgs = {}, message = "问一句", waitMs = 25000 }) {
  const tmp = path.join(BOX, `tmp-${tag}`);
  const state = path.join(BOX, `state-${tag}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  const proc = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: {
      ...process.env,
      AGENT_BRIDGE_STATE_DIR: state,
      AGENT_BRIDGE_VIZ: "on",
      TEMP: tmp, TMP: tmp, TMPDIR: tmp,
      ...env,
    },
  });
  let dead = null;
  proc.on("close", (code, signal) => { dead = { code, signal }; });
  proc.stderr.on("data", d => process.stdout.write(`[${tag}-stderr] ${d}`));
  const resps = new Map();
  let rbuf = "";
  proc.stdout.on("data", d => {
    rbuf += d.toString();
    let i;
    while ((i = rbuf.indexOf("\n")) >= 0) {
      const line = rbuf.slice(0, i).trim(); rbuf = rbuf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) resps.set(m.id, m); } catch {}
    }
  });
  let seq = 1;
  const send = o => proc.stdin.write(JSON.stringify(o) + "\n");
  // 工具调用失败时返回 `{ __error }`,而不是 null —— "开会话失败了"与"没收到响应"
  // 是两件不同的事,混成同一个 null,V5 那段就没法证明它考的是前者。
  const rcall = async (name, args, ms = 30000) => {
    const id = seq++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (resps.has(id)) {
        const r = resps.get(id);
        if (r.error) return { __error: r.error.message || JSON.stringify(r.error) };
        const t = r?.result?.content?.[0]?.text;
        return t ? JSON.parse(t) : null;
      }
      if (dead) return null;
      await sleep(40);
    }
    return null;
  };
  const stop = async () => {
    try { proc.stdin.end(); } catch {}
    for (let i = 0; i < 60 && !dead; i++) await sleep(100);
    try { proc.kill("SIGKILL"); } catch {}
  };

  send({ jsonrpc: "2.0", id: seq++, method: "initialize", params: {} });
  await sleep(500);
  const hits = fs.readdirSync(tmp).filter(n => n.startsWith("agent-bridge-viz-"));
  const rdir = hits.length === 1 ? path.join(tmp, hits[0]) : null;
  if (!rdir) { await stop(); return { dir: null, hits, stop: async () => {} }; }

  const opened = await rcall("agent_bridge_open_session", { agent, cwd: ROOT, ...openArgs });
  const rsid = opened?.session?.id;
  const openError = opened?.__error ?? (rsid ? null : JSON.stringify(opened)?.slice(0, 300) ?? "no response");
  const pick = () => {
    const snap = snapshot(rdir);
    const sess = snap?.sessions?.find(x => (rsid ? x.sessionId === rsid : true)) ?? null;
    return { snap, session: sess, turn: sess?.turns?.[0] ?? null };
  };
  if (!rsid) { await sleep(400); return { dir: rdir, sid: null, openError, call: rcall, pick, stop, ...pick() }; }

  await rcall("agent_bridge_send_message", { session_id: rsid, message });
  await rcall("agent_bridge_wait", { session_ids: [rsid], mode: "all", timeout_ms: waitMs });
  await sleep(600);
  return { dir: rdir, sid: rsid, openError: null, call: rcall, pick, stop, ...pick() };
}

/** 五个后端共用的一段收口断言:结算干净 + 整目录过独立校验器。 */
function assertSettledAndValid(tag, r) {
  ok(`${tag} 轮次正常结算并留下正文`,
    r.turn?.outcome === "completed" && r.turn?.bodyKind === "final" && r.turn?.output?.state === "ready",
    JSON.stringify({ o: r.turn?.outcome, k: r.turn?.bodyKind, s: r.turn?.output?.state }));
  const v = checkVizDir(r.dir);
  ok(`${tag} ★ 该后端产出的目录同样通过独立校验器`, v.violations.length === 0 && v.chosen !== null,
    JSON.stringify(v.violations));
}

// ═══════════════════════════════════════════════════════════════════════════
sect("V5 起不来的会话也必须有卡片(open_session 失败 ⇒ openFailed)");

// ⚠️ 这一段替换了原来那句「会话在 start() 之前就已登记」。
//    那句断言**不具判别力**:后端正常时,登记早于还是晚于 `start()` 写出来的快照长得一样,
//    把插桩挪到 `start()` 之后它照样绿。**能被这条断言杀死的实现,才值得写这条断言。**
//    真正要证的是:**后端根本起不来的那一次,页面上也要有卡片**——那正是最需要看见它的时候。
//
//    用 `hang-bin`(进程正常起来、却永远不吐 `ready`)⇒ OMP 的 ready 等待超时 ⇒ `start` 阶段失败。
//    ⚠️ 这里**不能**用 `FAKE_OMP_MODE=deafstart`:那个模式只对**请求**装聋,启动时照样
//       `say({type:"ready"})`,于是 open_session 反而成功——第一版就是这么写的,两条断言当场变红。
//       "名字听起来对"不等于"行为对",挑桩子要看它到底吐什么。
{
  const r = await bridgeRun({
    tag: "deaf",
    agent: "omp",
    // 把 ready 超时从默认 45s 压到 2.5s:这一段考的是"超时之后留下什么",
    // 不是"要等多久"。默认值会让整份回归多跑 45 秒,没人会长期忍受一个这么慢的闸门。
    env: {
      OMP_BIN: path.join(HERE, process.platform === "win32" ? "hang-bin.cmd" : "hang-bin.sh"),
      AGENT_BRIDGE_OMP_READY_TIMEOUT_MS: "2500",
    },
    waitMs: 8000,
  });
  ok("V5 后端永远不吐 ready 时 open_session 确实失败了(否则这段考不到任何东西)",
    !!r.openError, String(r.openError).slice(0, 200));
  ok("V5 ★ 起不来的会话在快照里仍有卡片(登记发生在 start() 之前)",
    !!r.session, JSON.stringify(r.snap?.sessions?.map(x => x.sessionId)));
  ok("V5 ★ 卡片上写明是在哪一步倒下的(openFailed.phase=start)",
    r.session?.openFailed?.phase === "start" && typeof r.session?.openFailed?.error === "string",
    JSON.stringify(r.session?.openFailed));
  ok("V5 这种会话没有轮次(start 都没过去,谈不上派发)",
    (r.session?.turns?.length ?? 0) === 0, JSON.stringify(r.session?.turns));
  const v = checkVizDir(r.dir);
  ok("V5 open 失败的目录也通过独立校验器", v.violations.length === 0, JSON.stringify(v.violations));
  await r.stop();
}

// ═══════════════════════════════════════════════════════════════════════════
sect("V6~V9 证据档必须跟着后端走,不是全局常量");

// ⚠️ 这四段的价值不在"这些后端也能跑",而在**`boundary` 不是一句永远为真的废话**。
//    OMP 有协议级 ACK ⇒ `rpc_ack`;codex 有 turn/start 的响应或 turn_started 通知
//    ⇒ `turn_start_ack` / `turn_started_notification`;claude 的 `#write` 是无 callback 的
//    裸 `stdin.write`,只能证明「字节交给了管道」⇒ `pipe_enqueued`;cursor/kimi 是形状 B,
//    每轮短进程,只知道「进程起来了」⇒ `os_spawned`。
//    后三档页面只能写「已派发,等待后端输出」——**四个后端都记成同一档,这个字段就废了**。
//    (另外:cursor / kimi 的插桩此前从未被任何测试执行过,那里的笔误只能靠这里抓。)

{
  const r = await bridgeRun({
    tag: "claude", agent: "claude",
    env: {
      CLAUDE_BIN: path.join(HERE, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh"),
      FAKE_CLAUDE_MODE: "bigresult",
    },
  });
  ok("V6 claude 会话开起来了", !!r.sid, String(r.openError).slice(0, 200));
  ok("V6 ★ claude 的派发证据是 `pipe_enqueued`,不是协议级的 rpc_ack",
    r.turn?.boundary === "pipe_enqueued", String(r.turn?.boundary));
  assertSettledAndValid("V6", r);
  await r.stop();
}

{
  const r = await bridgeRun({
    tag: "codex", agent: "codex",
    env: { CODEX_BIN: path.join(HERE, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex.sh") },
  });
  ok("V7 codex 会话开起来了", !!r.sid, String(r.openError).slice(0, 200));
  // 两个值都合法:一次 stdout flush 可能把 turn_started 通知排在 turn/start 响应的续体之前。
  // **写死其中一个就是把一场竞态钉成必然**,那种断言会在别人的机器上随机变红。
  ok("V7 ★ codex 的派发证据是它自己那两档之一(turn_start_ack / turn_started_notification)",
    r.turn?.boundary === "turn_start_ack" || r.turn?.boundary === "turn_started_notification",
    String(r.turn?.boundary));
  ok("V7 ★ codex 绑上了后端自己的轮次 id(这一档比 os_spawned 强就强在这儿)",
    typeof r.turn?.backendTurnId === "string" && r.turn.backendTurnId.length > 0,
    String(r.turn?.backendTurnId));
  assertSettledAndValid("V7", r);
  await r.stop();
}

if (process.platform !== "win32") {
  console.log("  [SKIP] V8/V9 cursor 与 kimi 是 Windows-only 后端(v1),本平台跳过");
} else {
  // ── cursor:装一套假的 cursor-agent 目录(versions/<ver>/{node.exe,index.js}) ──
  {
    const root = path.join(BOX, "cursor-install");
    const ver = path.join(root, "versions", "2026.07.09-deadbeef");
    fs.mkdirSync(ver, { recursive: true });
    const nodeTarget = path.join(ver, "node.exe");
    try { fs.linkSync(process.execPath, nodeTarget); } catch { fs.copyFileSync(process.execPath, nodeTarget); }
    fs.copyFileSync(path.join(HERE, "fake-cursor-index.js"), path.join(ver, "index.js"));

    const r = await bridgeRun({
      tag: "cursor", agent: "cursor",
      env: { CURSOR_AGENT_BIN: root, FAKE_CURSOR_MODE: "ok" },
    });
    ok("V8 cursor 会话开起来了", !!r.sid, String(r.openError).slice(0, 200));
    ok("V8 ★ cursor 的派发证据只能是 `os_spawned`(形状 B:每轮短进程,只知道进程起来了)",
      r.turn?.boundary === "os_spawned", String(r.turn?.boundary));
    assertSettledAndValid("V8", r);
    await r.stop();
  }

  // ── kimi:需要一个 argv0 就是 kimi.exe 的转发 stub(resolveKimiBin 认这个名字)。
  //    编译方式照抄 repro-kimi.mjs —— 那边已经证明这条路在本机可行。
  {
    const kroot = path.join(BOX, "kimi-bin");
    fs.mkdirSync(kroot, { recursive: true });
    const stubExe = path.join(kroot, "kimi.exe");
    const CS_SRC = `using System;
using System.Diagnostics;
class KimiStub {
  static int Main() {
    string full = Environment.CommandLine;
    int idx;
    if (full.Length > 0 && full[0] == '"') { int q = full.IndexOf('"', 1); idx = (q < 0) ? full.Length : q + 1; }
    else { int sp = full.IndexOf(' '); idx = (sp < 0) ? full.Length : sp; }
    string tail = full.Substring(idx);
    string script = Environment.GetEnvironmentVariable("FAKE_KIMI_SCRIPT");
    string node = Environment.GetEnvironmentVariable("FAKE_KIMI_NODE");
    if (node == null || node.Length == 0) node = "node";
    var psi = new ProcessStartInfo(node, "\\"" + script + "\\"" + tail);
    psi.UseShellExecute = false;
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}`;
    const csFile = path.join(BOX, "kimi-stub.cs");
    fs.writeFileSync(csFile, CS_SRC, "utf8");
    const ps = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${csFile}') -OutputType ConsoleApplication -OutputAssembly '${stubExe}'`;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
    // ⚠️ 编译不出来就**判红**,不"静默跳过"。跳过等于把一段从没跑过的插桩记成绿的。
    ok("V9 假 kimi.exe 转发 stub 编译成功(依赖 in-box .NET C# 编译器)", fs.existsSync(stubExe), stubExe);

    if (fs.existsSync(stubExe)) {
      const r = await bridgeRun({
        tag: "kimi", agent: "kimi",
        env: {
          KIMI_BIN: stubExe, FAKE_KIMI_MODE: "ok",
          FAKE_KIMI_SCRIPT: path.join(HERE, "fake-kimi.js"), FAKE_KIMI_NODE: process.execPath,
        },
      });
      ok("V9 kimi 会话开起来了", !!r.sid, String(r.openError).slice(0, 200));
      ok("V9 ★ kimi 的派发证据同样只能是 `os_spawned`",
        r.turn?.boundary === "os_spawned", String(r.turn?.boundary));
      assertSettledAndValid("V9", r);
      await r.stop();
    }
  }
}

finish();
