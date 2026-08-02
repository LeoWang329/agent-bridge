/**
 * 页面的零消耗回归:喂 `sample/` 那三份冻结 transcript,断言 **reducer 的 view-model** 与
 * **渲染器产出的 HTML**。不起桥、不起后端、不连网、不开浏览器。
 *
 *   node tests/test-viz-graph.mjs
 *
 * 它与 `tests/repro-graph-viz.mjs` 的分工是清楚的:
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
import { boundPayload } from "../skills/agent-bridge-graph/tools/viz-events.mjs";
import { checkInvariants } from "./contract-invariants-graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const VIZ = path.join(REPO, "skills", "agent-bridge-graph", "viz");
const SAMPLE_ROOT = path.join(VIZ, "sample");
const SAMPLE = path.join(SAMPLE_ROOT, "nodes", ".runs");
const PAGE = path.join(VIZ, "index.html");

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
  factsHTML, statusBlock, attemptsBlock, sceneBlock, curTurn, writeBlock, edgeSvg, assetRow, filesBlock, esc,
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
  return Y.factsHTML(n) + Y.statusBlock(n) + Y.filesBlock(n) + Y.attemptsBlock(n) +
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
  const mainLines = fs.readFileSync(path.join(SAMPLE, "gr-sample-main", "transcript.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fin = mainLines.find((l) => l.event === "run:final");
  const c = fin.payload.counts;
  const sum = c.rejected + c.ok + c.contract_error + c.backend_failed + c.timeout + c.unknown + c.callback_error;
  ok("S 主样例 counts 恒等式 observed === rejected+六档", c.observed === sum, `${c.observed} ≠ ${sum}`);
  ok("S 主样例 reused ⊆ ok", c.reused <= c.ok);

  // ⚠️ **光有上面那条恒等式不够,它只验总和。**
  //    实测:样例里手写的 counts 写着「ok 10、unknown 1」,而它自己发的 21 条节点事件
  //    数出来是「ok 8、unknown 3」—— 两个 `unknown` 的环节被记成了完成。
  //    一档多 2、另一档少 2,**和还是 21**,恒等式全程绿灯。
  //    所以必须逐档跟事件对账:counts 是汇总,节点事件是原始记录,汇总不许自说自话。
  {
    const actual = { observed: 0, rejected: 0, ok: 0, contract_error: 0,
                     backend_failed: 0, timeout: 0, unknown: 0, callback_error: 0, reused: 0 };
    for (const { event, payload } of mainLines) {
      if (event === "node:observed") actual.observed += 1;
      else if (event === "node:rejected") actual.rejected += 1;
      else if (event === "node:settled") {
        // 用封闭集判,不用 `in` —— observed/rejected/reused 也是键,同名 status 会加错桶。
        if (!["ok", "contract_error", "backend_failed", "timeout", "unknown", "callback_error"]
              .includes(payload.status)) { actual[`未知档:${payload.status}`] = 1; continue; }
        actual[payload.status] += 1;
        if (payload.execution === "reused") actual.reused += 1;
      }
    }
    const diff = Object.keys(actual).filter((k) => actual[k] !== c[k])
      .map((k) => `${k}: 汇总说 ${c[k]}、事件里是 ${actual[k]}`);
    ok("S ★★ 主样例 counts **逐档**与节点事件对得上(只验总和的话,一增一减照样绿)",
      diff.length === 0, diff.join(" ; "));
  }
}

console.log("\n[I] 合同不变式(§1.3 / §3.1 / §5.8)");
{
  for (const graphId of ["gr-sample-main", "gr-sample-cut"]) {
    const lines = fs.readFileSync(path.join(SAMPLE, graphId, "transcript.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const tag = graphId === "gr-sample-main" ? "主" : "中断";
    for (const r of checkInvariants(lines, { archiveRoot: SAMPLE_ROOT })) {
      if (r.weak) continue;                       // 覆盖度提示,不是断言
      ok(`I ${tag} ★ ${r.name}`, r.ok, r.detail);
    }
  }
  /* 覆盖度:④ 那条断言只有在**两条路都真的被走到**时才有意义 ——
     样例要是全是"回执正常",它就永远不会被触发,绿灯是空转出来的。 */
  {
    const lines = fs.readFileSync(path.join(SAMPLE, "gr-sample-main", "transcript.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ss = lines.filter((l) => l.event === "node:settled").map((l) => l.payload);
    ok("I 主 ★ 样例同时覆盖「回执正常」与「回执缺席+内联兜底」两条路",
      ss.some((x) => x.receipt.state === "present") && ss.some((x) => x.workspaceSummary),
      "两条路没都走到");
  }
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
  /* ⚠️ 这里**曾经**断言"页面列出了 src/auth/session.ts" —— 而事件流里**根本没有改动清单**
        (§5.8 刻意不带:清单无上限)。那条绿灯当时之所以是绿的,只因为样例也是照着同一个
        错误实现造的。**同源的绿灯不值钱。** 现在断言的是合同真给得出的东西:
        说清清单在哪,而且**不许**把"拿不到清单"渲染成"零项"(那是一句凭空造出来的结论)。 */
  ok("B ★ delivered 说清改动清单在哪(事件里不带清单)", /改动清单/.test(delivered) && /回执/.test(delivered));
  mustFail("拿不到清单被渲染成「零项」", /零项/.test(delivered));
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
  /* ★ 判据本身:`netEmpty` 只能来自 **diff 自己是零字节**。
     ⚠️ 换成 `changesKnown === true` 这条就该红 —— 样例里另有一个 changesKnown:true
        且**改了东西**的交付节点,那时它会跟着被判成"净改动为零"。 */
  {
    const empt = A.nodes.find((x) => x.write && x.write.netEmpty === true);
    const busy = A.nodes.find((x) => x.write && x.write.outcome === 'delivered'
      && x.write.changesKnown === true && x.write.netEmpty !== true);
    ok("B ★ netEmpty 的那个节点,diff 确实是零字节",
      !!empt && empt.write.diff && empt.write.diff.s === 'have' && empt.write.diff.byteCount === 0,
      JSON.stringify(empt?.write?.diff));
    ok("B ★ 另有一个 changesKnown:true 却**不是**零改动的交付节点(否则这条考不出东西)",
      !!busy, "样例里缺一个反例节点");
    mustFail("changesKnown:true 就被判成净改动为零", !!busy && busy.write.netEmpty === true);
  }

  /* ★ delivered 但 removed:false。
     ⚠️ 这一组断言**曾经反过来**:它要求页面说"这份副本**还在**"。那是从 node-core 的源码
        倒推出来的,而合同(docs/EVENTS-graph.md §5.8)早就把 `removed:false` 定死为
        「**收尾时没有确认清理**」—— 可能没删、也可能删了但没确认,**推不出目录现在还在磁盘上**。
        说"还在",会让人去核对一个可能不存在的目录、扑一次空;说"未确认",人才既知道去看一眼,
        也知道看不到并不代表出了错。⚠️ 这就是"照着实现写断言"的典型代价:
        断言把一个**读错的语义**焊死,后面每一次改对都会被它判红。 */
  ok("B ★ removed:false → 「收尾时未确认清理」(不是「还在」)",
    /收尾时未确认清理/.test(notRemoved), notRemoved.slice(-400));
  ok("B ★ 而且明说这是当时的快照、推不出现在",
    /不是现在的事实|现在可能已经/.test(notRemoved));
  mustFail("removed:false 被说成「这份副本还在」", /这份副本还在|副本仍在/.test(notRemoved));
  /* `changesKnown` 回答的是「**这棵树的改动状况探到了没有**」。
     ⚠️ **这一条断言原来是错的**:它写着 "changesKnown:true 说的是「确认过没有改动」",
        把「测出来了」当成了「测出来是零」。而生产者只要 git 探测正常返回就置 true
        (node-core `out.changesKnown = true`)——**改了一大堆文件的节点同样是 true**。
        于是页面对着一个正常交付的 write 节点斩钉截铁地写"已交付,但这次提交没有净改动",
        而这条断言把那句假话冻成了正确预期:**一次确定的假绿**。
     ⚠️ 判"净改动为零"要用 diff 自己的字节数(见下面那条),不是这个键。 */
  ok("B ★ changesKnown:false 说的是「没能确认」", /没能确认/.test(notRemoved));
  ok("B ★ changesKnown:true 只说「探到了改动状况」,不说有没有改动",
    /探到了/.test(netEmpty) && !/确认过：这次<b>没有<\/b>净改动|确认过.{0,6}没有.{0,4}净改动/.test(netEmpty),
    netEmpty.match(/改动清单[^<]*(<[^>]*>[^<]*)*/)?.[0]?.slice(0, 160) || "");
  mustFail("changesKnown:true 被读成「确知零改动」",
    /确认过：这次<b>没有<\/b>净改动/.test(netEmpty));
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
/* ⚠️ 送进去的是 **`owner-lost`**,不是 `owner-final`。这两者是 §10.1 里**不同的两档**:
      前者是"记录到此为止、结局不明",后者是"拥有者说它正常结束了"。
      早先这里送的是一个连合同里都不存在的 `owner-ended` —— 归约器认不出、当场退回
      "还在跑",于是整组中断断言测的是一条**根本没发生的中断**。 */
const { sc: C } = sceneOf("gr-sample-cut", [{ kind: "owner-lost" }]);
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

/** 取运行级横幅上那句话 —— 用来证明两档"看起来都像坏了"的状态**说的不是同一件事**。 */
const detailRunCopy = (sc) => JSON.stringify({ s: sc.run.state, at: sc.run.brokenAt, why: sc.run.brokenWhy });

/* ============================================================
   5. 记录损坏 ≠ 一堆节点事故
   ============================================================ */
console.log("\n[D] 记录损坏");
{
  /* §10.1 的四档是**有序**的,这里测的是第 ② 档:记录坏了,**但拥有者明确说它正常结束了**。
     ⚠️ 送 `owner-final`,不是 `owner-lost` —— 后者是第 ③ 档(记录坏了、拥有者也没了),
        两档的处置完全不同:一个能说"跑完了,只是账没记全",另一个连跑没跑完都不知道。 */
  const { sc } = sceneOf("gr-sample-cut",
    [{ kind: "recording-failed", atSeq: 12, lastGoodOffset: 4096, error: "ENOSPC: no space left on device" },
     { kind: "owner-final" }]);
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

  /* 第 ③ 档:记录坏了,**而且**拥有者也没了(管道到了 EOF 却没等到 run:final)。 */
  const { sc: s2 } = sceneOf("gr-sample-cut",
    [{ kind: "recording-failed", atSeq: 12, lastGoodOffset: 1, error: "EIO" }, { kind: "owner-lost" }]);
  ok("D 记录坏了 + 拥有者也没了 = log_broken_unknown", s2.run.state === "log_broken_unknown", s2.run.state);
  ok("D ★ 第 ②③ 档不共用同一句", detailRunCopy(sc) !== detailRunCopy(s2));

  /* ⚠️ **只有 recording-failed、管道还开着** —— 那它就**还在跑**。
        记录坏了不等于运行停了:写不进日志的进程照样在干活。把这一档说成"结束了",
        是拿"我看不见了"当"它没了"。 */
  const { sc: s2b } = sceneOf("gr-sample-cut", [{ kind: "recording-failed", atSeq: 12, lastGoodOffset: 1, error: "EIO" }]);
  ok("D ★ 记录坏了但管道还开着 = 仍在跑(不许当成结束)", s2b.run.state === "running", s2b.run.state);

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

  /**
   * ⚠️ **先把"是我们自己喂进去的正文"减掉,再找漏字。**
   *
   * 直接在整段 HTML 上搜 `undefined` 是**判别不了**的:一条真实的报错正文就长这样 ——
   * `TypeError: Cannot read properties of undefined (reading 'sections')`。
   * 那个 `undefined` 是**内容**,不是漏字;为它把断言删掉是放弃守卫,
   * 为它把样例里的报错改掉更糟 —— 真跑那天照样会有这种报错,守卫又会误报,
   * 然后就会有人第二次把它删掉。
   *
   * 判据要落在**渲染器有没有凭空产生**这几个词上:把 view-model 里所有字符串叶子
   * 从 HTML 里减掉,剩下的都是模板自己拼的。模板里再出现 `undefined`,那才是漏字。
   */
  const inputStrings = (v, out = []) => {
    if (typeof v === "string") { if (v.length >= 3) out.push(v); return out; }
    if (v && typeof v === "object") for (const k of Object.keys(v)) inputStrings(v[k], out);
    return out;
  };
  const esc = X.esc;
  const chromeOnly = (h, nd) => {
    let t = h;
    // 长的先减,否则短串会把长串切碎、留下拼接出来的假阳性
    for (const raw of inputStrings(nd).sort((x, y) => y.length - x.length)) {
      /* ⚠️ **一个正好等于漏字本身的输入,不许当掩码。**
            比如某个节点的 id 恰好就是字符串 `"undefined"` —— 拿它当掩码会把页面上
            **真正的**那处 `<p>undefined</p>` 一起抹掉,守卫从此永远绿。
            宁可为这种病态输入误报一次,也不能为它放过一次真漏字:
            **误报会被看见并查清,漏报不会。** */
      /* 判据是**精确等于**某个漏字 token,不是"含有它而且够短" ——
         后者会把 `foo-undefined` 这种**合法内容**排除在掩码之外,于是它自己里面的
         `undefined` 被当成模板泄漏报出来:一次误报。 */
      if (["undefined", "NaN", "[object Object]"].includes(raw.trim())) continue;
      for (const form of [raw, esc(raw)]) {
        if (!form) continue;
        let i;
        while ((i = t.indexOf(form)) >= 0) t = t.slice(0, i) + "\u0001" + t.slice(i + form.length);
      }
    }
    return t;
  };

  let n = 0, bad = [];
  for (const [tag, sc] of [["main", A], ["cut", C]]) {
    for (const nd of sc.nodes) {
      for (let i = 0; i < nd.turns.length; i++) {
        let h;
        try { h = detailOf(sc, nd.seq, i); }
        catch (e) { bad.push(`${tag}#${nd.seq}/${i} 抛了 ${e.message}`); continue; }
        n++;
        const c = chromeOnly(h, nd);
        if (BAD.test(c)) bad.push(`${tag}#${nd.seq}(${nd.id})/${i} 漏字 ${c.match(BAD)[0]}`);
      }
    }
  }
  ok(`H ${n} 次渲染无异常、无漏字`, bad.length === 0, bad.slice(0, 3).join(" | "));

  // ★ 负对照:守卫必须**真的**抓得住漏字 —— 往 view-model 里塞一个渲染器读不到的字段,
  //   让某一处模板拼出 `undefined`,这条就该红。
  {
    const broken = JSON.parse(JSON.stringify(A.nodes.find((x) => x.id === "survey")));
    delete broken.t;                      // factsHTML 会去读 t.r —— 少了它就会拼出漏字
    let threwOrLeaked = false;
    try {
      X.setSC(A); X.setATT({ seq: broken.seq, turn: 0, idx: 0, raw: false });
      threwOrLeaked = BAD.test(chromeOnly(X.factsHTML(broken), broken));
    } catch (e) { threwOrLeaked = true; }
    ok("H ★ 负对照:view-model 缺字段时守卫抓得住(不是恒绿)", threwOrLeaked);
  }

  // 静态演示场景也过一遍 —— 它们与实况走**同一个渲染器**,坏了会在演示时才发现
  let m = 0;
  for (const sc of X.SCENES) {
    if (sc.key === "live") continue;
    for (const nd of sc.nodes || []) {
      for (let i = 0; i < nd.turns.length; i++) {
        const h = detailOf(sc, nd.seq, i); m++;
        if (BAD.test(chromeOnly(h, nd))) bad.push(`demo:${sc.key}#${nd.seq}/${i}`);
      }
    }
  }
  ok(`H 静态演示场景 ${m} 次渲染同样干净`, bad.length === 0, bad.slice(0, 3).join(" | "));
}

/* ============================================================
   9.5 这一轮修出来的东西,各自留一条判别式断言
   ============================================================ */
console.log("\n[J] 复用 / 现场键名 / 推断边并集 / 连不上的依赖 / 节点级资产");
{
  const byId = Object.fromEntries(A.nodes.map((n) => [n.id, n]));

  /* ① 复用节点:一条 turn 事件都不发,轮只存在于 node:settled.turns[] 里。
        ⚠️ 只按实时事件建轮的实现,会给它补一条"main / queued / 0 次尝试 / 没联系过 AI" ——
           而回执上白纸黑字写着 ok、七千多字。**页面直接和回执打架**,却长得像一次正常排队。 */
  {
    const r = byId["audit-flow"];
    ok("J ★ 复用节点的轮来自回执摘要(不是补一条空的 main)",
      r.turns.length === 1 && r.turns[0].status === "ok" && r.turns[0].attempts.length === 1,
      JSON.stringify(r.turns.map((t) => [t.key, t.status, t.attempts.length])));
    mustFail("复用节点被补成 queued / 零尝试",
      r.turns[0].status === "queued" || r.turns[0].attempts.length === 0);
    ok("J ★ 复用节点的现场说的是「没真跑,所以没有现场」",
      r.turns[0].scene.session.s === "na" && /复用/.test(r.turns[0].scene.session.why || ""),
      JSON.stringify(r.turns[0].scene.session));
    // 复用命中时 turns[].inferredDeps 是**唯一**一份推断依赖 —— 少了它整段对话的推断边全没
    ok("J ★ 复用节点的推断边没丢", A.edges.some((e) => e.b === r.seq && e.a === byId.survey.seq));

    /* ★ 复用 + **打回重说过**的那一轮:产出要挂在**真正产生它的那一次**名下。
       ⚠️ 无条件塞给 attempt 1 的实现会让页面在**被打回的那次**下面挂出最终正确答案,
          而 accepted 那次显示"拿不到"。两条信息都错,还互相印证。
       样例里的复用节点只有一次尝试(加一个会改 counts),所以这里现造最小事件流。

       ⚠️ **这里有两种真实形状,不是一种** —— 早先这一段只写了 B 那种,于是把
          「被打回那次只剩指纹」当成了复用的**常态**,反而给错误实现发了通行证:
          A. 旧回执逐次记了 artifactPath(v2 起的常态)⇒ 两次**各是各的字节**,都 present;
          B. 某一次**没有**逐次原件 ⇒ 才是 fingerprint-only。
             ⚠️ **成因别写成"老回执 / 当初没开 viz"** —— v1 的回执在复用闸上直接被拒(版本严格等值),
                而 v2 的逐次原件与 viz 开关**无关**(`attemptArtifactPathFor` 恒写)。
                真正会落到这一格的是**当时那次复制失败**。形状是真的,理由曾经写错。
          真正跨越生产者与页面的门禁在 repro-graph-viz 的 [V6b](真跑一次 reask 再复用)。 */
    const reuseStream = (id, attOut) => {
      const R5 = X.newLiveState();
      const ev = (seq, event, payload) => X.applyEvent(R5, { v: 1, seq, ts: 1e12 + seq, graphId: "g", event, payload });
      const NA = { state: "not-applicable" };
      ev(0, "run:started", { outDir: "C:\\w", maxConcurrent: 1 });
      ev(1, "node:observed", { nodeSeq: 0, id, agent: "omp", access: "read", cwd: "C:\\w",
        model: null, effort: null, spec: NA, prompt: NA, role: NA,
        declaredDeps: [], inferredDeps: [], inferredDepsTruncated: false });
      ev(2, "node:settled", { nodeSeq: 0, status: "ok", execution: "reused", durationMs: 5,
        receipt: NA, artifact: attOut(2), diff: NA,
        turns: [{ key: "main", status: "ok", sessionReusable: true,
          output: attOut(2), turnSpecHash: "a".repeat(32), charCount: 9, durationMs: 5,
          inferredDeps: [], inferredDepsTruncated: false,
          attempts: [
            { n: 1, status: "rejected", inputSha256: "b".repeat(64), input: NA,
              output: attOut(1), rejectedReason: "第一次不合格" },
            { n: 2, status: "accepted", inputSha256: "c".repeat(64), input: NA,
              output: attOut(2) }] }] });
      R5.replay.mode = "live";
      return X.buildScene(R5).nodes[0].turns[0];
    };

    /* A —— 常态:两次尝试各留下一份原件(生产者 emitReusedSettled 逐次归档)。 */
    {
      const asset = (n) => ({ state: "present",
        ref: `nodes/.runs/g/0-again/turns/main/attempt-${n}.output.md`,
        sha256: String(n).repeat(64), byteCount: 12 });
      const t5 = reuseStream("again", asset);
      ok("J ★ 复用节点两次尝试都在", t5.attempts.length === 2, String(t5.attempts.length));
      ok("J ★ 被打回那次(#1)的产出**照样看得见** —— 它当初真的落过盘",
        t5.attempts[0].output.s === "have", JSON.stringify(t5.attempts[0].output));
      ok("J ★ 两次挂的是**两份不同的字节**(不是把最终答案挂到被打回那次名下)",
        t5.attempts[0].output.ref !== t5.attempts[1].output.ref, JSON.stringify(t5.attempts.map((a) => a.output.ref)));
      ok("J ★ 最终产出挂在 accepted(#2)那次名下", t5.attempts[1].output.s === "have",
        JSON.stringify(t5.attempts[1].output));
      mustFail("产出被错挂:#1 显示的是 #2 那份字节",
        t5.attempts[0].output.ref === t5.attempts[1].output.ref);
      mustFail("有原件却被说成「只剩指纹」", t5.attempts[0].output.code === "fingerprint-only");
    }

    /* B —— 老回执:当初就没留下逐次原件。此时 `fingerprint-only` 才是**真话**,
           而且必须与 `source-missing`("从来没有过产出")分得开。 */
    {
      const asset = (n) => (n === 1 ? { state: "unavailable", code: "fingerprint-only" }
        : { state: "present", ref: "nodes/.runs/g/0-old/turns/main/attempt-2.output.md",
            sha256: "f".repeat(64), byteCount: 12 });
      const t5 = reuseStream("old", asset);
      ok("J ★ 没有逐次原件那次说的是「只剩指纹」而不是「从来没有过产出」",
        t5.attempts[0].output.s !== "have" && t5.attempts[0].output.code === "fingerprint-only",
        JSON.stringify(t5.attempts[0].output));
      ok("J ★ 最终产出仍挂在 #2", t5.attempts[1].output.s === "have");
      mustFail("产出被错挂到被打回的那一次", t5.attempts[0].output.s === "have");
    }
  }

  /* ①b 轮序:**事件里被宣告的先后**说了算,不是回执里的排列。
        `not-started` 的轮不进 `turns[]`,所以"先 draft 没能开始、再换个 key 跑成 fix"
        这种真实形状里,回执里只有 fix —— 按回执优先排就成了 fix → draft,**时间倒流**。 */
  {
    const R6 = X.newLiveState();
    const ev = (seq, event, payload) => X.applyEvent(R6, { v: 1, seq, ts: 1e12 + seq, graphId: "g", event, payload });
    const NA = { state: "not-applicable" };
    const SHA = "d".repeat(64);
    const asset = (ref) => ({ state: "present", ref, sha256: SHA, byteCount: 3 });
    ev(0, "run:started", { outDir: "C:\\w", maxConcurrent: 1 });
    ev(1, "node:observed", { nodeSeq: 0, id: "talk", agent: "omp", access: "read", cwd: "C:\\w",
      model: null, effort: null, spec: NA, prompt: NA, role: NA,   // prompt=na ⇒ 这是一段对话
      declaredDeps: [], inferredDeps: [], inferredDepsTruncated: false });
    // 第 1 轮 draft:宣告了、但没能开始(它**不进** turns[])
    ev(2, "node:turn", { nodeSeq: 0, turnKey: "draft", input: NA, inputSha256: SHA,
      timeoutMs: 1000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
    ev(3, "node:turn-settled", { nodeSeq: 0, turnKey: "draft", status: "not-started",
      sessionReusable: true, output: { state: "unavailable", code: "source-missing" }, scene: NA,
      charCount: null, durationMs: 0, errorSummary: "这一轮在入场就被挡下了" });
    // 第 2 轮 fix:跑成了,**只有它进 turns[]**
    ev(4, "node:turn", { nodeSeq: 0, turnKey: "fix", input: NA, inputSha256: SHA,
      timeoutMs: 1000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
    ev(5, "node:started", { nodeSeq: 0, turnKey: "fix", queuedMs: 1 });
    ev(6, "node:attempt", { nodeSeq: 0, turnKey: "fix", n: 1, input: NA, inputSha256: SHA });
    ev(7, "node:attempt-settled", { nodeSeq: 0, turnKey: "fix", n: 1, status: "accepted",
      output: asset("nodes/.runs/g/0-talk/turns/fix/attempt-1.output.md"), durationMs: 2, charCount: 3 });
    ev(8, "node:turn-settled", { nodeSeq: 0, turnKey: "fix", status: "ok", sessionReusable: true,
      output: asset("nodes/.runs/g/0-talk/turns/fix/attempt-1.output.md"), scene: NA,
      charCount: 3, durationMs: 2 });
    ev(9, "node:settled", { nodeSeq: 0, status: "ok", execution: "fresh", durationMs: 9,
      receipt: NA, artifact: asset("nodes/.runs/g/0-talk/turns/fix/attempt-1.output.md"), diff: NA,
      turns: [{ key: "fix", status: "ok", sessionReusable: true,
        output: asset("nodes/.runs/g/0-talk/turns/fix/attempt-1.output.md"),
        turnSpecHash: "e".repeat(32), charCount: 3, durationMs: 2,
        inferredDeps: [], inferredDepsTruncated: false,
        attempts: [{ n: 1, status: "accepted", inputSha256: SHA, input: NA,
          output: asset("nodes/.runs/g/0-talk/turns/fix/attempt-1.output.md") }] }] });
    R6.replay.mode = "live";
    const t6 = X.buildScene(R6).nodes[0].turns;
    ok("J ★ 轮序按事件宣告的先后(not-started 那轮不进回执,也不许被排到后面)",
      t6.map((t) => t.key).join(",") === "draft,fix", t6.map((t) => t.key).join(","));
    mustFail("轮序被回执排列覆盖 ⇒ 时间倒流", t6[0].key === "fix");
    ok("J ★ 两轮都画得出来(回执里只有一轮,不能因此少画)", t6.length === 2, String(t6.length));
  }

  /* ② SceneState 的键是**逻辑名**,不是磁盘文件名(§3.2)。读错了会三样全部落空,
        而那看起来就是一次正常的"没有现场"。 */
  {
    const g = byId["long-scan"];
    const sess = g.turns[0].scene.session;
    ok("J ★ 现场三件套按逻辑名读得到(sessionLog/answer/status)",
      sess.s === "have" && !!sess.ref, JSON.stringify(sess));
    mustFail("现场被按磁盘文件名读 → 三样全部落空", sess.s === "unlogged");
  }

  /* ③ 推断边取**并集**:refine-plan 第 1 轮推断 survey、第 2 轮推断 audit-auth。
        覆盖式实现只会留下后者 —— 而两条都是真的。 */
  {
    const rp = byId["refine-plan"];
    const ins = A.edges.filter((e) => e.b === rp.seq).map((e) => e.a).sort((x, y) => x - y);
    ok("J ★ 多轮的推断依赖取并集,不是后一轮覆盖前一轮",
      ins.includes(byId.survey.seq) && ins.includes(byId["audit-auth"].seq), JSON.stringify(ins));
  }

  /* ④ 连不上的依赖:不许静默丢掉,也不许猜一个连上。 */
  {
    const rep = byId.report;
    ok("J ★ 图里没有的依赖 id 要说出来", /typo-id/.test(rep.note || ""), rep.note || "(没有 note)");
    /* ⚠️ 早先这条写的是 `!edges.some(e => e.a == null)` —— **它必然为真**:
          连不上的依赖压根不会进 edges,`a` 也就不可能是 null。一条永远不会红的断言
          守不住任何东西。判别式的写法是:**进 report 的边,恰好是那两条能连上的**。 */
    const into = A.edges.filter((e) => e.b === rep.seq).map((e) => e.a).sort((x, y) => x - y);
    const want = [byId.survey.seq, byId["long-scan"].seq].sort((x, y) => x - y);
    ok("J ★ 而且**只**画得出能连上的那两条(typo-id 一条都没变出来)",
      JSON.stringify(into) === JSON.stringify(want), JSON.stringify(into) + " vs " + JSON.stringify(want));
    mustFail("连不上的依赖被静默丢掉", !/连不上/.test(rep.note || ""));

    /* ★ 但这一句**只对声明成立**。推断是我们自己猜的,猜空了就是没猜中 ——
       页面没有立场为自己的猜测报警。照声明那套处置推断,用户会看到一条
       **他从没写过的依赖**被报成「连不上」,尤其在他一条 deps 都没声明的时候。 */
    {
      const R5 = X.newLiveState();
      const ev = (seq, event, payload) => X.applyEvent(R5, { v: 1, seq, ts: 1e12 + seq, graphId: "g", event, payload });
      const obs = (nodeSeq, id, inferred) => ({ nodeSeq, id, agent: "omp", access: "read", cwd: "C:\\w",
        model: null, effort: null, spec: {state:"not-applicable"}, prompt: {state:"not-applicable"},
        role: {state:"not-applicable"}, declaredDeps: [], inferredDeps: inferred, inferredDepsTruncated: false });
      ev(0, "run:started", { outDir: "C:\\w", maxConcurrent: 1 });
      ev(1, "node:observed", obs(0, "solo", []));
      // 一条**猜**出来的依赖,指向本图根本没有的 id(扫到了别的 out-dir 的路径就会这样)
      ev(2, "node:observed", obs(1, "user", ["from-another-run"]));
      const S5 = X.buildScene(R5);
      const u = S5.nodes.find((n) => n.id === "user");
      ok("K ★★ 猜出来的依赖连不上时,页面闭嘴(它从没承诺过这条边有意义)",
        !/连不上/.test(u?.note || ""), `note = ${JSON.stringify(u?.note || "")}`);
      ok("K 而且也确实没画出那条边",
        !S5.edges.some((e) => e.b === u?.seq), JSON.stringify(S5.edges));
    }

    /* ★ write 环节的工作副本去向:**「这一层不带」不是「记录坏了」**。
       实测踩过:回执正常归档时 `workspaceSummary` 按合同不出现,而页面把这一档也判成
       `unlogged` —— 于是每个成功的 write 环节都被指控「记录从某处起不完整」,
       就印在绿色「已交付」框正下方。看到这句的人会开始怀疑上面所有数字。 */
    {
      const mk = (hasWsSummary) => {
        const R6 = X.newLiveState();
        const ev = (seq, event, payload) => X.applyEvent(R6, { v: 1, seq, ts: 1e12 + seq, graphId: "g", event, payload });
        ev(0, "run:started", { outDir: "C:\\w", maxConcurrent: 1 });
        ev(1, "node:observed", { nodeSeq: 0, id: "fix", agent: "claude", access: "write", cwd: "C:\\w",
          model: null, effort: null, spec: {state:"not-applicable"}, prompt: {state:"not-applicable"},
          role: {state:"not-applicable"}, declaredDeps: [], inferredDeps: [], inferredDepsTruncated: false });
        ev(2, "node:workspace-intent",  { nodeSeq: 0, path: "C:\\w\\.graph\\wt\\r\\fix", branch: "graph/r/fix", baseCommit: "abc1234" });
        ev(3, "node:workspace-created", { nodeSeq: 0, path: "C:\\w\\.graph\\wt\\r\\fix", branch: "graph/r/fix", baseCommit: "abc1234" });
        ev(4, "node:started", { nodeSeq: 0 });
        const settled = { nodeSeq: 0, status: "ok", execution: "fresh", durationMs: 1000, outcome: "delivered",
          receipt: {state:"present", ref:"nodes/.runs/g/0-fix/receipt.json", sha256:"a".repeat(64), byteCount: 10},
          artifact: {state:"not-applicable"}, diff: {state:"present", ref:"nodes/.runs/g/0-fix/change.diff", sha256:"b".repeat(64), byteCount: 200},
          turns: [] };
        // 兜底那一层:summary 出现了、却没记下 removed —— 这一档才是真的"没记全"
        if (hasWsSummary) settled.workspaceSummary = { branch: "graph/r/fix", baseCommit: "abc1234", changesKnown: true };
        ev(5, "node:settled", settled);
        return X.buildScene(R6).nodes.find((n) => n.id === "fix");
      };

      const normal = mk(false);
      ok("K ★★ 回执正常归档时,工作副本那栏不许说「记录不完整」(那是留给归档真断了的)",
        normal?.write?.worktree?.state === "in_receipt", JSON.stringify(normal?.write?.worktree));
      ok("K ★★ 而分支名要从 workspace 事件里取出来显示(页面手上有,别说没有)",
        normal?.write?.branch === "graph/r/fix", JSON.stringify(normal?.write));
      ok("K ★ 基线同理", normal?.write?.base === "abc1234", JSON.stringify(normal?.write?.base));

      const degraded = mk(true);
      ok("K ★ 但兜底 summary 真的缺 removed 时,照旧如实报「状态未记录」",
        degraded?.write?.worktree?.state === "unlogged", JSON.stringify(degraded?.write?.worktree));
    }

    /* ★ 重复 id:合同说**恰好出现 1 次才连**,0 次或 ≥2 次都不画,改标一句。
       样例里没有重复 id 的场景(它会改变 counts),所以这里现造一条最小事件流。 */
    {
      const R4 = X.newLiveState();
      const ev = (seq, event, payload) => X.applyEvent(R4, { v: 1, seq, ts: 1e12 + seq, graphId: "g", event, payload });
      const obs = (nodeSeq, id, deps) => ({ nodeSeq, id, agent: "omp", access: "read", cwd: "C:\\w",
        model: null, effort: null, spec: {state:"not-applicable"}, prompt: {state:"not-applicable"},
        role: {state:"not-applicable"}, declaredDeps: deps, inferredDeps: [], inferredDepsTruncated: false });
      ev(0, "run:started", { outDir: "C:\\w", maxConcurrent: 1 });
      ev(1, "node:observed", obs(0, "twin", []));
      ev(2, "node:observed", obs(1, "twin", []));      // 同一个 id 出现两次(force 顺序重跑是合法的)
      ev(3, "node:observed", obs(2, "user", ["twin"]));
      R4.replay.mode = "live";
      const sc4 = X.buildScene(R4);
      const u = sc4.nodes.find((x) => x.seq === 2);
      ok("J ★ 目标 id 不唯一时**一条边都不画**(不许挑最近的那个 —— 那是编造因果)",
        !sc4.edges.some((e) => e.b === 2), JSON.stringify(sc4.edges));
      ok("J ★ 但必须说出来:实例不唯一", /不唯一|2 个同名/.test(u.note || ""), u.note || "(没有 note)");
      mustFail("重复 id 被静默连到其中一个", sc4.edges.some((e) => e.b === 2));
    }
  }

  /* ⑤ 节点级五份资产要进 view-model 并渲得出来 —— 产出就是跑这个环节的全部目的。 */
  {
    const s0 = byId.survey;
    ok("J ★ 产出文件进了 view-model", s0.files && s0.files.artifact.s === "have", JSON.stringify(s0.files && s0.files.artifact));
    ok("J ★ 回执也在", s0.files.receipt.s === "have");
    const h = X.filesBlock(s0);
    ok("J ★ 详情面板给得出产出入口", /打开产出/.test(h), h.slice(0, 160));
    ok("J ★ 也给得出回执入口", /打开回执/.test(h));
    // 回执归档失败的那个:入口要**明说拿不到**,不是不给也不解释
    const nr = X.filesBlock(byId["no-receipt"]);
    ok("J ★ 回执拿不到时如实标注并给原因码", /拿不到/.test(nr) && /write-failed/.test(nr), nr.slice(-260));
  }

  /* ⑥ 失败原因:回执归档正常时节点级没有 errorSummary,原因在**轮**上。
        只读节点级的实现会让每一个失败节点都显示成"没有附带错误正文"。 */
  {
    const ls = byId["long-scan"];
    ok("J ★ 回执正常的失败节点也给得出原因(取自轮)",
      /20 分钟的执行上限/.test(ls.error.desc), ls.error.desc);
    ok("J ★ 而且标明这句话来自哪一轮", ls.error.descFrom === "main", String(ls.error.descFrom));
    mustFail("回执正常就说「没有错误正文」", /没有附带错误正文/.test(ls.error.desc));
  }

  /* ⑦ present 缺 sha256 / byteCount = 记录损坏 —— 对证手段没了,不能当可信资产渲染。
        ⚠️ 但 byteCount **可以是 0**(空产出是合法的 present),判据是"是不是非负整数"。 */
  {
    const R3 = X.newLiveState();
    const evs = fs.readFileSync(path.join(SAMPLE, "gr-sample-main", "transcript.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const raw of evs) {
      let e = raw;
      if (e.event === "node:observed" && e.payload.id === "survey") {
        e = JSON.parse(JSON.stringify(e)); delete e.payload.spec.sha256;
      }
      X.applyEvent(R3, e);
    }
    R3.replay.mode = "live";
    const s3 = X.buildScene(R3).nodes.find((n) => n.id === "survey");
    ok("J ★ present 少了 sha256 → 按记录损坏处理", s3.files.spec.s === "unavailable" &&
      s3.files.spec.code === "record-broken", JSON.stringify(s3.files.spec));
    // 负对照的另一半:零字节产出**照常**是 have
    const flaky = A.nodes.find((n) => n.id === "flaky");
    ok("J ★ 零字节产出照常是可打开的 present(不许判成损坏)",
      flaky.files.artifact.s === "have" && flaky.files.artifact.byteCount === 0,
      JSON.stringify(flaky.files.artifact));
  }
}

/* ============================================================
   9.6 §9 的按需取正文:取回来的字节要与事件里的指纹对证
   ============================================================
   §9 那一段在 §8 之后(它要碰 DOM 与 EventSource),沙箱装不进去。
   但 `resolveAsset` 本身是纯函数 —— 把它单独抠出来、喂一个假的取文件缓存就能测。
   ⚠️ 这一条守的是**整套归档唯一的防篡改手段**:归档区就在磁盘上,谁都能改;
      页面拿 `/file` 响应头里的指纹与事件里记的对一次,不等就当场标红。
      服务端那一半由 repro-graph-viz 的 V8 守(改了文件,头要跟着变)。 */
console.log("\n[K] §9 按需取正文:指纹对证");
{
  const src = fs.readFileSync(PAGE, "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
  const i = src.indexOf("function resolveAsset(");
  const j = src.indexOf("\n}", i) + 2;
  ok("K 抠得到 resolveAsset(页面结构变了这条要跟着改)", i > 0 && j > i);

  const mk = (rec) => {
    const ctx = { LIVE: true, wantFile: () => rec, console };
    vm.createContext(ctx);
    vm.runInContext(src.slice(i, j) + "\n;globalThis.__f = resolveAsset;", ctx);
    return ctx.__f;
  };
  const SHA = "a".repeat(64), OTHER = "b".repeat(64);
  const asset = { s: "have", ref: "nodes/.runs/g/0-x/turns/main/attempt-1.output.md", sha256: SHA, byteCount: 12 };

  const okCase = mk({ state: "ok", text: "正文", gotSha: SHA })(asset);
  ok("K ★ 指纹一致 → verify:'ok'", okCase.verify === "ok", JSON.stringify(okCase));
  ok("K 正文照常给出", okCase.text === "正文");

  const bad = mk({ state: "ok", text: "被改过的正文", gotSha: OTHER })(asset);
  ok("K ★ 指纹不一致 → verify:'mismatch'", bad.verify === "mismatch", JSON.stringify(bad));
  /* ⚠️ **仍然要把正文给出去。** 藏起来更糟:人会以为文件丢了、去查一个不存在的故障;
        判成错误也更糟。正确处置是"给你看,但明说这不是记录里那一份"。 */
  ok("K ★ 但正文仍然给出(藏起来会被当成文件丢了)", bad.text === "被改过的正文");
  ok("K ★ 两个指纹都带上,好让人自己核对", bad.sha256 === SHA && bad.gotSha === OTHER);

  const noHdr = mk({ state: "ok", text: "正文", gotSha: null })(asset);
  ok("K ★ 服务端没给指纹头 → verify:'no-header'(不是默默当成对上了)",
    noHdr.verify === "no-header", JSON.stringify(noHdr));
  mustFail("没有指纹头时被当成对上了", noHdr.verify === "ok");

  // 404 与网络错误各自成档,别混进对证这条线
  ok("K 404 → gone(记录时它在,现在取不回来)", mk({ state: "gone" })(asset).s === "gone");
  const err = mk({ state: "error", why: "HTTP 500" })(asset);
  ok("K 其它错误 → unavailable 且原样带上状态", err.s === "unavailable" && /500/.test(err.why));

  // 渲染侧:mismatch 必须在页面上**看得见**
  const h = X.assetRow("产出文件", bad, "打开产出");
  ok("K ★ 页面上明说「这不是事件记录的那一份」", /这不是事件记录的那一份/.test(h), h.slice(0, 200));
  mustFail("对不上却静默显示", !/文件已被改动|这不是事件记录的那一份/.test(h));
}



console.log(`\n${"=".repeat(56)}`);
console.log(`  test-viz: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(56)}\n`);
process.exit(fail === 0 ? 0 : 1);
