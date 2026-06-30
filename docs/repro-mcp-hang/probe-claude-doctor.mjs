// Asserts the `claude` backend is registered and doctor probes it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/agent-bridge.mjs");
const out = spawnSync("node", [BRIDGE, "doctor"], { encoding: "utf8" });
const text = (out.stdout || "") + (out.stderr || "");
const ok = /(^|\n)claude:\s*(ok|missing)/i.test(text);
console.log(text);
console.log(ok ? ">>> PASS: claude backend registered (doctor lists it)" : ">>> FAIL: claude not listed by doctor");
process.exit(ok ? 0 : 1);
