/**
 * 委托会话史观测台 —— writer 侧。
 *
 * **合同在 `skills/agent-bridge/viz/STATE.md`，不在这里。** 本文件是那份散文的一个实现；
 * `skills/agent-bridge/viz/contract-invariants.mjs` 是**另一个**实现，两者刻意互不 import、
 * 不共用常量表。理由见 STATE.md §11：同源的校验器只能证明「我和我自己一致」。
 *
 * 为什么单独一个文件而不是塞进 `agent-bridge.mjs`：
 *   +900 行进 6000 行的 core，writer / ledger / 队列 / cleanup 就**无法直接单测**，
 *   而这套东西的回归必须零消耗（不能每次都拉真后端）。
 *
 * ⚠️ **零副作用**：模块顶层不做任何事。只有 `createVizRun()` 被调用才 `mkdtemp`。
 *    `doctor` / `cleanup` / `help` / 测试 import 都不许凭空建目录。
 * ⚠️ **不 import 主文件**：`agent-bridge.mjs` 底部立即执行 `runCli()`，import 它就会启动 CLI。
 *    需要主文件的东西一律由调用方注入。
 * ⚠️ **所有公开方法 non-throwing**：观测失败绝不能改变桥的运行结局。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ── 常量 ────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;

/** 目录前缀。`cleanup` 的孤儿回收按这个 glob 找。 */
export const VIZ_DIR_PREFIX = "agent-bridge-viz-";

/** 单条错误文本硬顶（code unit）。超了截断——错误信息再长也不该把快照撑爆。 */
const ERROR_MAX_CHARS = 300;

/** `run.recordingErrors` 上限。满了丢新的，不挤掉旧的（先发生的更接近根因）。 */
const RECORDING_ERRORS_MAX = 16;

/** 有界队列。三条阈值各管一件事，不要合并。 */
const MAX_PENDING_JOBS = 64;                     // 排队条数
const MAX_PENDING_BYTES = 64 * 1024 * 1024;      // 排队总字节
const MAX_ITEM_BYTES = 32 * 1024 * 1024;         // 单条上限 → queue_item_too_large

/** 实时尾巴长度（code unit）。 */
const TAIL_CHARS = 400;

/**
 * sidecar 的最小写入间隔。页面只要 ~1 Hz 的观感，而 delta 回调是**每 token 级**。
 * ⚠️ 节流放在 writer 里而不是让五个后端各自自律——五处纪律迟早有一处忘。
 */
const PROGRESS_MIN_MS = 400;

/** 正文供体的硬顶。再等下去就是让观测拖住桥。 */
const BODY_PROVIDER_MAX_MS = 2000;

/** 快照写失败后的自动重试：间隔与连续次数上限。
 *  ⚠️ 有上限是因为磁盘真坏掉时不该一直烧 IO；再有新里程碑会重新开始计数。 */
const SNAPSHOT_RETRY_MS = 250;
const SNAPSHOT_RETRY_MAX = 3;

/** sessionId 直接做目录名，字符集必须先卡死。 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 错误文本有界化。**注意单位是 code unit**（STATE.md §3）。 */
function boundError(v) {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : (v?.message ? String(v.message) : String(v));
  return s.length > ERROR_MAX_CHARS ? s.slice(0, ERROR_MAX_CHARS) : s;
}

/**
 * 取末 N 个 code unit，并**丢掉两端落单的代理**。
 *
 * ⚠️ 直接 `.slice(-400)` 会从代理对中间切开，页面上就是一个 `U+FFFD`。
 *    graph 那边踩过这个坑并已修（`viz-node.mjs` 的 `trimLoneSurrogate`）。
 */
function tailOf(s, n = TAIL_CHARS) {
  if (typeof s !== "string" || s.length === 0) return "";
  let t = s.length > n ? s.slice(-n) : s;
  const first = t.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) t = t.slice(1);           // 落单低代理
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);         // 落单高代理
  return t;
}

/**
 * 计数一律走这里。
 *
 * ⚠️ **`NaN` / `Infinity` 经 `JSON.stringify` 会静默变成 `null`**，而 `null` 在这份 schema 里
 *    到处都是合法值——于是一个算错的数字会**伪装成「这项没有」**。写入侧就必须挡住。
 */
function safeCount(n) {
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function nowIso(clock) {
  return new Date(clock ? clock() : Date.now()).toISOString();
}

// ── 注入面 ──────────────────────────────────────────────────────────────────

/**
 * 文件 IO 全部走这一层，方便测试注入故障与断言并发写数。
 * ⚠️ 这**不是**目录参数：注入的是「怎么写」，不是「写去哪」（STATE.md §2.2）。
 */
function defaultIo() {
  return {
    mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
    mkdtempSync: (prefix) => fs.mkdtempSync(prefix),
    writeFileSync: (p, data) => fs.writeFileSync(p, data),
    mkdir: (p) => fsp.mkdir(p, { recursive: true }),
    writeFile: (p, data) => fsp.writeFile(p, data),
    unlink: (p) => fsp.unlink(p),
    rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
  };
}

// ── 串行 writer + 有界队列 + 合并快照槽 ─────────────────────────────────────

/**
 * **严格串行**：同一时刻在途的写有且只有一个。
 *
 * 为什么不并发：双槽协议的正确性建立在「永不重叠写」上（STATE.md §2）。
 * 两个写同时进行时，「始终覆盖较旧的槽」这句话就没有意义了。
 *
 * 队列分两条通道，**故意不共用预算**：
 *   - 普通 job（正文文件）：受 `MAX_PENDING_*` 三条限制
 *   - 快照：**单一可合并的 dirty slot**，新的直接盖掉旧的
 *
 * ⚠️ 快照不进普通队列，是因为「队列满」这个状态本身要靠快照告诉页面。
 *    让它们争同一份容量，就会出现**连 `degraded` 自己都排不进去**的死角。
 */
class SerialWriter {
  #io;
  #jobs = [];
  #pendingBytes = 0;
  #draining = false;
  #stopped = false;

  #inflight = 0;
  /** 给测试用：整个生命周期里同时在途的写的最大值。**必须恒为 1。** */
  maxInflightSeen = 0;

  #snapshotDirty = null;      // { build: () => {path, data} }
  #snapshotFails = 0;
  #retryTimer = null;

  /**
   * 覆盖写的合并槽：`path → { dir, data }`。sidecar 走这里，**不进有界队列**。
   *
   * ⚠️ 这不是优化，是**修一个会把健康会话报成故障的缺陷**：
   *    进度回调是**每 token 级**频率，而正文队列只有 64 条。让 sidecar 走队列，
   *    一个正常跑着的轮次几百毫秒就能把队列打满 → `queue_full` → `run.degraded = true`
   *    → 页面顶上挂出「本次记录不完整」。**观测把被观测者报成了病人。**
   *    sidecar 的语义本来就是"最新即真、旧的可丢"，和快照同类——就该走合并槽。
   */
  #coalesced = new Map();
  #coalescedNextAt = new Map();
  #coalescedTimer = null;

  #onError;

  constructor(io, onError) { this.#io = io; this.#onError = onError; }

  get pendingJobs() { return this.#jobs.length; }
  get pendingBytes() { return this.#pendingBytes; }

  /**
   * 「彻底静止」——**三件事都要看**：没有排队的正文、没有待发布的快照、也不在排空中。
   *
   * ⚠️ 只看 `pendingJobs` 是不够的：一次纯里程碑（比如 `sessionOpened`）**一个 job 都不产生**，
   *    活儿全在合并槽里。拿 `pendingJobs === 0` 当"写完了"，就会在快照还没落盘时就去读文件——
   *    随机绿随机红，且失败方向取决于当天 Defender 的心情。
   *    这个 getter 只服务测试与诊断；**桥的热路径永不 await 它**。
   */
  get idle() {
    return !this.#draining && this.#jobs.length === 0 && !this.#snapshotDirty
      && !this.#retryTimer && this.#coalesced.size === 0;
  }

  /**
   * 入队一个正文写。**返回是否入队成功 + 拒绝原因码**，不抛。
   * 调用方拿到 `queue_full` / `queue_item_too_large` 后必须**同步**完成降级收口。
   */
  enqueue(job) {
    if (this.#stopped) return { ok: false, code: "queue_full" };
    const bytes = job.data.length;
    if (bytes > MAX_ITEM_BYTES) return { ok: false, code: "queue_item_too_large" };
    if (this.#jobs.length >= MAX_PENDING_JOBS) return { ok: false, code: "queue_full" };
    if (this.#pendingBytes + bytes > MAX_PENDING_BYTES) return { ok: false, code: "queue_full" };
    this.#jobs.push(job);
    this.#pendingBytes += bytes;
    this.#drain();
    return { ok: true, code: null };
  }

  /** 快照永远接受——它走独立的合并槽。新的盖旧的，**不排队堆积**。 */
  markSnapshotDirty(build) {
    if (this.#stopped) return;
    this.#snapshotDirty = { build };
    this.#snapshotFails = 0;
    this.#drain();
  }

  /**
   * 覆盖写的合并槽。同一路径新的直接盖旧的；每条路径有**最小写入间隔**。
   *
   * 光靠合并还不够：合并只保证"不堆积"，不保证"不频繁"——排空一次就能写一次，
   * 于是磁盘有多快就写多快。加一道最小间隔，把它压到页面真正需要的节奏（~1 Hz 量级）。
   * 到点前来的更新不丢，只是等下一拍一起发；**最后一拍由定时器补**，不会漏掉收尾那一版。
   */
  markCoalesced(path, dir, data, minIntervalMs) {
    if (this.#stopped) return;
    this.#coalesced.set(path, { dir, data, minIntervalMs });
    this.#armCoalesced();
    this.#drain();
  }

  dropCoalesced(path) {
    this.#coalesced.delete(path);
    this.#coalescedNextAt.delete(path);
  }

  #armCoalesced() {
    if (this.#coalescedTimer || this.#stopped || this.#coalesced.size === 0) return;
    let wait = 0;
    const now = Date.now();
    for (const [p] of this.#coalesced) {
      const due = this.#coalescedNextAt.get(p) ?? 0;
      wait = Math.max(wait, Math.min(1000, Math.max(0, due - now)));
    }
    this.#coalescedTimer = setTimeout(() => { this.#coalescedTimer = null; this.#drain(); }, wait + 5);
    this.#coalescedTimer.unref?.();
  }

  /** 取一条到点的合并项；没有到点的就返回 null（留给定时器）。 */
  #takeCoalesced() {
    const now = Date.now();
    for (const [p, v] of this.#coalesced) {
      if ((this.#coalescedNextAt.get(p) ?? 0) <= now) {
        this.#coalesced.delete(p);
        this.#coalescedNextAt.set(p, now + (v.minIntervalMs ?? 0));
        return { path: p, ...v };
      }
    }
    return null;
  }

  #drain() {
    if (this.#draining || this.#stopped) return;
    this.#draining = true;
    queueMicrotask(() => { this.#loop().catch(() => {}); });
  }

  async #loop() {
    try {
      for (;;) {
        if (this.#stopped) break;
        const co = this.#takeCoalesced();
        if (!this.#jobs.length && !this.#snapshotDirty && !co) break;
        // 先推一条正文，再尝试发布最新快照，最后才是 sidecar。
        // 交替是故意的:队列满时正文仍在排空,而快照**总有机会**把 degraded 发出去;
        // sidecar 排最后,因为它是三者里唯一"丢了也不影响正确性"的。
        if (this.#jobs.length) {
          const job = this.#jobs.shift();
          this.#pendingBytes -= job.data.length;
          await this.#run(job);
        }
        if (this.#stopped) break;
        if (this.#snapshotDirty) {
          const slot = this.#snapshotDirty;
          this.#snapshotDirty = null;
          await this.#runSnapshot(slot);
        }
        if (this.#stopped) break;
        // sidecar 写失败**不置 degraded**:它是可再生的过程数据,下一拍就会重来。
        // 把它算进"记录不完整"会让页面对一件无关紧要的事拉警报。
        if (co) await this.#run({ path: co.path, dir: co.dir, data: co.data, quiet: true });
      }
      this.#armCoalesced();
    } finally {
      this.#draining = false;
    }
  }

  async #run(job) {
    this.#inflight++;
    if (this.#inflight > this.maxInflightSeen) this.maxInflightSeen = this.#inflight;
    try {
      if (job.dir) await this.#io.mkdir(job.dir);
      await this.#io.writeFile(job.path, job.data);
      job.onDone?.(null);
    } catch (err) {
      // ⚠️ 观测失败只描述"我们没记下来",绝不改变后端的 outcome。
      if (!job.quiet) this.#onError?.("write_failed", err);
      job.onDone?.(err);
    } finally {
      this.#inflight--;
    }
  }

  async #runSnapshot(slot) {
    this.#inflight++;
    if (this.#inflight > this.maxInflightSeen) this.maxInflightSeen = this.#inflight;
    let built = null;
    try {
      built = slot.build();
      if (!built) return;
      await this.#io.writeFile(built.path, built.data);
      built.onPublished?.();
      this.#snapshotFails = 0;
    } catch (err) {
      // ⚠️ **绝不把一次失败当作已发布**:保留 dirty 供后续重试,且**不推进槽位**——
      //    这样新的写还是覆盖那个较旧的槽,最新的合法槽岿然不动。
      // ⚠️ **不在这里就地把 dirty 挂回去**:排空循环还在跑,`while` 条件立刻又为真,
      //    于是"退避 250ms 再试"变成**原地立即重试**——瞬时故障(Defender 短暂锁文件)
      //    上立刻重试基本必然再失败,3 次预算一口气烧完,退避的意义整个丢掉。
      //    交给定时器放回去,才是真的退避。
      this.#onError?.("snapshot_write_failed", err);
      built?.onFailed?.();
      this.#snapshotFails++;
      if (this.#snapshotFails <= SNAPSHOT_RETRY_MAX) this.#armRetry(slot);
    } finally {
      this.#inflight--;
    }
  }

  #armRetry(slot) {
    if (this.#retryTimer || this.#stopped) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      // 期间要是来了更新的里程碑,用更新的那份——重试的目的是"发出去",不是"发那一代"。
      if (!this.#snapshotDirty) this.#snapshotDirty = slot;
      this.#drain();
    }, SNAPSHOT_RETRY_MS);
    this.#retryTimer.unref?.();
  }

  /** 有待重试的快照时,`idle` 不能报真——否则测试会在重试之前就判定"写完了"。 */
  get retryPending() { return !!this.#retryTimer; }

  /** 停止接收新任务并丢弃在途队列。**O(1)，无 IO。** */
  stop() {
    this.#stopped = true;
    this.#jobs.length = 0;
    this.#pendingBytes = 0;
    this.#snapshotDirty = null;
    this.#coalesced.clear();
    this.#coalescedNextAt.clear();
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    if (this.#coalescedTimer) { clearTimeout(this.#coalescedTimer); this.#coalescedTimer = null; }
  }
}

// ── VizLedger ───────────────────────────────────────────────────────────────

/**
 * 轮次的内部状态机。
 *
 * ```
 * attempted ──dispatch──> dispatched ──settleOnce──> settling ──写完/降级──> settled
 *     │                        ↑
 *     ├──确定拒绝──> rejected（销毁，不产生 turnNo，不发任何事件）
 *     └──无法判断──> ambiguous ──单个可认领时被后到终结 adopt──┘
 *                         └──多个/无法认领──> unresolved（销毁 + degraded）
 * ```
 *
 * **公开快照只暴露 `dispatched` 与 `settled`。** 其余留在内部，
 * 避免 UI 渲染半提交状态。
 */
class VizLedger {
  sessions = new Map();          // sessionId → session rec（**插入顺序 = attempt 创建顺序**）
  attempts = new Map();          // attemptId → attempt
  byBackendTurnId = new Map();   // backendTurnId → attemptId
  /** OMP 专用：`(sessionId, requestId)` → attemptId。**纯 observer**，不动核心 `this.pending`。 */
  pendingRpc = new Map();

  #seq = 0;

  nextAttemptId() { return `at-${++this.#seq}`; }

  session(sessionId) { return this.sessions.get(sessionId) || null; }

  /**
   * **原子**分配 turnNo 并转 dispatched。
   *
   * ⚠️ 全程同步、**中间没有一个 await**——这就是它的原子性来源。
   *    两个入口各自分配 turnNo 会绕过任何去重键，所以只允许这一个地方分配。
   */
  acceptOrAdopt(attemptId, boundary, at) {
    const a = this.attempts.get(attemptId);
    if (!a) return null;
    // ⚠️ **返回形状必须只有一种。** 早先这里的幂等早退返回的是裸 attempt、
    //    正常路径返回 `{attempt, buffered}`,于是调用方的 `res.attempt` 在幂等路径上
    //    是 `undefined` → 重复 dispatch **静默返回 null**,看起来像"派发失败"。
    //    同一个函数两种返回形状,是这类静默错误的标准产地。
    if (a.state === "dispatched" || a.state === "settling" || a.state === "settled") {
      return { attempt: a, buffered: null };
    }
    if (a.state !== "attempted" && a.state !== "ambiguous") return null;
    const s = this.sessions.get(a.sessionId);
    if (!s) return null;
    a.turnNo = ++s.turnSeq;
    a.vizTurnId = `vt-${a.sessionId}-${a.turnNo}-${a.id.slice(3)}`;
    a.state = "dispatched";
    a.boundary = boundary;
    a.dispatchedAt = at;
    s.turns.push(a);
    // ACK 之前到的 lifecycle/terminal 暂存在 attempt 上，**这里立刻归并**——
    // 否则会出现「已结束却永远不 settle」的轮次。
    const buffered = a.buffered;
    a.buffered = null;
    return { attempt: a, buffered };
  }

  /** 只在 `ambiguous` 里找，且**同一 session 有多个时禁止认领**。 */
  claimableAmbiguous(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { attempt: null, tooMany: false };
    const cands = s.attempts.filter(a => a.state === "ambiguous");
    if (cands.length === 1) return { attempt: cands[0], tooMany: false };
    return { attempt: null, tooMany: cands.length > 1 };
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/** 所有方法都是 no-op 的 recorder。开关没开、或初始化失败时返回它。 */
function disabledRecorder(reason) {
  const noop = () => {};
  return {
    enabled: false, dir: null, runId: null, disabledReason: reason,
    sessionOpened: noop, sessionStatus: noop, sessionOpenFailed: noop, sessionClosed: noop,
    attempt: () => null, dispatch: () => null, reject: noop, ambiguous: noop,
    adoptByTerminal: () => null, firstBackendEvent: noop, progress: noop,
    settleOnce: () => Promise.resolve(), collected: noop, bindBackendTurnId: noop,
    finalizeSession: noop, sealAndStop: noop, cleanup: noop,
    // ⚠️ 这几个也必须在场。桥会无条件调它们；少一个,**关掉观测就等于当场崩掉桥**——
    //    而"关掉观测"是默认路径。
    activeAttempt: () => null, rpcRegister: noop, rpcTake: () => null,
    rpcDrainSession: () => 0, markSessionTerminal: noop,
    snapshot: () => null, _writer: null, _ledger: null,
  };
}

/**
 * 建一次 run 的观测目录并返回 recorder。
 *
 * ⚠️ **签名里没有目录参数，这是刻意的**（STATE.md §2.2）。
 *    唯一入口自己 `mkdtemp`，公开面上就**没有任何办法**让 writer 指向别的目录——
 *    于是「指向了已存在的旧目录」这个状态**结构上不可达**。
 *    为一个到不了的状态写实现 + 原因码 + 机器验收，等于给测试造一个只有测试能构造出来的绿灯。
 *    （落地位置由环境的 tmpdir 决定；测试改 `TEMP`/`TMP` 即可，不需要 API 开口子。）
 */
export function createVizRun({
  bridgeVersion = "unknown",
  env = process.env,
  io = null,
  clock = null,
  onDiagnostic = null,
} = {}) {
  const flag = String(env.AGENT_BRIDGE_VIZ ?? "").trim().toLowerCase();
  // **默认关。** 理由见 STATE.md §7:开着就等于"本机磁盘上存在全部委托原文"。
  if (flag !== "on" && flag !== "1" && flag !== "true") return disabledRecorder("off");

  const IO = io || defaultIo();
  const diag = (kind, err) => { try { onDiagnostic?.(kind, err); } catch {} };

  let dir, runId;
  try {
    dir = IO.mkdtempSync(path.join(os.tmpdir(), VIZ_DIR_PREFIX));
    runId = `mcp-${path.basename(dir).slice(VIZ_DIR_PREFIX.length)}`;
    const startedAt = nowIso(clock);
    // meta.json **只放不可变身份字段**,写一次就再也不动(STATE.md §6.1:
    // 同一个事实有两份可写的副本,就一定会漂)。
    IO.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
      runId, pid: process.pid, processStartedAt: startedAt,
      bridgeVersion, createdAt: startedAt,
    }));
    // 键名与 meta.json 保持一致（都是 processStartedAt）——同一个概念两个名字，
    // 读的人就只能猜，而猜错了两边都"对"。
    IO.writeFileSync(path.join(dir, "owner"),
      JSON.stringify({ pid: process.pid, processStartedAt: startedAt }));
  } catch (err) {
    diag("init_failed", err);
    return disabledRecorder("init_failed");
  }

  return new VizRecorder({ dir, runId, bridgeVersion, io: IO, clock, diag });
}

class VizRecorder {
  enabled = true;
  disabledReason = null;

  #dir; #runId; #bridgeVersion; #io; #clock; #diag;
  #writer; #ledger = new VizLedger();
  #startedAt;
  #generation = 0;
  /** 下一次写哪个槽。**始终是较旧的那个**；写成功才切，失败不切。 */
  #nextSlot = 0;
  #degraded = false;
  #recordingErrors = [];
  #sealed = false;

  constructor({ dir, runId, bridgeVersion, io, clock, diag }) {
    this.#dir = dir; this.#runId = runId; this.#bridgeVersion = bridgeVersion;
    this.#io = io; this.#clock = clock; this.#diag = diag;
    this.#startedAt = nowIso(clock);
    this.#writer = new SerialWriter(io, (code, err) => {
      this.#noteRecordingError(code);
      diag(code, err);
    });
  }

  get dir() { return this.#dir; }
  get runId() { return this.#runId; }
  get _writer() { return this.#writer; }
  get _ledger() { return this.#ledger; }

  #now() { return nowIso(this.#clock); }

  /**
   * 观测失败的三处连带写入之二（第三处是 turn 上的 `input.error`/`output.error`）。
   * ⚠️ 三处不同步就是「页面看起来完整、实则缺页」。
   */
  #noteRecordingError(code) {
    this.#degraded = true;
    if (!this.#recordingErrors.includes(code) && this.#recordingErrors.length < RECORDING_ERRORS_MAX) {
      this.#recordingErrors.push(code);
    }
  }

  #markDirty() {
    if (this.#sealed) return;
    this.#writer.markSnapshotDirty(() => {
      const gen = this.#generation + 1;
      const slot = this.#nextSlot;
      const snap = this.#buildSnapshot(gen);
      return {
        path: path.join(this.#dir, `state.${slot}.json`),
        data: Buffer.from(JSON.stringify(snap), "utf8"),
        onPublished: () => {
          // **发布屏障**:generation 与槽位只在写成功之后才推进。
          this.#generation = gen;
          this.#nextSlot = 1 - slot;
        },
        onFailed: () => { /* 什么都不推进——最新的合法槽必须岿然不动 */ },
      };
    });
  }

  // ── 会话 ──────────────────────────────────────────────────────────────

  #safe(fn) {
    // 所有公开方法都过这里。**观测绝不改变桥的运行结局。**
    try { return fn(); } catch (err) { this.#diag("recorder_error", err); return null; }
  }

  sessionOpened(info) {
    return this.#safe(() => {
      const id = String(info?.sessionId ?? "");
      if (!SAFE_ID.test(id)) { this.#diag("bad_session_id", new Error(id)); return; }
      if (this.#ledger.sessions.has(id)) { this.sessionStatus(id, info); return; }
      const at = this.#now();
      // ⚠️ **逐字段白名单映射,不许 spread `session.summary()`**——
      //    否则后端将来新增字段会静默流进快照,绕过白名单纪律。
      this.#ledger.sessions.set(id, {
        sessionId: id,
        name: info.name ?? null,
        agent: info.agent ?? null,
        model: info.model ?? null,
        effort: info.effort ?? null,
        access: info.access ?? null,
        cwd: info.cwd ?? null,
        returnMode: info.returnMode ?? "full",
        logFile: info.logFile ?? null,
        appendSystemPrompt: info.appendSystemPrompt
          ? {
              file: info.appendSystemPrompt.file ?? null,
              bytes: safeCount(info.appendSystemPrompt.bytes),
              injectionMode: info.appendSystemPrompt.injectionMode ?? null,
            }
          : null,
        backendPid: safeCount(info.backendPid),
        status: info.status ?? "starting",
        health: info.health ?? "healthy",
        isStreaming: !!info.isStreaming,
        contextUsage: this.#mapContextUsage(info.contextUsage),
        createdAt: at, updatedAt: at,
        openFailed: null, closed: null,
        turns: [], attempts: [], turnSeq: 0, activeAttemptId: null,
      });
      this.#markDirty();
    });
  }

  #mapContextUsage(cu) {
    // ⚠️ `null` 是「未知」,不是 0。cursor / kimi **恒为 null**。
    if (!cu || typeof cu !== "object") return null;
    const out = { tokens: safeCount(cu.tokens), live: !!cu.live };
    // 这两个键**只有 OMP 会给**,其余后端不出现——所以按存在与否透传,不补默认值。
    if (cu.isCompacting !== undefined) out.isCompacting = !!cu.isCompacting;
    if (cu.autoCompactionEnabled !== undefined) out.autoCompactionEnabled = !!cu.autoCompactionEnabled;
    return out;
  }

  sessionStatus(sessionId, info) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s) return;
      let changed = false;
      const set = (k, v) => { if (s[k] !== v) { s[k] = v; changed = true; } };
      if (info.status !== undefined) set("status", info.status);
      if (info.health !== undefined) set("health", info.health);
      if (info.isStreaming !== undefined) set("isStreaming", !!info.isStreaming);
      if (info.backendPid !== undefined) set("backendPid", safeCount(info.backendPid));
      if (info.model !== undefined) set("model", info.model ?? null);
      if (info.contextUsage !== undefined) {
        const next = this.#mapContextUsage(info.contextUsage);
        if (JSON.stringify(next) !== JSON.stringify(s.contextUsage)) { s.contextUsage = next; changed = true; }
      }
      // ⚠️ 无变化时**不推进 generation**——重复 close / 重复 status 不该造出新一代快照。
      if (!changed) return;
      s.updatedAt = this.#now();
      this.#markDirty();
    });
  }

  sessionOpenFailed(sessionId, { phase, error } = {}) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s) return;
      s.openFailed = { phase: phase ?? "start", error: boundError(error) };
      s.status = "failed";
      s.health = "dead";
      // ⚠️ 顺序定死:**openFailed 优先,抑制该 sessionId 的 closed**。
      //    open 失败分支会先 close 再 openFailed,不抑制的话页面上就只剩一句"已关闭",
      //    "为什么起不来"这个真正有用的信息被盖掉。
      s.closed = null;
      s.suppressClosed = true;
      s.updatedAt = this.#now();
      this.#markDirty();
    });
  }

  sessionClosed(sessionId, { reason, forced = false } = {}) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s) return;
      if (s.suppressClosed) return;
      if (s.closed) return;                      // 按 sessionId 幂等
      s.closed = { reason: boundError(reason), forced: !!forced, at: this.#now() };
      s.status = "closed";
      s.updatedAt = s.closed.at;
      this.finalizeSession(sessionId);
      this.#markDirty();
    });
  }

  // ── 轮次 ──────────────────────────────────────────────────────────────

  /** 记一次「打算发」。**此刻还没有 turnNo，也不产生任何公开状态。** */
  attempt({ sessionId, source = "send_message", blocking = false, hasSchema = false, input = null } = {}) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s) return null;
      const a = {
        id: this.#ledger.nextAttemptId(), sessionId,
        state: "attempted", turnNo: null, vizTurnId: null,
        backendTurnId: null, backendTurnCount: null, boundary: null,
        attemptedAt: this.#now(), dispatchedAt: null, settledAt: null,
        firstBackendEventAt: null,
        source, blocking: !!blocking, hasSchema: !!hasSchema,
        input: { state: "pending", ref: null, sha256: null, chars: null, bytes: null,
                 truncated: false, originalBytes: null, error: null },
        output: { state: "pending", ref: null, sha256: null, chars: null, bytes: null,
                  previewBytes: null, previewSha256: null, error: null },
        outcome: null, bodyKind: null, generationCount: 0,
        collected: null, error: null, durationMs: null,
        buffered: null, settlePromise: null, pendingInput: input ?? null,
      };
      this.#ledger.attempts.set(a.id, a);
      s.attempts.push(a);
      // ⚠️ **会话级的"当前 attempt"**。没有它，`firstBackendEvent` / `progress` /
      //    OMP 的 `agent_end` / `abort` 这些**拿不到 attemptId 的调用点**就没法接线:
      //    它们各自所在的函数(通知处理器、事件分发)没有 send() 的闭包,
      //    而 `pendingRpc` 在 ACK 之后就被删了。
      //    桥侧因此只需要传 sessionId,由这里解析——**别让五个后端各自去想办法存这个 id**。
      s.activeAttemptId = a.id;
      return a.id;
    });
  }

  /**
   * 派发边界确认 → 分配 turnNo → 公开这一轮。**同步完成**。
   *
   * ⚠️ **不等 `currentTurnId`**——它要到 await 恢复之后才生成，而 OMP 的同一批次
   *    后续行会同步进 `#applyEvent`：等它就会出现「先 settle 后 accept」。
   *    公开 `turnId` 一律用 viz 自己的稳定 ID，`backendTurnId` 作可选别名后绑。
   */
  dispatch(attemptId, { boundary, backendTurnId = null } = {}) {
    return this.#safe(() => {
      const res = this.#ledger.acceptOrAdopt(attemptId, boundary, this.#now());
      if (!res || !res.attempt) return null;
      const a = res.attempt;
      if (backendTurnId) this.bindBackendTurnId(attemptId, backendTurnId);
      // 输入正文：dispatch 时文件**还没写完**，所以先不公布 ref（STATE.md §4.7 悬空 ref）。
      if (a.pendingInput != null) { const t = a.pendingInput; a.pendingInput = null; this.#writeInput(a, t); }
      // ACK 之前到的事件在这里归并。
      if (res.buffered) {
        if (res.buffered.firstBackendEventAt && !a.firstBackendEventAt) {
          a.firstBackendEventAt = res.buffered.firstBackendEventAt;
        }
        if (res.buffered.terminal) {
          const t = res.buffered.terminal;
          this.#markDirty();
          this.settleOnce(attemptId, t);
          return a.vizTurnId;
        }
      }
      this.#markDirty();
      return a.vizTurnId;
    });
  }

  /** 确定拒绝：**立即销毁，不产生 turnNo、不产生任何公开状态**。 */
  reject(attemptId, reason) {
    return this.#safe(() => {
      const a = this.#ledger.attempts.get(attemptId);
      if (!a || a.state !== "attempted") return;
      a.state = "rejected"; a.error = boundError(reason);
      this.#ledger.attempts.delete(attemptId);
      const s = this.#ledger.session(a.sessionId);
      if (s) s.attempts = s.attempts.filter(x => x !== a);
      // **不 markDirty**:它从来没公开过,快照里本来就没有它。
    });
  }

  /**
   * 无法判断：保留待认领。
   *
   * ⚠️ 这一档存在的全部意义，是**不要把「后端可能仍在跑」这个歧义抹掉**。
   *    OMP 的 ACK 超时、Codex 的 `turn/start` 超时都属于这里——
   *    源码注释明写「the app-server may yet return a turn id and run that turn untracked」。
   */
  ambiguous(attemptId, reason) {
    return this.#safe(() => {
      const a = this.#ledger.attempts.get(attemptId);
      if (!a || a.state !== "attempted") return;
      a.state = "ambiguous"; a.error = boundError(reason);
    });
  }

  /**
   * 后到的终结事件来了，看能不能认领一个歧义 attempt。
   *
   * ⚠️ **只看 `ambiguous`**，绝不按 sessionId 从所有失败 attempt 里捞。
   * ⚠️ 同一 session 有多个 ambiguous 时**禁止认领**——仅凭 sessionId 无法知道
   *    这个 `agent_end` 属于哪个 prompt。一律转 `unresolved` + degraded，
   *    **不许永远挂在 ledger 上**。
   */
  adoptByTerminal(sessionId) {
    return this.#safe(() => {
      const { attempt, tooMany } = this.#ledger.claimableAmbiguous(sessionId);
      if (tooMany) {
        const s = this.#ledger.session(sessionId);
        for (const a of s.attempts) {
          if (a.state === "ambiguous") { a.state = "unresolved"; this.#ledger.attempts.delete(a.id); }
        }
        s.attempts = s.attempts.filter(a => a.state !== "unresolved");
        this.#noteRecordingError("write_failed");   // 记录不完整:有轮次永远说不清
        this.#markDirty();
        return null;
      }
      if (!attempt) return null;
      // 没有任何 ACK 可依,证据只有"后到的终结事件" → boundary 必须如实是 terminal_adopted。
      const vizTurnId = this.dispatch(attempt.id, { boundary: "terminal_adopted" });
      return vizTurnId ? attempt.id : null;
    });
  }

  /**
   * 把 sessionId 解析成「这个会话当前那个 attempt」。
   *
   * 给**拿不到 attemptId 的调用点**用（通知处理器、事件分发、abort）。
   * 已经 settled 的不再返回——否则一条迟到的事件会打到上一轮头上。
   */
  activeAttempt(sessionId) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s?.activeAttemptId) return null;
      const a = this.#ledger.attempts.get(s.activeAttemptId);
      if (!a || a.state === "settled" || a.state === "rejected") return null;
      return a.id;
    });
  }

  // ── OMP 的 pendingRpc 观测映射 ────────────────────────────────────────
  //
  // ⚠️ **只暴露方法，不暴露那张 Map。** 直接把 `_ledger.pendingRpc` 交给桥去 set/delete，
  //    就等于把「观测绝不影响桥」这条边界的执行责任推给调用方——而且 disabled recorder
  //    根本没有 `_ledger`（是 null），照那个写法接线会在关闭观测时**当场崩掉桥**。
  //    这三个方法在 disabled 时是安全 no-op。

  rpcRegister(sessionId, requestId, attemptId) {
    return this.#safe(() => { this.#ledger.pendingRpc.set(`${sessionId} ${requestId}`, attemptId); });
  }

  /** 取出并**删除**——五类出口都调它，重复调用是安全的。 */
  rpcTake(sessionId, requestId) {
    return this.#safe(() => {
      const k = `${sessionId} ${requestId}`;
      const v = this.#ledger.pendingRpc.get(k) ?? null;
      this.#ledger.pendingRpc.delete(k);
      return v;
    });
  }

  /**
   * 批量清一个会话的残留映射（进程崩 / `#markUnresponsive` / close 走这里）。
   * 每个还挂着的 attempt 一律转 `ambiguous`——**超时或断链不等于后端没接受**。
   */
  rpcDrainSession(sessionId, reason) {
    return this.#safe(() => {
      const prefix = `${sessionId} `;
      const drained = [];
      for (const k of [...this.#ledger.pendingRpc.keys()]) {
        if (!k.startsWith(prefix)) continue;
        drained.push(this.#ledger.pendingRpc.get(k));
        this.#ledger.pendingRpc.delete(k);
      }
      for (const id of drained) this.ambiguous(id, reason);
      return drained.length;
    });
  }

  /**
   * 会话进入终态（后端崩了 / RPC 静默超时 / stdin 断了）时的收口。
   *
   * ⚠️ **和 `finalizeSession()` 不是一回事，混用会静默改写事实。**
   *    `finalizeSession` 把在途轮次收成 `abandoned`（"会话被关掉，这轮从中间截断了"），
   *    而后端崩掉时事实是 `failed`。PLAN 原本指望一个 poller 去补这个差别，
   *    但退出期**没有下一拍**——poller 补不上，`abandoned` 就会顶替 `failed` 写进记录。
   *    所以由调用方**当场说清楚**是哪一种，不靠事后推断。
   */
  markSessionTerminal(sessionId, { outcome = "failed", error = null } = {}) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s) return;
      this.rpcDrainSession(sessionId, error || outcome);
      const { attempt: amb } = this.#ledger.claimableAmbiguous(sessionId);
      if (amb) this.dispatch(amb.id, { boundary: "terminal_adopted" });
      for (const a of s.turns) {
        if (a.state === "dispatched") this.settleOnce(a.id, { outcome, error, body: null, bodyKind: "none" });
      }
    });
  }

  bindBackendTurnId(attemptId, backendTurnId, backendTurnCount = null) {
    return this.#safe(() => {
      const a = this.#ledger.attempts.get(attemptId);
      if (!a || !backendTurnId) return;
      a.backendTurnId = String(backendTurnId);
      if (backendTurnCount !== null) a.backendTurnCount = safeCount(backendTurnCount);
      this.#ledger.byBackendTurnId.set(a.backendTurnId, a.id);
    });
  }

  /** 诊断字段：区分「已派发但完全沉默」与「已开始输出」。**绝不作轮次出现的门槛。** */
  firstBackendEvent(attemptId) {
    return this.#safe(() => {
      const a = this.#ledger.attempts.get(attemptId);
      if (!a) return;
      if (a.state === "attempted" || a.state === "ambiguous") {
        // ACK 还没到。暂存,等 dispatch 时归并——允许它早于 dispatchedAt。
        a.buffered = a.buffered || {};
        a.buffered.firstBackendEventAt = a.buffered.firstBackendEventAt || this.#now();
        return;
      }
      if (!a.firstBackendEventAt) a.firstBackendEventAt = this.#now();
    });
  }

  progress(attemptId, { charCount, tail, generationCount } = {}) {
    return this.#safe(() => {
      const a = this.#ledger.attempts.get(attemptId);
      if (!a || a.state !== "dispatched" || !a.vizTurnId) return;
      if (generationCount !== undefined) a.generationCount = safeCount(generationCount) ?? a.generationCount;
      // sidecar **覆盖写、不用 rename**;结算后删除。**不进全量快照**——
      // 否则一个会话的进度更新会重写其余会话和全部历史。
      const body = JSON.stringify({
        vizTurnId: a.vizTurnId,
        generationCount: a.generationCount,
        updatedAt: this.#now(),
        charCount: safeCount(charCount) ?? 0,
        tail: tailOf(String(tail ?? "")),
      });
      // ⚠️ **走合并槽，不进有界队列**。进度回调是每 token 级频率，正文队列只有 64 条——
      //    塞进去几百毫秒就能打满，于是 `queue_full` → `run.degraded` → 页面对着一个
      //    **完全健康**的会话挂出「本次记录不完整」。观测把被观测者报成了病人。
      this.#writer.markCoalesced(
        this.#progressPath(a), this.#turnDir(a), Buffer.from(body, "utf8"), PROGRESS_MIN_MS);
    });
  }

  #turnDir(a) { return path.join(this.#dir, "turns", a.sessionId); }
  #progressPath(a) { return path.join(this.#turnDir(a), `t${a.turnNo}.progress.json`); }
  #refOf(a, suffix) { return `turns/${a.sessionId}/t${a.turnNo}.${suffix}`; }

  #writeInput(a, text) {
    const buf = Buffer.from(String(text ?? ""), "utf8");
    const r = this.#writer.enqueue({
      path: path.join(this.#turnDir(a), `t${a.turnNo}.in.md`), dir: this.#turnDir(a), data: buf,
      onDone: (err) => {
        if (err) {
          a.input.state = "missing"; a.input.ref = null; a.input.sha256 = null; a.input.error = "write_failed";
          this.#noteRecordingError("write_failed");
        } else {
          // **写成功之后才公布 ref**——任何情况下都不出现悬空引用。
          a.input.state = "ready";
          a.input.ref = this.#refOf(a, "in.md");
          a.input.sha256 = sha256Hex(buf);
          a.input.error = null;
        }
        this.#markDirty();
      },
    });
    if (!r.ok) {
      a.input.state = "missing"; a.input.ref = null; a.input.sha256 = null; a.input.error = r.code;
      this.#noteRecordingError(r.code);
    } else {
      a.input.chars = safeCount(String(text ?? "").length);
      a.input.bytes = safeCount(buf.length);
    }
  }

  /**
   * 结算。**同步转移 `dispatched → settling`，然后返回同一个 Promise。**
   *
   * ⚠️ 「同步」是硬要求：OMP 那几处 hook 不幂等（idle 时 abort、重复/迟到 `agent_end`
   *    都会再触发一次）。只要转移里插了一个 await，两次调用就都能看到 `dispatched`，
   *    于是同一轮被结算两次。**这是这套东西唯一的护栏。**
   */
  settleOnce(attemptId, result = {}) {
    const a = this.#ledger.attempts.get(attemptId);
    if (!a) return Promise.resolve();
    if (a.state === "attempted" || a.state === "ambiguous") {
      // 终结先于 ACK 到达：暂存，等 dispatch 归并。**不能在这里 settle**——
      // 那会造出一个没有 turnNo 的幽灵轮次。
      a.buffered = a.buffered || {};
      a.buffered.terminal = result;
      return Promise.resolve();
    }
    if (a.state !== "dispatched") return a.settlePromise || Promise.resolve();
    a.state = "settling";                                    // ← 同步，且在任何 await 之前
    a.settlePromise = this.#doSettle(a, result);
    return a.settlePromise;
  }

  /**
   * 正文可以是一个**函数**（可返回 Promise）。
   *
   * ⚠️ 这不违反「settleOnce 必须同步转移」——**同步的是状态转移，不是正文**。
   *    `dispatched → settling` 已经在 `settleOnce()` 里同步完成了，护栏没松；
   *    这里只是允许调用方晚一点交出正文。
   *    OMP 需要它：`agent_end` 可能先于最后一条 `message_update` 到达，
   *    要宽限一小会儿才能救回尾部。硬顶 2 秒——**再等下去就是让观测拖住桥**。
   */
  async #resolveBody(result) {
    if (typeof result.body !== "function") return result;
    let body = null;
    try {
      body = await Promise.race([
        Promise.resolve().then(() => result.body()),
        new Promise(r => setTimeout(() => r(undefined), BODY_PROVIDER_MAX_MS)),
      ]);
    } catch (err) { this.#diag("body_provider_error", err); }
    // 供体超时或抛错 ⇒ 当作"没有正文"，**绝不因此改动 outcome**：
    // 后端确实完成了，只是我们没记下来（STATE.md §4.9 的 completed + none）。
    if (body === undefined || body === null) {
      return { ...result, body: null, bodyKind: "none", output: { error: "write_failed" } };
    }
    return { ...result, body };
  }

  async #doSettle(a, rawResult) {
    const result = await this.#resolveBody(rawResult);
    return new Promise((resolve) => {
      try {
        const at = this.#now();
        a.settledAt = at;
        a.outcome = result.outcome ?? "failed";
        a.error = boundError(result.error ?? null);
        if (result.backendTurnCount !== undefined) a.backendTurnCount = safeCount(result.backendTurnCount);

        const started = Date.parse(a.dispatchedAt || a.attemptedAt);
        const ended = Date.parse(at);
        a.durationMs = Number.isFinite(started) && Number.isFinite(ended) ? safeCount(Math.max(0, ended - started)) : null;

        // 结算了就不再有 sidecar。**先删,再谈正文**——留着它会让 viewer 一直轮询一个死文件。
        // ⚠️ 顺序要紧:**先把合并槽里那一版丢掉,再删文件**。反过来的话,
        //    槽里压着的那一版会在删除之后把文件重新造出来,于是一个已结算的轮次
        //    又长出一个 sidecar——viewer 会一直轮询它,而它永远不会再更新。
        this.#writer.dropCoalesced(this.#progressPath(a));
        this.#io.unlink(this.#progressPath(a)).catch(() => {});

        let body = result.body;
        const kind = result.bodyKind ?? (body ? "final" : "none");
        if (body == null || kind === "none") {
          a.bodyKind = "none";
          a.output.state = "missing"; a.output.ref = null; a.output.sha256 = null;
          a.output.chars = null; a.output.bytes = null;
          // ⚠️ `completed + none` **只在 `output.error` 非空时合法**（STATE.md §4.9）——
          //    「后端正常完成，但观测侧没记下来」。所以这一格必须带上原因码，
          //    否则 writer 会自己造出一个连独立校验器都判非法的快照。
          //    而它确实**就是**一次观测失败：后端完成了，我们手上没有正文。
          const code = result.output?.error ?? (a.outcome === "completed" ? "write_failed" : null);
          a.output.error = code;
          if (code) this.#noteRecordingError(code);
          a.state = "settled";
          this.#markDirty();
          resolve(); return;
        }

        const buf = Buffer.from(String(body), "utf8");
        const chars = String(body).length;
        const r = this.#writer.enqueue({
          path: path.join(this.#turnDir(a), `t${a.turnNo}.out.md`), dir: this.#turnDir(a), data: buf,
          onDone: (err) => {
            if (err) {
              a.bodyKind = "none";
              a.output.state = "missing"; a.output.ref = null; a.output.sha256 = null;
              a.output.chars = null; a.output.bytes = null; a.output.error = "write_failed";
              this.#noteRecordingError("write_failed");
            } else {
              a.bodyKind = kind;
              a.output.state = "ready";
              a.output.ref = this.#refOf(a, "out.md");
              a.output.sha256 = sha256Hex(buf);
              a.output.chars = safeCount(chars);
              a.output.bytes = safeCount(buf.length);
              a.output.error = null;
            }
            a.state = "settled";
            this.#markDirty();
            resolve();
          },
        });

        if (!r.ok) {
          // ⚠️ 队列拒绝时**同步**完成 settling → settled 并降级。
          //    不这么做就会出现「ledger 永久停在 settling」——而 `settleOnce()` 的共享
          //    Promise 也就永远 pending，调用方跟着挂住。
          a.bodyKind = "none";
          a.output.state = "missing"; a.output.ref = null; a.output.sha256 = null;
          a.output.chars = null; a.output.bytes = null; a.output.error = r.code;
          this.#noteRecordingError(r.code);
          a.state = "settled";
          body = null;                                       // **立即释放正文**,不再占字节预算
          this.#markDirty();
          resolve(); return;
        }
        body = null;
      } catch (err) {
        this.#diag("settle_error", err);
        a.state = "settled";
        this.#markDirty();
        resolve();
      }
    });
  }

  /** 收口。**同一轮重复 result/wait 只记第一次。** */
  collected(backendTurnId, { via, returnedChars = null, truncated = false } = {}) {
    return this.#safe(() => {
      const attemptId = this.#ledger.byBackendTurnId.get(String(backendTurnId));
      if (!attemptId) return;
      const a = this.#ledger.attempts.get(attemptId);
      if (!a || a.state !== "settled") return;               // collected ⟹ settled
      if (a.collected) return;                               // 只记第一次
      a.collected = {
        at: this.#now(), via,
        returnedChars: safeCount(returnedChars),
        truncated: !!truncated,
      };
      this.#markDirty();
    });
  }

  /**
   * 会话关闭时的收口。**三种内部态各有确定结果**，不许有第四种走法。
   */
  finalizeSession(sessionId) {
    return this.#safe(() => {
      const s = this.#ledger.session(sessionId);
      if (!s) return;
      // 单个可认领的 ambiguous：先 adopt 再收成 abandoned。
      const { attempt: amb, tooMany } = this.#ledger.claimableAmbiguous(sessionId);
      if (amb) this.dispatch(amb.id, { boundary: "terminal_adopted" });
      if (tooMany) {
        for (const a of s.attempts) if (a.state === "ambiguous") a.state = "unresolved";
        s.attempts = s.attempts.filter(a => a.state !== "unresolved");
        this.#noteRecordingError("write_failed");
      }
      for (const a of s.turns) {
        // `settling` 的复用原 settlement Promise，不重复收口。
        if (a.state === "dispatched") this.settleOnce(a.id, { outcome: "abandoned", body: null, bodyKind: "none" });
      }
    });
  }

  /**
   * run 退出。**只做 O(1) 的封账 + 停止接收新任务，不写快照、不做任何 IO。**
   *
   * ⚠️ 「同步封账」不等于「同步落盘」：同步 OS 操作放进异步路径照样冻事件循环，
   *    而同步文件写**没有可执行的超时**——Defender 一卡就把退出本身拖死。
   *    何况正常退出马上删除整个目录，写完即删的最终快照**没有可靠消费者**。
   *    run gone 是最终裁决，viewer 靠 owner 探测把 dispatched 合成 abandoned。
   */
  sealAndStop() {
    return this.#safe(() => { this.#sealed = true; this.#writer.stop(); });
  }

  cleanup() {
    return this.#safe(() => {
      this.#sealed = true;
      this.#writer.stop();
      try { this.#io.rmSync(this.#dir); } catch {}
    });
  }

  // ── 快照 ──────────────────────────────────────────────────────────────

  /** 给测试与 `/events` 用：不落盘，直接拿当前态。 */
  snapshot() { return this.#buildSnapshot(this.#generation + 1); }

  #buildSnapshot(generation) {
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: this.#runId,
      generation,
      updatedAt: this.#now(),
      run: {
        pid: process.pid,
        bridgeVersion: this.#bridgeVersion,
        startedAt: this.#startedAt,
        // **只有 running 一档。** 终态是传输层的一帧,不是快照里的字段(STATE.md §4)。
        status: "running",
        degraded: this.#degraded,
        recordingErrors: this.#recordingErrors.slice(),
      },
      sessions: [...this.#ledger.sessions.values()].map(s => this.#mapSession(s)),
    };
  }

  #mapSession(s) {
    return {
      sessionId: s.sessionId, name: s.name, agent: s.agent, model: s.model,
      effort: s.effort, access: s.access, cwd: s.cwd, returnMode: s.returnMode,
      logFile: s.logFile, appendSystemPrompt: s.appendSystemPrompt,
      backendPid: s.backendPid, status: s.status, health: s.health,
      isStreaming: s.isStreaming, contextUsage: s.contextUsage,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
      openFailed: s.openFailed, closed: s.closed,
      // **公开只暴露 dispatched 与 settled**;attempted/rejected/ambiguous/settling/unresolved
      // 留在 ledger 内部,避免 UI 渲染半提交状态。
      turns: s.turns
        .filter(a => a.state === "dispatched" || a.state === "settled")
        .sort((x, y) => x.turnNo - y.turnNo)
        .map(a => this.#mapTurn(a)),
    };
  }

  #mapTurn(a) {
    const settled = a.state === "settled";
    return {
      turnNo: a.turnNo, vizTurnId: a.vizTurnId,
      backendTurnId: a.backendTurnId, backendTurnCount: a.backendTurnCount,
      state: a.state, boundary: a.boundary,
      attemptedAt: a.attemptedAt, dispatchedAt: a.dispatchedAt,
      settledAt: settled ? a.settledAt : null,
      firstBackendEventAt: a.firstBackendEventAt,
      source: a.source, blocking: a.blocking, hasSchema: a.hasSchema,
      input: { ...a.input },
      // ⚠️ `output` 的计数在 dispatched 阶段**恒 null**——那时候还没有正文可数。
      output: settled ? { ...a.output } : {
        state: "pending", ref: null, sha256: null, chars: null, bytes: null,
        previewBytes: null, previewSha256: null, error: null,
      },
      outcome: settled ? a.outcome : null,
      bodyKind: settled ? a.bodyKind : null,
      generationCount: a.generationCount,
      collected: a.collected,
      error: a.error,
      durationMs: settled ? a.durationMs : null,
    };
  }
}

// ── 孤儿回收（供 `cleanup` CLI 用） ─────────────────────────────────────────

/**
 * 扫 tmpdir 下的 `agent-bridge-viz-*`，把 owner 已经不在的目录删掉。
 *
 * ⚠️ **判据只有一条：owner 里的 pid 还活着吗。** 别把注释写成"pid + 起始时间双重校验"——
 *    代码没做那件事，而**注释撒谎比没有注释更危险**。
 *
 * 之所以单条判据也够安全，在于**判错的方向**：pid 被操作系统回收再分给别的进程时，
 * `alive()` 返回 true → 我们**留下**这个目录（漏收一个孤儿），
 * 而不是删掉一个活着的 run。真正危险的方向（活的被判死）需要 `alive()` 对一个活进程返 false，
 * 那不会因为号码回收而发生。
 * 代价如实记：pid 恰好被回收的孤儿目录**收不掉**，会一直躺在 tmpdir 里。
 */
export function vizCleanup({ tmpRoot = os.tmpdir(), isAlive = null } = {}) {
  const alive = isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const removed = [], kept = [];
  let names = [];
  try { names = fs.readdirSync(tmpRoot); } catch { return { removed, kept }; }
  for (const n of names) {
    if (!n.startsWith(VIZ_DIR_PREFIX)) continue;
    const dir = path.join(tmpRoot, n);
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(dir, "owner"), "utf8"));
      if (owner?.pid === process.pid) { kept.push(dir); continue; }
      if (Number.isSafeInteger(owner?.pid) && alive(owner.pid)) { kept.push(dir); continue; }
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // owner 读不出来 = 目录残缺 = 上一个进程死得很难看。删掉。
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir); } catch { kept.push(dir); }
    }
  }
  return { removed, kept };
}
