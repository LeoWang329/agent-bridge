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

// T4/P1: when FAKE_CLAUDE_STDERR is set, emit one benign line to STDERR on startup (real claude/CLIs
// write progress/info to stderr). It must land in the session's lastStderr, NOT lastError. Gated so the
// abort-fallback test's behavior is unchanged.
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write("[fake-claude] benign progress on stderr\n");

// FAKE_CLAUDE_MODE selects behavior; default "abortfallback" preserves the abort-fallback dance below.
//   ctxturn  — a single CLEAN turn whose success result carries modelUsage with TWO model entries: a
//              1M-window primary and a 200k-window subagent. Proves contextUsage picks the LARGEST-window
//              entry (subagent excluded) and sums the input-side tokens, with live:false.
//   ctxstale — turn 1's result carries modelUsage; turn 2's result OMITS it. Proves the #beginTurn reset:
//              contextUsage must be null after turn 2 (not turn 1's stale number).
//   ctxtie   — a turn whose modelUsage has TWO entries with the SAME (1M) contextWindow: a subagent listed
//              FIRST with few tokens, the main model SECOND with more. Proves the equal-window tie-break
//              picks the higher-token entry (the main conversation), not first-seen.
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
    say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "CTX_ANSWER" }] } });
    const base = { type: "result", subtype: "success", is_error: false, result: "CTX_ANSWER", session_id: "fake-claude-ctx" };
    if (CMODE === "ctxtie") {
      // Equal windows (both 1M): subagent entry FIRST (fewer tokens), main SECOND (more). Tie-break by
      // tokens must pick the main model (40000+10000=50000), NOT the first-seen subagent (1000).
      say({ ...base, modelUsage: {
        "claude-opus-4-7[1m]": { inputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000000 },
        "claude-opus-4-8[1m]": { inputTokens: 40000, cacheReadInputTokens: 10000, cacheCreationInputTokens: 0, contextWindow: 1000000 },
      } });
    } else if (CMODE === "ctxstale" && ctxTurns >= 2) {
      // Turn 2 OMITS modelUsage → contextUsage must reset to null (not report turn 1's number).
      say(base);
    } else {
      // ctxturn, and ctxstale turn 1: report modelUsage (1M primary + a 200k subagent to exclude).
      say({ ...base,
        usage: { input_tokens: 8000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 3000, output_tokens: 5 },
        modelUsage: {
          "claude-opus-4-8[1m]": { inputTokens: 8000, cacheReadInputTokens: 20000, cacheCreationInputTokens: 3000, contextWindow: 1000000, maxOutputTokens: 64000 },
          "claude-haiku-4-5": { inputTokens: 400, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, contextWindow: 200000, maxOutputTokens: 8000 },
        },
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
      say({
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
      say({
        type: "result", subtype: "error_during_execution", is_error: true, session_id: "fake-claude-1",
        modelUsage: { "claude-opus-4-8[1m]": { inputTokens: 500000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 1000000 } },
      });
      say({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "FAKE_CLAUDE_B_OK" }] },
      });
      // Turn B's success result intentionally has NO modelUsage.
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
