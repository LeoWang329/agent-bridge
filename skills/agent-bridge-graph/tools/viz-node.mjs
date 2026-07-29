/**
 * 节点级观测适配器 —— `node-core` 的插桩点全部打在这里。
 *
 * 一个节点一个实例(`run.viz`)。**viz 关着时 `run.viz` 恒为 null**,于是所有插桩点
 * 都是 `if (run.viz)` 一句 —— 没有第二条代码路径可漂。
 *
 * ⚠️ **这个文件里的每个方法都必须是 non-throwing 的。** 观测层随便抛一个异常上去
 * 就会把节点的**业务结局**改掉(`runNode` 那条路变 `unknown`;`conversation` 那条路
 * 会顺着 `turn()` 冒进用户回调,最后成 `callback_error`)。所以下面统一用 `guard()` 包一层。
 */

import crypto from "node:crypto";
import { NOT_APPLICABLE, unavailable, stableJson } from "./viz-graph.mjs";

/** `node:progress` 的节流窗口。丢一条无所谓 —— 下一条 5 秒后就来。 */
const PROGRESS_THROTTLE_MS = 5000;
/** `node:progress.tail` 天生有界:末 240 个 UTF-16 code unit。 */
const TAIL_UNITS = 240;

const sha256Text = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/**
 * 按 code unit 截断会**切开代理对**(半个 emoji)。合同(§5.7)定死:
 * 切完之后若首字符是落单的**低代理**,把它丢掉;剩下的原样发。
 *
 * ⚠️ **不许因此声称这里的单位是"Unicode 字符"** —— 丢掉半个代理对只是防止页面上
 * 冒出一个 `U+FFFD`,并没有把计量口径从 code unit 改成字符。
 */
export function trimLoneSurrogate(s) {
  const c = s.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? s.slice(1) : s;
}

/** 把任何东西变成一句话。**不能直接 `String(x)`** —— `throw Object.create(null)` 会让它自己再抛。 */
function msgOf(e) {
  try {
    if (e instanceof Error) return e.message || e.name || "(无消息)";
    if (e === null || e === undefined) return String(e);
    if (typeof e === "object") return JSON.stringify(e) ?? "(无法序列化)";
    return String(e);
  } catch { return "(连描述都取不出来)"; }
}

/**
 * @param scope  graph 作用域(`viz-graph.mjs`)
 * @param nodeSeq 本 graph 内的实例序号
 * @param spec   已规范化的任务单
 */
export function createNodeViz(scope, nodeSeq, spec) {
  const archive = scope.archiveFor(nodeSeq, spec.id);
  /** 每一轮的归档资产。`turnKey` → { input, output, scene, attempts: Map<n, {input, output}> } */
  const turns = new Map();
  /** 已经发过终态的轮。见 `turnSettled` 里那条幂等。 */
  const settledTurns = new Set();
  let lastProgressAt = 0;

  const turnOf = (key) => {
    let e = turns.get(key);
    if (!e) { e = { input: null, output: null, scene: null, attempts: new Map() }; turns.set(key, e); }
    return e;
  };

  /** 统一的兜底。**观测层永远无权改变节点的业务结局。** */
  const guard = (fn) => async (...args) => { try { return await fn(...args); } catch { /* 观测失败不外溢 */ } };

  /* ---------------- node:observed ---------------- */

  const observed = guard(async () => {
    // `input.json` —— **只是 spec 的快照,不兼任资产目录**:它不列举归档里有哪些文件
    // (那是各条事件的职责),也不含 prompt / role 的正文(这里只放指纹)。
    // ⚠️ 这 15 个键**恒在**;没设置的写 null,**不省略键**(键集固定才谈得上"可对比")。
    const isConv = spec.kind === "conversation";
    const specAsset = await archive.putJson("input.json", {
      id: spec.id, nodeSeq,
      agent: spec.agent, model: spec.model ?? null, effort: spec.effort ?? null,
      access: spec.access, cwd: spec.cwd,
      // ⚠️ 对话节点这五个键**恒为 null**:它们是**逐轮**参数,写在顶层任务单上直接 UsageError。
      //    为 null 不是"没设置",是"这一层没有这个概念" —— 页面不许显示成"用了默认值"。
      timeoutMs: isConv ? null : (spec.timeoutMs ?? null),
      reask: isConv ? null : (spec.reask ?? null),
      schema: isConv ? null : (spec.schema === undefined ? null : spec.schema),
      outputShape: isConv ? null : (spec.outputShape === undefined ? null : spec.outputShape),
      promptSha256: isConv ? null : sha256Text(spec.promptBody ?? ""),
      baseRef: spec.baseRef ?? null,
      roleSha256: spec.roleBody == null ? null : sha256Text(spec.roleBody),
      specHash: spec.specHash,
    });

    const role = spec.roleBody == null ? NOT_APPLICABLE : await archive.putText("role.md", spec.roleBody);

    // 单轮节点的 prompt **就是** turns/main/prompt.md 那一份字节 —— 不另存一份。
    // ⚠️ 两份"本该相同"的字节迟早会被改成不同,所以这里只有一个文件、一个 sha。
    let prompt;
    if (isConv) {
      // 对话节点**没有节点级 prompt**(第一句话要到 node:turn 才出现)。
      // 页面据这个 `not-applicable` 判别「这是不是一段对话」——它是唯一判据。
      prompt = NOT_APPLICABLE;
    } else {
      prompt = await archive.putText("turns/main/prompt.md", spec.promptBody ?? "");
      turnOf("main").input = prompt;
    }

    const payload = {
      nodeSeq, id: spec.id, agent: spec.agent, access: spec.access, cwd: spec.cwd,
      model: spec.model ?? null, effort: spec.effort ?? null,
      declaredDeps: spec.declaredDeps ?? [],
      inferredDeps: spec.inferredDeps ?? [],
      inferredDepsTruncated: spec.inferredDepsTruncated ?? false,
      spec: specAsset, prompt, role,
    };
    // `group` 不传 → **整个键不出现**(不是 null)
    if (spec.group !== undefined && spec.group !== null) payload.group = String(spec.group);
    await scope.emit("node:observed", payload);
  });

  /* ---------------- node:rejected ---------------- */

  // ⚠️ `phase` 与 `error` 是**两个独立的事实**,这里不许互相推断:`error` 恒是抛出去
  //    那个异常的消息(根因优先),`phase` 由调用方按 §5.3 的决策树给出。
  const rejected = guard(async (phase, err) => {
    await scope.emit("node:rejected", { nodeSeq, phase, error: msgOf(err) });
  });

  /* ---------------- 轮 ---------------- */

  const turnStarted = guard(async (t) => {
    // 该轮冻结的提问。**先归档、再发引用它的事件** —— 顺序反了页面会读到 404。
    const body = t.promptBody ?? "";
    const input = await archive.putText(`turns/${t.key}/prompt.md`, body);
    turnOf(t.key).input = input;
    // ⚠️ 指纹算**正文本身**,不取 `input.sha256` —— 归档失败时那边是 unavailable、没有 sha,
    //    而"这一轮问了什么"这个事实与归档成没成功无关。
    const inputSha256 = sha256Text(body);
    await scope.emit("node:turn", {
      nodeSeq, turnKey: t.key, input, inputSha256,
      timeoutMs: t.timeoutMs, reask: t.reask ?? 0,
      inferredDeps: t.inferredDeps ?? [],
      inferredDepsTruncated: t.inferredDepsTruncated ?? false,
    });
  });

  // 「这一轮拿到执行名额、开始烧预算」。⚠️ 不是「这个节点第一次开跑」——
  // 每一轮各自排队、各自起钟,所以一个节点有几轮就有几条。
  const turnGateAcquired = guard(async (t, queuedMs) => {
    await scope.emit("node:started", { nodeSeq, turnKey: t.key, queuedMs: Math.max(0, Math.round(queuedMs)) });
  });

  const turnSettled = guard(async (t, rec) => {
    // ⚠️ **幂等做在这里,不靠调用点自觉。** 「一轮恰好一条终态」是页面归位的地基:
    //    两条 `node:turn-settled{turnKey:"draft"}` 会让页面按 key 建的 map 把前一条盖掉。
    if (settledTurns.has(t.key)) return;
    settledTurns.add(t.key);
    const e = turnOf(t.key);
    /* 该轮产出 = **本轮最后一次成功复制的那一项 attempt 的 output** —— 直接沿用它的资产,
       **不再拷一份**。

       ⚠️ 这里曾经把它另存成 `turns/<key>/attempt-last.output.md`。那是同一段字节的
          **第二个副本**,而归档布局(§1.3)里根本没有这个文件名:
          - 合同要求 `TurnSummary.output.sha256 === 该轮最后一次成功复制的 attempt 的 output.sha256`,
            也要求顶层 `artifact` 指向 `attempt-<n>.output.md` —— 两处指着**不同的 ref**,
            页面上"这一轮的产出"和"这个环节的产出"就成了两个可点的东西,点开却是一样的内容;
          - 更要命的是合同对这类副本的判词:**两份"本该相同"的字节迟早会被改成不同**。
       ⚠️ 一次成功复制都没有过 → source-missing(「没能开始的轮」恒落在这一格)。
          复制**试过但失败**时,沿用那一项的 unavailable(code 相同)—— 与顶层 artifact 同一条规则:
          宁可说"给不出",也不要一个指向不存在文件的死链接(页面会把死链接显示成"点得开")。 */
    let output = unavailable("source-missing");
    for (const [, slot] of e.attempts) if (slot.hadLocal) output = slot.output ?? unavailable("source-missing");
    e.output = output;

    /* 现场是**轮级**的(一段对话可能有多份)。
       ⚠️ `not-applicable` 的含义是「**本来就不该有**」,只有 status 为 `ok` / `not-started` 时成立
          (那两种压根不跑 saveScene)。其余状态下 `saveScene` 是**跑过的**,没拿到就得说
          「该保没保成」—— 标成 not-applicable 是把"没保住现场"谎报成"本来就没有现场",
          而现场恰恰是这几档唯一能自证的东西。 */
    const shouldHaveScene = rec.status !== "ok" && rec.status !== "not-started";
    let scene = shouldHaveScene ? unavailable(rec.sceneError || "save-failed") : NOT_APPLICABLE;
    /* ⚠️ **本节点的归档子目录都没建起来时,不许说"scene present、三个槽各自 unavailable"。**
          那句话的意思是「目录在,只是里面三样都没保成」—— 而事实是**这次归档里压根没有
          这个目录**。§3.2 给了专门的一档:整个 `SceneState` 是
          `unavailable{code:"archive-root-failed"}`。 */
    if (rec.scene && rec.scene.dir && archive.rootFailed) {
      scene = unavailable("archive-root-failed");
    } else if (rec.scene && rec.scene.dir) {
      const files = {};
      // 左边是**磁盘上的文件名**,右边是**合同里的逻辑名**(§3.2)。两者刻意不同名。
      for (const [name, slot] of [["session.log", "sessionLog"], ["answer.txt", "answer"], ["status.json", "status"]]) {
        /* ⚠️ **逐槽定死,不许套用同一句**(§3.2):三个槽里**只有 `status` 有 not-applicable 这一档**
              (没有 sessionId ⇒ 会话压根没建起来 ⇒ 无状态可查)。另外两个一旦进了 saveScene
              就都是"本该拿得到"的,给不出就得说给不出。 */
        files[slot] = (rec.scene.files || []).includes(name)
          ? await archive.putFile(`turns/${t.key}/scene/${name}`, `${rec.scene.dir}/${name}`)
          : (slot === "status" && rec.scene.hadSession === false ? NOT_APPLICABLE : unavailable("source-missing"));
      }
      scene = { state: "present", files };
      e.scene = scene;
    }

    const payload = {
      nodeSeq, turnKey: t.key,
      status: rec.status,
      sessionReusable: rec.sessionReusable === true,
      output, scene,
      charCount: typeof rec.charCount === "number" ? rec.charCount : null,
      durationMs: Math.max(0, Math.round(rec.durationMs ?? 0)),
    };
    if (rec.error) payload.errorSummary = String(rec.error);
    await scope.emit("node:turn-settled", payload);
  });

  /* ---------------- 尝试 ---------------- */

  const attemptStarted = guard(async (t, att, body) => {
    const e = turnOf(t.key);
    // ⚠️ **第 1 次的输入不另存一份**:该轮第一次发的就是这一轮 prompt 的原文,
    //    所以 `n === 1` 的 input 直接指向 `turns/<key>/prompt.md`,
    //    且它的 `inputSha256` **必然等于** `node:turn.input` 的 sha(这是可验的断言,不是约定)。
    const input = att.n === 1
      ? (e.input ?? unavailable("source-missing"))
      : await archive.putText(`turns/${t.key}/attempt-${att.n}.input.md`, body);
    if (input.state === "present") att.inputRef = input.ref;
    e.attempts.set(att.n, { input, output: null });
    await scope.emit("node:attempt", {
      nodeSeq, turnKey: t.key, n: att.n, input, inputSha256: att.inputSha256,
    });
  });

  const attemptSettled = guard(async (t, att) => {
    const e = turnOf(t.key);
    const slot = e.attempts.get(att.n) || { input: unavailable("source-missing"), output: null };
    // ⚠️ `status` 与 `output` 是**两个维度,不能合并**:status 说这次尝试的结局,
    //    AssetState 说证据有没有被成功归档。存在"文件已复制成功、后续本地处理才失败"
    //    这个窗口 —— 那时 status 是 failed 而 output 仍是 present。
    const output = att.artifactPath
      ? await archive.putFile(`turns/${t.key}/attempt-${att.n}.output.md`, att.artifactPath)
      : unavailable("source-missing");
    slot.output = output;
    /* ⚠️ **「本地复制成功」与「归档成功」是两件事**,而"最后一次成功复制的那一份"说的是前者。
          归档失败时 output 是 unavailable,但那一项**仍然是**最后一次成功复制的那一项 ——
          轮产出与顶层 artifact 都该沿用它(带着相同的 code),这就是合同说的"同生同灭"。
          没有这个标志,判据只能退化成"最后一个有 output 槽的" —— 于是
          「第 1 次归档成功、第 2 次连产出都没有」会让页面把一份**真实存在、点得开**的产出
          说成"拿不到"。 */
    slot.hadLocal = !!att.artifactPath;
    e.attempts.set(att.n, slot);

    const payload = {
      nodeSeq, turnKey: t.key, n: att.n, status: att.status, output,
      durationMs: typeof att.durationMs === "number" ? Math.max(0, Math.round(att.durationMs)) : null,
      charCount: typeof att.charCount === "number" ? att.charCount : null,
    };
    if (att.status === "rejected" && att.rejectedReason != null) {
      payload.rejectedReason = String(att.rejectedReason);
    }
    await scope.emit("node:attempt-settled", payload);
  });

  /* ---------------- 活进度 ---------------- */

  const progress = guard(async (t, snap, nowMs, attemptN = 1) => {
    if (!snap) return; // 快照取不到就**不发**
    if (nowMs - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = nowMs;
    // ⚠️ 连长度都给不出的快照**整条不发**(§5.7)。补一个 0 或 null 都是伪造证据:
    //    页面会把"没测到"画成"活着但一个字没产出"。
    if (!Number.isSafeInteger(snap.charCount) || snap.charCount < 0) return;
    await scope.emit("node:progress", {
      nodeSeq, turnKey: t.key, n: attemptN,
      status: String(snap.status ?? "running"),
      charCount: snap.charCount,
      // 天生有界:末 240 个 UTF-16 code unit。**不许降级**(降级会凭空多一个形状)。
      tail: trimLoneSurrogate(String(snap.tail ?? "").slice(-TAIL_UNITS)),
      // 恒在、可 null —— 「没这个键」不是一种状态。
      lastEvent: snap.lastEvent ?? null,
      contextUsage: snap.contextUsage ?? null,
    });
  });

  /* ---------------- 工作副本 ---------------- */

  const workspaceIntent = guard(async (info) =>
    scope.emit("node:workspace-intent", {
      nodeSeq, path: String(info.path), branch: String(info.branch), baseCommit: String(info.baseCommit),
    }));

  const workspaceCreated = guard(async (info) =>
    scope.emit("node:workspace-created", {
      nodeSeq, path: String(info.path), branch: String(info.branch), baseCommit: String(info.baseCommit),
    }));

  /* ---------------- node:settled ---------------- */

  /** 把一条回执里的**每一层**相对 ref 重写到本节点的归档目录。
   *
   *  ⚠️ **新增一层就要重写一层。** 漏掉 `turns[]` 里那些,页面点开的就是 canonical 区里
   *  会被下一波 `force` 覆盖的文件 —— 那不是"缺信息",是**伪造历史**,比缺失更糟。 */
  /** 本节点归档里那份 diff 的 ref(没归档成功就是 null)。 */
  const diffRefOf = () => (archivedDiff && archivedDiff.state === "present" ? archivedDiff.ref : null);

  function rewriteReceipt(receipt) {
    const refOf = (a) => (a && a.state === "present" ? a.ref : null);
    const out = JSON.parse(JSON.stringify(receipt));
    /* ⚠️ **换成 ref 之后要把 canonical 那条绝对路径删掉,每一层都删。**
          理由与下面 `diffPath` 那条**一模一样**:canonical 区的 `<outDir>/nodes/<id>.md`
          会被同 id 带 `force` 的下一波**原地覆盖**。归档回执里留着它,等于给读的人一条
          "打开这个"的指示,而打开之后读到的是**另一次运行**的字节 —— 伪造历史,比缺失更糟。
          ⚠️ 早先只删了 `diffPath`,`artifactPath` 三层(顶层 / 轮 / 每次尝试)原样留着。
             同一条规则只应用到一个字段上,是这份代码里已经栽过一次的坑(§1.3 那句
             "新增一层就要重写一层"说的就是它)。 */
    const dropCanonical = (o) => { if (o && typeof o === "object") delete o.artifactPath; };
    const doTurn = (turnRec, e) => {
      if (!e) return;
      turnRec.artifactRef = refOf(e.output);
      /* ⚠️ **和同一份回执里其它 ref 用同一个基准：out-dir。**
            早先这里发的是裸的 `turns/<key>/scene` —— 而 `artifactRef`/`diffRef`/`inputRef`
            全都是 `nodes/.runs/<graphId>/<nodeSeq>-<id>/…`。同一个 JSON 里两种基准、
            却都叫 `xxxRef`，消费方按同一套解析必然解错；serve.mjs 那道闸更是明确要求
            `nodes/.runs/<graphId>/` 开头，拿裸路径去取现场只会拿到 403。 */
      turnRec.sceneRef = e.scene && e.scene.state === "present"
        ? `${archive.relDir}/turns/${turnRec.key ?? "main"}/scene` : null;
      dropCanonical(turnRec);
      // 现场目录同理:`sceneRef` 已经指向归档里那一份,`dir` 是 canonical 区的绝对路径。
      if (turnRec.scene && typeof turnRec.scene === "object") delete turnRec.scene.dir;
      for (const a of turnRec.attempts || []) {
        const slot = e.attempts.get(a.n);
        a.inputRef = refOf(slot?.input);
        a.artifactRef = refOf(slot?.output);
        dropCanonical(a);
      }
    };
    if (Array.isArray(out.turns)) {
      for (const tr of out.turns) doTurn(tr, turns.get(tr.key));
    } else {
      // runNode:这一轮**就是**回执本身,轮 key 恒为 "main"
      out.key = "main";
      doTurn(out, turns.get("main"));
      delete out.key;
    }
    /* ⚠️ **顶层 `diffRef` 也要重写** —— 归档必须是**传递闭包**(§1.3)。
          漏掉它,归档下来的回执仍指着 canonical 区那个 `diffPath`,而同一个 id 带 `force`
          再跑一遍就会把那份文件覆盖掉。于是打开**第一次**的回执,读到的是**第二次**的 diff:
          那不是"缺信息",是**伪造历史**,比缺失更糟。 */
    if (out.workspace && typeof out.workspace === "object") {
      out.workspace.diffRef = diffRefOf();
      if ("diffPath" in out.workspace) delete out.workspace.diffPath;
    }
    /* ⚠️ **无条件写,不许"原来有这个键才写"。** 回执上 diff 只挂在 `workspace.diffPath` 上,
          顶层压根没有 `diffRef`/`diffPath` —— 用"有才改"的守卫就等于**永远不写**,
          而 §1.3 的传递闭包点名要求顶层这一份。write 节点交付成功、diff 也归档成功,
          按合同去读顶层 `diffRef` 的消费方却什么都拿不到。
          ⚠️ read 节点与 no-changes 没有 diff —— 那时它是 `null`(**键在、值为 null**,
          不是省略:同 §3.1 "不许用缺席表达未知"的口径)。 */
    out.diffRef = diffRefOf();
    delete out.diffPath;
    return out;
  }

  /**
   * 节点终态。
   *
   * @param receipt   finish 返回的那份内存对象
   * @param turnSummaries 由调用方按 §5.8 投影好的 `turns[]`
   * @param diffAsset diff 的资产状态(read 节点 / no-changes → not-applicable)
   */
  const settled = guard(async (receipt, turnSummaries, diffAsset) => {
    const receiptAsset = await archive.putJson("receipt.json", rewriteReceipt(receipt));

    // 顶层产出 = **最后一个** output 是 present 的那一轮,取该轮最后一次成功复制的那次尝试。
    // ⚠️ `artifact` 与它所指的那一项 output **同生同灭**:那一项归档失败时 artifact 也只能
    //    是 unavailable 且 **code 相同** —— ref 指向一个不存在的文件就是死链接,
    //    而死链接比"给不出"更坏(页面会显示成"点得开")。
    let artifact = unavailable("source-missing");
    for (const ts of turnSummaries) {
      const e = turns.get(ts.key);
      if (!e) continue;
      /* ⚠️ 同 turnSettled:判据是**这一项本地复制成功了没有**(`hadLocal`),不是"它有没有 output 槽"。
            用后者的话,一次"连产出都没拿到"的尝试会把前一次**已经保住**的产出盖掉。 */
      let last = null;
      for (const [, slot] of e.attempts) if (slot.hadLocal) last = slot.output ?? null;
      if (last) artifact = last;
    }

    const payload = {
      nodeSeq,
      status: receipt.status,
      execution: receipt.execution === "reused" ? "reused" : "fresh",
      durationMs: Math.max(0, Math.round(receipt.durationMs ?? 0)),
      receipt: receiptAsset,
      artifact,
      diff: diffAsset ?? NOT_APPLICABLE,
      turns: turnSummaries,
    };
    // ⚠️ `outcome` **只有 write 节点才有**(read 节点是**缺席**,不是 null)——
    //    页面用"缺席"判 read/write,不用 access 猜。
    if (receipt.access === "write" && receipt.outcome) payload.outcome = receipt.outcome;
    // 这两样**只在回执没归档成功时**出现:回执在的时候页面自己去回执里读,
    // 内联一份就是同一事实的第二个副本。
    if (receiptAsset.state !== "present") {
      if (receipt.error) payload.errorSummary = String(receipt.error);
      if (receipt.workspace) {
        const w = receipt.workspace;
        /* ⚠️ **六个键一个都不能少**(§5.8):这是回执没归档成功时"人怎么找到现场"的唯一线索。
              早先这里是 `if (w[k]) ws[k] = …` —— 拿不到就**整个键不出现**,于是一份
              `{removed:true}` 照样合法,而页面连"该去核对哪个目录、基于哪个提交"都说不出。
              拿不到的用 `null`:**不许用缺席表达未知**(同 §3.1 对 AssetState 的口径)。
              ⚠️ 不发 `filesChanged`(无上限)、不发 `committed`(交付结论只认 `outcome`)。 */
        // ⚠️ 拿不到一律 `null`。早先这里对 path / baseCommit 用 `?? ""` 顶替 ——
        //    而 `baseCommit` 是按 `hex40` 校验的,空串会让整条 node:settled 记录失败。
        const str = (v) => (typeof v === "string" && v ? v : null);
        payload.workspaceSummary = {
          path: str(w.path),
          branch: str(w.branch),
          baseCommit: str(w.baseCommit),
          headCommit: str(w.headCommit),
          removed: w.removed === true,
          // 「我们**确知**这棵树里有没有改动」。false = git 探测失败,既不能说有也不能说没有。
          changesKnown: w.changesKnown === true,
        };
      }
    }
    await scope.emit("node:settled", payload);
  });

  /** 归档一份 diff(write 节点收尾时调)。 */
  let archivedDiff = null;
  const putDiff = guard(async (diffPath) => {
    archivedDiff = await archive.putFile("change.diff", diffPath);
    return archivedDiff;
  });

  /** 归档某一轮的产出(复用命中时用 —— 那条路不跑 runTurn,但产出必须照样归档)。 */
  const putTurnOutput = guard(async (key, srcPath, n = 1) => {
    const e = turnOf(key);
    const a = await archive.putFile(`turns/${key}/attempt-${n}.output.md`, srcPath);
    e.output = a;
    e.attempts.set(n, { input: e.attempts.get(n)?.input ?? unavailable("fingerprint-only"),
                        output: a, hadLocal: true });
    return a;
  });

  /**
   * 复用命中时,**把 attempt 1 的输入原文找回来**(§5.9)。
   *
   * 一轮的 attempt 1 发的就是这一轮 `prompt` 的原文,而这一次**重新冻结过同一段正文**
   * (`turnSpecHash` 已经逐项比对过 ⇒ 必然是同一份字节)。所以它不是"够不着",
   * 是**这一次手里就有**。早先无条件标 `fingerprint-only`,等于对着一份**正躺在归档里**
   * 的原文说"只剩指纹了" —— 而复审时第一件想看的就是"当初到底问了什么"。
   *
   * ⚠️ **落盘之前必须拿候选的 SHA 与回执里的 `inputSha256` 逐字节对证**(§5.9 明写)。
   *    对不上就老老实实退回 `fingerprint-only` —— **既不造内容,也不给死链接**。
   *    (指纹对上不算伪造历史;被禁止的是**无校验的重构**。)
   * ⚠️ 只对 `n === 1`。n≥2 的输入是当时按模板拼出来的重说提示,这一次没有它,只剩指纹。
   */
  const recoverAttemptInput = guard(async (key, n, body, expectSha) => {
    if (n !== 1 || typeof body !== "string" || !/^[0-9a-f]{64}$/.test(expectSha || "")) {
      markFingerprintOnly(key, n); return;
    }
    /* ⚠️ **先对指纹,再落盘 —— 顺序反了就等于"先写下来再看对不对"。**
          §5.9 的原话是「只有候选的 SHA 与 `inputSha256` 逐字节一致**才落盘并给出 present**」。
          先写后验的话:对不上时事件确实降级成了 `fingerprint-only`,可归档区里已经躺着
          一份**没能自证的候选正文** —— 一份谁也说不清来历的文件,恰恰是这套归档最不该有的东西。
          (而且 runNode 那条路上 `node:observed` 已经把同一个 `prompt.md` 写过一次了,
           先写后验还会**无谓地重写它一遍**。) */
    if (sha256Text(body) !== expectSha) { markFingerprintOnly(key, n); return; }
    const e = turnOf(key);
    /* 已经归档过同一份字节(runNode 的 `node:observed` 就干了这件事)就直接沿用 ——
       同一段正文只该有一个文件、一个 sha。 */
    const a = (e.input && e.input.state === "present" && e.input.sha256 === expectSha)
      ? e.input
      : await archive.putText(`turns/${key}/prompt.md`, body);
    if (a.state !== "present" || a.sha256 !== expectSha) { markFingerprintOnly(key, n); return; }
    e.input = a;
    const slot = e.attempts.get(n) || { input: null, output: null };
    slot.input = a;
    e.attempts.set(n, slot);
  });

  /** 复用命中时,输入原文当初可能压根没落盘 —— 那是**当时的选择,不是故障**。 */
  const markFingerprintOnly = (key, n) => {
    const e = turnOf(key);
    const slot = e.attempts.get(n) || { input: null, output: null };
    slot.input = unavailable("fingerprint-only");
    e.attempts.set(n, slot);
  };

  /**
   * 复用命中时,**非最后一次**尝试的产出够不着。
   *
   * ⚠️ **这句话曾经写的是「一轮之内每次尝试覆盖同一个 `artifactPath`,所以磁盘上只剩最后那一份」
   *    —— 相对 v2 已经过时,而且照它实现过一次:复用时只归档最后那份、其余标成"只剩指纹",
   *    等于否认几份确实还在磁盘上的证据。** v2 起 canonical 区**每次尝试各存一份**
   *    审计原件(`<id>.a<n>.md`),所以正常情况下每一次都归档得到;真正落到这里的只剩两种:
   *    当初 **viz 关着**、或那一次压根没落盘。
   * 早先那几次的归档在**上一次运行的归档区**里,而合同不许跨 graph 引用。
   * 这与"从来没有过产出"(`source-missing`)是两件事,所以用同一个 `fingerprint-only`:
   * 它表达的正是「记录在,东西够不着,而且这不是故障」。
   * ⚠️ **不打 `hadLocal`** —— 这一项没有本地副本,不该参与"最后一次成功复制"的选取。
   */
  const markOutputFingerprintOnly = (key, n) => {
    const e = turnOf(key);
    const slot = e.attempts.get(n) || { input: null, output: null };
    if (!slot.output) slot.output = unavailable("fingerprint-only");
    e.attempts.set(n, slot);
  };

  return {
    nodeSeq, archive,
    observed, rejected,
    turnStarted, turnGateAcquired, turnSettled,
    attemptStarted, attemptSettled, progress,
    workspaceIntent, workspaceCreated,
    settled, putDiff, putTurnOutput, markFingerprintOnly, markOutputFingerprintOnly,
    recoverAttemptInput,
    /** 某一轮某次尝试的归档状态(调用方投影 `turns[]` 时要用)。 */
    assetsOf: (key) => turns.get(key) || null,
  };
}

/** 把内存里的轮记录投影成 §5.8 的 `TurnSummary`。
 *
 *  ⚠️ **`turns[]` 里不含"没能开始的轮"** —— 它是**复用判据**,塞一条从没跑过的轮进去,
 *  下一次回放就会拿它去比对一份**根本不存在的产出**,把一张好回执判死。 */
export function toTurnSummaries(turnRecs, viz) {
  return turnRecs.map((r) => {
    const e = viz ? viz.assetsOf(r.key) : null;
    const attempts = (r.attempts || []).map((a) => {
      const slot = e ? e.attempts.get(a.n) : null;
      const item = {
        n: a.n, status: a.status,
        inputSha256: a.inputSha256,
        input: slot?.input ?? unavailable("fingerprint-only"),
        output: slot?.output ?? unavailable("source-missing"),
      };
      if (a.status === "rejected" && a.rejectedReason != null) item.rejectedReason = String(a.rejectedReason);
      return item;
    });
    return {
      key: r.key,
      status: r.status,
      sessionReusable: r.sessionReusable === true,
      output: e?.output ?? unavailable("source-missing"),
      turnSpecHash: r.turnSpecHash,
      charCount: typeof r.charCount === "number" ? r.charCount : null,
      durationMs: Math.max(0, Math.round(r.durationMs ?? 0)),
      inferredDeps: (r.inferredDeps ?? []).slice(0, 20),
      inferredDepsTruncated: (r.inferredDeps ?? []).length > 20 || r.inferredDepsTruncated === true,
      attempts,
    };
  });
}

export { stableJson };
