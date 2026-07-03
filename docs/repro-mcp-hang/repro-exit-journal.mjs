// Repro / proof for R1 — durable exit journal (docs/PLAN-append-system-and-exit-journal-2026-07-03.md,
// INVESTIGATION-mcp-cleanexit-heavy-delegation-2026-07-02.md §4-§5).
//
// The field-report gap: a clean code-0 teardown deletes the run dir (and its bridge.log), so AFTERWARDS
// there is no record of WHY the server exited. R1 appends one line to STATE_ROOT/exit-journal.jsonl
// BEFORE that deletion. This proves: (1) a clean stdin-close exit writes a code:0 journal line with the
// reason + state; (2) the run dir is gone yet the journal SURVIVED; (3) the journal is size-capped at
// startup (rotates to .1). No backend needed — the server exits on stdin close with zero sessions.
//
// Run: node docs/repro-mcp-hang/repro-exit-journal.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "..", "..", "scripts", "agent-bridge.mjs");

let passed = 0;
const pass = (msg) => { passed++; console.log(`[PASS] ${msg}`); };

// Resolve with the child's exit code, but never hang forever: if the server does not exit within `ms`,
// kill it and reject so a wedged server fails the repro loudly instead of pinning it.
const waitExit = (child, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("server did not exit within timeout")); }, ms);
  child.on("exit", (c) => { clearTimeout(t); resolve(c); });
});

// Start the server with an isolated STATE_ROOT, do the MCP initialize handshake (readiness signal +
// exercises activeRequests inc/dec), then resolve once we see the initialize response.
async function startServer(stateDir, extraEnv = {}) {
  const child = spawn(process.execPath, [BRIDGE, "mcp"], {
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: stateDir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); if (m.id === 1) { child.stdout.off("data", onData); resolve(); return; } } catch {}
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => reject(new Error(`server exited early code=${c}`)));
    setTimeout(() => reject(new Error("timed out waiting for initialize response")), 10000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "repro", version: "0" } } })}\n`);
  await ready;
  return child;
}

const runDirs = (stateDir) => {
  const logs = path.join(stateDir, "logs");
  return fs.existsSync(logs) ? fs.readdirSync(logs).filter(n => n.startsWith("mcp-")) : [];
};

// ── Scenario 1: clean stdin-close exit → code:0 journal line; run dir gone; journal survived ──
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-exitjournal-"));
  const child = await startServer(stateDir);
  assert.equal(runDirs(stateDir).length, 1, "exactly one run dir should exist while running");

  const exited = waitExit(child);
  child.stdin.end(); // stdin EOF → rl.on("close") with 0 active requests → cleanupAndExit(0, "stdin closed")
  const code = await exited;
  assert.equal(code, 0, `expected clean exit code 0, got ${code}`);
  pass("clean stdin-close exits code 0");

  const journalPath = path.join(stateDir, "exit-journal.jsonl");
  assert.ok(fs.existsSync(journalPath), "exit-journal.jsonl must exist after clean exit");
  const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected 1 journal line, got ${lines.length}`);
  const e = JSON.parse(lines[0]);
  assert.equal(e.code, 0, "journal code must be 0");
  assert.match(e.reason, /stdin closed/, "journal reason must record stdin close");
  assert.ok(typeof e.runId === "string" && e.runId.startsWith("mcp-"), "journal must record runId");
  assert.equal(typeof e.uptimeSec, "number", "journal must record uptimeSec");
  assert.equal(e.activeRequests, 0, "activeRequests must be 0 after the initialize turn completed");
  assert.ok(Array.isArray(e.sessions) && e.sessions.length === 0, "no sessions were opened");
  assert.equal(typeof e.pid, "number");
  pass(`journal line captured: code=0 reason="${e.reason}" runId=${e.runId} uptimeSec=${e.uptimeSec}`);

  // The whole point: the run dir (with bridge.log) is deleted on clean exit, yet the journal SURVIVED.
  assert.equal(runDirs(stateDir).length, 0, "run dir must be deleted on clean exit");
  assert.ok(fs.existsSync(journalPath), "journal must survive run-dir deletion");
  pass("run dir deleted on clean exit, but exit-journal.jsonl survived (the forensic gap is closed)");
}

// ── Scenario 2: startup size-cap rotates the journal to .1 ──
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-exitjournal-rot-"));
  fs.mkdirSync(stateDir, { recursive: true });
  const journalPath = path.join(stateDir, "exit-journal.jsonl");
  // Pre-seed an oversized journal (~1.5 MB) and cap at 1 MB so startup pruneExitJournal() rotates it.
  const bogus = `${JSON.stringify({ ts: "old", runId: "mcp-old", code: 0, reason: "old" })}\n`;
  fs.writeFileSync(journalPath, bogus.repeat(Math.ceil((1.5 * 1024 * 1024) / bogus.length)));
  const sizeBefore = fs.statSync(journalPath).size;
  assert.ok(sizeBefore > 1024 * 1024, "seed journal should exceed 1 MB");

  const child = await startServer(stateDir, { AGENT_BRIDGE_EXIT_JOURNAL_MAX_MB: "1" });
  const exited = waitExit(child);
  child.stdin.end();
  await exited;

  assert.ok(fs.existsSync(`${journalPath}.1`), "oversized journal must rotate to .1 at startup");
  const rotatedLines = fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(rotatedLines.length, 1, "post-rotation journal holds only this run's exit line");
  assert.equal(JSON.parse(rotatedLines[0]).runId.startsWith("mcp-"), true);
  pass(`journal rotated at startup (>${1} MB → .1), fresh journal holds 1 line`);
}

console.log(`\n>>> PASS: ${passed} checks passed (exit-journal R1)`);
