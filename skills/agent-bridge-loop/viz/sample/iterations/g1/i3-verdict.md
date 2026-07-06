VERDICT: PASS
AC1: PASS — `npm test` 17/17,输出干净
AC2: PASS — validation/probe-stdout.mjs 100 次跑全部 `JSON.parse` 通过;stderr 独立
AC3: PASS — 坏输入:exit 2 + `{"error":…}`;`kill -INT`:stdout=`{"aborted":true}`、exit 130(validation/sigint-probe.mjs 三平台参数各跑 3 次)
AC4: PASS — 异引擎 reviewer 对 a1b2c3d^..b7c8d9e APPROVE(主控代执行,报告见主控存档)

NOTES:
- validation/ 探针脚本(probe-stdout.mjs / sigint-probe.mjs)已留存,G2 及收官复验可复用。
