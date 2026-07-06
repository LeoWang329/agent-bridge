VERDICT: PASS
AC1: PASS — `relay-cli --help` 输出含 --json 段;帮助示例 `relay-cli sync --json` 实跑,stdout 合法 JSON
AC2: PASS — README「JSON 输出」3 个示例逐条执行:成功例输出与 schema 表一致;错误例 exit 2 + `{"error":…}`;中断例 `{"aborted":true}` + exit 130

NOTES:
- 复用了 G1 留存的 validation/probe-stdout.mjs 做示例输出校验,零重写。
