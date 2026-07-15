// Fake cursor-agent `index.js`: speaks just enough of Cursor's CLI to drive the hermetic
// CursorAgentSession tests (repro-cursor.mjs). At test setup this file is COPIED into a fake
// install layout `<tmp>\cursor-agent\versions\<v>\index.js` next to a hardlink of the real
// node.exe, and CURSOR_AGENT_BIN points at that install root — so the bridge resolves and spawns
// `node index.js …` exactly as it would the real Cursor. CommonJS-safe (globals only, no imports,
// wrapped in main()) so it runs as `node index.js` regardless of surrounding package.json.
//
// Behavior is selected by FAKE_CURSOR_MODE (server-wide env, so the harness uses one server per mode):
//   create-chat subcommand → prints a bare UUID + exit 0 (unless createfail/createhang).
//   a turn (`-p --resume <id> --output-format stream-json … -- <prompt>`) emits stream-json then exits:
//     ok         — assistant + success result("FAKE_CURSOR_OK") + exit 0
//     multiblock — two assistant blocks around a shell tool_call, then success result
//     delayexit  — success result, THEN exit ~800ms later (proves `close`, not `result`, settles)
//     noresult   — assistant but NO result, then exit 0 (protocol error → failed turn)
//     resulterror— assistant + result{is_error:true} (→ failed turn), exit 0
//     abort      — assistant + a shell tool_call, then HANG (no result/exit) so abort must tree-kill

function main() {
  const argv = process.argv.slice(2);
  const mode = process.env.FAKE_CURSOR_MODE || "ok";
  const say = o => process.stdout.write(JSON.stringify(o) + "\n");

  // ── --version (doctor probe) ────────────────────────────────────────────────────────────────────
  // doctor() versions the resolved `node index.js --version` (NOT a bare node.exe, §5.9). Answer it
  // directly so the probe sees a Cursor-shaped version line, not a stream-json turn.
  if (argv.includes("--version") && argv[0] !== "create-chat") {
    process.stdout.write("fake-cursor 9.9.9\n");
    process.exit(0);
    return;
  }

  // ── create-chat ───────────────────────────────────────────────────────────────────────────────
  if (argv[0] === "create-chat") {
    if (mode === "createfail") { process.stderr.write("Not authenticated. Run `agent login`.\n"); process.exit(1); return; }
    if (mode === "createhang") { setTimeout(() => {}, 1e9); return; } // never exits → create-chat timeout
    process.stdout.write("11111111-2222-4333-8444-555555555555\n"); // bare UUID (like real create-chat)
    process.exit(0);
    return;
  }

  // ── a turn ────────────────────────────────────────────────────────────────────────────────────
  const dd = argv.indexOf("--");
  const prompt = dd >= 0 ? argv.slice(dd + 1).join(" ") : "";
  const ri = argv.indexOf("--resume");
  const chatId = ri >= 0 ? argv[ri + 1] : "unknown";

  const runTurn = () => {
    say({ type: "system", subtype: "init", session_id: chatId, cwd: process.cwd(), apiKeySource: "login" });
    say({ type: "user", message: { role: "user", content: prompt } }); // prompt echo — bridge must NOT re-log this
    say({ type: "thinking", subtype: "delta", text: "reasoning-should-not-be-logged" });
    const asst = t => say({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
    const shell = cmd => {
      say({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: cmd } } } });
      say({ type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { args: { command: cmd } } } });
    };
    const ok = res => say({ type: "result", subtype: "success", is_error: false, duration_ms: 7, duration_api_ms: 5, result: res });

    switch (mode) {
      case "echoprompt":
        // Return the EXACT received prompt (everything after `--`) as the result, so a test can assert
        // what the bridge composed (e.g. first-turn system-prompt injection).
        asst("echoing"); ok(prompt);
        process.exit(0); return;
      case "multiblock":
        asst("AAA"); shell("echo hi"); asst("BBB"); ok("FAKE_CURSOR_OK");
        process.exit(0); return;
      case "delayexit":
        asst("hi"); ok("FAKE_CURSOR_OK");
        setTimeout(() => process.exit(0), 800); return; // result emitted; exit delayed
      case "noresult":
        asst("partial-answer-no-result");
        process.exit(0); return; // no result → protocol error
      case "resulterror":
        asst("attempting");
        say({ type: "result", subtype: "error", is_error: true, duration_ms: 5 });
        process.exit(0); return;
      case "abort":
        asst("working on it");
        shell("sleep 999"); // cosmetic — the fake never really runs shell
        setTimeout(() => process.exit(0), 60_000); return; // effectively hang until tree-killed
      default: // "ok"
        asst("hello there"); ok("FAKE_CURSOR_OK");
        process.exit(0);
    }
  };

  // Small delay so the bridge finishes spawn/#beginTurn before output arrives (mirrors real latency).
  setTimeout(runTurn, 50);
}

process.stdin.on("error", () => {});
// Safety valve: never outlive a test run.
setTimeout(() => process.exit(0), 120000).unref?.();
main();
