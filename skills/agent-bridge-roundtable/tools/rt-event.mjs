#!/usr/bin/env node
// Agent Roundtable — 通用事件追加器(零依赖,仅 Node 内建)
//
// 把主席手工的 "算 seq + 组信封 + append transcript.jsonl" 收成一条命令,
// 并导出 appendEvents() 供 seat-turn.mjs 复用(单一 append 实现,避免 seq 逻辑在两脚本间漂移)。
//
// 用法:
//   node rt-event.mjs <run-dir> <event> <round>     # payload 从 stdin 读 JSON(空 stdin = {})
//   node rt-event.mjs <run-dir> --batch             # stdin 每行一个 {event,round,payload},批量 append
//
// 契约(与 EVENTS.md 一致,schema 不变):
//   - 每行信封 {v:1, seq, ts, event, rtId, round, payload};seq 单调递增(读现有 max+1),ts=epoch ms。
//   - rtId 从 run-dir 目录名推导(basename),不再要求主席传。
//   - **单 writer = 主席**:内建目录锁(<run-dir>/.transcript.lock)串行化并发调用,防 seq 竞争。
//   - 半行安全:读现有 transcript 求 max seq 时,忽略无换行结尾的不完整末行(不 JSON.parse 半行)。
//   - 只 append,绝不改写既有行。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_V = 1;
const LOCK_TIMEOUT_MS = 5000;   // 拿锁上限;单 writer 下几乎不竞争,超时=有异常并发,报错好过静默错乱
const LOCK_RETRY_MS = 25;

function sleepSync(ms) {
  // 零依赖同步睡眠(不引入 async);SharedArrayBuffer + Atomics.wait 是标准做法
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const t = Date.now(); while (Date.now() - t < ms) { /* Atomics 不可用时的忙等兜底 */ } }
}

// 目录锁:mkdir 是跨平台原子操作,存在即失败 → 天然互斥
function withLock(runDir, fn) {
  const lockDir = path.join(runDir, ".transcript.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`拿 transcript 锁超时(${LOCK_TIMEOUT_MS}ms):可能有并发 writer,或残留锁 ${lockDir}(确认无并发后手动删)`);
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(lockDir); } catch { /* best-effort */ } }
}

// 读现有 transcript 的最大 seq;不存在或空 → -1(下一个从 0 起)。
// 逐行 parse:合法行(**含末尾无 \n 但内容完整的行**)计入 seq;不可解析行(崩溃半行/整行损坏)跳过并告警。
// 不按"有无末尾换行"盲丢末行——那会漏掉合法的无换行末行,令下一个 seq 与其重复(append 又补 \n 后二者同 seq)。
function readMaxSeq(transcript) {
  let content;
  try { content = fs.readFileSync(transcript, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return -1; throw e; }
  if (!content) return -1;
  let max = -1;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue; // 空行(含 \n 结尾产生的末尾空串)
    try {
      const o = JSON.parse(s);
      if (Number.isInteger(o.seq) && o.seq > max) max = o.seq;
    } catch {
      // 整行损坏或崩溃残留的半行:不计入 seq,并告警(静默会埋 seq 重用的雷)
      process.stderr.write(`[rt-event] 警告:transcript 第 ${i + 1} 行无法解析,已跳过(不计入 seq):${s.slice(0, 80)}\n`);
    }
  }
  return max;
}

function validateRecord(r, i) {
  if (!r || typeof r !== "object") throw new Error(`record[${i}] 不是对象`);
  if (typeof r.event !== "string" || !r.event) throw new Error(`record[${i}].event 必须是非空字符串`);
  if (!Number.isFinite(r.round)) throw new Error(`record[${i}].round 必须是数字(不属于任何轮用 -1)`);
  if (r.payload == null || typeof r.payload !== "object") throw new Error(`record[${i}].payload 必须是对象`);
}

/**
 * 追加一批事件到 <run-dir>/transcript.jsonl。持锁 → 读 max seq → 逐条组信封 append。
 * @param {string} runDir 圆桌 run-dir(含 transcript.jsonl;rtId=basename)
 * @param {Array<{event:string,round:number,payload:object}>} records
 * @returns {Array<object>} 落盘的信封对象(含分配的 seq/ts/rtId)
 */
export function appendEvents(runDir, records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("records 为空");
  records.forEach(validateRecord);
  const resolved = path.resolve(runDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`run-dir 不存在或不是目录: ${resolved}`);
  const rtId = path.basename(resolved);
  const transcript = path.join(resolved, "transcript.jsonl");
  return withLock(resolved, () => {
    let seq = readMaxSeq(transcript) + 1;
    const ts = Date.now();
    const envelopes = records.map((r) => ({
      v: SCHEMA_V, seq: seq++, ts, event: r.event, rtId, round: r.round, payload: r.payload,
    }));
    // 若前一 writer 崩溃残留无换行的半行,先补 \n 终止它(否则新事件会粘到半行上 → 双双损坏)
    let prefix = "";
    try {
      const st = fs.statSync(transcript);
      if (st.size > 0) {
        const fd = fs.openSync(transcript, "r");
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        fs.closeSync(fd);
        if (b[0] !== 0x0a) prefix = "\n";
      }
    } catch { /* 文件不存在等:无需前缀 */ }
    fs.appendFileSync(transcript, prefix + envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return envelopes;
  });
}

// ---- CLI ----
function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
function die(msg) { process.stderr.write(`[rt-event] ${msg}\n`); process.exit(1); }

function main(argv) {
  const runDir = argv[0];
  if (!runDir) die("缺少 <run-dir>。用法见文件头。");
  let records;
  if (argv[1] === "--batch") {
    const raw = readStdin().trim();
    if (!raw) die("--batch 需要 stdin(每行一个 {event,round,payload})");
    records = raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
      try { return JSON.parse(l); } catch { die(`--batch 第 ${i + 1} 行不是合法 JSON`); }
    });
  } else {
    const event = argv[1], round = argv[2];
    if (!event || round === undefined) die("用法: node rt-event.mjs <run-dir> <event> <round>  (payload 从 stdin)");
    const raw = readStdin().trim();
    let payload = {};
    if (raw) { try { payload = JSON.parse(raw); } catch { die("stdin payload 不是合法 JSON"); } }
    records = [{ event, round: Number(round), payload }];
  }
  let out;
  try { out = appendEvents(runDir, records); }
  catch (e) { die(e.message); }
  process.stdout.write(`appended ${out.length} event(s): seq ${out[0].seq}..${out[out.length - 1].seq}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
