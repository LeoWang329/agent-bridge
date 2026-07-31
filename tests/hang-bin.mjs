// A fake "backend binary" that HANGS instead of answering `--version`, to prove doctor()'s probe
// timeout (T2/P3) AND that the timeout kills the whole process tree (no orphaned grandchild). Ignores
// its args and produces no output. On startup it appends its own pid to HANG_PID_FILE (if set) so the
// repro can assert this process is actually dead after doctor() returns — on Windows this node process
// is the grandchild under a cmd.exe .cmd shim, exactly the process that would be orphaned if the fix
// only killed the direct child. Self-reaps after 30s as a backstop so a broken fix can't leave a
// forever-orphan across repeated test runs (still far longer than the repro's timing budget, so it
// cannot mask a failed tree-kill within the test window).
import fs from "node:fs";
const pidFile = process.env.HANG_PID_FILE;
if (pidFile) { try { fs.appendFileSync(pidFile, `${process.pid}\n`); } catch {} }
process.stdin.resume?.();
setTimeout(() => process.exit(0), 30000);
