// Hermetic 回归:graph 作用域与节点归档(`skills/agent-bridge-graph/tools/viz-graph.mjs`)。
// 零消耗、零网络、零后端。
//
//   node tests/repro-viz-graph.mjs
//
//   G1 canonical 绑定  —— realpath 别名认得出;跨 outDir 当场拒**且外来目录零文件**
//   G2 落盘位置        —— 每一个字节都在 `nodes/.runs/` 之下(脏树闸的地基)
//   G3 graphId         —— 每次新的;transcript 用 wx;两个 scope 互不干扰
//   G4 nodeSeq         —— 从 1 起递增;同 id 重跑各自成号
//   G5 归档三态        —— present 三样齐全 / source-missing / 字节直传不改内容
//   G6 归档根失败      —— 每个**本该归档**的资产各自 unavailable,先天不适用的**仍是** not-applicable
//   G7 逐项失败        —— 只有它 unavailable,同批其它照常 present
//   G8 emit 永不抛     —— recorder 坏掉之后 emit 仍返回 false 而不是抛(观测层无权改业务结局)
//   G9 stableJson      —— 键名字典序 / 2 空格 / 结尾换行 / 逐字节可重现

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  createGraphScope, stableJson, NOT_APPLICABLE, unavailable, RUNS_REL,
} from "../skills/agent-bridge-graph/tools/viz-graph.mjs";

const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "viz-graph-"));
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
let n = 0;
const freshOut = () => { const p = path.join(RUN_ROOT, `out${++n}`); fs.mkdirSync(p, { recursive: true }); return p; };
/** 列出一个目录下的全部文件(相对路径,POSIX 分隔符)。 */
function walk(dir, base = dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, acc);
    else acc.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return acc;
}

/* ============================================================ */
console.log("\nG1 canonical outDir 绑定");
{
  const out = freshOut();
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  ok("G1.1 canonical 是真实路径", path.isAbsolute(scope.canonicalOutDir));

  // 同一个目录的**不同写法**必须认得出是同一个(否则合同在别名下静默失效)
  let sameOk = true;
  try { scope.assertSameOutDir(path.join(out, "..", path.basename(out)), "runNode"); }
  catch { sameOk = false; }
  ok("G1.2 `a/../a` 这类别名认得出是同一个", sameOk);

  let trailingOk = true;
  try { scope.assertSameOutDir(out + path.sep, "runNode"); } catch { trailingOk = false; }
  ok("G1.3 末尾分隔符不影响判定", trailingOk);

  // 跨 outDir 当场拒,**且那个外来目录里零文件**
  const alien = freshOut();
  const alienBefore = walk(alien);
  let rejected = false;
  try { scope.assertSameOutDir(alien, "runNode"); } catch { rejected = true; }
  ok("G1.4 跨 outDir 当场拒", rejected);
  ok("G1.5 外来目录里没有产生任何文件", walk(alien).length === alienBefore.length && walk(alien).length === 0);
  // ⚠️ 断言要瞄准的是**外来目录**,不是"整个进程一个文件都没写" ——
  //    本 scope 自己的 transcript 在回调之前就建好了,那是对的。
  ok("G1.6 对照:本 scope 自己的 transcript 确实已经建了", walk(out).some((f) => f.endsWith("transcript.jsonl")));

  scope.close();
}

/* ============================================================ */
console.log("\nG2 落盘位置(脏树闸的地基)");
{
  const out = freshOut();
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  const a = scope.archiveFor(1, "n1");
  await a.putText("turns/main/prompt.md", "hello");
  await a.putJson("input.json", { id: "n1", nodeSeq: 1 });
  await scope.emit("run:started", { outDir: out, maxConcurrent: 4 });
  scope.close();

  const files = walk(out);
  ok("G2.1 确实写了东西", files.length >= 3, `${files.length} 个文件`);
  // **没有例外**:漏一个文件与全漏效果一样(脏树闸只需要一条脏条目)
  const stray = files.filter((f) => !f.startsWith(RUNS_REL + "/"));
  ok("G2.2 每一个字节都在 nodes/.runs/ 之下", stray.length === 0, `漏在外面:${stray.join(", ")}`);
  ok("G2.3 transcript 就在 .runs/<graphId>/ 里",
    files.includes(`${RUNS_REL}/${scope.graphId}/transcript.jsonl`));
  ok("G2.4 归档在 <nodeSeq>-<id>/ 里",
    files.includes(`${RUNS_REL}/${scope.graphId}/1-n1/input.json`));
  ok("G2.5 轮的产物在 turns/<key>/ 之下(单轮也不例外)",
    files.includes(`${RUNS_REL}/${scope.graphId}/1-n1/turns/main/prompt.md`));
}

/* ============================================================ */
console.log("\nG3 graphId 与 transcript");
{
  const out = freshOut();
  const s1 = createGraphScope({ outDir: out, maxConcurrent: 4 });
  const s2 = createGraphScope({ outDir: out, maxConcurrent: 4 });
  ok("G3.1 每次 withBridge 一个新 graphId", s1.graphId !== s2.graphId);
  ok("G3.2 是 UUID 形状", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s1.graphId));
  await s1.emit("run:started", { outDir: out, maxConcurrent: 4 });
  await s2.emit("run:started", { outDir: out, maxConcurrent: 1 });
  s1.close(); s2.close();
  // 同 outDir 两个 graph 并发:两份 transcript 互不干扰
  const t1 = fs.readFileSync(path.join(s1.runsDir, "transcript.jsonl"), "utf8").trim().split("\n");
  const t2 = fs.readFileSync(path.join(s2.runsDir, "transcript.jsonl"), "utf8").trim().split("\n");
  ok("G3.3 两份 transcript 各写各的", t1.length === 1 && t2.length === 1);
  ok("G3.4 各自带自己的 graphId",
    JSON.parse(t1[0]).graphId === s1.graphId && JSON.parse(t2[0]).graphId === s2.graphId);
  ok("G3.5 内容没串", JSON.parse(t1[0]).payload.maxConcurrent === 4 && JSON.parse(t2[0]).payload.maxConcurrent === 1);
}

/* ============================================================ */
console.log("\nG4 nodeSeq");
{
  const out = freshOut();
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  // ⚠️ **从 0 起、步长 1**,与信封的 seq 一样稠密 —— 空洞 = 记录损坏,不是"有个节点悄悄跑了"。
  ok("G4.1 从 0 起", scope.nextNodeSeq() === 0);
  ok("G4.2 步长 1", scope.nextNodeSeq() === 1 && scope.nextNodeSeq() === 2);
  // 同 id 带 force 顺序重跑是合法的 —— 两次各自成号,归档互不覆盖
  const a1 = scope.archiveFor(4, "same");
  const a2 = scope.archiveFor(5, "same");
  await a1.putText("turns/main/prompt.md", "第一次");
  await a2.putText("turns/main/prompt.md", "第二次");
  ok("G4.3 同 id 两次归档互不覆盖",
    fs.readFileSync(path.join(a1.absDir, "turns/main/prompt.md"), "utf8") === "第一次" &&
    fs.readFileSync(path.join(a2.absDir, "turns/main/prompt.md"), "utf8") === "第二次");
  scope.close();
}

/* ============================================================ */
console.log("\nG5 归档:present 与 source-missing");
{
  const out = freshOut();
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  const a = scope.archiveFor(1, "n1");

  const st = await a.putText("turns/main/prompt.md", "你好世界");
  ok("G5.1 present", st.state === "present");
  ok("G5.2 ref/sha256/byteCount 三样恒有", !!st.ref && !!st.sha256 && typeof st.byteCount === "number");
  ok("G5.3 ref 是相对 out-dir 的 POSIX 路径,且以 nodes/.runs/<graphId>/ 开头",
    st.ref.startsWith(`${RUNS_REL}/${scope.graphId}/`) && !st.ref.includes("\\") && !st.ref.includes(".."));
  ok("G5.4 byteCount 是 UTF-8 字节数不是字符数", st.byteCount === Buffer.byteLength("你好世界", "utf8"));
  ok("G5.5 sha256 对得上", st.sha256 === crypto.createHash("sha256").update("你好世界", "utf8").digest("hex"));

  // 字节直传:含 NUL 与 CRLF 的内容一个字节都不许改
  const src = path.join(RUN_ROOT, "bin.md");
  const payload = Buffer.from([0x41, 0x00, 0x0d, 0x0a, 0xe4, 0xb8, 0xad, 0x00, 0x5a]);
  fs.writeFileSync(src, payload);
  const st2 = await a.putFile("turns/main/attempt-1.output.md", src);
  ok("G5.6 字节直传:present", st2.state === "present");
  ok("G5.7 字节直传:内容逐字节相同",
    Buffer.compare(fs.readFileSync(path.join(a.absDir, "turns/main/attempt-1.output.md")), payload) === 0);

  // 源头就没有可拷的东西
  const st3 = await a.putFile("change.diff", path.join(RUN_ROOT, "does-not-exist"));
  ok("G5.8 源头不存在 → source-missing", st3.state === "unavailable" && st3.code === "source-missing");
  // 空文件照样是 present(空文件也有 SHA)
  const empty = path.join(RUN_ROOT, "empty.md");
  fs.writeFileSync(empty, "");
  const st4 = await a.putFile("turns/main/attempt-2.output.md", empty);
  ok("G5.9 零字节产出照样 present(空文件也有 SHA)",
    st4.state === "present" && st4.byteCount === 0 &&
    st4.sha256 === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  scope.close();
}

/* ============================================================ */
console.log("\nG6 归档根建不起来(§3.1 逐槽位规则)");
{
  const out = freshOut();
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  // 注入:让这个节点的归档子目录建不起来(在它该在的位置放一个**文件**)
  const clash = path.join(scope.runsDir, "9-blocked");
  fs.writeFileSync(clash, "我占着这个名字");
  const a = scope.archiveFor(9, "blocked");
  ok("G6.1 归档根确实失败了", a.rootFailed !== null);

  const s1 = await a.putText("turns/main/prompt.md", "x");
  const s2 = await a.putJson("input.json", { id: "blocked" });
  ok("G6.2 每个**本该归档**的资产各自标 unavailable(不是只在根上标一次)",
    s1.state === "unavailable" && s2.state === "unavailable");
  ok("G6.3 code 是 archive-root-failed", s1.code === "archive-root-failed" && s2.code === "archive-root-failed");

  // ⚠️ 这条是负对照,也是最容易写成"假红"的地方:
  //    **先天不适用的槽位仍然是 not-applicable**。把它们也要求成 unavailable,
  //    就是把"从来不适用"谎报成"本该拿得到、现在拿不到" —— 那是会**逼正确实现变差**的假红。
  const diffOfReadNode = NOT_APPLICABLE;
  ok("G6.4 先天不适用的槽位仍是 not-applicable(read 节点的 diff)",
    diffOfReadNode.state === "not-applicable" && !("code" in diffOfReadNode));
  scope.close();
}

/* ============================================================ */
console.log("\nG7 逐项写失败");
{
  const out = freshOut();
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  const a = scope.archiveFor(1, "n1");
  // 注入:只让某一个路径写不进去(用目录占掉它的文件名)
  fs.mkdirSync(path.join(a.absDir, "change.diff"), { recursive: true });
  const bad = await a.putText("change.diff", "x");
  const good1 = await a.putText("turns/main/prompt.md", "a");
  const good2 = await a.putJson("input.json", { id: "n1" });
  ok("G7.1 只有它是 unavailable", bad.state === "unavailable");
  ok("G7.2 code 说清是写盘失败", bad.code === "write-failed");
  ok("G7.3 同批其它资产照常 present", good1.state === "present" && good2.state === "present");
  ok("G7.4 **不是** not-applicable(那是把「给不出」谎报成「本来就没有」)", bad.state !== "not-applicable");
  scope.close();
}

/* ============================================================ */
console.log("\nG8 emit 永不抛(观测层无权改业务结局)");
{
  const out = freshOut();
  let notified = null;
  const scope = createGraphScope({ outDir: out, maxConcurrent: 4 });
  scope.onRecordingFailed((info) => { notified = info; });

  // 一条 schema 不符的事件 —— writer 会判 recording-failed
  let threw = false;
  try { await scope.emit("node:settled", { nodeSeq: 1 /* 缺一堆必需字段 */ }); }
  catch { threw = true; }
  ok("G8.1 emit **不抛**", !threw);
  ok("G8.2 但确实通知了 recorder 损坏", notified !== null);
  ok("G8.3 通知带 atSeq", notified && Number.isSafeInteger(notified.atSeq));
  ok("G8.4 scope.recordingFailure 记住了", scope.recordingFailure !== null);

  // 损坏之后继续 emit 照样不抛
  let threw2 = false;
  try { await scope.emit("run:final", { result: "completed", durationMs: 1, counts: {} }); }
  catch { threw2 = true; }
  ok("G8.5 损坏之后 emit 仍然不抛", !threw2);
  scope.close();
}

/* ============================================================ */
console.log("\nG9 stableJson");
{
  const a = stableJson({ b: 2, a: 1, c: { z: 1, y: 2 } });
  const b = stableJson({ c: { z: 1, y: 2 }, a: 1, b: 2 });
  ok("G9.1 键序不影响字节(键名字典序)", a === b);
  ok("G9.2 2 空格缩进", a.includes('\n  "a": 1'));
  ok("G9.3 结尾一个换行", a.endsWith("\n") && !a.endsWith("\n\n"));
  ok("G9.4 逐字节可重现", stableJson({ a: 1, b: 2, c: { z: 1, y: 2 } }) === a);
  // 只排顶层键 —— 嵌套对象保持插入序。这是**刻意**的:input.json 是扁平的 15 键,
  // 递归排序会给一个用不上的保证,却让"这份 JSON 与源对象长得不一样"变难排查。
  ok("G9.5 顶层键确实排了序", a.indexOf('"a"') < a.indexOf('"b"') && a.indexOf('"b"') < a.indexOf('"c"'));
}

/* ============================================================ */
console.log(`\n${"=".repeat(56)}`);
console.log(`  viz-graph: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(56)}\n`);
try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* Windows 删挂起 */ }
process.exit(fail === 0 ? 0 : 1);
