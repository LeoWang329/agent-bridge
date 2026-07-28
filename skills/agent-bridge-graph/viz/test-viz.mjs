/**
 * 页面的零消耗回归:喂 `sample/` 那三份冻结 transcript,断言 **reducer 的 view-model** 与
 * **渲染器产出的 HTML**。不起桥、不起后端、不连网、不开浏览器。
 *
 *   node skills/agent-bridge-graph/viz/test-viz.mjs
 *
 * 它与 `docs/repro-mcp-hang/repro-graph-viz.mjs` 的分工是清楚的:
 *   - repro-graph-viz 证**产生侧**(事件顺序、归档布局、SSE 线格式、/file 四道闸);
 *   - 这一份证**消费侧**(事件流 → 页面上到底写了什么)。
 *
 * ⚠️ 这里的断言刻意做成**判别式**的:很多条都配了负对照 —— 把实现换成那个常见的错误做法,
 *    这条断言必须变红。只断言"渲染出来了"是判别不了的,那种绿灯不值钱。
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { boundPayload } from "../tools/viz-events.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, "sample", "nodes", ".runs");
const PAGE = path.join(HERE, "index.html");

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
/** 负对照:这条**必须**红。真红了才算这条守卫是判别式的。 */
function mustFail(name, cond, detail = "") {
  if (!cond) { pass++; console.log(`  [PASS] 负对照 ${name}(按预期变红)`); }
  else { fail++; console.log(`  [FAIL] 负对照 ${name} —— 换成错误实现之后**居然还是绿的**${detail ? `:${detail}` : ""}`); }
}

/* ============================================================
   0. 把页面脚本装进一个沙箱
   ============================================================ */

const pageSrc = fs.readFileSync(PAGE, "utf8");
const scriptSrc = pageSrc.match(/<script>([\s\S]*?)<\/script>/)[1];

/**
 * 只取到 §8「状态与装配」之前 —— 那之后才开始真的碰 DOM。
 * 前面全是常量、纯函数与静态演示数据的构造,可以在沙箱里原样跑。
 */
function loadPage(mutate = (s) => s) {
  const lines = scriptSrc.split("\n");
  const cut = lines.findIndex((l) => l.includes("8. 状态与装配"));
  if (cut < 0) throw new Error("找不到 §8 边界 —— 页面结构变了,这个测试要跟着改");
  const head = mutate(lines.slice(0, cut - 2).join("\n"));
  const ctx = {
    console,
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
                createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
    location: { protocol: "file:" },
  };
  vm.createContext(ctx);
  vm.runInContext(head + `
;globalThis.__X = { newLiveState, applyEvent, applyControl, buildScene, SCENES,
  factsHTML, statusBlock, attemptsBlock, sceneBlock, curTurn, writeBlock, edgeSvg, assetRow,
  setSC: (v) => { SC = v; }, setATT: (v) => { ATT = v; } };`, ctx);
  return ctx.__X;
}

const X = loadPage();

/** 读一份样例并归约成 scene。`ctl` 是要额外送进去的控制帧。 */
function sceneOf(graphId, ctl = []) {
  const raw = fs.readFileSync(path.join(SAMPLE, graphId, "transcript.jsonl"), "utf8");
  const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const R = X.newLiveState();
  for (const e of lines) X.applyEvent(R, e);
  for (const c of ctl) X.applyControl(R, c);
  R.replay.mode = "live";
  return { R, lines, sc: X.buildScene(R) };
}

/** 渲染一个节点的详情面板(逐块拼)。`turn` 指定看第几轮。 */
function detailOf(sc, seq, turn = 0, Y = X) {
  const n = sc.nodes.find((x) => x.seq === seq);
  if (!n) return "";
  Y.setSC(sc); Y.setATT({ seq, turn, idx: 0, raw: false });
  return Y.factsHTML(n) + Y.statusBlock(n) + Y.attemptsBlock(n) +
         Y.sceneBlock((Y.curTurn(n) || {}).t) + (n.write ? Y.writeBlock(n) : "");
}

/* ============================================================
   1. 样例本身是**合法的事件流**
   ============================================================ */
console.log("\n[S] 冻结样例的自洽性");
{
  for (const graphId of ["gr-sample-main", "gr-sample-cut", "gr-sample-empty"]) {
    const raw = fs.readFileSync(path.join(SAMPLE, graphId, "transcript.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // ★ 用**生产用的那份 schema** 校样例 —— 样例自己长歪了,后面所有断言都在验一个假合同。
    let bad = null;
    for (const l of lines) {
      try { boundPayload(l.event, l.payload); }
      catch (e) { bad = `seq=${l.seq} ${l.event}: ${e.message}`; break; }
    }
    ok(`S ${graphId} 每一条都过生产 schema`, bad === null, bad || "");
    ok(`S ${graphId} seq 从 0 起且稠密`, lines.every((l, i) => l.seq === i));
    ok(`S ${graphId} graphId 一致`, lines.every((l) => l.graphId === graphId));

    // turn ↔ turn-settled 一一对应(含没能开始的那一轮)。
    // ⚠️ 这条**只对有序收场成立**:中断样例里"开了口没闭上的轮"正是它要表达的东西 ——
    //    在那里要求一一对应,等于要求一次强杀先把账做平。
    const ordered = lines.some((l) => l.event === "run:final");
    const turns = new Map();
    for (const l of lines) {
      if (l.event !== "node:turn" && l.event !== "node:turn-settled") continue;
      const k = `${l.payload.nodeSeq}/${l.payload.turnKey}`;
      if (!turns.has(k)) turns.set(k, { o: 0, c: 0 });
      if (l.event === "node:turn") turns.get(k).o++; else turns.get(k).c++;
    }
    if (ordered) {
      ok(`S ${graphId} node:turn 与 node:turn-settled 一一对应`,
        [...turns.values()].every((v) => v.o === 1 && v.c === 1));
    } else if (turns.size) {
      ok(`S ${graphId} 中断样例:有轮开了口没闭上(这正是它要表达的)`,
        [...turns.values()].some((v) => v.o === 1 && v.c === 0));
      ok(`S ${graphId} 但没有"闭了口却没开过"的轮`,
        [...turns.values()].every((v) => v.o >= v.c));
    } else {
      ok(`S ${graphId} 空样例:一条轮事件都没有`, true);
    }
  }
  // 主样例的 run:final 恒等式
  const fin = fs.readFileSync(path.join(SAMPLE, "gr-sample-main", "transcript.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === "run:final");
  const c = fin.payload.counts;
  const sum = c.rejected + c.ok + c.contract_error + c.backend_failed + c.timeout + c.unknown + c.callback_error;
  ok("S 主样例 counts 恒等式 observed === rejected+六档", c.observed === sum, `${c.observed} ≠ ${sum}`);
  ok("S 主样例 reused ⊆ ok", c.reused <= c.ok);
}

/* ============================================================
   2. 归约:三档拓扑 / 状态 / 轮与尝试 / 复用 / 空态
   ============================================================ */
console.log("\n[A] 归约:主样例");
const { sc: A } = sceneOf("gr-sample-main");
{
  ok("A 运行状态 = ended_failed(run:final.result === failed)", A.run.state === "ended_failed", A.run.state);
  ok("A 21 个节点", A.nodes.length === 21, String(A.nodes.length));
  const byId = Object.fromEntries(A.nodes.map((n) => [n.id, n]));

  // ---- 状态各档 ----
  ok("A survey = ok", byId.survey.status === "ok");
  ok("A audit-auth = contract_error", byId["audit-auth"].status === "contract_error");
  ok("A long-scan = timeout", byId["long-scan"].status === "timeout");
  ok("A flaky = backend_failed", byId.flaky.status === "backend_failed");
  ok("A patch-gc = unknown", byId["patch-gc"].status === "unknown");
  ok("A refine-plan = callback_error", byId["refine-plan"].status === "callback_error");
  ok("A dup = rejected", byId.dup.status === "rejected");

  // ---- 复用不许伪装成一次普通的 ok ----
  ok("A audit-flow 是 ok", byId["audit-flow"].status === "ok");
  ok("A ★ audit-flow 带 reused 标记(复用是正交标记,不是第七档 status)", byId["audit-flow"].reused === true);
  ok("A ★ 复用的耗时标成「原执行耗时」而不是本次", byId["audit-flow"].origRun === 2547);
  ok("A ★ 复用节点一条 turn 事件都没有,但**照样有 turns[]**",
    byId["audit-flow"].turns.length === 1 && byId["audit-flow"].turns[0].key === "main");
  ok("A 非复用节点没有 reused 标记", byId.survey.reused === undefined);

  // ---- 轮与尝试 ----
  const rp = byId["refine-plan"];
  ok("A refine-plan 三轮", rp.turns.length === 3, String(rp.turns.length));
  ok("A refine-plan 第 3 轮 = not-started", rp.turns[2].status === "not-started");
  ok("A ★ 第 3 轮没能开始,但**前两轮是权威结局**", rp.turns[0].status === "ok" && rp.turns[1].status === "ok");
  ok("A refine-plan 第 2 轮两次尝试", rp.turns[1].attempts.length === 2);
  ok("A ★ 尝试的 n 在**每轮内**从 1 重开", rp.turns[1].attempts[0].n === 1 && rp.turns[1].attempts[1].n === 2);
  ok("A 第 2 轮第 1 次被打回且带原因", rp.turns[1].attempts[0].verdict === "rejected");
  ok("A ★ 每个节点都有 turns[](不留没有 turn 的旧路径)", A.nodes.every((n) => n.turns.length >= 1));

  // ---- 现场挂在**轮**上,不挂在节点上 ----
  ok("A ★ 同一节点不同轮可以有不同的现场",
    rp.turns[0].scene.session.s === "na" && rp.turns[1].scene.session.s === "have",
    `${rp.turns[0].scene.session.s} / ${rp.turns[1].scene.session.s}`);

  // ---- 拓扑三档 ----
  const dec = A.edges.filter((e) => e.kind === "declared");
  const inf = A.edges.filter((e) => e.kind === "inferred");
  ok("A 有声明边", dec.length > 0, String(dec.length));
  ok("A 有推断边", inf.length > 0, String(inf.length));
  ok("A ★ 同一对节点不同时出现声明边与推断边",
    !inf.some((i) => dec.some((d) => d.a === i.a && d.b === i.b)));
  ok("A ★ 每条推断边都带「为什么推断出这条边」", inf.every((e) => typeof e.why === "string" && e.why.length > 0));
  const warned = A.edges.filter((e) => e.warn);
  ok("A ★ 声明先后与实际执行不符的那条边给了提醒", warned.length >= 1,
    `report(#20) 比 long-scan(#11) 早结束,应有 1 条;实得 ${warned.length}`);
  ok("A 提醒里写明「这条边只是一句声明」", warned.every((e) => /只是一句声明/.test(e.warn)));

  // ---- outcome:三档 + read 节点缺席 ----
  ok("A patch-guard outcome = delivered", byId["patch-guard"].write.outcome === "delivered");
  ok("A patch-retry outcome = no-changes", byId["patch-retry"].write.outcome === "no-changes");
  ok("A patch-gc outcome = unknown", byId["patch-gc"].write.outcome === "unknown");
  ok("A ★ read 节点没有 write 块(按 outcome **缺席**判,不按 access 猜)",
    !byId.survey.write && !byId["audit-auth"].write);
  ok("A ★ 被拒的 write 节点也没有 write 回执块(它连回执都没有)", !byId["wt-fail"].write?.outcome);
}

console.log("\n[A] 空态");
{
  const { sc } = sceneOf("gr-sample-empty");
  ok("A 空态:0 个节点", sc.nodes.length === 0);
  ok("A 空态:0 条边", sc.edges.length === 0);
  ok("A 空态:仍是 running(只开了个头,没结束)", sc.run.state === "running", sc.run.state);
  ok("A 空态:slots 从 run:started 读出来", sc.run.slots === 4);
}

/* ============================================================
   3. 渲染:六种 phase / 三档 outcome / 回执缺失
   ============================================================ */
console.log("\n[B] 渲染:node:rejected 六种 phase");
{
  const PH = [
    ["dup", "lock", /有人在跑|同名|已经存在|正在跑/],
    ["dirty", "preflight", /没有任何东西被创建|自己工作区/],
    ["stale", "reuse-check", /关掉复用|核对上次/],
    ["wt-fail", "workspace-setup", /去下面这个预定位置看一眼|残留/],
    ["bad-turn", "turn-validation", /turn\(\) 是怎么调的/],
    ["empty-talk", "zero-turn", /为什么空转|一次 turn\(\) 都没调/],
  ];
  const htmls = new Map();
  for (const [id, phase, hint] of PH) {
    const n = A.nodes.find((x) => x.id === id);
    ok(`B ${id} phase 是 ${phase}`, n.rejected.kind === phase, n.rejected.kind);
    const h = detailOf(A, n.seq);
    htmls.set(id, h);
    ok(`B ${id} 给出了**这一档专属**的处置提示`, hint.test(h), h.slice(0, 160));
    // ⚠️ 页面里的正文是 esc() 过的,原样 includes 会在带引号的消息上假红。
    const escd = n.rejected.detail.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    ok(`B ${id} 照抄了 error 正文`, h.includes(escd), escd.slice(0, 60));
    ok(`B ${id} 明说没花钱、没有结局不明的任务在后台`, /没有花钱/.test(h));
  }
  // ★ 六段处置提示必须**两两不同** —— 这是"渲染成同一句被拒绝了"那种假绿的唯一判别式。
  const bodies = PH.map(([id]) => htmls.get(id).replace(/[a-f0-9]{8,}/g, ""));
  const uniq = new Set(bodies);
  ok("B ★ 六种 phase 的详情两两不同(不是同一句「被拒绝了」)", uniq.size === 6, `只有 ${uniq.size} 种`);
  // workspace-setup 是**唯一**要给预定路径的那一档
  ok("B ★ 只有 workspace-setup 给了预定位置",
    /预定位置/.test(htmls.get("wt-fail")) &&
    PH.filter(([id]) => id !== "wt-fail").every(([id]) => !/预定位置/.test(htmls.get(id))));
}

console.log("\n[B] 渲染:三档 outcome + 两个易混的边界");
{
  const g = (id) => detailOf(A, A.nodes.find((x) => x.id === id).seq);
  const delivered = g("patch-guard"), noChg = g("patch-retry"), unk = g("patch-gc");
  const netEmpty = g("patch-cfg"), notRemoved = g("patch-tele");

  ok("B delivered 给了 diff 入口", /打开.*diff|完整 diff|diff/.test(delivered));
  ok("B delivered 列出了改动文件", /src\/auth\/session\.ts/.test(delivered));
  // ★ 判据是**没有那个入口**,不是"入口写着不适用" —— 后者仍然是一个可点的东西。
  ok("B ★ no-changes 一个 diff 入口都不给", !/改动详情/.test(noChg), "不该出现「改动详情」这一行");
  ok("B ★ 而且明说为什么不给", /没有改动清单可看，因此这里不给入口/.test(noChg), noChg.slice(0, 200));
  ok("B ★ 措辞是「收尾检查未发现」而不是替 AI 下结论", /收尾检查未发现可交付的改动/.test(noChg));
  ok("B ★ unknown 必须给出工作副本路径", /\.worktrees\\patch-gc/.test(unk));
  ok("B ★ unknown 必须写明禁止自动重跑", /不要自动重跑|禁止.*重跑|别自动重跑|绝不能自动重跑/.test(unk));

  // ★ delivered + filesChanged=[] + committed:**有 HEAD 前进,只是净改动为零**
  ok("B ★ delivered 且零改动文件时,不说「没有改动」",
    !/没有改动|未做任何修改/.test(netEmpty), netEmpty.match(/没有改动|未做任何修改/)?.[0] || "");
  ok("B ★ 它要说清是「净改动为零」而不是「没提交」", /净改动|空/.test(netEmpty));
  // 负对照:如果实现把 netEmpty 当成 no-changes 渲染,上面那条就该红
  mustFail("delivered+零改动 被当成 no-changes",
    /没有可交付的改动/.test(netEmpty));

  /* ★ delivered 但 removed:false。
     ⚠️ 早先的验收清单把它写成"显示未确认清理" —— 那是**读错了** `removed` 的语义:
        node-core 里 removed:false 有两种成因(删除试过了没成功 / 关会话没被确认所以刻意不删),
        **两种都意味着那份副本此刻还在**,不是"不确定在不在"。
        写成"未确认",人就不会去清;写成"还在",人才会去看一眼。 */
  ok("B ★ delivered 但 removed:false → 说这份副本**还在**",
    /收尾时这份副本还在/.test(notRemoved), notRemoved.slice(-400));
  ok("B ★ 而且两种成因都说到", /删除没成功/.test(notRemoved) && /关会话没被确认/.test(notRemoved));
  // 路径里全是反斜杠,用 includes 比正则可靠(`\p` 之类会被当成普通字符,静默匹配错东西)。
  ok("B ★ 给出路径让人去核对", notRemoved.includes(".worktrees\\patch-tele"));
  mustFail("removed:false 被说成「已清理」", /已清理/.test(notRemoved));
}

console.log("\n[B] 渲染:unknown + delivered 的两种成因");
{
  for (const id of ["patch-sse", "patch-wt"]) {
    const n = A.nodes.find((x) => x.id === id);
    const h = detailOf(A, n.seq);
    ok(`B ${id} 状态 unknown 且 outcome delivered`,
      n.status === "unknown" && n.write.outcome === "delivered");
    ok(`B ${id} ★ 照常给出分支`, new RegExp(`agent/${id}`).test(h), h.slice(0, 120));
    ok(`B ${id} ★ 照常给出 diff 入口`, /diff/i.test(h));
    ok(`B ${id} 说清成因(照抄 errorSummary)`, h.includes(n.error.desc.slice(0, 12)));
  }
  const a = detailOf(A, A.nodes.find((x) => x.id === "patch-sse").seq);
  const b = detailOf(A, A.nodes.find((x) => x.id === "patch-wt").seq);
  ok("B ★ 两种成因的正文不同(不是同一句「说不清」)", a !== b);
}

console.log("\n[B] 渲染:回执拿不到时不静默留白");
{
  const n = A.nodes.find((x) => x.id === "no-receipt");
  ok("B no-receipt 状态照常是 ok", n.status === "ok");
  const h = X.assetRow("回执", { s: "unavailable", code: "write-failed" });
  ok("B ★ 回执缺失要**明说原因**,不是空着", /这一项写盘失败|拿不到/.test(h) && /write-failed/.test(h), h);
  ok("B ★ 原因码原样显示", /<code>write-failed<\/code>/.test(h));
}

console.log("\n[B] 渲染:字面量 unknown 与「没见过的 code」文案不同");
{
  const u = X.assetRow("产出", { s: "unavailable", code: "unknown" });
  const w = X.assetRow("产出", { s: "unavailable", code: "some-new-code-2027" });
  ok("B ★ 字面量 unknown 有自己的文案", /已知的未知|连原因都没分辨/.test(u), u);
  ok("B ★ 没见过的 code 走另一句", /不在已知清单里/.test(w));
  ok("B ★ 两者不共用同一句", u.replace(/unknown/g, "") !== w.replace(/some-new-code-2027/g, ""));
}

/* ============================================================
   4. 中断:六种 abandoned 落点,③④互为负对照
   ============================================================ */
console.log("\n[C] 中断:六种 abandoned");
const { sc: C } = sceneOf("gr-sample-cut", [{ kind: "owner-ended" }]);
{
  ok("C 运行状态 = no_finish", C.run.state === "no_finish", C.run.state);
  const byId = Object.fromEntries(C.nodes.map((n) => [n.id, n]));
  ok("C ★ 中断前已收场的节点不受影响(不许整次运行涂成结果不明)",
    byId["done-before-cut"].status === "ok");

  const CASES = [
    ["cut-observed", { stage: "discovered" }, /还没派出去|本地准备中/],
    ["cut-queued", { stage: "queued" }, /一个字都还没发给 AI|在等名额/],
    ["cut-read", { stage: "running" }, /执行结果不明/],
    ["cut-pre", { stage: "running", writePhase: "pre" }, /压根还没开始|不会有工作副本/],
    ["cut-creating", { stage: "running", writePhase: "creating" }, /位置未确认|可能已经开始建/],
    ["cut-created", { stage: "running", writePhase: "created" }, /代码去向都不明/],
  ];
  const H = new Map();
  for (const [id, at, hint] of CASES) {
    const n = byId[id];
    ok(`C ${id} = abandoned`, n.status === "abandoned", n.status);
    ok(`C ${id} 落点 = ${JSON.stringify(at)}`,
      n.abandonedAt.stage === at.stage && (n.abandonedAt.writePhase || undefined) === at.writePhase,
      JSON.stringify(n.abandonedAt));
    const h = detailOf(C, n.seq);
    H.set(id, h);
    ok(`C ${id} 文案对得上落点`, hint.test(h), h.slice(0, 200));
    ok(`C ${id} 说明这不是「结果永远拿不到了」`,
      at.stage === "discovered" || at.stage === "queued" || /缺的只是一份权威的结束回执/.test(h));
  }
  ok("C ★ 只有 created 那一档说「禁止自动重跑」",
    /禁止自动重跑/.test(H.get("cut-created")) &&
    !/禁止自动重跑/.test(H.get("cut-pre")) && !/禁止自动重跑/.test(H.get("cut-creating")));

  // ★ ③④互为负对照:把 pre 的文案换成 creating 的要红,反之亦然
  mustFail("pre 用了 creating 的文案(「可能已经开始建」)", /可能已经开始建/.test(H.get("cut-pre")));
  mustFail("creating 用了 pre 的文案(「不会有工作副本」)", /不会有工作副本/.test(H.get("cut-creating")));
  ok("C ★ pre 一个路径都不给(不能让人去找一个可以证明不存在的目录)",
    !/\.worktrees\\cut-pre/.test(H.get("cut-pre")));
  ok("C ★ creating 给了预定路径", /\.worktrees\\cut-creating/.test(H.get("cut-creating")));

  // 现场:被中断的轮拿不到现场三件套,文案要说「未捕获」,不给死链接
  const cr = byId["cut-read"];
  ok("C ★ 被中断的轮不给可点的现场链接",
    !/<a class="a-open"/.test(X.sceneBlock(cr.turns[0])), "不许给一个点了 404 的入口");
}

/* ============================================================
   5. 记录损坏 ≠ 一堆节点事故
   ============================================================ */
console.log("\n[D] 记录损坏");
{
  const { sc } = sceneOf("gr-sample-cut",
    [{ kind: "recording-failed", atSeq: 12, lastGoodOffset: 4096, error: "ENOSPC: no space left on device" },
     { kind: "owner-ended" }]);
  ok("D 运行状态 = log_broken_ended", sc.run.state === "log_broken_ended", sc.run.state);
  const byId = Object.fromEntries(sc.nodes.map((n) => [n.id, n]));
  ok("D ★ 没有终态的节点标成 unlogged,**不是** abandoned",
    ["cut-observed", "cut-queued", "cut-read", "cut-pre"].every((k) => byId[k].status === "unlogged"),
    JSON.stringify(["cut-observed", "cut-queued", "cut-read"].map((k) => byId[k].status)));
  ok("D ★ 已经收场的节点不被摊派成事故", byId["done-before-cut"].status === "ok");
  ok("D 损坏锚点如实带出", sc.run.brokenAt === 12);
  ok("D 损坏原因照抄", /ENOSPC/.test(sc.run.brokenWhy));
  const h = detailOf(sc, byId["cut-read"].seq);
  ok("D ★ unlogged 的文案要说「它很可能好好跑完了」", /很可能好好地跑完了/.test(h), h.slice(0, 200));
  mustFail("unlogged 被当成 abandoned 渲染", /没有看到这个环节的结局/.test(h));

  // recording-failed 但 **没有** owner-ended → 另一档,文案不共用
  const { sc: s2 } = sceneOf("gr-sample-cut", [{ kind: "recording-failed", atSeq: 12, lastGoodOffset: 1, error: "EIO" }]);
  ok("D 只有 recording-failed 时 = log_broken_unknown", s2.run.state === "log_broken_unknown");

  // 历史读不回来 ≠ 运行被掐断
  const { sc: s3 } = sceneOf("gr-sample-main", [{ kind: "history-read-failure", reason: "第 88 条是坏行" }]);
  ok("D ★ 历史读取失败不改运行状态(出问题的是读历史这一侧)", s3.run.state === "ended_failed", s3.run.state);
  ok("D 历史读取失败要单独出横幅参数", s3.run.replayIncomplete === true);
}

/* ============================================================
   6. 拓扑的负对照:把推断边画成实线,守它的断言必须变红
   ============================================================ */
console.log("\n[E] 拓扑负对照:推断边被当成事实");
{
  const e = { kind: "inferred", why: "x" }, d = { kind: "declared" };
  const gi = X.edgeSvg(e, 0, 0, 0, 100, 100), gd = X.edgeSvg(d, 1, 0, 0, 100, 100);
  ok("E 推断边是虚线", /stroke-dasharray/.test(gi));
  ok("E 声明边是实线", !/stroke-dasharray/.test(gd));
  ok("E 两者的箭头也不同(空心 vs 实心)", /url\(#mi\)/.test(gi) && /url\(#md\)/.test(gd));

  // ★ 把渲染器换成「推断边也画成实线」,上面那两条**必须**变红。
  const Y = loadPage((s) => s.replace(`(inf?' stroke-dasharray="5 5"':'')`, `''`));
  const bi = Y.edgeSvg(e, 0, 0, 0, 100, 100);
  mustFail("推断边仍是虚线", /stroke-dasharray/.test(bi));

  // 同理:把箭头也统一掉
  const Z = loadPage((s) => s.replace(`(inf?'mi':'md')`, `'md'`));
  mustFail("推断边的箭头仍与声明边不同", /url\(#mi\)/.test(Z.edgeSvg(e, 0, 0, 0, 100, 100)));
}

/* ============================================================
   7. 上下文占用:绝对 token,不是百分比
   ============================================================ */
console.log("\n[F] 上下文占用");
{
  const n = C.nodes.find((x) => x.id === "cut-read");
  ok("F ctx 是绝对 token(样例给的是 128000)", n.ctx === 128000, String(n.ctx));
  X.setSC(C); X.setATT({ seq: n.seq, turn: 0, idx: 0, raw: false });
  const h = X.factsHTML(n);
  ok("F ★ 不显示百分比、不显示窗口大小", !/% *<span class="u">of window/.test(h) && !/of window/.test(h), h.slice(0, 400));
  ok("F 显示 token 字样", /token/.test(h));
  const big = { ...n, ctx: 420000 };
  ok("F ≥400k 标出「已过重开线」", /已过重开线/.test(X.factsHTML(big)));
  const mid = { ...n, ctx: 310000 };
  ok("F ≥300k 标出「已过关注线」", /已过关注线/.test(X.factsHTML(mid)));
  const nul = { ...n, ctx: null, engine: "kimi" };
  ok("F ★ null 显示成「未知」而不是 0", /未知/.test(X.factsHTML(nul)) && !/\b0 <span class="u">token/.test(X.factsHTML(nul)));
}

/* ============================================================
   8. 重连去重:同一份事件流喂两遍,计数不许翻倍
   ============================================================ */
console.log("\n[G] 重连回放去重");
{
  const raw = fs.readFileSync(path.join(SAMPLE, "gr-sample-main", "transcript.jsonl"), "utf8");
  const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const R = X.newLiveState();
  const seen = new Set();
  const feed = () => { for (const e of lines) { if (seen.has(e.seq)) continue; seen.add(e.seq); X.applyEvent(R, e); } };
  feed(); feed();                     // 第二遍模拟重连后的完整回放
  R.replay.mode = "live";
  const sc = X.buildScene(R);
  ok("G 节点数没有翻倍", sc.nodes.length === 21, String(sc.nodes.length));
  const rp = sc.nodes.find((n) => n.id === "refine-plan");
  ok("G 轮数没有翻倍", rp.turns.length === 3, String(rp.turns.length));
  ok("G 尝试数没有翻倍", rp.turns[1].attempts.length === 2, String(rp.turns[1].attempts.length));
  ok("G 边数没有翻倍", sc.edges.length === A.edges.length, `${sc.edges.length} vs ${A.edges.length}`);

  // ★ 负对照:去掉去重,尝试数就该翻倍 —— 证明上面那条真的在守着什么
  const R2 = X.newLiveState();
  for (const e of lines) X.applyEvent(R2, e);
  for (const e of lines) X.applyEvent(R2, e);
  R2.replay.mode = "live";
  const rp2 = X.buildScene(R2).nodes.find((n) => n.id === "refine-plan");
  ok("G ★ 归约器本身按 (turnKey, n) 收敛,重复喂也不会多出尝试",
    rp2.turns[1].attempts.length === 2, String(rp2.turns[1].attempts.length));
}

/* ============================================================
   9. 每个节点、每一轮都渲得出来,且没有漏字
   ============================================================ */
console.log("\n[H] 全量渲染扫描");
{
  const BAD = /undefined|NaN|\[object Object\]/;
  let n = 0, bad = [];
  for (const [tag, sc] of [["main", A], ["cut", C]]) {
    for (const nd of sc.nodes) {
      for (let i = 0; i < nd.turns.length; i++) {
        let h;
        try { h = detailOf(sc, nd.seq, i); }
        catch (e) { bad.push(`${tag}#${nd.seq}/${i} 抛了 ${e.message}`); continue; }
        n++;
        if (BAD.test(h)) bad.push(`${tag}#${nd.seq}(${nd.id})/${i} 漏字 ${h.match(BAD)[0]}`);
      }
    }
  }
  ok(`H ${n} 次渲染无异常、无漏字`, bad.length === 0, bad.slice(0, 3).join(" | "));
  // 静态演示场景也过一遍 —— 它们与实况走**同一个渲染器**,坏了会在演示时才发现
  let m = 0;
  for (const sc of X.SCENES) {
    if (sc.key === "live") continue;
    for (const nd of sc.nodes || []) {
      for (let i = 0; i < nd.turns.length; i++) {
        const h = detailOf(sc, nd.seq, i); m++;
        if (BAD.test(h)) bad.push(`demo:${sc.key}#${nd.seq}/${i}`);
      }
    }
  }
  ok(`H 静态演示场景 ${m} 次渲染同样干净`, bad.length === 0, bad.slice(0, 3).join(" | "));
}

console.log(`\n${"=".repeat(56)}`);
console.log(`  test-viz: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(56)}\n`);
process.exit(fail === 0 ? 0 : 1);
