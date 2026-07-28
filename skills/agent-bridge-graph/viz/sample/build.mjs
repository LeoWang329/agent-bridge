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
 */

import fs from "node:fs";
import path from "node:path";
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

const sha = (s) => {
  // 样例里的 sha 只要**形状对、彼此不同**就够(页面不验签,验签在 /file 那一侧)。
  let h = 0n; for (const c of s) h = (h * 131n + BigInt(c.codePointAt(0))) % (2n ** 256n);
  return h.toString(16).padStart(64, "0").slice(0, 64);
};
const present = (ref, byteCount = 1024) => ({ state: "present", ref, sha256: sha(ref), byteCount });
const na = () => ({ state: "not-applicable" });
const unavail = (code) => ({ state: "unavailable", code });
const sceneP = (base) => ({ state: "present", files: {
  "session.log": present(`${base}/scene/session.log`, 4096),
  "answer.txt": present(`${base}/scene/answer.txt`, 2048),
  "status.json": present(`${base}/scene/status.json`, 256) } });

/** 一个"跑起来过"的节点:observed → turn → started → attempt* → turn-settled → settled。 */
function node(tp, o) {
  const base = `nodes/.runs/${o.graphId}/${o.seq}-${o.id}`;
  tp.put("node:observed", {
    nodeSeq: o.seq, id: o.id, agent: o.agent, access: o.access, cwd: CWD,
    model: o.model ?? null, effort: o.effort ?? null,
    spec: present(`${base}/spec.json`, 512),
    prompt: o.promptAsset ?? present(`${base}/prompt.md`, 300),
    role: na(),
    declaredDeps: o.declaredDeps ?? [], inferredDeps: o.inferredDeps ?? [], inferredDepsTruncated: false,
  });
  if (o.reused) {
    // ⚠️ 复用**一条 node:turn 都不发** —— 它没有真跑。
    tp.put("node:settled", {
      nodeSeq: o.seq, status: "ok", execution: "reused", durationMs: o.origMs ?? 2547000,
      receipt: present(`${base}/receipt.json`, 900), artifact: present(`${base}/artifact.md`, 7310),
      diff: na(), turns: o.turns,
    });
    return;
  }
  if (o.write) {
    tp.put("node:workspace-intent", { nodeSeq: o.seq, path: `${CWD}\\.worktrees\\${o.id}`,
      branch: `agent/${o.id}`, baseCommit: "a91c04e" });
    tp.put("node:workspace-created", { nodeSeq: o.seq, path: `${CWD}\\.worktrees\\${o.id}`,
      branch: `agent/${o.id}`, baseCommit: "a91c04e" });
  }
  const summaries = [];
  for (const tn of o.turns) {
    const tb = `${base}/turns/${tn.key}`;
    tp.put("node:turn", { nodeSeq: o.seq, turnKey: tn.key, input: present(`${tb}/prompt.md`, 300),
      timeoutMs: 600000, reask: tn.reask ?? 1,
      inferredDeps: o.inferredDeps ?? [], inferredDepsTruncated: false });
    if (tn.status === "not-started") {
      // ⚠️ **不另造事件类型**:没能开始的轮由 turn-settled{not-started} 闭合(§10.9 第 10 条)。
      tp.put("node:turn-settled", { nodeSeq: o.seq, turnKey: tn.key, status: "not-started",
        sessionReusable: false, output: unavail("source-missing"), scene: na(),
        charCount: null, durationMs: 0, errorSummary: tn.error ?? "上一轮之后会话已不可复用" });
      continue;
    }
    tp.put("node:started", { nodeSeq: o.seq, turnKey: tn.key, queuedMs: tn.queuedMs ?? 120 });
    const atts = [];
    for (const a of tn.attempts) {
      const suffix = a.n === 1 ? "" : `-${a.n}`;
      tp.put("node:attempt", { nodeSeq: o.seq, turnKey: tn.key, n: a.n,
        input: present(`${tb}/attempt${suffix || "-1"}.input.md`, 300), inputSha256: sha(`${tb}/in${a.n}`) });
      const settled = { nodeSeq: o.seq, turnKey: tn.key, n: a.n, status: a.status,
        output: a.output ?? present(`${tb}/attempt${suffix || "-1"}.output.md`, a.chars ?? 1200),
        durationMs: a.durationMs ?? 4000, charCount: a.chars ?? 1200 };
      if (a.rejectedReason) settled.rejectedReason = a.rejectedReason;
      tp.put("node:attempt-settled", settled);
      atts.push({ n: a.n, status: a.status, inputSha256: sha(`${tb}/in${a.n}`),
        input: present(`${tb}/attempt${suffix || "-1"}.input.md`, 300),
        output: settled.output, ...(a.rejectedReason ? { rejectedReason: a.rejectedReason } : {}) });
    }
    const last = tn.attempts[tn.attempts.length - 1];
    tp.put("node:turn-settled", { nodeSeq: o.seq, turnKey: tn.key, status: tn.status,
      sessionReusable: tn.sessionReusable ?? true,
      output: last.output ?? present(`${tb}/attempt${last.n === 1 ? "-1" : `-${last.n}`}.output.md`, last.chars ?? 1200),
      scene: tn.scene ?? na(), charCount: last.chars ?? 1200, durationMs: tn.durationMs ?? 4200,
      ...(tn.errorSummary ? { errorSummary: tn.errorSummary } : {}) });
    summaries.push({ key: tn.key, status: tn.status, sessionReusable: tn.sessionReusable ?? true,
      output: last.output ?? present(`${tb}/attempt${last.n === 1 ? "-1" : `-${last.n}`}.output.md`, last.chars ?? 1200),
      turnSpecHash: sha(`${tb}/spec`).slice(0, 32), charCount: last.chars ?? 1200,
      durationMs: tn.durationMs ?? 4200, inferredDeps: o.inferredDeps ?? [],
      inferredDepsTruncated: false, attempts: atts });
  }
  const st = { nodeSeq: o.seq, status: o.status, execution: "fresh", durationMs: o.durationMs ?? 5000,
    receipt: o.receipt ?? present(`${base}/receipt.json`, 900),
    artifact: o.artifact ?? present(`${base}/artifact.md`, 1200),
    diff: o.diff ?? na(), turns: summaries };
  if (o.outcome !== undefined) st.outcome = o.outcome;
  if (o.ws) st.workspaceSummary = o.ws;
  if (o.errorSummary) st.errorSummary = o.errorSummary;
  tp.put("node:settled", st);
}

/** 入场就被拒的节点:observed → rejected。**没有回执、没有 settled。** */
function rejected(tp, o) {
  const base = `nodes/.runs/${o.graphId}/${o.seq}-${o.id}`;
  tp.put("node:observed", { nodeSeq: o.seq, id: o.id, agent: o.agent ?? "omp", access: o.access ?? "read",
    cwd: CWD, model: null, effort: null, spec: present(`${base}/spec.json`, 512),
    prompt: present(`${base}/prompt.md`, 200), role: na(),
    declaredDeps: o.declaredDeps ?? [], inferredDeps: [], inferredDepsTruncated: false });
  if (o.wsIntent) tp.put("node:workspace-intent", { nodeSeq: o.seq, path: `${CWD}\\.worktrees\\${o.id}`,
    branch: `agent/${o.id}`, baseCommit: "a91c04e" });
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

  N({ seq: 0, id: "survey", agent: "codex", access: "read", model: "gpt-5-codex", effort: "medium",
      status: "ok", durationMs: 187000,
      turns: [{ key: "main", status: "ok", scene: na(), chars: 4820,
                attempts: [{ n: 1, status: "accepted", chars: 4820 }] }] });

  // 打回重说:两次尝试,第 1 次带原因。**两次的产出各自独立**。
  N({ seq: 1, id: "audit-auth", agent: "claude", access: "read", model: "claude-opus-5", effort: "high",
      status: "contract_error", durationMs: 508000, declaredDeps: ["survey"], inferredDeps: ["survey"],
      errorSummary: "第 2 次仍缺少「置信度」小节的取值约束",
      turns: [{ key: "main", status: "contract_error", scene: sceneP(`nodes/.runs/${graphId}/1-audit-auth/turns/main`),
                chars: 6180, errorSummary: "第 2 次仍缺少「置信度」小节的取值约束",
                attempts: [
                  { n: 1, status: "rejected", chars: 3100, rejectedReason: "缺少结构化结论块：合同要求「结论 / 证据 / 影响面 / 建议 / 置信度」五节。" },
                  { n: 2, status: "rejected", chars: 6180, rejectedReason: "置信度给了「比较高」，合同只接受 高/中/低。" }] }] });

  // 复用:execution:"reused",一条 node:turn 都不发,推断边仍在。
  N({ seq: 2, id: "audit-flow", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      effort: "medium", reused: true, origMs: 2547000, declaredDeps: ["survey"], inferredDeps: ["survey"],
      turns: [{ key: "main", status: "ok", sessionReusable: false,
                output: present(`nodes/.runs/${graphId}/2-audit-flow/artifact.md`, 7310),
                turnSpecHash: sha("reuse").slice(0, 32), charCount: 7310, durationMs: 2540000,
                inferredDeps: ["survey"], inferredDepsTruncated: false,
                attempts: [{ n: 1, status: "accepted", inputSha256: sha("reuse-in"),
                             input: present(`nodes/.runs/${graphId}/2-audit-flow/turns/main/prompt.md`, 300),
                             output: present(`nodes/.runs/${graphId}/2-audit-flow/artifact.md`, 7310) }] }] });

  // outcome = delivered(正常交付)
  N({ seq: 3, id: "patch-guard", agent: "cursor", access: "write", model: "gpt-5.6-sol-high",
      status: "ok", write: true, outcome: "delivered", durationMs: 878000,
      declaredDeps: ["audit-auth"], inferredDeps: ["audit-auth"],
      diff: present(`nodes/.runs/${graphId}/3-patch-guard/diff.patch`, 8400),
      ws: { path: `${CWD}\\.worktrees\\patch-guard`, branch: "agent/patch-guard", baseCommit: "a91c04e",
            headCommit: "b7d21f0", committed: true, removed: true,
            filesChanged: ["src/auth/session.ts", "src/auth/const.ts", "src/auth/__tests__/session.test.ts"] },
      turns: [{ key: "main", status: "ok", scene: na(), chars: 1980,
                attempts: [{ n: 1, status: "accepted", chars: 1980 }] }] });

  // outcome = no-changes:**diff 不适用**,页面不许给 diff 入口
  N({ seq: 4, id: "patch-retry", agent: "omp", access: "write", model: "deepseek/deepseek-v3.2",
      status: "ok", write: true, outcome: "no-changes", durationMs: 658000, diff: na(),
      ws: { path: `${CWD}\\.worktrees\\patch-retry`, branch: "agent/patch-retry", baseCommit: "a91c04e",
            committed: false, removed: true, filesChanged: [] },
      turns: [{ key: "main", status: "ok", scene: na(), chars: 1120,
                attempts: [{ n: 1, status: "accepted", chars: 1120 }] }] });

  // delivered 且 filesChanged=[] 且 committed:**有 HEAD 前进,只是净改动为零** ——
  // 页面不许说"没有改动"(那是 no-changes 的话)。
  N({ seq: 5, id: "patch-cfg", agent: "claude", access: "write", model: "claude-opus-5",
      status: "ok", write: true, outcome: "delivered", durationMs: 478000,
      diff: present(`nodes/.runs/${graphId}/5-patch-cfg/diff.patch`, 0),
      ws: { path: `${CWD}\\.worktrees\\patch-cfg`, branch: "agent/patch-cfg", baseCommit: "a91c04e",
            headCommit: "c02aa19", committed: true, removed: true, filesChanged: [] },
      turns: [{ key: "main", status: "ok", scene: na(), chars: 860,
                attempts: [{ n: 1, status: "accepted", chars: 860 }] }] });

  // outcome = unknown:必须显示工作副本路径 + 禁止自动重跑
  N({ seq: 6, id: "patch-gc", agent: "omp", access: "write", model: "deepseek/deepseek-v3.2",
      status: "unknown", write: true, outcome: "unknown", durationMs: 1601000,
      diff: unavail("source-missing"), errorSummary: "提交步骤退出码 128（分支引用被占用），收尾检查也没跑完。",
      ws: { path: `${CWD}\\.worktrees\\patch-gc`, branch: "agent/patch-gc", baseCommit: "a91c04e",
            committed: false, removed: false },
      turns: [{ key: "main", status: "unknown", scene: sceneP(`nodes/.runs/${graphId}/6-patch-gc/turns/main`),
                chars: 1290, attempts: [{ n: 1, status: "failed", chars: 1290 }] }] });

  // delivered 但 removed:false —— 收尾时**没能确认**清理,工作副本可能还在
  N({ seq: 7, id: "patch-tele", agent: "codex", access: "write", model: "gpt-5-codex",
      status: "ok", write: true, outcome: "delivered", durationMs: 744000,
      diff: present(`nodes/.runs/${graphId}/7-patch-tele/diff.patch`, 3200),
      ws: { path: `${CWD}\\.worktrees\\patch-tele`, branch: "agent/patch-tele", baseCommit: "a91c04e",
            headCommit: "d41ff02", committed: true, removed: false,
            filesChanged: ["src/telemetry/events.ts", "src/graph/node.ts"] },
      turns: [{ key: "main", status: "ok", scene: na(), chars: 1440,
                attempts: [{ n: 1, status: "accepted", chars: 1440 }] }] });

  // unknown + delivered,**两种成因各一个** —— 都要照常给分支与 diff 入口
  N({ seq: 8, id: "patch-sse", agent: "cursor", access: "write", model: "gpt-5.6-sol-high",
      status: "unknown", write: true, outcome: "delivered", durationMs: 1430000,
      diff: present(`nodes/.runs/${graphId}/8-patch-sse/diff.patch`, 5100),
      errorSummary: "写结果记录那一步自己失败了（ENOSPC），所以没有一份权威的结束回执。",
      ws: { path: `${CWD}\\.worktrees\\patch-sse`, branch: "agent/patch-sse", baseCommit: "a91c04e",
            headCommit: "e5510aa", committed: true, removed: true,
            filesChanged: ["src/transport/sse.ts", "src/transport/const.ts"] },
      turns: [{ key: "main", status: "unknown", scene: sceneP(`nodes/.runs/${graphId}/8-patch-sse/turns/main`),
                chars: 1710, attempts: [{ n: 1, status: "failed", chars: 1710 }] }] });
  N({ seq: 9, id: "patch-wt", agent: "kimi", access: "write", model: "kimi-code/k3",
      status: "unknown", write: true, outcome: "delivered", durationMs: 1290000,
      diff: present(`nodes/.runs/${graphId}/9-patch-wt/diff.patch`, 2200),
      errorSummary: "确认任务是否已开始时，后端返回的东西看不懂（形状不认识）。",
      ws: { path: `${CWD}\\.worktrees\\patch-wt`, branch: "agent/patch-wt", baseCommit: "a91c04e",
            headCommit: "f6621bb", committed: true, removed: true, filesChanged: ["src/graph/gc.ts"] },
      turns: [{ key: "main", status: "unknown", scene: sceneP(`nodes/.runs/${graphId}/9-patch-wt/turns/main`),
                chars: 1290, attempts: [{ n: 1, status: "failed", chars: 1290 }] }] });

  // 回执拿不到:页面必须**明说原因**,不是静默留白
  N({ seq: 10, id: "no-receipt", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      status: "ok", durationMs: 220000, receipt: unavail("write-failed"),
      turns: [{ key: "main", status: "ok", scene: na(), chars: 900,
                attempts: [{ n: 1, status: "accepted", chars: 900 }] }] });

  /* 汇总环节。两件事同时在这一个节点上:
     ① 它**声明**依赖 long-scan,而 long-scan 是最后才收场的 —— 于是"声明的先后与实际执行不符",
        页面要给一句提醒(那条边只是一句声明,系统既不校验也不据此调度);
     ② 它**推断**出的依赖是 survey,而 survey **没被声明过** —— 于是这是一条纯推断边。
        ⚠️ 少了这一条,样例里所有推断边都会与声明边重合、被去重掉,
        「推断边画成虚线」那组断言就永远测不到任何东西。 */
  N({ seq: 11, id: "report", agent: "codex", access: "read", model: "gpt-5-codex", effort: "medium",
      status: "ok", durationMs: 437000, declaredDeps: ["long-scan"], inferredDeps: ["survey"],
      turns: [{ key: "main", status: "ok", scene: na(), chars: 3260,
                attempts: [{ n: 1, status: "accepted", chars: 3260 }] }] });

  N({ seq: 12, id: "flaky", agent: "kimi", access: "read", model: "kimi-code/k3",
      status: "backend_failed", durationMs: 186000,
      errorSummary: "upstream_closed: connection reset by peer (after 214 chunks)",
      turns: [{ key: "main", status: "backend_failed",
                scene: sceneP(`nodes/.runs/${graphId}/12-flaky/turns/main`),
                chars: 640, attempts: [{ n: 1, status: "no-output", chars: 640 }] }] });

  // 多轮 + callback_error:**每一轮都跑完了,是编排那段 JS 自己炸的**;最后一轮没能开始
  N({ seq: 13, id: "refine-plan", agent: "omp", access: "read", model: "deepseek/deepseek-v3.2",
      status: "callback_error", durationMs: 96000, declaredDeps: ["survey"],
      errorSummary: "TypeError: Cannot read properties of undefined (reading 'sections')",
      turns: [
        { key: "draft", status: "ok", scene: na(), chars: 900, durationMs: 26000,
          attempts: [{ n: 1, status: "accepted", chars: 900 }] },
        { key: "critique", status: "ok", chars: 1500, durationMs: 31000,
          scene: sceneP(`nodes/.runs/${graphId}/13-refine-plan/turns/critique`),
          attempts: [{ n: 1, status: "rejected", chars: 120, rejectedReason: "只给了一句「总体可行」，合同要求至少三条。" },
                     { n: 2, status: "accepted", chars: 1500 }] },
        { key: "signoff", status: "not-started", error: "上一轮之后会话已不可复用，这一轮在入场那几关就被挡下了" },
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
      errorSummary: "到达 20 分钟的执行上限，被主动打断。它当时还在输出。",
      turns: [{ key: "main", status: "timeout", scene: sceneP(`nodes/.runs/${graphId}/20-long-scan/turns/main`),
                chars: 12400, attempts: [{ n: 1, status: "failed", chars: 12400 }] }] });

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
  const obs = (seq, id, access, deps = []) => tp.put("node:observed", {
    nodeSeq: seq, id, agent: "omp", access, cwd: CWD, model: "deepseek/deepseek-v3.2", effort: "high",
    spec: present(`${base(seq, id)}/spec.json`, 512), prompt: present(`${base(seq, id)}/prompt.md`, 300),
    role: na(), declaredDeps: deps, inferredDeps: [], inferredDepsTruncated: false });

  // ① 停在 observed
  obs(0, "cut-observed", "read");
  // ② 停在 turn（排队中,没拿到名额）—— 一个字都还没发给 AI
  obs(1, "cut-queued", "read", ["cut-observed"]);
  tp.put("node:turn", { nodeSeq: 1, turnKey: "main", input: present(`${base(1, "cut-queued")}/turns/main/prompt.md`, 300),
    timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
  // ③ read 且已开跑 —— 执行结果不明
  obs(2, "cut-read", "read", ["cut-observed"]);
  tp.put("node:turn", { nodeSeq: 2, turnKey: "main", input: present(`${base(2, "cut-read")}/turns/main/prompt.md`, 300),
    timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
  tp.put("node:started", { nodeSeq: 2, turnKey: "main", queuedMs: 90 });
  tp.put("node:attempt", { nodeSeq: 2, turnKey: "main", n: 1,
    input: present(`${base(2, "cut-read")}/turns/main/attempt-1.input.md`, 300), inputSha256: sha("c2") });
  tp.put("node:progress", { nodeSeq: 2, turnKey: "main", status: "running", charCount: 820,
    tail: "……正在读 src/auth/session.ts", contextUsage: { tokens: 128000, live: true } });
  // ④ write,已开跑、**还没见过 workspace-intent** —— 创建动作压根没开始,不会有工作副本
  obs(3, "cut-pre", "write", ["cut-observed"]);
  tp.put("node:turn", { nodeSeq: 3, turnKey: "main", input: present(`${base(3, "cut-pre")}/turns/main/prompt.md`, 300),
    timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
  tp.put("node:started", { nodeSeq: 3, turnKey: "main", queuedMs: 70 });
  // ⑤ write,见过 intent、**没见过 created** —— 位置未确认,去看一眼
  obs(4, "cut-creating", "write", ["cut-observed"]);
  tp.put("node:turn", { nodeSeq: 4, turnKey: "main", input: present(`${base(4, "cut-creating")}/turns/main/prompt.md`, 300),
    timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
  tp.put("node:started", { nodeSeq: 4, turnKey: "main", queuedMs: 60 });
  tp.put("node:workspace-intent", { nodeSeq: 4, path: `${CWD}\\.worktrees\\cut-creating`,
    branch: "agent/cut-creating", baseCommit: "a91c04e" });
  // ⑥ write,见过 created —— 执行与代码去向都不明,禁止自动重跑
  obs(5, "cut-created", "write", ["cut-observed"]);
  tp.put("node:turn", { nodeSeq: 5, turnKey: "main", input: present(`${base(5, "cut-created")}/turns/main/prompt.md`, 300),
    timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false });
  tp.put("node:started", { nodeSeq: 5, turnKey: "main", queuedMs: 55 });
  tp.put("node:workspace-intent", { nodeSeq: 5, path: `${CWD}\\.worktrees\\cut-created`,
    branch: "agent/cut-created", baseCommit: "a91c04e" });
  tp.put("node:workspace-created", { nodeSeq: 5, path: `${CWD}\\.worktrees\\cut-created`,
    branch: "agent/cut-created", baseCommit: "a91c04e" });
  // ⑦ 一个已经好好收场的节点 —— 中断**不影响**它,用来盯"别把整次运行涂成结果不明"
  node(tp, { graphId, seq: 6, id: "done-before-cut", agent: "codex", access: "read",
    model: "gpt-5-codex", effort: "medium", status: "ok", durationMs: 120000,
    turns: [{ key: "main", status: "ok", scene: na(), chars: 2200,
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

/* ---- 落盘 ---- */
const outs = [["transcript-main.jsonl", buildMain()], ["transcript-cut.jsonl", buildCut()],
              ["transcript-empty.jsonl", buildEmpty()]];
for (const [name, { graphId, text }] of outs) {
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

   ⚠️ 每个 present 资产都要有**真的文件** —— 少一个,页面点开就是 404,
   而 404 在页面上会被如实标成「记录时它在、现在取不到了」。那是一个**正确的**结论,
   但对着一份自己造的样例得出它,只会让人以为归档坏了。 */
let files = 0;
for (const [name, { graphId }] of outs) {
  const raw = fs.readFileSync(path.join(HERE, "nodes", ".runs", graphId, "transcript.jsonl"), "utf8");
  const refs = new Set();
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (v.state === "present" && typeof v.ref === "string") refs.add(v.ref);
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const line of raw.split("\n").filter(Boolean)) walk(JSON.parse(line).payload);
  for (const ref of refs) {
    const p = path.join(HERE, ref);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const leaf = path.basename(ref);
    let body;
    if (leaf.endsWith(".json")) body = JSON.stringify({ sample: true, graphId, ref }, null, 2) + "\n";
    else if (leaf.endsWith(".patch")) body = `diff --git a/sample b/sample\n(样例占位:${ref})\n`;
    else body = `# 样例内容\n\n这是 \`${ref}\` 的占位正文,供页面离线开发与回归使用。\n\n` +
      `真实运行里这里是那一步的完整产出,**字节直传、未截断**。\n`;
    fs.writeFileSync(p, body, "utf8");
    files++;
  }
}
console.log(`  归档占位文件 ${files} 个`);
