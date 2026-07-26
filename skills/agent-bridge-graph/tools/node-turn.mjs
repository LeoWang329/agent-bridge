#!/usr/bin/env node
// Agent Bridge Graph — 跑一个环节(命令行薄壳,零依赖)
//
// 这是给「懒得写脚本」的简单情况准备的配角。**主角是 node-core.mjs**(可 import 的内核):
// 流程一复杂(要循环、要按结果分支、要过滤),就该写几十行 JS 而不是敲一串命令 —— 见 ../SKILL.md。
//
//   node node-turn.mjs \
//     --id audit-auth --agent codex --cwd D:/repo \
//     --prompt "审计 auth.ts 的权限校验" \
//     --timeout-ms 600000 --out-dir D:/repo/.graph/run-1 \
//     [--model gpt-5.6-sol-high] [--effort xhigh] \
//     [--prompt-file D:/repo/task.md]        # 与 --prompt 二选一
//     [--role-file D:/prompts/reviewer.md]   # 角色设定(注入为 system 追加)
//     [--require-keys findings,summary]      # 弱检查:输出必须是 JSON 且含这些顶层键
//     [--schema-file D:/schema.json]         # 强制格式,**仅 codex**
//     [--no-reask]                           # 不合格时不打回重说(默认打回一次)
//     [--force] [--reuse-if-same]            # 幂等闸的两种解法
//     [--json]                               # stdout 只吐回执 JSON(给脚本吃)
//
// 退出码(描述**这一个环节**的结局):
//   0 成功 · 1 程序自己崩了 · 2 输出格式不合格(打回重说后仍不合格) · 3 后端挂了
//   4 超时 · 5 用法/IO 错 · 6 没预料到的状态(已停下并保留现场,**绝不自动重跑**)
//
// 注意 3 与 4 有重叠(后端卡死被超时收掉):判定顺序写死为**先判超时**(超时是本工具自己的动作、
// 看得见),只有桥明确回报 failed/closed 才算 3。

import fs from "node:fs";
import path from "node:path";
import { withBridge, runNode, UsageError, STATUS_EXIT } from "./node-core.mjs";

const BOOLEAN_FLAGS = new Set(["no-reask", "force", "reuse-if-same", "json", "help"]);

function die(msg, code = 5) {
  process.stderr.write(`[node-turn] ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`--${key} 缺少取值`);
    out[key] = next; i++;
  }
  return out;
}

const USAGE = `用法:node node-turn.mjs --id <名> --agent <omp|codex|claude|cursor|kimi> --cwd <目录> \\
  (--prompt <文本> | --prompt-file <文件>) --timeout-ms <毫秒> --out-dir <目录> [可选项]

可选:--model --effort --role-file --require-keys a,b --schema-file <文件>
      --no-reask --force --reuse-if-same --json

退出码:0 成功 / 1 崩了 / 2 格式不合格 / 3 后端挂 / 4 超时 / 5 用法错 / 6 未知状态(已保留现场)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) { process.stdout.write(USAGE + "\n"); process.exit(0); }

  const spec = {
    id: args.id,
    agent: args.agent,
    cwd: args.cwd,
    outDir: args["out-dir"],
    timeoutMs: args["timeout-ms"],
    prompt: args.prompt,
    promptFile: args["prompt-file"],
    model: args.model,
    effort: args.effort,
    roleFile: args["role-file"],
    reask: args["no-reask"] ? 0 : 1,
    force: Boolean(args.force),
    reuseIfSame: Boolean(args["reuse-if-same"]),
  };

  if (args["require-keys"]) {
    spec.outputShape = { requiredKeys: args["require-keys"].split(",").map((s) => s.trim()).filter(Boolean) };
  }
  if (args["schema-file"]) {
    const p = path.resolve(args["schema-file"]);
    if (!fs.existsSync(p)) die(`schema-file 不存在:${p}`);
    try { spec.schema = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { die(`schema-file 不是合法 JSON:${e.message}`); }
  }

  const receipt = await withBridge((bridge) => runNode(bridge, spec));

  if (args.json) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  } else {
    const line = [
      `[node-turn] ${receipt.id} → ${receipt.status}`,
      `agent=${receipt.agent}${receipt.model ? `/${receipt.model}` : ""}`,
      receipt.durationMs !== null ? `${Math.round(receipt.durationMs / 1000)}s` : "",
      receipt.charCount !== null ? `${receipt.charCount} chars` : "",
    ].filter(Boolean).join("  ");
    process.stdout.write(line + "\n");
    if (receipt.artifactPath) process.stdout.write(`  结果: ${receipt.artifactPath}\n`);
    if (receipt.scene?.dir) process.stdout.write(`  现场: ${receipt.scene.dir}\n`);
    if (receipt.error) process.stdout.write(`  错误: ${receipt.error}\n`);
    for (const d of receipt.diagnostics) process.stdout.write(`  诊断: ${d}\n`);
  }

  process.exit(STATUS_EXIT[receipt.status] ?? 6);
}

main().catch((e) => {
  if (e instanceof UsageError) die(e.message, 5);
  process.stderr.write(`[node-turn] 未捕获异常:${e?.stack || e}\n`);
  process.exit(1);
});
