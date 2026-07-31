/**
 * 事件 writer —— transcript 的唯一出口。
 *
 * 合同是 `docs/EVENTS-graph.md`,这里只做三件事:
 *   ① **有界化**(§6 上限表 + §7 不变式) → ② **分配 seq**(§2 稠密) → ③ **落盘**(§2.1 半行容错)
 * 顺序不能换:seq 在有界化之后分配,被丢弃的 `node:progress` 才不会占号。
 *
 * ⚠️ **这里刻意用声明式 schema 表,不用手写 if。** §7 那条不变式是
 * 「字段级有界化之后,schema 里实际存在的字段一个都不能少」——它的反面是
 * 「每轮重新猜哪些小字段可以牺牲」,而那件事本身就是缺陷源(历轮复审漏过
 * `execution`/`outcome`/`counts`/`inputSha256`/`rejectedReason` 五个)。
 * 表驱动之后,漏字段是**写不出来的**:没在表里的键会被当场判成 schema 不符。
 */

import fs from "node:fs";
import crypto from "node:crypto";

export const SCHEMA_VERSION = 1;

/** §2.1 整行 UTF-8 字节上限(含换行)。顶穿的处置见 §7。 */
export const MAX_LINE_BYTES = 1048576;
/** §6 四个可降级字段的**触发阈值**。⚠️ 不许给其中任何一个定更小的数(§3.3):
 *  比 2 KiB 小的阈值永远触发不了 —— writer 判"该降级",又被 §3.3 第 4 条那道地板原样退回。 */
export const DEGRADE_THRESHOLD = 2048;
/** §3.3 摘要头尾各自的配额。 */
export const HEAD_TAIL_BYTES = 1024;

/* ============================================================
   1. UTF-8 原语
   ============================================================ */

const enc = new TextEncoder();

/** 一个 JS 字符串的 UTF-8 字节数。 */
export function utf8Len(s) {
  return Buffer.byteLength(s, "utf8");
}

/** 取前 n 字节,**绝不切开多字节序列**(§3.3 第 3 条)。
 *  允许因此比配额少留几个字节,不允许多留。 */
function headBytes(s, n) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  let end = n;
  // 续接字节是 10xxxxxx;落在续接字节上说明切进了一个字符中间,往回退。
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** 取后 n 字节,同样不切开多字节序列。 */
function tailBytes(s, n) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= n) return s;
  let start = buf.length - n;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

function sha256Text(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * §3.3 唯一的降级形状。**五个字段全部恒在。**
 *
 * ⚠️ **必须同时留头和尾。** 只截头是这类实现最常见的错 —— 报错的根因往往在最后一行
 * (`… caused by: EACCES`),只留开头等于把最有用的那段丢掉。
 */
export function boundedSummary(s) {
  const totalBytes = utf8Len(s);
  const head = headBytes(s, HEAD_TAIL_BYTES);
  const tail = tailBytes(s, HEAD_TAIL_BYTES);
  return {
    totalBytes,
    sha256: sha256Text(s),
    head,
    tail,
    // §3.3 第 5 条恒等式。头尾不重叠 —— 由第 4 条那道地板保证。
    omittedBytes: totalBytes - utf8Len(head) - utf8Len(tail),
  };
}

/** §3.4 那四个字段的降级入口。**地板(§3.3 第 4 条):≤2 KiB 原样留字符串。** */
function degrade(s) {
  return utf8Len(s) <= DEGRADE_THRESHOLD ? s : boundedSummary(s);
}

/* ============================================================
   2. schema 描述子
   ============================================================ */

/** 有界化过程中发现「这条事件写不出合规的形状」时抛它。
 *  ⚠️ 它**不是**业务错误 —— 它只说明 recorder 这一侧出了问题(§7 推论 2、3)。 */
export class RecordingError extends Error {
  constructor(message, { path } = {}) {
    super(path ? `${path}: ${message}` : message);
    this.name = "RecordingError";
    this.path = path || null;
  }
}

/** 结构字符串:超限 → `recording-failed`,**不许悄悄换成 BoundedSummary**(§3.4)。 */
const S = (limit) => ({ k: "str", limit });
/** **必需但可 null** 的结构字符串。
 *  ⚠️ 与"可缺席"是两回事,别混:`model` 是必需键、值可以是 null(=后端用默认模型);
 *  `group` 是可缺席键、不传时**整个键不出现**(**不是** null)。
 *  混了会让页面把"没指定模型"和"这个字段还没实现"看成同一件事。 */
const NS = (limit) => ({ k: "str", limit, nullable: true });
/** 可降级字符串(§3.4 那四个,一个不多)。 */
const DEG = { k: "deg" };
/** 固定长度的 hex。形状不对 → `recording-failed`。 */
const HEX = (n) => ({ k: "hex", n });
/** 数值域(§6.1)。⚠️ NaN / Infinity 一律拦下 —— `JSON.stringify` 会把它们**静默变成 null**,
 *  于是页面上"未知"、"0"、"没测到"三种截然不同的事实长得一模一样。 */
const NUM = (dom) => ({ k: "num", dom });
const BOOL = { k: "bool" };
/** 封闭枚举。 */
const ENUM = (...vals) => ({ k: "enum", vals });
/** 数组。`mode:"fail"` 超条数 → recording-failed;`mode:"trunc"` → 截断 + 同级的 truncFlag 置 true。
 *  `min` 是下界(目前只有 `node:settled.turns` 用,下界 1)。 */
const ARR = (item, max, mode = "fail", truncFlag = null, min = null) =>
  ({ k: "arr", item, max, mode, truncFlag, min });
/** 对象。`f` 是必需字段,`o` 是可缺席字段。⚠️ **表里没有的键一律判 schema 不符** —— 那正是
 *  「漏字段写不出来」的机制所在。 */
const OBJ = (f, o = {}) => ({ k: "obj", f, o });
/** 白名单对象:**只取列出的键,其余丢弃**(§6 对 `node:progress` 的 `contextUsage` / `lastEvent` 的规定)。
 *  ⚠️ 它与 `OBJ` 的差别是**故意的**,别合并:`OBJ` 的"多一个键就判不符"用于我们自己构造的 payload;
 *  这两处的对象**整个来自后端**,键集不受我们约束,判不符会让一次正常运行变成记录损坏。
 *  但**白名单内的字段照样受上限约束**(超限 → recording-failed),不是"来自后端就免检"。 */
const WL = (f) => ({ k: "wl", f });
/** 判别联合:按 `on` 字段的取值选分支。 */
const UNION = (on, branches) => ({ k: "union", on, branches });
/** **恒在、可 null** 的字段。⚠️ 与 `OBJ` 的第二个参数(可缺席)是两回事,别混:
 *  「键不在」与「值是 null」在页面上必须是同一件事(未知),做成可缺席就会有两套分支各写各的。 */
const NULLABLE = (of) => ({ k: "nullable", of });

/* ---- 公共类型(§3) ---- */

/** §3.1 `AssetState` —— 每个可点击资产都是一个判别联合。
 *  ⚠️ `{state:"present"}` 却没有 `ref`,**等于没有**:页面知道"东西在"却点不开。
 *  所以三样在 present 分支里都是**必需**。 */
const ASSET = UNION("state", {
  present: OBJ({ state: ENUM("present"), ref: S(512), sha256: HEX(64), byteCount: NUM("uint") }),
  "not-applicable": OBJ({ state: ENUM("not-applicable") }), // 不许有任何其它键
  unavailable: OBJ({ state: ENUM("unavailable"), code: S(200) }),
});

/** §3.2 `SceneState` —— scene 是**容器**,不是普通资产,而且**挂在轮上**。
 *  容器本身没有 ref/sha,三个子文件各自有。 */
const SCENE = UNION("state", {
  present: OBJ({
    state: ENUM("present"),
    // ⚠️ 键是**逻辑名**,不是文件名(§3.2)。用 `session.log` 这种带点的键读着顺,
    //    但合同全篇的判据表用的都是逻辑名,而且带点的键让所有 `a.b.c` 取值失效。
    files: OBJ({ sessionLog: ASSET, answer: ASSET, status: ASSET }),
  }),
  "not-applicable": OBJ({ state: ENUM("not-applicable") }),
  unavailable: OBJ({ state: ENUM("unavailable"), code: S(200) }),
});

/** §5.6 一次尝试的摘要。`n` 是 **1-based**,`0` 非法。 */
const ATTEMPT_SUMMARY = OBJ(
  {
    n: NUM("uint1"),
    status: ENUM("accepted", "rejected", "no-output", "failed"),
    inputSha256: HEX(64),
    input: ASSET,
    output: ASSET,
  },
  { rejectedReason: DEG },
);

/** §5.8 `TurnSummary`。⚠️ `turnSpecHash` 是 **hex32 不是 hex64**;
 *  `inferredDeps` 上限 **20**(比事件级那份小 —— 它内联在 node:settled 一行里,
 *  20 轮 × 200 项会顶穿 1 MiB 行上限,算术见 §7)。 */
const TURN_SUMMARY = OBJ({
  key: S(200),
  status: ENUM("ok", "contract_error", "backend_failed", "timeout", "unknown"),
  sessionReusable: BOOL,
  output: ASSET,
  turnSpecHash: HEX(32),
  charCount: NUM("uint?"),
  durationMs: NUM("uint"),
  inferredDeps: ARR(S(200), 20, "trunc", "inferredDepsTruncated"),
  inferredDepsTruncated: BOOL,
  attempts: ARR(ATTEMPT_SUMMARY, 2, "fail"),
});

/* ---- §5 逐事件 payload ---- */

export const EVENT_SCHEMAS = {
  "run:started": OBJ({ outDir: S(512), maxConcurrent: NUM("uint1") }),

  "node:observed": OBJ({
    nodeSeq: NUM("uint"),
    id: S(200),
    agent: ENUM("omp", "codex", "claude", "cursor", "kimi"),
    access: ENUM("read", "write"),
    cwd: S(512),
    // 未显式指定 → **null**(后端用默认模型)。必需键、可 null。
    model: NS(200),
    effort: NS(200),
    spec: ASSET,
    prompt: ASSET,
    role: ASSET,
    declaredDeps: ARR(S(200), 200, "fail"),
    inferredDeps: ARR(S(200), 200, "trunc", "inferredDepsTruncated"),
    inferredDepsTruncated: BOOL,
  }, {
    // 使用者自己传的分组标签。不传 → **整个键不出现**(不是 null)。
    group: S(200),
  }),

  // §5.3 六档封闭枚举。⚠️ `turn-validation` 与 `zero-turn` 只可能出现在对话节点上。
  "node:rejected": OBJ({
    nodeSeq: NUM("uint"),
    phase: ENUM("lock", "preflight", "reuse-check", "workspace-setup", "turn-validation", "zero-turn"),
    error: DEG,
  }),

  "node:turn": OBJ({
    nodeSeq: NUM("uint"),
    turnKey: S(200),
    input: ASSET,
    // 这一轮问的正文的指纹。⚠️ 与 `turnSpecHash` 不是一回事:那份覆盖整张任务单。
    inputSha256: HEX(64),
    timeoutMs: NUM("uint1"),
    reask: NUM("bit"),
    inferredDeps: ARR(S(200), 200, "trunc", "inferredDepsTruncated"),
    inferredDepsTruncated: BOOL,
  }),

  "node:started": OBJ({ nodeSeq: NUM("uint"), turnKey: S(200), queuedMs: NUM("uint") }),

  "node:workspace-intent": OBJ({ nodeSeq: NUM("uint"), path: S(512), branch: S(512), baseCommit: S(512) }),
  "node:workspace-created": OBJ({ nodeSeq: NUM("uint"), path: S(512), branch: S(512), baseCommit: S(512) }),

  "node:attempt": OBJ({
    nodeSeq: NUM("uint"), turnKey: S(200), n: NUM("uint1"),
    input: ASSET, inputSha256: HEX(64),
  }),

  // §5.6 ⚠️ **四种 status 都发**,不只"有产出"那种。
  "node:attempt-settled": OBJ({
    nodeSeq: NUM("uint"), turnKey: S(200), n: NUM("uint1"),
    status: ENUM("accepted", "rejected", "no-output", "failed"),
    output: ASSET,
    // 死在 `send_message` 或等待阶段时为 null;`charCount` 拿不到时也为 null。
    durationMs: NUM("uint?"),
    charCount: NUM("uint?"),
  }, { rejectedReason: DEG }),

  // §5.7 唯一可以整条丢的事件。`tail` 天生有界(240 UTF-16 code unit),**不许降级**。
  "node:progress": OBJ({
    nodeSeq: NUM("uint"), turnKey: S(200),
    // 当前在跑**本轮**第几次尝试。没有它,打回重说时页面没法把在途正文贴到对的那一次上。
    n: NUM("uint1"),
    status: S(200),
    // ⚠️ **恒有,非 null**。快照连长度都给不出时,合同的处置是**整条不发**(§5.7) ——
    //    发一条 charCount:null 的进度,等于在时间轴上留一个"它还活着而且什么都没产出"的假证据。
    charCount: NUM("uint"),
    tail: { k: "u16", limit: 240 },
    // ⚠️ **恒在、可 null**,不是"可缺席"。「键不在」与「值是 null」在页面上必须是同一件事(未知),
    //    做成可缺席就会有两套分支各写各的。白名单本身照旧:这两个对象整个来自后端。
    lastEvent: NULLABLE(WL({ at: S(200), type: S(200) })),
    contextUsage: NULLABLE(WL({ tokens: NUM("finite+"), live: BOOL, isCompacting: BOOL, autoCompactionEnabled: BOOL })),
  }),

  // §5.4 ⚠️ 轮级五档 + `not-started`。「没能开始的轮」恒落在 output:unavailable{source-missing}。
  "node:turn-settled": OBJ({
    nodeSeq: NUM("uint"), turnKey: S(200),
    status: ENUM("ok", "contract_error", "backend_failed", "timeout", "unknown", "not-started"),
    sessionReusable: BOOL,
    output: ASSET,
    scene: SCENE,
    charCount: NUM("uint?"),
    durationMs: NUM("uint"),
  }, { errorSummary: DEG }),

  // §5.8 ⚠️ 没有 `scene`、没有节点级 `attempts[]` —— 两样都下沉到轮。
  "node:settled": OBJ({
    nodeSeq: NUM("uint"),
    status: ENUM("ok", "contract_error", "backend_failed", "timeout", "unknown", "callback_error"),
    execution: ENUM("fresh", "reused"),
    durationMs: NUM("uint"),
    receipt: ASSET,
    artifact: ASSET,
    diff: ASSET,
    // ⚠️ 下界是 1 不是 0:一轮都没跑起来的节点根本不会有 node:settled(走 node:rejected)。
    turns: ARR(TURN_SUMMARY, 20, "fail", null, 1),
  }, {
    outcome: ENUM("delivered", "no-changes", "unknown"),
    // ⚠️ **字段封闭而且六个键全必需**(§5.8):这一层是"回执没归档成功时人怎么找到现场"的
    //    唯一线索,少一个键就少一条线索,而 `{}` 照样是合法 JSON —— 做成可缺席等于
    //    兜底没兜住却又不报错。拿不到的用 `null`(**不许用缺席表达未知**,同 §3.1)。
    // ⚠️ 刻意**没有** `filesChanged`(无上限,内联进事件就是把事件流变成第二个真理源)、
    //    也没有 `committed`(交付结论的唯一权威判据是 `outcome`)。
    //    `changesKnown` 不能少 —— 少了它,页面就分不开「**探到了**这棵树的改动状况」与
    //    「探测那一步没跑成、说不清」。
    // ⚠️ **它不是「确知没有改动」** —— 生产者只要 git 探测正常返回就置 true,
    //    改了一万个文件的节点同样是 true。判"净改动为零"要看 diff 自己的字节数。
    //    (本行早先就写成了"确知没有改动",而页面照着这句话把一次正常交付渲染成
    //     "已交付,但这次提交没有净改动" —— 一句凭空捏造、却比真话还确定的结论。)
    // ⚠️ commit 是 `git rev-parse` 给的**完整 40 位 SHA**,不是短 SHA:短 SHA 会随仓库长大而歧义。
    // ⚠️ 四个字符串**都可 null**:兜底这一层的职责是"能给什么给什么",它自己绝不能
    //    因为某一项拿不到就把整条 node:settled 变成 recording-failed。
    //    但 null 是**唯一**的"拿不到"表示 —— 不许省略键、也不许用空串(空串会撞 hex40)。
    workspaceSummary: OBJ({
      path: NS(512), branch: NS(512),
      baseCommit: NULLABLE(HEX(40)), headCommit: NULLABLE(HEX(40)),
      removed: BOOL, changesKnown: BOOL,
    }),
    errorSummary: DEG,
  }),

  // §5.10 `counts` 是**固定键集**,九个键全部恒在。
  "run:final": OBJ({
    result: ENUM("completed", "failed"),
    counts: OBJ({
      observed: NUM("uint"), rejected: NUM("uint"), ok: NUM("uint"),
      contract_error: NUM("uint"), backend_failed: NUM("uint"), timeout: NUM("uint"),
      unknown: NUM("uint"), callback_error: NUM("uint"), reused: NUM("uint"),
    }),
    durationMs: NUM("uint"),
  }),
};

/* ============================================================
   3. 有界化
   ============================================================ */

const isUint = (v) => Number.isSafeInteger(v) && v >= 0;

function checkNum(v, dom, path) {
  // ⚠️ 这一关必须在 JSON.stringify 之前:它会把 NaN/Infinity 静默变成 null。
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new RecordingError(`数值非法(NaN/Infinity/非数):${String(v)}`, { path });
  }
  switch (dom) {
    case "uint": if (!isUint(v)) throw new RecordingError(`要非负安全整数,拿到 ${v}`, { path }); break;
    case "uint1": if (!isUint(v) || v < 1) throw new RecordingError(`要 ≥1 的安全整数,拿到 ${v}`, { path }); break;
    case "bit": if (v !== 0 && v !== 1) throw new RecordingError(`只能是 0 或 1,拿到 ${v}`, { path }); break;
    case "finite+": if (v < 0) throw new RecordingError(`要非负,拿到 ${v}`, { path }); break;
    default: throw new RecordingError(`未知数值域 ${dom}`, { path });
  }
  return v;
}

/**
 * 按 schema 有界化一个值。**返回新值**(不原地改调用方的对象)。
 *
 * 三条处置(§7):可降级字段超限 → 摘要;数组超条数 → 按 mode 截断或失败;
 * **其余任何超限、类型不符、schema 里没有的键 → 抛 `RecordingError`**。
 */
function boundValue(v, d, path) {
  switch (d.k) {
    case "str": {
      if (d.nullable && v === null) return null;
      if (typeof v !== "string") throw new RecordingError(`要字符串,拿到 ${typeof v}`, { path });
      const n = utf8Len(v);
      // ⚠️ 结构字段永远保持原类型。超限说明上游给了一个不合合同的值(比如 600 字节的分支名),
      //    那属于 recorder 层的失败,**不许悄悄换成 BoundedSummary**(§3.4)。
      if (n > d.limit) throw new RecordingError(`结构字符串超限(${n} > ${d.limit} 字节)`, { path });
      return v;
    }
    case "u16": {
      if (typeof v !== "string") throw new RecordingError(`要字符串,拿到 ${typeof v}`, { path });
      // 天生有界:按 UTF-16 code unit 计,不许降级(§3.4)。
      if (v.length > d.limit) throw new RecordingError(`超 ${d.limit} 个 UTF-16 code unit`, { path });
      return v;
    }
    case "deg": {
      if (typeof v !== "string") throw new RecordingError(`要字符串,拿到 ${typeof v}`, { path });
      return degrade(v);
    }
    case "hex": {
      if (typeof v !== "string" || v.length !== d.n || !/^[0-9a-f]*$/.test(v)) {
        throw new RecordingError(`要 hex${d.n},拿到 ${JSON.stringify(v)?.slice(0, 80)}`, { path });
      }
      return v;
    }
    case "num": {
      // `uint?` = 可空的非负安全整数(目前只有 `charCount`:后端没吐用量时就是 null)。
      // ⚠️ null 与 0 必须分得开 —— 「没测到」和「零个字」是两件事(§6.1 那条 NaN 注记的同源问题)。
      if (d.dom === "uint?") {
        if (v === null) return null;
        return checkNum(v, "uint", path);
      }
      return checkNum(v, d.dom, path);
    }
    case "nullable":
      // null **原样留着** —— 它是一个有意义的取值(未知),不是缺席。
      return v === null ? null : boundValue(v, d.of, path);
    case "bool":
      if (typeof v !== "boolean") throw new RecordingError(`要布尔,拿到 ${typeof v}`, { path });
      return v;
    case "enum":
      if (!d.vals.includes(v)) throw new RecordingError(`不在封闭枚举里:${JSON.stringify(v)}`, { path });
      return v;
    case "arr": {
      if (!Array.isArray(v)) throw new RecordingError(`要数组,拿到 ${typeof v}`, { path });
      if (d.min != null && v.length < d.min) {
        throw new RecordingError(`条数不足(${v.length} < ${d.min})`, { path });
      }
      let items = v;
      if (v.length > d.max) {
        // ⚠️ **绝不静默截断**:截断的那一项必须同时把同级的 truncFlag 置 true,
        //    否则页面会把"截了 180 项"显示成"本来就只有 20 项"。
        if (d.mode !== "trunc") throw new RecordingError(`条数超限(${v.length} > ${d.max})`, { path });
        items = v.slice(0, d.max);
      }
      return items.map((x, i) => boundValue(x, d.item, `${path}[${i}]`));
    }
    case "union": {
      if (v === null || typeof v !== "object") throw new RecordingError(`要对象,拿到 ${typeof v}`, { path });
      const tag = v[d.on];
      const branch = d.branches[tag];
      if (!branch) throw new RecordingError(`判别标签 ${d.on}=${JSON.stringify(tag)} 不认识`, { path });
      return boundValue(v, branch, path);
    }
    case "obj": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        throw new RecordingError(`要对象,拿到 ${Array.isArray(v) ? "数组" : typeof v}`, { path });
      }
      const out = {};
      const truncFlags = new Map();
      for (const [key, sub] of Object.entries(d.f)) {
        if (!(key in v)) throw new RecordingError(`必需字段缺席:${key}`, { path });
        out[key] = boundValue(v[key], sub, path ? `${path}.${key}` : key);
        if (sub.k === "arr" && sub.truncFlag && Array.isArray(v[key]) && v[key].length > sub.max) {
          truncFlags.set(sub.truncFlag, true);
        }
      }
      for (const [key, sub] of Object.entries(d.o)) {
        if (!(key in v) || v[key] === undefined) continue;
        out[key] = boundValue(v[key], sub, path ? `${path}.${key}` : key);
      }
      // 截断标志由**截断这件事本身**置位,盖掉调用方给的值 —— 调用方没有资格说"我没截断"。
      for (const [flag, val] of truncFlags) out[flag] = val;
      // ⚠️ schema 里没有的键 = schema 不符。这条是「漏字段写不出来」的另一半:
      //    多字段同样写不出来,于是两边都不会悄悄漂。
      for (const key of Object.keys(v)) {
        if (!(key in d.f) && !(key in d.o) && v[key] !== undefined) {
          throw new RecordingError(`schema 里没有这个键:${key}`, { path });
        }
      }
      return out;
    }
    case "wl": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        throw new RecordingError(`要对象,拿到 ${Array.isArray(v) ? "数组" : typeof v}`, { path });
      }
      const out = {};
      for (const [key, sub] of Object.entries(d.f)) {
        if (!(key in v) || v[key] === undefined || v[key] === null) continue;
        // 白名单**内**的字段照样受上限约束 —— "来自后端"不是免检理由。
        out[key] = boundValue(v[key], sub, path ? `${path}.${key}` : key);
      }
      return out; // 白名单外的键:**丢弃**,不报错(§6)
    }
    default: throw new RecordingError(`未知描述子 ${d.k}`, { path });
  }
}

/** 有界化一条事件的 payload。 */
export function boundPayload(event, payload) {
  const d = EVENT_SCHEMAS[event];
  if (!d) throw new RecordingError(`未知事件类型:${event}`);
  return boundValue(payload, d, "");
}

/* ============================================================
   4. writer
   ============================================================ */

/**
 * transcript 的顺序 writer。
 *
 * - **单 fd + `writeSync` 串行**:并发 append 不会交错半行。
 * - **seq 在有界化之后分配**(§2):被丢弃的 `node:progress` 不占号,
 *   转 `recording-failed` 的那一条**占号**(它就是 `atSeq`)。
 * - **短写 = recorder 损坏**:见 `#writeLine` 里那段。
 *
 * `onRecordingFailed({atSeq, error})` 在**第一次**损坏时**恰好**调一次。
 */
export function createEventWriter({ file, graphId, onRecordingFailed = null }) {
  // `wx` —— 同 outDir 两个 graph 并发时,谁也别想覆盖谁的 transcript。
  const fd = fs.openSync(file, "wx");

  let seq = 0;
  let failed = null;        // { atSeq, lastGoodOffset, error }
  let closed = false;
  let chain = Promise.resolve(); // append 的串行链
  /** transcript 里「最后一个完整换行之后」的排他字节偏移 ——
   *  即 `[0, lastGoodOffset)` 这段字节**全部是完整的行**。
   *
   *  ⚠️ **只在一整行(含 `\n`)的全部字节都写完时一次性推进**,靠**累加已写字节**维护。
   *  ⚠️ **短写之后物理 EOF 会比它大,但绝不许推进它;失败时更不许拿 `stat().size` 去重算** ——
   *  那正好会把半行算进"可信边界",而所有关于"末尾半行"的处理都建立在
   *  "可信边界只到完整行"之上。 */
  let lastGoodOffset = 0;

  function fail(atSeq, error) {
    if (failed) return failed;
    failed = { atSeq, lastGoodOffset, error };
    // 一旦损坏就**永不再写**:半行留在 EOF,读侧按 §2.1 跳过它;
    // 再写下去那半行就变成**非末尾**的坏行 —— 那是历史损坏,性质更坏。
    if (onRecordingFailed) {
      try { onRecordingFailed({ atSeq, error }); } catch { /* 通知失败不改这里的结局 */ }
    }
    return failed;
  }

  function writeLine(line) {
    const buf = Buffer.from(line, "utf8");
    const n = fs.writeSync(fd, buf, 0, buf.length);
    // ⚠️ **短写不重试。** 常规文件的 `writeSync` 是要么全写要么抛;真短写基本只发生在
    // 盘写满那一刻,而那时重试只是往一条**已经截断的行**后面再糊几个字节。
    // 正确处置是:让那半行留在 EOF(读侧容错),然后**再也不写**。
    if (n !== buf.length) {
      // ⚠️ 这里**不推进** `lastGoodOffset` —— 盘上多出来的那半行永远不属于可信边界。
      throw new RecordingError(`短写:只落了 ${n} / ${buf.length} 字节,transcript 尾部已截断`);
    }
    lastGoodOffset += buf.length; // 整行落定,一次性推进
  }

  /**
   * 追加一条事件。
   *
   * @returns Promise —— **第一次损坏时 reject**(调用方据此知道"这条没记下")。
   *   之后的 append 一律静默 no-op:recorder 坏了**不改业务结局**,不该让每个插桩点都炸。
   */
  function append(event, payload) {
    const p = chain.then(() => {
      if (closed) throw new RecordingError("writer 已关闭");
      if (failed) return; // 已经损坏 —— 静默 no-op,业务照跑
      let bounded;
      try {
        bounded = boundPayload(event, payload);
      } catch (e) {
        // 有界化失败:这一条占号,它就是 atSeq(§2 —— 消费方需要一个具体的锚点)。
        const atSeq = seq++;
        throw fail(atSeq, e).error;
      }
      const at = seq;
      const line = JSON.stringify({ v: SCHEMA_VERSION, seq: at, ts: Date.now(), graphId, event, payload: bounded }) + "\n";
      if (utf8Len(line) > MAX_LINE_BYTES) {
        // §7 推论 1:**只有 `node:progress` 可以整条丢**(丢一条无所谓,下一条 5 秒后就来),
        // 而且它在分配 seq **之前**就被丢了 —— 所以不占号。
        if (event === "node:progress") return;
        // 其余一律 `recording-failed`,**绝不静默丢行**:静默丢会伪装成"本来就没有"。
        const atSeq = seq++;
        throw fail(atSeq, new RecordingError(`有界化之后仍超行上限(${utf8Len(line)} > ${MAX_LINE_BYTES})`, { path: event })).error;
      }
      seq++;
      try {
        writeLine(line);
      } catch (e) {
        throw fail(at, e instanceof RecordingError ? e : new RecordingError(String(e?.message || e))).error;
      }
    });
    // 链本身不许因为一次失败就断掉 —— 后面的 append 还要能进来(然后 no-op)。
    chain = p.catch(() => {});
    return p;
  }

  return {
    append,
    get seq() { return seq; },
    get failed() { return failed; },
    get lastGoodOffset() { return lastGoodOffset; },
    /** ⚠️ `close()` 抛错**不等于**写失败:`run:final` 已确认落盘时,页面就该显示"已结束"。
     *  所以这里的异常**不**转 `recording-failed`,原样抛给调用方由它决定怎么记。 */
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}
