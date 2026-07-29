/**
 * 这是 wire 合同的第二实现：它只把 STATE.md 的散文约束重新表达为可执行检查，
 * 不读取生产者源码、不复用生产侧常量，也不在模块加载时触碰文件系统。
 * 这种刻意的独立性用于暴露生产者与合同之间的漂移，而不是证明一套代码与自己一致。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);
const RECORDING_ERROR_CODES = new Set([
  'queue_full',
  'queue_item_too_large',
  'write_failed',
  'snapshot_write_failed',
]);
const AGENTS = new Set(['omp', 'codex', 'claude', 'cursor', 'kimi']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const ACCESS_MODES = new Set(['read', 'write']);
const RETURN_MODES = new Set(['full', 'ref']);
const SESSION_STATUSES = new Set(['starting', 'running', 'idle', 'failed', 'closed']);
const SESSION_HEALTH = new Set(['healthy', 'degraded', 'dead']);
const INJECTION_MODES = new Set(['system', 'developer', 'first-turn-user-prefix']);
const OPEN_FAILURE_PHASES = new Set(['start', 'initialTurn']);
const TURN_STATES = new Set(['dispatched', 'settled']);
const TURN_BOUNDARIES = new Set([
  'rpc_ack',
  'turn_start_ack',
  'turn_started_notification',
  'pipe_enqueued',
  'os_spawned',
  'terminal_adopted',
]);
const TURN_SOURCES = new Set(['initial_prompt', 'send_message']);
const TURN_OUTCOMES = new Set(['completed', 'failed', 'aborted', 'abandoned']);
const BODY_KINDS = new Set(['final', 'partial', 'none']);
const FILE_STATES = new Set(['pending', 'ready', 'missing']);
const INPUT_ERROR_CODES = new Set(['queue_full', 'write_failed']);
const OUTPUT_ERROR_CODES = new Set(['queue_full', 'queue_item_too_large', 'write_failed']);
const COLLECTION_VIA = new Set(['open_session', 'send_message', 'result', 'wait']);

const SNAPSHOT_KEYS = ['schemaVersion', 'runId', 'generation', 'updatedAt', 'run', 'sessions'];
const RUN_KEYS = ['pid', 'bridgeVersion', 'startedAt', 'status', 'degraded', 'recordingErrors'];
const SESSION_KEYS = [
  'sessionId', 'name', 'agent', 'model', 'effort', 'access', 'cwd', 'returnMode',
  'logFile', 'appendSystemPrompt', 'backendPid', 'status', 'health', 'isStreaming',
  'contextUsage', 'createdAt', 'updatedAt', 'openFailed', 'closed', 'turns',
];
const APPEND_PROMPT_KEYS = ['file', 'bytes', 'injectionMode'];
const CONTEXT_USAGE_KEYS = ['tokens', 'live', 'isCompacting', 'autoCompactionEnabled'];
const OPEN_FAILED_KEYS = ['phase', 'error'];
const CLOSED_KEYS = ['reason', 'forced', 'at'];
const TURN_KEYS = [
  'turnNo', 'vizTurnId', 'backendTurnId', 'backendTurnCount', 'state', 'boundary',
  'attemptedAt', 'dispatchedAt', 'settledAt', 'firstBackendEventAt', 'source',
  'blocking', 'hasSchema', 'input', 'output', 'outcome', 'bodyKind',
  'generationCount', 'collected', 'error', 'durationMs',
];
const INPUT_KEYS = [
  'state', 'ref', 'sha256', 'chars', 'bytes', 'truncated', 'originalBytes', 'error',
];
const OUTPUT_KEYS = [
  'state', 'ref', 'sha256', 'chars', 'bytes', 'previewBytes', 'previewSha256', 'error',
];
const COLLECTED_KEYS = ['at', 'via', 'returnedChars', 'truncated'];
const META_KEYS = ['runId', 'pid', 'processStartedAt', 'bridgeVersion', 'createdAt'];

const SHA256_RE = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 缺字段会让半写入对象伪装成完整快照，所以结构检查必须区分“没有”与值为 null。
function requireRecord(value, label, requiredKeys, violations) {
  if (!isRecord(value)) {
    violations.push(label + ' 必须是对象');
    return null;
  }
  for (const key of requiredKeys) {
    if (!hasOwn(value, key)) {
      violations.push(label + ' 缺少必填字段 ' + key);
    }
  }
  return value;
}

// 类型错误若被留到语义阶段，坏槽可能先被当成可选择槽，因此先做独立的线形状检查。
function checkShapeField(object, key, predicate, expected, label, violations) {
  if (hasOwn(object, key) && !predicate(object[key])) {
    violations.push(label + '.' + key + ' 必须是' + expected);
  }
}

// 未知键会让生产对象未来新增的属性静默穿透 wire，所以每层都按自己的封闭白名单拒绝。
function rejectUnknownKeys(object, allowedKeys, label, violations) {
  if (!isRecord(object)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      violations.push(label + ' 含未知字段 ' + key);
    }
  }
}

// NaN 和 Infinity 序列化后会变成 null，单看 typeof 会把计算错误掩成“无数据”。
function checkSafeCount(value, label, violations, { nullable = false, minimum = 0 } = {}) {
  if (value === undefined) return false;
  if (value === null) {
    if (nullable) return true;
    violations.push(label + ' 不能是 null');
    return false;
  }
  if (typeof value !== 'number') {
    violations.push(label + ' 必须是数字');
    return false;
  }
  if (!Number.isFinite(value)) {
    violations.push(label + ' 必须是有限数字，不能是 NaN 或 Infinity');
    return false;
  }
  if (!Number.isSafeInteger(value) || value < minimum) {
    violations.push(label + ' 必须是大于等于 ' + minimum + ' 的安全整数');
    return false;
  }
  return true;
}

// 封闭枚举防止拼写错误被页面当作将来版本的新状态继续渲染。
function checkEnum(value, allowed, label, violations, { nullable = false } = {}) {
  if (value === undefined) return false;
  if (value === null && nullable) return true;
  if (!allowed.has(value)) {
    violations.push(label + ' 取值不在合同枚举内');
    return false;
  }
  return true;
}

// §3：时间戳一律是 `new Date().toISOString()` 的输出 —— UTC、带毫秒、Z 结尾。
//
// 只判“能不能 Date.parse”远远不够：`"2026-07-29 10:00:00"` 照样解析得动，
// 但它按**本地时区**解释，同一份快照在两台机器上读出来就是两个时刻，
// 而这份记录存在的全部意义就是事后对时间线。正则先卡住形状，
// 再用 toISOString() 往回比一次 —— 那一步顺带排掉 13 月、32 日这类正则拦不住的值。
const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function checkIsoTimestamp(value, label, violations, { nullable = false } = {}) {
  if (value === undefined) return false;
  if (value === null) {
    if (nullable) return true;
    violations.push(label + ' 不能是 null');
    return false;
  }
  if (typeof value !== 'string'
      || !ISO_MS_UTC.test(value)
      || new Date(value).toISOString() !== value) {
    violations.push(label + ' 必须是 toISOString() 形式的 UTC 毫秒时间戳');
    return false;
  }
  return true;
}

// 错误文本的上限避免异常对象把快照体积无限放大。
function checkBoundedText(value, label, violations) {
  if (value !== null && typeof value === 'string' && value.length > 300) {
    violations.push(label + ' 超过 300 个 JS code unit');
  }
}

function nullableString(value) {
  return value === null || typeof value === 'string';
}

function nullableNumber(value) {
  return value === null || typeof value === 'number';
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// §2.1 只能依赖必填结构与基础类型选槽，否则会先读取半写入的深层对象再崩溃。
function collectRequiredStructure(snapshot) {
  const violations = [];
  const root = requireRecord(snapshot, 'snapshot', SNAPSHOT_KEYS, violations);
  if (!root) return violations;

  checkShapeField(root, 'schemaVersion', (v) => typeof v === 'number', '数字', 'snapshot', violations);
  checkShapeField(root, 'runId', (v) => typeof v === 'string', '字符串', 'snapshot', violations);
  checkShapeField(root, 'generation', (v) => typeof v === 'number', '数字', 'snapshot', violations);
  checkShapeField(root, 'updatedAt', (v) => typeof v === 'string', '字符串', 'snapshot', violations);
  checkShapeField(root, 'sessions', Array.isArray, '数组', 'snapshot', violations);

  // run 的固定形状是 viewer 判断快照可消费的最小运行上下文。
  if (hasOwn(root, 'run')) {
    const run = requireRecord(root.run, 'snapshot.run', RUN_KEYS, violations);
    if (run) {
      checkShapeField(run, 'pid', (v) => typeof v === 'number', '数字', 'snapshot.run', violations);
      checkShapeField(run, 'bridgeVersion', (v) => typeof v === 'string', '字符串', 'snapshot.run', violations);
      checkShapeField(run, 'startedAt', (v) => typeof v === 'string', '字符串', 'snapshot.run', violations);
      checkShapeField(run, 'status', (v) => typeof v === 'string', '字符串', 'snapshot.run', violations);
      checkShapeField(run, 'degraded', (v) => typeof v === 'boolean', '布尔值', 'snapshot.run', violations);
      checkShapeField(run, 'recordingErrors', stringArray, '字符串数组', 'snapshot.run', violations);
    }
  }

  if (!Array.isArray(root.sessions)) return violations;
  for (let sessionIndex = 0; sessionIndex < root.sessions.length; sessionIndex += 1) {
    const sessionLabel = 'snapshot.sessions[' + sessionIndex + ']';
    const session = requireRecord(root.sessions[sessionIndex], sessionLabel, SESSION_KEYS, violations);
    if (!session) continue;

    // session 的所有公开属性都必须出现，启动失败的 attempt 也不能退化成另一种短对象。
    checkShapeField(session, 'sessionId', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'name', nullableString, '字符串或 null', sessionLabel, violations);
    checkShapeField(session, 'agent', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'model', nullableString, '字符串或 null', sessionLabel, violations);
    checkShapeField(session, 'effort', nullableString, '字符串或 null', sessionLabel, violations);
    checkShapeField(session, 'access', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'cwd', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'returnMode', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    // logFile 可空（§4.2）：调用方没给时，writer 只剩"编一个路径"或"丢掉整张卡片"
    // 两条路，都比承认没有更坏。页面据此只是不显示逃生门链接。
    checkShapeField(session, 'logFile', nullableString, '字符串或 null', sessionLabel, violations);
    checkShapeField(session, 'appendSystemPrompt', (v) => v === null || isRecord(v), '对象或 null', sessionLabel, violations);
    checkShapeField(session, 'backendPid', nullableNumber, '数字或 null', sessionLabel, violations);
    checkShapeField(session, 'status', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'health', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'isStreaming', (v) => typeof v === 'boolean', '布尔值', sessionLabel, violations);
    checkShapeField(session, 'contextUsage', (v) => v === null || isRecord(v), '对象或 null', sessionLabel, violations);
    checkShapeField(session, 'createdAt', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'updatedAt', (v) => typeof v === 'string', '字符串', sessionLabel, violations);
    checkShapeField(session, 'openFailed', (v) => v === null || isRecord(v), '对象或 null', sessionLabel, violations);
    checkShapeField(session, 'closed', (v) => v === null || isRecord(v), '对象或 null', sessionLabel, violations);
    checkShapeField(session, 'turns', Array.isArray, '数组', sessionLabel, violations);

    if (isRecord(session.appendSystemPrompt)) {
      const prompt = requireRecord(session.appendSystemPrompt, sessionLabel + '.appendSystemPrompt', APPEND_PROMPT_KEYS, violations);
      checkShapeField(prompt, 'file', (v) => typeof v === 'string', '字符串', sessionLabel + '.appendSystemPrompt', violations);
      checkShapeField(prompt, 'bytes', (v) => typeof v === 'number', '数字', sessionLabel + '.appendSystemPrompt', violations);
      checkShapeField(prompt, 'injectionMode', (v) => typeof v === 'string', '字符串', sessionLabel + '.appendSystemPrompt', violations);
    }

    if (isRecord(session.contextUsage)) {
      const requiredContextKeys = session.agent === 'omp'
        ? CONTEXT_USAGE_KEYS
        : ['tokens', 'live'];
      const usage = requireRecord(session.contextUsage, sessionLabel + '.contextUsage', requiredContextKeys, violations);
      checkShapeField(usage, 'tokens', (v) => typeof v === 'number', '数字', sessionLabel + '.contextUsage', violations);
      checkShapeField(usage, 'live', (v) => typeof v === 'boolean', '布尔值', sessionLabel + '.contextUsage', violations);
      if (hasOwn(usage, 'isCompacting')) {
        checkShapeField(usage, 'isCompacting', (v) => typeof v === 'boolean', '布尔值', sessionLabel + '.contextUsage', violations);
      }
      if (hasOwn(usage, 'autoCompactionEnabled')) {
        checkShapeField(usage, 'autoCompactionEnabled', (v) => typeof v === 'boolean', '布尔值', sessionLabel + '.contextUsage', violations);
      }
    }

    if (isRecord(session.openFailed)) {
      const failure = requireRecord(session.openFailed, sessionLabel + '.openFailed', OPEN_FAILED_KEYS, violations);
      checkShapeField(failure, 'phase', (v) => typeof v === 'string', '字符串', sessionLabel + '.openFailed', violations);
      checkShapeField(failure, 'error', (v) => typeof v === 'string', '字符串', sessionLabel + '.openFailed', violations);
    }

    if (isRecord(session.closed)) {
      const closed = requireRecord(session.closed, sessionLabel + '.closed', CLOSED_KEYS, violations);
      checkShapeField(closed, 'reason', (v) => typeof v === 'string', '字符串', sessionLabel + '.closed', violations);
      checkShapeField(closed, 'forced', (v) => typeof v === 'boolean', '布尔值', sessionLabel + '.closed', violations);
      checkShapeField(closed, 'at', (v) => typeof v === 'string', '字符串', sessionLabel + '.closed', violations);
    }

    if (!Array.isArray(session.turns)) continue;
    for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex += 1) {
      const turnLabel = sessionLabel + '.turns[' + turnIndex + ']';
      const turn = requireRecord(session.turns[turnIndex], turnLabel, TURN_KEYS, violations);
      if (!turn) continue;

      // turn 形状固定后，状态矩阵才有足够信息判定一次派发是否自洽。
      checkShapeField(turn, 'turnNo', (v) => typeof v === 'number', '数字', turnLabel, violations);
      checkShapeField(turn, 'vizTurnId', (v) => typeof v === 'string', '字符串', turnLabel, violations);
      checkShapeField(turn, 'backendTurnId', nullableString, '字符串或 null', turnLabel, violations);
      checkShapeField(turn, 'backendTurnCount', nullableNumber, '数字或 null', turnLabel, violations);
      checkShapeField(turn, 'state', (v) => typeof v === 'string', '字符串', turnLabel, violations);
      checkShapeField(turn, 'boundary', (v) => typeof v === 'string', '字符串', turnLabel, violations);
      checkShapeField(turn, 'attemptedAt', (v) => typeof v === 'string', '字符串', turnLabel, violations);
      checkShapeField(turn, 'dispatchedAt', (v) => typeof v === 'string', '字符串', turnLabel, violations);
      checkShapeField(turn, 'settledAt', nullableString, '字符串或 null', turnLabel, violations);
      checkShapeField(turn, 'firstBackendEventAt', nullableString, '字符串或 null', turnLabel, violations);
      checkShapeField(turn, 'source', (v) => typeof v === 'string', '字符串', turnLabel, violations);
      checkShapeField(turn, 'blocking', (v) => typeof v === 'boolean', '布尔值', turnLabel, violations);
      checkShapeField(turn, 'hasSchema', (v) => typeof v === 'boolean', '布尔值', turnLabel, violations);
      checkShapeField(turn, 'input', isRecord, '对象', turnLabel, violations);
      checkShapeField(turn, 'output', isRecord, '对象', turnLabel, violations);
      checkShapeField(turn, 'outcome', nullableString, '字符串或 null', turnLabel, violations);
      checkShapeField(turn, 'bodyKind', nullableString, '字符串或 null', turnLabel, violations);
      checkShapeField(turn, 'generationCount', (v) => typeof v === 'number', '数字', turnLabel, violations);
      checkShapeField(turn, 'collected', (v) => v === null || isRecord(v), '对象或 null', turnLabel, violations);
      checkShapeField(turn, 'error', nullableString, '字符串或 null', turnLabel, violations);
      checkShapeField(turn, 'durationMs', nullableNumber, '数字或 null', turnLabel, violations);

      if (isRecord(turn.input)) {
        const input = requireRecord(turn.input, turnLabel + '.input', INPUT_KEYS, violations);
        checkShapeField(input, 'state', (v) => typeof v === 'string', '字符串', turnLabel + '.input', violations);
        checkShapeField(input, 'ref', nullableString, '字符串或 null', turnLabel + '.input', violations);
        checkShapeField(input, 'sha256', nullableString, '字符串或 null', turnLabel + '.input', violations);
        checkShapeField(input, 'chars', nullableNumber, '数字或 null', turnLabel + '.input', violations);
        checkShapeField(input, 'bytes', nullableNumber, '数字或 null', turnLabel + '.input', violations);
        checkShapeField(input, 'truncated', (v) => typeof v === 'boolean', '布尔值', turnLabel + '.input', violations);
        checkShapeField(input, 'originalBytes', nullableNumber, '数字或 null', turnLabel + '.input', violations);
        checkShapeField(input, 'error', nullableString, '字符串或 null', turnLabel + '.input', violations);
      }

      if (isRecord(turn.output)) {
        const output = requireRecord(turn.output, turnLabel + '.output', OUTPUT_KEYS, violations);
        checkShapeField(output, 'state', (v) => typeof v === 'string', '字符串', turnLabel + '.output', violations);
        checkShapeField(output, 'ref', nullableString, '字符串或 null', turnLabel + '.output', violations);
        checkShapeField(output, 'sha256', nullableString, '字符串或 null', turnLabel + '.output', violations);
        checkShapeField(output, 'chars', nullableNumber, '数字或 null', turnLabel + '.output', violations);
        checkShapeField(output, 'bytes', nullableNumber, '数字或 null', turnLabel + '.output', violations);
        checkShapeField(output, 'previewBytes', nullableNumber, '数字或 null', turnLabel + '.output', violations);
        checkShapeField(output, 'previewSha256', nullableString, '字符串或 null', turnLabel + '.output', violations);
        checkShapeField(output, 'error', nullableString, '字符串或 null', turnLabel + '.output', violations);
      }

      if (isRecord(turn.collected)) {
        const collected = requireRecord(turn.collected, turnLabel + '.collected', COLLECTED_KEYS, violations);
        checkShapeField(collected, 'at', (v) => typeof v === 'string', '字符串', turnLabel + '.collected', violations);
        checkShapeField(collected, 'via', (v) => typeof v === 'string', '字符串', turnLabel + '.collected', violations);
        checkShapeField(collected, 'returnedChars', (v) => typeof v === 'number', '数字', turnLabel + '.collected', violations);
        checkShapeField(collected, 'truncated', (v) => typeof v === 'boolean', '布尔值', turnLabel + '.collected', violations);
      }
    }
  }
  return violations;
}

// ref 的词法边界先挡住绝对路径、反斜杠与父目录段，避免存在性检查本身越出 VIZ_DIR。
function isLexicallyValidRef(ref) {
  return typeof ref === 'string'
    && REF_RE.test(ref)
    && !ref.startsWith('/')
    && !ref.includes('\\')
    && !ref.split('/').includes('..');
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

// 只有调用者显式给出 vizDir 时才碰文件系统，保持纯对象校验可用于冻结样例。
function createVizContext(vizDir, violations) {
  if (vizDir === null) return null;
  if (typeof vizDir !== 'string' || vizDir.length === 0) {
    violations.push('vizDir 必须是非空字符串或 null');
    return null;
  }
  try {
    const logicalBase = path.resolve(vizDir);
    const realBase = fs.realpathSync(logicalBase);
    if (!fs.statSync(realBase).isDirectory()) {
      violations.push('vizDir 不是目录');
      return null;
    }
    return { logicalBase, realBase };
  } catch (error) {
    violations.push('vizDir 不存在或不可读：' + error.message);
    return null;
  }
}

// 普通路径检查挡不住 symlink 逃逸，所以 realpath 前后都必须确认目标仍在 VIZ_DIR 内。
function checkReadableRef(ref, label, vizContext, violations) {
  if (!vizContext || typeof ref !== 'string' || !isLexicallyValidRef(ref)) return;
  const logicalTarget = path.resolve(vizContext.logicalBase, ref.split('/').join(path.sep));
  if (!isInside(vizContext.logicalBase, logicalTarget)) {
    violations.push(label + ' 解析后越出 vizDir');
    return;
  }
  try {
    const realTarget = fs.realpathSync(logicalTarget);
    if (!isInside(vizContext.realBase, realTarget)) {
      violations.push(label + ' 经 realpath 后越出 vizDir');
      return;
    }
    if (!fs.statSync(realTarget).isFile()) {
      violations.push(label + ' 指向的目标不是普通文件');
      return;
    }
    fs.accessSync(realTarget, fs.constants.R_OK);
  } catch (error) {
    violations.push(label + ' 指向的文件不存在或不可读：' + error.message);
  }
}

function validateAppendSystemPrompt(session, label, violations) {
  if (!isRecord(session.appendSystemPrompt)) return;
  const prompt = session.appendSystemPrompt;
  rejectUnknownKeys(prompt, APPEND_PROMPT_KEYS, label + '.appendSystemPrompt', violations);

  // 注入方式与后端不匹配会把“系统指令”误报成具有并不存在的权限层级。
  checkEnum(prompt.injectionMode, INJECTION_MODES, label + '.appendSystemPrompt.injectionMode', violations);
  const expectedByAgent = {
    omp: 'system',
    claude: 'system',
    codex: 'developer',
    cursor: 'first-turn-user-prefix',
    kimi: 'first-turn-user-prefix',
  };
  if (hasOwn(expectedByAgent, session.agent) && prompt.injectionMode !== expectedByAgent[session.agent]) {
    violations.push(label + '.appendSystemPrompt.injectionMode 与 agent 不匹配');
  }

  // prompt 字节数参与容量与展示，溢出或小数会让不同实现采用不同口径。
  checkSafeCount(prompt.bytes, label + '.appendSystemPrompt.bytes', violations);
}

function validateContextUsage(session, label, violations) {
  if (session.contextUsage === null || !isRecord(session.contextUsage)) return;
  const usage = session.contextUsage;
  rejectUnknownKeys(usage, CONTEXT_USAGE_KEYS, label + '.contextUsage', violations);

  // token 是绝对计数，非安全整数会让压缩状态与页面读数失真。
  checkSafeCount(usage.tokens, label + '.contextUsage.tokens', violations);

  // cursor 与 kimi 按合同没有上下文读数，伪造对象会把“不适用”显示成真实的零或进度。
  if (session.agent === 'cursor' || session.agent === 'kimi') {
    violations.push(label + '.contextUsage 对 ' + session.agent + ' 必须是 null');
  }

  // live 的后端含义是固定的，反转后会把历史快照标成实时遥测。
  if (session.agent === 'omp' && usage.live !== true) {
    violations.push(label + '.contextUsage.live 对 omp 必须是 true');
  }
  if ((session.agent === 'codex' || session.agent === 'claude') && usage.live !== false) {
    violations.push(label + '.contextUsage.live 对 ' + session.agent + ' 必须是 false');
  }

  // 压缩细节只有 OMP 能提供，其他后端出现这些键会制造虚假的能力信息。
  if (session.agent !== 'omp'
      && (hasOwn(usage, 'isCompacting') || hasOwn(usage, 'autoCompactionEnabled'))) {
    violations.push(label + '.contextUsage 的压缩字段只能由 omp 提供');
  }
}

function validateCollected(collected, label, violations) {
  if (!isRecord(collected)) return;
  rejectUnknownKeys(collected, COLLECTED_KEYS, label, violations);

  // collection 来源是封闭集合，否则页面无法解释正文究竟在哪个 API 首次被取走。
  checkEnum(collected.via, COLLECTION_VIA, label + '.via', violations);

  // returnedChars 是真实内联返回量，必须保持 UTF-16 计数且不能用非有限数冒充 null。
  checkSafeCount(collected.returnedChars, label + '.returnedChars', violations);

  checkIsoTimestamp(collected.at, label + '.at', violations);
}

function validatePayload(payload, kind, turn, session, label, vizContext, observedErrors, violations) {
  if (!isRecord(payload)) return;
  const isInput = kind === 'input';
  rejectUnknownKeys(payload, isInput ? INPUT_KEYS : OUTPUT_KEYS, label, violations);

  // 三态必须封闭，否则 ref 与错误字段的蕴含式没有确定含义。
  checkEnum(payload.state, FILE_STATES, label + '.state', violations);

  // 正文计数使用安全整数，显式拒绝 NaN 与 Infinity，避免序列化后伪装成 null。
  checkSafeCount(payload.chars, label + '.chars', violations, { nullable: true });
  checkSafeCount(payload.bytes, label + '.bytes', violations, { nullable: true });
  if (isInput) {
    checkSafeCount(payload.originalBytes, label + '.originalBytes', violations, { nullable: true });

    // §4.7：`truncated === false ⟹ bytes === originalBytes`。
    //
    // 不截断就没有“原始比保存大”这回事，两个数必须是同一个。页面正是拿它们说出
    // 「已截断 · 原始 12.3 MB / 保存 4 MB」这句话 —— 放任它们对不上，等于凭空告诉
    // 用户手里那份是残件（或者反过来，把残件说成完整原文）。
    //
    // 判据就是**恒等**，包括两者同为 null（尚未落盘 / 写失败，两个数都还不存在）。
    // 不要额外加一条“originalBytes 不能是 null”：那会把 pending 这个完全正常的
    // 中间态判成违规 —— 合同要的是两个数一致，不是要求它们随时都有值。
    if (payload.truncated === false && payload.originalBytes !== payload.bytes) {
      violations.push(label + '.truncated 为 false 时 originalBytes 必须等于 bytes');
    }
    // 反过来，声称截断却没比保存的更大，说明那面“已截断”的旗子是假的。
    if (payload.truncated === true
        && typeof payload.originalBytes === 'number'
        && typeof payload.bytes === 'number'
        && payload.originalBytes <= payload.bytes) {
      violations.push(label + '.truncated 为 true 时 originalBytes 必须大于 bytes');
    }
  } else {
    checkSafeCount(payload.previewBytes, label + '.previewBytes', violations, { nullable: true });
  }

  // 非 ready 状态若发布 ref 或摘要，viewer 会把尚未完成或已经失败的正文当成可读文件。
  if (payload.state !== 'ready') {
    if (payload.ref !== null) violations.push(label + '.ref 在 state 非 ready 时必须是 null');
    if (payload.sha256 !== null) violations.push(label + '.sha256 在 state 非 ready 时必须是 null');
  }

  // ready 没有稳定路径或强摘要就无法证明页面展示的是快照所指的那份正文。
  if (payload.state === 'ready') {
    if (typeof payload.ref !== 'string' || payload.ref.length === 0) {
      violations.push(label + '.ref 在 state 为 ready 时必须是非空字符串');
    }
    if (typeof payload.sha256 !== 'string' || !SHA256_RE.test(payload.sha256)) {
      violations.push(label + '.sha256 在 state 为 ready 时必须是 64 位小写 hex');
    }
  }

  // 即使 ref 类型正确，危险字符与父目录段仍可能把 /file 变成目录穿越入口。
  if (typeof payload.ref === 'string' && !isLexicallyValidRef(payload.ref)) {
    violations.push(label + '.ref 不是安全的 POSIX 风格 VIZ_DIR 相对路径');
  }

  // ref 必须落在本 session、本 turn 的固定文件名上，否则历史卡片会串读另一轮正文。
  if (typeof payload.ref === 'string'
      && typeof session.sessionId === 'string'
      && Number.isSafeInteger(turn.turnNo)) {
    const suffix = isInput ? '.in.md' : '.out.md';
    const expectedRef = 'turns/' + session.sessionId + '/t' + turn.turnNo + suffix;
    if (payload.ref !== expectedRef) {
      violations.push(label + '.ref 必须等于 ' + expectedRef);
    }
  }

  // 第四条蕴含式只有拿到 vizDir 才可实证；没有目录时绝不把无法观察当作失败。
  if (payload.ref !== null) {
    checkReadableRef(payload.ref, label + '.ref', vizContext, violations);
  }

  const allowedErrors = isInput ? INPUT_ERROR_CODES : OUTPUT_ERROR_CODES;
  // 错误码必须与输入、输出各自可发生的失败面一致，不能混入 run 级原因。
  checkEnum(payload.error, allowedErrors, label + '.error', violations, { nullable: true });

  // 第五条蕴含式防止“写失败”与“文件可读”同时成立。
  if (payload.error !== null && payload.state !== 'missing') {
    violations.push(label + '.error 非空时 state 必须是 missing');
  }

  // 第六条蕴含式防止 pending 或 ready 携带一个不可能的写入错误。
  if ((payload.state === 'pending' || payload.state === 'ready') && payload.error !== null) {
    violations.push(label + '.state 为 pending/ready 时 error 必须是 null');
  }

  if (typeof payload.error === 'string' && allowedErrors.has(payload.error)) {
    observedErrors.add(payload.error);
  }

  if (!isInput) {
    // 预览长度与指纹必须成对出现，否则 viewer 无法知道摘要对应哪一段字节。
    const hasPreviewBytes = payload.previewBytes !== null;
    const hasPreviewSha = payload.previewSha256 !== null;
    if (hasPreviewBytes !== hasPreviewSha) {
      violations.push(label + '.previewBytes 与 previewSha256 必须同时为 null 或同时有值');
    }
    if (hasPreviewSha && (typeof payload.previewSha256 !== 'string' || !SHA256_RE.test(payload.previewSha256))) {
      violations.push(label + '.previewSha256 必须是 64 位小写 hex');
    }

    // 非 ready 输出不存在可供预览的正文，残留预览元数据会让页面展示幽灵内容。
    if (payload.state !== 'ready' && (payload.previewBytes !== null || payload.previewSha256 !== null)) {
      violations.push(label + ' 在 state 非 ready 时不能带预览元数据');
    }

    // 预览是完整正文的前缀，长度超过正文总字节数说明两种计量已经漂移。
    if (typeof payload.previewBytes === 'number'
        && Number.isSafeInteger(payload.previewBytes)
        && typeof payload.bytes === 'number'
        && Number.isSafeInteger(payload.bytes)
        && payload.previewBytes > payload.bytes) {
      violations.push(label + '.previewBytes 不能大于 bytes');
    }

    // dispatched 阶段正文尚未结算，提前填计数会把进行中的输出伪装成已保存内容。
    if (turn.state === 'dispatched' && (payload.chars !== null || payload.bytes !== null)) {
      violations.push(label + '.chars/bytes 在 turn.state 为 dispatched 时必须是 null');
    }
  }
}

function validateTurn(turn, session, label, vizContext, seenVizTurnIds, observedErrors, violations) {
  if (!isRecord(turn)) return;
  rejectUnknownKeys(turn, TURN_KEYS, label, violations);

  // turnNo 既决定展示顺序也进入文件名，必须从 1 起且不能被非有限数污染。
  checkSafeCount(turn.turnNo, label + '.turnNo', violations, { minimum: 1 });

  // vizTurnId 是 sidecar 与快照的唯一身份缝，复用会让迟到进度写进另一轮。
  if (typeof turn.vizTurnId === 'string') {
    if (turn.vizTurnId.length === 0) {
      violations.push(label + '.vizTurnId 不能为空');
    } else if (seenVizTurnIds.has(turn.vizTurnId)) {
      violations.push(label + '.vizTurnId 在一个 run 内重复：' + turn.vizTurnId);
    } else {
      seenVizTurnIds.add(turn.vizTurnId);
    }
  }

  // 后端轮次计数与稿次都参与诊断，null 以外只能是有限非负安全整数。
  checkSafeCount(turn.backendTurnCount, label + '.backendTurnCount', violations, { nullable: true });
  checkSafeCount(turn.generationCount, label + '.generationCount', violations);
  checkSafeCount(turn.durationMs, label + '.durationMs', violations, { nullable: true });

  // 公开状态、边界、来源、结果与正文种类都是封闭词汇，新增值必须走 schema 升级。
  checkEnum(turn.state, TURN_STATES, label + '.state', violations);
  checkEnum(turn.boundary, TURN_BOUNDARIES, label + '.boundary', violations);
  checkEnum(turn.source, TURN_SOURCES, label + '.source', violations);
  checkEnum(turn.outcome, TURN_OUTCOMES, label + '.outcome', violations, { nullable: true });
  checkEnum(turn.bodyKind, BODY_KINDS, label + '.bodyKind', violations, { nullable: true });

  // 单轮错误同样有体积上限，避免后端异常栈无限进入快照。
  checkBoundedText(turn.error, label + '.error', violations);

  // 时间线是这份记录的主轴，四个时刻的格式一个都不能松。
  checkIsoTimestamp(turn.attemptedAt, label + '.attemptedAt', violations);
  checkIsoTimestamp(turn.dispatchedAt, label + '.dispatchedAt', violations);
  checkIsoTimestamp(turn.settledAt, label + '.settledAt', violations, { nullable: true });
  checkIsoTimestamp(turn.firstBackendEventAt, label + '.firstBackendEventAt', violations, { nullable: true });

  // terminal_adopted 代表终结事件晚到认领，时间倒序就不符合这段因果关系。
  //
  // ⚠️ 判据是 `>=` 而不是 `>`（STATE.md §4.6）。要挡的是「实现把 dispatchedAt 直接抄成
  //    attemptedAt、抹平中间那段歧义期」，但**严格大于要求的是毫秒时钟分辨率**——
  //    本地极快的后端、hermetic 假后端都可能在同一毫秒里走完「尝试 → 终结事件 → 认领」。
  //    合同不该要求实现保证不了的事，否则这里就是一颗随机红的雷。
  //    牙齿在 writer 回归里：那边造一个真实时间间隔再断言严格 `>`，抄时间戳的实现照样过不去。
  if (turn.boundary === 'terminal_adopted'
      && typeof turn.attemptedAt === 'string'
      && typeof turn.dispatchedAt === 'string') {
    const attemptedMs = Date.parse(turn.attemptedAt);
    const dispatchedMs = Date.parse(turn.dispatchedAt);
    if (!Number.isFinite(attemptedMs) || !Number.isFinite(dispatchedMs)) {
      violations.push(label + ' 的 terminal_adopted 时间必须可解析后才能证明先后关系');
    } else if (dispatchedMs < attemptedMs) {
      violations.push(label + ' 使用 terminal_adopted 时 dispatchedAt 不得早于 attemptedAt');
    }
  }

  validatePayload(turn.input, 'input', turn, session, label + '.input', vizContext, observedErrors, violations);
  validatePayload(turn.output, 'output', turn, session, label + '.output', vizContext, observedErrors, violations);
  validateCollected(turn.collected, label + '.collected', violations);

  // 第一张矩阵把公开进行态锁死，避免未结算轮次携带一个看似完成的结果。
  if (turn.state === 'dispatched') {
    if (turn.outcome !== null) violations.push(label + '.outcome 在 dispatched 时必须是 null');
    if (turn.settledAt !== null) violations.push(label + '.settledAt 在 dispatched 时必须是 null');
    if (turn.durationMs !== null) violations.push(label + '.durationMs 在 dispatched 时必须是 null');
    if (turn.bodyKind !== null) violations.push(label + '.bodyKind 在 dispatched 时必须是 null');
    if (isRecord(turn.output) && turn.output.state !== 'pending') {
      violations.push(label + '.output.state 在 dispatched 时必须是 pending');
    }
    if (turn.collected !== null) violations.push(label + '.collected 在 dispatched 时必须是 null');
  }

  // 第一张矩阵也锁死结算态，防止 settled 仍残留 pending 文件或缺少结算时长。
  if (turn.state === 'settled') {
    if (turn.outcome === null) violations.push(label + '.outcome 在 settled 时必须非空');
    if (turn.settledAt === null) violations.push(label + '.settledAt 在 settled 时必须有值');
    if (turn.durationMs === null) violations.push(label + '.durationMs 在 settled 时必须有值');
    if (turn.bodyKind === null) violations.push(label + '.bodyKind 在 settled 时必须非空');
    if (isRecord(turn.output) && turn.output.state === 'pending') {
      violations.push(label + '.output.state 在 settled 时不能是 pending');
    }
    if (isRecord(turn.input) && turn.input.state === 'pending') {
      violations.push(label + '.input.state 在 settled 时不能是 pending');
    }
  }

  // 第二张矩阵禁止失败、终止或遗弃轮次声称拥有 final 正文。
  if ((turn.outcome === 'failed' || turn.outcome === 'aborted' || turn.outcome === 'abandoned')
      && turn.bodyKind === 'final') {
    violations.push(label + ' 的 outcome=' + turn.outcome + ' 不能与 bodyKind=final 组合');
  }

  // completed+none 只代表后端完成但观测写失败，无 output.error 就会把漏记伪装成正常完成。
  if (turn.outcome === 'completed'
      && turn.bodyKind === 'none'
      && isRecord(turn.output)
      && turn.output.error === null) {
    violations.push(label + ' 的 completed+none 仅在 output.error 非空时合法');
  }

  // 第一条蕴含式确保 final/partial 的正文真的已经发布并有可追踪 ref。
  if ((turn.bodyKind === 'final' || turn.bodyKind === 'partial') && isRecord(turn.output)) {
    if (turn.output.state !== 'ready' || typeof turn.output.ref !== 'string' || turn.output.ref.length === 0) {
      violations.push(label + ' 的 bodyKind 为 final/partial 时 output 必须 ready 且 ref 非空');
    }
  }

  // 第二条蕴含式确保 none 不会暗中保留一个可读输出。
  if (turn.bodyKind === 'none' && isRecord(turn.output)) {
    if (turn.output.state !== 'missing' || turn.output.ref !== null) {
      violations.push(label + ' 的 bodyKind 为 none 时 output 必须 missing 且 ref 为 null');
    }
  }

  // 第三条蕴含式防止进行中的轮次被标成已经由 result/wait 取走。
  if (turn.collected !== null && turn.state !== 'settled') {
    violations.push(label + '.collected 非空时 state 必须是 settled');
  }
}

function validateSession(session, index, context, violations) {
  if (!isRecord(session)) return;
  const label = 'snapshot.sessions[' + index + ']';
  rejectUnknownKeys(session, SESSION_KEYS, label, violations);

  // sessionId 直接进入目录名，空值、分隔符或双点会把正文写出预期目录。
  if (typeof session.sessionId === 'string') {
    if (!SESSION_ID_RE.test(session.sessionId) || session.sessionId.includes('..')) {
      violations.push(label + '.sessionId 只能含 A-Z/a-z/0-9/._-，且不能含 ..');
    } else if (context.seenSessionIds.has(session.sessionId)) {
      violations.push(label + '.sessionId 重复：' + session.sessionId);
    } else {
      context.seenSessionIds.add(session.sessionId);
    }
  }

  // session 的后端、努力级别、访问面、返回方式、状态与健康度都必须来自封闭枚举。
  checkEnum(session.agent, AGENTS, label + '.agent', violations);
  checkEnum(session.effort, EFFORTS, label + '.effort', violations, { nullable: true });
  checkEnum(session.access, ACCESS_MODES, label + '.access', violations);
  checkEnum(session.returnMode, RETURN_MODES, label + '.returnMode', violations);
  checkEnum(session.status, SESSION_STATUSES, label + '.status', violations);
  checkEnum(session.health, SESSION_HEALTH, label + '.health', violations);

  // backendPid 是可空 PID，出现时仍必须满足所有计数的有限安全整数口径。
  checkSafeCount(session.backendPid, label + '.backendPid', violations, { nullable: true });

  validateAppendSystemPrompt(session, label, violations);
  validateContextUsage(session, label, violations);

  if (isRecord(session.openFailed)) {
    rejectUnknownKeys(session.openFailed, OPEN_FAILED_KEYS, label + '.openFailed', violations);
    // 启动失败阶段只有两处，额外值会让 viewer 错判失败发生在何时。
    checkEnum(session.openFailed.phase, OPEN_FAILURE_PHASES, label + '.openFailed.phase', violations);
    checkBoundedText(session.openFailed.error, label + '.openFailed.error', violations);
  }

  if (isRecord(session.closed)) {
    // close 对象也必须封闭，避免后端 summary 的新字段绕过 session 白名单。
    rejectUnknownKeys(session.closed, CLOSED_KEYS, label + '.closed', violations);
    checkIsoTimestamp(session.closed.at, label + '.closed.at', violations);
  }

  checkIsoTimestamp(session.createdAt, label + '.createdAt', violations);
  checkIsoTimestamp(session.updatedAt, label + '.updatedAt', violations);

  if (!Array.isArray(session.turns)) return;
  let previousTurnNo = null;
  for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex += 1) {
    const turn = session.turns[turnIndex];
    if (isRecord(turn) && Number.isSafeInteger(turn.turnNo)) {
      // turns 的稳定升序保证数组位置不会随 updatedAt 或后端编号重排。
      if (previousTurnNo === null && turn.turnNo !== 1) {
        violations.push(label + '.turns 必须从 turnNo=1 开始');
      }
      if (previousTurnNo !== null && turn.turnNo <= previousTurnNo) {
        violations.push(label + '.turns 必须按 turnNo 严格升序');
      }
      previousTurnNo = turn.turnNo;
    }
    validateTurn(
      turn,
      session,
      label + '.turns[' + turnIndex + ']',
      context.vizContext,
      context.seenVizTurnIds,
      context.observedErrors,
      violations,
    );
  }
}

export function checkSnapshot(snapshot, { vizDir = null } = {}) {
  // 先收集必填结构，保证任意坏对象都返回违反项而不是在深层访问时抛异常。
  const violations = collectRequiredStructure(snapshot);
  if (!isRecord(snapshot)) return violations;

  // 顶层白名单阻止事件信封、seq 或其他非快照字段悄悄进入 v1 wire。
  rejectUnknownKeys(snapshot, SNAPSHOT_KEYS, 'snapshot', violations);

  // schemaVersion 固定为 1，未知版本不能按当前语义误读。
  if (!SUPPORTED_SCHEMA_VERSIONS.has(snapshot.schemaVersion)) {
    violations.push('snapshot.schemaVersion 当前只支持 1');
  }

  // generation 是发布屏障，0、负数、非有限数和非安全整数都不能参与新旧比较。
  checkSafeCount(snapshot.generation, 'snapshot.generation', violations, { minimum: 1 });

  // 空 runId 无法承担同目录 meta 身份比对，也会让不同 run 看似相同。
  if (typeof snapshot.runId === 'string' && snapshot.runId.length === 0) {
    violations.push('snapshot.runId 不能为空');
  }

  checkIsoTimestamp(snapshot.updatedAt, 'snapshot.updatedAt', violations);

  const vizContext = createVizContext(vizDir, violations);
  const observedErrors = new Set();
  const context = {
    vizContext,
    observedErrors,
    seenSessionIds: new Set(),
    seenVizTurnIds: new Set(),
  };

  if (isRecord(snapshot.run)) {
    const run = snapshot.run;
    rejectUnknownKeys(run, RUN_KEYS, 'snapshot.run', violations);

    // run.pid 也属于统一计数口径，不能让进程身份被小数或 Infinity 污染。
    checkSafeCount(run.pid, 'snapshot.run.pid', violations);

    checkIsoTimestamp(run.startedAt, 'snapshot.run.startedAt', violations);

    // terminated 在生产路径不可达，保留它只会让测试认可 writer 永远发不出的状态。
    if (run.status !== 'running') {
      violations.push('snapshot.run.status 只能是 running');
    }

    if (Array.isArray(run.recordingErrors)) {
      // 上限阻止持续失败让快照无界增长。
      if (run.recordingErrors.length > 16) {
        violations.push('snapshot.run.recordingErrors 最多 16 条');
      }

      const seenErrors = new Set();
      for (const code of run.recordingErrors) {
        // 原因码封闭后，页面才不会把未知内部错误当成可解释的记录降级。
        if (!RECORDING_ERROR_CODES.has(code)) {
          violations.push('snapshot.run.recordingErrors 含未知原因码 ' + String(code));
        }
        // 去重让数组表达原因集合，而不是失败次数。
        if (seenErrors.has(code)) {
          violations.push('snapshot.run.recordingErrors 含重复原因码 ' + String(code));
        }
        seenErrors.add(code);
      }

      // 有原因却不 degraded 会让页面看见错误码但仍显示“记录完整”。
      if (run.recordingErrors.length > 0 && run.degraded !== true) {
        violations.push('snapshot.run.recordingErrors 非空时 degraded 必须为 true');
      }
      // degraded 没有任何原因无法说明缺页来自何处，也破坏这两个字段的单一真理源。
      if (run.degraded === true && run.recordingErrors.length === 0) {
        violations.push('snapshot.run.degraded 为 true 时 recordingErrors 不能是空数组');
      }
    }
  }

  if (Array.isArray(snapshot.sessions)) {
    for (let index = 0; index < snapshot.sessions.length; index += 1) {
      validateSession(snapshot.sessions[index], index, context, violations);
    }
  }

  if (isRecord(snapshot.run) && Array.isArray(snapshot.run.recordingErrors)) {
    // 任一正文写失败都必须同时点亮 run.degraded，否则页面会把缺页快照当完整历史。
    if (observedErrors.size > 0 && snapshot.run.degraded !== true) {
      violations.push('存在 input/output.error 时 snapshot.run.degraded 必须为 true');
    }

    // 任一正文错误码都必须并入 run 原因集合，三处少一处就无法追踪降级根因。
    for (const code of observedErrors) {
      if (!snapshot.run.recordingErrors.includes(code)) {
        violations.push('input/output.error 原因码 ' + code + ' 未写入 snapshot.run.recordingErrors');
      }
    }
  }

  return violations;
}

// meta 只允许不可变身份字段，额外状态会制造与最新快照竞争的第二真理源。
function checkMeta(meta) {
  const violations = [];
  const object = requireRecord(meta, 'meta.json', META_KEYS, violations);
  if (!object) return violations;
  rejectUnknownKeys(object, META_KEYS, 'meta.json', violations);
  checkShapeField(object, 'runId', (v) => typeof v === 'string', '字符串', 'meta.json', violations);
  checkShapeField(object, 'pid', (v) => typeof v === 'number', '数字', 'meta.json', violations);
  checkShapeField(object, 'processStartedAt', (v) => typeof v === 'string', '字符串', 'meta.json', violations);
  checkShapeField(object, 'bridgeVersion', (v) => typeof v === 'string', '字符串', 'meta.json', violations);
  checkShapeField(object, 'createdAt', (v) => typeof v === 'string', '字符串', 'meta.json', violations);
  checkSafeCount(object.pid, 'meta.json.pid', violations);
  checkIsoTimestamp(object.processStartedAt, 'meta.json.processStartedAt', violations);
  checkIsoTimestamp(object.createdAt, 'meta.json.createdAt', violations);
  if (typeof object.runId === 'string' && object.runId.length === 0) {
    violations.push('meta.json.runId 不能为空');
  }
  return violations;
}

function readJsonFile(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

// 槽资格严格只由 §2.1 四条决定，深层语义错误留给选中后的 checkSnapshot 报告。
function checkSlotEligibility(snapshot, metaRunId) {
  const violations = collectRequiredStructure(snapshot);
  if (!isRecord(snapshot)) return violations;

  // 先比 runId，确保旧 run 的高 generation 永远没有参选资格。
  if (typeof metaRunId !== 'string' || snapshot.runId !== metaRunId) {
    violations.push('runId 与 meta.json.runId 不完全相等');
  }

  // generation 必须可安全排序且从 1 开始。
  checkSafeCount(snapshot.generation, 'generation', violations, { minimum: 1 });

  // viewer 只能消费明确支持的 schema，不能拿 generation 掩盖版本不兼容。
  if (!SUPPORTED_SCHEMA_VERSIONS.has(snapshot.schemaVersion)) {
    violations.push('schemaVersion 不在支持集合中');
  }

  return violations;
}

export function checkVizDir(vizDir) {
  const result = { chosen: null, generation: null, violations: [] };

  // 非目录参数无法建立 meta 与双槽的共同身份边界，直接返回人话错误而不是抛异常。
  if (typeof vizDir !== 'string' || vizDir.length === 0) {
    result.violations.push('vizDir 必须是非空字符串');
    return result;
  }

  const metaRead = readJsonFile(path.join(vizDir, 'meta.json'));
  let metaRunId = null;
  if (!metaRead.ok) {
    result.violations.push('meta.json 无法读取或解析：' + metaRead.error.message);
  } else {
    const meta = metaRead.value;
    result.violations.push(...checkMeta(meta));
    if (isRecord(meta) && typeof meta.runId === 'string' && meta.runId.length > 0) {
      metaRunId = meta.runId;
    }
  }

  const validSlots = [];
  const rejectedSlots = [];
  for (const name of ['state.0.json', 'state.1.json']) {
    const slotRead = readJsonFile(path.join(vizDir, name));
    if (!slotRead.ok) {
      rejectedSlots.push(name + ' 无法读取或解析：' + slotRead.error.message);
      continue;
    }
    const slotViolations = checkSlotEligibility(slotRead.value, metaRunId);
    if (slotViolations.length > 0) {
      rejectedSlots.push(name + ' 不是合法槽：' + slotViolations.join('；'));
      continue;
    }
    validSlots.push({ name, snapshot: slotRead.value, generation: slotRead.value.generation });
  }

  // 双槽允许一个槽正处于覆盖写；只有两槽都不合法时才把各自失败原因升级为目录违反项。
  if (validSlots.length === 0) {
    result.violations.push(...rejectedSlots);
    result.violations.push('没有符合 §2.1 四条条件的合法槽');
    return result;
  }

  validSlots.sort((left, right) => {
    if (left.generation === right.generation) return left.name.localeCompare(right.name);
    return left.generation > right.generation ? -1 : 1;
  });
  const chosen = validSlots[0];
  result.chosen = chosen.name;
  result.generation = chosen.generation;

  // 相同最大 generation 无法从合同推出唯一新槽，报告歧义并用文件名稳定择一以保持返回形状可用。
  if (validSlots.length > 1 && validSlots[1].generation === chosen.generation) {
    result.violations.push('两个合法槽具有相同的最大 generation，无法唯一判定最新槽');
  }

  // 选槽完成后才跑全部白名单、矩阵、蕴含式与文件可读性检查，防止错误槽凭高 generation 胜出。
  result.violations.push(...checkSnapshot(chosen.snapshot, { vizDir }));
  return result;
}
