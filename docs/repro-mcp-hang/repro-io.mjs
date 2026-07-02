// Repro/verify for T10 (A2): file-first I/O + summary-return.
//   return_mode:"ref"  — results omit inline text by default (text:null) but keep charCount/byteCount/
//                        textRef; an explicit max_chars overrides ref for that call.
//   message_file       — read the prompt body from a file inside the session cwd (exactly one of
//                        message / message_file); path-safety rejects anything outside cwd.
// Uses a throwaway temp dir as the session cwd (so the repo is never touched) and fake-omp `echoturn`
// (echoes the prompt back) to prove message_file content actually reaches the backend. Zero real usage.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

// A dedicated temp workspace = the session cwd. realpath it so our containment expectations match the
// bridge's realpath-based check (macOS /var→/private/var, Windows 8.3, etc).
const CWD = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "repro-io-")));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "repro-io-out-"));
fs.writeFileSync(path.join(CWD, "prompt.txt"), "PROMPT_FROM_FILE_42");
fs.writeFileSync(path.join(OUTSIDE, "evil.txt"), "OUTSIDE_SHOULD_BE_REJECTED");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "echoturn" } });
console.log(`[harness] server pid=${srv.pid} cwd=${CWD}`);
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; console.log(`[srv-close] code=${code} signal=${signal}`); });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));
const responses = new Map();
let buf = "";
srv.stdout.on("data", d => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {} } });
const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
let nextId = 1;
async function waitResp(id, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; }
const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
function cleanup() { for (const d of [CWD, OUTSIDE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); cleanup(); try { srv.kill("SIGKILL"); } catch {} process.exit(1); }
async function callRaw(name, args, ms = 15000) { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const r = await waitResp(id, ms); if (!r) return fail(`${name} no response`); return r; }
const call = async (n, a, ms) => parse(await callRaw(n, a, ms));
const errText = r => r?.error?.message || (r?.result?.isError ? (r.result.content?.[0]?.text || "") : "");

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-io", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("no init");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  // ===== return_mode:"ref" =====
  const refId = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD, return_mode: "ref" }, 30000))?.session?.id;
  if (!refId) return fail("open ref session failed");
  await call("agent_bridge_send_message", { session_id: refId, message: "hello-ref" });
  const w = await call("agent_bridge_wait", { session_ids: [refId], mode: "all", timeout_ms: 8000 });
  const r = w?.results?.[0];
  if (r?.text !== null) return fail(`ref mode should return text:null, got ${JSON.stringify(r?.text)}`);
  if (!(r?.charCount > 0)) return fail(`ref mode should still report charCount, got ${r?.charCount}`);
  if (!r?.textRef) return fail(`ref mode must provide textRef`);
  const refFile = fs.readFileSync(r.textRef, "utf8");
  if (!/ECHO:hello-ref/.test(refFile)) return fail(`textRef file should hold the full answer, got ${JSON.stringify(refFile.slice(0, 40))}`);
  console.log(`[harness] ref OK — text:null, charCount=${r.charCount}, full answer in textRef`);

  // explicit max_chars overrides ref for that call → inline text present
  const rExplicit = await call("agent_bridge_result", { session_id: refId, max_chars: 5 }, 10000);
  if (!rExplicit?.text) return fail(`explicit max_chars should override ref (inline text), got ${JSON.stringify(rExplicit?.text)}`);
  console.log(`[harness] ref-override OK — explicit max_chars returns inline text ("${rExplicit.text}")`);

  // ===== message_file =====
  const fId = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!fId) return fail("open file session failed");

  // valid: relative path inside cwd → content reaches the backend (echoed back)
  await call("agent_bridge_send_message", { session_id: fId, message_file: "prompt.txt" });
  const wf = await call("agent_bridge_wait", { session_ids: [fId], mode: "all", timeout_ms: 8000 });
  if (!/ECHO:PROMPT_FROM_FILE_42/.test(wf?.results?.[0]?.text || "")) return fail(`message_file content should reach backend, got ${JSON.stringify(wf?.results?.[0]?.text)}`);
  console.log(`[harness] message_file OK — file content delivered to backend`);

  // reject: both message and message_file
  const both = await callRaw("agent_bridge_send_message", { session_id: fId, message: "x", message_file: "prompt.txt" });
  if (!/not both/i.test(errText(both))) return fail(`message+message_file should be rejected, got ${JSON.stringify(parse(both))}`);
  // reject: neither
  const neither = await callRaw("agent_bridge_send_message", { session_id: fId });
  if (!/Provide .*message/i.test(errText(neither))) return fail(`neither message nor message_file should be rejected, got ${JSON.stringify(parse(neither))}`);
  // reject: path outside cwd (absolute path to a real file elsewhere)
  const outside = await callRaw("agent_bridge_send_message", { session_id: fId, message_file: path.join(OUTSIDE, "evil.txt") });
  if (!/inside the session cwd/i.test(errText(outside))) return fail(`message_file outside cwd should be rejected for containment, got ${JSON.stringify(errText(outside))}`);
  // reject: traversal that escapes cwd
  const trav = await callRaw("agent_bridge_send_message", { session_id: fId, message_file: "../evil.txt" });
  if (!errText(trav)) return fail(`traversal message_file should be rejected, got ${JSON.stringify(parse(trav))}`);
  // reject: file over the 1 MiB cap
  fs.writeFileSync(path.join(CWD, "big.txt"), Buffer.alloc((1 << 20) + 1024, 0x61));
  const big = await callRaw("agent_bridge_send_message", { session_id: fId, message_file: "big.txt" });
  if (!/too large/i.test(errText(big))) return fail(`oversized message_file should be rejected, got ${JSON.stringify(errText(big))}`);
  console.log(`[harness] message_file guards OK — both / neither / outside-cwd / traversal / oversized all rejected`);

  console.log("[harness] >>> PASS: return_mode:ref omits inline text (keeps textRef); max_chars overrides; message_file reads inside-cwd content and rejects outside/both/neither");
  await call("agent_bridge_close_session", {}, 10000);
  cleanup();
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
main().catch(e => fail(String(e)));
