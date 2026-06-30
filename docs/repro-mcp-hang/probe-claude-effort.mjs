// Assert that --effort is emitted correctly in the spawned claude command line.
// Session 1: no model, no effort  -> $ line contains --effort xhigh, NOT --model
// Session 2: effort:"high"        -> $ line contains --effort high (caller override)
// Session 3: model:"haiku"        -> $ line contains --model haiku AND --effort xhigh
// SKIPs (exit 0) if `claude` is not on PATH.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log(">>> SKIP: claude not on PATH"); process.exit(0);
}
const { spawn } = await import("node:child_process");
import fs from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let exited = null; srv.on("close", (code, signal) => { exited = { code, signal }; });
let buf = ""; const got = new Map();
srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { const o = JSON.parse(l); if (o.id !== undefined) got.set(o.id, o); } catch {} } } });
srv.stderr.on("data", () => {});
let idc = 0;
function rpc(method, params) { const id = ++idc; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; }
async function call(name, args, waitMs = 60000) { const id = rpc("tools/call", { name, arguments: args }); const t = Date.now(); while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(100); } const o = got.get(id); if (!o) throw new Error(`timeout ${name}`); if (o.error) return { __error: o.error }; try { return JSON.parse(o.result.content[0].text); } catch { return { __raw: o.result?.content?.[0]?.text }; } }

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

function firstCmdLine(logFile) {
  const content = fs.readFileSync(logFile, "utf8");
  const line = content.split("\n").find(l => l.startsWith("$ "));
  return line || "";
}

try {
  rpc("initialize", { protocolVersion: "2025-06-18" }); await sleep(300);

  // Session 1: no model, no effort -> must have --effort xhigh, must NOT have --model
  const s1 = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  check("s1 open idle", s1.session?.status === "idle", s1.session?.status);
  const cmd1 = firstCmdLine(s1.session?.logFile);
  console.log(`  s1 cmd: ${cmd1}`);
  check("s1 has --effort xhigh", cmd1.includes("--effort xhigh"), cmd1);
  check("s1 has no --model", !cmd1.includes("--model"), cmd1);

  // Session 2: effort:"high" -> must have --effort high (caller override)
  const s2 = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false, effort: "high" });
  check("s2 open idle", s2.session?.status === "idle", s2.session?.status);
  const cmd2 = firstCmdLine(s2.session?.logFile);
  console.log(`  s2 cmd: ${cmd2}`);
  check("s2 has --effort high", cmd2.includes("--effort high"), cmd2);

  // Session 3: model:"haiku" -> must have --model haiku AND --effort xhigh
  const s3 = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false, model: "haiku" });
  check("s3 open idle", s3.session?.status === "idle", s3.session?.status);
  const cmd3 = firstCmdLine(s3.session?.logFile);
  console.log(`  s3 cmd: ${cmd3}`);
  check("s3 has --model haiku", cmd3.includes("--model haiku"), cmd3);
  check("s3 has --effort xhigh", cmd3.includes("--effort xhigh"), cmd3);

  // Arg-vector assertions: write:false session (s1) must have the right permission/tool flags
  check("s1 write:false has --permission-mode default", cmd1.includes("--permission-mode default"), cmd1);
  check("s1 write:false has --allowedTools Read,Glob,Grep,WebFetch,WebSearch", cmd1.includes("--allowedTools Read,Glob,Grep,WebFetch,WebSearch"), cmd1);
  check("s1 write:false has no Bash in allowedTools", !cmd1.includes("Bash"), cmd1);
  check("s1 write:false has no bypassPermissions", !cmd1.includes("bypassPermissions"), cmd1);

  // Session 4: write:true -> must have --permission-mode bypassPermissions and NO --allowedTools
  const s4 = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: true });
  check("s4 open idle", s4.session?.status === "idle", s4.session?.status);
  const cmd4 = firstCmdLine(s4.session?.logFile);
  console.log(`  s4 cmd: ${cmd4}`);
  check("s4 write:true has --permission-mode bypassPermissions", cmd4.includes("--permission-mode bypassPermissions"), cmd4);
  check("s4 write:true has no --allowedTools", !cmd4.includes("--allowedTools"), cmd4);

  // Close all
  const closed = await call("agent_bridge_close_session", {});
  check("close all", closed.closedAll === true || closed.count >= 4, JSON.stringify({ count: closed.count }));
} catch (e) { check(`harness error: ${e.message}`, false); }
finally { srv.stdin.end(); await sleep(800); if (!exited) srv.kill(); await sleep(300); check("server clean shutdown", exited?.code === 0, JSON.stringify(exited)); console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1); }
