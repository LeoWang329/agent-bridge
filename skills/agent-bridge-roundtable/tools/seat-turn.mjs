#!/usr/bin/env node
// Agent Roundtable — 收口一个席位一轮次(零依赖,仅 Node 内建)
//
// 一条命令替代主席现在的 3 次机械动作(cp textRef → 泄漏扫描 → append turn:produced):
//
//   node seat-turn.mjs <run-dir> \
//     --seat p1 --round 0 \
//     --text-ref "<桥返回的 textRef 绝对路径>" \
//     --agent omp --model deepseek/deepseek-v4-pro \
//     --summary "主席一句话摘要" \
//     [--extra-names "MiniMax-M3,glm"]     # 本场在座模型名,并入泄漏黑名单
//
// 行为:
//   1. cp textRef → <run-dir>/rounds/<seat>-r<round>.md(字节直传,fs.copyFileSync,0 改写);
//   2. 泄漏扫描:内置厂商黑名单 + --extra-names,**整词、大小写不敏感、按文本读**(等效 grep -aiwE);
//      命中 → 打印命中行 + **exit 2**(不删不改,主席决定点状处理);干净 → 继续;
//   3. append turn:produced 事件(自动算 seq/ts/charCount;复用 rt-event.mjs 的 appendEvents,含目录锁)。
//
// exit code:0=成功;1=用法/IO 错;2=检测到身份泄漏(需主席处理后重跑或点状遮盖)。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendEvents } from "./rt-event.mjs";

// 常见厂商/商品名黑名单(整词匹配)。**不含桥后端名 "omp"**——那是后端标识、席位不会自称它,且易误伤正文。
const VENDOR_BLACKLIST = [
  "claude", "opus", "sonnet", "gpt", "chatgpt", "deepseek", "gemini", "qwen",
  "anthropic", "openai", "minimax", "kimi", "codex", "glm", "zhipu",
];

function die(msg, code = 1) { process.stderr.write(`[seat-turn] ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) die(`--${key} 缺少值`);
      out[key] = val; i++;
    } else out._.push(a);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 整词、大小写不敏感扫描;返回命中行 [{line, text, terms:[...]}]
function scanLeaks(content, terms) {
  const re = new RegExp(`\\b(?:${terms.map(escapeRe).join("|")})\\b`, "gi");
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matched = lines[i].match(re);
    if (matched) hits.push({ line: i + 1, text: lines[i], terms: [...new Set(matched.map((m) => m.toLowerCase()))] });
  }
  return hits;
}

function main(argv) {
  const args = parseArgs(argv);
  const runDir = args._[0];
  if (!runDir) die("缺少 <run-dir>。用法见文件头。");
  const { seat, round, "text-ref": textRef, agent, model, summary } = args;
  if (!seat) die("缺少 --seat(如 p1)");
  if (round === undefined) die("缺少 --round(如 0)");
  if (!textRef) die("缺少 --text-ref(桥返回的 textRef 绝对路径)");
  if (!agent) die("缺少 --agent(如 omp/codex/claude)");
  // 校验 seat/round:二者直接拼进文件路径与 roundRef,必须挡目录穿越/非法名(如 ../x、p1/sub)
  if (!/^p\d+$/.test(seat)) die(`--seat 必须形如 p<数字>(如 p1),收到: ${seat}`);
  const roundNum = Number(round);
  if (!Number.isInteger(roundNum) || roundNum < 0) die(`--round 必须是非负整数,收到: ${round}`);

  const resolvedRun = path.resolve(runDir);
  if (!fs.existsSync(resolvedRun) || !fs.statSync(resolvedRun).isDirectory()) die(`run-dir 不存在或不是目录: ${resolvedRun}`);
  if (!fs.existsSync(textRef) || !fs.statSync(textRef).isFile()) die(`--text-ref 不存在或不是文件: ${textRef}`);

  const roundRefRel = `rounds/${seat}-r${roundNum}.md`;

  // 1. 先扫描源(textRef),命中泄漏就此中止——不 cp,rounds/ 保持原样(让"exit 2 不改文件"真正成立;
  //    cp 是字节直传,扫源 === 扫落盘成品)。
  const content = fs.readFileSync(textRef, "utf8");
  const extra = (args["extra-names"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const terms = [...VENDOR_BLACKLIST, ...extra];
  const hits = scanLeaks(content, terms);
  if (hits.length) {
    process.stderr.write(`[seat-turn] 泄漏扫描命中 ${hits.length} 行,已中止(未写 ${roundRefRel};源文件 ${textRef} 未改;请主席让该席重述或点状遮盖后重跑):\n`);
    for (const h of hits) process.stderr.write(`  L${h.line} [${h.terms.join(",")}]: ${h.text.trim().slice(0, 200)}\n`);
    process.exit(2);
  }

  // 2. 干净 → cp 字节直传到 rounds/
  const roundsDir = path.join(resolvedRun, "rounds");
  fs.mkdirSync(roundsDir, { recursive: true });
  const dest = path.join(roundsDir, `${seat}-r${roundNum}.md`);
  fs.copyFileSync(textRef, dest);

  // 3. append turn:produced(model 恒在:未指定 --model → null,消费端不必判 undefined;charCount 用 UTF-16
  //    code units,与桥 scripts/agent-bridge.mjs 的 charCount 口径一致)
  const charCount = content.length;
  let out;
  try {
    out = appendEvents(resolvedRun, [{
      event: "turn:produced",
      round: roundNum,
      payload: { seat, agent, model: model || null, roundRef: roundRefRel, charCount, ...(summary ? { summary } : {}) },
    }]);
  } catch (e) { die(e.message); }

  process.stdout.write(`seat-turn ok: ${roundRefRel} (${charCount} chars), turn:produced seq ${out[0].seq}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
