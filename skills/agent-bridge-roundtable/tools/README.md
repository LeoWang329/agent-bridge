# 圆桌主席工具(可选省力封装)

两个零依赖 node 脚本(仅 Node 内建),把主席手工的机械记账收成一条命令。**它们不改 `EVENTS.md` schema**——只是 writer 的省力封装;手工「`cp` + `grep` + append」三步路径仍然有效、作为降级保留。

> **路径**:主席的 cwd 是**目标仓库**、不是本 skill 目录,调用须用 harness 给的 base directory 绝对前缀:`node <base>/tools/seat-turn.mjs …`(同 `<base>/viz/serve.mjs`)。下面示例里的 `<base>` 即该绝对路径;只有当你恰好 `cd` 到 skill 根目录时才能省成相对 `tools/…`。

> **单 writer 纪律**:真理源 `transcript.jsonl` 只有主席一个 writer。两个脚本都用**目录锁**(`<run-dir>/.transcript.lock`)串行化,防止意外并发导致 seq 竞争——但你仍应**串行调用**,别并发跑。

## `seat-turn.mjs` — 收口一个席位一轮

替代「cp textRef → 泄漏扫描 → append `turn:produced`」三步:

```
node <base>/tools/seat-turn.mjs <run-dir> \
  --seat p1 --round 0 \
  --text-ref "<桥返回的 textRef 绝对路径>" \
  --agent omp --model deepseek/deepseek-v4-pro \
  --summary "主席一句话摘要" \
  [--extra-names "MiniMax-M3,glm"]     # 本场在座模型名,并入裸厂商名扫描
  [--vendor-topic]                     # 议题合法涉及后端/厂商名时:全部命中降为非阻塞 WARN(见下)
```

- `--seat` 须形如 `p<数字>`(如 `p1`);`--round` 非负整数(二者拼进文件路径,已校验挡穿越)。
- `--agent` 取本场后端(当前:`omp` / `codex` / `claude` / `cursor`);`--model` **可选**——省略时 `turn:produced.payload.model` 记为 `null`(后端用默认模型)。
  - **cursor 席**:内置黑名单只放家族/厂商级名(已含 `grok`/`xai`/`gemini`/`gpt`/`claude`…);该席实际在跑的模型/家族若不在表内(如 Google 系的 `google`/`deepmind`、或某具体模型名),用 `--extra-names` 逐席带上,别往全局黑名单塞高频词。
- **先扫源、再落盘**:先对 `--text-ref` 做泄漏扫描,**干净才** `cp` 字节直传 → `<run-dir>/rounds/<seat>-r<round>.md`(0 改写);阻断级命中 → **`exit 2` 且不写 `rounds/`**(源文件也不动,主席让该席重述或点状遮盖后重跑)。
- **泄漏扫描分两类**(治「厂商名出现 ≠ 席位自我指认」的混淆):
  - **自我指认(self-ID)**:点名(`作为 codex`/`我是 gpt`/`as a claude`)+ **不点名**(`作为一个语言模型`/`我的知识截止`/`as an AI`)——这才是打穿匿名的真信号;不点名那类是整词厂商黑名单**挡不住**的漏网(dogfood 2026-07-15 发现)。
  - **裸厂商名(vendor)**:内置黑名单 + `--extra-names`,**整词、大小写不敏感**(等效 `grep -aiwE`);黑名单**不含桥后端名 `omp`**(易误伤正文,如 `component`)。可能是自指、也可能只是**议题内容**(如「codex 的沙箱是硬只读」)。
- **阻断策略**:**默认**(普通议题)自指 **或** 裸厂商名任一命中 → `exit 2` 阻断;**`--vendor-topic`**(议题合法涉及后端/厂商名,如"讨论 agent 后端本身")→ 全部命中降为**非阻塞 WARN**、**照常 cp+append**,把命中(自指嫌疑优先)surfaced 给主席**人工核对**。**诚实边界**:扫描是启发式地板不是天花板;`--vendor-topic` 关掉自动阻断后靠主席人工自指审查(工具只给候选清单)。若议题恰是匿名机制**本身**(正文会把「作为一个语言模型」当例子引用),连自指启发式也会误报——主席逐条判 WARN。
- 干净(或 `--vendor-topic`)后 append `turn:produced`(自动算 seq/ts/charCount)。

**exit code**:`0`=成功(含 `--vendor-topic` 下仅 WARN);`1`=用法/IO 错;`2`=检测到阻断级身份泄漏。

## `rt-event.mjs` — 通用事件追加器

其它事件(`round:started`/`coverage`/`disagreement`/`schedule:decision`/`human:*`…)的省力 append:

```
node <base>/tools/rt-event.mjs <run-dir> <event> <round>     # payload 从 stdin 读 JSON(空 = {})
node <base>/tools/rt-event.mjs <run-dir> --batch             # stdin 每行一个 {event,round,payload},批量 append
```

`rtId` 从 run-dir 目录名(basename)推导,不用传;`seq` 读现有 max+1(半行安全);`ts`=epoch ms。
`seat-turn.mjs` 复用它导出的 `appendEvents()`——两脚本共享同一份 append/seq/锁实现,不重复造轮子。
