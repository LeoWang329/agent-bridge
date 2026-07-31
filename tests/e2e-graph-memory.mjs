// END-TO-END(真后端、真模型、真花钱):证明 `conversation()` 的**记忆真的在**。
//
//   node tests/e2e-graph-memory.mjs [--agent claude] [--model x] [--keep]
//
// 为什么必须是真后端:假后端**没有记忆**,让它"记住"只能靠夹具作弊 ——
// 那种测试证明的是夹具会配合,不是会话真的带着上文。所以这条只能在这里考。
//
// 实验设计(**关键是让它能失败**):
//
//   正例   一段对话三轮:第 1 轮给口令甲、第 2 轮给口令乙、第 3 轮要它把两个都背出来。
//          要两个而不是一个,是为了排除"只记得上一轮"—— 那不叫会话记忆。
//   阴性对照 同样的第 3 轮问题,换成全新的单轮节点(**同一个 cwd**)再问一遍。
//          它**必须答不出来**。没有这一步,正例通过也可能是口令从别处漏进去了。
//   结构证据 ①整段对话只有**一个** sessionId ②contextUsage.tokens 逐轮**增长**
//          (后端吐用量时才有;cursor / kimi 恒 null,那两家只能靠正例+对照)。
//
// ⚠️⚠️ **阴性对照跑的那一刻,口令不能存在于 agent 读得到的任何地方** —— 这是这条 e2e 的命门。
//
//    第一版栽在这里:我把 outDir 放在 cwd **外面**就以为够不着了。**错的** ——
//    `read` 档带 shell,agent 能读整个文件系统,而第 3 轮的回答(两个口令,25 字节)
//    就明晃晃躺在 `<outDir>/nodes/mem.t-t3.md`。五家里 cursor 是唯一真去翻的,
//    它翻到了、答对了、于是阴性对照 FAIL —— 另外四家的绿是**运气**,不是设计保证。
//
//    正确的做法是**把口令从盘上抹掉再问**:产物先读进内存 → 删掉整个对话 outDir →
//    扫一遍临时根目录与桥的 STATE_ROOT 确认零命中 → 才跑对照。
//    这样对照那一刻,口令只存在于**后端的会话状态**里,别无副本;
//    它要还能答出来,就只剩"后端跨会话串了"这一种解释。
//
//    ⚠️ 别把"删 outDir + 扫零命中"这两步当成啰嗦省掉:省掉它们,这条 e2e 就退回成
//    "看模型爱不爱翻文件",而不是"会话记忆在不在"。
//
// ⚠️ **cursor 的隔离比其余四家弱(实测)**:口令抹到零命中之后,它的全新单轮节点在**同一个 cwd**
//    下照样把两个口令答了出来;换一个 cwd 再问就答不出来 ⇒ 它的跨会话召回按 **workspace 划界**。
//    后果要说清楚:**对 cursor,这条 e2e 证不了"记忆来自会话"** —— 正例的第 3 轮同样可能是
//    从同工作区的历史里捞的。脚本没有把这条"放过",而是把事实钉成断言(见 SESSION_ISOLATION):
//    cursor 哪天修好了隔离,它会当场变红提醒回来改表。
//
// ⚠️ 花真 token。缺后端时**干净 SKIP(exit 0)**,不是 FAIL。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withBridge } from "../skills/agent-bridge-graph/tools/node-core.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const AGENT = flag("agent", "claude");
const MODEL = flag("model", null);
const TURN_TIMEOUT_MS = Number(flag("timeout-ms", "300000"));
const KEEP = argv.includes("--keep");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => {
  if (c) { pass++; console.log(`[PASS] ${n}`); }
  else { fail++; console.log(`[FAIL] ${n}${d ? ` — ${d}` : ""}`); }
};

// 纯小写 hex,不带分隔符 —— 模型最不容易"顺手美化"成别的样子。
const mint = () => crypto.randomBytes(6).toString("hex");
const NONCE_A = mint();
const NONCE_B = mint();

// 各后端的**会话隔离**:一个全新会话,在同一个 cwd 下,拿不拿得到上一段对话的内容。
// ⚠️ 这不是配置项,是**实测记录**。改它之前先跑一遍看事实变了没有。
//   cursor = false 是量出来的:盘上口令已抹到零命中,它的全新单轮节点照样把两个口令答了出来;
//   换一个 cwd 再问就答不出来 ⇒ 它的召回按 **workspace** 划界(见下面 else 分支的两条断言)。
const SESSION_ISOLATION = { omp: true, codex: true, claude: true, kimi: true, cursor: false };

const has = (text, nonce) => typeof text === "string" && text.toLowerCase().includes(nonce);
const readArtifact = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

/** 把一整棵目录读一遍,看口令有没有漏在里面。用于证明 cwd 不是泄漏通道。 */
function grepTree(root, needles) {
  const hits = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let body = "";
      try { body = fs.readFileSync(p, "utf8"); } catch { continue; }
      for (const n of needles) if (body.toLowerCase().includes(n)) hits.push(`${p} 含 ${n}`);
    }
  };
  walk(root);
  return hits;
}

const ASK_BOTH =
  "把我前面让你记的**两个**口令按「甲、乙」的顺序原样写出来,每个一行,只写口令本身。\n" +
  "如果你不知道我在说什么,就只回一句「我不知道」——**绝对不要猜、不要编**。";

// 桥把会话日志 / 现场写在这里。它同样是 agent 读得到的地方,所以扫零命中要连它一起扫。
const STATE_ROOT = process.env.AGENT_BRIDGE_STATE_ROOT
  || path.join(os.homedir(), ".agent-bridge");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-e2e-mem-"));
let exitCode = 1;
try {
  // ── 0. 体检 ────────────────────────────────────────────────────────────────
  const doc = await withBridge((b) => b.doctor(), {});
  const docText = doc?._raw || JSON.stringify(doc);
  if (!new RegExp(`${AGENT}:\\s*ok`, "i").test(docText)) {
    console.log(`>>> SKIP: 后端 ${AGENT} 不可用`);
    process.exit(0);
  }

  // cwd 与 outDir **分开两棵树**,谁也不在谁里面
  const cwd = path.join(ROOT, "workspace");
  const outDir = path.join(ROOT, "out");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  // 放一个诱饵:证明它确实在读盘、但盘上没有口令
  fs.writeFileSync(path.join(cwd, "README.md"), "这是一个空工作区,用于记忆 e2e。\n", "utf8");

  console.log(`[info] 后端=${AGENT}${MODEL ? ` 模型=${MODEL}` : ""} 口令 甲=${NONCE_A} 乙=${NONCE_B}`);
  console.log(`[info] cwd=${cwd}\n[info] outDir=${outDir}`);

  const base = { agent: AGENT, cwd, access: "read", ...(MODEL ? { model: MODEL } : {}) };

  // ── 1. 正例:一段对话,三轮 ─────────────────────────────────────────────────
  const answers = {};
  const rec = await withBridge((b) => b.conversation(
    { id: "mem", ...base, outDir },
    async (turn) => {
      const t1 = await turn({
        key: "t1", timeoutMs: TURN_TIMEOUT_MS,
        prompt: `记住口令甲:${NONCE_A}\n只回「收到」两个字,别的什么都不要说。`,
      });
      answers.t1 = readArtifact(t1.artifactPath);

      const t2 = await turn({
        key: "t2", timeoutMs: TURN_TIMEOUT_MS,
        prompt: `记住口令乙:${NONCE_B}\n同样只回「收到」两个字。`,
      });
      answers.t2 = readArtifact(t2.artifactPath);

      const t3 = await turn({ key: "t3", timeoutMs: TURN_TIMEOUT_MS, prompt: ASK_BOTH });
      answers.t3 = readArtifact(t3.artifactPath);
    },
  ), {});

  ok("对话 status=ok", rec.status === "ok", `${rec.status} ${rec.error ?? ""}`);
  ok("三轮都在回执里", rec.turns?.length === 3, JSON.stringify(rec.turns?.map((t) => t.key)));
  ok("每一轮自己也是 ok", (rec.turns || []).every((t) => t.status === "ok"),
    JSON.stringify(rec.turns?.map((t) => [t.key, t.status])));

  // ★★ 真正的验收:第 3 轮必须把两个口令都背出来 ★★
  ok(`★★ 第 3 轮记得口令甲(${NONCE_A})`, has(answers.t3, NONCE_A), answers.t3?.slice(0, 300));
  ok(`★★ 第 3 轮记得口令乙(${NONCE_B})`, has(answers.t3, NONCE_B), answers.t3?.slice(0, 300));
  // 只记得上一轮不算会话记忆 —— 甲是**两轮之前**给的,所以上面第一条才是关键
  ok("★ 第 3 轮没说「我不知道」", !/我不知道/.test(answers.t3 || ""), answers.t3?.slice(0, 200));

  // ── 2. 结构证据:一个对话 = 一个会话 ───────────────────────────────────────
  ok("★ 整段对话只落了一个 sessionId", typeof rec.sessionId === "string" && rec.sessionId.length > 0,
    String(rec.sessionId));

  // contextUsage 逐轮增长 = 同一个会话在累积上文。cursor / kimi 恒 null,那两家跳过。
  const toks = (rec.turns || []).map((t) => t.contextUsage?.tokens ?? null);
  if (toks.every((v) => typeof v === "number")) {
    ok("★ contextUsage.tokens 逐轮增长(同一会话在累积上文)",
      toks[0] < toks[1] && toks[1] < toks[2], JSON.stringify(toks));
  } else {
    console.log(`[info] ${AGENT} 不吐 contextUsage(${JSON.stringify(toks)})—— 跳过这条结构证据,`
      + `只靠正例 + 阴性对照`);
  }

  // ── 3. 抹掉盘上的口令,再证明确实抹干净了 ─────────────────────────────────
  // ⚠️ 这一步不是打扫卫生,是**实验成立的前提**:第 3 轮的回答里就有两个口令,
  //    它躺在 outDir 里,而 `read` 档带 shell —— agent 读得到。不抹掉就跑对照,
  //    考的是"模型爱不爱翻文件",不是"会话记忆在不在"。
  ok("(前提)第 3 轮的产物确实写了口令,所以它必须被抹掉",
    has(readArtifact(rec.turns?.find((t) => t.key === "t3")?.artifactPath), NONCE_A)
    || answers.t3.includes(NONCE_A), "产物已读进内存");
  fs.rmSync(outDir, { recursive: true, force: true });

  const onDisk = [
    ...grepTree(ROOT, [NONCE_A, NONCE_B]),                       // 我们自己的临时树
    ...grepTree(STATE_ROOT, [NONCE_A, NONCE_B]),                 // 桥的日志 / 现场
  ];
  ok("★★ 对照开跑前,口令在盘上零命中(只剩后端会话里那一份)",
    onDisk.length === 0, onDisk.join(" / ").slice(0, 400));

  // ── 4. 阴性对照:全新单轮,同一个 cwd,同一个问题 ───────────────────────────
  // 到这里口令**只存在于后端的会话状态**。它要还能答出来,就只剩"后端跨会话串了"这一种解释。
  const outDir2 = path.join(ROOT, "out-control");
  fs.mkdirSync(outDir2, { recursive: true });
  const fresh = await withBridge((b) => b.runNode({
    id: "no-memory", ...base, outDir: outDir2, timeoutMs: TURN_TIMEOUT_MS, prompt: ASK_BOTH,
  }), {});
  const freshText = readArtifact(fresh.artifactPath);

  ok("阴性对照跑通了", fresh.status === "ok", `${fresh.status} ${fresh.error ?? ""}`);

  // 观察到的事实:全新会话在**同一个 cwd** 下,拿不拿得到上一段对话的内容。
  const recalled = has(freshText, NONCE_A) || has(freshText, NONCE_B);
  const expectIsolated = SESSION_ISOLATION[AGENT];

  if (expectIsolated) {
    ok("★★ 阴性对照答不出口令甲(说明上面不是漏出来的)", !has(freshText, NONCE_A), freshText?.slice(0, 300));
    ok("★★ 阴性对照答不出口令乙", !has(freshText, NONCE_B), freshText?.slice(0, 300));
  } else {
    // ⚠️ **不是"允许它失败"**,是把已知事实钉成断言:cursor 一旦哪天修好了会话隔离,
    //    这条会当场变红提醒我们回来把表和结论一起改 —— 而不是继续躺在"已知例外"里。
    ok(`★★ [已知] ${AGENT} 同一 cwd 下新会话**能**召回上一段对话(隔离比其余四家弱)`,
      recalled, `没召回 —— 隔离行为变了,回来改 SESSION_ISOLATION 表`);
    console.log(
      `\n⚠️ ${AGENT} 的会话隔离弱于其余四家:同一个 cwd 下,一个全新会话也能拿到上一段对话的内容。\n`
      + `   后果:**对 ${AGENT} 而言,这条 e2e 证不了"记忆来自会话"** —— 正例的第 3 轮\n`
      + `   同样可能是从同工作区历史里捞的。下面用「换个 cwd」把召回的边界钉住。\n`);

    // 换一个从没跑过本次对话的 cwd,同样的问题 —— 必须答不出来。
    // 这条把 "${AGENT} 什么都记得" 与 "按工作区划界" 区分开,不是走过场。
    const cwdFar = path.join(ROOT, "elsewhere");
    const outFar = path.join(ROOT, "out-elsewhere");
    fs.mkdirSync(cwdFar, { recursive: true });
    fs.mkdirSync(outFar, { recursive: true });
    const far = await withBridge((b) => b.runNode({
      id: "no-memory-far", agent: AGENT, cwd: cwdFar, outDir: outFar, access: "read",
      ...(MODEL ? { model: MODEL } : {}), timeoutMs: TURN_TIMEOUT_MS, prompt: ASK_BOTH,
    }), {});
    const farText = readArtifact(far.artifactPath);
    ok(`★★ 换个 cwd 就召回不到了(证明 ${AGENT} 的召回按 workspace 划界,不是全账户)`,
      !has(farText, NONCE_A) && !has(farText, NONCE_B), farText?.slice(0, 300));
  }

  console.log(`\n[t3 答案]\n${(answers.t3 || "").trim().slice(0, 400)}`);
  console.log(`\n[对照答案]\n${(freshText || "").trim().slice(0, 300)}`);

  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.log(`[FAIL] 脚本自己炸了 — ${e?.stack || e}`);
  fail++;
} finally {
  if (KEEP) console.log(`\n[keep] 现场留在 ${ROOT}`);
  else { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
}
