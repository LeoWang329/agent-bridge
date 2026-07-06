# 收官报告 — relay-cli --json 输出模式

**结果:2/2 goals 全部验收通过 · 收官评审 APPROVE(第 1 轮)**

## 逐 goal 交付

### G1 --json 输出结构化结果(3 迭代)
- 交付:`--json` 标志 + JsonReporter;stdout 纯 JSON、进度走 stderr;错误 exit 2、SIGINT 输出 `{"aborted":true}` 后 exit 130。
- 证据:`iterations/g1/i3-verdict.md`(AC1–AC4 全 PASS,含异引擎 reviewer APPROVE)。
- 爬坡:AC 1/4 → 2/4 → 4/4。中途一次洁净树审计撤销(验证者误改 `src/report/json.ts`,verdict 作废重验)。

### G2 文档与帮助文本(1 迭代)
- 交付:README「JSON 输出」章节(schema 表 + 3 示例)+ --help 更新。
- 证据:`iterations/g2/i1-verdict.md`(示例逐条实跑一致)。

## 人类决策记录

- q1:SIGINT 语义 → **必须完整 JSON(`{"aborted":true}`)**;合同 AC3 已增补(contract:amended)。

## 假设账本终态

- A1(stderr 分离)、A2(SIGINT 完整 JSON)均已被用户确认,无遗留推定假设。

## 遗留风险

- spinner 库靠环境变量禁用,若未来升级该库需回归 AC2(已写进 README 维护注记)。
