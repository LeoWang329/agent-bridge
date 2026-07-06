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
  [--extra-names "MiniMax-M3,glm"]     # 本场在座模型名,并入泄漏黑名单
```

- `--seat` 须形如 `p<数字>`(如 `p1`);`--round` 非负整数(二者拼进文件路径,已校验挡穿越)。
- `--agent` 取本场后端(当前:`omp` / `codex` / `claude`);`--model` **可选**——省略时 `turn:produced.payload.model` 记为 `null`(后端用默认模型)。
- **先扫源、再落盘**:先对 `--text-ref` 做泄漏扫描,**干净才** `cp` 字节直传 → `<run-dir>/rounds/<seat>-r<round>.md`(0 改写);命中泄漏 → **`exit 2` 且不写 `rounds/`**(源文件也不动,主席让该席重述或点状遮盖后重跑)。
- 泄漏扫描:内置厂商黑名单 + `--extra-names`,**整词、大小写不敏感**(等效 `grep -aiwE`)。黑名单**不含桥后端名 `omp`**(易误伤正文,如 `component`)。
- 干净后 append `turn:produced`(自动算 seq/ts/charCount)。

**exit code**:`0`=成功;`1`=用法/IO 错;`2`=检测到身份泄漏。

## `rt-event.mjs` — 通用事件追加器

其它事件(`round:started`/`coverage`/`disagreement`/`schedule:decision`/`human:*`…)的省力 append:

```
node <base>/tools/rt-event.mjs <run-dir> <event> <round>     # payload 从 stdin 读 JSON(空 = {})
node <base>/tools/rt-event.mjs <run-dir> --batch             # stdin 每行一个 {event,round,payload},批量 append
```

`rtId` 从 run-dir 目录名(basename)推导,不用传;`seq` 读现有 max+1(半行安全);`ts`=epoch ms。
`seat-turn.mjs` 复用它导出的 `appendEvents()`——两脚本共享同一份 append/seq/锁实现,不重复造轮子。
