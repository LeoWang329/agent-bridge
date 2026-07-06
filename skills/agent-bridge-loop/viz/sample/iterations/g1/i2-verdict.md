VERDICT: FAIL
AC1: PASS — `npm test` 14/14
AC2: PASS — validation/probe-stdout.mjs(pty)100 次跑,stdout 全部 `JSON.parse` 通过、零转义序列;stderr 独立承载进度
AC3: FAIL — 坏输入路径已修(exit 2 ✅);但 `kill -INT` 中断时 stdout 残留未闭合 JSON 片段(`{"items":[{"id":1},` 截断)
AC4: SKIPPED — 其余 AC 未全绿,lazy 不执行

DEFECTS:
- [AC3] 现象:SIGINT 时 stdout 留半个 JSON / 证据:validation/sigint-probe.mjs 三次中断三次截断 / 复现:`relay-cli sync --json` 运行中 Ctrl-C
  注:AC3 原文只写了「坏输入」,未覆盖中断路径——**这可能是验收标准本身的缺口**,已在 NOTES 请主控升级澄清,本轮按「stdout 必须可解析」的合同精神判 FAIL。

NOTES:
- (本轮为洁净树审计后的 fresh 重验:上一位验证者误将调试行写进 src/report/json.ts,verdict 作废。)
- 建议主控把「SIGINT 语义」升级给用户拍板,再决定 AC3 终稿。
