# 生成者汇报 · G1 · 迭代 2

- **Status:** DONE
- **Commit:** d4e5f6a `g1-i2: mute spinner on --json; error exit codes`
- **测试小结:** 14/14 通过(+2 回归)

## 缺陷回应表
- #1(AC2 spinner)fixed:spinner 全部改挂 stderr,且 `--json` 时彻底禁用(不靠 TTY 探测);回归测试用 pty 断言 stdout 零转义序列。
- #2(AC3 退出码)fixed:错误路径统一 `exit(2)`;回归测试断言 `$? === 2`。

## Concerns
- SIGINT 中断路径合同没写——我按「进程默认行为」未处理;若 CI 关心中断输出,可能需要澄清。
