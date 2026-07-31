// 顽固版假 omp 后端:协议部分照抄 fake-omp 的 okturn(所以会话能正常开、能跑完一轮),
// 唯一的区别是**怎么死** —— 它抗 EOF、抗 SIGTERM:
//   · stdin 关闭(EOF)→ **不退出**(正常后端会跟着退)
//   · SIGTERM / SIGINT / SIGHUP → **忽略**
//   · 只有 SIGKILL / taskkill /F 收得掉
// 靠一个长定时器把事件循环钉住;自带 120 秒兜底自杀,绝不在测试机上留长命孤儿。
//
// 用途:repro-graph-node.mjs 的 T8b —— 桥被杀之后,断言**这个后端的 pid 也死了**,
// 证明「即使桥已退出也杀进程树 + 桥自带 cleanup」这条回收路径真的在干活,
// 而不是"桥 pid 没了"就当零残留(那是假绿)。

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try { process.on(sig, () => { /* 就是不退 */ }); } catch {}
}
// ⚠️ 这几条才让它**真的**顽固:桥一死,我们的 stdout/stdin 管道就断,
// 未处理的 EPIPE 会以未捕获异常的形式把进程干掉 —— 那样测出来的"后端死了"
// 是它自己崩的,不是被回收路径收掉的(第一版就是这么假绿的)。
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.stdin.on("error", () => {});
process.on("uncaughtException", () => {});

const say = (obj) => { try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch {} };

// 启动握手:桥在 open_session 里等这一行,不发就会一直卡着(和 fake-omp 一致)
say({ type: "ready" });

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.type === "get_state") {
      // 与 okturn 一致:报"没在流式输出",会话才settle得下来
      say({
        type: "response", id: msg.id, command: "get_state", success: true,
        data: { isStreaming: false, queuedMessageCount: 0, sessionId: "stubborn", messageCount: 1 },
      });
    } else if (msg.type === "prompt") {
      say({ type: "response", id: msg.id, success: true });
      setTimeout(() => {
        say({ type: "agent_start" });
        say({ type: "message_update", message: { type: "text_delta", delta: "STUBBORN_ANSWER" } });
        say({ type: "turn_end" });
        say({ type: "agent_end" }); // 请求结束(按 OMP 协议,agent_end 才是 rpc 消费者的 idle 信号)
      }, 60);
    } else if (msg.id !== undefined) {
      say({ type: "response", id: msg.id, success: true, data: {} });
    }
  }
});

// EOF 也不退 —— 这正是本假后端存在的意义
process.stdin.on("end", () => {});
process.stdin.on("close", () => {});

// 把事件循环钉住,同时兜底自杀
setTimeout(() => process.exit(0), 120000);
