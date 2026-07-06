# 生成者汇报 · G1 · 迭代 1

- **Status:** DONE
- **Commit:** a1b2c3d `g1-i1: add --json flag + JsonReporter`
- **测试小结:** 12/12 通过,输出干净

## 实现说明
- `src/cli.ts`:新增 `--json` 布尔标志,注入 JsonReporter。
- `src/report/json.ts`:新建 JsonReporter,聚合结果为单一 JSON 文档,结束时一次性写 stdout。
- `test/json.test.ts`:schema 断言 + 幂等两跑。

## 逐 AC 自测
- AC1:npm test 12/12 ✅
- AC2:手跑 `sync --json | jq .` 通过 ✅(注:只跑了 1 次)
- AC3:坏输入返回 `{"error":…}` ✅(未断言退出码)
- AC4:不归我(主控代执行)

## Concerns
- spinner 库(ora)是否在非 TTY 下自动静默,未验证。
