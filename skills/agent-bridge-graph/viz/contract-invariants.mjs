/**
 * `docs/EVENTS-graph.md` 里那些**跨字段的等式** —— schema 管不到的那一类合同。
 *
 * `tools/viz-events.mjs` 的 schema 只管**单个字段的形状**(是不是 hex64、超没超 512 字节)。
 * 它管不了「这两处的 sha256 必须相等」「这个字段只在那个字段不是 present 时才许出现」——
 * 而正是这类等式,把归档从"一堆文件"变成**一份能对证的记录**。
 *
 * ⚠️ **这份文件刻意不 import viz-events.mjs。** 它是照着合同的散文写的第二实现:
 *    拿写方的 schema 去验写方造的事件,证明的只是"我和我自己一致"——一个同源的同义反复。
 *    只有两边各自独立地表达同一份合同,中间那道缝才照得出漂移。
 *
 * 两个调用点(都在推送前必过的回归里):
 *   - `viz/test-viz.mjs`     —— 验**冻结样例**(消费侧的地基:样例歪了,后面每条断言都在验假合同)
 *   - `docs/repro-mcp-hang/repro-graph-viz.mjs` —— 验**真跑出来的 transcript**(生产侧有没有漂)
 *
 * 条目对应 docs/EVENTS-graph.md:§1.3(四条"可验的断言")、§3.1(present 三样恒有)、§3.2(现场是容器、
 * 键是逻辑名)、§5.8(两级兜底的出现条件 + workspaceSummary 字段封闭)。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const WS_KEYS = ["path", "branch", "baseCommit", "headCommit", "removed", "changesKnown"];
const SCENE_KEYS = ["sessionLog", "answer", "status"];

/**
 * 把一条 payload 里所有 `AssetState{present}` 抓出来(含现场容器里的三件套)。
 *
 * ⚠️ **判据只看 `state === "present"`,不许再附加"而且 ref 是字符串"。**
 * 早先那个多余的条件制造了一个**结构性盲区**:一份 `{state:"present"}`(ref 都没有)
 * 压根不会被收集,于是"三样恒有"那条断言看到的是**零份资产,一切正常** ——
 * 一条**专门为它设的**检查,被它自己的取数方式挡在门外。
 */
function walkPresent(v, out) {
  if (!v || typeof v !== "object") return out;
  /* ⚠️ **现场是容器,不是资产**(§3.2):`{state:"present", files:{…}}` **本来就没有**
        ref / sha256 / byteCount,合同还明说页面不得把它渲染成可点击的目录链接。
        把它当资产收进来,"三样恒有"那条会对着一个**合规**的容器报错。
        它里面那三份才是资产 —— 由下面的递归各自收进来。 */
  const isSceneContainer = v.state === "present" && v.files && typeof v.files === "object";
  if (v.state === "present" && !isSceneContainer) out.push(v);
  for (const k of Object.keys(v)) walkPresent(v[k], out);
  return out;
}

/**
 * 两处 `AssetState` 说的是不是同一件事。
 *
 * ⚠️ **不用 `JSON.stringify` 比。** 那会把**键的插入顺序**也变成一致性要求,而合同
 * 从没规定过键序 —— 两处字段完全相同、只是构造顺序不同,就会被判红。
 * 断言只该覆盖合同真的说了的东西,多要一分就是给未来埋一次假红。
 */
function sameAsset(a, b) {
  if (!a || !b) return a === b;
  if (a.state !== b.state) return false;
  if (a.state === "present") return a.ref === b.ref && a.sha256 === b.sha256 && a.byteCount === b.byteCount;
  if (a.state === "unavailable") return a.code === b.code;
  return true;   // not-applicable:没有别的字段
}

/** 合法的归档 ref:相对路径、无 `..`、在本 graph 的归档前缀底下。 */
function refLooksLegal(ref, graphId) {
  if (typeof ref !== "string" || !ref) return "不是非空字符串";
  const norm = ref.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return "是绝对路径";
  if (norm.split("/").includes("..")) return "含 ..";
  if (graphId && !norm.startsWith(`nodes/.runs/${graphId}/`)) return "不在本 graph 的归档前缀底下";
  return null;
}

/**
 * @param {object[]} lines 一份 transcript 的**全部**行(已 JSON.parse)
 * @param {object}   opt   `archiveRoot` 给了就顺带验"磁盘上那份与事件里记的 sha256/byteCount 逐字节一致"
 * @returns {{name:string, ok:boolean, detail:string}[]}
 */
export function checkInvariants(lines, opt = {}) {
  const R = [];
  const add = (name, ok, detail = "") => R.push({ name, ok, detail: ok ? "" : String(detail) });
  const of = (e) => lines.filter((l) => l.event === e).map((l) => l.payload);

  const observed = of("node:observed");
  const turnEvents = of("node:turn");
  const attempts = of("node:attempt");
  const turnSettled = of("node:turn-settled");
  const settled = of("node:settled");

  /* ── ① 单轮节点的 `node:observed.prompt` 与 `node:turn{main}.input` 是**同一份字节**;
        对话节点(多轮)**没有节点级 prompt**。 */
  {
    const byNode = new Map();
    for (const p of turnEvents) {
      if (!byNode.has(p.nodeSeq)) byNode.set(p.nodeSeq, []);
      byNode.get(p.nodeSeq).push(p);
    }
    /* ⚠️ **判"是不是对话"的唯一判据是 `prompt.state === "not-applicable"`**(§3.1、§5.2、§10.8),
          **不是轮数**。用轮数判的话,一段**只跑了一轮、而且 key 恰好叫 main** 的合法 conversation
          会被当成 runNode,于是这条断言反过来要求它必须有节点级 prompt —— 把一次**完全合规**的
          真实运行判成违约。合同还专门警告过别把这道闸收窄成 "turns.length ≥ 2"。 */
    let checked = 0, bad = "";
    for (const o of observed) {
      const ts = byNode.get(o.nodeSeq) || [];
      if (o.prompt.state === "not-applicable") continue;   // 对话节点:这条不适用
      if (o.prompt.state !== "present") continue;          // 归档失败 ⇒ unavailable,不苛求
      // 单轮节点:它的节点级 prompt **就是** main 那一轮的输入(同 ref ⇒ 同 sha)。
      const main = ts.find((t) => t.turnKey === "main");
      if (!main) continue;                                 // 复用命中一条 turn 事件都不发
      if (ts.length !== 1) bad ||= `${o.id}: 有节点级 prompt(=单轮节点)却发了 ${ts.length} 轮`;
      else if (o.prompt.ref !== main.input.ref || o.prompt.sha256 !== main.input.sha256)
        bad ||= `${o.id}: 节点级 prompt 与 main 轮输入不是同一份字节`;
      checked++;
    }
    add(`①单轮 prompt≡main 轮输入 / 对话节点无节点级 prompt(${checked} 个)`, !bad, bad);
  }

  /* ── ② 每一轮 attempt 1 的输入**就是**该轮 `turns/<key>/prompt.md` 本身,不另存一份。 */
  {
    const byKey = new Map(turnEvents.map((p) => [`${p.nodeSeq}/${p.turnKey}`, p]));
    let checked = 0, bad = "";
    for (const a of attempts) {
      if (a.n !== 1) continue;
      const t = byKey.get(`${a.nodeSeq}/${a.turnKey}`);
      if (!t) { bad ||= `#${a.nodeSeq}/${a.turnKey}: 有 attempt 却没有 node:turn`; continue; }
      /* 指纹与归档是**两件事**:`inputSha256` 是那段正文的指纹,归档成没成功都在;
         `input` 是"这份正文归档下来没有"。所以指纹**无条件**比。 */
      if (a.inputSha256 !== t.inputSha256)
        { bad ||= `#${a.nodeSeq}/${a.turnKey}: attempt 1 的输入指纹不是该轮冻结正文`; checked++; continue; }
      /* ⚠️ 两边指的是**同一个文件**(attempt 1 不另存一份),所以归档结局必须**同生同灭**:
            一边 present 另一边 unavailable = 同一份字节有了两种命运,那是记录本身在自相矛盾。
            ⚠️ 早先这里直接 `a.input.ref.endsWith(...)` —— 归档失败时 `ref` 压根不存在,
               于是这个**用来判对错的检查器自己抛异常**:整份 transcript 一条都没查成,
               而调用方看到的是"炸了",不是"哪条不变式不成立"。 */
      const ap = a.input.state === "present", tp = t.input.state === "present";
      if (ap !== tp) {
        bad ||= `#${a.nodeSeq}/${a.turnKey}: 同一份输入两种归档结局(attempt=${a.input.state}/轮=${t.input.state})`;
      } else if (!ap) {
        if (a.input.code !== t.input.code)
          bad ||= `#${a.nodeSeq}/${a.turnKey}: 同一份输入两种失败原因(${a.input.code} ≠ ${t.input.code})`;
      } else if (a.input.ref !== t.input.ref) {
        bad ||= `#${a.nodeSeq}/${a.turnKey}: attempt 1 的输入不是该轮冻结正文`;
      } else if (!a.input.ref.endsWith(`/turns/${a.turnKey}/prompt.md`)) {
        bad ||= `#${a.nodeSeq}/${a.turnKey}: attempt 1 的输入另存了一份(${a.input.ref})`;
      }
      checked++;
    }
    add(`②attempt 1 的输入 = 该轮 prompt.md(${checked} 处)`, !bad, bad);
  }

  /* ── ③ 归档里**没有** `artifact.md`;顶层产出 = 最后一份成功复制的轮产出;
        轮产出 = 该轮最后一份成功复制的 attempt 产出。三处 sha 相等。 */
  {
    /* ⚠️ **期望值必须从 `attempts[]` 独立推出来,不能拿 `TurnSummary.output` 当基准。**
          从后者反推是**循环论证**:生产者要是把一份**明明归档成功**的产出说成 `source-missing`,
          轮产出与顶层产出会一起错成同一个值 —— 两处"一致",断言全绿,而那正是要抓的错。
          正确的基准是"该轮**最后一份 present 的 attempt 产出**",它由 attempts 直接给出。 */
    /* ⚠️ **选"哪一项"与"它是什么状态"是两步**(§1.3),不能合并成"取最后一个 present"。
          按 present 选的话,**最后那一次归档失败**就会让期望值回退到**上一次**的产出 ——
          于是一次把"旧答案冒充最终交付物"的实现会被判成合规,而一次**诚实地说
          "这一份没归档成功"**的合法运行反倒被判红。两个方向都错。
          ⚠️ 判据从 wire 上就分得出:`unavailable{source-missing}` ⟺ **从来没有过**本地原件;
             其余任何状态都说明**复制成功过**。 */
    /* ⚠️ **"有没有本地原件"要按 code 分两类,不是"只有 source-missing 才算没有"。**
          没有本地原件:`source-missing`(从来没有过)、`fingerprint-only`(有过,但在
            上一次运行的归档区里 / 当初就没落盘 —— **这一次够不着**)。
          有本地原件、只是这一层没保住:`write-failed` / `sha-failed` / `archive-root-failed`。
          ⚠️ 早先这里把 `fingerprint-only` 划进"有过",于是与生产者**正好相反**
             (`markOutputFingerprintOnly` 明说不打 `hadLocal`)。后果不是"少查一条":
             最后一次尝试只剩指纹时,生产者选**更早那次**当最终产出、检查器选**最后那次**,
             两边对"最终产出是哪一份"给出相反的答案,而这条不变式的全部意义就是判它们一致。 */
    const NO_LOCAL = new Set(["source-missing", "fingerprint-only"]);
    const hadLocal = (o) => !!o && !(o.state === "unavailable" && NO_LOCAL.has(o.code));
    let bad = "";
    for (const s of settled) {
      let nodeWant = null;
      for (const t of s.turns) {
        const copied = (t.attempts || []).filter((a) => hadLocal(a.output));
        const want = copied.length ? copied[copied.length - 1].output : null;
        if (want) {
          nodeWant = want;
          // 照抄那一项的状态:归档成功 ⇒ 同 ref 同 sha;归档失败 ⇒ 同 code(同生同灭)。
          if (!sameAsset(t.output, want))
            bad ||= `#${s.nodeSeq}/${t.key}: 轮产出不是"最后一次本地复制成功"的那一项(${JSON.stringify(t.output)})`;
        } else if (hadLocal(t.output)) {
          bad ||= `#${s.nodeSeq}/${t.key}: 一次本地复制都没成功过,轮产出却不是 source-missing`;
        }
      }
      if (nodeWant) {
        if (!sameAsset(s.artifact, nodeWant))
          bad ||= `#${s.nodeSeq}: 顶层产出不是"最后一次本地复制成功"的那一项(${JSON.stringify(s.artifact)})`;
      } else if (hadLocal(s.artifact)) {
        bad ||= `#${s.nodeSeq}: 一次本地复制都没成功过,顶层产出却不是 source-missing`;
      }
    }
    add(`③顶层产出 = 最后一份轮产出,三处 sha 相等(${settled.length} 个节点)`, !bad, bad);

    const refs = [];
    for (const l of lines) for (const a of walkPresent(l.payload, [])) refs.push(a.ref);
    const stray = refs.find((r) => typeof r === "string" && r.endsWith("/artifact.md"));
    add("③归档里没有 artifact.md(合同明说不另存一份)", !stray, stray || "");
  }

  /* ── ④ `workspaceSummary` / `errorSummary` **只在 receipt 不是 present 时**出现;
        `workspaceSummary` 字段封闭;**read 节点恒无** workspaceSummary。 */
  {
    const access = new Map(observed.map((p) => [p.nodeSeq, p.access]));
    let bad = "", healthy = 0, withWs = 0;
    for (const s of settled) {
      if (s.receipt.state === "present") {
        healthy++;
        if (s.workspaceSummary || s.errorSummary !== undefined)
          bad ||= `#${s.nodeSeq}: 回执正常却还内联了兜底字段`;
      }
      if (s.workspaceSummary) {
        withWs++;
        const w = s.workspaceSummary;
        if (access.get(s.nodeSeq) !== "write") bad ||= `#${s.nodeSeq}: read 节点不该有 workspaceSummary`;
        const extra = Object.keys(w).filter((k) => !WS_KEYS.includes(k));
        if (extra.length) bad ||= `#${s.nodeSeq}: workspaceSummary 字段封闭,多了 ${extra.join("/")}`;
        /* ⚠️ **字段封闭是双向的:不许多,也不许少。**
              只查"多了什么"的话,一份 `{}` 会顺利通过 —— 而这一层是回执没归档成功时
              "人怎么找到现场"的唯一线索,少一个键就少一条线索,却不报错。 */
        const missing = WS_KEYS.filter((k) => !(k in w));
        if (missing.length) bad ||= `#${s.nodeSeq}: workspaceSummary 少了 ${missing.join("/")}(拿不到要发 null,不是省略)`;
        else {
          if (typeof w.removed !== "boolean" || typeof w.changesKnown !== "boolean")
            bad ||= `#${s.nodeSeq}: removed/changesKnown 必须是布尔`;
          // commit 是 git rev-parse 给的**完整** 40 位 SHA —— 短 SHA 会随仓库长大而歧义。
          if (w.baseCommit !== null && !/^[0-9a-f]{40}$/.test(String(w.baseCommit)))
            bad ||= `#${s.nodeSeq}: baseCommit 既不是 null 也不是 hex40(${w.baseCommit})`;
          // ⚠️ 空串**不是**"拿不到" —— 它会撞上 hex40,而且在页面上长得像一个真值。
          for (const k of ["path", "branch", "baseCommit", "headCommit"])
            if (w[k] === "") bad ||= `#${s.nodeSeq}: ${k} 是空串;拿不到要发 null`;
          if (w.headCommit !== null && !/^[0-9a-f]{40}$/.test(String(w.headCommit)))
            bad ||= `#${s.nodeSeq}: headCommit 既不是 null 也不是 hex40(${w.headCommit})`;
        }
      }
    }
    add("④兜底字段只在回执缺席时出现 / 字段封闭 / read 节点恒无", !bad, bad);
    R.push({ name: "④两条路都被走到(回执正常 vs 回执缺席)", ok: healthy > 0 || withWs > 0,
             detail: `healthy=${healthy} ws=${withWs}`, weak: true });
  }

  /* ── ⑤ `present` 的 ref/sha256/byteCount **三样恒有**(§3.1)。
        ⚠️ `byteCount` **可以是 0**(空产出是合法的 present),判据是"非负整数",不是真值判断。 */
  {
    const gid = lines.length ? lines[0].graphId : null;
    let n = 0, bad = "";
    for (const l of lines) for (const a of walkPresent(l.payload, [])) {
      n++;
      /* ⚠️ 光有 ref 不够,它还得**打得开而且指对地方**:`/file` 会拒绝绝对路径、`..`、
            以及本次归档范围之外的东西。一个通不过那几道闸的 ref,页面照样会把它渲染成
            一个可点的链接 —— 点下去是 400/403,而用户看到的是"文件坏了"。 */
      const why = refLooksLegal(a.ref, gid);
      if (why) bad ||= `present 的 ref ${why}:${JSON.stringify(a.ref)}`;
      else if (!/^[0-9a-f]{64}$/.test(String(a.sha256))) bad ||= `${a.ref}: sha256 不是 hex64`;
      else if (!Number.isSafeInteger(a.byteCount) || a.byteCount < 0) bad ||= `${a.ref}: byteCount 不是非负整数`;
    }
    add(`⑤present 的三样恒有且 ref 合法(${n} 份资产)`, !bad, bad);
  }

  /* ── ⑥ 现场是**容器**:自己没有 ref/sha256/byteCount,`files` 的键是**逻辑名**(§3.2)。 */
  {
    let n = 0, bad = "";
    for (const t of turnSettled) {
      const sc = t.scene;
      if (!sc || sc.state !== "present") continue;
      n++;
      if (sc.ref || sc.sha256 || sc.byteCount != null) bad ||= `#${t.nodeSeq}/${t.turnKey}: 现场容器不该有 ref/sha256/byteCount`;
      const keys = Object.keys(sc.files || {});
      const missing = SCENE_KEYS.filter((k) => !keys.includes(k));
      if (missing.length) bad ||= `#${t.nodeSeq}/${t.turnKey}: 现场少了逻辑名键 ${missing.join("/")}`;
      const extra = keys.filter((k) => !SCENE_KEYS.includes(k));
      if (extra.length) bad ||= `#${t.nodeSeq}/${t.turnKey}: 现场多了键 ${extra.join("/")}(键是逻辑名,不是磁盘文件名)`;
    }
    add(`⑥现场是容器且键为逻辑名(${n} 份现场)`, !bad, bad);
  }

  /* ── ⑦ `turnSpecHash` 是 **hex32**,不是 hex64(§0.2)。
        把它当 hex64 校验,会把**每一条合法记录**判成违约。 */
  {
    let n = 0, bad = "";
    for (const s of settled) for (const t of s.turns) {
      n++;
      if (!/^[0-9a-f]{32}$/.test(String(t.turnSpecHash))) bad ||= `#${s.nodeSeq}/${t.key}: turnSpecHash 不是 hex32`;
    }
    add(`⑦turnSpecHash 是 hex32(${n} 轮)`, !bad, bad);
  }

  /* ── ⑧ 归档文件真的在,且与事件里记的 sha256/byteCount 逐字节一致。
        ⚠️ 这不是"文件在不在"那么简单:页面会拿 `/file` 的响应头指纹与事件里这个值对证,
           对不上就标红。记录自己对不上,那个警报就永远亮着 —— 等于没有警报。 */
  if (opt.archiveRoot) {
    let miss = 0, mismatch = 0, seen = new Set();
    for (const l of lines) for (const a of walkPresent(l.payload, [])) {
      if (seen.has(a.ref)) continue;
      seen.add(a.ref);
      const p = path.join(opt.archiveRoot, a.ref);
      if (!fs.existsSync(p)) { miss++; continue; }
      const b = fs.readFileSync(p);
      if (crypto.createHash("sha256").update(b).digest("hex") !== a.sha256 || b.length !== a.byteCount) mismatch++;
    }
    add(`⑧${seen.size} 份归档文件都在,sha256/byteCount 与磁盘逐字节对上`,
      miss === 0 && mismatch === 0, `缺 ${miss} 份、对不上 ${mismatch} 份`);
  }

  /* ── ⑨ **live 的 `node:turn-settled` 与回执摘要 `turns[]` 说的必须是同一件事。**
        这两处是同一轮的两个副本(一个逐轮广播、一个收尾汇总),而**两份"本该相同"的记录
        迟早会被改成不同**。页面按前者画时间线、按后者补复用节点的轮 —— 它们一旦分叉,
        同一个节点在两个位置显示两套结论,而且各自看起来都自洽。
        ⚠️ `not-started` 的轮**不进 turns[]**,所以只对两边都有的 key 比。 */
  {
    const liveBy = new Map();
    for (const t of turnSettled) liveBy.set(`${t.nodeSeq}/${t.turnKey}`, t);
    let checked = 0, bad = "";
    for (const s of settled) for (const ts of s.turns) {
      const live = liveBy.get(`${s.nodeSeq}/${ts.key}`);
      if (!live) continue;                       // 复用命中:一条 turn 事件都没有
      checked++;
      if (live.status !== ts.status) bad ||= `#${s.nodeSeq}/${ts.key}: status 两处不一致(${live.status} vs ${ts.status})`;
      else if (live.sessionReusable !== ts.sessionReusable) bad ||= `#${s.nodeSeq}/${ts.key}: sessionReusable 两处不一致`;
      else if (live.charCount !== ts.charCount) bad ||= `#${s.nodeSeq}/${ts.key}: charCount 两处不一致`;
      else if (live.durationMs !== ts.durationMs) bad ||= `#${s.nodeSeq}/${ts.key}: durationMs 两处不一致`;
      else if (!sameAsset(live.output, ts.output))
        bad ||= `#${s.nodeSeq}/${ts.key}: 产出资产两处不一致`;
    }
    add(`⑨live 轮事件与回执摘要逐字段一致(${checked} 轮)`, !bad, bad);
  }

  /* ── ⑩ §5.4 那张**封闭**的 `sessionReusable` 判定表。
        ⚠️ `timeout` 有两行(abort 被明确回报打断 ⇒ true,否则 false),事件里没有那个信号,
           所以对 timeout **不断言**;其余五档是硬的。 */
  {
    const WANT = { ok: true, contract_error: true, backend_failed: false, unknown: false, "not-started": true };
    let checked = 0, bad = "";
    for (const t of turnSettled) {
      const want = WANT[t.status];
      if (want === undefined) continue;          // timeout:两行都合法
      checked++;
      if (t.sessionReusable !== want)
        bad ||= `#${t.nodeSeq}/${t.turnKey}: ${t.status} 的 sessionReusable 该是 ${want},拿到 ${t.sessionReusable}`;
    }
    add(`⑩sessionReusable 合乎判定表(${checked} 轮)`, !bad, bad);
  }

  /* ── ⑪ 时钟:节点耗时**包含轮与轮之间回调在干别的事的时间**,所以 ≥ Σ 轮耗时(§5.4)。
        反过来(节点比各轮之和还短)只可能是两个时钟被混用了 —— 那正是这个仓栽过的那类错。 */
  {
    let checked = 0, bad = "";
    for (const s of settled) {
      if (s.execution === "reused") continue;    // 复用时 durationMs 是**当初那次**的耗时,不同口径
      const sum = s.turns.reduce((a, t) => a + (t.durationMs || 0), 0);
      checked++;
      if (s.durationMs < sum) bad ||= `#${s.nodeSeq}: 节点耗时 ${s.durationMs}ms < Σ轮 ${sum}ms`;
    }
    add(`⑪节点耗时 ≥ Σ 轮耗时(${checked} 个节点)`, !bad, bad);
  }

  /* ── ⑫ `turns[].inferredDeps` 是同一轮 `node:turn.inferredDeps` 的**前 20 项前缀**(§5.8)。
        不是前缀就说明两处各扫各的 —— 那时页面取并集会多出根本不存在的边。 */
  {
    const liveBy = new Map();
    for (const t of turnEvents) liveBy.set(`${t.nodeSeq}/${t.turnKey}`, t);
    let checked = 0, bad = "";
    for (const s of settled) for (const ts of s.turns) {
      const live = liveBy.get(`${s.nodeSeq}/${ts.key}`);
      if (!live) continue;
      checked++;
      const want = (live.inferredDeps || []).slice(0, 20);
      if (JSON.stringify(ts.inferredDeps || []) !== JSON.stringify(want))
        bad ||= `#${s.nodeSeq}/${ts.key}: turns[].inferredDeps 不是 node:turn 那份的前 20 项前缀`;
    }
    add(`⑫turns[].inferredDeps 是事件那份的前 20 项前缀(${checked} 轮)`, !bad, bad);
  }

  /* ── ⑬ 归档下来的 `receipt.json` 里,**凡是已经重写成 `xxxRef` 的东西,原来那条
        canonical 绝对路径 `xxxPath` 必须删掉**(§1.3)。
        ⚠️ 这不是洁癖。canonical 区的 `<outDir>/nodes/<id>.md` 会被同 id 带 `force` 的下一波
           **原地覆盖**;归档回执里留着那条路径,就是给读的人一条"打开这个"的指示,
           而打开之后读到的是**另一次运行**的字节 —— 伪造历史,比缺失更糟。
        ⚠️ 这条规则早先只落实到 `diffPath` 一个字段,`artifactPath` 三层原样留着。所以这里
           **不按字段名列清单**(列清单就是等着漏下一个),而是按 `xxxRef` 反推它自己那个
           `xxxPath` —— 新增一层 ref 时这条断言自动跟着覆盖到新的那一层。
        ⚠️ 判据**不是**"长得像绝对路径就违规":`workspace.path` 是 worktree 的绝对路径,
           §5.8 点名要它(回执没归档成功时,那是人**找回现场**的唯一线索),它没有对应的
           `workspaceRef`,也不指向任何"归档声称保住了的"文件。 */
  if (opt.archiveRoot) {
    // ⚠️ `gid` 在 ⑤ 那个块里是块级的,这里要自己取一份(否则运行时 ReferenceError ——
    //    而那正是"检查器自己炸掉"那一类:一条都没查成,却看不出是哪条不成立)。
    const gid = lines.length ? lines[0].graphId : null;
    const scan = (o, at, hits, nodePrefix) => {
      if (Array.isArray(o)) { o.forEach((x, i) => scan(x, `${at}[${i}]`, hits, nodePrefix)); return; }
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        if (!k.endsWith("Ref")) continue;
        const twin = `${k.slice(0, -3)}Path`;
        if (twin in o) hits.push(`${at}.${twin} 与 ${k} 并存(=${o[twin]})`);
        /* ⚠️ **只查"没有并存"是不够的** —— 那只能证明 canonical 那条路径删掉了,
              证明不了**换上去的这一条是对的**。
           ⚠️ 也**不能只查"在本 graph 内"**:同一个 graph 里别的节点的目录同样满足那个前缀,
              于是一条指向**另一个节点**的 ref 照样全绿,页面会拿到一个 200 —— 内容是别人的。
              §1.3 要的是**闭包到当前 `<nodeSeq>-<id>/`**,所以这里按那个前缀验;
              再加一条"文件/目录真的在",把指向不存在路径的死链接也挡掉
              (⑧ 只遍历**事件**里的 AssetState,不会打开 receipt.json 去看里面这些裸 ref)。
           ⚠️ `refLooksLegal` **返回的是原因字符串,合法时才是 null** —— 别写成 `!refLooksLegal(…)`,
              那会把判据整个反过来:合法的全报错、非法的全放行,而且照样"有断言"。 */
        const v = o[k];
        if (v === null || v === undefined) continue;   // 键在、值为 null = "本来就没有",合法
        const why = typeof v === "string" ? refLooksLegal(v, gid) : "不是字符串";
        if (why) { hits.push(`${at}.${k} ${why}(=${JSON.stringify(v)})`); continue; }
        if (!v.startsWith(nodePrefix)) {
          hits.push(`${at}.${k} 不在本节点的归档目录里(应以 ${nodePrefix} 开头,拿到 ${v})`);
        } else if (!fs.existsSync(path.join(opt.archiveRoot, v))) {
          hits.push(`${at}.${k} 指向一个不存在的路径(=${v})`);
        }
      }
      // `sceneRef` 的那一份原件是个**目录**,它的 canonical 路径记在 `scene.dir` 上。
      if ("sceneRef" in o && o.scene && typeof o.scene === "object" && "dir" in o.scene)
        hits.push(`${at}.scene.dir 与 sceneRef 并存(=${o.scene.dir})`);
      for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") scan(v, `${at}.${k}`, hits, nodePrefix);
    };
    /* nodeSeq → id(`id` 只出现在 node:observed 上)。 */
    const idOf = new Map();
    for (const l of lines) if (l.event === "node:observed") idOf.set(l.payload.nodeSeq, l.payload.id);
    const hits = [];
    let files = 0;
    for (const l of lines) {
      const r = l.event === "node:settled" ? l.payload.receipt : null;
      if (!r || r.state !== "present") continue;
      /* ⚠️ **本节点的归档目录要从「这条事件说自己是哪个节点」算出来,不能从 ref 自己推。**
            早先这里写的是 `r.ref.replace(/\/[^/]*$/, "/")` —— 拿被检查的那个值去算它自己的
            合格标准,**等于没检查**:把节点 A 的 `receipt` 整个换成节点 B 那份真回执,
            B 的内部引用彼此自洽、目标文件也都在,⑧ 与 ⑬ 一起全绿 ——
            而页面会在 A 名下端出 B 的回执。**跨节点的证据错配,而且看起来毫无异常。** */
      const nodeId = idOf.get(l.payload.nodeSeq);
      const nodePrefix = `nodes/.runs/${gid}/${l.payload.nodeSeq}-${nodeId}/`;
      if (nodeId === undefined) { hits.push(`#${l.payload.nodeSeq}: 有 node:settled 却没有 node:observed`); continue; }
      if (r.ref !== `${nodePrefix}receipt.json`) {
        hits.push(`#${l.payload.nodeSeq} 的 receipt.ref 不是本节点那一份(应为 ${nodePrefix}receipt.json,拿到 ${r.ref})`);
        continue;
      }
      const p = path.join(opt.archiveRoot, r.ref);
      if (!fs.existsSync(p)) continue;         // ⑧ 已经在管"文件在不在",这里不重复报
      files++;
      let j;
      try { j = JSON.parse(fs.readFileSync(p, "utf8")); }
      catch (e) { hits.push(`${r.ref}: 读不出来(${e.message})`); continue; }
      scan(j, r.ref, hits, nodePrefix);
    }
    add(`⑬${files} 份归档回执:ref 闭包到本节点、目标存在、canonical 路径已抹掉`, hits.length === 0, hits.slice(0, 3).join(" | "));
  }

  return R;
}
