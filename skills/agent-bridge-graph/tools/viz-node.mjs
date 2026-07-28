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
    const input = await archive.putText(`turns/${t.key}/prompt.md`, t.promptBody ?? "");
    turnOf(t.key).input = input;
    await scope.emit("node:turn", {
      nodeSeq, turnKey: t.key, input,
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
    // 该轮产出。**一次成功复制都没有过** → source-missing(「没能开始的轮」恒落在这一格)。
    const output = rec.artifactPath
      ? await archive.putFile(`turns/${t.key}/attempt-last.output.md`, rec.artifactPath)
      : unavailable("source-missing");
    // ⚠️ 顶层产出**不另存一份**:`node:settled.artifact` 指向的是最后一次成功复制的那份
    //    `attempt-<n>.output.md`。这里这份 `attempt-last` 只是该轮 output 的载体 ——
    //    见 settled() 里那段:artifact 直接沿用**那一项 attempt 的 ref**,不指这里。
    e.output = output;

    // 现场是**轮级**的(一段对话可能有多份)。正常收场根本不保现场 → not-applicable。
    let scene = NOT_APPLICABLE;
    if (rec.scene && rec.scene.dir) {
      const files = {};
      for (const [name, slot] of [["session.log", "session.log"], ["answer.txt", "answer.txt"], ["status.json", "status.json"]]) {
        files[slot] = (rec.scene.files || []).includes(name)
          ? await archive.putFile(`turns/${t.key}/scene/${name}`, `${rec.scene.dir}/${name}`)
          : NOT_APPLICABLE;
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

  const progress = guard(async (t, snap, nowMs) => {
    if (!snap) return; // 快照取不到就**不发**
    if (nowMs - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = nowMs;
    const payload = {
      nodeSeq, turnKey: t.key,
      status: String(snap.status ?? "running"),
      charCount: typeof snap.charCount === "number" ? snap.charCount : null,
      // 天生有界:末 240 个 UTF-16 code unit。**不许降级**(降级会凭空多一个形状)。
      tail: String(snap.tail ?? "").slice(-TAIL_UNITS),
    };
    if (snap.contextUsage) payload.contextUsage = snap.contextUsage;
    if (snap.lastEvent) payload.lastEvent = snap.lastEvent;
    await scope.emit("node:progress", payload);
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
  function rewriteReceipt(receipt) {
    const refOf = (a) => (a && a.state === "present" ? a.ref : null);
    const out = JSON.parse(JSON.stringify(receipt));
    const doTurn = (turnRec, e) => {
      if (!e) return;
      turnRec.artifactRef = refOf(e.output);
      turnRec.sceneRef = e.scene && e.scene.state === "present" ? `turns/${turnRec.key ?? "main"}/scene` : null;
      for (const a of turnRec.attempts || []) {
        const slot = e.attempts.get(a.n);
        a.inputRef = refOf(slot?.input);
        a.artifactRef = refOf(slot?.output);
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
      let last = null;
      for (const [, slot] of e.attempts) if (slot.output) last = slot.output;
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
        const ws = {};
        for (const k of ["path", "branch", "baseCommit", "headCommit"]) if (w[k]) ws[k] = String(w[k]);
        if (typeof w.committed === "boolean") ws.committed = w.committed;
        if (typeof w.removed === "boolean") ws.removed = w.removed;
        if (Array.isArray(w.filesChanged)) ws.filesChanged = w.filesChanged.map(String);
        payload.workspaceSummary = ws;
      }
    }
    await scope.emit("node:settled", payload);
  });

  /** 归档一份 diff(write 节点收尾时调)。 */
  const putDiff = guard(async (diffPath) => archive.putFile("change.diff", diffPath));

  /** 归档某一轮的产出(复用命中时用 —— 那条路不跑 runTurn,但产出必须照样归档)。 */
  const putTurnOutput = guard(async (key, srcPath, n = 1) => {
    const e = turnOf(key);
    const a = await archive.putFile(`turns/${key}/attempt-${n}.output.md`, srcPath);
    e.output = a;
    e.attempts.set(n, { input: e.attempts.get(n)?.input ?? unavailable("fingerprint-only"), output: a });
    return a;
  });

  /** 复用命中时,输入原文当初可能压根没落盘 —— 那是**当时的选择,不是故障**。 */
  const markFingerprintOnly = (key, n) => {
    const e = turnOf(key);
    const slot = e.attempts.get(n) || { input: null, output: null };
    slot.input = unavailable("fingerprint-only");
    e.attempts.set(n, slot);
  };

  return {
    nodeSeq, archive,
    observed, rejected,
    turnStarted, turnGateAcquired, turnSettled,
    attemptStarted, attemptSettled, progress,
    workspaceIntent, workspaceCreated,
    settled, putDiff, putTurnOutput, markFingerprintOnly,
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
