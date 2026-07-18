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
//     [--extra-names "MiniMax-M3,glm"]     # 本场在座模型名,并入裸厂商名扫描
//     [--vendor-topic]                     # 议题本身合法涉及后端/厂商名时:全部命中降为非阻塞 WARN(见下)
//
// 行为:
//   1. cp textRef → <run-dir>/rounds/<seat>-r<round>.md(字节直传,fs.copyFileSync,0 改写);
//   2. 泄漏扫描分两类(治「厂商名出现 ≠ 席位自我指认」的混淆):
//      - **自我指认(self-ID)**:点名(「作为 codex」「我是 gpt」「as a claude」)+ 不点名(「作为一个语言模型」
//        「我的知识截止」「as an AI」)——**这才是打穿匿名的真信号**(不点名那类是整词厂商黑名单**挡不住**的漏网);
//      - **裸厂商名(vendor)**:黑名单整词命中,可能是自指、也可能只是**议题内容**(如「codex 的沙箱是硬只读」)。
//      阻断策略:
//      - **默认**(普通议题):自指 **或** 裸厂商名任一命中 → 阻断(exit 2,不写 rounds/)。裸厂商名在与后端无关的
//        议题里出现本就可疑,保持阻断=安全默认。
//      - **`--vendor-topic`**(议题合法涉及后端/厂商名,如「讨论 agent 后端本身」):厂商名是合法内容,**任何自动模式
//        都不可靠** → 全部命中降为**非阻塞 WARN**,照常 cp+append,把命中(自指嫌疑优先)surfaced 给主席**人工核对**。
//   3. append turn:produced 事件(自动算 seq/ts/charCount;复用 rt-event.mjs 的 appendEvents,含目录锁)。
//
// exit code:0=成功(含 --vendor-topic 下仅 WARN);1=用法/IO 错;2=检测到阻断级身份泄漏(需主席处理后重跑或点状遮盖)。
//
// 诚实边界:扫描是**启发式地板不是天花板**。--vendor-topic 关掉自动阻断后,匿名靠主席人工自指审查(工具只给候选清单)。
// 若议题恰是匿名机制**本身**(正文会把「作为一个语言模型」当例子引用),连自指启发式也会误报 → 该场主席直接走全手工
// 路径、别用本工具的写入(或用 --vendor-topic 后人工逐条判 WARN)。真·硬匿名需桥层 OS 沙箱,不在本工具。

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { appendEvents } from "./rt-event.mjs";

// 裸厂商/商品名黑名单(整词匹配)。**不含桥后端名 "omp"**——那是后端标识、席位不会自称它,且易误伤正文。
const VENDOR_BLACKLIST = [
  "claude", "opus", "sonnet", "gpt", "chatgpt", "deepseek", "gemini", "qwen",
  "anthropic", "openai", "minimax", "kimi", "codex", "glm", "zhipu",
  // cursor 后端可托管的厂商/家族级名(grok=xAI 的 Grok)——补齐这些才让匿名扫描的**全局兜底**覆盖 cursor 席。
  // 只放**家族/厂商级、且非高频英文词**的名(与既有 qwen/kimi/glm/gemini 同粒度);产品/模式名(如 Cursor 的
  // "composer")、以及某席具体在跑的模型名,走**每席 `--extra-names`**(见 tools/README.md),不进全局表——
  // 否则整词匹配会大量误伤正文(如 PHP Composer / music composer)。
  // 故意**不含 "cursor" 本身**(同被排除的 "omp":常用词,英文正文 "move the cursor / DB cursor" 会误伤)。
  "grok", "xai",
  // kimi 后端的厂商级名(`kimi` 本身已在上面)。"moonshot" 作英文习语("这是个 moonshot")偶有正文误伤,但
  // 远不到 cursor/omp 那种高频,按同粒度收进全局表;真撞上议题就用 `--vendor-topic` 降为 WARN。
  // **不放** "k2"/"k3":太短、易在正文/版本号里误伤,要扫用每席 `--extra-names`。
  "moonshot",
];
const VENDOR_ALT = VENDOR_BLACKLIST.join("|");

// 自我指认句式(self-identification):打穿匿名的真信号,与「裸厂商名出现」区分对待。
// 两类:①点名自指(厂商名嵌在自指构造里,避免「作为一个软件工程师」误伤);②不点名自指(通用模型自述,厂商名可无
// ——整词厂商黑名单对这类**完全无效**,是它的漏网)。大小写不敏感、逐行 test(无 g flag,无 lastIndex 副作用)。
const SELF_ID_PATTERNS = [
  // ① 点名自指(中/英)
  { re: new RegExp(`作为\\s*(一个|一名|个|名)?\\s*(${VENDOR_ALT})\\b`, "i"), label: "作为<厂商>" },
  { re: new RegExp(`我(是|就是|乃|即)\\s*(${VENDOR_ALT})\\b`, "i"), label: "我是<厂商>" },
  { re: new RegExp(`\\bas\\s+an?\\s+(${VENDOR_ALT})\\b`, "i"), label: "as a <vendor>" },
  { re: new RegExp(`\\bi(?:'m|’m|\\s+am)\\s+(${VENDOR_ALT})\\b`, "i"), label: "I am <vendor>" },
  // ② 不点名自指(通用模型自述——整词厂商黑名单挡不住的漏网,p2 在 dogfood 中发现)
  { re: /作为\s*(一个|一名|个|名)?\s*(大?语言模型|语言模型|AI\s*模型|人工智能模型|人工智能助手|AI\s*助手|机器学习模型|大模型)/i, label: "作为语言模型/AI" },
  { re: /我(的)?\s*(知识|训练\s*数据|训练)\s*(截止|截至|更新|停留)/i, label: "我的知识截止/训练数据" },
  { re: /(知识|训练\s*数据)\s*(截止|截至)\s*(日期|时间|到|于|在)?/i, label: "知识截止" },
  { re: /我\s*(无法|不能|没有能力)\s*(联网|上网|访问\s*(互联网|实时|网络)|获取\s*实时)/i, label: "我无法联网/访问实时" },
  { re: /\bas\s+an?\s+(ai|a\.i\.|language model|large language model|llm|ai\s+(?:model|assistant)|assistant)\b/i, label: "as an AI/language model" },
  { re: /\bmy\s+(knowledge|training)\s+(cut-?off|cutoff|data)\b/i, label: "my knowledge cutoff/training data" },
  { re: /\bi\s+(?:can(?:'|’)?t|cannot|am unable to)\s+(?:browse|access the internet|go online|access real-?time)\b/i, label: "I cannot browse/access internet" },
];

const BOOLEAN_FLAGS = new Set(["vendor-topic"]);

function die(msg, code = 1) { process.stderr.write(`[seat-turn] ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) die(`--${key} 缺少值`);
      out[key] = val; i++;
    } else out._.push(a);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 裸厂商名:整词、大小写不敏感扫描;返回命中行 [{line, text, terms:[...]}]
function scanVendor(content, terms) {
  const re = new RegExp(`\\b(?:${terms.map(escapeRe).join("|")})\\b`, "gi");
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matched = lines[i].match(re);
    if (matched) hits.push({ line: i + 1, text: lines[i], terms: [...new Set(matched.map((m) => m.toLowerCase()))] });
  }
  return hits;
}

// 自我指认:逐行跑 SELF_ID_PATTERNS;返回命中行 [{line, text, labels:[...]}]
function scanSelfId(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const labels = [];
    for (const p of SELF_ID_PATTERNS) if (p.re.test(lines[i])) labels.push(p.label);
    if (labels.length) hits.push({ line: i + 1, text: lines[i], labels: [...new Set(labels)] });
  }
  return hits;
}

function printHits(tag, hits, render) {
  for (const h of hits) process.stderr.write(`  ${tag} L${h.line} [${render(h)}]: ${h.text.trim().slice(0, 200)}\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  const runDir = args._[0];
  if (!runDir) die("缺少 <run-dir>。用法见文件头。");
  const { seat, round, "text-ref": textRef, agent, model, summary } = args;
  const vendorTopic = args["vendor-topic"] === true;
  if (!seat) die("缺少 --seat(如 p1)");
  if (round === undefined) die("缺少 --round(如 0)");
  if (!textRef) die("缺少 --text-ref(桥返回的 textRef 绝对路径)");
  if (!agent) die("缺少 --agent(如 omp/codex/claude/cursor/kimi)");
  // 校验 seat/round:二者直接拼进文件路径与 roundRef,必须挡目录穿越/非法名(如 ../x、p1/sub)
  if (!/^p\d+$/.test(seat)) die(`--seat 必须形如 p<数字>(如 p1),收到: ${seat}`);
  const roundNum = Number(round);
  if (!Number.isInteger(roundNum) || roundNum < 0) die(`--round 必须是非负整数,收到: ${round}`);

  const resolvedRun = path.resolve(runDir);
  if (!fs.existsSync(resolvedRun) || !fs.statSync(resolvedRun).isDirectory()) die(`run-dir 不存在或不是目录: ${resolvedRun}`);
  if (!fs.existsSync(textRef) || !fs.statSync(textRef).isFile()) die(`--text-ref 不存在或不是文件: ${textRef}`);

  const roundRefRel = `rounds/${seat}-r${roundNum}.md`;

  // 1. 先扫描源(textRef)——分两类:自指(self-ID)+ 裸厂商名(vendor)。命中阻断就此中止——不 cp,rounds/
  //    保持原样(cp 是字节直传,扫源 === 扫落盘成品)。
  const content = fs.readFileSync(textRef, "utf8");
  const extra = (args["extra-names"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const vendorHits = scanVendor(content, [...VENDOR_BLACKLIST, ...extra]);
  const selfIdHits = scanSelfId(content);

  if (vendorTopic) {
    // 议题合法涉及厂商名:不阻断,把命中当 WARN 全部 surfaced(自指嫌疑优先),主席人工核对后自负其责。
    if (selfIdHits.length || vendorHits.length) {
      process.stderr.write(`[seat-turn] --vendor-topic:泄漏扫描降为非阻塞 WARN(主席须人工核对下列命中;已照常写 ${roundRefRel}):\n`);
      if (selfIdHits.length) {
        process.stderr.write(`  — 自指嫌疑 ${selfIdHits.length} 行(优先:核对是真自我指认还是议题引用):\n`);
        printHits("⚠SELF-ID", selfIdHits, (h) => h.labels.join(","));
      }
      if (vendorHits.length) {
        process.stderr.write(`  — 裸厂商名 ${vendorHits.length} 行(议题内容多为合法):\n`);
        printHits("·vendor", vendorHits, (h) => h.terms.join(","));
      }
    }
    // 继续写(非阻塞)。
  } else if (selfIdHits.length || vendorHits.length) {
    // 默认:自指或裸厂商名任一命中即阻断(exit 2,不写 rounds/,源文件不动)。
    const n = selfIdHits.length + vendorHits.length;
    process.stderr.write(`[seat-turn] 泄漏扫描命中 ${n} 处,已中止(未写 ${roundRefRel};源文件 ${textRef} 未改;请主席让该席重述或点状遮盖后重跑;若议题本身合法涉及后端/厂商名,改用 --vendor-topic 降为非阻塞 WARN):\n`);
    if (selfIdHits.length) printHits("SELF-ID", selfIdHits, (h) => h.labels.join(","));
    if (vendorHits.length) printHits("vendor", vendorHits, (h) => h.terms.join(","));
    process.exit(2);
  }

  // 2. 干净(或 --vendor-topic)→ cp 字节直传到 rounds/
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

  process.stdout.write(`seat-turn ok: ${roundRefRel} (${charCount} chars), turn:produced seq ${out[0].seq}${vendorTopic && (selfIdHits.length || vendorHits.length) ? " [--vendor-topic: WARN 已 surfaced,主席须人工核对]" : ""}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
