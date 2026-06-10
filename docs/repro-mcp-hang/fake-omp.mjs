// Fake omp backend: speaks just enough of the omp RPC protocol, then closes its OWN stdin
// read-end after 3s while staying alive — simulating a backend in graceful teardown
// (e.g. fatal API error) where the pipe breaks before the process exits.
// Launched via fake-omp.cmd (Windows) or fake-omp.sh (POSIX); see repro-pipebreak.mjs.
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
        say({ type: "response", id: msg.id, command: "get_state", success: true, data: { isStreaming: true, queuedMessageCount: 0, sessionId: "fake", messageCount: 1 } });
      } else if (msg.type === "prompt") {
        say({ type: "response", id: msg.id, success: true });
        say({ type: "agent_start" });
      } else if (msg.id) {
        say({ type: "response", id: msg.id, success: true, data: {} });
      }
    } catch {}
  }
});
process.stdin.on("error", () => {});

say({ type: "ready" });

setTimeout(() => {
  process.stderr.write("[fake-omp] destroying my stdin now, staying alive\n");
  process.stdin.destroy();
}, 3000);

setTimeout(() => process.exit(0), 60000);
