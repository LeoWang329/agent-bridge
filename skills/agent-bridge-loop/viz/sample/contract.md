# 验收合同 — relay-cli --json 输出模式

模式: 人在环 · 评审团: 双架构师 · 生成: 2026-07-06T09:00Z

## 原始需求(用户原话,逐字)

> 给 relay-cli 增加 --json 输出模式,机器可读结果,供 CI 消费。

## 假设账本

- A1: 进度输出(spinner/彩色日志)在 --json 下的去向 → **进 stderr,stdout 只有 JSON**(来源: 用户确认,访谈 Q1)
- A2: SIGINT 中断语义 → **stdout 必须仍是完整 JSON(`{"aborted":true}`)再退出**(来源: 用户拍板 q1;AC3 据此增补)

## Goal G1: --json 输出结构化结果

动机: CI 需要稳定的机器可读输出;当前人类可读输出无法可靠解析。

验收标准(每条可被验证者独立执行验证):
- AC1 [test] `npm test` 全绿(含新增 JsonReporter 测试)
- AC2 [e2e] `relay-cli sync --json` 的 stdout 是且仅是一个合法 JSON 文档(重复 100 次全部 `JSON.parse` 通过);进度噪声只许进 stderr
- AC3 [e2e] 错误与中断路径:坏输入 → 退出码 2 且 stdout 为 `{"error":…}`;**(增补)** SIGINT → stdout 先输出 `{"aborted":true}` 再退出(退出码 130)
- AC4 [review] 异引擎 reviewer 对 base..head 给 APPROVE(主控代执行,其余 AC 全绿才跑)

边界: 不动人类可读模式的既有输出格式;不改 sync 的业务逻辑。

## Goal G2: 文档与帮助文本

动机: 没有文档的标志等于不存在。

验收标准:
- AC1 [e2e] `relay-cli --help` 含 --json 说明,且帮助里的示例命令逐条可跑
- AC2 [e2e] README「JSON 输出」章节的示例逐条执行,输出与文档一致

边界: 只动 README 与 --help 文本。

## 全局约束

- 错误码表精简为 3 个:0 成功 / 2 用户输入错误 / 130 中断(用户确认)
- 不引入新运行时依赖
