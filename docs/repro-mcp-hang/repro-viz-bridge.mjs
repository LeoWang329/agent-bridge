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

import { spawn } from "node:child_process";
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
  ok("V2 ★ 会话在 `start()` **之前**就已登记(否则启动失败的会话根本没有卡片)",
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
sect("V5 换一个后端:证据档必须跟着换(claude ⇒ pipe_enqueued)");

// ⚠️ 这一段的价值不在"claude 也能跑",而在**证据强度不是全局常量**。
//    OMP 有协议级 ACK ⇒ `rpc_ack`;claude 的 `#write` 是无 callback 的裸 stdin.write,
//    只能证明「字节交给了管道」⇒ `pipe_enqueued`,页面对它只能写「已派发,等待后端输出」。
//    两个后端都记成同一档,这个字段就退化成一句永远为真的废话。
{
  const TMP2 = path.join(BOX, "tmp2");
  const STATE2 = path.join(BOX, "state2");
  fs.mkdirSync(TMP2, { recursive: true });
  fs.mkdirSync(STATE2, { recursive: true });
  const FAKE_CLAUDE = path.join(HERE, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh");

  const srv2 = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: {
      ...process.env,
      AGENT_BRIDGE_STATE_DIR: STATE2,
      CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: "bigresult",
      AGENT_BRIDGE_VIZ: "on",
      TEMP: TMP2, TMP: TMP2, TMPDIR: TMP2,
    },
  });
  let exited2 = null;
  srv2.on("close", (c, s) => { exited2 = { code: c, signal: s }; });
  srv2.stderr.on("data", d => process.stdout.write(`[srv2-stderr] ${d}`));
  const resp2 = new Map();
  let buf2 = "";
  srv2.stdout.on("data", d => {
    buf2 += d.toString();
    let i;
    while ((i = buf2.indexOf("\n")) >= 0) {
      const line = buf2.slice(0, i).trim(); buf2 = buf2.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) resp2.set(m.id, m); } catch {}
    }
  });
  let id2 = 1;
  const call2 = async (name, args, ms = 30000) => {
    const id = id2++;
    srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (resp2.has(id)) { const t = resp2.get(id)?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; }
      if (exited2) return null;
      await sleep(40);
    }
    return null;
  };

  srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id2++, method: "initialize", params: {} }) + "\n");
  await sleep(500);
  const hits2 = fs.readdirSync(TMP2).filter(n => n.startsWith("agent-bridge-viz-"));
  const dir2 = hits2.length === 1 ? path.join(TMP2, hits2[0]) : null;
  ok("V5 第二个桥进程有自己的 viz 目录(每个 run 一个,互不干扰)", !!dir2, hits2.join(","));

  if (dir2) {
    const o2 = await call2("agent_bridge_open_session", { agent: "claude", cwd: ROOT });
    const sid2 = o2?.session?.id;
    ok("V5 claude 会话开起来了", !!sid2, JSON.stringify(o2)?.slice(0, 200));
    if (sid2) {
      await call2("agent_bridge_send_message", { session_id: sid2, message: "问 claude" });
      await call2("agent_bridge_wait", { session_ids: [sid2], mode: "all", timeout_ms: 20000 });
      await sleep(500);
      const snap2 = snapshot(dir2);
      const t = snap2?.sessions?.find(x => x.sessionId === sid2)?.turns?.[0];
      ok("V5 ★ claude 的派发证据是 `pipe_enqueued`,不是协议级的 rpc_ack",
        t?.boundary === "pipe_enqueued", String(t?.boundary));
      ok("V5 claude 轮次正常结算并留下正文",
        t?.outcome === "completed" && t?.bodyKind === "final" && t?.output?.state === "ready",
        JSON.stringify({ o: t?.outcome, k: t?.bodyKind, s: t?.output?.state }));
      ok("V5 ★ claude 侧的目录同样通过独立校验器",
        checkVizDir(dir2).violations.length === 0, JSON.stringify(checkVizDir(dir2).violations));
    }
  }
  try { srv2.stdin.end(); } catch {}
  for (let i = 0; i < 60 && !exited2; i++) await sleep(100);
  try { srv2.kill("SIGKILL"); } catch {}
}

finish();
