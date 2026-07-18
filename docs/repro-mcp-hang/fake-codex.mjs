// Fake codex `app-server`: speaks just enough of the JSON-RPC app-server protocol to drive the T11
// (structured-output) repros WITHOUT a real backend or any token spend. Behavior is selected by
// FAKE_CODEX_MODE (default "schemaok"):
//   schemaok   — a clean turn whose final answer is VALID JSON that ECHOES the outputSchema it received
//                on turn/start (`{ok:true, receivedSchema:<schema>}`). Proves the bridge (a) forwards the
//                schema into turn/start and (b) parses the answer into a top-level `json`. [repro-schema]
//   schemabad  — a clean turn whose final answer is NON-JSON text. The turn SUCCEEDS (status completed),
//                so buildSessionResult must surface `schemaError:{error,rawText}` from the parse failure
//                — and must NOT throw. [repro-schema]
//   schemafail — the turn ends in status:"failed" (the shape codex uses when the model can't satisfy the
//                schema). buildSessionResult must normalize that to `schemaError` carrying the failure
//                reason, again WITHOUT throwing. [repro-schema, covers codex's failed-turn path]
//   startfail2 — turn #1's turn/start SUCCEEDS (a clean turn, schema-echoing like schemaok), but turn #2's
//                turn/start is REFUSED with an error response. Exercises the schema-flag/text drift codex
//                caught: the failed 2nd turn/start must leave turn #1's (text + schema flag) intact — no
//                stale-schema mislabel and no erased json. [repro-schema drift scenarios]
//   failstart  — turn #1 BEGINS then ends status:"failed" (like schemafail); turn #2's turn/start is
//                REFUSED. Exercises the round-2 edge: schemaError.error must report turn #1's OWN failure
//                reason (from #settleTurn), not the sticky lastError that turn #2's start-refusal
//                overwrote. [repro-schema failure-reason scenario]
//   bigoutput  — a clean turn that first emits a commandExecution item/completed carrying a ~2 MB
//                aggregatedOutput (the real codex shape; measured at 1.5 MB on a single log line in the
//                field), then a long agentMessage. Proves the diagnostic log stays bounded and the event
//                skeleton (command, exitCode, durationMs) survives. [repro-log-bounds]
//   ctxturn    — a clean plain turn that ALSO emits a thread/tokenUsage/updated notification carrying
//                {last:{inputTokens,totalTokens,...}, total:{...}, modelContextWindow}. Proves the bridge
//                normalizes contextUsage from last.inputTokens (NOT total, NOT totalTokens) + modelContext-
//                Window, with live:false. [repro-context-usage]
// Requests answered: initialize, thread/start, turn/start, turn/interrupt (+ any other id'd request → {}).
// Notifications are emitted ~50ms after the turn/start RESPONSE so the normal async path runs (send()
// returns its ack / arms the wait, THEN the turn settles via notification) rather than the same-flush path.
// Launched via fake-codex.cmd (Windows) / fake-codex.sh (POSIX) through CODEX_BIN; env is inherited.
const MODE = process.env.FAKE_CODEX_MODE || "schemaok";
const say = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const respond = (id, result) => say({ id, result });

let turnSeq = 0;
let buf = "";
process.stdin.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // Notifications (no id) — nothing to answer.
    if (msg.id === undefined) continue;
    const { id, method, params = {} } = msg;
    if (method === "initialize") { respond(id, {}); continue; }
    if (method === "thread/start") { respond(id, { thread: { id: "fake-thread-1" } }); continue; }
    if (method === "turn/interrupt") { respond(id, {}); continue; }
    if (method === "turn/start") {
      const seq = ++turnSeq;
      // startfail2: refuse the SECOND turn/start with an error response (the turn never begins). Turn #1
      // still runs cleanly, so the bridge has a prior result whose text+schema-flag must survive intact.
      if ((MODE === "startfail2" || MODE === "failstart") && seq >= 2) {
        say({ id, error: { code: -32000, message: `fake-codex: turn/start refused (${MODE})` } });
        continue;
      }
      const tid = `fake-turn-${seq}`;
      const schema = params.outputSchema ?? null;
      // Accept the turn with NO terminal status → the bridge keeps it in flight and is driven by the
      // notifications below (the common non-blocking path).
      respond(id, { turn: { id: tid } });
      setTimeout(() => driveTurn(tid, schema), 50);
      continue;
    }
    // Any other request: benign empty result.
    respond(id, {});
  }
});
process.stdin.on("error", () => {});

function driveTurn(tid, schema) {
  say({ method: "turn/started", params: { turn: { id: tid } } });
  if (MODE === "ctxturn") {
    // Report per-turn usage the way codex does. inputTokens = the tokens fed to the model this turn =
    // current context length; totalTokens/total are decoys the bridge must NOT pick. Then a plain answer.
    say({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { totalTokens: 987654, inputTokens: 900000, outputTokens: 87654 },
          last: { totalTokens: 99999, inputTokens: 21401, cachedInputTokens: 12000, outputTokens: 300, reasoningOutputTokens: 50 },
          modelContextWindow: 258400,
        },
      },
    });
    say({ method: "item/completed", params: { turn: { id: tid }, item: { type: "agentMessage", text: "ctx answer", phase: "final_answer", id: "item-1" } } });
    say({ method: "turn/completed", params: { turn: { id: tid, status: "completed" } } });
    return;
  }
  if (MODE === "bigoutput") {
    // (a) A 2 MB NON-JSON stdout line. The bridge's JSON.parse catch logs raw lines verbatim on every
    // backend — a path no redaction/type-exclusion touches, so only appendLog's byte cap can bound it.
    process.stdout.write(`fake-codex banner ${"z".repeat(2_000_000)}\n`);
    // (a2) The same, but padded with 4-byte characters. Four lines whose ASCII prefix grows by one byte
    // each, so whatever the cap lands on, at least three of the four cut MID-CHARACTER and the boundary
    // back-off is actually exercised (an all-ASCII payload can never prove it).
    for (let pad = 0; pad < 4; pad++) process.stdout.write(`fake-codex emoji${"!".repeat(pad)} ${"🙂".repeat(20_000)}\n`);
    // (b) The exact field layout observed in a real codex session log (keys: type,id,command,cwd,processId,
    // source,status,commandActions,aggregatedOutput,exitCode,durationMs).
    say({
      method: "item/completed",
      params: {
        turn: { id: tid },
        item: {
          type: "commandExecution", id: "cmd-1",
          command: "node -e \"process.stdout.write('x'.repeat(2e6))\"",
          cwd: process.cwd(), processId: 4242, source: "agent", status: "completed",
          commandActions: [{ type: "exec", command: "node -e ..." }],
          aggregatedOutput: "x".repeat(2_000_000),
          exitCode: 0, durationMs: 1234,
        },
      },
    });
    say({
      method: "item/completed",
      params: { turn: { id: tid }, item: { type: "agentMessage", text: `ran it. ${"y".repeat(50_000)}`, phase: "final_answer", id: "item-1" } },
    });
    say({ method: "turn/completed", params: { turn: { id: tid, status: "completed" } } });
    return;
  }
  if (MODE === "schemafail" || MODE === "failstart") {
    // Turn fails outright (model couldn't satisfy the schema). No final answer item.
    say({ method: "turn/completed", params: { turn: { id: tid, status: "failed" } } });
    return;
  }
  const answer =
    MODE === "schemabad"
      ? "this is not JSON at all <<<" // parse must fail → schemaError, no throw
      : JSON.stringify({ ok: true, receivedSchema: schema }); // schemaok: valid JSON echoing the schema
  say({
    method: "item/completed",
    params: { turn: { id: tid }, item: { type: "agentMessage", text: answer, phase: "final_answer", id: "item-1" } },
  });
  say({ method: "turn/completed", params: { turn: { id: tid, status: "completed" } } });
}

// A late safety valve so a hung test never leaks this process.
setTimeout(() => process.exit(0), 60000);
