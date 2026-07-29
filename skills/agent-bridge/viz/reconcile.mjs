/**
 * 观测台的**纯决策层** —— 页面与测试共同 import。
 *
 * 两件事：
 *   ① **wire → 展示模型**的适配（`deriveView`）。快照说的是 `status`/`health`/`access` 这些
 *      正交维度，页面要的是「进行中 / 空闲 / 有问题 / 已结束」这四档人话。这层转换必须
 *      **可单测**，不能埋在 DOM 代码里。
 *   ② **增量决策**（`reconcile`）。页面不能每秒 `innerHTML=` 全量重画——会丢折叠状态和
 *      滚动位置，而这个页面可能开着几个小时。
 *
 * ⚠️ **为什么是独立文件而不是写在 `index.html` 里**：
 *    UIREQ §10 要求「单个 HTML 文件」。这里是对它的**一处有意的最小偏离**——
 *    因为「测试要 Node 直接 import 它」和「它写在 HTML 里」自相矛盾。
 *    该约束的实质目的（**零外部依赖、无构建步骤、离线可用**）完全保留：
 *    `reconcile.mjs` 是同目录本地模块，`serve.mjs` 本来就从自己目录供文件。
 *
 * ⚠️ **纯函数**：不碰 DOM、不碰全局、不发请求。
 */

// ── 四档状态（UIREQ §5） ────────────────────────────────────────────────────

/**
 * 两个正交维度合成一档人话。
 *
 * ⚠️ **「没有进程」不等于「死了」。** cursor / kimi 在两轮之间不占任何进程，
 *    但会话完全健康、随时可以继续。所以这里**绝不看 `backendPid`**——
 *    存活只看 status + health。
 */
export function statusKind(s) {
  if (s.openFailed) return "warn";
  if (s.status === "closed" || s.health === "dead") return "end";
  if (s.status === "starting" || s.status === "running") return "run";
  if (s.status === "failed" || s.health === "degraded") return "warn";
  return "idle";
}

export const STATUS_LABEL = { run: "进行中", idle: "空闲", warn: "有问题", end: "已结束" };
/** 排序权重：正在跑 → 有异常 → 空闲 → 已关闭。 */
const STATUS_ORDER = { run: 0, warn: 1, idle: 2, end: 3 };

// ── 三档权限（UIREQ §4.1） ──────────────────────────────────────────────────

/**
 * 「只读」不能当安全承诺。
 *
 * ⚠️ 五个引擎里**只有 codex 的 read 是 OS 沙箱硬拦**；另外四家的 read 只是一句约束，
 *    它跑的 shell 命令照样能写盘。页面上只写「只读」会制造错误的安全感。
 */
export function permKind(s) {
  if (s.access === "write") return "write";
  return s.agent === "codex" ? "hard" : "soft";
}

export const PERM_LABEL = { write: "可写", hard: "只读（强制）", soft: "只读（约定）" };
export const PERM_HINT = {
  write: "明确授权改文件",
  hard: "操作系统级沙箱拦截，真的写不了盘",
  soft: "它仍然有能力写盘，只是被要求不要写",
};

// ── 上下文占用（UIREQ §6.1） ────────────────────────────────────────────────

/**
 * ⚠️ `null` 是**未知**，不是 0。cursor / kimi 恒为 null。
 *    显示成 0 或空进度条会让人以为「很空闲、很安全」——**是反的**。
 */
export function contextLevel(cu) {
  if (!cu || !Number.isFinite(cu.tokens)) return "unknown";
  if (cu.tokens >= 400000) return "reopen";
  if (cu.tokens >= 300000) return "wrap";
  return "normal";
}
export const CONTEXT_LABEL = {
  unknown: "未知 / 不适用", normal: "正常", wrap: "该收尾了", reopen: "该换新会话了",
};

// ── 轮次（UIREQ §6.3） ──────────────────────────────────────────────────────

export const OUTCOME_LABEL = {
  completed: "完成", failed: "失败", aborted: "被中断", abandoned: "未收场",
};
export const BODY_LABEL = {
  final: "完整正文", partial: "只有片段 · 可能不完整", none: "无正文",
};

/**
 * 「未取结果」——UIREQ §2 的场景 3，**这套系统里最常见的一类事故**。
 * 跑完了但主 agent 从没来取，产出就那么晾着。
 */
export function isUncollected(t) {
  return t.state === "settled" && !t.collected;
}

/** 会话有没有值得警示的东西（影响左栏排序与筛选）。 */
export function sessionHasProblem(s) {
  if (s.openFailed) return true;
  if (statusKind(s) === "warn") return true;
  return (s.turns || []).some(t => isUncollected(t) || (t.outcome && t.outcome !== "completed"));
}

/** 会话 id 不可读（`codex-mfx8q2-a7c319`），列表里要缩短。 */
export function shortName(s) {
  if (s.name) return s.name;
  const id = s.sessionId || "";
  const second = id.indexOf("-", id.indexOf("-") + 1);
  return second > 0 ? `${id.slice(0, second)}…${id.slice(-4)}` : id;
}

// ── 快照 → 页面展示模型（**适配层**） ───────────────────────────────────────

/**
 * ⚠️ **这一层必须住在这里，不能内联进 `index.html`。**
 *
 * 它内联在页面里的时候藏过一个正好说明问题的 bug：正文是异步从 `/file` 取的，
 * 取回来只触发了「重画 DOM」，而 DOM 是**从已构造好的展示模型**画的——
 * 那个模型里 `input.text` 早在构造时就被烘成了字符串占位符「正在读取原文…」。
 * 于是缓存填上了、页面也重画了，**正文永远出不来**。
 *
 * 这类 bug 在页面里查不出来，因为没有任何东西能单独喂它一份"缓存从空到满"的输入。
 * 搬到这里之后就是一个纯函数：给两次不同的 `bodyCache`，断言两次输出不同。
 */
export const BODY_PLACEHOLDER = "（正在读取原文…）";

const ENGINE = {
  omp: { name: "Oh My Pi", eb: "OM" },
  codex: { name: "Codex", eb: "CX" },
  claude: { name: "Claude Code", eb: "CC" },
  cursor: { name: "Cursor Agent", eb: "CU" },
  kimi: { name: "Kimi Code", eb: "KM" },
};

function hhmmss(iso, now) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (isNaN(d)) return "--:--:--";
  const p = x => String(x).padStart(2, "0");
  void now;
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function secsSince(iso, now) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round(((now ?? Date.now()) - t) / 1000));
}
function mb(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * 一份正文缓存条目 → 页面要显示的字符串。
 * 四种状态各有各的说法，**不许混成一句**：没取 / 取回来了 / 指纹对不上 / 取失败。
 */
export function bodyText(entry) {
  if (!entry) return BODY_PLACEHOLDER;
  if (entry.pending) return BODY_PLACEHOLDER;
  // ⚠️ 指纹对不上时**绝不照常展示**——那等于替一份被篡改的内容背书。
  if (entry.tamper) return "⚠️ 这份文件在落盘之后被改动过（指纹对不上），已拒绝展示。";
  if (entry.error) return `⚠️ 读取失败：${entry.error}`;
  return entry.text || "";
}
export function bodyUsable(entry) { return !!(entry && !entry.pending && !entry.tamper && !entry.error); }

/**
 * 快照 → 页面展示模型。**纯函数**：同样的输入必得同样的输出。
 *
 * @param {object} snapshot   §4 的快照，**原样**（不得改写它）
 * @param {object} ctx
 *   - `progress`: Map<vizTurnId, sidecar>
 *   - `bodyCache`: Map<ref, entry>   ← 换一份就得到不同的模型，这正是它可测的原因
 *   - `runGone`: boolean
 *   - `vizDir`: string | null
 *   - `now`: number（可注入，便于测试）
 */
export function adaptSnapshot(snapshot, ctx = {}) {
  const { progress = new Map(), bodyCache = new Map(), runGone = false, vizDir = null, now = Date.now() } = ctx;
  return (snapshot?.sessions || []).map(s => adaptSession(s, { progress, bodyCache, runGone, vizDir, now }));
}

function adaptSession(s, c) {
  const eng = ENGINE[s.agent] || { name: s.agent || "未知", eb: "??" };
  const kind = statusKind(s);
  return {
    id: s.sessionId,
    alias: s.name || null,
    engine: s.agent, engineName: eng.name, eb: eng.eb,
    model: s.model || null,
    effort: s.effort || null,
    perm: permKind(s),
    state: s.status, health: s.health,
    // ⚠️ null 是**未知**，不是 0。显示成 0 会让人以为"很空闲、很安全"——是反的。
    ctx: (s.contextUsage && Number.isFinite(s.contextUsage.tokens)) ? s.contextUsage.tokens : null,
    cwd: s.cwd || "",
    createdAt: hhmmss(s.createdAt, c.now),
    lastActive: kind === "run" ? 0 : secsSince(s.updatedAt, c.now),
    startupError: s.openFailed ? s.openFailed.error : null,
    logFile: s.logFile || null,
    turns: (s.turns || []).map(t => adaptTurn(t, c)),
  };
}

function adaptTurn(t, c) {
  // run gone 时把仍是 dispatched 的轮次**合成**为 abandoned（STATE.md §9）。
  // 快照永远发不出终态——`run.status` 只有一档，终态是传输层的一帧。
  const synthesized = c.runGone && t.state === "dispatched";
  const running = t.state === "dispatched" && !synthesized;
  const result = running ? "running" : (synthesized ? "abandoned" : t.outcome);
  const body = running || synthesized ? "none" : t.bodyKind;

  const inEntry = t.input.ref ? c.bodyCache.get(t.input.ref) : { text: "" };
  const o = {
    n: t.turnNo,
    result, body,
    from: hhmmss(t.dispatchedAt, c.now),
    to: t.settledAt ? hhmmss(t.settledAt, c.now) : null,
    dur: Math.round((t.durationMs || 0) / 1000),
    elapsed: running ? secsSince(t.dispatchedAt, c.now) : 0,
    unfetched: isUncollected(t) && !synthesized,
    error: t.error || null,
    vizTurnId: t.vizTurnId,
    pending: t.input.ref ? !bodyUsable(inEntry) : false,
    input: {
      chars: t.input.chars || 0,
      text: t.input.ref ? bodyText(inEntry) : "",
      truncated: t.input.truncated
        ? { orig: mb(t.input.originalBytes), saved: mb(t.input.bytes) } : null,
    },
  };

  if (running) {
    // §5 的四条前提：只有仍是 dispatched、且 sidecar 的 vizTurnId 对得上才合并。
    const p = c.progress.get(t.vizTurnId);
    const okp = p && p.vizTurnId === t.vizTurnId;
    o.live = {
      chars: okp ? (p.charCount || 0) : 0,
      draft: (okp ? p.generationCount : t.generationCount) || 1,
      preview: okp ? (p.tail || "") : "",
      age: okp ? secsSince(p.updatedAt, c.now) : 0,
    };
  } else if (body !== "none") {
    const outEntry = c.bodyCache.get(t.output.ref);
    o.output = { chars: t.output.chars || 0, md: bodyText(outEntry) };
    if (outEntry && outEntry.truncated) {
      o.output.capped = {
        shown: mb((o.output.md || "").length),
        total: mb(outEntry.fullBytes),
        path: (c.vizDir ? `${c.vizDir}\\` : "") + String(t.output.ref).replace(/\//g, "\\"),
      };
    }
    if (!bodyUsable(outEntry)) o.pending = true;
  } else {
    o.output = { chars: 0, md: "" };
  }
  return o;
}

/** 这份快照要取哪些正文（页面据此发 `/file` 请求）。 */
export function refsOf(snapshot) {
  const out = [];
  for (const s of snapshot?.sessions || []) {
    for (const t of s.turns || []) {
      if (t.input?.ref) out.push({ ref: t.input.ref, sha256: t.input.sha256 });
      if (t.output?.ref) out.push({ ref: t.output.ref, sha256: t.output.sha256 });
    }
  }
  return out;
}

// ── 快照 → 内部视图（左栏排序/筛选用） ──────────────────────────────────────

/**
 * @param {object} snapshot  §4 的快照，**原样**（viewer 不得改写它）
 * @param {Map<string,object>} progress  vizTurnId → §5 sidecar
 * @param {{runGone?:boolean}} ctx
 */
export function deriveView(snapshot, progress = new Map(), ctx = {}) {
  const runGone = !!ctx.runGone;
  const sessions = (snapshot?.sessions || []).map(s => {
    const kind = statusKind(s);
    const turns = (s.turns || []).map(t => deriveTurn(t, progress, runGone));
    return {
      raw: s,
      sessionId: s.sessionId,
      display: shortName(s),
      kind,
      statusLabel: STATUS_LABEL[kind],
      perm: permKind(s),
      permLabel: PERM_LABEL[permKind(s)],
      ctxLevel: contextLevel(s.contextUsage),
      problem: sessionHasProblem(s),
      uncollectedCount: turns.filter(t => t.uncollected).length,
      turns,
    };
  });

  // 排序：正在跑 → 有异常 → 空闲 → 已关闭；次级按最后活动时间倒序。
  // ⚠️ **不改 `snapshot.sessions` 本身**（它是 wire 的原样），只排一份副本。
  const order = sessions.slice().sort((a, b) => {
    const ka = a.problem && a.kind !== "run" ? 1 : STATUS_ORDER[a.kind];
    const kb = b.problem && b.kind !== "run" ? 1 : STATUS_ORDER[b.kind];
    if (ka !== kb) return ka - kb;
    return String(b.raw.updatedAt || "").localeCompare(String(a.raw.updatedAt || ""));
  });

  return {
    runId: snapshot?.runId ?? null,
    generation: snapshot?.generation ?? 0,
    degraded: !!snapshot?.run?.degraded,
    recordingErrors: snapshot?.run?.recordingErrors || [],
    runGone,
    sessions: order,
    byId: new Map(order.map(s => [s.sessionId, s])),
  };
}

function deriveTurn(t, progress, runGone) {
  // ⚠️ **run gone 时把仍是 dispatched 的轮次合成为 abandoned**（STATE.md §9）。
  //    这是页面合成的，不是快照里写的——快照永远发不出终态（§4 的 run.status 只有一档）。
  const synthesized = runGone && t.state === "dispatched";
  const outcome = synthesized ? "abandoned" : t.outcome;
  const bodyKind = synthesized ? "none" : t.bodyKind;

  // §5 的四条前提：只有仍是 dispatched、且 sidecar 的 vizTurnId 对得上，才合并 progress。
  // 快照一旦标 settled，迟到的 sidecar **永远无法让它回退**。
  let live = null;
  if (t.state === "dispatched" && !synthesized) {
    const p = progress.get(t.vizTurnId);
    if (p && p.vizTurnId === t.vizTurnId) live = p;
  }

  return {
    raw: t,
    vizTurnId: t.vizTurnId,
    turnNo: t.turnNo,
    running: t.state === "dispatched" && !synthesized,
    synthesized,
    outcome,
    outcomeLabel: outcome ? OUTCOME_LABEL[outcome] : null,
    bodyKind,
    bodyLabel: bodyKind ? BODY_LABEL[bodyKind] : null,
    uncollected: !synthesized && isUncollected(t),
    // 「第 N 稿」徽章的唯一数据源。sidecar 更新得更勤，优先用它。
    generationCount: live?.generationCount ?? t.generationCount ?? 0,
    live,
  };
}

// ── 增量决策 ────────────────────────────────────────────────────────────────

/** 按 key 对齐两份列表。返回进入 / 退出 / 保留 / 目标顺序。 */
export function diffKeyed(prev, next, keyOf) {
  const pk = new Set((prev || []).map(keyOf));
  const nk = (next || []).map(keyOf);
  const nks = new Set(nk);
  return {
    enter: nk.filter(k => !pk.has(k)),
    exit: [...pk].filter(k => !nks.has(k)),
    keep: nk.filter(k => pk.has(k)),
    order: nk,
  };
}

/**
 * 从上一份视图到下一份视图，页面该做什么。
 *
 * @param {object|null} prevView  上一次 `deriveView` 的结果（首帧为 null）
 * @param {object} nextView       这一次的结果
 * @param {object} ui             `{ selectedSessionId, expanded:Set<string>, scrollTop, stickToBottom }`
 * @returns {{sessions, turns, selection, expanded, scrollAnchor}}
 *
 * ⚠️ 返回的是**决定**，不是 DOM 操作。`index.html` 只留一层薄薄的应用层。
 *    这样这套逻辑才跑得进 Node 的测试里（真浏览器自动化在这个仓里不可行：无 package.json、零依赖）。
 */
export function reconcile(prevView, nextView, ui = {}) {
  const prevSessions = prevView?.sessions || [];
  const sessions = diffKeyed(prevSessions, nextView.sessions, s => s.sessionId);

  // 选中项：**能留就留**。只有当它真的消失了，才退到第一个。
  let selection = ui.selectedSessionId ?? null;
  if (!selection || !nextView.byId.has(selection)) {
    selection = nextView.sessions.length ? nextView.sessions[0].sessionId : null;
  }

  const prevSel = prevView?.byId?.get(ui.selectedSessionId ?? "") || null;
  const nextSel = nextView.byId.get(selection) || null;
  const turns = diffKeyed(prevSel?.turns || [], nextSel?.turns || [], t => t.vizTurnId);

  // 展开态：丢掉已经不存在的轮次，其余原样留住。
  const expanded = new Set();
  for (const k of ui.expanded || []) if (turns.order.includes(k)) expanded.add(k);
  // 新出现的**最后一轮**默认展开（UIREQ §6.2：最后一轮两段全展开）。
  const last = turns.order[turns.order.length - 1];
  if (last && turns.enter.includes(last)) expanded.add(last);

  // 换会话时回到顶；否则**保住用户的滚动位置**。
  // 只有在用户本来就贴着底部时才跟着走到底（UIREQ §6.5：用户一旦上滑就停止自动滚）。
  const switched = selection !== (ui.selectedSessionId ?? null);
  const scrollAnchor = switched
    ? { mode: "top", top: 0 }
    : (ui.stickToBottom ? { mode: "bottom", top: null } : { mode: "keep", top: ui.scrollTop ?? 0 });

  // patch = 留下来但内容变了的。判据用**逐字段比**而不是引用比——
  // 每一代快照都是新解析出来的对象，引用永远不相等。
  const prevTurnById = new Map((prevSel?.turns || []).map(t => [t.vizTurnId, t]));
  const patch = turns.keep.filter(k => {
    const a = prevTurnById.get(k), b = nextSel.turns.find(t => t.vizTurnId === k);
    return !sameTurn(a, b);
  });

  const prevSessById = prevView?.byId || new Map();
  const sessPatch = sessions.keep.filter(k => !sameSession(prevSessById.get(k), nextView.byId.get(k)));

  return {
    sessions: { ...sessions, patch: sessPatch },
    turns: { ...turns, patch },
    selection, expanded, scrollAnchor,
  };
}

function sameSession(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.perm === b.perm && a.ctxLevel === b.ctxLevel
    && a.problem === b.problem && a.uncollectedCount === b.uncollectedCount
    && a.turns.length === b.turns.length
    && a.raw.updatedAt === b.raw.updatedAt && a.raw.status === b.raw.status
    && a.raw.health === b.raw.health;
}

function sameTurn(a, b) {
  if (!a || !b) return false;
  return a.running === b.running && a.outcome === b.outcome && a.bodyKind === b.bodyKind
    && a.uncollected === b.uncollected && a.generationCount === b.generationCount
    && a.raw.output?.sha256 === b.raw.output?.sha256
    && a.raw.input?.sha256 === b.raw.input?.sha256
    && (a.live?.updatedAt ?? null) === (b.live?.updatedAt ?? null);
}
