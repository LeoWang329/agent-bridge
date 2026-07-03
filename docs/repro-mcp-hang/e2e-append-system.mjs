// END-TO-END test for open_session `append_system_prompt_file` against REAL omp + codex + claude.
// Proves each backend actually HONORS an injected append-system-prompt file (an ADDITIVE rule: end every
// reply with a tail marker), that the session summary reflects it, and that validation rejects bad inputs
// BEFORE spawning. omp: --append-system-prompt=<path>; claude: --append-system-prompt-file <path>; codex:
// thread/start developerInstructions.
//
// ⚠ Spends REAL tokens; needs omp + codex on PATH (claude optional). SKIPs cleanly if omp/codex absent.
// Run:  node docs/repro-mcp-hang/e2e-append-system.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const REPO = path.resolve(HERE, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Instruction file (absolute) that overrides any question with a single distinctive word.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-appendsys-"));
const rolePath = path.join(tmp, "role.md");
// ADDITIVE instruction (a tail marker), NOT an adversarial "ignore the user" override: the latter fights
// omp's base coding-agent system prompt (omp resists ignoring the user even though the append IS injected),
// so it is an unfair honor test. An additive rule cleanly proves the append reached the model on ALL three.
fs.writeFileSync(rolePath, "IMPORTANT OUTPUT RULE: You must end EVERY response with the exact marker QZX9TAIL on its own final line.\n");
// The bridge returns the realpath (canonical long form); os.tmpdir() may hand back an 8.3 short name.
const roleReal = fs.realpathSync.native(rolePath);
const emptyPath = path.join(tmp, "empty.md");
fs.writeFileSync(emptyPath, "   \n");

const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });
let buf = "";
const got = new Map();
srv.stdout.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (l) { try { const o = JSON.parse(l); if (o.id !== undefined) got.set(o.id, o); } catch {} }
  }
});
srv.stderr.on("data", () => {});
let idc = 0;
const rpc = (method, params) => { const id = ++idc; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; };
async function call(name, args, waitMs = 200000) {
  const id = rpc("tools/call", { name, arguments: args });
  const t = Date.now();
  while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(120); }
  const o = got.get(id);
  if (!o) throw new Error(`timeout waiting for ${name}`);
  if (o.error) return { __error: o.error };
  const txt = o.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}
let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };
async function shutdown() { srv.stdin.end(); await sleep(800); if (!exited) srv.kill(); await sleep(300); }

// Ask a normal question; the injected ADDITIVE rule should make the answer carry the tail marker.
async function askCapital(id) {
  await call("agent_bridge_send_message", { session_id: id, message: "What is the capital of France?" });
  const w = await call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 150000 });
  return (w.results?.[0]?.text ?? "").trim();
}

try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);
  const doc = await call("agent_bridge_doctor", {});
  const docText = doc.__raw || JSON.stringify(doc);
  const ompOk = /omp:\s*ok/i.test(docText), cdxOk = /codex:\s*ok/i.test(docText), claudeOk = /claude:\s*ok/i.test(docText);
  console.log(`[info] doctor: ${docText.split("\n").filter(l => /ok|missing/.test(l)).join(" | ")}`);
  if (!ompOk || !cdxOk) { console.log(`>>> SKIP: needs omp+codex (omp=${ompOk}, codex=${cdxOk}).`); await shutdown(); process.exit(0); }

  // ── Validation rejects (fail-fast, no backend spawned, no tokens) ──
  const relRej = await call("agent_bridge_open_session", { agent: "omp", cwd: REPO, append_system_prompt_file: "role.md" });
  check("relative path rejected before spawn", !!relRej.__error && /absolute/i.test(relRej.__error.message || ""), relRej.__error?.message);
  const missRej = await call("agent_bridge_open_session", { agent: "omp", cwd: REPO, append_system_prompt_file: path.join(tmp, "nope.md") });
  check("missing file rejected", !!missRej.__error && /not found|inaccessible/i.test(missRej.__error.message || ""), missRej.__error?.message);
  const emptyRej = await call("agent_bridge_open_session", { agent: "omp", cwd: REPO, append_system_prompt_file: emptyPath });
  check("empty file rejected", !!emptyRej.__error && /empty/i.test(emptyRej.__error.message || ""), emptyRej.__error?.message);

  // ── appendSystemPrompt is null when the param is absent ──
  const plain = await call("agent_bridge_open_session", { agent: "omp", cwd: REPO });
  check("appendSystemPrompt null when unset", plain.session?.appendSystemPrompt === null, JSON.stringify(plain.session?.appendSystemPrompt));
  if (plain.session?.id) await call("agent_bridge_close_session", { session_id: plain.session.id });

  // ── Per-backend HONOR + summary shape ──
  // omp: use a capable model. The bridge DOES inject the append into omp's systemPrompt (verified via a
  // get_state probe), but omp's DEFAULT model follows an appended instruction only flakily; deepseek-v4-pro
  // honors it reliably. codex/claude default models honor it reliably, so no model override needed there.
  const backends = [
    { agent: "omp", mode: "system", model: "deepseek/deepseek-v4-pro" },
    { agent: "codex", mode: "developer" },
    ...(claudeOk ? [{ agent: "claude", mode: "system" }] : []),
  ];
  for (const b of backends) {
    const o = await call("agent_bridge_open_session", { agent: b.agent, cwd: REPO, write: false, append_system_prompt_file: rolePath, ...(b.model ? { model: b.model } : {}) });
    const s = o.session;
    const a = s?.appendSystemPrompt;
    check(`${b.agent}: summary.appendSystemPrompt {file,bytes,mode}`, !!a && a.file === roleReal && a.bytes > 0 && a.injectionMode === b.mode, JSON.stringify(a));
    const ans = await askCapital(s.id);
    const honored = /QZX9TAIL/.test(ans);
    check(`${b.agent}: honors injected append-system (additive tail marker)`, honored, `answer=${JSON.stringify(ans).slice(0, 100)}`);
    await call("agent_bridge_close_session", { session_id: s.id });
  }

  await call("agent_bridge_close_session", {});
  await shutdown();
  check("server clean shutdown (code 0)", exited && exited.code === 0, JSON.stringify(exited));
} catch (e) {
  check(`no exception`, false, e.message);
  try { srv.kill(); } catch {}
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed (append_system e2e)`);
process.exit(fail === 0 ? 0 : 1);
