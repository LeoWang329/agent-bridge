// Repro/verify for T11 (A1): Codex-native structured output (`schema` → `json` / `schemaError`).
// Deterministic, zero real usage — driven by fake-codex.mjs (CODEX_BIN) in three modes, plus fake-omp/
// fake-claude for the cross-backend rejection. Scenarios:
//   schemaok    — send(schema) non-blocking, then wait() carries a parsed top-level `json` that ECHOES the
//                 exact schema back (proves the schema reached turn/start AND survived per-turn state +
//                 the T1 wait passthrough). schemaError is null.
//   ref+schema  — same, but return_mode:"ref": text is null yet `json` is still present (codex C-T11: parse
//                 json THEN null the free text).
//   schemabad   — model returns non-JSON on a SUCCEEDED turn → top-level `schemaError:{error,rawText}`,
//                 json null, and NO throw (the call still resolves).
//   schemafail  — turn ends status:"failed" → `schemaError` carrying the failure reason, no throw, and
//                 health reads "degraded" (last turn errored).
//   reject omp / reject claude — sending `schema` to a non-codex backend is rejected at sendMessage.
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

// One MCP server bound to a given FAKE_CODEX_MODE; returns a client with call()/callRaw().
function makeServer(codexMode) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, OMP_BIN: FAKE_OMP, CODEX_BIN: FAKE_CODEX, CLAUDE_BIN: FAKE_CLAUDE, FAKE_CODEX_MODE: codexMode },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr:${codexMode}] ${d}`));
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {} } });
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  let nextId = 1;
  const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; };
  const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
  const callRaw = async (name, args, ms = 15000) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const r = await waitResp(id, ms); if (!r) return fail(`${name} no response (mode ${codexMode})`); return r; };
  const call = async (name, args, ms) => parse(await callRaw(name, args, ms));
  const init = async () => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-schema", version: "0" } } }); if (!await waitResp(id, 10000)) return fail("no init"); rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); };
  return { srv, call, callRaw, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}
const errText = r => r?.error?.message || (r?.result?.isError ? (r.result.content?.[0]?.text || "") : "");

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Open codex, send(schema) non-blocking, wait(all), return the settled result object.
async function codexSchemaTurn(s, openArgs = {}) {
  const id = (await s.call("agent_bridge_open_session", { agent: "codex", cwd: CWD, ...openArgs }, 30000))?.session?.id;
  if (!id) return fail("open codex failed");
  const ack = await s.call("agent_bridge_send_message", { session_id: id, message: "produce structured output", schema: SCHEMA });
  if (ack?.accepted !== true) return fail(`send(schema) should be accepted, got ${JSON.stringify(ack)}`);
  const w = await s.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 });
  return { id, r: w?.results?.[0] };
}

async function main() {
  // ===== schemaok: json parsed + schema echoed back (proves flow-through + wait passthrough) =====
  const sOk = makeServer("schemaok");
  await sOk.init();
  {
    const { r } = await codexSchemaTurn(sOk);
    if (!r) return fail("schemaok: no wait result");
    if (r.schemaError != null) return fail(`schemaok: schemaError should be null, got ${JSON.stringify(r.schemaError)}`);
    if (!r.json || r.json.ok !== true) return fail(`schemaok: json.ok should be true, got ${JSON.stringify(r.json)}`);
    if (!eq(r.json.receivedSchema, SCHEMA)) return fail(`schemaok: backend should have received the exact schema, got ${JSON.stringify(r.json.receivedSchema)}`);
    console.log(`[harness] schemaok OK — wait carried parsed json; schema round-tripped into turn/start`);
  }

  // ===== return_mode:"ref" + schema: text null, json still present =====
  {
    const { r } = await codexSchemaTurn(sOk, { return_mode: "ref" });
    if (!r) return fail("ref+schema: no wait result");
    if (r.text !== null) return fail(`ref+schema: text should be null under ref, got ${JSON.stringify(r.text)}`);
    if (!r.json || r.json.ok !== true) return fail(`ref+schema: json should still be parsed under ref, got ${JSON.stringify(r.json)}`);
    if (!r.textRef) return fail(`ref+schema: textRef should still hold the raw JSON`);
    console.log(`[harness] ref+schema OK — text:null but json present (parse-then-omit-text)`);
  }

  // ===== reject: schema to omp / claude =====
  {
    const ompId = (await sOk.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
    const rej = await sOk.callRaw("agent_bridge_send_message", { session_id: ompId, message: "x", schema: SCHEMA });
    if (!/not supported for backend "omp"/i.test(errText(rej))) return fail(`omp+schema should be rejected, got ${JSON.stringify(errText(rej))}`);
    const clId = (await sOk.call("agent_bridge_open_session", { agent: "claude", cwd: CWD }, 30000))?.session?.id;
    const rejC = await sOk.callRaw("agent_bridge_send_message", { session_id: clId, message: "x", schema: SCHEMA });
    if (!/not supported for backend "claude"/i.test(errText(rejC))) return fail(`claude+schema should be rejected, got ${JSON.stringify(errText(rejC))}`);
    console.log(`[harness] reject OK — schema rejected for omp and claude (codex-only contract)`);
  }
  sOk.kill();
  await sleep(200);

  // ===== schemabad: non-JSON answer on a succeeded turn → schemaError, no throw =====
  const sBad = makeServer("schemabad");
  await sBad.init();
  {
    const { r } = await codexSchemaTurn(sBad);
    if (!r) return fail("schemabad: no wait result (a parse failure must NOT throw the call)");
    if (r.json != null) return fail(`schemabad: json should be null, got ${JSON.stringify(r.json)}`);
    if (!r.schemaError || !/not valid JSON/i.test(r.schemaError.error)) return fail(`schemabad: schemaError.error should flag invalid JSON, got ${JSON.stringify(r.schemaError)}`);
    if (!/not JSON/i.test(r.schemaError.rawText || "")) return fail(`schemabad: schemaError.rawText should hold the raw non-JSON text, got ${JSON.stringify(r.schemaError?.rawText)}`);
    console.log(`[harness] schemabad OK — invalid JSON → schemaError{error,rawText}, no throw`);
  }
  sBad.kill();
  await sleep(200);

  // ===== schemafail: failed turn → schemaError + degraded health, no throw =====
  const sFail = makeServer("schemafail");
  await sFail.init();
  {
    const { id, r } = await codexSchemaTurn(sFail);
    if (!r) return fail("schemafail: no wait result (a failed schema turn must NOT throw the call)");
    if (r.json != null) return fail(`schemafail: json should be null, got ${JSON.stringify(r.json)}`);
    if (!r.schemaError || !r.schemaError.error) return fail(`schemafail: schemaError should carry the failure reason, got ${JSON.stringify(r.schemaError)}`);
    if (r.health !== "degraded") return fail(`schemafail: a failed turn should read health "degraded", got ${JSON.stringify(r.health)}`);
    // Session must stay reusable: a subsequent PLAIN turn clears the schema state (no spurious schemaError).
    const w2 = await sFail.call("agent_bridge_status", { session_id: id });
    if (!w2?.session) return fail("schemafail: session should still be inspectable after a failed turn");
    console.log(`[harness] schemafail OK — failed turn → schemaError + health=degraded, no throw, session reusable`);
  }
  sFail.kill();
  await sleep(200);

  // ===== turn/start-failure drift (the bug codex caught): a schema flag is bound to a turn's REAL begin
  // (#beginTurn), never to send() entry, so a turn/start that never begins leaves the PRIOR turn's
  // text+flag in sync. startfail2 refuses the 2nd turn/start. =====
  // Scenario 1 — stale-schema mislabel: plain turn #1 succeeds; schema turn #2 fails at start; result()
  // must NOT parse turn #1's plain text as a failed schema turn.
  {
    const sd = makeServer("startfail2");
    await sd.init();
    const id = (await sd.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000))?.session?.id;
    if (!id) return fail("drift-1: open codex failed");
    await sd.call("agent_bridge_send_message", { session_id: id, message: "plain turn one" }); // no schema
    await sd.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 });
    const bad = await sd.callRaw("agent_bridge_send_message", { session_id: id, message: "now with schema", schema: SCHEMA });
    if (!/refused/i.test(errText(bad))) return fail(`drift-1: 2nd (schema) turn/start should be refused, got ${JSON.stringify(errText(bad))}`);
    const after = await sd.call("agent_bridge_result", { session_id: id });
    if (after?.schemaError != null || after?.json != null) return fail(`drift-1: a failed schema turn/start must NOT relabel the prior PLAIN result as schema — got json=${JSON.stringify(after?.json)} schemaError=${JSON.stringify(after?.schemaError)}`);
    console.log(`[harness] drift-1 OK — failed schema turn/start leaves the prior plain result unschema'd (no stale-flag mislabel)`);
    sd.kill();
    await sleep(200);
  }
  // Scenario 2 — erased json: schema turn #1 succeeds; plain turn #2 fails at start; the prior turn's
  // parsed json must NOT be erased by resetting the flag too early.
  {
    const sd = makeServer("startfail2");
    await sd.init();
    const id = (await sd.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000))?.session?.id;
    if (!id) return fail("drift-2: open codex failed");
    await sd.call("agent_bridge_send_message", { session_id: id, message: "schema turn one", schema: SCHEMA });
    const w1 = await sd.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 });
    if (w1?.results?.[0]?.json?.ok !== true) return fail(`drift-2: turn #1 should have parsed json, got ${JSON.stringify(w1?.results?.[0]?.json)}`);
    const bad = await sd.callRaw("agent_bridge_send_message", { session_id: id, message: "plain turn two" }); // no schema, start refused
    if (!/refused/i.test(errText(bad))) return fail(`drift-2: 2nd (plain) turn/start should be refused, got ${JSON.stringify(errText(bad))}`);
    const after = await sd.call("agent_bridge_result", { session_id: id });
    if (after?.json?.ok !== true) return fail(`drift-2: a failed plain turn/start must NOT erase the prior schema turn's json — got json=${JSON.stringify(after?.json)} schemaError=${JSON.stringify(after?.schemaError)}`);
    console.log(`[harness] drift-2 OK — failed plain turn/start preserves the prior schema turn's parsed json (no early flag reset)`);
    sd.kill();
    await sleep(200);
  }

  // Scenario 3 — failure REASON is per-turn (round-2 edge codex flagged): a failed schema turn #1, then a
  // turn/start-refused turn #2, must still report turn #1's OWN failure reason — not the sticky lastError
  // that turn #2's start-refusal overwrote.
  {
    const sd = makeServer("failstart");
    await sd.init();
    const id = (await sd.call("agent_bridge_open_session", { agent: "codex", cwd: CWD }, 30000))?.session?.id;
    if (!id) return fail("reason: open codex failed");
    const w1 = await (async () => { await sd.call("agent_bridge_send_message", { session_id: id, message: "schema turn that fails", schema: SCHEMA }); return sd.call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 8000 }); })();
    const err1 = w1?.results?.[0]?.schemaError?.error || "";
    if (!/codex turn/i.test(err1)) return fail(`reason: turn #1 should fail with its own turn reason, got ${JSON.stringify(err1)}`);
    const bad = await sd.callRaw("agent_bridge_send_message", { session_id: id, message: "turn two", schema: SCHEMA });
    if (!/refused/i.test(errText(bad))) return fail(`reason: 2nd turn/start should be refused, got ${JSON.stringify(errText(bad))}`);
    const after = await sd.call("agent_bridge_result", { session_id: id });
    if (/refused/i.test(after?.schemaError?.error || "")) return fail(`reason: schemaError.error must NOT be overwritten by turn #2's start-refusal (sticky lastError leak), got ${JSON.stringify(after?.schemaError?.error)}`);
    if (!/codex turn/i.test(after?.schemaError?.error || "")) return fail(`reason: schemaError.error should still carry turn #1's reason, got ${JSON.stringify(after?.schemaError?.error)}`);
    console.log(`[harness] reason OK — schemaError.error reports the failed turn's OWN reason, not a later start-refusal's sticky lastError`);
    sd.kill();
    await sleep(200);
  }

  console.log("[harness] >>> PASS: schema → json (round-trips into turn/start, carried through wait); ref keeps json but nulls text; invalid-JSON and failed-turn both become schemaError without throwing; turn/start-failure drift both ways stays in sync; schemaError reason is per-turn (no sticky-lastError leak); omp/claude reject schema");
  await sleep(200);
  process.exit(0);
}
main().catch(e => fail(String(e)));
