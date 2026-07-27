#!/usr/bin/env node
// 模板:**分波**——跑一波 → 脚本返回 → 主 agent 看结果决定 → 再跑一波。
//
//   node wave.mjs <cwd> --out <run-dir> --wave 1
//   node wave.mjs <cwd> --out <run-dir> --wave 2      ← 同一个 --out,第 1 波的环节秒判复用
//
// 为什么要分波:脚本一旦启动主 agent 就出局了,没有"跑到一半问主 agent"这回事。
// 要中途决策就把决策点切在**波与波之间** —— 灵活度全在主 agent 手里,而重活仍在脚本里,
// 中间产出一个字都不进上下文。
//
// 关键机制:`reuseIfSame:true` + 稳定的 `id`。第 2 波把第 1 波的环节**原样**再声明一遍,
// 指纹一致 → 本地秒判复用(不发任何模型请求)。所以后面每一波都能"从头声明整张图"。

import fs from "node:fs";
import path from "node:path";
import { withBridge } from "../tools/node-core.mjs";

// ── 改这里 ────────────────────────────────────────────────────────────────────
const TIMEOUT_MS = 900000;
const PROBES = [
  { id: "probe-a", agent: "codex", prompt: "只读调查(不要改文件):……你的问题 A" },
  { id: "probe-b", agent: "omp", prompt: "只读调查(不要改文件):……你的问题 B" },
];
const SYNTH_AGENT = "kimi"; // 必须是没下场调查的引擎
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith("--"));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CWD = path.resolve(pos[0] || process.cwd());
const OUT_DIR = path.resolve(flag("out", path.join(CWD, ".graph", "run-1")));
const WAVE = Number(flag("wave", "1"));

if (!fs.existsSync(CWD)) { console.error(`cwd 不存在:${CWD}`); process.exit(5); }
if (![1, 2].includes(WAVE)) { console.error(`--wave 只能是 1 或 2(要更多波就照着往下加)`); process.exit(5); }
if (PROBES.some((p) => p.agent === SYNTH_AGENT)) {
  console.error(`汇总引擎 ${SYNTH_AGENT} 不能同时是调查方 —— 自己评自己没意义`); process.exit(5);
}

const result = await withBridge(async (bridge) => {
  // 第 1 波:扇出。**每一波都从头声明整张图** —— 已完成的靠指纹复用,不会重跑。
  // 照写 Promise.all 就行:超过 maxConcurrent(默认 4)的会自动排队。
  const probes = await Promise.all(PROBES.map((p) => bridge.runNode({
    ...p, cwd: CWD, outDir: OUT_DIR, access: "read", timeoutMs: TIMEOUT_MS,
    reuseIfSame: true, // ← 分波的关键:第 2 波跑到这里是本地秒判,不发模型请求
  })));

  const ok = probes.filter((p) => p.status === "ok");
  // unknown 单独挑出来:它不是"一种失败",是"不知道后端干没干" —— 绝不自动重跑
  const unknown = probes.filter((p) => p.status === "unknown");
  if (unknown.length) {
    return { halt: "有环节状态不明(已保留现场),请人工看过再决定",
             unknown: unknown.map((u) => ({ id: u.id, scene: u.scene?.dir, error: u.error })) };
  }

  if (WAVE === 1) {
    // ← 这里就是交还给主 agent 的地方。只回摘要 + 路径,正文一个字不带。
    return {
      wave: 1, outDir: OUT_DIR,
      probes: probes.map((p) => ({ id: p.id, agent: p.agent, status: p.status,
                                   chars: p.charCount, path: p.artifactPath })),
      next: `主 agent 读上面这些 path、决定第 2 波要问什么,改好本文件的第 2 波再跑:--wave 2`,
    };
  }

  if (ok.length === 0) return { halt: "第 1 波全挂了,没东西可汇总" };

  // 第 2 波:换引擎汇总。**传路径不传正文**(大家在同一个 cwd,让它自己读)。
  const synth = await bridge.runNode({
    id: "synthesis", agent: SYNTH_AGENT, cwd: CWD, outDir: OUT_DIR,
    access: "read", timeoutMs: TIMEOUT_MS, reuseIfSame: true,
    prompt:
      `只读任务(不要改文件)。下面几份是不同引擎对同一问题的独立调查结果,**请自己读这些文件**:\n` +
      ok.map((p) => `  - ${p.artifactPath}(来自 ${p.agent})`).join("\n") +
      `\n\n请输出:①多家共同点名的 ②只有一家提到但你读完认为成立的 ③你判断不成立的,各自说明理由。`,
  });

  return {
    wave: 2, outDir: OUT_DIR,
    probes: probes.map((p) => ({ id: p.id, status: p.status, reused: !!p.reused })),
    synthesis: { status: synth.status, path: synth.artifactPath, chars: synth.charCount },
  };
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.halt ? 1 : 0);
