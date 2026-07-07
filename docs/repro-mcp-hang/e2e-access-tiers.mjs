// END-TO-END test for open_session `access` tiers (read | write) against REAL omp + codex + claude.
// Drives a FRESH bridge process over MCP stdio (so it exercises the EDITED code, not the client's running
// server). `read` = read + EXECUTE (a shell for investigation, no Edit/Write tools); `write` = full edits.
// Proves, behaviorally:
//   - validation: bad enum rejected; the removed 'exec' value rejected; access⇄write conflict rejected;
//     consistent pair accepted — all BEFORE spawn.
//   - summary reports `access` (+ derived `write`).
//   - legacy alias: write:true→access "write", write:false→access "read".
//   - per-backend capability, checked OBJECTIVELY by probing the session's own temp cwd on disk (MARKER-on-disk
//     ⟹ a real shell ran, since no write/edit tool exists to fake it):
//       read : all three run a shell; the WRITE-boundary is what we measure — omp/claude SOFT (writes land),
//              codex HARD (read-only OS sandbox blocks the write).
//       write: shell writes succeed (incl. codex — on mac/Linux under workspace-write, on Windows under
//              danger-full-access since codex's Windows sandbox breaks apply_patch; positive proof its shell
//              works, so codex read's no-write is sandbox gating, not a dead shell).
// The codex write-boundary is DISCOVERED here (not assumed) because its OS sandbox may not enforce on Windows
// the way it does on mac/linux — the docs must state whatever is actually true here.
//
// ⚠ Spends REAL tokens; needs omp + codex on PATH (claude optional). SKIPs cleanly if omp/codex absent.
// Run:  node docs/repro-mcp-hang/e2e-access-tiers.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
async function call(name, args, waitMs = 220000) {
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
const info = (label, extra = "") => console.log(`[info] ${label}${extra ? " — " + extra : ""}`);
async function shutdown() { srv.stdin.end(); await sleep(800); if (!exited) srv.kill(); await sleep(300); }

// A per-session workspace so a shell write lands somewhere we can inspect ON DISK. Disk is the ONLY reliable
// signal: models fabricate self-reports (a read-tier claude claimed it ran `node -v` it had no tool for), so
// we NEVER trust "SHELL=yes" text. Writing MARKER requires a shell — the read tool-set includes no
// write/edit tool — so MARKER-on-disk ⟹ a real shell ran AND could write. That single objective bit
// distinguishes all the cases we care about.
function mkdir() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ab-access-"))); }
const MARKER = "MARKER.txt";
const probePrompt =
  "Using a shell/bash tool if you have one, run a command that writes the text OK7 into a file named " +
  `${MARKER} in the current working directory (e.g.  echo OK7 > ${MARKER} ). Then run  node -v  and report ` +
  "its output. Reply in one short line. If you have no shell/bash tool at all, reply exactly: SHELL=no";

// Probe one (backend, tier): open with cwd=fresh dir, send the probe, then read the ON-DISK state (truth).
// `wrote` is the objective assertion target; `text` is INFO only (never gated — models self-report unreliably).
async function probe(agent, tier, model) {
  const cwd = mkdir();
  // effort:minimal speeds omp/claude, but codex's provider REJECTS effort=minimal while its default tools
  // (web_search/image_gen) are enabled (HTTP 400) — so let codex use its default effort.
  const effort = agent === "codex" ? undefined : "minimal";
  const o = await call("agent_bridge_open_session", { agent, cwd, access: tier, ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
  if (o.__error) return { err: o.__error.message, cwd };
  const s = o.session;
  const summaryAccess = s?.access;
  const summaryWrite = s?.write;
  await call("agent_bridge_send_message", { session_id: s.id, message: probePrompt });
  const w = await call("agent_bridge_wait", { session_ids: [s.id], mode: "all", timeout_ms: 200000 });
  const text = (w.results?.[0]?.text ?? w.settled?.[0]?.text ?? "").trim();
  await call("agent_bridge_close_session", { session_id: s.id });
  const wrote = fs.existsSync(path.join(cwd, MARKER)); // OBJECTIVE: a shell wrote a file here
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  return { summaryAccess, summaryWrite, wrote, text: text.slice(0, 100) };
}

try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);
  const doc = await call("agent_bridge_doctor", {});
  const docText = doc.__raw || JSON.stringify(doc);
  const ompOk = /omp:\s*ok/i.test(docText), cdxOk = /codex:\s*ok/i.test(docText), claudeOk = /claude:\s*ok/i.test(docText);
  info(`doctor: ${docText.split("\n").filter(l => /ok|missing/.test(l)).join(" | ")}`);
  if (!ompOk || !cdxOk) { console.log(`>>> SKIP: needs omp+codex (omp=${ompOk}, codex=${cdxOk}).`); await shutdown(); process.exit(0); }
  const anyDir = mkdir();

  // ── 1. Validation (fail-fast, no backend spawned, no tokens) ──
  const badEnum = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir, access: "bogus" });
  check("bad access enum rejected before spawn", !!badEnum.__error && /access must be one of/i.test(badEnum.__error.message || ""), badEnum.__error?.message);
  const noExec = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir, access: "exec" });
  check("removed 'exec' tier rejected (two tiers only)", !!noExec.__error && /access must be one of/i.test(noExec.__error.message || ""), noExec.__error?.message);
  const conflict = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir, access: "read", write: true });
  check("access/write conflict rejected", !!conflict.__error && /conflict/i.test(conflict.__error.message || ""), conflict.__error?.message);
  const consistent = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir, access: "write", write: true });
  check("consistent access+write accepted", !consistent.__error && consistent.session?.access === "write", JSON.stringify(consistent.session?.access ?? consistent.__error));
  if (consistent.session?.id) await call("agent_bridge_close_session", { session_id: consistent.session.id });

  // ── 2. Legacy alias → access (no message, just summary shape) ──
  const aliasT = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir, write: true });
  check("write:true aliases to access 'write'", aliasT.session?.access === "write" && aliasT.session?.write === true, JSON.stringify({ a: aliasT.session?.access, w: aliasT.session?.write }));
  if (aliasT.session?.id) await call("agent_bridge_close_session", { session_id: aliasT.session.id });
  const aliasF = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir, write: false });
  check("write:false aliases to access 'read'", aliasF.session?.access === "read" && aliasF.session?.write === false, JSON.stringify({ a: aliasF.session?.access, w: aliasF.session?.write }));
  if (aliasF.session?.id) await call("agent_bridge_close_session", { session_id: aliasF.session.id });
  const defA = await call("agent_bridge_open_session", { agent: "omp", cwd: anyDir });
  check("default access is 'read'", defA.session?.access === "read", JSON.stringify(defA.session?.access));
  if (defA.session?.id) await call("agent_bridge_close_session", { session_id: defA.session.id });
  try { fs.rmSync(anyDir, { recursive: true, force: true }); } catch {}

  // ── 3. read tier = read + EXECUTE: a shell runs (MARKER-on-disk ⟹ real shell — no write/edit tool exists
  //    to fake it). Write-boundary differs: omp/claude SOFT (writes land), codex HARD (read-only sandbox). ──
  const rOmp = await probe("omp", "read");
  check("omp read: summary.access=read", rOmp.summaryAccess === "read", JSON.stringify(rOmp));
  check("omp read: shell ran + wrote (soft boundary)", rOmp.wrote === true, JSON.stringify(rOmp));
  if (claudeOk) {
    const rCla = await probe("claude", "read");
    check("claude read: summary.access=read", rCla.summaryAccess === "read", JSON.stringify(rCla));
    check("claude read: shell ran + wrote (soft boundary)", rCla.wrote === true, JSON.stringify(rCla));
  }
  const rCdx = await probe("codex", "read");
  check("codex read: summary.access=read", rCdx.summaryAccess === "read", JSON.stringify(rCdx));
  // codex read runs commands (node -v shows in text) but its read-only sandbox HARD-blocks the write. We
  // assert ONLY the write-block here (the disk-observable, non-fabricable fact); that codex's shell actually
  // EXECUTES is proven deterministically by the codex WRITE-tier probe below (wrote===true), same backend.
  info(`codex read WRITE BOUNDARY (measured on this OS): wrote=${rCdx.wrote} → ${rCdx.wrote ? "SOFT (sandbox did NOT block)" : "HARD (read-only sandbox blocked the write)"}`, rCdx.text);
  check("codex read: read-only sandbox blocks writes (HARD)", rCdx.wrote === false, JSON.stringify(rCdx));

  // ── 4. write tier: shell writes succeed. omp = regression (path unchanged); codex = positive proof its
  //    shell WORKS when the sandbox widens to write (workspace-write on mac/Linux, danger-full-access on
  //    Windows) — so codex read's no-write is sandbox gating, not a dead shell. ──
  const wOmp = await probe("omp", "write");
  check("omp write: summary.access=write", wOmp.summaryAccess === "write", JSON.stringify(wOmp));
  check("omp write: shell writes succeed", wOmp.wrote === true, JSON.stringify(wOmp));
  const wCdx = await probe("codex", "write");
  check("codex write: shell writes succeed (workspace-write on mac/Linux, danger-full-access on Windows)", wCdx.wrote === true, JSON.stringify(wCdx));

  await call("agent_bridge_close_session", {});
  await shutdown();
  check("server clean shutdown (code 0)", exited && exited.code === 0, JSON.stringify(exited));
} catch (e) {
  check(`no exception`, false, e.message);
  try { srv.kill(); } catch {}
}
console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed (access-tiers e2e)`);
process.exit(fail === 0 ? 0 : 1);
