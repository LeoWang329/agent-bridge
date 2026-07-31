#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  checkSnapshot,
  checkVizDir,
} from './contract-invariants-session.mjs';
import {
  contextLevel,
  deriveView,
  isUncollected,
  permKind,
  reconcile,
  statusKind,
} from '../skills/agent-bridge/viz/reconcile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VIZ = path.join(REPO, 'skills', 'agent-bridge', 'viz');
const SAMPLE_DIR = path.join(VIZ, 'sample');
const SERVE_FILE = path.join(VIZ, 'serve.mjs');
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

let passed = 0;
let failed = 0;

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function assertCase(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    return true;
  }

  failed += 1;
  const suffix = detail ? ` — ${oneLine(detail)}` : '';
  console.log(`[FAIL] ${name}${suffix}`);
  return false;
}

async function runSection(name, body) {
  try {
    await body();
  } catch (error) {
    assertCase(`${name} 未完成`, false, error?.stack || error);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value), 'utf8');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempVizDir(body) {
  const prefix = path.join(tmpdir(), 'agent-bridge-test-viz-');
  const vizDir = await mkdtemp(prefix);
  try {
    return await body(vizDir);
  } finally {
    await rm(vizDir, { recursive: true, force: true });
  }
}

function makeMeta(runId) {
  return {
    runId,
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    bridgeVersion: 'test-viz',
    createdAt: new Date().toISOString(),
  };
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

async function materializeRefs(vizDir, snapshot) {
  for (const session of snapshot?.sessions || []) {
    for (const turn of session?.turns || []) {
      for (const payload of [turn?.input, turn?.output]) {
        if (typeof payload?.ref !== 'string') continue;
        const target = path.resolve(vizDir, payload.ref.split('/').join(path.sep));
        if (!isInside(path.resolve(vizDir), target)) {
          throw new Error(`冻结样例 ref 越界，拒绝材料化：${payload.ref}`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `fixture:${payload.ref}`, 'utf8');
      }
    }
  }
}

async function prepareVizDir(vizDir, metaRunId, state0, state1) {
  await writeJson(path.join(vizDir, 'meta.json'), makeMeta(metaRunId));

  for (const [name, slot] of [
    ['state.0.json', state0],
    ['state.1.json', state1],
  ]) {
    const target = path.join(vizDir, name);
    if (typeof slot === 'string') {
      await writeFile(target, slot, 'utf8');
    } else {
      await materializeRefs(vizDir, slot);
      await writeJson(target, slot);
    }
  }
}

function sampleNeedsDirectoryCheck(entry) {
  return /meta\.json|§2\.1/.test(`${entry.why || ''}\n${entry.violates || ''}`);
}

async function runFrozenCorpusTests() {
  const index = await readJson(path.join(SAMPLE_DIR, 'index.json'));
  const canonical = await readJson(path.join(SAMPLE_DIR, 'normal-completed-final-collected.json'));
  const metaRunId = canonical.runId;

  for (const entry of index.samples) {
    const snapshot = await readJson(path.join(SAMPLE_DIR, `${entry.name}.json`));

    // 每份语料都必须经过独立对象校验器；漏掉这一层会让目录选择结果掩盖深层矩阵错误。
    const snapshotViolations = checkSnapshot(snapshot);
    let finalViolations = snapshotViolations;

    if (sampleNeedsDirectoryCheck(entry)) {
      // runId/meta 闸在单对象上不可观察；这里先钉住“对象内部无别的错”，防止目录红灯由错误原因冒名顶替。
      assertCase(
        `冻结样例 ${entry.name} 的对象级部分合法`,
        snapshotViolations.length === 0,
        snapshotViolations.join('；'),
      );

      const directoryResult = await withTempVizDir(async (vizDir) => {
        const sibling = clone(snapshot);
        sibling.generation = Number.isSafeInteger(snapshot.generation) && snapshot.generation > 1
          ? snapshot.generation - 1
          : 2;
        await prepareVizDir(vizDir, metaRunId, snapshot, sibling);
        return checkVizDir(vizDir);
      });
      finalViolations = directoryResult.violations;
    }

    // expectValid 必须由真正能观察该违约的校验层决定，否则 meta/runId 冻结样例会永久假绿。
    const actualValid = finalViolations.length === 0;
    assertCase(
      `冻结样例 ${entry.name} expectValid=${entry.expectValid}`,
      actualValid === entry.expectValid,
      finalViolations.join('；'),
    );
  }
}

function slotSnapshot(base, { runId, generation, schemaVersion = 1 }) {
  const snapshot = clone(base);
  snapshot.runId = runId;
  snapshot.generation = generation;
  snapshot.schemaVersion = schemaVersion;
  return snapshot;
}

async function inspectSlots(metaRunId, state0, state1) {
  return withTempVizDir(async (vizDir) => {
    await prepareVizDir(vizDir, metaRunId, state0, state1);
    return checkVizDir(vizDir);
  });
}

async function runSlotSelectionTests() {
  const base = await readJson(path.join(SAMPLE_DIR, 'input-not-yet-published-pending.json'));
  const runId = 'mcp-slot-selection-test';

  const oldSlot = slotSnapshot(base, { runId, generation: 7 });
  const fallback = await inspectSlots(runId, oldSlot, '{broken-json');
  // 覆盖写可能撕裂新槽；没有回退会让一个仍完整的历史瞬间消失。
  assertCase(
    '双槽：新槽损坏时回退旧槽',
    fallback.chosen === 'state.0.json'
      && fallback.generation === 7
      && fallback.violations.length === 0,
    JSON.stringify(fallback),
  );

  const lower = slotSnapshot(base, { runId, generation: 8 });
  const higher = slotSnapshot(base, { runId, generation: 9 });
  const newest = await inspectSlots(runId, lower, higher);
  // 两槽都合法时 generation 是唯一发布屏障；选错会把页面永久卡在旧代。
  assertCase(
    '双槽：两槽合法时选择较大 generation',
    newest.chosen === 'state.1.json'
      && newest.generation === 9
      && newest.violations.length === 0,
    JSON.stringify(newest),
  );

  const current = slotSnapshot(base, { runId, generation: 10 });
  const staleRun = slotSnapshot(base, { runId: 'mcp-stale-run', generation: 999 });
  const identityFirst = await inspectSlots(runId, current, staleRun);
  // 若先排 generation 再验 runId，SIGKILL 残留的旧 run 会压过当前 run。
  assertCase(
    '双槽：高 generation 但 runId 错误者不得胜出',
    identityFirst.chosen === 'state.0.json'
      && identityFirst.generation === 10
      && identityFirst.violations.length === 0,
    JSON.stringify(identityFirst),
  );

  const schema2a = slotSnapshot(base, { runId, generation: 11, schemaVersion: 2 });
  const schema2b = slotSnapshot(base, { runId, generation: 12, schemaVersion: 2 });
  const unsupported = await inspectSlots(runId, schema2a, schema2b);
  // 未知版本不能靠高 generation 混入，否则 viewer 会用 v1 语义误读未来 wire。
  assertCase(
    '双槽：不支持的 schemaVersion 非法',
    unsupported.chosen === null
      && unsupported.violations.some((item) => item.includes('schemaVersion')),
    JSON.stringify(unsupported),
  );
}

async function runDisplayMappingTests() {
  const expectedStatus = {
    starting: { healthy: 'run', degraded: 'run', dead: 'end' },
    running: { healthy: 'run', degraded: 'run', dead: 'end' },
    idle: { healthy: 'idle', degraded: 'warn', dead: 'end' },
    failed: { healthy: 'warn', degraded: 'warn', dead: 'end' },
    closed: { healthy: 'end', degraded: 'end', dead: 'end' },
  };

  // 15 格写死两个正交维度的优先级；只挑“常见组合”会漏掉 dead、closed 与 degraded 的覆盖关系。
  for (const [status, healthMap] of Object.entries(expectedStatus)) {
    for (const [health, expected] of Object.entries(healthMap)) {
      const actual = statusKind({
        agent: 'cursor',
        backendPid: null,
        status,
        health,
        openFailed: null,
      });
      assertCase(
        `statusKind：${status} × ${health} → ${expected}`,
        actual === expected,
        `实际 ${actual}`,
      );
    }
  }

  // 形状 B 在轮间没有进程；把 null PID 当死亡会让健康的 cursor 会话误进终态。
  assertCase(
    'statusKind：cursor backendPid=null 且健康时不是 end',
    statusKind({ agent: 'cursor', backendPid: null, status: 'idle', health: 'healthy', openFailed: null }) !== 'end',
  );
  // kimi 与 cursor 共用短命 child 形状，单测一家不能证明映射没有后端特判漂移。
  assertCase(
    'statusKind：kimi backendPid=null 且健康时不是 end',
    statusKind({ agent: 'kimi', backendPid: null, status: 'idle', health: 'healthy', openFailed: null }) !== 'end',
  );

  const permissionTable = {
    omp: 'soft',
    codex: 'hard',
    claude: 'soft',
    cursor: 'soft',
    kimi: 'soft',
  };
  // 五家逐一钉住 read 的安全含义；笼统测一个 read 会把“只有 codex 是硬沙箱”稀释掉。
  for (const [agent, expected] of Object.entries(permissionTable)) {
    const actual = permKind({ agent, access: 'read' });
    assertCase(`permKind：${agent} read → ${expected}`, actual === expected, `实际 ${actual}`);
  }

  // null 是不可观测而非零占用；误判 normal 会给用户虚假的上下文安全感。
  assertCase('contextLevel：null → unknown', contextLevel(null) === 'unknown');
  // 300k 是收尾阈值本身，使用 > 会漏掉恰好到线的会话。
  assertCase('contextLevel：300000 → wrap', contextLevel({ tokens: 300000 }) === 'wrap');
  // 400k 必须覆盖 wrap 并升级 reopen，分支顺序反了会永远到不了最高告警。
  assertCase('contextLevel：400000 → reopen', contextLevel({ tokens: 400000 }) === 'reopen');

  // 只有已结算且从未收取才应点亮事故提示；这是正例。
  assertCase(
    'isUncollected：settled + collected=null → true',
    isUncollected({ state: 'settled', collected: null }) === true,
  );
  // 已收取的 settled 轮次不能继续报“未取”，否则提示永不消失。
  assertCase(
    'isUncollected：settled + collected 对象 → false',
    isUncollected({ state: 'settled', collected: { via: 'wait' } }) === false,
  );
  // 在途轮次尚无结果可取；只看 collected=null 会把所有运行中轮次误报警。
  assertCase(
    'isUncollected：dispatched + collected=null → false',
    isUncollected({ state: 'dispatched', collected: null }) === false,
  );

  const goneSnapshot = {
    runId: 'mcp-gone-view',
    generation: 3,
    run: { degraded: false, recordingErrors: [] },
    sessions: [{
      sessionId: 'cursor-gone-test',
      name: null,
      agent: 'cursor',
      access: 'read',
      status: 'running',
      health: 'healthy',
      contextUsage: null,
      updatedAt: '2026-07-29T00:00:00.000Z',
      openFailed: null,
      turns: [{
        turnNo: 1,
        vizTurnId: 'vt-gone-1',
        state: 'dispatched',
        outcome: null,
        bodyKind: null,
        generationCount: 1,
        collected: null,
      }],
    }],
  };
  const goneTurn = deriveView(goneSnapshot, new Map(), { runGone: true }).sessions[0].turns[0];
  // run 终态不落快照；没有这层合成，最后一代里的 dispatched 会永久显示为仍在运行。
  assertCase(
    'deriveView：run gone 把 dispatched 合成为 abandoned',
    goneTurn.synthesized === true
      && goneTurn.running === false
      && goneTurn.outcome === 'abandoned'
      && goneTurn.bodyKind === 'none',
    JSON.stringify(goneTurn),
  );
}

class ShimNode {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.scrollTop = 0;
    this.open = false;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  child(id) {
    return this.children.find((node) => node.id === id) || null;
  }
}

function uiTurn(vizTurnId, turnNo, state) {
  return {
    vizTurnId,
    turnNo,
    state,
    outcome: state === 'settled' ? 'completed' : null,
    bodyKind: state === 'settled' ? 'final' : null,
    generationCount: 1,
    collected: state === 'settled' ? { via: 'wait' } : null,
    input: { sha256: `input-${vizTurnId}` },
    output: { sha256: state === 'settled' ? `output-${vizTurnId}` : null },
  };
}

function uiSession(sessionId, status, updatedAt, turns = []) {
  return {
    sessionId,
    name: null,
    agent: 'codex',
    access: 'read',
    status,
    health: 'healthy',
    contextUsage: { tokens: 1000, live: false },
    updatedAt,
    openFailed: null,
    turns,
  };
}

function makeUiViews() {
  const previous = deriveView({
    runId: 'mcp-ui-test',
    generation: 1,
    run: { degraded: false, recordingErrors: [] },
    sessions: [
      uiSession('codex-runner', 'running', '2026-07-29T00:00:02.000Z'),
      uiSession('codex-selected', 'idle', '2026-07-29T00:00:01.000Z', [
        uiTurn('vt-ui-1', 1, 'settled'),
      ]),
    ],
  });

  const next = deriveView({
    runId: 'mcp-ui-test',
    generation: 2,
    run: { degraded: false, recordingErrors: [] },
    sessions: [
      uiSession('codex-runner', 'running', '2026-07-29T00:00:03.000Z'),
      uiSession('codex-selected', 'running', '2026-07-29T00:00:04.000Z', [
        uiTurn('vt-ui-1', 1, 'settled'),
        uiTurn('vt-ui-2', 2, 'dispatched'),
      ]),
    ],
  });

  return { previous, next };
}

function initialDom(previous, selectedSessionId) {
  const sessionList = new ShimNode('session-list');
  sessionList.replaceChildren(...previous.sessions.map((session) => new ShimNode(session.sessionId)));

  const detail = new ShimNode('detail-scroll');
  const selected = previous.byId.get(selectedSessionId);
  detail.replaceChildren(...selected.turns.map((turn) => new ShimNode(turn.vizTurnId)));
  detail.child('vt-ui-1').open = true;
  detail.scrollTop = 240;

  return { sessionList, detail, selectedSessionId };
}

function reconcileKeyedChildren(container, ids) {
  const previousById = new Map(container.children.map((node) => [node.id, node]));
  container.replaceChildren(...ids.map((id) => previousById.get(id) || new ShimNode(id)));
}

function applyRealReconcile(previous, next, uiState, dom) {
  const decision = reconcile(previous, next, uiState);
  reconcileKeyedChildren(dom.sessionList, decision.sessions.order);

  const selected = next.byId.get(decision.selection);
  reconcileKeyedChildren(dom.detail, (selected?.turns || []).map((turn) => turn.vizTurnId));
  for (const node of dom.detail.children) node.open = decision.expanded.has(node.id);

  if (decision.scrollAnchor.mode === 'top') dom.detail.scrollTop = 0;
  if (decision.scrollAnchor.mode === 'keep') dom.detail.scrollTop = decision.scrollAnchor.top;
  if (decision.scrollAnchor.mode === 'bottom') dom.detail.scrollTop = Number.MAX_SAFE_INTEGER;

  dom.selectedSessionId = decision.selection;
  return dom;
}

function applyNaiveReplacement(_previous, next, _uiState, dom) {
  const selection = next.byId.has(dom.selectedSessionId)
    ? dom.selectedSessionId
    : (next.sessions[0]?.sessionId ?? null);

  dom.sessionList.replaceChildren(...next.sessions.map((session) => new ShimNode(session.sessionId)));

  // 负对照故意重建滚动容器和 turn 节点，且不从 uiState 套回 open/scrollTop。
  const replacementDetail = new ShimNode('detail-scroll');
  const selected = next.byId.get(selection);
  replacementDetail.replaceChildren(...(selected?.turns || []).map((turn) => new ShimNode(turn.vizTurnId)));

  return {
    sessionList: dom.sessionList,
    detail: replacementDetail,
    selectedSessionId: selection,
  };
}

function observeDomApplication(application) {
  const { previous, next } = makeUiViews();
  const selectedSessionId = 'codex-selected';
  const dom = initialDom(previous, selectedSessionId);
  const originalScrollTop = dom.detail.scrollTop;
  const uiState = {
    selectedSessionId,
    expanded: new Set(['vt-ui-1']),
    scrollTop: originalScrollTop,
    stickToBottom: false,
  };

  const result = application(previous, next, uiState, dom);
  return {
    A1: result.selectedSessionId === selectedSessionId,
    A2: result.detail.child('vt-ui-1')?.open === true,
    A3: result.detail.scrollTop === originalScrollTop,
  };
}

async function runDomShimTests() {
  // 预期表在运行前写死；若根据观察结果反向决定“该过还是该红”，负对照本身就会假绿。
  const expected = {
    real: { A1: true, A2: true, A3: true },
    naive: { A1: true, A2: false, A3: false },
  };
  const labels = {
    A1: '选中项 id 不变',
    A2: '已展开轮次仍 open',
    A3: 'scrollTop 不被重置',
  };

  const runs = [
    ['真实 reconcile + uiState 恢复层', applyRealReconcile, expected.real],
    ['朴素全量替换且不恢复 uiState', applyNaiveReplacement, expected.naive],
  ];

  for (const [implementationName, application, expectation] of runs) {
    const observed = observeDomApplication(application);
    for (const key of ['A1', 'A2', 'A3']) {
      // 两遍运行同一套可见行为断言；任一格不符合固定表都必须独立判红。
      assertCase(
        `${implementationName} ${key}：${labels[key]}（预期 ${expectation[key] ? '过' : '失败'}）`,
        observed[key] === expectation[key],
        `实际 ${observed[key]}`,
      );
    }
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function probeUrl(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    const response = await fetch(new URL('/', baseUrl), { signal: controller.signal });
    await response.arrayBuffer();
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startServe(vizDir) {
  const requestedPort = await reservePort();
  const reportedUrls = new Set();
  let output = '';

  const child = spawn(process.execPath, [SERVE_FILE, vizDir, String(requestedPort)], {
    cwd: VIZ,                       // serve.mjs 按自身位置找 index.html / reconcile.mjs
    env: {
      ...process.env,
      AGENT_BRIDGE_VIZ: 'on',
      AGENT_BRIDGE_VIZ_DIR: vizDir,
      VIZ_DIR: vizDir,
      PORT: String(requestedPort),
      VIZ_PORT: String(requestedPort),
      AGENT_BRIDGE_VIZ_PORT: String(requestedPort),
      NO_BROWSER: '1',
      NO_OPEN: '1',
      BROWSER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const capture = (chunk) => {
    const text = chunk.toString('utf8');
    output += text;
    for (const match of text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/g)) {
      reportedUrls.add(`http://127.0.0.1:${match[1]}`);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`serve.mjs 提前退出 code=${child.exitCode}: ${oneLine(output)}`);
    }

    const candidates = [
      `http://127.0.0.1:${requestedPort}`,
      ...reportedUrls,
    ];
    for (const baseUrl of new Set(candidates)) {
      if (await probeUrl(baseUrl)) return { child, baseUrl, output: () => output };
    }
    await delay(100);
  }

  child.kill();
  throw new Error(`serve.mjs 12 秒内未就绪: ${oneLine(output)}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function stopServe(child) {
  if (child.exitCode !== null) return;
  child.kill();
  if (!await waitForChildExit(child, 1500) && child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForChildExit(child, 1500);
  }
}

function parseSseBlock(raw) {
  const lines = raw.split('\n').filter((line) => line.length > 0);
  const eventLine = lines.find((line) => line.startsWith('event:'));
  if (!eventLine) return null;
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  const dataText = dataLines
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');

  let data = null;
  let parseError = null;
  try {
    data = JSON.parse(dataText);
  } catch (error) {
    parseError = error;
  }

  return {
    event: eventLine.slice(6).trim(),
    data,
    dataText,
    parseError,
    raw,
  };
}

async function collectSse(baseUrl, durationMs) {
  const controller = new AbortController();
  let abortedByTest = false;
  let ended = false;
  let response = null;
  const frames = [];
  const timer = setTimeout(() => {
    abortedByTest = true;
    controller.abort();
  }, durationMs);

  try {
    response = await fetch(new URL('/events', baseUrl), {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      ended = true;
      return { response, frames, ended };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseBlock(raw);
        if (frame) frames.push(frame);
      }
    }
  } catch (error) {
    if (!abortedByTest) throw error;
  } finally {
    clearTimeout(timer);
    if (!abortedByTest) controller.abort();
  }

  return { response, frames, ended };
}

function fileUrl(baseUrl, ref) {
  const url = new URL('/file', baseUrl);
  url.searchParams.set('ref', ref);
  return url;
}

async function fetchFile(baseUrl, ref) {
  const response = await fetch(fileUrl(baseUrl, ref));
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body };
}

async function createTransportFixture(vizDir) {
  const base = await readJson(path.join(SAMPLE_DIR, 'normal-completed-final-collected.json'));
  const snapshot = clone(base);
  const runId = 'mcp-transport-test';
  const sessionId = 'codex-transport-test';
  const inputText = 'transport input\n';
  const outputText = 'transport output\n';
  const inputBody = Buffer.from(inputText, 'utf8');
  const outputBody = Buffer.from(outputText, 'utf8');
  const now = new Date().toISOString();

  snapshot.runId = runId;
  snapshot.generation = 1;
  snapshot.updatedAt = now;
  snapshot.run.pid = process.pid;
  snapshot.run.startedAt = PROCESS_STARTED_AT;
  snapshot.run.bridgeVersion = 'test-viz';
  snapshot.run.status = 'running';
  snapshot.run.degraded = false;
  snapshot.run.recordingErrors = [];

  const session = snapshot.sessions[0];
  session.sessionId = sessionId;
  session.cwd = HERE;
  session.logFile = path.join(vizDir, 'transport.log');
  session.appendSystemPrompt = null;
  session.backendPid = process.pid;
  session.status = 'idle';
  session.health = 'healthy';
  session.updatedAt = now;

  const turn = session.turns[0];
  turn.vizTurnId = 'vt-transport-1';
  turn.input = {
    state: 'ready',
    ref: `turns/${sessionId}/t1.in.md`,
    sha256: sha256(inputBody),
    chars: inputText.length,
    bytes: inputBody.length,
    truncated: false,
    originalBytes: inputBody.length,
    error: null,
  };
  turn.output = {
    state: 'ready',
    ref: `turns/${sessionId}/t1.out.md`,
    sha256: sha256(outputBody),
    chars: outputText.length,
    bytes: outputBody.length,
    previewBytes: null,
    previewSha256: null,
    error: null,
  };

  const turnDir = path.join(vizDir, 'turns', sessionId);
  await mkdir(turnDir, { recursive: true });
  await writeFile(path.join(turnDir, 't1.in.md'), inputBody);
  const outputPath = path.join(turnDir, 't1.out.md');
  await writeFile(outputPath, outputBody);
  await mkdir(path.join(turnDir, 'directory-target'));

  await writeJson(path.join(vizDir, 'meta.json'), makeMeta(runId));
  await writeJson(path.join(vizDir, 'owner'), {
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
  });

  const stateRaw = JSON.stringify(snapshot);
  await writeFile(path.join(vizDir, 'state.0.json'), stateRaw, 'utf8');
  await writeFile(path.join(vizDir, 'state.1.json'), '{broken-json', 'utf8');

  return {
    runId,
    sessionId,
    snapshot,
    stateRaw,
    outputBody,
    outputPath,
  };
}

async function runTransportTests() {
  await withTempVizDir(async (vizDir) => {
    const fixture = await createTransportFixture(vizDir);

    // 真服务测试前先由独立校验器证明夹具本身合法，避免服务红灯其实来自自造坏快照。
    const fixtureCheck = checkVizDir(vizDir);
    assertCase(
      '传输夹具通过独立目录校验',
      fixtureCheck.chosen === 'state.0.json' && fixtureCheck.violations.length === 0,
      JSON.stringify(fixtureCheck),
    );

    const service = await startServe(vizDir);
    try {
      const first = await collectSse(service.baseUrl, 1000);
      const firstHeaders = first.response?.headers;

      // EventSource 依赖正确媒体类型；缺它时代理或浏览器可能按普通下载处理。
      assertCase(
        '/events Content-Type 是 text/event-stream',
        firstHeaders?.get('content-type')?.toLowerCase().startsWith('text/event-stream') === true,
        firstHeaders?.get('content-type'),
      );
      // SSE 不得被缓存，否则重连可能拿到旧快照而非当前态。
      assertCase(
        '/events Cache-Control 含 no-cache',
        firstHeaders?.get('cache-control')?.toLowerCase().includes('no-cache') === true,
        firstHeaders?.get('cache-control'),
      );
      // 反向代理缓冲会把实时帧攒成批次，必须显式关闭。
      assertCase(
        '/events X-Accel-Buffering=no',
        firstHeaders?.get('x-accel-buffering')?.toLowerCase() === 'no',
        firstHeaders?.get('x-accel-buffering'),
      );
      // keep-alive 是长连接合同的一部分，缺失时空闲期可能被当普通响应关闭。
      assertCase(
        '/events Connection 含 keep-alive',
        firstHeaders?.get('connection')?.toLowerCase().includes('keep-alive') === true,
        firstHeaders?.get('connection'),
      );

      const helloIndex = first.frames.findIndex((frame) => frame.event === 'hello');
      const stateIndex = first.frames.findIndex((frame) => frame.event === 'state');
      const hello = first.frames[helloIndex];
      const state = first.frames[stateIndex];

      // hello 建立协议与目录身份；state 抢先会让页面在不知道 run 身份时消费快照。
      assertCase(
        'SSE hello 先于首个 state',
        helloIndex >= 0 && stateIndex > helloIndex,
        first.frames.map((frame) => frame.event).join(','),
      );
      // runId 与 vizDir 是页面区分 run 和定位逃生目录的唯一握手信息。
      assertCase(
        'SSE hello 带正确 runId 与 vizDir',
        hello?.data?.runId === fixture.runId
          && path.resolve(hello?.data?.vizDir || '') === path.resolve(vizDir),
        JSON.stringify(hello?.data),
      );
      // 帧必须保持 event/data 两行形状；解析器宽容不代表 wire 可以悄悄加第三种信封。
      assertCase(
        'SSE 首帧使用 event/data 两行格式',
        first.frames.slice(0, 2).every((frame) => {
          const lines = frame.raw.split('\n').filter(Boolean);
          return lines.length === 2
            && lines[0].startsWith('event:')
            && lines[1].startsWith('data:');
        }),
      );
      // viewer 只能搬运槽文件；重新序列化会在校验器与页面之间制造未定义的新对象。
      assertCase(
        'SSE state 原样透传当前槽文本',
        state?.dataText === fixture.stateRaw,
        `收到长度 ${state?.dataText?.length}，槽长度 ${fixture.stateRaw.length}`,
      );

      const generation2 = clone(fixture.snapshot);
      generation2.generation = 2;
      generation2.updatedAt = new Date().toISOString();
      const generation2Raw = JSON.stringify(generation2);
      await writeFile(path.join(vizDir, 'state.1.json'), generation2Raw, 'utf8');
      await delay(300);

      const reconnected = await collectSse(service.baseUrl, 1000);
      const reconnectStates = reconnected.frames.filter((frame) => frame.event === 'state');
      // 快照是全量当前态；重放 generation 1 会把页面倒退并重新制造事件日志语义。
      assertCase(
        'SSE 重连只发当前态且不回放历史',
        reconnected.frames[0]?.event === 'hello'
          && reconnectStates.length === 1
          && reconnectStates[0]?.data?.generation === 2
          && !reconnectStates.some((frame) => frame.data?.generation === 1),
        reconnected.frames.map((frame) => `${frame.event}:${frame.data?.generation ?? ''}`).join(','),
      );

      await writeFile(path.join(vizDir, 'state.0.json'), '{broken-zero', 'utf8');
      await writeFile(path.join(vizDir, 'state.1.json'), '{broken-one', 'utf8');
      const historyFailure = await collectSse(service.baseUrl, 1600);
      const controls = historyFailure.frames.filter((frame) => frame.event === 'control');

      // owner 活着时双槽暂时不可读是可重试的读取故障，不能静默保留旧态。
      assertCase(
        '双槽不可读且 owner 存活时发送 history-read-failure',
        controls.some((frame) => frame.data?.kind === 'history-read-failure'),
        controls.map((frame) => JSON.stringify(frame.data)).join(','),
      );
      // run.degraded 只描述 writer 已发布的缺页事实，不能被 viewer 的瞬时读取失败伪造。
      assertCase(
        'history-read-failure 不冒充 run.degraded',
        !historyFailure.frames.some((frame) => frame.event === 'state' && frame.data?.run?.degraded === true),
      );
      // 读取失败后仍要继续重试；主动断 SSE 会把同一故障误报成连接层问题。
      assertCase(
        'history-read-failure 不导致 SSE 断连',
        historyFailure.response !== null && historyFailure.ended === false,
      );
      // run-gone 会把 dispatched 合成为 abandoned；误发它会把可恢复历史永久封成终态。
      assertCase(
        'history-read-failure 不冒充 run-gone',
        !controls.some((frame) => frame.data?.kind === 'run-gone'),
      );

      // ── 从「暂时读不到」恢复，**且 generation 没有推进** ──
      //
      // 这是最常见的形态：瞬时 IO 抖动，快照本身根本没变过。
      // 页面上那句「暂时读不到」的唯一清除信号是下一帧 state，而 pollState 有一道
      // `generation <= lastGeneration 就不发` 的去重闸。只清内部标志、不重发的实现，
      // 会让页面**永久**停在那句话上 —— 而记录一直好端端地在那儿。
      // 判别式必须在**同一条连接**上做：新连接本来就会收到当前态，测不出这件事。
      const recovering = collectSse(service.baseUrl, 2600);
      await delay(700);
      await writeFile(path.join(vizDir, 'state.1.json'), generation2Raw, 'utf8');
      await writeFile(path.join(vizDir, 'state.0.json'), fixture.stateRaw, 'utf8');
      const recovered = await recovering;
      const recoveredStates = recovered.frames.filter((f) => f.event === 'state');
      assertCase(
        '★ 同代恢复后向已连接的客户端重发 state（否则「暂时读不到」永远清不掉）',
        recoveredStates.length >= 2
          && recoveredStates[recoveredStates.length - 1]?.data?.generation === 2,
        recovered.frames.map((f) => `${f.event}:${f.data?.generation ?? f.data?.kind ?? ''}`).join(','),
      );

      const lexical = await fetchFile(service.baseUrl, 'turns/bad name.md');
      // 非白名单字符应在任何路径解析前拒绝，避免错误输入触碰文件系统。
      assertCase('/file 词法非法 ref → 400', lexical.response.status === 400, lexical.response.status);

      const parentEscape = await fetchFile(service.baseUrl, '../outside.md');
      // 父目录段是明确的越界企图；若被当普通 404，调用方无法区分拒绝与缺失。
      assertCase('/file 父目录越界 ref → 400（词法阶段就拒，不碰文件系统）', parentEscape.response.status === 400, parentEscape.response.status);

      const absoluteEscape = await fetchFile(service.baseUrl, '/outside.md');
      // 绝对路径绕过 VIZ_DIR 锚点，必须与其他越界企图同样拒绝。
      assertCase('/file 绝对路径 ref → 400（同上）', absoluteEscape.response.status === 400, absoluteEscape.response.status);

      const directory = await fetchFile(
        service.baseUrl,
        `turns/${fixture.sessionId}/directory-target`,
      );
      // 目录不是正文资产；允许读取会泄露目录列表语义并破坏短开短关边界。
      assertCase('/file 目录目标 → 403', directory.response.status === 403, directory.response.status);

      const missing = await fetchFile(
        service.baseUrl,
        `turns/${fixture.sessionId}/does-not-exist.md`,
      );
      // 合法且未越界但不存在必须是 404，不能与安全拒绝混成同一状态。
      assertCase('/file 不存在目标 → 404', missing.response.status === 404, missing.response.status);

      const original = await fetchFile(service.baseUrl, fixture.snapshot.sessions[0].turns[0].output.ref);
      const originalHeader = original.response.headers.get('x-viz-sha256');
      // 头必须对响应体现场计算；复用快照摘要会漏掉落盘后的篡改。
      assertCase(
        '/file X-Viz-Sha256 与响应体实时摘要一致',
        original.response.status === 200 && originalHeader === sha256(original.body),
        `status=${original.response.status} header=${originalHeader}`,
      );
      // nosniff 阻止正文被浏览器按可执行内容猜型，是本地服务也不能省的边界。
      assertCase(
        '/file 带 X-Content-Type-Options=nosniff',
        original.response.headers.get('x-content-type-options')?.toLowerCase() === 'nosniff',
        original.response.headers.get('x-content-type-options'),
      );

      const tamperedBytes = Buffer.from(fixture.outputBody);
      tamperedBytes[0] ^= 1;
      await writeFile(fixture.outputPath, tamperedBytes);
      const tampered = await fetchFile(service.baseUrl, fixture.snapshot.sessions[0].turns[0].output.ref);
      const tamperedHeader = tampered.response.headers.get('x-viz-sha256');
      const recordedSha = fixture.snapshot.sessions[0].turns[0].output.sha256;
      // 改一个字节后实时头仍须忠于当前文件、同时不再等于快照指纹，页面才有证据标“文件被改动”。
      assertCase(
        '篡改负对照：实时 SHA 与快照 output.sha256 不再相等',
        tampered.response.status === 200
          && tamperedHeader === sha256(tampered.body)
          && tamperedHeader !== recordedSha,
        `status=${tampered.response.status} live=${tamperedHeader} recorded=${recordedSha}`,
      );
    } finally {
      await stopServe(service.child);
    }
  });
}

// ── 第四组之二：选槽的稳健性（每种都用一个**全新的** serve 进程考） ───────────
//
// 必须新起进程：一个跑过的 serve 手上有 `lastStateRaw`，那份陈旧快照会替它兜底，
// 于是「选不出槽」这件事根本表现不出来 —— 用例会因为兜底而变绿。
async function runSlotRobustnessTests() {
  // ① 空壳槽 generation 更高时，**不得**顶掉旁边那份完好的快照。
  //    这正是双槽协议存在的理由：另一个槽好端端的，不该因为判据太浅而落选。
  await withTempVizDir(async (vizDir) => {
    const fixture = await createTransportFixture(vizDir);
    const good = clone(fixture.snapshot);
    good.generation = 5;
    await writeFile(path.join(vizDir, 'state.0.json'), JSON.stringify(good), 'utf8');
    await writeFile(path.join(vizDir, 'state.1.json'), JSON.stringify({
      schemaVersion: 1, runId: fixture.runId, generation: 9,
      updatedAt: new Date().toISOString(), run: {}, sessions: [],
    }), 'utf8');

    const service = await startServe(vizDir);
    try {
      const seen = await collectSse(service.baseUrl, 1200);
      const states = seen.frames.filter((f) => f.event === 'state');
      assertCase(
        '★ 空壳槽（generation 更高但必填结构不全）不得胜出',
        states.length >= 1 && states.every((f) => f.data?.generation === 5),
        seen.frames.map((f) => `${f.event}:${f.data?.generation ?? f.data?.kind ?? ''}`).join(','),
      );
    } finally {
      await stopServe(service.child);
    }
  });

  // ② 两槽 generation 相等 ⇒ **双方都不可信**，不许静默择一。
  //    健康 run 到不了这个状态（写成功才推进代次并换槽），真出现就说明有东西在乱写 ——
  //    而这恰恰是最不该「挑一份看着像的展示出来」的时刻。
  await withTempVizDir(async (vizDir) => {
    const fixture = await createTransportFixture(vizDir);
    const a = clone(fixture.snapshot); a.generation = 7;
    const b = clone(fixture.snapshot); b.generation = 7;
    b.updatedAt = new Date(Date.now() + 1000).toISOString();
    await writeFile(path.join(vizDir, 'state.0.json'), JSON.stringify(a), 'utf8');
    await writeFile(path.join(vizDir, 'state.1.json'), JSON.stringify(b), 'utf8');

    const service = await startServe(vizDir);
    try {
      const seen = await collectSse(service.baseUrl, 1600);
      const states = seen.frames.filter((f) => f.event === 'state');
      const controls = seen.frames.filter((f) => f.event === 'control');
      assertCase(
        '★ 两槽同代时判双方不可信：不发 state',
        states.length === 0,
        seen.frames.map((f) => `${f.event}:${f.data?.generation ?? f.data?.kind ?? ''}`).join(','),
      );
      assertCase(
        '两槽同代时如实说「暂时读不到」，而不是冒充 run-gone',
        controls.some((f) => f.data?.kind === 'history-read-failure')
          && !controls.some((f) => f.data?.kind === 'run-gone'),
        controls.map((f) => JSON.stringify(f.data)).join(','),
      );
    } finally {
      await stopServe(service.child);
    }
  });

  // ③ **run 真的没了 ⇒ 必须发 run-gone。** 原先只考了它的反面(「暂时读不到」不许冒充 run-gone),
  //    正面从来没人考 —— 于是把 serve 里那条广播删掉,没有任何断言会红,
  //    而页面会在 run 结束之后一直挂着「仍在运行」的旧态,等一个永远不会来的下一帧。
  //    触发方式就是真实场景本身:桥干净退出时会把整个目录删掉(里面是全量委托明文)。
  await withTempVizDir(async (vizDir) => {
    await createTransportFixture(vizDir);
    const service = await startServe(vizDir);
    try {
      // 判别式必须在**同一条连接**上做:新连接靠 replayFor 补发,测不出"当场广播"这件事。
      const watching = collectSse(service.baseUrl, 2600);
      await delay(600);
      await rm(vizDir, { recursive: true, force: true });   // ← run 没了
      const seen = await watching;
      const controls = seen.frames.filter((f) => f.event === 'control');
      assertCase(
        '★ 目录消失(桥干净退出)⇒ 向已连接的客户端广播 run-gone',
        controls.some((f) => f.data?.kind === 'run-gone'),
        seen.frames.map((f) => `${f.event}:${f.data?.generation ?? f.data?.kind ?? ''}`).join(','),
      );
      // 这两件事不是一回事:run-gone 是终态(记录没了),history-read-failure 是可重试的读取故障。
      // 反过来发就会让页面把一份还在的记录当成已清除。
      assertCase(
        'run 没了的时候不许说成「暂时读不到」',
        !controls.some((f) => f.data?.kind === 'history-read-failure'),
        controls.map((f) => JSON.stringify(f.data)).join(','),
      );
    } finally {
      await stopServe(service.child);
    }
  });


  // ④ **悬空 ref:快照说有正文,盘上却没有那个文件。**
  //    这是 §4.9 蕴含式 4(ref 非 null ⟹ 该文件存在且可读)的负例,而它**只在目录层可观察** ——
  //    冻结样例走的是纯对象校验,`materializeRefs` 还会自动把引用的文件都造出来,
  //    所以那条规则从来没被任何用例真正考过:把 `checkReadableRef` 整段删掉,全绿。
  //    这条规则守的是页面上最难查的一种错:卡片说「有产出、这是它的指纹」,点开却什么都没有。
  await withTempVizDir(async (vizDir) => {
    const fixture = await createTransportFixture(vizDir);
    const before = checkVizDir(vizDir);
    assertCase(
      '悬空 ref 用例的前提:动手之前这个目录是干净的',
      before.violations.length === 0,
      JSON.stringify(before.violations),
    );
    // 只删文件,快照一个字不改 —— 于是 ref/sha256/bytes 全都还在,唯一的差别是文件没了。
    await rm(fixture.outputPath, { force: true });
    const after = checkVizDir(vizDir);
    assertCase(
      '★ 快照说有正文而文件不在 ⇒ 独立校验器必须判违规(不许有悬空 ref)',
      after.violations.some((v) => /不存在或不可读/.test(v)),
      JSON.stringify(after.violations),
    );
  });

}

// ── 第五组：适配层的正文缓存（这一组是被一个真 bug 逼出来的） ─────────────────
//
// 正文是异步从 /file 取的。**取回来必须重建模型，不能只重画 DOM**——
// 占位符是烘在展示模型里的字符串，光重画只会把同一个占位符再画一遍。
// 这个 bug 在页面里查不出来：没有任何东西能单独喂它一份「缓存从空到满」的输入。
// 适配层从 index.html 搬进 reconcile.mjs 之后，它就只是两次纯函数调用的差。
async function runAdapterBodyTests() {
  const { adaptSnapshot, refsOf, BODY_PLACEHOLDER } = await import('../skills/agent-bridge/viz/reconcile.mjs');
  const IN_REF = 'turns/codex-a-b/t1.in.md';
  const OUT_REF = 'turns/codex-a-b/t1.out.md';
  const snap = {
    schemaVersion: 1, runId: 'mcp-x', generation: 1, updatedAt: '2026-07-29T00:00:00.000Z',
    run: { pid: 1, bridgeVersion: 't', startedAt: '2026-07-29T00:00:00.000Z',
           status: 'running', degraded: false, recordingErrors: [] },
    sessions: [{
      sessionId: 'codex-a-b', name: null, agent: 'codex', model: null, effort: null,
      access: 'read', cwd: 'D:\\x', returnMode: 'full', logFile: null,
      appendSystemPrompt: null, backendPid: null, status: 'idle', health: 'healthy',
      isStreaming: false, contextUsage: null,
      createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:00.000Z',
      openFailed: null, closed: null,
      turns: [{
        turnNo: 1, vizTurnId: 'vt-1', backendTurnId: null, backendTurnCount: null,
        state: 'settled', boundary: 'turn_start_ack',
        attemptedAt: '2026-07-29T00:00:00.000Z', dispatchedAt: '2026-07-29T00:00:00.000Z',
        settledAt: '2026-07-29T00:00:10.000Z', firstBackendEventAt: null,
        source: 'send_message', blocking: false, hasSchema: false,
        input: { state: 'ready', ref: IN_REF, sha256: 'a'.repeat(64),
                 chars: 4, bytes: 12, truncated: false, originalBytes: 12, error: null },
        output: { state: 'ready', ref: OUT_REF, sha256: 'b'.repeat(64),
                  chars: 4, bytes: 12, previewBytes: null, previewSha256: null, error: null },
        outcome: 'completed', bodyKind: 'final', generationCount: 1,
        collected: null, error: null, durationMs: 10000,
      }],
    }],
  };

  const refs = refsOf(snap);
  assertCase('refsOf 找出输入与输出两个 ref', refs.length === 2, JSON.stringify(refs.map(r => r.ref)));
  assertCase('refsOf 带上了用于对证的 sha256', refs.every(r => /^[0-9a-f]{64}$/.test(r.sha256)));
  // 超限正文只发得出前缀，那时唯一能对证的就是前缀指纹——不带出来，页面只能在
  // 「拿前缀对全文（必然误报篡改）」和「干脆不验」之间二选一。
  assertCase('refsOf 把 output 的 previewSha256 一并带出（截断响应的唯一对证依据）',
    refs.some(r => r.ref === OUT_REF && 'previewSha256' in r), JSON.stringify(refs));

  // ① 缓存为空 → 占位符
  const t0 = adaptSnapshot(snap, { bodyCache: new Map() })[0].turns[0];
  assertCase('缓存为空时是占位符',
    t0.input.text === BODY_PLACEHOLDER && t0.output.md === BODY_PLACEHOLDER,
    JSON.stringify({ i: t0.input.text, o: t0.output.md }));
  assertCase('缓存为空时两个方向都不可复制（不许把占位符当原文交出去）',
    t0.input.copyable === false && t0.output.copyable === false);

  // ② 缓存填上 → **同一份快照必须产出不同的模型**。
  //    这一条就是那个 bug 的判别式：只重画 DOM、不重建模型的实现在这里过不去。
  const cache = new Map([[IN_REF, { text: '问题原文' }], [OUT_REF, { text: '回答正文' }]]);
  const t1 = adaptSnapshot(snap, { bodyCache: cache })[0].turns[0];
  assertCase('★ 缓存填上后同一份快照产出真正文（不再是占位符）',
    t1.input.text === '问题原文' && t1.output.md === '回答正文',
    JSON.stringify({ i: t1.input.text, o: t1.output.md }));
  assertCase('缓存填上后两个方向都可复制',
    t1.input.copyable === true && t1.output.copyable === true);

  // ③ 指纹对不上 → **绝不照常展示**（否则页面等于替一份被篡改的内容背书）
  const tampered = new Map([[IN_REF, { text: '问题原文' }], [OUT_REF, { tamper: true }]]);
  const t2 = adaptSnapshot(snap, { bodyCache: tampered })[0].turns[0];
  assertCase('★ 指纹对不上时拒绝展示内容并说明原因',
    /被改动过/.test(t2.output.md) && t2.output.md.indexOf('回答正文') < 0, t2.output.md);

  // ④ 读失败 → 说清是「读不到」，不是「没有」
  const t3 = adaptSnapshot(snap, { bodyCache: new Map([[OUT_REF, { error: 'HTTP 500' }]]) })[0].turns[0];
  assertCase('读失败时如实说读失败（区别于「这轮没有输出」）', /读取失败/.test(t3.output.md), t3.output.md);

  // ⑤ 复制资格**按方向各判各的**。
  //    共用一个轮次级布尔量会同时错两次，下面两条就是那两次。

  // ⑤-a 输出还在路上，不该连累已经验过的输入。
  const halfLoaded = new Map([[IN_REF, { text: '问题原文' }]]);
  const t4 = adaptSnapshot(snap, { bodyCache: halfLoaded })[0].turns[0];
  assertCase('★ 输出未就绪时，已验过的输入仍可复制（两个方向不共用一个判据）',
    t4.input.copyable === true && t4.output.copyable === false,
    JSON.stringify({ i: t4.input.copyable, o: t4.output.copyable }));

  // ⑤-b 输入压根没落盘（写失败 → missing / ref=null）时**必须禁用**。
  //     这里最危险：没有任何"待取"可言，轮次级判据看不到异常，按钮照常可点，
  //     复制出一个空串——而用户以为自己留档了当时发出去的 prompt。
  const noInput = JSON.parse(JSON.stringify(snap));
  noInput.sessions[0].turns[0].input = {
    state: 'missing', ref: null, sha256: null, chars: null, bytes: null,
    truncated: false, originalBytes: null, error: 'write_failed',
  };
  noInput.run.degraded = true;
  noInput.run.recordingErrors = ['write_failed'];
  const t5 = adaptSnapshot(noInput, { bodyCache: cache })[0].turns[0];
  assertCase('★ 输入没落盘时禁止复制（否则交出去的是一个空串）',
    t5.input.copyable === false, JSON.stringify(t5.input));
  assertCase('输入没落盘时说的是「没留存」，不是「正在读取」',
    t5.input.text !== BODY_PLACEHOLDER && /没有留存/.test(t5.input.text), t5.input.text);

  // ⑤-c 只拿到传输截断前缀时，"复制原文"就不该把残件交出去。
  const cappedCache = new Map([
    [IN_REF, { text: '问题原文' }],
    [OUT_REF, { text: '前 8 MB…', truncated: true, fullBytes: 9 * 1024 * 1024 }],
  ]);
  const t6 = adaptSnapshot(snap, { bodyCache: cappedCache })[0].turns[0];
  assertCase('★ 截断前缀不算原文，禁止复制', t6.output.copyable === false);
  assertCase('截断时页面仍要给出「完整件在哪」', !!t6.output.capped, JSON.stringify(t6.output.capped));

  // ⑤-d 无法对证（缺前缀指纹）与「对不上」是两回事，说法必须分开、且都不可复制。
  const t7 = adaptSnapshot(snap, {
    bodyCache: new Map([[IN_REF, { text: '问题原文' }], [OUT_REF, { unverified: true }]]),
  })[0].turns[0];
  assertCase('无法对证时拒绝展示且禁止复制',
    /无法对证/.test(t7.output.md) && t7.output.copyable === false, t7.output.md);

  // ⑥ 纯函数：同输入必得同输出（它不该有记忆——瞬态属于页面层）
  const a = adaptSnapshot(snap, { bodyCache: cache, now: 1 });
  const b = adaptSnapshot(snap, { bodyCache: cache, now: 1 });
  assertCase('adaptSnapshot 是纯函数（同输入同输出）', JSON.stringify(a) === JSON.stringify(b));
}

async function main() {
  await runSection('第一组：冻结样例与双槽选择', async () => {
    await runFrozenCorpusTests();
    await runSlotSelectionTests();
  });
  await runSection('第二组：reconcile DOM shim 自动负对照', runDomShimTests);
  await runSection('第三组：展示映射', runDisplayMappingTests);
  await runSection('第四组：真实 serve.mjs 传输层', runTransportTests);
  await runSection('第四组之二：选槽稳健性', runSlotRobustnessTests);
  await runSection('第五组：适配层的正文缓存', runAdapterBodyTests);
}

try {
  await main();
} catch (error) {
  assertCase('测试运行器顶层异常', false, error?.stack || error);
}

console.log(`总计 ${passed + failed} 条：通过 ${passed}，失败 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
