# Agent Bridge 安装与使用

这份文档面向想把 Agent Bridge 装进 Codex 或 Claude Code 并实际调用 OMP/Codex 的用户。

Agent Bridge 是一个 session-first 的 MCP 桥接器，注册到 Codex 或 Claude Code 后使用。它不是一次性命令封装，而是让客户端先打开一个持久会话，再向同一个会话连续发送消息，最后显式关闭会话。

## 1. 前置依赖

确认本机有这些命令：

```sh
node --version
codex --version
omp --version
```

最低要求：

- Node.js 20 或更高
- 一个 MCP 客户端：Codex（CLI 或 app）或 Claude Code
- OMP 已安装，并且 `omp` 在 PATH 中（如果要委托给 OMP）
- Codex 已安装，并且 `codex` 在 PATH 中（如果要委托给 Codex）

**必须先装好要委托的 coding agent。** Agent Bridge 只是桥接到 OMP / Codex，本身不包含也不会自动安装它们。如果对应后端没装，session 根本无法启动。请先把你打算委托的后端装好，再用 `node scripts/agent-bridge.mjs doctor` 确认每个后端都被检测到。

如果 OMP 或 Codex 不在 PATH 中，可以用环境变量覆盖：

```sh
export OMP_BIN="$HOME/.local/bin/omp"
export CODEX_BIN="$(command -v codex)"
```

## 2. 获取项目

```sh
mkdir -p "$HOME/projects"
cd "$HOME/projects"
git clone https://github.com/LeoWang329/agent-bridge.git
cd agent-bridge
```

先做本地检查：

```sh
node --check scripts/agent-bridge.mjs
node scripts/agent-bridge.mjs doctor
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node scripts/agent-bridge.mjs mcp
```

`doctor` 里应该看到类似：

```text
Agent Bridge 0.7.0
omp: ok (...) omp/15.9.1
codex: ok (...) codex-cli 0.137.0
```

## 两种安装身份:消费者 vs 维护者(先分清)

Agent Bridge「直接从 clone 运行」——MCP server 与 skill 软链都指向某个 clone，`git pull` 即更新。这对**消费者**很省事，但对**维护者**有个坑。先确认你是哪种，后面各节的 `<REPO>` 就填对应 clone：

- **消费者**（只用、不改）：把 agent 指向你 clone 的仓库即可。你不编辑它，「从 clone 运行」就是安全的；升级就 `git pull`（拉的是已发布的 main）。**下面各节默认按消费者写，`<REPO>` = 你的 clone。**
- **维护者 / 贡献者**（你要改 Agent Bridge 本身）：**不要**让日常 agent 指向你的**开发工作树**——skill 每次会话重读、MCP server 重启即重载，你**没提交、没测过**的中间改动会立刻在你所有项目里 live。用**两个 clone 分离**：

  | clone | 位置（示例） | 谁指向它 | 何时前进 |
  |---|---|---|---|
  | **开发 clone** | `D:\code\agent-bridge` | 无（日常 agent 不指它） | 你随时改、commit/push |
  | **稳定安装 clone** | `%USERPROFILE%\tools\agent-bridge` | 日常 agent 的 MCP 注册 + skill 软链 | 只在你**主动 `git pull`**（拉已 push/已测的 main）时 |

  后面各节的 `<REPO>` **填稳定安装 clone 的绝对路径**；开发 clone 只用于开发与分发源。想 dogfood 未发布的改动时，再**刻意**在开发 clone 里测（例如用仓库自带的 project 级 `.mcp.json`，它的相对路径正好指开发工作树），而不是让它默默全局生效。

## 适配不同 agent:各 agent 的要求

Agent Bridge 两块东西，**适配范围不同**：

- **MCP server（工具）= 通用**：任何支持 stdio MCP 的客户端都能注册 `node <REPO>/scripts/agent-bridge.mjs mcp`，拿到全部 `agent_bridge_*` 工具。
- **skills（使用指引）= 仅 Claude Code / Codex**：`skills/*/SKILL.md` 是这两家的 skill 约定，别的客户端不会自动加载（工具照用，只是少了「何时该委托」的判断指引——可把 SKILL.md 当普通文档喂给它）。

| agent | 注册 MCP（工具） | skill 目录 | 工具命名空间 | 生效 |
|---|---|---|---|---|
| **Claude Code** | `claude mcp add agent-bridge --scope user -- node "<MJS>" mcp`（写入用户配置） | `~/.claude/skills/<name>/`（软链，裸名、无命名空间） | `mcp__agent-bridge__agent_bridge_*` | 重启客户端 |
| **Codex** | `codex mcp add agent-bridge -- node "<MJS>" mcp`（写入 `~/.codex/config.toml`） | `~/.codex/skills/<name>/`（软链） | `agent_bridge_*`（裸名） | 重启 Codex |
| **其它 MCP 客户端**（Cursor / Cline / Windsurf …） | 在该客户端 MCP 配置里加一个 stdio server：命令 `node`、参数 `["<MJS>","mcp"]` | 无自动 skill 机制——按需把 `skills/agent-bridge/SKILL.md` 作为文档提供 | 由该客户端定（多为 `agent_bridge_*`） | 按该客户端方式重载 |

`<MJS>` = `<REPO>/scripts/agent-bridge.mjs` 的**绝对路径**（维护者填**稳定安装 clone**，见上一节）。后端（omp/codex/claude）是否可用以 `node "<MJS>" doctor` 为准。一律用**绝对路径**，别用 `$PWD`——agent 的 shell 通常不在仓库根。

## 3. 安装到 Codex

Codex 分两步：注册 MCP server（工具），再把 skill 链接进 Codex 的 skill 目录。两者都直接指向这个 clone，`git pull` 即更新，无需重装。下文 `<REPO>` = 这个 clone 的绝对路径。

注册 MCP server：

```sh
codex mcp add agent-bridge -- node "<REPO>/scripts/agent-bridge.mjs" mcp
```

链接 skill（用软链/junction，不要拷贝，这样跟随仓库）：

```sh
# macOS / Linux
ln -s "<REPO>/skills/agent-bridge"            ~/.codex/skills/agent-bridge
ln -s "<REPO>/skills/agent-bridge-dev"        ~/.codex/skills/agent-bridge-dev        # 可选：委托角色编排 companion
ln -s "<REPO>/skills/agent-bridge-roundtable" ~/.codex/skills/agent-bridge-roundtable # 可选：N 席圆桌审议
ln -s "<REPO>/skills/agent-bridge-loop"       ~/.codex/skills/agent-bridge-loop       # 可选：合同驱动交付循环

# Windows — junction，免管理员
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge"            "<REPO>\skills\agent-bridge"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-dev"        "<REPO>\skills\agent-bridge-dev"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-roundtable" "<REPO>\skills\agent-bridge-roundtable"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-loop"       "<REPO>\skills\agent-bridge-loop"
```

重启 Codex，确认能看到：

```sh
codex mcp list | rg agent-bridge
```

你应该看到一个名为 `agent-bridge` 的 MCP server；skill 列表里应出现 `agent-bridge`（以及 `agent-bridge-dev`，若你链接了）。以后移除：`codex mcp remove agent-bridge`，并删掉上面的软链。

## 4. Codex CLI 验证

运行一个不会发送任务 prompt 的只读 smoke test：

```sh
codex -a never -s danger-full-access -C "$PWD" exec --json --skip-git-repo-check \
  '这是 agent-bridge 的只读 smoke test。请只使用 agent_bridge MCP 工具，不要运行 shell 命令，不要发送实际任务 prompt 给 OMP 或 Codex。调用 agent_bridge_doctor；打开 agent=omp write=false 的 session，调用 status，关闭；打开 agent=codex write=false 的 session，调用 status，关闭；最后报告两个 session_id 和是否已关闭。'
```

这个测试只会启动、查看、关闭会话，不会让 OMP/Codex 执行具体任务。

## 5. 在 Claude Code 中使用

Agent Bridge 是标准的 stdio MCP server，和 Codex 用的是同一套 MCP 协议，所以 Claude Code 无需改任何代码即可使用，只需要注册这个 server。同样需要先装好后端 coding agent（见第 1 节）。

在 Claude Code 里，这些工具会带命名空间前缀，例如 `mcp__agent-bridge__agent_bridge_open_session`、`mcp__agent-bridge__agent_bridge_send_message`。

### 5.1 项目级（仅当前仓库）

Claude Code 会自动识别仓库根目录的 `.mcp.json`。在仓库根目录运行 `claude`，按提示批准 `agent-bridge` server，然后确认：

```sh
claude mcp list
```

仓库自带的 `.mcp.json` 用的是相对路径（`./scripts/agent-bridge.mjs`），所以项目级注册只在「从仓库根目录启动 Claude Code」时才能解析到。

### 5.2 用户级（任意目录可用，推荐）

用绝对路径注册一次，之后在任何目录的 Claude Code 会话里都能用：

```sh
claude mcp add agent-bridge --scope user -- node "$PWD/scripts/agent-bridge.mjs" mcp
```

在仓库根目录执行这条命令，`$PWD` 会展开成绝对路径。以后想移除：

```sh
claude mcp remove agent-bridge --scope user
```

### 5.3 安装 skill

`skills/` 下的中文使用指引与 Claude Code skill 兼容，软链到用户 skill 目录即可（`agent-bridge` 是桥用法指引；可选 companion：`agent-bridge-dev` 委托角色编排、`agent-bridge-roundtable` N 席圆桌审议、`agent-bridge-loop` 合同驱动交付循环）：

```sh
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/agent-bridge"            ~/.claude/skills/agent-bridge
ln -sfn "$PWD/skills/agent-bridge-dev"        ~/.claude/skills/agent-bridge-dev        # 可选
ln -sfn "$PWD/skills/agent-bridge-roundtable" ~/.claude/skills/agent-bridge-roundtable # 可选
ln -sfn "$PWD/skills/agent-bridge-loop"       ~/.claude/skills/agent-bridge-loop       # 可选
```

不装 skill 也能直接调用 MCP 工具，skill 只是补充「何时该委托」的判断指引。会话流程（open → send → status/result → 复用 → close）以及写权限、清理规则都与 Codex 完全一致。

## 6. 使用方式

会话**只能**通过 MCP 工具管理。会话活在你这个客户端启动的 `agent-bridge mcp` 进程内：该进程直接 spawn 并持有你打开的 OMP/Codex 后端。没有共享后台 daemon，也没有 Web UI——客户端退出，这个 MCP 进程随之退出，它持有的所有后端会话被一并清理（v0.7.0，详见 [docs/ARCHITECTURE.md](ARCHITECTURE.md)）。

Codex 使用 Agent Bridge 时应该遵循这个流程：

1. `agent_bridge_open_session`
2. `agent_bridge_send_message`（**默认非阻塞**，立刻返回 ack；快任务可显式传 `wait:true` 内联阻塞）
3. `agent_bridge_wait`（收结果主力，建议设短 `timeout_ms`，如 5~10 分钟：没完会返回当前状态，可看进展后再等）
4. `agent_bridge_status` / `agent_bridge_result`（随时查进度；`status` **不传 `session_id`** 时列出本客户端 MCP 进程里的全部会话——它们都属于你，会话不再跨客户端共享）
5. `agent_bridge_close_session`

并行多个 session 时：对每个 session `agent_bridge_send_message`（默认非阻塞），再调**一次** `agent_bridge_wait` 收口——`mode:"all"` 等全部完成，`mode:"any"` 第一个完成即返回（用 `pending` 里剩下的 id 再调一次，即可按完成顺序逐个处理），省去循环轮询 `agent_bridge_status`。

典型只读委托：

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```

然后把任务发给同一个 `session_id`：

```json
{
  "session_id": "omp-...",
  "message": "请只读代码，帮我审查这个模块的潜在问题。不要修改文件。",
  "wait": true
}
```

需要 Codex 时，把 `agent` 换成 `codex`（会启动 `codex app-server`，逐 token 流式返回；只读用 `sandbox: read-only`，写用 `sandbox: workspace-write`——**Windows 上写档改用 `danger-full-access`**，因 codex 的 Windows 沙箱会破坏 apply_patch（上游 bug），此时为软边界，同 omp/claude；均为非交互）：

```json
{
  "agent": "codex",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```

可以在**打开会话时**指定模型与推理强度。模型是会话级参数：在 `agent_bridge_open_session` 时用 `model` 指定，整个会话内固定，`agent_bridge_send_message` 不能逐条切换；想换模型就新开一个 session。`model` 会原样传给后端的 `--model`，取值格式由后端决定。OMP 尤其可以通过 `omp --model <name>` 触达多种模型（如 `deepseek-v4-pro`、`minimax-m3`、`claude`、`gpt`）。可选的 `effort` 在 OMP 映射为 `--thinking`（`minimal|low|medium|high|xhigh`），在 Codex 作为该轮的 effort（`none|minimal|low|medium|high|xhigh`）传入。不传 `model` / `effort` 时使用后端默认值。

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "<模型名>",
  "effort": "high"
}
```

## 7. CLI

会话只能通过 MCP 工具管理；CLI 只剩三条命令：server 入口加两个运维辅助命令。**没有任何会话命令（`open`/`send`/`status`/…），也没有 daemon/UI 命令**——它们在 v0.7.0 随会话搬进 MCP 进程后被移除。

```sh
node scripts/agent-bridge.mjs mcp        # 运行 MCP server（stdio）——会话活在这个进程里
node scripts/agent-bridge.mjs doctor     # 报告后端可用性（omp/codex）
node scripts/agent-bridge.mjs cleanup    # 回收被 kill 的 MCP server 残留的 omp/codex 孤儿子进程
```

`mcp` 由 MCP 客户端自动拉起，不用手动跑。`cleanup` 是安全网：只终止那些「owning MCP server 已经不在了」（例如被 `kill -9`）的后端子进程，并清理它们的 pid record；仍由活着的 `agent-bridge mcp` 进程持有的子进程不会被动到。

```sh
node scripts/agent-bridge.mjs cleanup --json
```

## 8. 写权限模式

默认使用 `write: false`。适合：

- 代码审查
- 问题定位
- 方案设计
- 第二代理独立复核

只有当用户明确要让代理改文件时，才传：

```json
{
  "write": true
}
```

写权限模式会启用高权限参数：

- OMP：`--auto-approve --approval-mode yolo`
- Codex：`sandbox: workspace-write`（Windows 上为 `danger-full-access`，见上）（`approvalPolicy: never`）

让委托代理改完后，Codex 自己仍然应该检查 git diff、运行测试，再向用户报告。

## 9. 会话和进程清理

正常关闭会话：

```json
{
  "session_id": "..."
}
```

调用 `agent_bridge_close_session` 后：

- OMP 的 `omp --mode rpc` 会退出
- Codex 的 `codex app-server` 会退出

MCP server 进程**直接持有**它打开的会话（不再代理给任何 daemon）。当它退出时（客户端退出 / stdin 关闭 / `SIGTERM`、`SIGINT`、`SIGHUP` / stdout `EPIPE` / 未捕获异常），会清理自己持有的所有 OMP/Codex 子进程。stdin 关闭时它会先等 pending MCP 响应写完再退出。优雅退出（code 0）还会删除本次 run 的日志目录 `~/.agent-bridge/logs/<runId>/`；崩溃（code≠0）保留以便排查。仍然建议在任务完成后显式调用 `agent_bridge_close_session`。

如果 Agent Bridge 被 `kill -9` 硬杀，清理逻辑来不及执行。此时它会依赖 `~/.agent-bridge/pids/` 里的 pid record，在下一次 MCP server 启动（或手动 `cleanup`）时回收上次残留的 OMP/Codex 子进程。

只有活着的 `agent-bridge mcp` 进程会被识别为 pid record owner，`cleanup` 不会误杀它仍在使用的 OMP/Codex 子进程；只回收 owner 已经死掉的孤儿子进程。

检查是否有残留：

```sh
ps -axo pid,ppid,command | rg 'agent-bridge|omp --mode rpc|codex app-server' || true
find "$HOME/.agent-bridge/pids" -type f -maxdepth 1 -print 2>/dev/null || true
```

## 10. 升级

MCP server 和 skill 都直接指向这个 clone，`git pull` 即完成升级，无需重装（**维护者**：在**稳定安装 clone** 里 `git pull`——那才是日常 agent 消费的副本；开发 clone 的未提交改动不该经此上线，见「两种安装身份」）：

```sh
cd "$HOME/projects/agent-bridge"
git pull
node --check scripts/agent-bridge.mjs
node scripts/agent-bridge.mjs doctor
node scripts/agent-bridge.mjs cleanup
```

然后**重启客户端**以重载正在运行的 MCP server（skill 下次启动自动重读），并确认：

```sh
codex mcp list | rg agent-bridge   # 或 claude mcp list
```

## 11. 卸载

注销 MCP server，并删除 skill 软链：

```sh
codex mcp remove agent-bridge                          # 或 claude mcp remove agent-bridge --scope user
rm -f ~/.codex/skills/agent-bridge  ~/.codex/skills/agent-bridge-dev  ~/.codex/skills/agent-bridge-roundtable  ~/.codex/skills/agent-bridge-loop
rm -f ~/.claude/skills/agent-bridge ~/.claude/skills/agent-bridge-dev ~/.claude/skills/agent-bridge-roundtable ~/.claude/skills/agent-bridge-loop
```

如果不再使用 Agent Bridge，也可以删除本地状态目录：

```sh
rm -rf "$HOME/.agent-bridge"
```

## 12. 常见问题

### `agent_bridge_doctor` 找不到 OMP

设置：

```sh
export OMP_BIN="$HOME/.local/bin/omp"
```

然后重启 Codex。

### `agent_bridge_doctor` 找不到 Codex

设置：

```sh
export CODEX_BIN="$(command -v codex)"
```

然后重启 Codex。

### Codex 看不到 `agent-bridge`

重新注册 MCP server 并重启 Codex，然后检查：

```sh
codex mcp add agent-bridge -- node "<REPO>/scripts/agent-bridge.mjs" mcp
codex mcp list | rg agent-bridge
```

### session 还在运行但不需要了

优先调用：

```text
agent_bridge_close_session
```

如果 Codex 已经退出，下一次 Agent Bridge MCP server 启动会清理上次记录的残留进程。
