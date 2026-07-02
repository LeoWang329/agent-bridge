// Repro/verify for contextUsage (current-context occupancy — the long-context "rot" signal). Deterministic,
// ZERO real token spend — driven by fake-omp/fake-codex/fake-claude usage payloads. What it proves:
//   omp live       — OMP get_state.contextUsage is normalized to top-level contextUsage
//                    {tokens,live:true,isCompacting,autoCompactionEnabled} (NO contextWindow — absolute tokens
//                    only, no percent-inviting field); carried through wait() (T1 passthrough) AND status().session.
//   omp snapshot   — a LONG-running omp session's live reading appears in wait().pendingSnapshots[].contextUsage
//                    (watch a session mid-turn, not just at the end). OMP is refreshed before the snapshot.
//   omp null       — a get_state WITHOUT contextUsage → contextUsage:null (partial → null, never half object).
//   codex          — last.inputTokens is chosen (NOT total, NOT last.totalTokens), live:false, NO contextWindow,
//                    and NO omp-only isCompacting key leaks in.
//   codex null     — before the first usage notification → contextUsage:null.
//   claude         — modelUsage's LARGEST-window entry is the primary (a 200k subagent is excluded, via internal
//                    window comparison), tokens are the input-side sum (input + cacheRead + cacheCreation), live:false;
//                    contextWindow is used only internally for selection, never emitted.
//   claude null    — before any result → contextUsage:null.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const win = process.platform === "win32";
const FAKE_OMP = path.join(HERE, win ? "fake-omp.cmd" : "fake-omp.sh");
const FAKE_CODEX = path.join(HERE, win ? "fake-codex.cmd" : "fake-codex.sh");
const FAKE_CLAUDE = path.join(HERE, win ? "fake-claude.cmd" : "fake-claude.sh");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }

// One MCP server with per-backend fake modes; returns a client with call()/callRaw().
function makeServer(modes = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: {
      ...process.env, OMP_BIN: FAKE_OMP, CODEX_BIN: FAKE_CODEX, CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_OMP_MODE: modes.omp || "okturn", FAKE_CODEX_MODE: modes.codex || "schemaok", FAKE_CLAUDE_MODE: modes.claude || "abortfallback",
    },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {} } });
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  let nextId = 1;
  const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; };
  const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
  const callRaw = async (name, args, ms = 15000) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const r = await waitResp(id, ms); if (!r) return fail(`${name} no response`); return r; };
  const call = async (name, args, ms) => parse(await callRaw(name, args, ms));
  const init = async () => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-context-usage", version: "0" } } }); if (!await waitResp(id, 10000)) return fail("no init"); rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); };
  return { srv, call, callRaw, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

const open = async (s, agent, extra = {}) => (await s.call("agent_bridge_open_session", { agent, cwd: CWD, ...extra }, 30000))?.session?.id;
// Open, send non-blocking, wait(all) → the settled result object.
async function turn(s, agent) {
  const id = await open(s, agent);
  if (!id) return fail(`open ${agent} failed`);
  const ack = await s.call("agent_bridge_send_message", { session_id: id, message: "hello" });
  if (ack?.accepted !== true) return fail(`${agent} send should be accepted, got ${JSON.stringify(ack)}`);
  const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 });
  return { id, r: w?.results?.[0] };
}

async function main() {
  // ===== omp: live contextUsage through wait AND status; null before/without a reading =====
  {
    const s = makeServer({ omp: "ctxturn" });
    await s.init();
    const { id, r } = await turn(s, "omp");
    const cu = r?.contextUsage;
    if (!cu) return fail(`omp: wait result should carry contextUsage, got ${JSON.stringify(r?.contextUsage)}`);
    if (cu.tokens !== 12345) return fail(`omp: tokens wrong, got ${JSON.stringify(cu)}`);
    if ("contextWindow" in cu) return fail(`omp: contextWindow must NOT be emitted (absolute tokens only), got ${JSON.stringify(cu)}`);
    if (cu.live !== true) return fail(`omp: OMP reading must be live:true, got ${JSON.stringify(cu.live)}`);
    if (cu.isCompacting !== false || cu.autoCompactionEnabled !== true) return fail(`omp: compaction flags should flow through, got ${JSON.stringify(cu)}`);
    // status() single-id refreshes get_state, so its session.contextUsage must match.
    const st = await s.call("agent_bridge_status", { session_id: id });
    if (st?.session?.contextUsage?.tokens !== 12345) return fail(`omp: status().session.contextUsage should match, got ${JSON.stringify(st?.session?.contextUsage)}`);
    // status() WITHOUT session_id (list-all) must ALSO carry contextUsage per session (idle → last-known
    // reading is accurate). Guards the deepseek test-gap: a refactor dropping it from summary() would slip.
    const list = await s.call("agent_bridge_status", {});
    const listed = (list?.sessions || []).find(x => x.id === id);
    if (listed?.contextUsage?.tokens !== 12345) return fail(`omp-listall: list-all session should carry contextUsage, got ${JSON.stringify(listed?.contextUsage)}`);
    console.log(`[harness] omp OK — live contextUsage{tokens,live:true,isCompacting,autoCompactionEnabled} (no contextWindow) via wait + status(id) + list-all`);
    s.kill();
    await sleep(200);
  }

  // ===== omp: null when get_state carries no contextUsage (okturn) — partial → null =====
  {
    const s = makeServer({ omp: "okturn" });
    await s.init();
    const id = await open(s, "omp");
    const st = await s.call("agent_bridge_status", { session_id: id }); // forces a get_state refresh
    if (st?.session?.contextUsage !== null) return fail(`omp-null: contextUsage should be null without a reading, got ${JSON.stringify(st?.session?.contextUsage)}`);
    console.log(`[harness] omp-null OK — no contextUsage in get_state → contextUsage:null (no half object)`);
    s.kill();
    await sleep(200);
  }

  // ===== omp: a LONG session's live reading in wait().pendingSnapshots (mid-wait watch) =====
  {
    const s = makeServer({ omp: "ctxslow" });
    await s.init();
    const id = await open(s, "omp");
    await s.call("agent_bridge_send_message", { session_id: id, message: "long task" }); // non-blocking
    const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 400 }); // times out mid-turn
    if (!w?.timedOut) return fail(`omp-snapshot: wait should time out mid-turn, got ${JSON.stringify(w)}`);
    const snap = w?.pendingSnapshots?.find(x => x.sessionId === id);
    if (!snap?.contextUsage) return fail(`omp-snapshot: pendingSnapshots should carry live contextUsage, got ${JSON.stringify(snap)}`);
    if (snap.contextUsage.tokens !== 12345 || snap.contextUsage.live !== true) return fail(`omp-snapshot: snapshot contextUsage wrong, got ${JSON.stringify(snap.contextUsage)}`);
    await s.call("agent_bridge_abort", { session_id: id }).catch(() => {});
    console.log(`[harness] omp-snapshot OK — long session's live contextUsage visible in wait().pendingSnapshots`);
    s.kill();
    await sleep(200);
  }

  // ===== codex: last.inputTokens (not total/totalTokens) + modelContextWindow, live:false, no omp-only key =====
  // Also null before the first usage notification (status before the turn).
  {
    const s = makeServer({ codex: "ctxturn" });
    await s.init();
    const idPre = await open(s, "codex");
    const stPre = await s.call("agent_bridge_status", { session_id: idPre });
    if (stPre?.session?.contextUsage !== null) return fail(`codex-null: contextUsage should be null before any usage, got ${JSON.stringify(stPre?.session?.contextUsage)}`);
    // drive the turn on the same session
    await s.call("agent_bridge_send_message", { session_id: idPre, message: "hello" });
    const w = await s.call("agent_bridge_wait", { session_ids: [idPre], mode: "all", timeout_ms: 8000 });
    const cu = w?.results?.[0]?.contextUsage;
    if (!cu) return fail(`codex: wait result should carry contextUsage, got ${JSON.stringify(w?.results?.[0])}`);
    if (cu.tokens !== 21401) return fail(`codex: tokens must be last.inputTokens (21401), NOT total/totalTokens — got ${JSON.stringify(cu.tokens)}`);
    if ("contextWindow" in cu) return fail(`codex: contextWindow must NOT be emitted (absolute tokens only), got ${JSON.stringify(cu)}`);
    if (cu.live !== false) return fail(`codex: last-turn snapshot must be live:false, got ${JSON.stringify(cu.live)}`);
    if ("isCompacting" in cu) return fail(`codex: omp-only isCompacting must not appear, got ${JSON.stringify(cu)}`);
    console.log(`[harness] codex OK — contextUsage{tokens:inputTokens,live:false} (no contextWindow); null before first usage; no isCompacting leak`);
    s.kill();
    await sleep(200);
  }

  // ===== claude: largest-window entry is the primary (subagent excluded); input-side token sum; live:false =====
  // Also null before any result.
  {
    const s = makeServer({ claude: "ctxturn" });
    await s.init();
    const idPre = await open(s, "claude");
    const stPre = await s.call("agent_bridge_status", { session_id: idPre });
    if (stPre?.session?.contextUsage !== null) return fail(`claude-null: contextUsage should be null before any result, got ${JSON.stringify(stPre?.session?.contextUsage)}`);
    await s.call("agent_bridge_send_message", { session_id: idPre, message: "hello" });
    const w = await s.call("agent_bridge_wait", { session_ids: [idPre], mode: "all", timeout_ms: 8000 });
    const cu = w?.results?.[0]?.contextUsage;
    if (!cu) return fail(`claude: wait result should carry contextUsage, got ${JSON.stringify(w?.results?.[0])}`);
    // opus (1M window) is primary; haiku (200k) is a subagent and must NOT be chosen. The tokens value
    // proves the selection: 8000+20000+3000=31000 is opus's sum; the haiku subagent would give ~500.
    if (cu.tokens !== 31000) return fail(`claude: primary must be the LARGEST-window entry (1M opus → 31000), not the 200k subagent (~500) — got ${JSON.stringify(cu.tokens)}`);
    if ("contextWindow" in cu) return fail(`claude: contextWindow must NOT be emitted (used internally for selection only), got ${JSON.stringify(cu)}`);
    if (cu.live !== false) return fail(`claude: last-turn snapshot must be live:false, got ${JSON.stringify(cu.live)}`);
    console.log(`[harness] claude OK — largest-window primary (subagent excluded), input-side token sum, live:false; null before first result`);
    s.kill();
    await sleep(200);
  }

  // ===== claude: modelUsage reset across turns — turn 2 omitting modelUsage yields null, not turn 1's number =====
  {
    const s = makeServer({ claude: "ctxstale" });
    await s.init();
    const id = await open(s, "claude");
    await s.call("agent_bridge_send_message", { session_id: id, message: "turn one" });
    const w1 = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 });
    if (w1?.results?.[0]?.contextUsage?.tokens !== 31000) return fail(`claude-stale: turn 1 should report contextUsage, got ${JSON.stringify(w1?.results?.[0]?.contextUsage)}`);
    await s.call("agent_bridge_send_message", { session_id: id, message: "turn two" });
    const w2 = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 });
    if (w2?.results?.[0]?.contextUsage !== null) return fail(`claude-stale: turn 2 omits modelUsage → contextUsage MUST be null (not turn 1's stale number), got ${JSON.stringify(w2?.results?.[0]?.contextUsage)}`);
    console.log(`[harness] claude-stale OK — #beginTurn reset: a turn that omits modelUsage → contextUsage:null, no stale carry-over`);
    s.kill();
    await sleep(200);
  }

  // ===== claude: equal-window tie-break picks the higher-token (main) entry, not first-seen (subagent) =====
  {
    const s = makeServer({ claude: "ctxtie" });
    await s.init();
    const { r } = await turn(s, "claude");
    const cu = r?.contextUsage;
    if (!cu) return fail(`claude-tie: should carry contextUsage, got ${JSON.stringify(r)}`);
    if (cu.tokens !== 50000) return fail(`claude-tie: equal-window tie must pick the higher-token main entry (50000), NOT the first-seen subagent (1000), got ${JSON.stringify(cu.tokens)}`);
    if ("contextWindow" in cu) return fail(`claude-tie: contextWindow must NOT be emitted, got ${JSON.stringify(cu)}`);
    console.log(`[harness] claude-tie OK — equal contextWindow → tie-break by tokens picks the main conversation, not insertion order`);
    s.kill();
    await sleep(200);
  }

  console.log("[harness] >>> PASS: contextUsage normalized across omp(live)/codex/claude(snapshot); carried through wait + status + pendingSnapshots; correct token source per backend; partial→null; no cross-backend field leak");
  await sleep(200);
  process.exit(0);
}
main().catch(e => fail(String(e)));
