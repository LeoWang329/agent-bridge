// Fake Kimi Code CLI: emits just enough OpenAI chat-completions-style stream-json to drive the hermetic
// KimiCodeSession tests (repro-kimi.mjs). Kimi is a self-contained native `kimi.exe` (Shape B: a local
// session id + a per-turn short-lived process), and the bridge spawns it DIRECTLY as
//   kimi.exe --output-format stream-json [-S session_<uuid>] [-m <model>] -p <prompt>
// with `--output-format` as argv[1] — so a renamed node.exe copy can't stand in (node chokes on that
// flag). repro-kimi.mjs therefore compiles a tiny REAL `kimi.exe` forwarder stub (argv0 MUST be kimi.exe
// for resolveKimiBin + the cleanup matcher) that re-execs `node fake-kimi.js <the bridge's verbatim args>`.
// FAKE_KIMI_SCRIPT points the stub at this file. Mode is selected by FAKE_KIMI_MODE (server-wide env, so
// the harness uses one server per mode). CommonJS-safe (globals only, wrapped in main()).
//
// A turn ends by process exit; success = exit0 AND a valid terminal `meta` (session.resume_hint) AND no
// protocol error (§2.1). First turn mints session id FIRST_ID (captured into chatId); a continuation turn
// (has -S <id>) echoes that id back in its meta so identity stays consistent.

function main() {
  const argv = process.argv.slice(2);
  const mode = process.env.FAKE_KIMI_MODE || "ok";
  const say = o => process.stdout.write(JSON.stringify(o) + "\n");

  // ── --version (doctor probe) ────────────────────────────────────────────────────────────────────
  // doctor() versions the resolved native kimi.exe via `<abs kimi.exe> --version` (§5.9). Answer directly
  // so the probe sees a Kimi-shaped version line, not a stream-json turn.
  if (argv.includes("--version")) { process.stdout.write("0.27.0\n"); process.exit(0); return; }

  const si = argv.indexOf("-S");
  const resumeId = si >= 0 ? argv[si + 1] : null; // null on the first turn
  const pi = argv.indexOf("-p");
  const prompt = pi >= 0 ? argv[pi + 1] : "";

  // Anchored `session_<uuid>` ids (§2.1 regex ^session_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$).
  const FIRST_ID = "session_11111111-2222-4333-8444-555555555555";
  const OTHER_ID = "session_99999999-8888-4777-8666-555544443333";

  const asst = t => say({ role: "assistant", content: t });
  const toolCall = name => say({ role: "assistant", tool_calls: [{ type: "function", id: "tool_1", function: { name, arguments: "{}" } }] });
  const toolResult = () => say({ role: "tool", tool_call_id: "tool_1", content: "tool output\n" });
  const meta = id => say({ role: "meta", type: "session.resume_hint", session_id: id });
  // process.exit can truncate a pipe mid-write; a short delay lets the NDJSON drain to the bridge first.
  const exit = (code, ms = 30) => setTimeout(() => process.exit(code), ms);

  const runTurn = () => {
    const myId = resumeId || FIRST_ID; // continuation echoes the resumed id; first turn mints FIRST_ID
    switch (mode) {
      case "echoprompt":
        // Echo the EXACT received prompt (the -p value) as assistant content, so a test can assert what the
        // bridge composed (first-turn append_system injection + read policy prefix).
        asst(prompt); meta(myId); exit(0); return;
      case "multiline":
        asst("part one "); toolCall("Bash"); toolResult(); asst("part two"); meta(myId); exit(0); return;
      case "nometa":
        asst("answer but no meta"); exit(0); return; // exit0 + no meta → protocol error (§2.1)
      case "exitnonzero":
        asst("attempting"); meta(myId); exit(3); return; // nonzero exit → failed (even with meta)
      case "mismatch":
        // First turn establishes FIRST_ID; a continuation turn reports a DIFFERENT id → protocol error,
        // chatId must NOT be overwritten (§2.1).
        if (!resumeId) { asst("first"); meta(FIRST_ID); } else { asst("second"); meta(OTHER_ID); }
        exit(0); return;
      case "delayexit":
        asst("slow"); meta(myId); exit(0, 600); return; // meta emitted early; exit delayed → close settles
      case "hang":
        asst("working"); toolCall("Bash"); setTimeout(() => process.exit(0), 60000); return; // hang until killed
      case "okthenhang":
        // First turn succeeds (mints chatId); a continuation turn hangs → lets a test abort/reuse a
        // session that already holds a resumable chatId (abort tree-kill + stale-close-safe reuse).
        if (!resumeId) { asst("ok"); meta(FIRST_ID); exit(0); }
        else { asst("working"); toolCall("Bash"); setTimeout(() => process.exit(0), 60000); }
        return;
      default: // "ok"
        asst("hello from kimi"); meta(myId); exit(0);
    }
  };

  // Small delay so the bridge finishes spawn/#beginTurn before output arrives (mirrors real latency).
  setTimeout(runTurn, 50);
}

process.stdin.on("error", () => {});
// Safety valve: never outlive a test run.
setTimeout(() => process.exit(0), 120000).unref?.();
main();
