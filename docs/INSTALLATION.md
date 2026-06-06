# Agent Bridge 安装与使用

这份文档面向想把 Agent Bridge 装进 Codex 或 Claude Code 并实际调用 OMP/Codex 的用户。

Agent Bridge 是一个 session-first 的 MCP 桥接器（可作为 Codex 插件使用，也可以直接注册到 Claude Code）。它不是一次性命令封装，而是让客户端先打开一个持久会话，再向同一个会话连续发送消息，最后显式关闭会话。

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
Agent Bridge 0.3.0
omp: ok (...) omp/15.9.1
codex: ok (...) codex-cli 0.137.0
```

## 3. 安装到 Codex

Agent Bridge 是一个 Codex plugin，推荐通过 personal marketplace 安装。

把项目链接到本机 personal plugin 目录：

```sh
mkdir -p "$HOME/plugins"
ln -sfn "$HOME/projects/agent-bridge" "$HOME/plugins/agent-bridge"
```

如果你还没有 personal marketplace，或不确定里面是否已经有 `agent-bridge`，用下面脚本创建/更新。它会保留已有插件，只插入或更新 `agent-bridge`：

```sh
mkdir -p "$HOME/.agents/plugins"
python3 - <<'PY'
import json
from pathlib import Path

marketplace = Path.home() / ".agents" / "plugins" / "marketplace.json"
if marketplace.exists():
    data = json.loads(marketplace.read_text())
else:
    data = {
        "name": "personal",
        "interface": {"displayName": "Personal"},
        "plugins": [],
    }

entry = {
    "name": "agent-bridge",
    "source": {
        "source": "local",
        "path": "./plugins/agent-bridge",
    },
    "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    },
    "category": "Productivity",
}

plugins = [plugin for plugin in data.get("plugins", []) if plugin.get("name") != "agent-bridge"]
plugins.append(entry)
data["plugins"] = plugins
marketplace.write_text(json.dumps(data, indent=2) + "\n")
print(marketplace)
PY
```

安装插件：

```sh
codex plugin add agent-bridge@personal
```

确认 Codex 能看到它：

```sh
codex plugin list | rg agent-bridge
codex mcp list | rg agent-bridge
```

你应该看到 `agent-bridge@personal installed, enabled`，以及一个名为 `agent-bridge` 的 MCP server。

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

### 5.3 可选：安装 skill

`skills/agent-bridge/SKILL.md` 里的中文使用指引与 Claude Code skill 兼容，软链到用户 skill 目录即可：

```sh
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/agent-bridge" ~/.claude/skills/agent-bridge
```

不装 skill 也能直接调用 MCP 工具，skill 只是补充「何时该委托」的判断指引。会话流程（open → send → status/result → 复用 → close）以及写权限、清理规则都与 Codex 完全一致。

## 6. 使用方式

Codex 正式调用 Agent Bridge 时，应该优先使用 MCP 工具。CLI facade 主要给人类调试、smoke test、清理残留进程、临时操作使用。

从 0.3.0 开始，MCP tools、CLI facade、Web UI monitor 共享同一个本地 daemon/session manager。Codex 通过 MCP 打开的 session 可以在 UI 中看到，也可以用 CLI 查看或关闭。

Codex 使用 Agent Bridge 时应该遵循这个流程：

1. `agent_bridge_open_session`
2. `agent_bridge_send_message`
3. `agent_bridge_status`
4. `agent_bridge_result`
5. `agent_bridge_close_session`

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

需要 Codex 时，把 `agent` 换成 `codex`（会启动 `codex app-server`，逐 token 流式返回；只读用 `sandbox: read-only`，写用 `sandbox: workspace-write`，均为非交互）：

```json
{
  "agent": "codex",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```

可以在**打开会话时**指定模型与推理强度。模型是会话级参数：在 `agent_bridge_open_session` 时用 `model` 指定，整个会话内固定，`agent_bridge_send_message` 不能逐条切换；想换模型就新开一个 session。`model` 会原样传给后端的 `--model`，取值格式由后端决定。OMP 尤其可以通过 `omp --model <name>` 触达多种模型（如 `deepseek-v4-pro`、`claude`、`gpt`）。可选的 `effort` 在 OMP 映射为 `--thinking`（`minimal|low|medium|high|xhigh`），在 Codex 作为该轮的 effort（`none|minimal|low|medium|high|xhigh`）传入。不传 `model` / `effort` 时使用后端默认值。

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "<模型名>",
  "effort": "high"
}
```

## 7. CLI facade

CLI facade 会自动启动一个本地 Agent Bridge daemon，并通过 Unix socket 和它通信。这样 `open`、`send`、`status`、`result`、`close` 可以跨多次 CLI 调用复用同一个持久 session。

启动 daemon：

```sh
node scripts/agent-bridge.mjs start
```

查看 daemon 里的 sessions：

```sh
node scripts/agent-bridge.mjs sessions --json
```

打开 OMP session：

```sh
node scripts/agent-bridge.mjs open --agent omp --cwd "$PWD" --json
```

也可以在打开时指定模型与推理强度（`--model` / `--effort`，均为会话级）：

```sh
node scripts/agent-bridge.mjs open --agent codex --cwd "$PWD" --model "<模型名>" --effort medium --json
```

发送消息：

```sh
node scripts/agent-bridge.mjs send <session_id> "请只读代码，帮我检查潜在问题。不要修改文件。" --wait --json
```

读取结果：

```sh
node scripts/agent-bridge.mjs result <session_id> --json
```

关闭 session：

```sh
node scripts/agent-bridge.mjs close <session_id>
```

停止 daemon：

```sh
node scripts/agent-bridge.mjs stop
```

`stop` 会关闭 daemon 内所有 session，并退出对应的 `omp --mode rpc` 和 `codex app-server`。

清理 stale pid record：

```sh
node scripts/agent-bridge.mjs cleanup --json
```

`cleanup` 会跳过仍由当前 MCP server 或 CLI daemon 拥有的进程，只清理 stale pid record 和确认已失去 owner 的子进程。

## 8. UI 实时监控

启动本地 Web UI：

```sh
node scripts/agent-bridge.mjs ui
```

默认会自动启动或复用 `agent-bridge daemon`，只监听 `127.0.0.1`，随机选一个空闲端口并自动打开浏览器。命令会打印实际地址，例如 `Agent Bridge UI: http://127.0.0.1:52799`。无需提前手动 `start` daemon，`ui` 会自动拉起或复用它。

参数：

- `--port PORT` 固定端口（默认随机空闲端口）
- `--no-open` 不打开浏览器，只打印地址（适合远程 / 无头环境）
- `--json` 以 JSON 打印地址（同样不打开浏览器）

```sh
node scripts/agent-bridge.mjs ui --port 8787
node scripts/agent-bridge.mjs ui --no-open --json
```

UI 可以：

- 查看 daemon 内已有的 OMP/Codex sessions
- 打开新的 OMP/Codex session
- 发送消息、abort 当前 turn、关闭 session
- 通过 SSE 实时看到状态变化和 assistant 可见文本
- 在折叠的 Debug 面板里查看经过裁剪和脱敏的事件 JSON 与 log file 路径
- 停止 daemon，并关闭 daemon 持有的所有后端进程

HTTP API：

```text
GET    /sessions
POST   /sessions
GET    /sessions/:id
POST   /sessions/:id/messages
GET    /sessions/:id/result
GET    /sessions/:id/events
POST   /sessions/:id/abort
DELETE /sessions/:id
POST   /daemon/stop
```

`/sessions/:id/events` 是 Server-Sent Events 流。默认输出状态事件和 assistant 可见文本；完整 thinking/raw internal payload 不会在主输出区展示。

## 9. 写权限模式

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
- Codex：`sandbox: workspace-write`（`approvalPolicy: never`）

让委托代理改完后，Codex 自己仍然应该检查 git diff、运行测试，再向用户报告。

## 10. 会话和进程清理

正常关闭会话：

```json
{
  "session_id": "..."
}
```

调用 `agent_bridge_close_session` 后：

- OMP 的 `omp --mode rpc` 会退出
- Codex 的 `codex app-server` 会退出

如果 daemon 进程退出，Agent Bridge 会在 `SIGTERM`、`SIGINT`、`SIGHUP`、stdout `EPIPE`、未捕获异常等情况下清理自己持有的所有子进程。

0.3.0 之后，MCP session 默认由本地 daemon 持有。MCP server 自身 stdin 关闭时会等 pending MCP 响应写完再退出，不会误删 daemon 里仍在运行、且可能正被 UI/CLI 观察的 session；仍然建议在任务完成后显式调用 `agent_bridge_close_session`。

如果关闭 CLI daemon，`node scripts/agent-bridge.mjs stop` 会关闭 daemon 持有的所有 session，并让对应 OMP/Codex 服务退出。

如果 Agent Bridge 被 `kill -9` 硬杀，清理逻辑来不及执行。此时它会依赖 `~/.agent-bridge/pids/` 里的 pid record，在下一次 MCP server 启动时清理上次残留的 OMP/Codex 子进程。

正常运行的 MCP server 或 CLI daemon 会被识别为 pid record owner，`cleanup` 不会误杀它们仍在使用的 OMP/Codex 子进程。

检查是否有残留：

```sh
ps -axo pid,ppid,command | rg 'agent-bridge|omp --mode rpc|codex app-server' || true
find "$HOME/.agent-bridge/pids" -type f -maxdepth 1 -print 2>/dev/null || true
```

## 11. 升级

```sh
cd "$HOME/projects/agent-bridge"
git pull
node --check scripts/agent-bridge.mjs
node scripts/agent-bridge.mjs doctor
node scripts/agent-bridge.mjs cleanup
codex plugin add agent-bridge@personal
```

重新安装后确认：

```sh
codex plugin list | rg agent-bridge
codex mcp list | rg agent-bridge
```

## 12. 卸载

如果 Codex CLI 支持插件移除命令，可以使用对应的 `codex plugin` 子命令卸载。

手动清理本地链接：

```sh
rm -f "$HOME/plugins/agent-bridge"
```

停止 CLI daemon：

```sh
node scripts/agent-bridge.mjs stop
```

如果不再使用 Agent Bridge，也可以删除本地状态目录：

```sh
rm -rf "$HOME/.agent-bridge"
```

## 13. 常见问题

### `agent_bridge_doctor` 找不到 OMP

设置：

```sh
export OMP_BIN="$HOME/.local/bin/omp"
```

然后重新安装或重启 Codex。

### `agent_bridge_doctor` 找不到 Codex

设置：

```sh
export CODEX_BIN="$(command -v codex)"
```

然后重新安装或重启 Codex。

### Codex 看不到 `agent-bridge`

重新安装并检查：

```sh
codex plugin add agent-bridge@personal
codex plugin list | rg agent-bridge
codex mcp list | rg agent-bridge
```

### session 还在运行但不需要了

优先调用：

```text
agent_bridge_close_session
```

如果 Codex 已经退出，下一次 Agent Bridge MCP server 启动会清理上次记录的残留进程。
