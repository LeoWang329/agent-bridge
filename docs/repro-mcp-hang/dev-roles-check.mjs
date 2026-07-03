// Structure + shared-principles consistency + injectability smoke for the `agent-bridge:dev` skill.
//
// Part A (always, no tokens): skills/dev/SKILL.md exists with `name: dev`; exactly the four role files exist,
//   non-empty, each carrying a PAIRED <!-- SHARED-PRINCIPLES … --> … <!-- /SHARED-PRINCIPLES --> block; and the
//   block is BYTE-IDENTICAL across all four (guards against copy-drift — DESIGN §4/§8).
// Part B (real backend, SKIPs if omp absent): ACCEPTANCE/injectability check — open an omp session per role with
//   append_system_prompt_file set to the role's ABSOLUTE path and assert the session summary echoes it (file=realpath,
//   bytes>0, mode=system) — proves every role file resolves to an absolute path and is accepted/injected by the bridge.
//   No send = minimal tokens. NOTE: this does NOT re-prove behavioral HONOR (that a backend obeys an injected file) —
//   that mechanism is already proven for arbitrary files across all 3 backends by e2e-append-system.mjs.
//
// Run:  node docs/repro-mcp-hang/dev-roles-check.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const REPO = path.resolve(HERE, "../..");
const SKILL_DIR = path.join(REPO, "skills", "dev");
const ROLES_DIR = path.join(SKILL_DIR, "roles");
const ROLES = ["implementer", "reviewer", "architect", "debugger"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

// ── Part A: structure + shared-block consistency (no backend) ──
const skillMd = path.join(SKILL_DIR, "SKILL.md");
check("skills/dev/SKILL.md exists", fs.existsSync(skillMd));
if (fs.existsSync(skillMd)) {
  const fm = fs.readFileSync(skillMd, "utf8").split(/\r?\n/).slice(0, 12).join("\n");
  check("SKILL.md frontmatter name: dev", /^name:\s*dev\s*$/m.test(fm), fm.match(/name:.*/)?.[0]);
}

// allow-list: roles/ holds exactly the four .md role files, nothing else
const roleMdFiles = fs.existsSync(ROLES_DIR) ? fs.readdirSync(ROLES_DIR).filter(f => f.endsWith(".md")).sort() : [];
check("roles/ has exactly the 4 allow-listed role files", roleMdFiles.join(",") === ROLES.map(r => `${r}.md`).sort().join(","), roleMdFiles.join(","));

const OPEN = "<!-- SHARED-PRINCIPLES";
const CLOSE = "<!-- /SHARED-PRINCIPLES -->";
const blocks = new Map();
for (const r of ROLES) {
  const p = path.join(ROLES_DIR, `${r}.md`);
  if (!fs.existsSync(p)) { check(`${r}.md exists`, false); continue; }
  const body = fs.readFileSync(p, "utf8");
  check(`${r}.md non-empty`, body.trim().length > 0);
  const i = body.indexOf(OPEN);
  const j = body.indexOf(CLOSE);
  const paired = i >= 0 && j > i;
  check(`${r}.md has paired SHARED-PRINCIPLES anchors`, paired);
  if (paired) blocks.set(r, body.slice(i, j + CLOSE.length));
}
// byte-identical across all four
if (blocks.size === ROLES.length) {
  const ref = blocks.get(ROLES[0]);
  const refBuf = Buffer.from(ref, "utf8");
  let allSame = true, firstDiff = "";
  for (const r of ROLES.slice(1)) {
    if (!Buffer.from(blocks.get(r), "utf8").equals(refBuf)) { allSame = false; firstDiff = r; break; }
  }
  check("SHARED-PRINCIPLES block byte-identical across 4 roles", allSame, allSame ? `${refBuf.length} bytes` : `differs in ${firstDiff}.md`);
} else {
  check("SHARED-PRINCIPLES block byte-identical across 4 roles", false, "missing block in some role file");
}

// ── Part B: injectability smoke against real omp (SKIP if absent) ──
const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });
let buf = "";
const got = new Map();
srv.stdout.on("data", d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (l) { try { const o = JSON.parse(l); if (o.id !== undefined) got.set(o.id, o); } catch {} }
  }
});
srv.stderr.on("data", () => {});
let idc = 0;
const rpc = (method, params) => { const id = ++idc; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; };
async function call(name, args, waitMs = 60000) {
  const id = rpc("tools/call", { name, arguments: args });
  const t = Date.now();
  while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(100); }
  const o = got.get(id);
  if (!o) throw new Error(`timeout waiting for ${name}`);
  if (o.error) return { __error: o.error };
  const txt = o.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}
async function shutdown() { srv.stdin.end(); await sleep(600); if (!exited) srv.kill(); await sleep(200); }

try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);
  const doc = await call("agent_bridge_doctor", {});
  const docText = doc.__raw || JSON.stringify(doc);
  const ompOk = /omp:\s*ok/i.test(docText);
  if (!ompOk) {
    console.log(">>> Part B SKIP: needs omp on PATH.");
  } else {
    for (const r of ROLES) {
      const abs = path.join(ROLES_DIR, `${r}.md`);           // absolute path, as the skill must resolve it
      const real = fs.realpathSync.native(abs);
      const o = await call("agent_bridge_open_session", { agent: "omp", cwd: REPO, write: false, append_system_prompt_file: abs });
      const a = o.session?.appendSystemPrompt;
      check(`${r}.md injectable (summary echoes abs path, bytes>0, mode=system)`,
        !!a && a.file === real && a.bytes > 0 && a.injectionMode === "system", JSON.stringify(a));
      if (o.session?.id) await call("agent_bridge_close_session", { session_id: o.session.id });
    }
  }
  await shutdown();
  check("server clean shutdown (code 0)", exited && exited.code === 0, JSON.stringify(exited));
} catch (e) {
  check("no exception", false, e.message);
  try { srv.kill(); } catch {}
}
console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed (dev roles check)`);
process.exit(fail === 0 ? 0 : 1);
