# 生成者汇报 · G2 · 迭代 1

- **Status:** DONE
- **Commit:** c9d0e1f `g2-i1: docs for --json`
- **测试小结:** 17/17 通过(文档改动,无新测试)

## 实现说明
- `README.md`:新增「JSON 输出」章节——输出 schema 表(字段/类型/含义)、3 个可复制示例(成功/错误/中断)、错误码表(0/2/130)、spinner 库维护注记。
- `src/cli.ts`:--help 文本补 --json 说明与一个示例。

## 逐 AC 自测
- AC1:`relay-cli --help` 含 --json 段,示例手跑通过 ✅
- AC2:README 3 个示例逐条手跑,输出一致 ✅
