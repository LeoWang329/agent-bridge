#!/usr/bin/env node
// 示例:异构分头查 → 过滤 → 换引擎汇总。**可直接跑**,也是本 skill 的真跑 e2e。
//
//   node examples/hetero-audit.mjs <要审计的目录> [--agents codex,omp,claude] [--out <目录>]
//
// 这段脚本本身就是"graph 工程"该长的样子:
//   · 扇出/等齐  = Promise.all(JS 自带,不用我们发明)
//   · 过滤/分支  = filter / if(普通代码,一次 AI 都没叫)
//   · 判断       = 才叫 bridge.runNode(...)
//   · 中间结果   = 活在 JS 变量和磁盘里,**主 agent 只看见最后 return 的那点东西**
//
// 换成"要循环到收敛"的场景,就是在外面套一个 `for (let round = 1; round <= 3; round++)`
// 再加个"没新发现就 break"——同样是普通 JS,不需要本 skill 提供任何"循环原语"。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge } from "../tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[++i]; } else { out._.push(a); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const TARGET = path.resolve(args._[0] || process.cwd());
const AGENTS = (args.agents || "codex,omp,claude").split(",").map((s) => s.trim()).filter(Boolean);
const OUT_DIR = path.resolve(args.out || path.join(TARGET, ".graph", `run-${Date.now()}`));
// 单个环节的上限。短的是「单次请求」不是任务本身 —— 内核内部会按 5 分钟切片反复 wait。
const PER_NODE_TIMEOUT_MS = Number(args["timeout-ms"] || 900000);

// 每家查一个不同的角度 —— 异构的价值在"不同脑子看不同地方",不是同一个问题问三遍
const ANGLES = [
  "错误处理与边界条件:未捕获的异常、静默吞错、失败路径没有收尾",
  "资源生命周期:进程/文件句柄/会话有没有泄漏,异常路径上还关不关得干净",
  "并发与竞态:共享状态、重入、先写后读的顺序假设",
];

if (!fs.existsSync(TARGET)) { console.error(`目标目录不存在:${TARGET}`); process.exit(5); }

// 示例必须**执行自己写下的纪律**,否则就是教坏用的人:
// ① 一次并行别超过 4 个(怕挤垮主 agent 自己那条桥连接);② 同一个引擎不要排两遍(那不叫异构,
// 而且两个环节的 id 会撞);③ 汇总一定要换一个没参与审计的引擎(自己评自己会护短)。
const ALL_AGENTS = ["omp", "codex", "claude", "cursor", "kimi"];
if (AGENTS.length === 0) { console.error("--agents 不能为空"); process.exit(5); }
if (AGENTS.length > 4) { console.error(`一次并行别超过 4 个,拿到 ${AGENTS.length} 个:${AGENTS.join(",")}`); process.exit(5); }
if (new Set(AGENTS).size !== AGENTS.length) { console.error(`--agents 里有重复:${AGENTS.join(",")}(重复不叫异构)`); process.exit(5); }
for (const a of AGENTS) {
  if (!ALL_AGENTS.includes(a)) { console.error(`不认识的后端 "${a}",可选:${ALL_AGENTS.join("/")}`); process.exit(5); }
}
// 汇总者必须是没下场审计的引擎。找不到就直接停,不退而求其次让某个审计者兼任裁判。
const SUMMARIZER = args.summarizer || ALL_AGENTS.find((a) => !AGENTS.includes(a));
if (SUMMARIZER && !ALL_AGENTS.includes(SUMMARIZER)) {
  console.error(`--summarizer 不认识的后端 "${SUMMARIZER}",可选:${ALL_AGENTS.join("/")}`);
  process.exit(5);
}
if (!SUMMARIZER || AGENTS.includes(SUMMARIZER)) {
  console.error(
    `找不到一个没参与审计的引擎来做汇总(审计方 ${AGENTS.join(",")})。\n` +
    `请少排一家审计,或用 --summarizer 明确指定一个没下场的引擎——"汇总一定换引擎"这条不能破。`,
  );
  process.exit(5);
}

const result = await withBridge(async (bridge) => {
  // 开跑前先体检(便宜)。注意 doctor 只查版本号,不验登录,过了也可能起不来。
  const doc = await bridge.doctor();
  console.log(`[doctor]\n${(doc?._raw || JSON.stringify(doc)).trim()}\n`);

  // --- 扇出:每家一个角度,同时跑
  console.log(`[fan-out] ${AGENTS.length} 家并发审计 ${TARGET}`);
  const audits = await Promise.all(AGENTS.map((agent, i) =>
    bridge.runNode({
      id: `audit-${agent}`,
      agent,
      cwd: TARGET,
      outDir: OUT_DIR,
      timeoutMs: PER_NODE_TIMEOUT_MS,
      prompt:
        `只读调查(**不要修改任何文件**)。审计这个仓库里 scripts/agent-bridge.mjs 的一个侧面:\n\n` +
        `【你的角度】${ANGLES[i % ANGLES.length]}\n\n` +
        `要求:自己去读代码(别等我贴),最多挑 3 个**最值得说**的问题。每个问题给:\n` +
        `  1) 文件:行号  2) 一句话说清问题  3) 具体触发场景  4) 你的把握(高/中/低)\n` +
        `没找到真问题就直说"没发现值得报的问题",**不要凑数**。控制在 400 字内。`,
    })));

  for (const a of audits) {
    console.log(`  ${a.id}: ${a.status}` +
      (a.status === "ok" ? `  ${a.charCount} chars  ${Math.round(a.durationMs / 1000)}s` : `  ${a.error ?? ""}`));
  }

  // --- 过滤:普通代码,不叫 AI(这就是"不需要判断的活用代码"那条纪律)
  const ok = audits.filter((a) => a.status === "ok");
  if (ok.length === 0) {
    return { halt: "全部环节都失败了,没东西可汇总", audits };
  }
  // --- 分支:普通 if。这里的处置是**这个脚本的策略**,不是工具替你定的
  if (ok.length < audits.length) {
    console.log(`[note] ${audits.length - ok.length} 个环节失败,带缺口继续汇总(圆桌式处置)`);
  }

  // --- 汇总:用开跑前就选定的、没参与审计的引擎(自己评自己会护短)
  console.log(`[synthesize] 用 ${SUMMARIZER} 汇总 ${ok.length} 份结果`);

  const summary = await bridge.runNode({
    id: "summary",
    agent: SUMMARIZER,
    cwd: TARGET,
    outDir: OUT_DIR,
    timeoutMs: PER_NODE_TIMEOUT_MS,
    prompt:
      `只读任务(**不要修改任何文件**)。下面几份文件是几个不同引擎对同一个仓库的独立审计结果,` +
      `**请自己读这些文件**(别等我贴内容):\n` +
      ok.map((a) => `  - ${a.artifactPath}(来自 ${a.agent})`).join("\n") +
      `\n\n请输出:\n` +
      `  1) **多家共同点名**的问题(这些最可能是真的)——逐条给文件:行号 + 一句话\n` +
      `  2) 只有一家提到、但你读完代码认为**确实成立**的问题\n` +
      `  3) 你判断**不成立或过度紧张**的,点名说明为什么\n` +
      `控制在 600 字内。`,
  });

  // 主 agent / 调用方只拿到这一小坨,上面那几份长报告全程没进过任何人的上下文
  return {
    outDir: OUT_DIR,
    audits: audits.map((a) => ({ id: a.id, agent: a.agent, status: a.status, chars: a.charCount })),
    summarizer: SUMMARIZER,
    summary: { status: summary.status, path: summary.artifactPath, chars: summary.charCount },
  };
});

console.log(`\n[done]\n${JSON.stringify(result, null, 2)}`);
if (result.summary?.path) {
  console.log(`\n===== 汇总正文 =====\n${fs.readFileSync(result.summary.path, "utf8")}`);
}
process.exit(result.halt || result.summary?.status !== "ok" ? 1 : 0);
