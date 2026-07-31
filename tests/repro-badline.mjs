// Repro/verify: a line that PARSES as JSON but is not an object must never kill the server.
//
// The bug: every line consumer did `msg = JSON.parse(line)` and then read a property off the result.
// `JSON.parse("null")` succeeds and returns null, so `msg.type` throws TypeError — and all of these
// run inside an `rl.on("line")` listener, where a throw is an UNCAUGHT exception that
// installProcessHandlers turns into cleanupAndExit(1). One `null` line from ANY backend (or from an
// MCP client) took down the whole server and every session on it. Six sites had it, including the
// MCP stdin main loop. Fixed by welding the object check to the parse (parseMessageLine).
//
// Two independent surfaces are exercised here:
//   A. BACKEND side — the fake omp emits bare `null` / `123` / `[]` / `"str"` lines mid-session.
//   B. CLIENT side  — we send those same shapes down the MCP stdin pipe ourselves.
// PASS = the server survives both and still answers a normal request afterwards.
// Without the fix, A kills the server outright (and B kills it too).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ab-badline-"));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};

const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE, OMP_BIN: FAKE, FAKE_OMP_MODE: "badline" },
});
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; console.log(`[srv-close] code=${code} signal=${signal}`); });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));

const responses = new Map();
// Errors for a line we could not attribute to a request come back with id:null — they never land in
// `responses` (keyed by id), so they are collected separately. Without this the error-code assertions
// below would have nothing to look at and would silently degrade into "the server is still alive".
const unsolicitedErrors = [];
let buf = "";
srv.stdout.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (!m) continue;
      if (m.id !== undefined && m.id !== null) responses.set(m.id, m);
      else if (m.error) unsolicitedErrors.push(m.error);
    } catch {}
  }
});
const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
const raw = s => srv.stdin.write(`${s}\n`);
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
const bail = msg => { console.log(`[harness] >>> FAIL: ${msg}`); try { srv.kill("SIGKILL"); } catch {} process.exit(1); };

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-badline", version: "0" } } });
  if (!await waitResp(initId, 10000)) return bail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  // ── A. backend emits non-object JSON lines ────────────────────────────────────────────────────
  console.log("\n[A] 后端吐出「能 parse 但不是对象」的行(null / 123 / [] / 字符串)");
  const openId = nextId++;
  rpc({ jsonrpc: "2.0", id: openId, method: "tools/call", params: { name: "agent_bridge_open_session", arguments: { agent: "omp", cwd: CWD } } });
  const sid = parse(await waitResp(openId, 30000))?.session?.id;
  ok("会话开起来了", !!sid, "open_session 就失败了,后面的断言无意义");
  if (!sid) return bail("open_session failed");

  // The fake emits the poison lines when prompted, then a normal answer.
  const sendId = nextId++;
  rpc({ jsonrpc: "2.0", id: sendId, method: "tools/call", params: { name: "agent_bridge_send_message", arguments: { session_id: sid, message: "go" } } });
  ok("send 被接收", !!await waitResp(sendId, 10000));

  const waitId = nextId++;
  rpc({ jsonrpc: "2.0", id: waitId, method: "tools/call", params: { name: "agent_bridge_wait", arguments: { session_ids: [sid], mode: "all", timeout_ms: 15000 } } });
  const w = parse(await waitResp(waitId, 25000));
  ok("桥没被毒行打死(wait 正常返回)", !!w, exited ? `服务已退出 code=${exited.code}` : "wait 没回话");
  ok("毒行之后仍拿到了正常答案", w?.results?.[0]?.text === "BADLINE_ANSWER", JSON.stringify(w?.results?.[0]?.text));

  // ── B. an MCP client sends the same shapes ────────────────────────────────────────────────────
  console.log("\n[B] MCP 客户端自己发「能 parse 但不是对象」的行");
  unsolicitedErrors.length = 0;
  for (const poison of ["null", "123", "[]", '"just a string"', "true"]) {
    raw(poison);
    await sleep(80);
    ok(`发送 ${poison} 之后服务还活着`, !exited, `服务退出了 code=${exited?.code}`);
    if (exited) break;
  }
  // 能解析、但不是请求对象 → JSON-RPC 的 -32600 Invalid Request。
  // ⚠️ 这条断言不能省:注释里写了要区分两个错误码,只查"服务活着"的话,谁把两类合并回去测试照样绿 ——
  //    那样注释就变成了一个没人守的契约。
  const invalidRequest = unsolicitedErrors.filter(e => e?.code === -32600);
  ok("非对象的行回的是 -32600(Invalid Request)", invalidRequest.length === 5,
     `拿到 ${invalidRequest.length} 条 -32600,全部错误=${JSON.stringify(unsolicitedErrors)}`);
  // 反空绿:`[].every()` 恒为 true —— 没有 -32600 时这条会假过,必须先要求非空
  ok("-32600 的说明里点明了收到的是什么",
     invalidRequest.length > 0 && invalidRequest.every(e => /expected a JSON object/i.test(e?.message || "")),
     JSON.stringify(invalidRequest.map(e => e?.message)));

  // 语法错 → -32700 Parse error,和上面那类必须是**两个**码
  unsolicitedErrors.length = 0;
  raw("{not json");
  await sleep(150);
  ok("语法错的行也没打死服务", !exited);
  const parseErrors = unsolicitedErrors.filter(e => e?.code === -32700);
  ok("语法错回的是 -32700(Parse error),与 -32600 分开", parseErrors.length === 1,
     `拿到 ${JSON.stringify(unsolicitedErrors)}`);

  // ── C. still fully functional afterwards ──────────────────────────────────────────────────────
  console.log("\n[C] 收完这些毒行,服务必须仍然可用");
  const stId = nextId++;
  rpc({ jsonrpc: "2.0", id: stId, method: "tools/call", params: { name: "agent_bridge_status", arguments: {} } });
  const after = parse(await waitResp(stId, 10000));
  ok("毒行之后 status 仍然可用", after !== null && after !== undefined, exited ? `服务已退出` : "没回话");

  const closeId = nextId++;
  rpc({ jsonrpc: "2.0", id: closeId, method: "tools/call", params: { name: "agent_bridge_close_session", arguments: {} } });
  await waitResp(closeId, 8000);

  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  try { srv.stdin.end(); } catch {}
  setTimeout(() => { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {} process.exit(fail === 0 ? 0 : 1); }, 1500);
}

main().catch(e => bail(String(e)));
