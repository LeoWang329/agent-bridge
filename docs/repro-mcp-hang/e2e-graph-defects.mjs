// END-TO-END(真后端、真模型、真花钱):agent-bridge-graph 八条缺陷修复里**动了代码**的那四条。
//
//   node docs/repro-mcp-hang/e2e-graph-defects.mjs [--agent claude] [--keep]
//
// 与 hermetic 的 repro-graph-node.mjs(T13)的分工——这一条要想清楚,否则这份文件只是把
// 假后端那 34 条断言用真钱又抄了一遍:
//
//   T13 证的是**机制**:用假后端造出各种边界(连续三次失败、归档号递增、锁不被搬走、
//        改 scope 后指纹变了)。这些用真后端造不出来,也不该用真钱造。
//   这份证的是**假后端造不出来的那三件事**:
//     ①真后端失败时,错文长什么样、`classifyFailure` 会不会**判反方向**
//       (假后端的错文是我自己写的 —— 拿它验判据,等于自己出题自己答);
//     ②`scope` 那段拼出来的文字,**真模型读不读得懂**
//       (T13 只证了字节发出去了,证不了它是不是一段模型看不明白的乱码);
//     ③真失败留下的现场(真的 session.log / answer.txt)能不能被归档搬走。
//
// ⚠️ 覆盖不到、且**永远覆盖不到**的一块:quota / auth / rate_limited 这三档判据。
//    要真造出一条欠费错文,就得真把余额跑到零。这三档只有 T13 用合成错文覆盖,
//    这份 e2e 只能反向保证「**别的**失败不会被误判成它们」—— 见 §2。
//
// ⚠️ 花真 token(但刻意压到最小:提问都是一句话、要一个词的回答)。
//    缺后端时**干净 SKIP(exit 0)**,不是 FAIL。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withBridge, FAILURE_KINDS } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const AGENT = flag("agent", "claude");
const NODE_TIMEOUT_MS = Number(flag("timeout-ms", "600000"));
const KEEP = argv.includes("--keep");

// 这次跑的所有产出都带上它,于是"结果串了没有"可以逐字节验,而不是靠看着像。
const NONCE = `E2E${Math.floor(Math.random() * 1e9).toString(36).toUpperCase()}`;
// 真后端一定认不出来的型号 —— 这是本文件制造**真实失败**的唯一手段。
const BOGUS_MODEL = "definitely-not-a-real-model-xyz-9999";

// 断言条数写死:改了脚本却忘了改这个数,就说明有断言被静默漏掉或重复了。
const EXPECTED_ASSERTIONS = 23;

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`[PASS] ${n}`); } else { fail++; console.log(`[FAIL] ${n}${d ? ` — ${d}` : ""}`); } };

const readArtifact = (r) =>
  r?.artifactPath && fs.existsSync(r.artifactPath) ? fs.readFileSync(r.artifactPath, "utf8") : "";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-e2e-defects-"));
let exitCode = 1;
try {
  // ── 0. 体检 ────────────────────────────────────────────────────────────────
  const doc = await withBridge((b) => b.doctor(), {});
  const docText = doc?._raw || JSON.stringify(doc);
  if (!new RegExp(`${AGENT}:\\s*ok`, "i").test(docText)) {
    console.log(`>>> SKIP: 需要后端 ${AGENT} 可用`);
    process.exit(0);
  }

  // 一个小工作区。scope 那节要引用**真实存在**的文件名,否则模型有理由说"我没看见这些文件"。
  const cwd = path.join(ROOT, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "alpha.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(cwd, "beta.txt"), "beta\n", "utf8");
  const outDir = path.join(ROOT, "run");
  const nodesDir = path.join(outDir, "nodes");
  console.log(`[info] 后端=${AGENT} nonce=${NONCE} 工作区=${cwd}`);

  // ── 1. D4/D8:runAll 在**真**后端失败面前不丢别人的成果 ──────────────────────
  // 关键在于这一次的失败是真的:后端真的被拉起、真的拒绝、错文是它自己吐的。
  console.log("\n[1] runAll:两个真环节 + 一个真失败,一起收口");
  let threw = null;
  let rs = [];
  try {
    rs = await withBridge((b) => b.runAll([
      { id: "good-a", agent: AGENT, cwd, outDir, timeoutMs: NODE_TIMEOUT_MS,
        prompt: `只回答一个词,不要任何解释:把 ${NONCE}A 原样打出来。` },
      { id: "doomed", agent: AGENT, cwd, outDir, timeoutMs: NODE_TIMEOUT_MS,
        // ⚠️ 这句话**故意留着**:它当初正是撞出「判定命中自己说过的话」那个 bug 的原文
        //    (prompt 里的「起不来」被后端回显进 session.log,分类就凭它判了 backend_crash)。
        //    换掉它等于把发现问题的那个探针拆了。
        model: BOGUS_MODEL, prompt: "这一轮预期起不来。" },
      { id: "good-b", agent: AGENT, cwd, outDir, timeoutMs: NODE_TIMEOUT_MS,
        prompt: `只回答一个词,不要任何解释:把 ${NONCE}B 原样打出来。` },
    ]), {});
  } catch (e) { threw = e; }

  ok("★ 中间那个环节真失败了,runAll 也没抛(部分成果不该被一个异常带走)",
    threw === null, `抛了 ${threw?.constructor?.name}: ${threw?.message}`);
  ok("同序等长(下游敢按下标取)", rs.length === 3
    && rs[0]?.id === "good-a" && rs[1]?.id === "doomed" && rs[2]?.id === "good-b",
    rs.map((r) => `${r?.id}:${r?.status}`).join(" "));
  const doomed = rs[1];
  ok("前提:那个环节确实失败了(不然本节是空的)",
    doomed && doomed.status !== "ok", `拿到 ${doomed?.status}`);
  ok("★ 两个好环节照样拿到了结果",
    rs[0]?.status === "ok" && rs[2]?.status === "ok",
    `${rs[0]?.status} / ${rs[2]?.status}`);
  // 结果串没串:各自的 nonce 必须只出现在自己那份产物里。
  const bodyA = readArtifact(rs[0]), bodyB = readArtifact(rs[2]);
  ok("★ 结果没串(各自的暗号只出现在自己那份产物里)",
    bodyA.includes(`${NONCE}A`) && !bodyA.includes(`${NONCE}B`)
      && bodyB.includes(`${NONCE}B`) && !bodyB.includes(`${NONCE}A`),
    `A=${bodyA.slice(0, 60)} | B=${bodyB.slice(0, 60)}`);
  ok("成功环节的产物落了盘、指纹也记了",
    /^[0-9a-f]{64}$/.test(rs[0]?.artifactSha256 || "") && rs[0]?.charCount > 0,
    JSON.stringify({ sha: rs[0]?.artifactSha256?.slice(0, 12), n: rs[0]?.charCount }));

  // ── 2. D2:真错文喂给 classifyFailure,会不会判反方向 ─────────────────────────
  console.log("\n[2] failureKind:拿真后端吐的错文验判据(不是我自己写的合成错文)");
  ok("failureKind 落在封闭枚举里", FAILURE_KINDS.includes(doomed?.failureKind),
    String(doomed?.failureKind));
  ok("failureEvidence 非空(判定要能被人复核,不是一个不容置疑的标签)",
    typeof doomed?.failureEvidence === "string" && doomed.failureEvidence.length > 0,
    String(doomed?.failureEvidence).slice(0, 160));
  // 最贵的误判方向:把一个「换个型号就能跑」的错,判成 quota/auth(=永久放弃,还会去查账单);
  // 或者判成 rate_limited(=傻等着重试一个永远不会好的东西)。真错文必须挡住这一类。
  ok("★ 没有被误判成 quota / auth / rate_limited(型号不对不是这三样)",
    !["quota", "auth", "rate_limited"].includes(doomed?.failureKind),
    `判成了 ${doomed?.failureKind};凭据:${String(doomed?.failureEvidence).slice(0, 200)}`);
  ok("ok 的回执上这两个字段恒为 null(调用方不必写 ?. 也不会把 undefined 当没失败)",
    rs[0]?.failureKind === null && rs[0]?.failureEvidence === null,
    JSON.stringify({ k: rs[0]?.failureKind, e: rs[0]?.failureEvidence }));
  console.log(`[info] 真错文判成了 ${doomed?.failureKind};凭据:${String(doomed?.failureEvidence).slice(0, 200)}`);
  console.log("[info] ⚠️ quota/auth/rate_limited 三档判据本文件覆盖不到(造不出真欠费),只有 T13 用合成错文覆盖。");

  // ── 3. D7:scope 那段文字,真模型读不读得懂 ──────────────────────────────────
  // T13 证的是"字节发出去了"。发出去的要是一段模型看不明白的乱码,那修的就只是个寂寞。
  console.log("\n[3] scope:让真模型复述它被划定的范围");
  const scoped = await withBridge((b) => b.runNode({
    id: "scoped", agent: AGENT, cwd, outDir, timeoutMs: NODE_TIMEOUT_MS,
    prompt: "不要读任何文件、不要动手做事。只根据你收到的这份任务单回答两个问题:"
          + "①你被允许动的文件叫什么名字?②有没有明确禁止你碰的东西,叫什么名字?"
          + "两行答完,每行只写文件名。",
    scope: { include: ["alpha.txt"], outOfBounds: ["beta.txt"] },
  }), {});
  ok("带 scope 的真环节跑通了", scoped.status === "ok", `${scoped.status} ${scoped.error ?? ""}`);
  const stext = readArtifact(scoped);
  ok("★ 真模型复述出了允许范围(说明那段文字它读懂了,不只是被发出去了)",
    /alpha\.txt/.test(stext), stext.slice(0, 300));
  ok("★ 真模型也复述出了禁区",
    /beta\.txt/.test(stext), stext.slice(0, 300));
  // 这里**刻意不再考**"回执里有没有 scope 字段" —— 回执上压根没这个字段,scope 是被拼进
  // 冻结正文的(于是它进 specHash、进归档的输入原件)。「改了 scope 旧回执复用不了」由 T13
  // 用假后端考,不该用真钱再抄一遍。真钱只买上面那两条:**这段文字对真模型是可读的**。

  // ── 4. D3:真失败的现场能不能被完整归档 ─────────────────────────────────────
  // 假后端的"现场"是我造的几个小文件。真失败的现场是后端自己写的 session.log / answer.txt,
  // 可能被句柄占着、可能很大 —— 搬得动搬不动,只有真跑才知道。
  console.log("\n[4] retryFailed:真失败 → 真重试,现场留档、路径契约不变");
  const rid = "retry-me";
  const bad = await withBridge((b) => b.runNode({
    id: rid, agent: AGENT, cwd, outDir, timeoutMs: NODE_TIMEOUT_MS,
    model: BOGUS_MODEL, prompt: `预期失败:${NONCE}FAIL`,
  }), {});
  ok("前提:第一次是真的失败了", bad.status !== "ok", bad.status);
  ok("失败留下了现场目录(后面要考的就是它搬不搬得走)",
    !!bad.scene?.dir && fs.existsSync(bad.scene.dir), String(bad.scene?.dir));

  const good = await withBridge((b) => b.runNode({
    id: rid, agent: AGENT, cwd, outDir, timeoutMs: NODE_TIMEOUT_MS, retryFailed: true,
    prompt: `只回答一个词,不要任何解释:把 ${NONCE}R 原样打出来。`,
  }), {});
  ok("重试这次成功了", good.status === "ok", `${good.status} ${good.error ?? ""}`);
  ok("★ 路径契约没变(下游按 nodes/<id>.md 读,读到的是最新那次)",
    good.artifactPath === path.join(nodesDir, `${rid}.md`)
      && readArtifact(good).includes(`${NONCE}R`),
    good.artifactPath);
  ok("★ 上一次的现场被留成审计原件(f1),没被销毁",
    fs.existsSync(path.join(nodesDir, `${rid}.f1.receipt.json`))
      && fs.existsSync(path.join(nodesDir, `${rid}.f1.scene`)),
    fs.readdirSync(nodesDir).join(", "));
  ok("★ 真后端写的现场文件确实跟着搬过去了(不是搬了个空壳目录)",
    fs.readdirSync(path.join(nodesDir, `${rid}.f1.scene`))
      .some((f) => fs.statSync(path.join(nodesDir, `${rid}.f1.scene`, f)).size > 0),
    fs.readdirSync(path.join(nodesDir, `${rid}.f1.scene`)).join(", "));
  ok("归档的那张回执就是失败那张",
    JSON.parse(fs.readFileSync(path.join(nodesDir, `${rid}.f1.receipt.json`), "utf8")).status === bad.status);
  ok("新回执记了它是重试来的、上次什么结局",
    good.retriedFrom?.n === 1 && good.retriedFrom?.prevStatus === bad.status,
    JSON.stringify(good.retriedFrom));
  ok("锁文件没被当成产物搬走", !fs.existsSync(path.join(nodesDir, `${rid}.f1.lock`)));

  ok(`断言条数与写死的 ${EXPECTED_ASSERTIONS} 一致(改了脚本别忘了改这个数)`,
    pass + fail + 1 === EXPECTED_ASSERTIONS, `实际 ${pass + fail + 1}`);

  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  ok(`夹具自己抛了:${e?.message || e}`, false);
  console.log(e?.stack || "");
} finally {
  if (KEEP) {
    console.log(`\n[keep] 现场留在:${ROOT}`);
    console.log(`[keep] 看完请自行删除:rm -rf "${ROOT}"`);
  } else {
    for (let i = 0; i < 40 && fs.existsSync(ROOT); i++) {
      try { fs.rmSync(ROOT, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 250)); }
    }
  }
  console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} 通过 / ${fail} 失败(真后端 graph-defects e2e)`);
  process.exit(exitCode);
}
