/**
 * 生成 `viz/sample/` 下那三份**冻结样例** transcript。
 *
 * 为什么要有它:页面（reducer + 渲染器）必须能**离线**开发与回归 —— 不起桥、不起后端、
 * 不连网,喂一份写死的事件流就能跑。样例本身是**产物**(已提交),这个脚本只是它的来源:
 * 要改样例就改这里再重跑,别手改 jsonl —— 手改必然漏掉不变式(seq 稠密、turn 一一对应、
 * run:final 恒等式),而那些不变式正是 `test-viz.mjs` 要断言的东西。
 *
 *   node skills/agent-bridge-graph/viz/sample/build.mjs
 *
 * ⚠️ 时间戳是**写死的**,不取 Date.now() —— 样例要逐字节可重现,否则每次重跑都是一次 diff。
 *
 * ⚠️ **这份样例按 `docs/EVENTS-graph.md` 建,不按 `viz-events.mjs` 建。**
 *    这两者不是一回事:后者是**写方**的实现,它自己也可能漂。拿写方的实现造样例、再拿
 *    写方的 schema 去验它,证明的只是"我和我自己一致" —— 一个同源的同义反复。
 *    所以这里逐条按合同的**散文**摆事实,尤其是那几条合同点名"**可验的断言**"的地方(§1.3):
 *
 *      ① 单轮节点的 `node:observed.prompt` 与 `node:turn{main}.input` 是**同一份字节**
 *         (ref 与 sha256 都相同,都指向 `turns/main/prompt.md`);**对话节点没有节点级 prompt**。
 *      ② 每一轮 attempt 1 的输入**就是**该轮 `prompt.md` 本身(不另存一份),
 *         于是它的 `inputSha256` 恒等于 `node:turn.input.sha256`。
 *      ③ 归档里**没有** `artifact.md`:`node:settled.artifact` 指向**最后一次成功复制**的那份
 *         `turns/<key>/attempt-<n>.output.md`,`sha256` 三处(顶层 / TurnSummary / attempt)相等。
 *      ④ `workspaceSummary` 与 `errorSummary` **只在 `receipt` 不是 present 时**才出现;
 *         **read 节点恒无 `workspaceSummary`**。
 *
 *    ⚠️ 违反其中任何一条,样例就"长得像真的但不是真的",而页面正是照着它调出来的 ——
 *    错误会一路藏到真跑那天。`test-viz.mjs` 把这四条做成了断言。
 *
 * ⚠️ **sha256 是占位正文的真 SHA-256,不是编出来的。**
 *    页面会拿 `/file` 响应头里的指纹和事件里这个值对证,对不上就在界面上标红。
 *    编一个假的,离线开发时每一份资产都会被标成"文件已被改动" —— 一个每次都亮的警报
 *    等于没有警报,而它恰恰是这套归档唯一的防篡改手段。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = 1753660800000;          // 2026-07-28T00:00:00Z,写死
const OUT_DIR = "D:\\repo\\.graph\\run-1";
const CWD = "D:\\repo";

/* ---- 一份 transcript 的构造器 ---- */
function tape(graphId) {
  const lines = [];
  let seq = 0, t = T0;
  const put = (event, payload, dt = 200) => {
    t += dt;
    lines.push(JSON.stringify({ v: 1, seq: seq++, ts: t, graphId, event, payload }));
  };
  return { lines, put, at: () => t, text: () => lines.join("\n") + "\n" };
}

/* ---- 归档占位文件:正文由 ref 唯一决定 ----
   ⚠️ 正文**必须**在这里定,不能等到最后落盘时再拼:事件里的 `sha256` 与 `byteCount`
      要与磁盘上那一份逐字节对上,而对上的唯一办法就是**同一个函数算两次**。 */
function bodyOf(ref, opts = {}) {
  if (opts.empty) return "";                       // 空文件也是合法的 present(§3.1)
  const leaf = path.basename(ref);
  if (leaf.endsWith(".json")) return JSON.stringify({ sample: true, ref }, null, 2) + "\n";
  if (leaf.endsWith(".patch") || leaf.endsWith(".diff"))
    return `diff --git a/sample b/sample\n(样例占位:${ref})\n`;
  if (leaf.endsWith(".log")) return `[sample] ${ref}\n(会话日志占位)\n`;
  return `# 样例内容\n\n这是 \`${ref}\` 的占位正文,供页面离线开发与回归使用。\n\n` +
         `真实运行里这里是那一步的完整产出,**字节直传、未截断**。\n`;
}
const ARCHIVE = new Map();          // ref → 正文(落盘时照抄,保证与 sha256 一致)

/** 一份归档进去的资产。`byteCount` 与 `sha256` 都从正文真算,不许手填。 */
function present(ref, opts = {}) {
  const body = bodyOf(ref, opts);
  ARCHIVE.set(ref, body);
  const buf = Buffer.from(body, "utf8");
  return { state: "present", ref, sha256: crypto.createHash("sha256").update(buf).digest("hex"),
           byteCount: buf.length };
}
const na = () => ({ state: "not-applicable" });
const unavail = (code) => ({ state: "unavailable", code });
/** 现场是个**容器**,它自己没有 ref/sha256/byteCount(§3.2)。 */
const sceneP = (turnBase) => ({ state: "present", files: {
  // 键是**逻辑名**,不是磁盘上的文件名(docs/EVENTS-graph.md §3.2)——两者刻意不同。
  sessionLog: present(`${turnBase}/scene/session.log`),
  answer:     present(`${turnBase}/scene/answer.txt`),
  status:     present(`${turnBase}/scene/status.json`) } });
/**
 * §5.4 那张**封闭**的 `sessionReusable` 判定表。
 *
 * ⚠️ 样例**不许**随手给个默认值。早先默认 `true`,于是一个 `unknown` 的轮在样例里说
 * "这个会话还能接着聊" —— 而合同对 `unknown` 写得很明白:**不知道后端干没干,
 * 正是最不能再叠一轮的情况**。样例一旦这么写,页面就是照着一份**假合同**调出来的。
 * ⚠️ `timeout` 分两行(abort 被明确回报打断 ⇒ true,没被确认 ⇒ false),
 * 所以它由场景自己点名,不给默认。
 */
const reusableOf = (status) =>
  status === "ok" || status === "contract_error" || status === "not-started" ? true
  : status === "backend_failed" || status === "unknown" ? false
  : null;   // timeout:两行都合法,场景必须自己说

/** 任务单指纹是 **hex32**(SHA-256 取前 32 个 hex),不是 hex64(§0.2)。 */
const specHash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);


/**
 * 一个"跑起来过"的节点:observed → (workspace) → 每轮 turn → started → attempt* → turn-settled → settled。
 *
 * ⚠️ 这个函数是**合同的可执行版本**:上面注释里那四条"可验的断言"全在这里落地。
 *    改它之前先把 docs/EVENTS-graph.md §1.3 与 §5.8 读一遍 —— 这里每一处 ref 的选择都是合同指定的,
 *    不是随手起的名字。
 */
function node(tp, o) {
  const base = `nodes/.runs/${o.graphId}/${o.seq}-${o.id}`;
  const tb = (k) => `${base}/turns/${k}`;

  /* ① 单轮节点的节点级 prompt **就是** main 轮那份冻结正文(同 ref ⇒ 同 sha);
        对话节点没有节点级 prompt —— 它的正文是逐轮才有的。 */
  const nodePrompt = o.conversation ? na() : present(`${tb(o.turns[0].key)}/prompt.md`);

  tp.put("node:observed", {
    nodeSeq: o.seq, id: o.id, agent: o.agent, access: o.access, cwd: CWD,
    model: o.model ?? null, effort: o.effort ?? null,
    /* ⚠️ 归档里这份叫 **input.json**（§1.3 那张布局表），不是 spec.json ——
          样例把名字写错，页面点开就是 404，而 404 会被如实标成「记录时它在、现在取不到了」。 */
    spec: present(`${base}/input.json`),
    prompt: nodePrompt,
    role: o.role ?? na(),
    declaredDeps: o.declaredDeps ?? [], inferredDeps: o.inferredDeps ?? [], inferredDepsTruncated: false,
  });

  if (o.reused) {
    /* ⚠️ 复用**一条 turn 事件都不发**(§5.9) —— 它没有真跑。
          于是这段对话的轮、尝试、推断边,**全部**只存在于下面这张 turns[] 里。 */
    const t0 = o.turns[0];
    const out = present(`${tb(t0.key)}/attempt-1.output.md`);
    tp.put("node:settled", {
      nodeSeq: o.seq, status: "ok", execution: "reused", durationMs: o.origMs ?? 2547000,
      receipt: present(`${base}/receipt.json`), artifact: out, diff: na(),
      turns: [{ key: t0.key, status: "ok", sessionReusable: t0.sessionReusable ?? true, output: out,
                turnSpecHash: specHash(`${base}/${t0.key}`), charCount: t0.chars, durationMs: o.origMs ?? 2547000,
                inferredDeps: o.inferredDeps ?? [], inferredDepsTruncated: false,
                attempts: [{ n: 1, status: "accepted",
                             inputSha256: present(`${tb(t0.key)}/prompt.md`).sha256,
                             input: present(`${tb(t0.key)}/prompt.md`), output: out }] }],
    });
    return;
  }

  if (o.write) {
    tp.put("node:workspace-intent", { nodeSeq: o.seq, path: `${CWD}\\.worktrees\\${o.id}`,
      branch: `agent/${o.id}`, baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016" });
    tp.put("node:workspace-created", { nodeSeq: o.seq, path: `${CWD}\\.worktrees\\${o.id}`,
      branch: `agent/${o.id}`, baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016" });
  }

  const summaries = [];
  let lastPresentOutput = null;      // ③ 顶层 artifact 就是它

  for (const tn of o.turns) {
    /* ② 这一轮冻结的正文。**attempt 1 的输入就是它本身**,不另存一份。 */
    const frozen = present(`${tb(tn.key)}/prompt.md`);

    tp.put("node:turn", { nodeSeq: o.seq, turnKey: tn.key, input: frozen, inputSha256: frozen.sha256,
      timeoutMs: tn.timeoutMs ?? 600000, reask: tn.reask ?? 1,
      inferredDeps: tn.inferredDeps ?? o.inferredDeps ?? [], inferredDepsTruncated: false });

    if (tn.status === "not-started") {
      /* ⚠️ **不另造事件类型**:没能开始的轮由 turn-settled{not-started} 闭合(§10.9 第 10 条)。
            它**没有任何 attempt**,也**不进 turns[]** —— 所以顶层 status 一个字都不受它影响。 */
      /* ⚠️ `not-started` 恒 `sessionReusable: true` —— 那一轮**一条消息都没发出去**,
            会话根本没被碰过。写 false 就是在事件流上宣布"这段对话已经毒化"。 */
      tp.put("node:turn-settled", { nodeSeq: o.seq, turnKey: tn.key, status: "not-started",
        sessionReusable: true, output: unavail("source-missing"), scene: na(),
        charCount: null, durationMs: 0, errorSummary: tn.error });
      continue;
    }

    tp.put("node:started", { nodeSeq: o.seq, turnKey: tn.key, queuedMs: tn.queuedMs ?? 120 });

    const atts = [];
    let turnLastPresent = null;
    for (const a of tn.attempts) {
      // attempt 1 的输入 = 该轮 prompt.md 本身;第 2 次才另存一份(它是拼出来的新正文)。
      const input = a.n === 1 ? frozen : present(`${tb(tn.key)}/attempt-${a.n}.input.md`);
      tp.put("node:attempt", { nodeSeq: o.seq, turnKey: tn.key, n: a.n,
        input, inputSha256: input.sha256 });

      /* ⚠️ status × output 是**两个维度**(§5.6):`no-output` 照样是 present(零字节 + 空内容的 SHA),
            `failed` 也可能已经把文件复制成功了 —— 一律写死成 unavailable 就是在否认一份存在的证据。 */
      const output = a.archiveFailed ? unavail("copy-failed")
                   : present(`${tb(tn.key)}/attempt-${a.n}.output.md`, { empty: a.status === "no-output" });
      if (output.state === "present") turnLastPresent = output;

      const settled = { nodeSeq: o.seq, turnKey: tn.key, n: a.n, status: a.status,
        output, durationMs: a.durationMs ?? 4000, charCount: a.chars ?? null };
      if (a.rejectedReason) settled.rejectedReason = a.rejectedReason;
      tp.put("node:attempt-settled", settled);

      atts.push({ n: a.n, status: a.status, inputSha256: input.sha256, input, output,
                  ...(a.rejectedReason ? { rejectedReason: a.rejectedReason } : {}) });
    }

    /* ③ 该轮的 output = **本轮最后一次成功复制**的那一项的 output(同一份字节,sha 必须相等)。
          一次都没成功 → unavailable。 */
    const turnOut = turnLastPresent ?? unavail("source-missing");
    if (turnLastPresent) lastPresentOutput = turnLastPresent;

    const last = tn.attempts[tn.attempts.length - 1];
    const charCount = tn.chars !== undefined ? tn.chars : (last.chars ?? null);
    tp.put("node:turn-settled", { nodeSeq: o.seq, turnKey: tn.key, status: tn.status,
      sessionReusable: tn.sessionReusable ?? reusableOf(tn.status),
      output: turnOut, scene: tn.scene ?? na(), charCount, durationMs: tn.durationMs ?? 4200,
      ...(tn.errorSummary ? { errorSummary: tn.errorSummary } : {}) });

    summaries.push({ key: tn.key, status: tn.status,
      sessionReusable: tn.sessionReusable ?? reusableOf(tn.status),
      output: turnOut, turnSpecHash: specHash(`${base}/${tn.key}`), charCount,
      durationMs: tn.durationMs ?? 4200, inferredDeps: tn.inferredDeps ?? o.inferredDeps ?? [],
      inferredDepsTruncated: false, attempts: atts });
  }

  const receipt = o.receipt ?? present(`${base}/receipt.json`);
  const st = { nodeSeq: o.seq, status: o.status, execution: "fresh", durationMs: o.durationMs ?? 5000,
    receipt,
    /* ③ 归档里**没有 artifact.md** —— 顶层产出就是最后那一份 attempt 产出本身。 */
    artifact: lastPresentOutput ?? unavail("source-missing"),
    diff: o.diff ?? na(), turns: summaries };
  if (o.outcome !== undefined) st.outcome = o.outcome;

  /* ④ 这两样**只在回执没归档成功时**才出现 —— 回执在的时候页面自己去回执里读,
        内联一份就是同一事实的第二个副本,两份迟早打架。
        ⚠️ 而且 **read 节点恒无 workspaceSummary**(源码里 read 的 workspace 恒为 null)。 */
  if (receipt.state !== "present") {
    if (o.errorSummary) st.errorSummary = o.errorSummary;
    if (o.write && o.ws) st.workspaceSummary = o.ws;
  } else if (o.errorSummary || o.ws) {
    throw new Error(`${o.id}: 回执是 present,不许再内联 errorSummary / workspaceSummary(§5.8)`);
  }
  tp.put("node:settled", st);
}

/** 入场就被拒的节点:observed → rejected。**没有回执、没有 settled。** */
function rejected(tp, o) {
  const base = `nodes/.runs/${o.graphId}/${o.seq}-${o.id}`;
  tp.put("node:observed", { nodeSeq: o.seq, id: o.id, agent: o.agent ?? "omp", access: o.access ?? "read",
    cwd: CWD, model: null, effort: null, spec: present(`${base}/input.json`),
    /* 被拒的节点也是单轮节点,它那份冻结正文照样在 turns/main/ 下。 */
    prompt: present(`${base}/turns/main/prompt.md`), role: na(),
    declaredDeps: o.declaredDeps ?? [], inferredDeps: [], inferredDepsTruncated: false });
  if (o.wsIntent) tp.put("node:workspace-intent", { nodeSeq: o.seq, path: `${CWD}\\.worktrees\\${o.id}`,
    branch: `agent/${o.id}`, baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016" });
  tp.put("node:rejected", { nodeSeq: o.seq, phase: o.phase, error: o.error });
}


/* ============================================================
   样例 A：主样例 —— 有序收场,六种 phase / 三档 outcome / 复用 / 多轮 全在
   ============================================================ */
function buildMain() {
  const graphId = "gr-sample-main";
  const tp = tape(graphId);
  tp.put("run:started", { outDir: OUT_DIR, maxConcurrent: 4 }, 0);
  const N = (o) => node(tp, { ...o, graphId });
  const J = (o) => rejected(tp, { ...o, graphId });
  const tbase = (seq, id, key) => `nodes/.runs/${graphId}/${seq}-${id}/turns/${key}`;

  N({ seq: 0, id: "survey", agent: "codex", access: "read", model: "gpt-5-codex", effort: "medium",
      status: "ok", durationMs: 187000,
      turns: [{ key: "main", status: "ok", chars: 4820,
                attempts: [{ n: 1, status: "accepted", chars: 4820 }] }] });

  /* 打回重说:两次尝试,两次都被打回。
     ⚠️ 顶层**没有** errorSummary(回执归档正常),失败原因在**轮**上 ——
        页面必须能从轮里把它取出来,否则一个 contract_error 节点会一个字的原因都不给。 */
  N({ seq: 1, id: "audit-auth", agent: "claude", access: "read", model: "claude-opus-5", effort: "high",
      status: "contract_error", durationMs: 508000, declaredDeps: ["survey"], inferredDeps: ["survey"],
      turns: [{ key: "main", status: "contract_error", scene: sceneP(tbase(1, "audit-auth", "main")),
                chars: 6180, errorSummary: "第 2 次仍缺少「置信度」小节的取值约束",
                attempts: [
                  { n: 1, status: "rejected", chars: 3100, rejectedReason: "缺少结构化结论块：合同要求「结论 / 证据 / 影响面 / 建议 / 置信度」五节。" },
                  { n: 2, status: "rejected", chars: 6180, rejectedReason: "置信度给了「比较高」，合同只接受 高/中/低。" }] }] });

  // 复用:execution:"reused",一条 turn 事件都不发,推断边只存在于 turns[] 里。
  N({ seq: 2, id: "audit-flow", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      effort: "medium", reused: true, origMs: 2547000, declaredDeps: ["survey"], inferredDeps: ["survey"],
      turns: [{ key: "main", chars: 7310 }] });

  // outcome = delivered,**回执归档正常** —— 这条主路径上没有 workspaceSummary,
  // 分支/清单都要去回执里读。页面必须如实说这件事,不许显示成空字段或"零项"。
  N({ seq: 3, id: "patch-guard", agent: "cursor", access: "write", model: "gpt-5.6-sol-high",
      status: "ok", write: true, outcome: "delivered", durationMs: 878000,
      declaredDeps: ["audit-auth"], inferredDeps: ["audit-auth"],
      diff: present(`nodes/.runs/${graphId}/3-patch-guard/change.diff`),
      turns: [{ key: "main", status: "ok", chars: 1980,
                attempts: [{ n: 1, status: "accepted", chars: 1980 }] }] });

  // outcome = no-changes:**diff 不适用**,页面不许给 diff 入口。回执也正常。
  N({ seq: 4, id: "patch-retry", agent: "omp", access: "write", model: "deepseek/deepseek-v3.2",
      status: "ok", write: true, outcome: "no-changes", durationMs: 658000, diff: na(),
      turns: [{ key: "main", status: "ok", chars: 1120,
                attempts: [{ n: 1, status: "accepted", chars: 1120 }] }] });

  /* delivered 且 changesKnown:true ⇒ **有提交,只是净改动为零** —— 页面不许说"没有改动"
     (那是 no-changes 的话)。这一条要看得到 workspaceSummary,所以回执归档失败。 */
  N({ seq: 5, id: "patch-cfg", agent: "claude", access: "write", model: "claude-opus-5",
      status: "ok", write: true, outcome: "delivered", durationMs: 478000,
      receipt: unavail("write-failed"),
      diff: present(`nodes/.runs/${graphId}/5-patch-cfg/change.diff`, { empty: true }),
      ws: { path: `${CWD}\\.worktrees\\patch-cfg`, branch: "agent/patch-cfg", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016",
            headCommit: "c02aa19b7d41e6f0925c8a3b1e77fd460a2c9835", removed: true, changesKnown: true },
      turns: [{ key: "main", status: "ok", chars: 860,
                attempts: [{ n: 1, status: "accepted", chars: 860 }] }] });

  // outcome = unknown:必须显示工作副本路径 + 禁止自动重跑。changesKnown:false = 探测都没跑成。
  N({ seq: 6, id: "patch-gc", agent: "omp", access: "write", model: "deepseek/deepseek-v3.2",
      status: "unknown", write: true, outcome: "unknown", durationMs: 1601000,
      receipt: unavail("write-failed"), diff: unavail("source-missing"),
      errorSummary: "提交步骤退出码 128（分支引用被占用），收尾检查也没跑完。",
      /* ⚠️ 六个键恒在:提交没成功 ⇒ headCommit 是 **null**,不是省略这个键。 */
      ws: { path: `${CWD}\\.worktrees\\patch-gc`, branch: "agent/patch-gc", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016",
            headCommit: null, removed: false, changesKnown: false },
      turns: [{ key: "main", status: "unknown", scene: sceneP(tbase(6, "patch-gc", "main")),
                chars: 1290, errorSummary: "提交步骤退出码 128（分支引用被占用）。",
                attempts: [{ n: 1, status: "failed", chars: 1290 }] }] });

  // delivered 但 removed:false —— **收尾时没有确认清理**,推不出那个目录现在还在。
  N({ seq: 7, id: "patch-tele", agent: "codex", access: "write", model: "gpt-5-codex",
      status: "ok", write: true, outcome: "delivered", durationMs: 744000,
      receipt: unavail("write-failed"),
      diff: present(`nodes/.runs/${graphId}/7-patch-tele/change.diff`),
      ws: { path: `${CWD}\\.worktrees\\patch-tele`, branch: "agent/patch-tele", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016",
            headCommit: "d41ff0271c6b93ae58204df1b7e3a96c05d81724", removed: false, changesKnown: false },
      turns: [{ key: "main", status: "ok", chars: 1440,
                attempts: [{ n: 1, status: "accepted", chars: 1440 }] }] });

  // unknown + delivered,**两种成因各一个** —— 都要照常给 diff 入口,且两句话不能一样
  N({ seq: 8, id: "patch-sse", agent: "cursor", access: "write", model: "gpt-5.6-sol-high",
      status: "unknown", write: true, outcome: "delivered", durationMs: 1430000,
      receipt: unavail("write-failed"),
      diff: present(`nodes/.runs/${graphId}/8-patch-sse/change.diff`),
      errorSummary: "写结果记录那一步自己失败了（ENOSPC），所以没有一份权威的结束回执。",
      ws: { path: `${CWD}\\.worktrees\\patch-sse`, branch: "agent/patch-sse", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016",
            headCommit: "e5510aa3f92c74b061d8e25a7c3419fb60d872ae", removed: true, changesKnown: true },
      turns: [{ key: "main", status: "unknown", scene: sceneP(tbase(8, "patch-sse", "main")),
                chars: 1710, errorSummary: "写结果记录那一步失败：ENOSPC。",
                attempts: [{ n: 1, status: "failed", chars: 1710 }] }] });
  N({ seq: 9, id: "patch-wt", agent: "kimi", access: "write", model: "kimi-code/k3",
      status: "unknown", write: true, outcome: "delivered", durationMs: 1290000,
      receipt: unavail("write-failed"),
      diff: present(`nodes/.runs/${graphId}/9-patch-wt/change.diff`),
      errorSummary: "确认任务是否已开始时，后端返回的东西看不懂（形状不认识）。",
      ws: { path: `${CWD}\\.worktrees\\patch-wt`, branch: "agent/patch-wt", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016",
            headCommit: "f6621bb84e07d3c95a12f6b70e48d259c1a37f0b", removed: true, changesKnown: true },
      turns: [{ key: "main", status: "unknown", scene: sceneP(tbase(9, "patch-wt", "main")),
                chars: 1290, errorSummary: "确认任务是否已开始时，后端返回的东西看不懂。",
                attempts: [{ n: 1, status: "failed", chars: 1290 }] }] });

  // 回执拿不到:页面必须**明说原因**,不是静默留白。⚠️ read 节点恒无 workspaceSummary。
  N({ seq: 10, id: "no-receipt", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      status: "ok", durationMs: 220000, receipt: unavail("write-failed"),
      turns: [{ key: "main", status: "ok", chars: 900,
                attempts: [{ n: 1, status: "accepted", chars: 900 }] }] });

  /* 汇总环节。两件事同时在这一个节点上:
     ① 它**声明**依赖 long-scan,而 long-scan 是最后才收场的 —— 于是"声明的先后与实际执行不符",
        页面要给一句提醒(那条边只是一句声明,系统既不校验也不据此调度);
     ② 它**推断**出的依赖是 survey,而 survey **没被声明过** —— 于是这是一条纯推断边。
        ⚠️ 少了这一条,样例里所有推断边都会与声明边重合、被去重掉,
        「推断边画成虚线」那组断言就永远测不到任何东西。
     ③ 它还声明了一个**图里根本不存在**的 id —— 页面不许静默丢掉,要说"这条连不上"。 */
  N({ seq: 11, id: "report", agent: "codex", access: "read", model: "gpt-5-codex", effort: "medium",
      status: "ok", durationMs: 437000, declaredDeps: ["long-scan", "typo-id"], inferredDeps: ["survey"],
      turns: [{ key: "main", status: "ok", chars: 3260,
                attempts: [{ n: 1, status: "accepted", chars: 3260 }] }] });

  /* backend_failed + `no-output`:⚠️ 产出**照样是 present**(零字节 + 空内容的 SHA),
     不是 unavailable、更不是 not-applicable —— 磁盘上确实躺着一份零字节的审计原件(§5.6)。 */
  N({ seq: 12, id: "flaky", agent: "kimi", access: "read", model: "kimi-code/k3",
      status: "backend_failed", durationMs: 186000,
      turns: [{ key: "main", status: "backend_failed", sessionReusable: false,
                scene: sceneP(tbase(12, "flaky", "main")), chars: 0,
                errorSummary: "upstream_closed: connection reset by peer (after 214 chunks)",
                attempts: [{ n: 1, status: "no-output", chars: 0 }] }] });

  /* 多轮对话 + callback_error:**每一轮都跑完了,是编排那段 JS 自己炸的**;最后一轮没能开始。
     ⚠️ 对话节点**没有节点级 prompt**(正文是逐轮才有的)。
     ⚠️ 那条 not-started 的轮**不进 turns[]**,所以顶层不因它变色。 */
  N({ seq: 13, id: "refine-plan", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      conversation: true, status: "callback_error", durationMs: 96000, declaredDeps: ["survey"],
      receipt: unavail("write-failed"),
      errorSummary: "TypeError: Cannot read properties of undefined (reading 'sections')",
      turns: [
        { key: "draft", status: "ok", chars: 900, durationMs: 26000, inferredDeps: ["survey"],
          attempts: [{ n: 1, status: "accepted", chars: 900 }] },
        { key: "critique", status: "ok", chars: 1500, durationMs: 31000, inferredDeps: ["audit-auth"],
          scene: sceneP(tbase(13, "refine-plan", "critique")),
          attempts: [{ n: 1, status: "rejected", chars: 120, rejectedReason: "只给了一句「总体可行」，合同要求至少三条。" },
                     { n: 2, status: "accepted", chars: 1500 }] },
        { key: "signoff", status: "not-started",
          error: "上一轮之后会话已不可复用，这一轮在入场那几关就被挡下了" },
      ] });

  // 六种 phase 各一个。⚠️ 六种要**各自不同的处置提示**,渲染成同一句"被拒绝了"是假绿。
  J({ seq: 14, id: "dup", phase: "lock", declaredDeps: ["survey"],
      error: '同一个 outDir 里的环节 id "dup" 正在并发运行 —— id 必须唯一' });
  J({ seq: 15, id: "dirty", phase: "preflight", access: "write",
      error: "工作区有未提交的改动，write 节点拒绝在脏树上开工" });
  J({ seq: 16, id: "stale", phase: "reuse-check",
      error: "复用校验没过：上次那份产出的 SHA-256 与回执记录不符" });
  J({ seq: 17, id: "wt-fail", phase: "workspace-setup", access: "write", wsIntent: true,
      error: "git worktree add 退出码 128：目标目录已存在且非空" });
  J({ seq: 18, id: "bad-turn", phase: "turn-validation",
      error: "turn() 调用非法：prompt 与 promptFile 必须二选一（调了 2 次，最后一次两个都给了）" });
  J({ seq: 19, id: "empty-talk", phase: "zero-turn",
      error: "conversation() 的回调跑完了，但一次 turn() 都没调用过" });

  /* 最后才收场的那个 —— 它被 #11 report **声明**为依赖,却比 report 晚结束。
     ⚠️ 它也是一次**前向引用**:report 观测在先、它观测在后。真实的 Promise.all 扇出里
        这很常见,而"依赖 id 只往前找"的实现会把这条边**静默丢掉**。 */
  N({ seq: 20, id: "long-scan", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      status: "timeout", durationMs: 1200004,
      /* timeout 两行都合法,场景必须自己说:这里取"abort 没被确认" ⇒ 那一轮**可能还在后台跑**。 */
      turns: [{ key: "main", status: "timeout", sessionReusable: false,
                scene: sceneP(tbase(20, "long-scan", "main")), chars: 12400,
                errorSummary: "到达 20 分钟的执行上限，被主动打断。它当时还在输出。",
                attempts: [{ n: 1, status: "failed", chars: 12400 }] }] });

  tp.put("run:final", { result: "failed", durationMs: tp.at() - T0 + 1000,
    counts: { observed: 21, rejected: 6, ok: 10, contract_error: 1, backend_failed: 1,
              timeout: 1, unknown: 1, callback_error: 1, reused: 1 } });
  return { graphId, text: tp.text() };
}

/* ============================================================
   样例 B：中断 —— 六种 abandoned 落点,一个不少。**没有 run:final。**
   ============================================================ */
function buildCut() {
  const graphId = "gr-sample-cut";
  const tp = tape(graphId);
  tp.put("run:started", { outDir: OUT_DIR, maxConcurrent: 4 }, 0);
  const base = (seq, id) => `nodes/.runs/${graphId}/${seq}-${id}`;
  const frozen = (seq, id, key = "main") => present(`${base(seq, id)}/turns/${key}/prompt.md`);
  const obs = (seq, id, access, deps = []) => tp.put("node:observed", {
    nodeSeq: seq, id, agent: "omp", access, cwd: CWD, model: "deepseek/deepseek-v3.2", effort: "high",
    spec: present(`${base(seq, id)}/input.json`),
    // 单轮节点:节点级 prompt 与 main 轮的输入是**同一份字节**。
    prompt: frozen(seq, id),
    role: na(), declaredDeps: deps, inferredDeps: [], inferredDepsTruncated: false });
  const turn = (seq, id) => { const f = frozen(seq, id);
    tp.put("node:turn", { nodeSeq: seq, turnKey: "main", input: f, inputSha256: f.sha256,
      timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false }); return f; };

  // ① 停在 observed
  obs(0, "cut-observed", "read");
  // ② 停在 turn（排队中,没拿到名额）—— 一个字都还没发给 AI
  obs(1, "cut-queued", "read", ["cut-observed"]);
  turn(1, "cut-queued");
  // ③ read 且已开跑 —— 执行结果不明
  obs(2, "cut-read", "read", ["cut-observed"]);
  const f2 = turn(2, "cut-read");
  tp.put("node:started", { nodeSeq: 2, turnKey: "main", queuedMs: 90 });
  // ⚠️ attempt 1 的输入**就是**该轮冻结正文本身,不另存一份(§1.3)。
  tp.put("node:attempt", { nodeSeq: 2, turnKey: "main", n: 1, input: f2, inputSha256: f2.sha256 });
  tp.put("node:progress", { nodeSeq: 2, turnKey: "main", n: 1, status: "running", charCount: 820,
    tail: "……正在读 src/auth/session.ts",
    lastEvent: { at: "2026-07-28T00:00:12Z", type: "tool:read" },
    contextUsage: { tokens: 128000, live: true } });
  // ④ write,已开跑、**还没见过 workspace-intent** —— 创建动作压根没开始,不会有工作副本
  obs(3, "cut-pre", "write", ["cut-observed"]);
  turn(3, "cut-pre");
  tp.put("node:started", { nodeSeq: 3, turnKey: "main", queuedMs: 70 });
  // ⑤ write,见过 intent、**没见过 created** —— 位置未确认,去看一眼
  obs(4, "cut-creating", "write", ["cut-observed"]);
  turn(4, "cut-creating");
  tp.put("node:started", { nodeSeq: 4, turnKey: "main", queuedMs: 60 });
  tp.put("node:workspace-intent", { nodeSeq: 4, path: `${CWD}\\.worktrees\\cut-creating`,
    branch: "agent/cut-creating", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016" });
  // ⑥ write,见过 created —— 执行与代码去向都不明,禁止自动重跑
  obs(5, "cut-created", "write", ["cut-observed"]);
  turn(5, "cut-created");
  tp.put("node:started", { nodeSeq: 5, turnKey: "main", queuedMs: 55 });
  tp.put("node:workspace-intent", { nodeSeq: 5, path: `${CWD}\\.worktrees\\cut-created`,
    branch: "agent/cut-created", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016" });
  tp.put("node:workspace-created", { nodeSeq: 5, path: `${CWD}\\.worktrees\\cut-created`,
    branch: "agent/cut-created", baseCommit: "a91c04e2f7b3d5188c6e0a4419fd7c2b8e35d016" });
  // ⑦ 一个已经好好收场的节点 —— 中断**不影响**它,用来盯"别把整次运行涂成结果不明"
  node(tp, { graphId, seq: 6, id: "done-before-cut", agent: "codex", access: "read",
    model: "gpt-5-codex", effort: "medium", status: "ok", durationMs: 120000,
    turns: [{ key: "main", status: "ok", chars: 2200,
              attempts: [{ n: 1, status: "accepted", chars: 2200 }] }] });
  return { graphId, text: tp.text() };
}

/* ============================================================
   样例 C：空态 —— 只开了个头
   ============================================================ */
function buildEmpty() {
  const graphId = "gr-sample-empty";
  const tp = tape(graphId);
  tp.put("run:started", { outDir: OUT_DIR, maxConcurrent: 4 }, 0);
  return { graphId, text: tp.text() };
}

/* ---- 落盘 ----
   ⚠️ **先把整棵树删掉再写。** 归档布局是会变的(合同改了一次 ref 的落点,旧的
      `artifact.md` / `diff.patch` / 节点根下的 `prompt.md` 就全成了孤儿)。只覆盖不删除的话,
      那些孤儿会一直躺在仓库里 —— 它们**不在任何事件里**,于是永远没人发现它们已经不该存在,
      而 review 时看到一个 `artifact.md` 会以为合同还允许它。 */
fs.rmSync(path.join(HERE, "nodes"), { recursive: true, force: true });

const outs = [buildMain(), buildCut(), buildEmpty()];
for (const { graphId, text } of outs) {
  // ⚠️ 只写**一份**,而且写在 serve.mjs 认的那个位置(`<outDir>/nodes/.runs/<graphId>/`)。
  //    想过再在 sample/ 根下放一份名字好记的副本 —— 那是同样的字节存两处,迟早只有一处被更新。
  const p = path.join(HERE, "nodes", ".runs", graphId, "transcript.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
  console.log(`  ${graphId}/transcript.jsonl  ${text.split("\n").filter(Boolean).length} 条`);
}

/* ---- 一棵能跑起来的归档树 ----
   `serve.mjs` 认的布局是 `<outDir>/nodes/.runs/<graphId>/…`,而 `/file?ref=` 只放行这底下的东西。
   这里把样例摆成那个形状,于是**不起桥也能把页面跑起来**:

     VIZ_OUT_DIR=skills/agent-bridge-graph/viz/sample VIZ_GRAPH_ID=gr-sample-main \
       VIZ_PORT=8080 node skills/agent-bridge-graph/viz/serve.mjs

   ⚠️ 每个 present 资产都要有**真的文件**,而且**正文必须与事件里的 sha256 逐字节对上** ——
      少一个,页面点开就是 404;对不上,页面会标红说「这不是事件记录的那一份」。
      两个结论都是**对的**,但对着一份自己造的样例得出它们,只会让人以为归档坏了。
      所以这里直接落 `ARCHIVE` 里那份正文 —— 它和算 sha256 时用的是同一个字符串。 */
let files = 0;
for (const [ref, body] of ARCHIVE) {
  const p = path.join(HERE, ref);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  files++;
}
console.log(`  归档占位文件 ${files} 个`);
