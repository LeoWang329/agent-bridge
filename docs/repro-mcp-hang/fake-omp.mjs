// Fake omp backend: speaks just enough of the omp RPC protocol to drive the repros. Behavior is
// selected by FAKE_OMP_MODE (default "pipebreak"):
//   pipebreak — ack prompt + agent_start, answer get_state, then destroy our OWN stdin read-end at
//               T+3s while staying alive (graceful-teardown / broken-pipe shape). [repro-pipebreak]
//   silent    — ack prompt + agent_start, but NEVER answer get_state (process alive, pipe writable,
//               no responses) — the half-dead backend shape. [repro-halfdead -> P/F4 fast-fail]
//   turnstate — ack prompt, then emit turn_start -> turn_end -> turn_start (a backend re-entering a
//               turn on its own) and stay quiet/running. [repro-turnstate -> F7/F8 coherent clock]
//   rejectprompt — REFUSE the prompt (respond success:false) while staying alive and idle, so no turn
//               ever starts. send() throws, status returns to idle. [repro-waitfail -> R2/turnInFlight:
//               a rejected-prompt session must still settle wait(), not dead-wait on a turn that never comes]
//   okturn    — a CLEAN turn: ack prompt, emit agent_start + one text message_update + turn_end, and
//               report isStreaming:false to get_state so the session settles idle with real answer text.
//               A benign line is written to STDERR mid-turn (must NOT be treated as a fatal lastError).
//               [repro-wait-shape (T1 result-field passthrough) / repro-laststderr (T4) / repro-health (T9)]
// Launched via fake-omp.cmd (Windows) or fake-omp.sh (POSIX) through OMP_BIN; env is inherited.
const MODE = process.env.FAKE_OMP_MODE || "pipebreak";
const say = obj => process.stdout.write(JSON.stringify(obj) + "\n");

let buf = "";
process.stdin.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        if (MODE === "silent") continue; // half-dead: swallow the poll, never respond
        // okturn settles idle, so it must report NOT streaming (else state() would flip status back to
        // running after turn_end and the session would never settle for wait()).
        const isStreaming = MODE !== "okturn";
        say({ type: "response", id: msg.id, command: "get_state", success: true, data: { isStreaming, queuedMessageCount: 0, sessionId: "fake", messageCount: 1 } });
      } else if (msg.type === "prompt") {
        if (MODE === "rejectprompt") {
          // Refuse the prompt; no turn ever starts. The bridge's send() rejects and returns the
          // session to idle. A correct sessionSettled must then settle wait() (turnInFlight cleared
          // in send()'s catch), not dead-wait. Pre-turnInFlight (everPrompted) this dead-waited.
          say({ type: "response", id: msg.id, success: false, error: "fake-omp: prompt refused" });
          continue;
        }
        say({ type: "response", id: msg.id, success: true });
        if (MODE === "okturn") {
          // A clean, fully-settling turn with real answer text. Emit a benign STDERR line mid-turn so
          // tests can assert it does NOT become a fatal lastError (T4). Then agent_start -> text -> turn_end.
          process.stderr.write("[fake-omp] progress: thinking...\n");
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "OKTURN_ANSWER" } });
            say({ type: "turn_end" });
          }, 60);
        } else if (MODE === "turnstate") {
          // Churn turns on our own (no new prompt): start, then end->start->end. The mid re-entry
          // (turn_end -> turn_start) exercises F7's stamp-clear; we settle on turn_end (status idle,
          // turnEndedAt SET) while get_state keeps reporting isStreaming:true — so the bridge's
          // status()/state() path flips status->running with the end stamp still set. That "running +
          // endedAt" contradiction is exactly what F8 (status-aware lastTurnOf) must suppress.
          say({ type: "turn_start" });
          setTimeout(() => { say({ type: "turn_end" }); say({ type: "turn_start" }); say({ type: "turn_end" }); }, 120);
        } else {
          say({ type: "agent_start" });
        }
      } else if (msg.id) {
        say({ type: "response", id: msg.id, success: true, data: {} });
      }
    } catch {}
  }
});
process.stdin.on("error", () => {});

say({ type: "ready" });

if (MODE === "pipebreak") {
  setTimeout(() => {
    process.stderr.write("[fake-omp] destroying my stdin now, staying alive\n");
    process.stdin.destroy();
  }, 3000);
}

setTimeout(() => process.exit(0), 60000);
