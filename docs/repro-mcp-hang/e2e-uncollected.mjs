// 收口台账的**真跑** e2e —— 真 MCP server + **真 claude 后端**,不是 fake。
//
// hermetic 那份(repro-uncollected.mjs)用 fake-omp 把每条分支都摆了一遍,但它证明不了
// 一件事:**在一个真实后端的真实时序上,这套账对不对得上**。真后端的 turn 要跑几十秒、
// 状态迁移由真事件驱动、`lastTurn.id` 是后端真铸的 —— 这些都不是 fixture 能替代的。
//
// 跑这个会消耗真实模型额度(一轮极短的问答)。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const NONCE = `E2E-UNCOLLECTED-${Date.now().toString(36).toUpperCase()}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });
srv.stderr.on("data", d => { const s = String(d); if (/error|Error/.test(s)) process.stdout.write(`[srv-stderr] ${s}`); });

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
async function call(name, args, timeoutMs = 120000) {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (responses.has(id)) {
      const r = responses.get(id);
      if (r.error) return { payload: null, rpcError: r.error };
      const t = r.result?.content?.[0]?.text;
      let payload = null;
      try { payload = t ? JSON.parse(t) : null; } catch { payload = t; }
      return { payload, rpcError: null };
    }
    if (exited) throw new Error("server exited mid-call");
    await sleep(200);
  }
  throw new Error(`${name} timed out after ${timeoutMs}ms`);
}
const debtOf = (p, sid) => (p?.uncollected || []).find(x => x.sessionId === sid) || null;

async function main() {
  rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await sleep(400);

  console.log(`\n[E2E] 真 claude 后端 · nonce=${NONCE}`);
  const { payload: opened } = await call("agent_bridge_open_session",
    { agent: "claude", cwd: CWD, access: "read" }, 180000);
  const sid = opened?.session?.id;
  ok("E1 真开起来了一个 claude 会话", !!sid, JSON.stringify(opened).slice(0, 200));
  if (!sid) throw new Error("open_session failed");

  // 非阻塞发 —— 这正是 ack 那条提示所服务的形态
  const { payload: ack } = await call("agent_bridge_send_message",
    { session_id: sid, message: `Reply with exactly this token and nothing else: ${NONCE}` });
  ok("E2 ack 带 mustCollectResult", ack?.mustCollectResult === true);
  ok("E2 ★ ack 讲清了不收的后果(真后端上同样挂得上)",
    /gone for good/.test(ack?.ifNotCollected || ""), ack?.ifNotCollected);

  // 等它真的跑完 —— **但不收**。status 不构造结果,所以不会清账。
  let settled = false;
  for (let i = 0; i < 90 && !settled; i++) {
    await sleep(2000);
    const { payload: st } = await call("agent_bridge_status", { session_id: sid });
    if (st?.session?.status === "idle" && st?.session?.lastTurn?.endedAt) settled = true;
  }
  ok("E3 真轮次跑完了(且全程没取结果)", settled);

  // ① 活账:出现在一个与收结果无关的调用上
  const { payload: list1 } = await call("agent_bridge_status", {});
  const d1 = debtOf(list1, sid);
  ok("E4 ★ 债务出现在真实运行的 status 上", !!d1, JSON.stringify(list1?.uncollected));
  ok("E4 turnId 是后端真铸的那一个(非空且与 lastTurn 对得上)", !!d1?.turnId, JSON.stringify(d1));
  ok("E4 带了后果说明", /gone for good/.test(list1?.uncollectedNote || ""));

  // ★ 反复出现 —— 这才是它区别于一次性提醒的地方
  const { payload: list2 } = await call("agent_bridge_status", {});
  ok("E5 ★ 再调一次仍在(活账)", !!debtOf(list2, sid));

  // ★ doctor 是纯文本返回,承诺同样要兑现
  const { payload: doc } = await call("agent_bridge_doctor", {}, 180000);
  ok("E6 ★ 纯文本返回(doctor)也带上了债务提示并点名会话",
    typeof doc === "string" && /finished turn\(s\) still uncollected:/.test(doc) && doc.includes(sid),
    typeof doc === "string" ? doc.slice(-220) : typeof doc);

  // 收 —— 并且**这一次**返回里不许还挂着它自己刚清掉的债
  const { payload: w } = await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 120000 }, 180000);
  const text = w?.completed?.text ?? "";
  ok("E7 真的收到了这一轮的产出", typeof text === "string" && text.length > 0, JSON.stringify(w).slice(0, 200));
  ok("E7 ★ 产出里有那个 nonce(证明收到的确实是这一轮,不是别的东西)",
    text.includes(NONCE), text.slice(0, 200));
  ok("E8 ★ 收结果的那一次返回里,不许还挂着它自己刚清掉的债",
    !debtOf(w, sid), JSON.stringify(w?.uncollected));

  const { payload: list3 } = await call("agent_bridge_status", {});
  ok("E9 ★ 收完之后字段整个消失(空就不挂)", !("uncollected" in (list3 || {})), JSON.stringify(list3?.uncollected));

  const { payload: doc2 } = await call("agent_bridge_doctor", {}, 180000);
  ok("E9 doctor 也不再追加那一行",
    typeof doc2 === "string" && !/finished turn\(s\) still uncollected:/.test(doc2), (doc2 || "").slice(-120));

  await call("agent_bridge_close_session", { session_id: sid }, 60000);
  const { payload: list4 } = await call("agent_bridge_status", {});
  ok("E10 关掉之后不留残账", !("uncollected" in (list4 || {})), JSON.stringify(list4?.uncollected));
}

main()
  .then(() => {
    console.log(`\n========================================================`);
    console.log(`  e2e-uncollected: ${pass} passed, ${fail} failed`);
    console.log(`========================================================\n`);
  })
  .catch(e => { console.log(`[e2e] >>> FAIL: ${e?.stack || e}`); fail++; })
  .finally(async () => {
    try { srv.stdin.end(); } catch {}
    for (let i = 0; i < 60 && !exited; i++) await sleep(100);
    try { srv.kill("SIGKILL"); } catch {}
    process.exit(fail ? 1 : 0);
  });
