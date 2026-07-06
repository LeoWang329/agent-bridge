VERDICT: FAIL
AC1: PASS — `npm test` 12/12,输出干净
AC2: FAIL — `relay-cli sync --json > out.json` 后 `node -e "JSON.parse(...)"` 抛错:stdout 混入 `\x1b[2K\x1b[1G⠙ syncing…` spinner 转义序列(TTY 下 ora 写的是 stdout)
AC3: FAIL — `relay-cli sync --bad-flag --json; echo $?` → 退出码 0(合同要求 2);stdout 的 `{"error":…}` 本身合法
AC4: SKIPPED — 其余 AC 未全绿,lazy 不执行

DEFECTS:
- [AC2] 现象:stdout 被 spinner 污染 / 证据:validation/probe-stdout.mjs 捕获的原始字节含 \x1b[ 序列(100 次跑 100 次坏)/ 复现:任意 TTY 环境 `relay-cli sync --json`
- [AC3] 现象:错误路径 `process.exit(0)` / 证据:echo $? → 0 / 复现:`relay-cli sync --bad-flag --json`

NOTES:
- 生成者自测「手跑 jq 通过」大概率在非 TTY 管道下跑的——TTY 差异正是雷点;我的探针脚本 validation/probe-stdout.mjs 用 pty 模拟真实终端。
