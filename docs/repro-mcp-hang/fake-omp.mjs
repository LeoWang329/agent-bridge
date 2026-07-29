// Fake omp backend: speaks just enough of the omp RPC protocol to drive the repros. Behavior is
// selected by FAKE_OMP_MODE (default "pipebreak"):
//   pipebreak — ack prompt + agent_start, answer get_state, then destroy our OWN stdin read-end at
//               T+3s while staying alive (graceful-teardown / broken-pipe shape). [repro-pipebreak]
//   silent    — ack prompt + agent_start, but NEVER answer get_state (process alive, pipe writable,
//               no responses) — the half-dead backend shape. [repro-halfdead -> P/F4 fast-fail]
//   turnstate — two phases. (1) A request that genuinely COMPLETES (agent_start + text + turn_end +
//               agent_end), so the bridge really writes an end stamp — without this the F8 check would
//               be vacuous. (2) No further lifecycle events at all: get_state simply starts reporting
//               isStreaming:true, which is the real OMP incoherence (BUG-omp-turn-state-inconsistency)
//               that flips status back to "running" while the end stamp is still set.
//               [repro-turnstate -> F7/F8 coherent clock]
//   rejectprompt — REFUSE the prompt (respond success:false) while staying alive and idle, so no turn
//               ever starts. send() throws, status returns to idle. [repro-waitfail -> R2/turnInFlight:
//               a rejected-prompt session must still settle wait(), not dead-wait on a turn that never comes]
//   okturn    — a CLEAN turn: ack prompt, emit agent_start + one text message_update + turn_end, and
//               report isStreaming:false to get_state so the session settles idle with real answer text.
//               A benign line is written to STDERR mid-turn (must NOT be treated as a fatal lastError).
//               [repro-wait-shape (T1 result-field passthrough) / repro-laststderr (T4) / repro-health (T9)]
//   slowturn  — ack prompt + agent_start, then stay running ~2.5s before message_update + turn_end, so a
//               SECOND send() lands mid-turn and must be rejected ("already has a running turn").
//               get_state reports isStreaming:true FOREVER, so this mode can only be used to produce a
//               "still running" reading — an inline wait:true on it never completes (waitIdle wants
//               !isStreaming). Use slowsettle when the slow turn must actually finish.
//               [repro-omp-concurrent (T3)]
//   slowsettle— like slowturn (~2.5s) but get_state flips back to isStreaming:false when the turn really
//               ends, which is what real omp does. The only slow mode an inline wait:true can complete
//               on. [repro-collect-discipline T13/T14 -> join clock vs inline clock]
//   errturn   — ack prompt + agent_start, then turn_end with stopReason:"error" so the turn completes
//               in ERROR (session returns to idle but health must read degraded). [repro-health (T9)]
//   echoturn  — like okturn but ECHOES the received prompt text back as the answer ("ECHO:<prompt>"), so
//               a test can prove message_file content actually reached the backend. [repro-io (T10)]
//   ctxturn   — like okturn (settles clean) but get_state ALSO reports contextUsage{tokens,contextWindow}
//               + isCompacting/autoCompactionEnabled, so the bridge's normalized top-level contextUsage
//               (live:true) can be asserted through result()/wait()/status(). [repro-context-usage]
//   logstress — a clean turn that also exercises every diagnostic-log hazard: a multi-byte character
//               split across two STDERR writes (cross-chunk UTF-8), a tool_execution_end whose `content`
//               is a structure carrying both a tool name and big text/output leaves, and a body nested
//               past the redaction depth guard. [repro-log-bounds]
//   ctxslow   — like slowturn (stays running ~2.5s) with the SAME contextUsage in get_state, so a
//               short-timeout wait times out with the session still running and the OMP reading is LIVE
//               in pendingSnapshots[].contextUsage (mid-wait watch of a long session). [repro-context-usage]
// Launched via fake-omp.cmd (Windows) or fake-omp.sh (POSIX) through OMP_BIN; env is inherited.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MODE = process.env.FAKE_OMP_MODE || "pipebreak";
/** reaskturn 用:同一个后端进程里第几次收到 prompt(第 1 次故意答不合格)。 */
let reaskSeen = 0;

/** 所有"往 cwd 里写文件"的模式。写完之后各自还会再干点别的(自己提交 / 切走 HEAD / 弄坏 git 链接)。 */
const WRITE_MODES = [
  "writeturn", "writeturn-break", "writeturn-commit", "writeturn-detach",
  // 文件名**按 prompt 取**,于是同一棵工作树上跑 N 轮会留下 N 个不同的文件。
  // 用来考"一段对话 = 一条分支,N 轮的改动**全都在里面**"——固定文件名的 writeturn
  // 每轮互相覆盖,只能证明"最后一轮在",证不出前几轮的改动没丢。[对话方案 §10]
  "writeturn-perprompt",
  // 只建一个**空提交**,一个文件都不写:HEAD 前进了但净改动为零。
  // 用来考"首跑判 delivered、复用却因为 diff 是 0 字节而拒绝"这种前后打架。[W24]
  "writeturn-emptycommit",
];

// --- multiturn / multiturn-fast:**「已完成的请求又自己动起来」** 的防御性用例
//     起源是真机事故(omp + deepseek-v4-pro:一次委托被拆成多个内部 turn,桥在第一个 turn_end 就收结果,
//     拿到一个字符 "."),但那个**根因已经在协议层面修掉了** —— 现在桥以 `agent_end` 为完成边界,
//     真实 OMP 的多子轮形状由 `toolturns` 模式覆盖。
//     ⚠️ 如实标注这两个模式**现在测的是什么**:它们在**已经发过 agent_end 之后**又自行 turn_start。
//     真实 OMP 的 wire 会扣住中间的 agent_end、由后来的那个取代,只把最终一次交给 rpc 消费者
//     (agent-session.ts:#pendingAgentEndEmit),所以这已不是真实 OMP 的复刻,而是
//     **「后端违反协议时,桥的正文归属(generation)仍不能把上一轮的文本当本轮答案」** 这条防线。
//     钩子挂在 `get_last_assistant_text`(result() 必发的那次 RPC)上,所以复现是确定性的,不靠抢时序。
let multiturnStreaming = false;
let multiturnPhase = "idle"; // idle → first(第一轮已结束) → second(已重开) → done
let multiturnLastText = "."; // 真 omp 实现 get_last_assistant_text,这里如实回报当前正文(见下)
// lateterminal 模式:第二轮开头先发一个"迟到的"(属于上一轮的)**agent_end**(还带错误负载),
// 考两件事:桥会不会据此误判本轮已结束,以及它的错误会不会被记进本轮的健康字段
let turnstateStreaming = false; // turnstate 模式:请求完成后才翻成 true(制造状态不一致)
let lateturnCount = 0;
let lateturnStreaming = false;
// slowsettle 模式:和 slowturn 一样跑满 ~2.5s,但 get_state 会在 turn 真正结束时翻回"没在流"。
// ⚠️ 这个区别是必须的,不是锦上添花:slowturn 的 get_state **恒报 isStreaming:true**,而 OMP 的
// waitIdle 要的正是 `!isStreaming && turnStarted` —— 所以 slowturn 永远完不成一次 inline wait:true,
// 它只能用来造"正在跑"。要考"inline 时钟没被 join 默认污染"就必须有一个能真正收尾的慢桩。
let slowsettleStreaming = false;
const say = obj => process.stdout.write(JSON.stringify(obj) + "\n");

// deafstart:进程正常起来、正常收 stdin,但**一个字都不回**。用来造「open_session 请求确实发出去了,
// 结局却不明」——本地 RPC 超时,而后端可能已经把会话建起来了。这与「桥明确回报开不起来」是两回事:
// 后者可以放心把工作区当成没人在写,前者不行。[repro-graph-worktree W22]
if (MODE === "deafstart") {
  process.stdin.resume();
  setInterval(() => {}, 1 << 30); // 保持进程活着,别让事件循环排空
}

let buf = "";
process.stdin.on("data", d => {
  if (MODE === "deafstart") return; // 收下,但一个字都不回
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        if (MODE === "silent") continue; // half-dead: swallow the poll, never respond
        // Turns that settle idle (okturn/errturn/echoturn/ctxturn/logstress) must report NOT streaming, else
        // state() would flip status back to running after turn_end and the session would never settle for wait().
        // multiturn 自己管这个标志(见下方 multiturn 分支):第一轮 turn_end 后报"没在流",让会话真的 settle;
        // 注入 turn_start 之后报"在流",这样 wait 才会接着等第二轮,而不是又立刻 settle 一次。
        const isStreaming = MODE === "turnstate"
          ? turnstateStreaming
          : MODE === "lateterminal"
          ? lateturnStreaming
          : MODE === "slowsettle" || MODE === "partialslow"
          ? slowsettleStreaming
          : (MODE === "multiturn" || MODE === "multiturn-fast")
          ? multiturnStreaming
          : !(MODE === "okturn" || MODE === "errturn" || MODE === "echoturn" || MODE === "reaskturn" || WRITE_MODES.includes(MODE) || MODE === "ctxturn" || MODE === "logstress" || MODE === "badline" || MODE === "toolturns" || MODE === "agentenderr");
        const data = { isStreaming, queuedMessageCount: 0, sessionId: "fake", messageCount: 1 };
        // ctx* modes: real omp reports current-context occupancy in get_state.data (contextUsage sub-object
        // + isCompacting/autoCompactionEnabled siblings — see the probe dump). The bridge normalizes this to
        // the top-level contextUsage{tokens,contextWindow,live:true,isCompacting,autoCompactionEnabled}.
        if (MODE === "ctxturn" || MODE === "ctxslow") {
          data.contextUsage = { tokens: 12345, contextWindow: 1000000, percent: 1.2345 };
          data.isCompacting = false;
          data.autoCompactionEnabled = true;
        }
        say({ type: "response", id: msg.id, command: "get_state", success: true, data });
      } else if (msg.type === "prompt") {
        if (MODE === "rejectprompt") {
          // Refuse the prompt; no turn ever starts. The bridge's send() rejects and returns the
          // session to idle. A correct sessionSettled must then settle wait() (turnInFlight cleared
          // in send()'s catch), not dead-wait. Pre-turnInFlight (everPrompted) this dead-waited.
          say({ type: "response", id: msg.id, success: false, error: "fake-omp: prompt refused" });
          continue;
        }
        say({ type: "response", id: msg.id, success: true });
        if (MODE === "okturn" || MODE === "ctxturn") {
          // A clean, fully-settling turn with real answer text. Emit a benign STDERR line mid-turn so
          // tests can assert it does NOT become a fatal lastError (T4). Then agent_start -> text -> turn_end.
          process.stderr.write("[fake-omp] progress: thinking...\n");
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "OKTURN_ANSWER" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" }); // 整个请求结束(rpc 消费者的 idle 信号)
          }, 60);
        } else if (WRITE_MODES.includes(MODE)) {
          // **真往 cwd 里写一个文件**。用于验证 agent-bridge-graph 的 `access:"write"` worktree 隔离:
          // 桥用会话的 cwd 起后端,所以这里的 process.cwd() 就是该环节自己那棵工作树 ——
          // 写进去的内容必须只出现在它自己的分支上,别的环节和主工作区都看不见。
          // 文件名带上 prompt 的头几个字,这样多环节并发时能一眼看出"谁写的落在了谁那里"。
          say({ type: "agent_start" });
          const body = String(msg.message ?? "").slice(0, 200);
          let note;
          try {
            if (MODE === "writeturn-emptycommit") {
              // 一个文件都不写,只建空提交 —— HEAD 前进,净改动为零
              const gg = (a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
              gg(["-c", "user.name=fake-agent", "-c", "user.email=fake@agent.local",
                  "commit", "--allow-empty", "--no-verify", "-m", "empty commit by agent"]);
              note = "EMPTYCOMMIT_OK";
            } else if (MODE === "writeturn-perprompt") {
              // 每一轮一个自己的文件 —— 名字取自 prompt,于是 N 轮留下 N 处改动、互不覆盖
              const slug = (body.match(/[A-Za-z0-9._-]+/) || ["turn"])[0].slice(0, 40);
              fs.writeFileSync(path.join(process.cwd(), `wrote-${slug}.txt`), `${body}\n`, "utf8");
              note = "WROTE_OK";
            } else {
              fs.writeFileSync(path.join(process.cwd(), "wrote-by-node.txt"), `${body}\n`, "utf8");
              // 路径里带空格的那种文件 —— 用来验证 name-status 是按 TAB 切而不是按空白切
              if (process.env.FAKE_OMP_WRITE_EXTRA) {
                fs.writeFileSync(path.join(process.cwd(), "a file with spaces.txt"), `${body}\n`, "utf8");
              }
              note = "WROTE_OK";
            }
          } catch (e) { note = `WRITE_FAILED:${e.message}`; }
          // writeturn-break:写完文件后**弄坏这棵 worktree 的 git 链接**(worktree 里的 `.git` 是个
          // 写着 `gitdir: <repo>/.git/worktrees/<name>` 的文件)。用来注入"收工作区时 git 探测失败":
          // 此时既不能说有改动、也不能说没有,而错误的实现会把它当成"零改动"并**删掉工作树和分支**,
          // 把 agent 刚写出来的代码一起抹掉。
          // ⚠️ 不能用「删掉 .git」来注入:worktree 就落在主仓目录树**里面**(<repo>/.graph/wt/…),
          //    .git 一没,git 会**往上走**找到主仓的 .git,一切照常成功 —— 故障压根没注进去。
          //    必须把 gitfile 留着、但让它指向一个不存在的 gitdir,git 才会当场报 not a git repository。
          if (MODE === "writeturn-break") {
            // 注入结果要**如实回报**进答案正文:注入悄悄失败的话,整个 W11 会变成一条空绿断言
            // (什么都没坏,于是"没删代码"当然成立)。
            try {
              const gf = path.join(process.cwd(), ".git");
              // ⚠️ 必须**先删再建**:Windows 上 worktree 的 .git gitfile 带隐藏属性,
              // 直接 writeFileSync(flag "w") 打开隐藏文件会 EPERM —— 注入会悄悄失败。
              fs.rmSync(gf, { force: true });
              fs.writeFileSync(gf, `gitdir: ${path.join(process.cwd(), "__no_such_gitdir__")}\n`, "utf8");
              note += " BREAK_OK";
            } catch (e) { note += ` BREAK_FAILED:${e.message}`; }
          }
          // writeturn-commit / writeturn-detach:模拟**agent 自己动 git**。很多编码后端会自己
          // `git commit`;这时收工作区那边的暂存区是空的,把它当成"零改动"就会把它刚提交的成果
          // 连同分支一起删掉。detach 更进一步:提交完再把 HEAD 切走,交付物就不在我们声称的分支上了。
          // 注入结果同样**如实回报**进正文 —— 注入悄悄失败会让整条用例变成空绿。
          if (MODE === "writeturn-commit" || MODE === "writeturn-detach") {
            const gg = (args) => execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            try {
              gg(["add", "-A"]);
              gg(["-c", "user.name=fake-agent", "-c", "user.email=fake@agent.local",
                  "commit", "--no-verify", "-m", "agent's own commit"]);
              note += " SELFCOMMIT_OK";
              if (MODE === "writeturn-detach") {
                gg(["checkout", "--detach", "HEAD"]);
                note += " DETACH_OK";
              }
            } catch (e) { note += ` SELFCOMMIT_FAILED:${e.stderr || e.message}`; }
          }
          // 并发观测用:把这一轮拖长,好让测试有窗口采样到"两棵工作树同时存在"
          const delay = Number(process.env.FAKE_OMP_WRITE_DELAY_MS || 60);
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: `WRITETURN ${note} cwd=${process.cwd()}` } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
          }, Number.isFinite(delay) && delay >= 0 ? delay : 60);
        } else if (MODE === "reaskturn") {
          // 第 1 次故意答一段**不是 JSON** 的话(会被 outputShape 弱检查判不合格 → 打回重说),
          // 第 2 次答合格。于是这一轮以 `ok` 收场,但磁盘上**两次尝试各留下一份原件**,
          // 且两份内容不同 —— 复用这张回执时,"被打回的那一次写了什么"必须还看得见。
          reaskSeen++;
          const body = reaskSeen === 1
            ? "REASK_BAD_1 这次没按格式说"
            : `{"findings":["REASK_GOOD_${reaskSeen}"]}`;
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: body } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
          }, 60);
        } else if (MODE === "echoturn") {
          // Echo the received prompt back as the answer, so a test can confirm the exact prompt body
          // (e.g. a message_file's content) reached the backend.
          say({ type: "agent_start" });
          const echo = String(msg.message ?? "").slice(0, 2000);
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: `ECHO:${echo}` } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
          }, 60);
        } else if (MODE === "errturn") {
          // Turn completes IN ERROR: session returns to idle but the last-turn outcome is error, so
          // health must read "degraded" (not healthy) and lastError carries the reason.
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "turn_end", message: { stopReason: "error", errorMessage: "fake-omp: simulated turn error" } });
            say({ type: "agent_end" });
          }, 60);
        } else if (MODE === "partialslow") {
          // 中途**已经有部分文本**的慢 turn。slowturn 在终态之前一个 delta 都不吐,mid-result 的
          // textRef 会是 null,考不到"running 时 textRef 指向的是片段"这件事。
          slowsettleStreaming = true;
          say({ type: "agent_start" });
          setTimeout(() => say({ type: "message_update", message: { type: "text_delta", delta: "PARTIAL_" } }), 200);
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "FINAL" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
            slowsettleStreaming = false;
          }, 2500);
        } else if (MODE === "slowsettle") {
          // 慢,但会如实收尾:turn 结束时 get_state 才翻回"没在流",这才是真 omp 的样子。
          slowsettleStreaming = true;
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "SLOW_DONE" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
            slowsettleStreaming = false;
          }, 2500);
        } else if (MODE === "slowturn" || MODE === "ctxslow") {
          // Stay running long enough that a concurrent second send() is attempted mid-turn.
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "SLOW_DONE" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
          }, 2500);
        } else if (MODE === "logstress") {
          // Drive the diagnostic-log redaction/cap paths [repro-log-bounds]:
          // (a) a multi-byte character SPLIT ACROSS TWO stderr writes. Decoding each Buffer on its own
          //     turns this into two replacement characters; only a stream-level decoder survives it.
          const smile = Buffer.from("🙂", "utf8"); // f0 9f 99 82
          process.stderr.write(Buffer.concat([Buffer.from("[fake-omp] split:"), smile.subarray(0, 2)]));
          setTimeout(() => process.stderr.write(Buffer.concat([smile.subarray(2), Buffer.from(":end\n")])), 80);
          say({ type: "agent_start" });
          setTimeout(() => {
            // (b) a tool event whose `content` is a STRUCTURE: the tool name/id/type must survive, the
            //     text/output leaves inside must not.
            say({
              type: "tool_execution_end",
              toolCallId: "tc_1",
              toolName: "Bash",
              result: {
                content: [
                  { type: "tool_use", name: "Bash", id: "tu_1", text: `LEAK_BODY_${"q".repeat(3000)}` },
                  { type: "text", text: `LEAK_BODY_${"r".repeat(3000)}` },
                ],
                details: { isDirectory: false, resolvedPath: "/tmp/x", output: `LEAK_BODY_${"s".repeat(3000)}` },
              },
              isError: false,
            });
            // (c) a body buried PAST the recursion depth guard — must not reach disk verbatim.
            let deep = { text: "DEEP_SECRET_BODY", note: "DEEP_SECRET_SCALAR" };
            for (let d = 0; d < 14; d++) deep = { wrap: deep };
            say({ type: "message_end", deep });
            say({ type: "message_update", message: { type: "text_delta", delta: "LOGSTRESS_ANSWER" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
          }, 160);
        } else if (MODE === "lateterminal") {
          // 第一轮正常;**第二轮**一开头先吐一个"迟到的" **agent_end**(冒充上一轮请求的完成 ——
          // OMP 的事件不带 request id,桥分不出它属于哪一次),而且是在本轮 agent_start **之前**。
          // 桥若信了它 → 会话被判"已完成" → wait 把**上一轮**的正文当本轮答案交出去(静默错答)。
          // (注意这里发的必须是 agent_end 而不是 turn_end:按 OMP 协议 turn_end 本来就不代表请求结束,
          //  发 turn_end 考不到"误判完成"这件事。)
          lateturnCount += 1;
          if (lateturnCount === 1) {
            say({ type: "agent_start" });
            setTimeout(() => {
              say({ type: "message_update", message: { type: "text_delta", delta: "FIRST_ANSWER" } });
              say({ type: "turn_end" });
              say({ type: "agent_end" });
            }, 60);
          } else {
            lateturnStreaming = true;
            // ← 迟到的、属于上一次请求的完成事件,本轮还没 start。**带错误负载**:上一轮如果是失败的,
            //   迟到过来就是这个形状(事件不带 request id,桥分不出是谁的)。它既不能把本轮判成已结束,
            //   也不能把自己的错误记进本轮的健康字段 —— 后者要求"归属判定"跑在**任何**请求级写入之前,
            //   而不是先写完再拒收(先写后拒 → lastError 会留着上一轮的失败,本轮干净完成也洗不掉)。
            say({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "fake-omp: late foreign failure" }] });
            setTimeout(() => {
              say({ type: "agent_start" });
              say({ type: "message_update", message: { type: "text_delta", delta: "SECOND_ANSWER" } });
              say({ type: "turn_end" });
              say({ type: "agent_end" });
              lateturnStreaming = false;
            }, 500);
          }
        } else if (MODE === "badline") {
          // Emit lines that PARSE as JSON but are not objects. Reading `.type` off the `null` one
          // throws TypeError inside the bridge's rl "line" listener = uncaught = whole server dies.
          // Then a normal answer, so the test can prove the session still works afterwards.
          say({ type: "agent_start" });
          for (const poison of [null, 123, [], "just a string", true]) {
            try { process.stdout.write(`${JSON.stringify(poison)}\n`); } catch {}
          }
          try { process.stdout.write("{not json\n"); } catch {} // unparseable too, for good measure
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "BADLINE_ANSWER" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
          }, 60);
        } else if (MODE === "multiturn" || MODE === "multiturn-fast") {
          // 第一次请求正常完成(只吐了一个字符)。桥到此判定 settled、开始取正文 ——
          // 而后端会在**取正文的那次 RPC 期间**自己再开一轮(真机上是自动压缩/后续轮那类"无人再 prompt
          // 却自己动起来"的情形,OMP 源码注释里明说 agent_end 可能被更晚的一次取代)。
          multiturnStreaming = false;
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "." } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
            multiturnPhase = "first";
          }, 60);
        } else if (MODE === "agentenderr") {
          // **真实存在的错误路径**(omp 16.0.3 `pi-agent-core/src/agent.ts`:当被拦截的输出不是 "visible"
          // 那一支):直接发 `agent_end({messages:[errorMsg]})`,**一个 turn_end 都不发**。
          // 桥若只从 turn_end 取错误标志 → 这次失败会保留上一次的健康状态(报 healthy、lastError 为 null),
          // 即最坏的静默失败。
          say({ type: "agent_start" });
          setTimeout(() => {
            say({
              // `role:"assistant"` 是真实协议里 errorMsg 的形状(它就是一条被追加进历史的 assistant 消息)。
              // 桥在 messages[] 里找的是**最后一条 assistant**,不是数组末项 —— 这里带上 role,
              // 走的才是那条主路径而不是"无 role 就退回末项"的兼容分支。
              type: "agent_end",
              messages: [{ role: "assistant", stopReason: "error", errorMessage: "fake-omp: agent_end-only failure" }],
            });
          }, 60);
        } else if (MODE === "toolturns") {
          // **真实 OMP 的常态形状**(源码 agent-loop.ts:一次 prompt 会发出多组 turn_start→turn_end,
          // 工具/steering/后续轮全跑完才发 agent_end;agent-session.ts 更明说 rpc 消费者把 agent_end
          // 当作 "session is idle" 信号)。
          // 这里模拟:第一个子轮只吐半句就 turn_end(工具调用间隙),真正的答案在第二个子轮,
          // 最后才 agent_end。桥若把 turn_end 当请求结束 → 交出半句 "PARTIAL_"(静默截断)。
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "message_update", message: { type: "text_delta", delta: "PARTIAL_" } });
            say({ type: "turn_end" });            // ← 子轮结束,请求还没完
          }, 60);
          setTimeout(() => {
            say({ type: "turn_start" });          // ← 工具跑完,继续下一个子轮
            say({ type: "message_update", message: { type: "text_delta", delta: "TOOLTURNS_ANSWER" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });           // ← 到这里才是整个请求结束
          }, 700);
        } else if (MODE === "turnstate") {
          // 两阶段,专考 F7/F8 的「轮时钟不许自相矛盾」:
          //  ① 先**正常完成**一次请求(turn_start → 正文 → turn_end → agent_end)。到这里 turnEndedAt
          //     被真正写入、status 回 idle —— 这一步是让后面那条断言**有东西可测**。
          //  ② 然后**不发任何事件**,只让 get_state 单方面翻成 isStreaming:true(真实 omp 就有这种
          //     状态不一致,见 docs/BUG-omp-turn-state-inconsistency-2026-06-10.md)。桥的
          //     status()/state() 路径会把 status 翻成 running,而结束戳仍然留着 ——
          //     「running + endedAt」这个矛盾正是 F8(状态感知的 lastTurnOf)必须压住的。
          //  ⚠️ 老版本在 turn_end 就 settle、从不发 agent_end,于是 turnEndedAt **压根不会被写**,
          //     F8 的门控删掉测试照样绿(空绿)。这个顺序不能倒过来。
          turnstateStreaming = false;
          say({ type: "agent_start" });
          setTimeout(() => {
            say({ type: "turn_start" });
            say({ type: "message_update", message: { type: "text_delta", delta: "TURNSTATE_ANSWER" } });
            say({ type: "turn_end" });
            say({ type: "agent_end" });
            // 请求已结束、时钟已写入;稍后再让 get_state 自说自话地报"还在流"
            setTimeout(() => { turnstateStreaming = true; }, 400);
          }, 60);
        } else {
          say({ type: "agent_start" });
        }
      } else if (MODE === "multiturn-fast" && msg.type === "get_last_assistant_text") {
        // ★★ 比 multiturn **更毒**的形状,专门打「只复核 settled、不复核 generation」这个洞:
        //    后端在**同一次 RPC 之内**把整整一轮跑完 —— turn_start → 新正文 → turn_end 一次性发完,
        //    **然后才**回复这次 get_last_assistant_text,而且回的是**旧**正文。
        //    于是桥复核时:状态又是 idle(settled 成立!),generation 却已经变了。
        //    只看 settled 的实现会把旧的半句 "." 当成答案交出去,还会把它写进 answerFile。
        //    multiturn 那个模式把第二轮拖了 400ms,复核时仍是 running,所以**盖不到**这一支。
        if (multiturnPhase !== "first") {
          say({ type: "response", id: msg.id, success: true, data: { text: multiturnLastText } });
          continue;
        }
        multiturnPhase = "done";
        say({ type: "turn_start" });
        say({ type: "message_update", message: { type: "text_delta", delta: "MULTITURN_ANSWER" } });
        say({ type: "turn_end" });
        say({ type: "agent_end" });
        multiturnLastText = "MULTITURN_ANSWER";
        // ⚠️ 回的是**旧**正文:真 omp 的这次 RPC 在新一轮开始前就被受理了,拿回来的自然是上一轮的文本。
        //    这正是"无法归属到当前 generation 的文本"——桥不得使用它。
        say({ type: "response", id: msg.id, success: true, data: { text: "." } });
      } else if (MODE === "multiturn" && msg.type === "get_last_assistant_text") {
        // 真 omp 是**实现**这个命令的(会如实返回当前的助手正文),所以这里也如实返回 —— 不能像别的
        // mode 那样敷衍成 `data:{}`。否则桥会走 `full = text || lastAssistantText` 的回退分支,
        // 把上一段内部 turn 的正文重新写回(agent-bridge.mjs:2242 的陈旧写回),
        // 测试就会把**桥的一个 bug**当成期望值锁进断言里。
        const reply = () => say({ type: "response", id: msg.id, success: true, data: { text: multiturnLastText } });
        if (multiturnPhase !== "first") { reply(); continue; }
        // ★ 这里就是真机那个竞态窗口:桥已经判定 settled,正在 await 这次取文本 ——
        //   后端就在此刻自己重开了一轮。**先发 turn_start 再回响应**,顺序必须是这个。
        multiturnPhase = "second";
        multiturnStreaming = true;
        say({ type: "turn_start" });
        reply(); // 此刻如实回报的仍是第一段那个 "." —— 收下它就是真机那次事故(charCount:1)
        // 第二轮才是真答案;完事后回到"没在流",会话正常 settle
        setTimeout(() => {
          say({ type: "message_update", message: { type: "text_delta", delta: "MULTITURN_ANSWER" } });
          say({ type: "turn_end" });
          say({ type: "agent_end" });
          multiturnLastText = "MULTITURN_ANSWER";
          multiturnStreaming = false;
          multiturnPhase = "done";
        }, 400);
      } else if (msg.type === "abort") {
        // 真 omp 被 abort 之后就不再流式了。桩必须照做 —— 否则 get_state 会在 abort 之后继续谎报
        // isStreaming:true,桥每次 refreshStatus 都把状态翻回 running,会话看起来永远在跑。
        // 只清 slowsettle 这一族的标志:turnstate **故意**在轮结束后仍报 streaming(那是它存在的
        // 理由),lateterminal 也自有节奏,都不能在这里被顺手改掉。
        slowsettleStreaming = false;
        if (msg.id) say({ type: "response", id: msg.id, command: "abort", success: true, data: {} });
      } else if (msg.id) {
        say({ type: "response", id: msg.id, success: true, data: {} });
      }
    } catch {}
  }
});
process.stdin.on("error", () => {});

say({ type: "ready" });

if (MODE === "pipebreak") {
  setTimeout(() => {
    process.stderr.write("[fake-omp] destroying my stdin now, staying alive\n");
    process.stdin.destroy();
  }, 3000);
}

setTimeout(() => process.exit(0), 60000);
