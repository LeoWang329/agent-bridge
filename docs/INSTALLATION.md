# Agent Bridge 安装与使用

这份文档面向想把 Agent Bridge 装进 Codex 并实际调用 OMP/OpenCode 的用户。

Agent Bridge 是一个 session-first 的 Codex MCP 插件。它不是一次性命令封装，而是让 Codex 先打开一个持久会话，再向同一个会话连续发送消息，最后显式关闭会话。

## 1. 前置依赖

确认本机有这些命令：

```sh
node --version
codex --version
omp --version
opencode --version
sqlite3 --version
```

最低要求：

- Node.js 20 或更高
- Codex CLI 或 Codex app
- OMP 已安装，并且 `omp` 在 PATH 中
- OpenCode 已安装，并且 `opencode` 在 PATH 中
- `sqlite3` 在 PATH 中，用于 OpenCode 结果兜底读取

如果 OMP 或 OpenCode 不在 PATH 中，可以用环境变量覆盖：

```sh
export OMP_BIN="$HOME/.local/bin/omp"
export OPENCODE_BIN="$(command -v opencode)"
export OPENCODE_DB_PATH="$HOME/.local/share/opencode/opencode.db"
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
Agent Bridge 0.2.3
omp: ok (...) omp/15.9.0
opencode: ok (...) 1.15.13
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
  '这是 agent-bridge 的只读 smoke test。请只使用 agent_bridge MCP 工具，不要运行 shell 命令，不要发送实际任务 prompt 给 OMP 或 OpenCode。调用 agent_bridge_doctor；打开 agent=omp write=false 的 session，调用 status，关闭；打开 agent=opencode write=false 的 session，调用 status，关闭；最后报告两个 session_id 和是否已关闭。'
```

这个测试只会启动、查看、关闭会话，不会让 OMP/OpenCode 执行具体任务。

## 5. 使用方式

Codex 正式调用 Agent Bridge 时，应该优先使用 MCP 工具。CLI facade 主要给人类调试、smoke test、清理残留进程、临时操作使用。

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

需要 OpenCode 时，把 `agent` 换成 `opencode`：

```json
{
  "agent": "opencode",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```

## 6. CLI facade

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

`stop` 会关闭 daemon 内所有 session，并退出对应的 `omp --mode rpc`、`opencode serve` 和正在运行的 OpenCode attach client。

清理 stale pid record：

```sh
node scripts/agent-bridge.mjs cleanup --json
```

`cleanup` 会跳过仍由当前 MCP server 或 CLI daemon 拥有的进程，只清理 stale pid record 和确认已失去 owner 的子进程。

## 7. 写权限模式

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
- OpenCode：`--dangerously-skip-permissions`

让委托代理改完后，Codex 自己仍然应该检查 git diff、运行测试，再向用户报告。

## 8. 会话和进程清理

正常关闭会话：

```json
{
  "session_id": "..."
}
```

调用 `agent_bridge_close_session` 后：

- OMP 的 `omp --mode rpc` 会退出
- OpenCode 的 `opencode serve` 会退出
- 当前 OpenCode attach client 也会退出

如果 Codex 关闭 MCP server，Agent Bridge 会在 `SIGTERM`、`SIGINT`、`SIGHUP`、stdin 关闭、stdout `EPIPE`、未捕获异常等情况下清理所有子进程。

如果关闭 CLI daemon，`node scripts/agent-bridge.mjs stop` 会关闭 daemon 持有的所有 session，并让对应 OMP/OpenCode 服务退出。

如果 Agent Bridge 被 `kill -9` 硬杀，清理逻辑来不及执行。此时它会依赖 `~/.agent-bridge/pids/` 里的 pid record，在下一次 MCP server 启动时清理上次残留的 OMP/OpenCode 子进程。

正常运行的 MCP server 或 CLI daemon 会被识别为 pid record owner，`cleanup` 不会误杀它们仍在使用的 OMP/OpenCode 子进程。

检查是否有残留：

```sh
ps -axo pid,ppid,command | rg 'agent-bridge|omp --mode rpc|opencode serve' || true
find "$HOME/.agent-bridge/pids" -type f -maxdepth 1 -print 2>/dev/null || true
```

## 9. 升级

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

## 10. 卸载

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

## 11. 常见问题

### `agent_bridge_doctor` 找不到 OMP

设置：

```sh
export OMP_BIN="$HOME/.local/bin/omp"
```

然后重新安装或重启 Codex。

### `agent_bridge_doctor` 找不到 OpenCode

设置：

```sh
export OPENCODE_BIN="$(command -v opencode)"
```

然后重新安装或重启 Codex。

### OpenCode 返回 `text: null`

确认 `sqlite3` 可用，并确认 OpenCode 数据库路径：

```sh
sqlite3 --version
ls "$HOME/.local/share/opencode/opencode.db"
```

如果数据库在别处，设置：

```sh
export OPENCODE_DB_PATH="/path/to/opencode.db"
```

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
