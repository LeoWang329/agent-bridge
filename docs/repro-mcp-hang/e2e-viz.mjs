// 委托会话史观测台的**真** e2e —— 拉真后端、起真 viewer、走真 SSE。
//
// 它和 `repro-viz-bridge.mjs`(假后端)的分工是清楚的:
//   · repro-viz-bridge —— 零消耗,考**桥有没有按合同调 recorder**(时序、边界、字段)
//   · 本文件           —— 真消耗,考**整条链在真东西上成不成立**:
//                          真后端的输出 → writer 落盘 → 双槽 → serve 的 SSE → 页面拿到的字节
//
// 假后端考不到的东西恰恰是最容易出事的:真模型的输出有换行、有 Unicode、有几 KB 长度,
// 真后端的事件时序不像假的那样规整,而**页面对证的是 sha256** —— 中间任何一层多一个字节都会露馅。
//
// ⚠️ **会真的花钱。** 一个会话、两轮,尽量短。
// 跑法:node docs/repro-mcp-hang/e2e-viz.mjs

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BRIDGE = path.join(ROOT, "scripts/agent-bridge.mjs");
const SERVE = path.join(ROOT, "skills/agent-bridge/viz/serve.mjs");
const { checkVizDir } = await import(`file://${path.join(ROOT, "skills/agent-bridge/viz/contract-invariants.mjs")}`);

// 经桥拉真 agent 的 e2e 默认用 claude(见 memory: e2e 后端偏好)。
const AGENT = process.env.E2E_VIZ_AGENT || "claude";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);

const BOX = fs.mkdtempSync(path.join(os.tmpdir(), "ab-e2eviz-"));
const STATE = path.join(BOX, "state");
const TMP = path.join(BOX, "tmp");
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

let srv = null, viewer = null;
function finish(code) {
  for (const p of [viewer, srv]) { try { p?.kill("SIGKILL"); } catch {} }
  console.log(`\n========================================================`);
  console.log(`  e2e-viz: ${pass} passed, ${fail} failed`);
  console.log(`========================================================\n`);
  try { fs.rmSync(BOX, { recursive: true, force: true }); } catch {}
  process.exit(code ?? (fail ? 1 : 0));
}

// ── MCP 客户端 ──────────────────────────────────────────────────────────────

srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE, AGENT_BRIDGE_VIZ: "on", TEMP: TMP, TMP, TMPDIR: TMP },
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
let nextId = 1;
async function call(name, args, ms = 300000) {
  const id = nextId++;
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (responses.has(id)) { const t = responses.get(id)?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; }
    if (exited) return null;
    await sleep(120);
  }
  return null;
}

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
async function freePort() {
  return await new Promise(res => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════

srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: {} }) + "\n");
await sleep(600);

sect(`E1 真会话(${AGENT})`);

const dir = vizDir();
ok("E1 viz run 目录已建", !!dir, fs.readdirSync(TMP).join(","));
if (!dir) finish(1);

const opened = await call("agent_bridge_open_session", { agent: AGENT, cwd: ROOT });
const sid = opened?.session?.id;
ok("E1 真后端会话开起来了", !!sid, JSON.stringify(opened)?.slice(0, 300));
if (!sid) finish(1);

// 刻意让答案带上换行 + 非 ASCII:假后端不会自然产生这些,而它们正是
// 「字节口径」出错时最先露馅的地方(UTF-8 边界、CRLF、代理对)。
const ASK = "请只输出下面三行，不要任何解释、不要代码块：\n第一行：观测台\n第二行：café — 汉字\n第三行：done";
await call("agent_bridge_send_message", { session_id: sid, message: ASK });
const waited = await call("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 240000 });
const text = waited?.results?.[0]?.text ?? null;
ok("E1 真后端返回了正文", typeof text === "string" && text.length > 0, String(text).slice(0, 120));
await sleep(1200);   // 让 writer 的合并槽落盘

sect("E2 落盘的字节 = 后端真给的字节");

const snap = snapshot(dir);
const turn = snap?.sessions?.find(s => s.sessionId === sid)?.turns?.[0];
ok("E2 轮次已结算", turn?.state === "settled" && turn?.outcome === "completed",
  JSON.stringify({ s: turn?.state, o: turn?.outcome }));
ok("E2 边界档与后端相符", typeof turn?.boundary === "string" && turn.boundary.length > 0, String(turn?.boundary));

const outAbs = turn?.output?.ref ? path.join(dir, turn.output.ref.split("/").join(path.sep)) : null;
const outBuf = outAbs && fs.existsSync(outAbs) ? fs.readFileSync(outAbs) : null;
ok("E2 输出正文文件存在", !!outBuf, String(outAbs));
if (outBuf) {
  ok("E2 ★ 落盘字节的 sha256 与快照记的完全一致",
    crypto.createHash("sha256").update(outBuf).digest("hex") === turn.output.sha256);
  ok("E2 ★ 字节数也对得上(UTF-8 多字节没被算错)", outBuf.length === turn.output.bytes,
    `file=${outBuf.length} snap=${turn.output.bytes}`);
  // 这一条是真 e2e 独有的:假后端的答案是常量,考不出「模型真给了什么」与「我们存了什么」的差。
  ok("E2 ★ 存下来的就是调用方拿到的那一份(逐字符相等)",
    outBuf.toString("utf8") === text,
    `saved=${JSON.stringify(outBuf.toString("utf8").slice(0, 80))} got=${JSON.stringify(String(text).slice(0, 80))}`);
  ok("E2 非 ASCII 内容确实经过了这条链(不是纯 ASCII 侥幸通过)",
    /[^\x00-\x7F]/.test(outBuf.toString("utf8")), outBuf.toString("utf8").slice(0, 60));
}

const inAbs = turn?.input?.ref ? path.join(dir, turn.input.ref.split("/").join(path.sep)) : null;
if (inAbs && fs.existsSync(inAbs)) {
  ok("E2 ★ 输入存的是**原始 message**(不是拼好前缀的 argv)",
    fs.readFileSync(inAbs, "utf8") === ASK, JSON.stringify(fs.readFileSync(inAbs, "utf8").slice(0, 100)));
}
ok("E2 collected 记下了这次交付", turn?.collected?.via === "wait", JSON.stringify(turn?.collected));

sect("E3 独立校验器判真数据");

{
  const v = checkVizDir(dir);
  // ⚠️ **先证明有东西可判,再判。** 一个空目录(或一个没有任何轮次的会话)
  //    照样能让 checkVizDir 返回零违规 —— 那是一条**永远为真**的断言,
  //    整条链断在前面时它还会显示绿色,正好把失败藏起来。
  const nTurns = (snapshot(dir)?.sessions || []).reduce((n, s) => n + (s.turns?.length || 0), 0);
  ok("E3 判据的前提成立:目录里确实有已结算的轮次", nTurns > 0 && turn?.state === "settled",
    `turns=${nTurns} state=${turn?.state}`);
  ok("E3 ★ 真后端产出的 viz 目录通过独立校验器", v.violations.length === 0 && v.chosen !== null,
    JSON.stringify({ chosen: v.chosen, violations: v.violations.slice(0, 5) }));
}

sect("E4 真 viewer:SSE 与 /file");

const port = await freePort();
viewer = spawn("node", [SERVE, dir, String(port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
viewer.stderr.on("data", d => process.stdout.write(`[viewer-stderr] ${d}`));
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(200);
  try { const r = await fetch(`http://127.0.0.1:${port}/`); await r.arrayBuffer(); up = r.status < 500; } catch {}
}
ok("E4 viewer 起来了", up, `port=${port}`);

if (up) {
  // SSE:拿 hello + 首帧 state
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  let raw = "";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/events`, { signal: ctl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const t0 = Date.now();
    while (Date.now() - t0 < 3500) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (raw.includes("event: state")) break;
    }
    try { await reader.cancel(); } catch {}
  } catch {} finally { clearTimeout(t); }

  ok("E4 SSE 先发 hello", raw.indexOf("event: hello") === 0 || raw.startsWith("event: hello"), raw.slice(0, 60));
  ok("E4 SSE 发出了 state 帧", raw.includes("event: state"));
  // ★ viewer 是搬运工:state 帧必须是槽文件的**字节原样**,不是重新序列化的。
  const slotRaw = (() => {
    for (const i of [0, 1]) {
      try {
        const s = fs.readFileSync(path.join(dir, `state.${i}.json`), "utf8");
        if (JSON.parse(s).generation === snapshot(dir).generation) return s;
      } catch {}
    }
    return null;
  })();
  const dataLine = raw.split("event: state")[1]?.split("\n").find(l => l.startsWith("data:"))?.slice(5).replace(/^ /, "");
  ok("E4 ★ state 帧是槽文件的字节原样透传(viewer 不重新序列化)",
    !!slotRaw && !!dataLine && dataLine === slotRaw,
    `frame=${dataLine?.length} slot=${slotRaw?.length}`);

  // /file:实时 sha 必须等于响应体自身,且等于快照记的
  // ⚠️ 前面任何一步没成,`turn.output` 就是 undefined —— **不能让 harness 在这里抛**。
  //    一个中途崩掉的验收脚本会把它后面所有断言一起丢掉,而那些断言的红/绿正是我们要的信息。
  if (turn?.output?.ref) {
    const fr = await fetch(`http://127.0.0.1:${port}/file?ref=${encodeURIComponent(turn.output.ref)}`);
    const fb = Buffer.from(await fr.arrayBuffer());
    const live = fr.headers.get("x-viz-sha256");
    ok("E4 /file 取回 200", fr.status === 200, String(fr.status));
    ok("E4 ★ /file 的实时 sha256 = 响应体自身 = 快照记的那个",
      live === crypto.createHash("sha256").update(fb).digest("hex") && live === turn.output.sha256,
      `live=${live} snap=${turn.output.sha256}`);
    ok("E4 ★ 页面能拿到的正文与后端真给的逐字符相等", fb.toString("utf8") === text);
  } else {
    ok("E4 /file 一组断言的前提(轮次有 output.ref)", false, "前面已经断链,这一组没得考");
  }

  // 越界读必须挡住(真服务、真文件系统)
  const bad = await fetch(`http://127.0.0.1:${port}/file?ref=${encodeURIComponent("../../../etc/passwd")}`);
  ok("E4 越界 ref 被挡(400)", bad.status === 400, String(bad.status));
}

sect("E5 收尾");

await call("agent_bridge_close_session", { session_id: sid });
await sleep(500);
{
  const s = snapshot(dir)?.sessions?.find(x => x.sessionId === sid);
  ok("E5 关会话被记成 closed 对象", !!s?.closed, JSON.stringify(s?.closed));
  ok("E5 关会话后目录仍然合法", checkVizDir(dir).violations.length === 0);
}
try { viewer.kill("SIGKILL"); } catch {}
srv.stdin.end();
for (let i = 0; i < 120 && !exited; i++) await sleep(100);
ok("E5 桥干净退出", !!exited && exited.code === 0, JSON.stringify(exited));
ok("E5 ★ 正常退出把整个 viz 目录删掉(全量委托明文不留在盘上)", !fs.existsSync(dir), dir);

finish();
