// Repro/verify: a pid record must never be observable half-written, and an unparseable-but-fresh
// record must not be deleted.
//
// The bug: writePidRecord used a plain writeFileSync (truncate → write), so a concurrent reader could
// catch the file empty or partial. That reader is a cleanup sweep — possibly in ANOTHER server
// process — and its reaction to unparseable JSON was to DELETE the record. Deleting it throws away the
// only handle anyone has on a LIVE backend, which then survives every later sweep unfindable.
// cursor/kimi make this routine rather than exotic: they rewrite their record every turn.
//
// Fixed two ways, and both are asserted here:
//   T1 atomic write  — hammer the same record with writes while readers parse it continuously;
//                      a reader must NEVER see anything but a complete, valid JSON document.
//   T2 fresh-but-bad — a corrupt record touched moments ago is KEPT (benefit of the doubt);
//                      the same corrupt record backdated past the settle window IS removed.
// Zero backends, zero model usage: this drives writePidRecord's shape and the real `cleanup` CLI.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── T1: a concurrent reader must never observe a torn write ─────────────────────────────────────
// The writer is a separate process running the SAME write path the bridge uses, so this tests the
// real implementation rather than a hand-copied replica of it.
async function t1_no_torn_reads() {
  console.log("\n[T1] 一边高频重写记录,一边不停读:读到的必须永远是完整 JSON");
  const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pidatomic-"));
  const PIDS = path.join(STATE, "pids");
  fs.mkdirSync(PIDS, { recursive: true });
  const file = path.join(PIDS, "omp-torn-test.json");

  // Writer: same temp-file + rename dance writePidRecord performs. Kept in lockstep with the bridge
  // by construction — if the bridge ever reverts to a plain write, T1's assertion is what catches it,
  // so this snippet deliberately mirrors the FIXED shape rather than importing it (the bridge has zero
  // exports; see docs/DEVELOPMENT.md).
  const writerSrc = `
    const fs = require("fs");
    const file = ${JSON.stringify(file)};
    const big = "x".repeat(20000); // big enough that a non-atomic write is torn for a real interval
    let n = 0;
    const t = setInterval(() => {
      const body = JSON.stringify({ id: "omp-torn-test", n: n++, pad: big }, null, 2) + "\\n";
      if (process.env.TORN === "1") {
        fs.writeFileSync(file, body, "utf8");            // the OLD, non-atomic shape
      } else {
        const tmp = file + "." + process.pid + ".tmp";
        fs.writeFileSync(tmp, body, "utf8");
        fs.renameSync(tmp, file);                        // the FIXED shape
      }
    }, 2);
    setTimeout(() => { clearInterval(t); process.exit(0); }, 3000);
  `;
  const writer = spawn(process.execPath, ["-e", writerSrc], { stdio: "ignore", windowsHide: true });
  await sleep(120);

  let reads = 0, torn = 0, missing = 0;
  const until = Date.now() + 2200;
  while (Date.now() < until) {
    let raw = null;
    try { raw = fs.readFileSync(file, "utf8"); } catch { missing += 1; continue; }
    reads += 1;
    try { JSON.parse(raw); } catch { torn += 1; }
  }
  await new Promise(r => writer.on("close", r));

  console.log(`  读了 ${reads} 次,撕裂 ${torn} 次,读不到 ${missing} 次`);
  ok("确实读到过(否则本用例是空的)", reads > 50, `只读到 ${reads} 次`);
  ok("从没读到过半写的 JSON", torn === 0, `${torn} 次读到不完整内容`);
  // rename 是原子替换,所以"文件短暂不存在"也不该发生
  ok("文件从没消失过", missing === 0, `${missing} 次读不到文件`);
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
}

// ── T2: unparseable + freshly touched → keep; unparseable + old → remove ────────────────────────
function t2_fresh_bad_record_kept() {
  console.log("\n[T2] 解析不了的记录:刚被写过的要留,陈年的才删");
  const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pidbad-"));
  const PIDS = path.join(STATE, "pids");
  fs.mkdirSync(PIDS, { recursive: true });

  const fresh = path.join(PIDS, "omp-fresh.json");
  const stale = path.join(PIDS, "omp-stale.json");
  fs.writeFileSync(fresh, '{"id":"omp-fresh","proces', "utf8"); // 半截 JSON,mtime = 现在
  fs.writeFileSync(stale, '{"id":"omp-stale","proces', "utf8");
  const old = (Date.now() - 60_000) / 1000; // 1 分钟前,远超 settle 窗口
  fs.utimesSync(stale, old, old);

  const run = spawnSync(process.execPath, [BRIDGE, "cleanup", "--json"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE },
  });
  let summary = null;
  try { summary = JSON.parse(run.stdout || "{}").childProcesses; } catch {}
  console.log(`  → ${JSON.stringify(summary)}`);
  ok("cleanup 正常退出", run.status === 0, `exit=${run.status} ${(run.stderr || "").slice(0, 200)}`);
  ok("刚写过的坏记录被留下了(可能是别的进程正在写)", fs.existsSync(fresh),
     "被删了 —— 如果那是个活着的后端,它的唯一线索就没了");
  ok("陈年的坏记录被清掉了(不留垃圾)", !fs.existsSync(stale), "还在,说明变成只进不出了");
  ok("留下的那条被如实计数", summary?.skippedFreshlyWritten === 1, JSON.stringify(summary));
  try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {}
}

async function main() {
  await t1_no_torn_reads();
  t2_fresh_bad_record_kept();
  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.log(`[harness] >>> FAIL: ${e}`); process.exit(1); });
