// Fake claude backend stub: speaks just enough of the claude stream-json protocol to drive
// the abort-fallback test (probe-claude-abort-fallback.mjs). Behavior:
//   - Emits NOTHING on startup (real claude is silent until the first user message; the
//     bridge marks the session idle immediately on spawn, no handshake needed).
//   - On 1st user message (turn A): emits ONE assistant event, then WITHHOLDS the result.
//     This forces the bridge's 5s abort() fallback to fire (no result arrives within 5s).
//   - On interrupt control_request: immediately echoes a control_response success (so the
//     bridge's first 5s wait resolves cleanly), but STILL withholds turn A's result (forcing
//     the second 5s wait to expire, which triggers pendingAbortedResults += 1 + force-settle).
//   - On 2nd user message (turn B): first flushes turn A's STALE result (error_during_execution),
//     then emits turn B's assistant event + success result. The bridge must swallow the stale
//     result (pendingAbortedResults counter) and settle turn B with FAKE_CLAUDE_B_OK cleanly.
// Launched via fake-claude.cmd (Windows) or fake-claude.sh (POSIX) through CLAUDE_BIN env var.
import readline from "node:readline";

const say = obj => process.stdout.write(JSON.stringify(obj) + "\n");
// Emit an assistant message carrying ONE call's per-call usage (input side = `inputSide`), like real claude.
const asstUsage = (text, inputSide) => say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: inputSide, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } });

// T4/P1: when FAKE_CLAUDE_STDERR is set, emit one benign line to STDERR on startup (real claude/CLIs
// write progress/info to stderr). It must land in the session's lastStderr, NOT lastError. Gated so the
// abort-fallback test's behavior is unchanged.
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write("[fake-claude] benign progress on stderr\n");

// FAKE_CLAUDE_MODE selects behavior; default "abortfallback" preserves the abort-fallback dance below.
//   abortusage — the abort dance, but turn A's assistant CARRIES usage (77000), and on turn B a LATE
//              turn-A assistant carrying usage (99000) is flushed BEFORE A's stale result (i.e. while
//              pendingAbortedResults>0). B's own assistant carries NO usage. Proves the #handleLine gate:
//              the late aborted-turn usage is skipped (pending>0) and #beginTurn already reset A's 77000,
//              so contextUsage is null after B — the aborted turn's reading never leaks into B.
// The ctx* modes mirror REAL claude stream-json: each API call streams as an `assistant` message whose
// message.usage carries that ONE call's input side (input_tokens + cache_read + cache_creation). Verified
// empirically 2026-07-06 (a 3-call turn: last call 33663 vs the whole-turn modelUsage sum 100374).
//   ctxturn  — a clean turn with THREE growing assistant calls (last input-side = 41002). The result ALSO
//              carries a large whole-turn modelUsage/usage aggregate (100004). Proves contextUsage takes
//              the LAST per-call value (41002) and IGNORES the aggregate — the regression guard for the
//              old sum-based over-count. live:false.
//   ctxstale — turn 1 streams assistant usage (41002); turn 2 streams an assistant with NO usage. Proves
//              the #beginTurn reset: contextUsage must be null after turn 2 (not turn 1's stale number).
//   ctxlast  — three calls 30000 → 60000 (peak) → 45000 (after a mid-turn compaction). Proves contextUsage
//              is the LAST call (45000), not the max (60000) and not the sum (135000) — last reflects
//              post-compaction reality, which max would miss.
const CMODE = process.env.FAKE_CLAUDE_MODE || "abortfallback";
let userMsgCount = 0;
let ctxTurns = 0;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", line => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (CMODE.startsWith("ctx") && msg.type === "user") {
    ctxTurns += 1;
    // Each assistant message carries ONE call's per-call usage (input + cache_read + cache_creation),
    // exactly like real claude. contextUsage takes the LAST such call, never the sum across the turn.
    const asst = (text, usage) => say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], ...(usage ? { usage } : {}) } });
    const u = (input, cr, cc) => ({ input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 5 });
    const base = { type: "result", subtype: "success", is_error: false, result: "CTX_ANSWER", session_id: "fake-claude-ctx" };
    if (CMODE === "ctxlast") {
      // Three calls: 30000 → 60000 (peak) → 45000 (after a mid-turn compaction). contextUsage must be the
      // LAST (45000), NOT the max (60000) and NOT the sum (135000).
      asst("A", u(10000, 20000, 0));    // 30000
      asst("B", u(10000, 45000, 5000)); // 60000 (peak)
      asst("CTX_ANSWER", u(5000, 40000, 0)); // 45000 (last — post-compaction)
      say(base);
    } else if (CMODE === "ctxstale" && ctxTurns >= 2) {
      // Turn 2's assistant carries NO usage → lastCallContextTokens stays null → contextUsage null.
      asst("CTX_ANSWER", null);
      say(base);
    } else {
      // ctxturn, and ctxstale turn 1: three growing calls, last = 41002. The result ALSO carries a big
      // whole-turn aggregate (usage/modelUsage sum to 100004) — contextUsage must IGNORE it (the old code
      // summed modelUsage and would report 100004; the fix reports the last per-call value 41002).
      asst("D", u(5000, 20000, 3000)); // 28000
      asst("E", u(2, 30000, 1000));    // 31002
      asst("CTX_ANSWER", u(2, 40000, 1000)); // 41002 (last)
      say({ ...base,
        usage: { input_tokens: 5004, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000, output_tokens: 15 },
        modelUsage: { "claude-opus-4-8[1m]": { inputTokens: 5004, cacheReadInputTokens: 90000, cacheCreationInputTokens: 5000, contextWindow: 1000000, maxOutputTokens: 64000 } },
      });
    }
    return;
  }

  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    // Immediately ack the interrupt so the bridge's first 5s withTimeout resolves.
    // Do NOT emit any result — that forces the bridge's second 5s withTimeout to expire,
    // activating the abort-fallback: pendingAbortedResults += 1, then force-settle turn A.
    say({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
    return;
  }

  if (msg.type === "user") {
    userMsgCount += 1;

    if (userMsgCount === 1) {
      // Turn A: emit one assistant event so the bridge transitions to status "running",
      // but WITHHOLD the terminal result event. The bridge's abort() will:
      //   1. Send interrupt control_request → we ack immediately above.
      //   2. Wait 5s for turn.promise to settle → times out (we never emit a result).
      //   3. Force-settle: pendingAbortedResults = 1, #settleTurn(null, "aborted") → status "idle".
      if (CMODE === "abortusage") asstUsage("FAKE_CLAUDE_A_PARTIAL", 77000); // A's assistant carries usage
      else say({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "FAKE_CLAUDE_A_PARTIAL" }] },
      });
      // No result emitted for turn A — that is the deliberate trigger for the fallback path.
      return;
    }

    if (userMsgCount === 2) {
      // Turn B: FIRST flush turn A's stale/late result (the one the bridge now expects to swallow),
      // THEN emit turn B's assistant event + success result. Order matters: the FIFO invariant the
      // bridge relies on is "turn A result arrives before turn B result". We replicate that exactly.
      //
      // Bridge #handleResult path for the stale A result:
      //   pendingAbortedResults (= 1) > 0 → swallowed, decremented to 0, returns early.
      //
      // Bridge #handleResult path for turn B's success result:
      //   pendingAbortedResults = 0, interrupting = false → normal success → finalAnswer = "FAKE_CLAUDE_B_OK",
      //   #settleTurn(null, "success") → turn resolves, status "idle".
      // A's STALE result carries a LARGE modelUsage. It must be SWALLOWED without touching contextUsage:
      // if the bridge captured usage before the swallow gate, this 500k reading would leak as the
      // session's context. Turn B's result deliberately OMITS modelUsage, so a leak would persist
      // (nothing overwrites it) — after B, contextUsage must be null, not 500k. Isolates the capture-
      // after-gate + reset-at-beginTurn fix.
      // abortusage: BEFORE flushing A's stale result, emit a LATE turn-A assistant carrying usage (99000).
      // It arrives while pendingAbortedResults>0 and this.turn=B, so the #handleLine gate must SKIP it —
      // otherwise it would leak as B's contextUsage. B's own assistant (below) carries NO usage, so a leak
      // would survive to the assertion.
      if (CMODE === "abortusage") asstUsage("FAKE_CLAUDE_A_LATE", 99000);
      say({
        type: "result", subtype: "error_during_execution", is_error: true, session_id: "fake-claude-1",
        modelUsage: { "claude-opus-4-8[1m]": { inputTokens: 500000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000000 } },
      });
      say({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "FAKE_CLAUDE_B_OK" }] },
      });
      // Turn B's success result intentionally has NO modelUsage; B's assistant carries no usage either.
      say({ type: "result", subtype: "success", is_error: false, result: "FAKE_CLAUDE_B_OK", session_id: "fake-claude-1" });
      return;
    }
  }
});

rl.on("close", () => process.exit(0));
process.stdin.on("error", () => {});

// Safety valve: exit after 120s in case something in the harness stalls. Normal test runtime
// is under 15s. unref() so this timer never prevents a clean natural exit.
setTimeout(() => process.exit(0), 120_000).unref();
