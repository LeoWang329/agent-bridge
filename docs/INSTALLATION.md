# Agent Bridge 安装与使用

这份文档面向想把 Agent Bridge 装进 Codex、Claude Code 或 DeepSeek Harness（DSH）并实际调用 OMP/Codex/Claude/Cursor/Kimi/DSH 的用户。

Agent Bridge 是一个 session-first 的 MCP 桥接器，注册到 Codex、Claude Code 或 DSH 后使用。它不是一次性命令封装，而是让客户端先打开一个持久会话，再向同一个会话连续发送消息，最后显式关闭会话。

## 1. 前置依赖

确认本机有这些命令：

```sh
node --version
codex --version
omp --version
claude --version   # 如果要委托给 Claude
agent --version    # 如果要委托给 Cursor（仅 Windows）
kimi --version     # 如果要委托给 Kimi（仅 Windows）
dsh --version      # 如果要委托给 DSH（需要 0.2.x，带 --profile acp）
```

最低要求：

- Node.js 20 或更高
- 一个 MCP 客户端：Codex（CLI 或 app）、Claude Code，或 DeepSeek Harness（DSH）0.2.x（桌面版或 CLI；`dsh -V` 可执行。DSH 不读 `.mcp.json`，需要一行 profile patch，见第 6 节）
- OMP 已安装，并且 `omp` 在 PATH 中（如果要委托给 OMP）
- Codex 已安装，并且 `codex` 在 PATH 中（如果要委托给 Codex）
- Claude Code 已安装，并且 `claude` 在 PATH 中（如果要委托给 Claude）
- Cursor Agent CLI（`agent`）已安装，**仅 Windows**（如果要委托给 Cursor）
- Kimi Code CLI（原生 `kimi.exe`）已安装，**仅 Windows**（如果要委托给 Kimi）
- DeepSeek Harness（DSH）**0.2.x** 已安装，`dsh` 可执行（如果要委托给 DSH；需要该版本自带 `--profile acp`，0.2.1-rc.2 实测可用。Windows / macOS / Linux）

**必须先装好要委托的 coding agent。** Agent Bridge 只是桥接到 OMP / Codex / Claude / Cursor / Kimi / DSH（cursor、kimi 仅 Windows；DSH 三平台），本身不包含也不会自动安装它们。如果对应后端没装，session 根本无法启动。请先把你打算委托的后端装好，再用 `node scripts/agent-bridge.mjs doctor` 确认每个后端都被检测到。

如果后端不在 PATH 中，可以用环境变量覆盖（下面以 omp/codex/claude 的 POSIX shell 写法为例；cursor / kimi / DSH 的覆盖见后）：

```sh
export OMP_BIN="$HOME/.local/bin/omp"
export CODEX_BIN="$(command -v codex)"
export CLAUDE_BIN="$(command -v claude)"
```

Cursor 仅 Windows，用 PowerShell 覆盖（通常无需——`agent` 在 PATH 即可；`agent` 是 `.cmd`/`.ps1` shim）：

```powershell
$env:CURSOR_AGENT_BIN = (Get-Command agent).Source
```

Kimi 仅 Windows，用官方 native 安装器安装（装的是原生 `kimi.exe`，落在 `%USERPROFILE%\.kimi-code\bin`，不碰 Python）：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

装完先跑一次 `kimi`，在里面用 `/login` 完成登录，之后 `node scripts/agent-bridge.mjs doctor` 应列出 `kimi: ok (kimi.exe) <version>`（版本号随你装的 CLI 走）。桥按 `KIMI_BIN` → `%USERPROFILE%\.kimi-code\bin\kimi.exe` → PATH 的顺序找二进制，装在别处才需要覆盖（**必须指向原生 `kimi.exe`，`.cmd`/`.bat` shim 一律拒绝**——prompt 走 argv，经 shim 会丢掉元字符安全边界）：

```powershell
$env:KIMI_BIN = "$env:USERPROFILE\.kimi-code\bin\kimi.exe"
```

DSH（Windows / macOS / Linux）按 `DSH_BIN` → 标准桌面安装的 launcher（Windows 是 `…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`）→ PATH 的顺序**懒解析**，装的是官方桌面版通常无需配置。装在别处才需要覆盖（**必须指向 launcher 文件路径，不能是裸名字**）：

```powershell
$env:DSH_BIN = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
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
Agent Bridge 0.12.0
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
- **skills（使用指引）**：`skills/*/SKILL.md` 是 Claude Code / Codex 的 skill 约定，**DSH 的文件系统 skill 机制也兼容**（frontmatter 只要求 `name`+`description`，5 个 skill 已实测可直接加载，见第 6 节）；其它客户端不会自动加载（工具照用，只是少了「何时该委托」的判断指引——可把 SKILL.md 当普通文档喂给它）。

| agent | 注册 MCP（工具） | skill 目录 | 工具命名空间 | 生效 |
|---|---|---|---|---|
| **Claude Code** | `claude mcp add agent-bridge --scope user -- node "<MJS>" mcp`（写入用户配置） | `~/.claude/skills/<name>/`（软链，裸名、无命名空间） | `mcp__agent-bridge__agent_bridge_*` | 重启客户端 |
| **Codex** | `codex mcp add agent-bridge -- node "<MJS>" mcp`（写入 `~/.codex/config.toml`） | `~/.codex/skills/<name>/`（软链） | `agent_bridge_*`（裸名） | 重启 Codex |
| **DeepSeek Harness（DSH）** | 在 DSH profile 的**用户 patch 层**插一行 `@deepseek-ai/dsh-mcp-client`：桌面版改 `~/.dsh/profiles/desktop/cordis.patch.yml`；headless 用 `--patch` overlay（见第 6 节） | `~/.dsh/skills/<name>/`（junction/软链，DSH 自动发现，所有 profile 生效） | `mcp__agent-bridge__agent_bridge_*` | 桌面版 HMR 在线生效（重启为兜底）；headless 每次运行读新配置 |
| **其它 MCP 客户端**（Cursor / Cline / Windsurf …） | 在该客户端 MCP 配置里加一个 stdio server：命令 `node`、参数 `["<MJS>","mcp"]` | 无自动 skill 机制——按需把 `skills/agent-bridge/SKILL.md` 作为文档提供 | 由该客户端定（多为 `agent_bridge_*`） | 按该客户端方式重载 |

`<MJS>` = `<REPO>/scripts/agent-bridge.mjs` 的**绝对路径**（维护者填**稳定安装 clone**，见上一节）。后端（omp/codex/claude/cursor/kimi/dsh）是否可用以 `node "<MJS>" doctor` 为准。一律用**绝对路径**，别用 `$PWD`——agent 的 shell 通常不在仓库根。

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
ln -s "<REPO>/skills/agent-bridge-graph"      ~/.codex/skills/agent-bridge-graph      # 可选：JS 编排的异构多厂商跑批

# Windows — junction，免管理员
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge"            "<REPO>\skills\agent-bridge"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-dev"        "<REPO>\skills\agent-bridge-dev"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-roundtable" "<REPO>\skills\agent-bridge-roundtable"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-loop"       "<REPO>\skills\agent-bridge-loop"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\agent-bridge-graph"      "<REPO>\skills\agent-bridge-graph"
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

`skills/` 下的中文使用指引与 Claude Code skill 兼容，软链到用户 skill 目录即可（`agent-bridge` 是桥用法指引；可选 companion：`agent-bridge-dev` 委托角色编排、`agent-bridge-roundtable` N 席圆桌审议、`agent-bridge-loop` 合同驱动交付循环、`agent-bridge-graph` 用 JS 编排一次异构多厂商跑批）：

```sh
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/agent-bridge"            ~/.claude/skills/agent-bridge
ln -sfn "$PWD/skills/agent-bridge-dev"        ~/.claude/skills/agent-bridge-dev        # 可选
ln -sfn "$PWD/skills/agent-bridge-roundtable" ~/.claude/skills/agent-bridge-roundtable # 可选
ln -sfn "$PWD/skills/agent-bridge-loop"       ~/.claude/skills/agent-bridge-loop       # 可选
ln -sfn "$PWD/skills/agent-bridge-graph"      ~/.claude/skills/agent-bridge-graph      # 可选
```

不装 skill 也能直接调用 MCP 工具，skill 只是补充「何时该委托」的判断指引。会话流程（open → send → status/result → 复用 → close）以及写权限、清理规则都与 Codex 完全一致。

## 6. 安装到 DeepSeek Harness（DSH）

DSH 也是 stdio MCP 客户端，但它的 MCP **没有设置页、没有设置文件，也不读 `.mcp.json`**：MCP server 是 DSH profile 的一行 Loader 配置（`@deepseek-ai/dsh-mcp-client`，DSH 自带但这个客户端默认不挂任何 MCP server）。所以接入方式与 Codex / Claude Code 不同——要往 DSH 的 **profile 用户 patch 层**插一行；skills 则与 DSH 的文件系统 skill 约定天然兼容。实测环境：DSH 0.2.1-rc.2（Windows 桌面版 + CLI）。

> **同一个 DSH 安装也可以被桥委托（方向 A，v0.12.0 起）。** 本节讲的是「DSH 当客户端」；反过来 `agent_bridge_open_session({ agent: "dsh" })` 驱动的是本机 DSH 的 `--profile acp` 后端，两个方向互不冲突、可以同时启用（DSH 既能指挥桥，也能被桥指挥）。后端要求见第 1 节，`doctor` 里的同一行 `dsh: ok (...)` 即代表两边都可用——注意 `--profile acp` 是委托方向必需的能力，DSH 版本太低时 `open_session` 会明确报错。

### 6.1 注册 MCP server（工具）

先确认 `dsh` 可执行（桌面安装会写用户 PATH；长期运行的旧进程可能持有过期 PATH，新开 shell 再试）：

```powershell
dsh -V   # 应输出 0.2.x
```

**桌面版 GUI**（日常主 agent 跑在 DSH 桌面 App 里）：把下面这段**追加**到 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（这是你的用户 patch 层，不是 `cordis.yml`；建议先备份一份）。桌面版开着 HMR，保存后新会话即可看到工具，不生效再重启 App：

```yaml
# DSH profile 用户 patch 层：追加这段（顶层 - insert:）
- insert:
    - id: mcp-agent-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-bridge          # 工具名 → mcp__agent-bridge__agent_bridge_*
        transport: stdio
        command: !!js process.execPath    # 桌面 App 里 process.execPath 是 Electron 二进制
        args:
          - '<REPO>\scripts\agent-bridge.mjs'
          - mcp
        env:
          ELECTRON_RUN_AS_NODE: '1'       # 让 Electron 二进制以 Node 模式跑 MCP server
        cwd: '<REPO>'
        toolCallTimeoutMs: 900000         # 必须 ≥ 桥 wait 的 10 分钟默认值（DSH 默认只有 60s）
        failOnStartupError: false
```

**headless / 其他 CLI 运行**（不经过 GUI）：把 `- insert:` 块存成仓库外的 overlay 文件（如 `%USERPROFILE%\.dsh\agent-bridge.mcp.yml`），用 `--patch` 传入；纯 CLI/headless 下把 `command` 换成 `node`、删掉 `env:` 块（这是已实测的写法）。headless 默认还禁用了 GUI 保存的凭据，如果你要让它沿用已保存的 DSH 登录/API key，再在同一个文件顶部加三行（后端都用自己的登录时可省略）：

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
```

```powershell
dsh --profile headless --patch "$env:USERPROFILE\.dsh\agent-bridge.mcp.yml" "用 agent-bridge 的 doctor 检查后端"
```

> 两种 `command` 的选择：**桌面 App 宿主**用 `!!js process.execPath` + `ELECTRON_RUN_AS_NODE: '1'`（与 DSH 自带的 OpenViking 插件同形；**2026-10-20 已在 DSH 桌面版真机启用并验证**：HMR 热加载后工具进入运行中的会话，`agent_bridge_doctor` 正常）；**CLI/headless** 用 `command: node`（Windows 实测跑通：`agent_bridge_doctor` 五项全 ok，`mcp__agent-bridge__agent_bridge_doctor` 可被模型正常调用）。

必须知道的点：

- **`toolCallTimeoutMs` 一定 ≥ 600000（建议 900000）**：DSH 的 MCP 调用默认 60 s 超时，而 `agent_bridge_wait` 默认等 10 分钟——不改的话长任务会被 DSH 端掐断。
- DSH 会**清洗** MCP 子进程环境：名字命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 以及所有 `DSH_*` 的变量会被剥掉（`PATH` 保留）。靠环境变量传 key 的后端要在 `env:` 里显式重述。
- 不要把 `~/.dsh/cordis.patch.yml` 建成空文件或只有注释——DSH 会 boot 失败。要 home 级生效就写完整 patch 内容。
- `<REPO>` 用**绝对路径**；YAML 里 Windows 路径用**单引号**（双引号中 `\c` 是非法转义）。
- **作用域**：插在顶层 `- insert:` 是 host plane，所有 DSH 会话（含 DSH 自己的 subagent）都会看到这 8 个工具。只想让部分会话用：把这一行加进 desktop patch 里各个 agent preset 的 plugins 列表（改动只对**新建会话**生效）。
- 想只验证配置组装、不发模型请求：`dsh --profile headless --patch <overlay 文件> --dump-config`，输出里应能看到 `mcp-agent-bridge` 这一行。

### 6.2 安装 skills（使用指引）

DSH 自带文件系统 skill 机制，`skills/*/SKILL.md` 的 frontmatter（`name` + `description`）与 DSH 的契约兼容，**5 个 skill 全部可直接用**，不需要改文件（frontmatter 兼容性与目录发现已实测：DSH 会话的 skill 目录里能列出这 5 个名字）。用户级目录 `~/.dsh/skills/` 会被所有 DSH profile 扫描，无需配置、无需重启：

```powershell
# Windows — junction（免管理员；不要拷贝，这样 git pull 即更新）
$root = Join-Path $env:USERPROFILE '.dsh\skills'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$repo = '<REPO>\skills'
foreach ($n in 'agent-bridge','agent-bridge-dev','agent-bridge-roundtable','agent-bridge-loop','agent-bridge-graph') {
  $link = Join-Path $root $n
  if (Test-Path $link) { Remove-Item $link -Force -Recurse }
  New-Item -ItemType Junction -Path $link -Target (Join-Path $repo $n) | Out-Null
}
Get-ChildItem $root | Select-Object Name   # 应看到 5 个 junction
```

```sh
# macOS / Linux
mkdir -p ~/.dsh/skills
ln -sfn "<REPO>/skills/agent-bridge"            ~/.dsh/skills/agent-bridge
ln -sfn "<REPO>/skills/agent-bridge-dev"        ~/.dsh/skills/agent-bridge-dev
ln -sfn "<REPO>/skills/agent-bridge-roundtable" ~/.dsh/skills/agent-bridge-roundtable
ln -sfn "<REPO>/skills/agent-bridge-loop"       ~/.dsh/skills/agent-bridge-loop
ln -sfn "<REPO>/skills/agent-bridge-graph"      ~/.dsh/skills/agent-bridge-graph
```

装完在新会话里可直接 `/agent-bridge` 显式调用（或说「用 agent-bridge 的 skill」）。**非 desktop 的 profile** 也可用配置方式（`- id: skill-filesystem` / `config: {customSkillDirs: ['<REPO>/skills']}`），但 desktop 的 host 行被 DSH 的 web bundle 禁用了、由各 agent preset 自己管，所以桌面版请用上面的 junction（**2026-10-20 真机验证**：建好 junction 后，正在运行的 DSH 桌面会话的 skill 目录当场更新并列出这 5 个 skill，无需重启）。

### 6.3 验证

在 DSH 里新开一个会话（或按 6.1 用 headless 跑一次），发送：

```text
这是 agent-bridge 的只读 smoke test。请调用 mcp__agent-bridge__agent_bridge_doctor，把原始输出原样贴出来；不要发送任何实际任务 prompt。
```

预期输出类似（后端清单随本机安装变化）：

```text
Agent Bridge 0.12.0
Node: v24.16.0
State: C:\Users\<you>\.agent-bridge
Viz: on   ...\Temp\agent-bridge-viz-...

omp: ok (omp) omp/18.2.6
codex: ok (codex) codex-cli 0.161.0
claude: ok (claude) 2.1.280 (Claude Code)
cursor: ok (agent) 2026.07.23-e383d2b
kimi: ok (kimi.exe) 0.32.0
dsh: ok (dsh) 0.2.1-rc.2
```

**回滚**：删掉 6.1 追加的 `- insert:` 块（有备份就恢复），删掉 6.2 的 5 个 junction，重启 DSH。

> 2026-10-20 本机（DSH 桌面版 0.2.1-rc.2）实测记录：HMR 热加载后工具直接进入运行中的会话 → `agent_bridge_doctor` 五项 ok → 打开 `omp` 只读会话、发一条消息，1.3 s 内拿回 `DSH-BRIDGE-OK`；5 个 skill 同时上线。也就是说上面两条（工具 + skills）都已经在桌面版真机跑通。

### 6.4 已知摩擦

- **工具名带命名空间**：DSH 里是 `mcp__agent-bridge__agent_bridge_*`（与 Claude Code 同形）；skill 正文里的裸 `agent_bridge_*` 需要模型自行对应（Claude Code 已有先例，实际可行）。
- **`.mcp.json` 在 DSH 里完全无效**（DSH 全树没有 `.mcp.json` 读取器）；仓库自带的 `.mcp.json` 只服务 Claude Code 的项目级安装。
- **DSH 里没有「只读桥」或按工具裁剪**：8 个工具 schema 会常驻每次请求（占一点 context）。这是 DSH MCP 客户端的现状。
- **skill 正文较长（9–22 KB）**：desktop 默认的 tool-result-pruner 阈值是 8192 字符，压缩压力下 skill 正文中间可能被剪；在意的话调高该 preset 的 `thresholdChars`。
- **作用域/递归**：host-plane 注册会让 DSH 自己的 subagent 也看到这 8 个工具。DSH 侧没有「桥→DSH」直接环（DSH 目前不是桥的后端），但桥委派的 Claude Code 若在含 `.mcp.json` 的仓库里运行会再注册桥（这是既有风险，与 DSH 无关）。
- **已知坑（2026-10-20 实测，v0.12.0 已修）**：在**含 `.mcp.json`** 的目录里作为委托 cwd 打开 `omp` 会话，OMP 会自动挂载嵌套的 agent-bridge MCP；旧版桥的 owner 存活判定只认 `node` 开头的进程（`scripts/agent-bridge.mjs` 的 `ownerStillRunning`），Electron 宿主（DSH 桌面版）下会把外层桥误判为已死，嵌套桥的启动清理把 OMP 杀掉（约 5–6 s 后 `OMP RPC exited with code 1`）。**v0.12.0 起**判定改为「owner 命令含 `agent-bridge.mjs` + `mcp` 即视为存活」（比原来更保守：宁可少清理，不可误杀），不再需要绕开 `.mcp.json` 目录；回归测试 `tests/repro-owner-electron-argv0.mjs`。老版本升级前仍建议避开。
- DSH 升级后 `cordis.patch.yml` 可能被 app 的 profile 自愈逻辑或 Plugin Manager 备份重命名，升级前留一份副本。

### 6.5 委托方向：让 dsh 看图片（`read_image`）

`agent_bridge_open_session({ agent: "dsh" })` 的会话**收不到图片字节**：桥只发文本 prompt，DSH ACP 的 `promptCapabilities.image` 实测为 `false`（0.2.1-rc.2）。但 dsh 自带 `read_image` 工具（`dsh-tool-fs`，依赖持久附件存储，`dsh-base` 默认挂载），所以图像任务的正确姿势是**把图片文件路径写进 prompt**，让被委托的 dsh 自己读：

```text
用 read_image 读取 D:\shots\mock.png，然后回答：这个页面的主导航有几项？
```

- 支持 PNG / JPEG / WebP / GIF，单图 ≤20 MiB（`dsh-attachment-local` 默认限制）；读取会落成持久附件、按该路由的图像预算缩放后作为 image content 交给模型。
- ⚠️ **会话模型必须声明图像输入**。2026-10-20 实测：不传 `model` 时默认路由是 bundle 里写死的 `deepseek-official/deepseek-v4-flash`（一个**不在模型目录里的透传纯文本 id**），`read_image` 直接失败并给出稳定错误：
  `model "deepseek-v4-flash" does not declare image input; switch to an image-capable model to read images`
  传 `model: "deepseek-flash"`（模型目录里文本+图像的条目，展示名 DeepSeek-V4.1-Flash）后，工具调用完成，2 s 内正确答出测试图（左红右蓝）的左右颜色。
- 两种用法：
  1. **按会话指定**（不改配置、单次生效）：`open_session({ agent: "dsh", model: "deepseek-flash", ... })`；
  2. **改默认路由**（本机所有 `dsh --profile acp` 生效，含所有桥委托会话；下次新开会话即生效，**不用重启 DSH**）：在 `%USERPROFILE%\.dsh\profiles\acp\cordis.patch.yml` 顶层加：

```yaml
- id: acp
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-flash
```

  bundle 默认只在 `dsh-acp-app/cordis.patch.yml` 里写死；profile 用户 patch 层在 bundle 之后应用，可按 id 覆盖。想恢复原默认就删掉这段。注意桌面版 GUI 的默认模型是另一处 `agent-default-model`（本项与它无关），GUI 默认模型本身已支持图像。
- 图片路径要在 dsh 会话可读范围内（`access:"read"` 仍可读文件系统）；图片引用会留在会话持久历史里，后续轮次可继续追问。
- `read_image` 只读文件 + 写 DSH 自己的附件存储，不改工作区，`read` 档即可用。

## 7. 使用方式

会话**只能**通过 MCP 工具管理。会话活在你这个客户端启动的 `agent-bridge mcp` 进程内：该进程直接 spawn 并持有你打开的 OMP/Codex/Claude/DSH 后端（**cursor / kimi 例外**：只持有逻辑会话——cursor 是云端 `chatId`、kimi 是本地 session id，两者进程都按轮短驻）。没有共享后台 daemon，也没有 Web UI——客户端退出，这个 MCP 进程随之退出，它持有的所有后端进程被一并清理（cursor 的云端 chat 因无 delete-chat 不受影响、仍留存；kimi 无云端 chat 存储，但已发出的 prompt 仍到过 Moonshot 云端）（v0.7.0，详见 [docs/ARCHITECTURE.md](ARCHITECTURE.md)）。

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

需要 Claude 时，把 `agent` 换成 `claude`（启动一个 fresh-context Claude Code worker，逐 token 流式；`read` 档 Bash 可跑命令、但能写盘=**软边界**，`write` 档用 `bypassPermissions`；思考强度默认 `xhigh`；不设 `model` 时用 claude 自身默认模型）：

```json
{
  "agent": "claude",
  "cwd": "/absolute/path/to/workspace",
  "write": false
}
```

需要 Cursor 时，把 `agent` 换成 `cursor`（**仅 Windows**；形状 B——逻辑会话=云端 `chatId`、进程按轮短驻）。几处后端特有约束：`read`/`write` 都是**软边界**（`read` 甚至保留原生 Edit/Write 工具、只靠每轮提示压制）；`model` 要带**档位后缀**的 selector（如 `gpt-5.3-codex-high`、`cursor-grok-4.5-high`，清单用 `agent --list-models` 活查）；`append_system_prompt_file` 无原生 system flag、软注入为首轮用户前缀；`effort` 被接受但忽略、`schema` 不支持；`contextUsage` 恒 `null`；无 delete-chat，`close` 只忘 `chatId`、云端 chat 留存删不掉：

```json
{
  "agent": "cursor",
  "cwd": "C:\\absolute\\path\\to\\workspace",
  "write": false,
  "model": "gpt-5.3-codex-high"
}
```

需要 Kimi 时，把 `agent` 换成 `kimi`（**仅 Windows**；Kimi Code CLI，Moonshot 的 K2/K3 系；形状 B——逻辑会话=kimi 首轮自己在**本地**铸的 session id、进程按轮短驻，比 cursor 简单：无 create-chat 往返、无云端 chat 存储）。几处后端特有约束：`read`/`write` 都是**软边界**（Windows 无 OS 沙箱；`read` 保留原生写工具、只靠每轮注入的「仅只读调查」策略压制，**不是真只读**——shell 仍能写盘）；`model` 用 `kimi-code/…` 别名（`kimi-code/k3` 为默认，另有 `kimi-code/kimi-for-coding`、`kimi-code/kimi-for-coding-highspeed`，清单用 `kimi provider list --json` 活查（**要 `--json`**：裸 `kimi provider list` 只报 provider 摘要与默认模型，不列别名））；`append_system_prompt_file` 无原生 system flag、软注入为首轮用户前缀；`effort` 被接受但忽略（回显 `null`）、`schema` 不支持；`contextUsage` 恒 `null`。**隐私口径**：session 状态在本地、无云端 chat 存储，但**推理仍走 Moonshot 云端 API**——prompt 和 agent 读进去的仓库内容一样离开本机，别当成"数据不出本地"：

```json
{
  "agent": "kimi",
  "cwd": "C:\\absolute\\path\\to\\workspace",
  "write": false,
  "model": "kimi-code/k3"
}
```

需要 DSH 时，把 `agent` 换成 `dsh`（DeepSeek Harness 0.2.x 的 **ACP profile**，一个会话一个持久进程；Windows / macOS / Linux）。几处后端特有约束：`model` 用**友好名**（如 `deepseek-v4-pro`，或 `deepseek-official/deepseek-v4-pro`；桥按该会话 `session/new` 实际公布的 `configOptions` 映射，**不硬编码 id**，非法值在 `open_session` 当场失败而不是回落到默认）；`effort` 映射 `minimal→off, low→low, medium→high, high→high, xhigh→max`；`append_system_prompt_file` 是**真 system prompt**（桥生成临时 `--patch` 注入 `system-prompt.personaSuffix`，档位与 omp/claude 同级，优于 cursor/kimi 的首轮软前缀；内容含 `{{…}}` 会在 open 时被拒——DSH 会把它当模板表达式）；`contextUsage` **非 null**（取上一轮 `usage_update`，`live:false` 快照）；`schema` 不支持（同 cursor/kimi）；`read` 档 = DSH `read-only`（文件工具由文件系统沙箱硬拦、shell 走 ACL 受限令牌且 enforcement 为 `partial`，是**工具面**写围栏，**不是** codex 那种 OS 沙箱），`write` 档 = `danger-full-access`；一个会话约 **250 MB** 内存（大并发要收敛 dsh 会话数），且会话会出现在你本机 DSH 的会话列表里（`~/.dsh`）：

```json
{
  "agent": "dsh",
  "cwd": "/absolute/path/to/workspace",
  "access": "read",
  "model": "deepseek-v4-pro",
  "effort": "high"
}
```

可以在**打开会话时**指定模型与推理强度。模型是会话级参数：在 `agent_bridge_open_session` 时用 `model` 指定，整个会话内固定，`agent_bridge_send_message` 不能逐条切换；想换模型就新开一个 session。`model` 会原样传给后端的 `--model`（**DSH 例外**：它经 ACP `session/set_config_option` 下发，不走 argv），取值格式由后端决定。OMP 尤其可以通过 `omp --model <name>` 触达多种模型（如 `deepseek-v4-pro`、`minimax-m3`、`claude`、`gpt`）。可选的 `effort` 在 OMP 映射为 `--thinking`（`minimal|low|medium|high|xhigh`），在 Codex 作为该轮的 effort（`none|minimal|low|medium|high|xhigh`）传入，在 Claude 映射为 `--effort`（默认 `xhigh`）；**Cursor 的 `model` 必须是带档位后缀的 selector**（用 `agent --list-models` 活查），其 `effort` 被接受但忽略、`contextUsage` 恒 `null`；**Kimi 的 `model` 是 `kimi-code/…` 别名**（用 `kimi provider list --json` 活查（**要 `--json`**：裸 `kimi provider list` 只报 provider 摘要与默认模型，不列别名），默认 `kimi-code/k3`），其 `effort` 同样被接受但忽略、`contextUsage` 也恒 `null`；**DSH 的 `model` 用友好名**（`deepseek-v4-pro`，或 `deepseek-official/deepseek-v4-pro` 这类 `provider/model` 形式；桥按该会话 `configOptions` 映射，不是硬编码目录），其 `effort` 按 `minimal→off, low→low, medium→high, high→high, xhigh→max` 映射到 ACP `reasoning_effort`，`contextUsage` 非 null（上一轮 `usage_update` 快照，`live:false`）。不传 `model` / `effort` 时使用后端默认值。

```json
{
  "agent": "omp",
  "cwd": "/absolute/path/to/workspace",
  "write": false,
  "model": "<模型名>",
  "effort": "high"
}
```

## 8. CLI

会话只能通过 MCP 工具管理；CLI 只剩三条命令：server 入口加两个运维辅助命令。**没有任何会话命令（`open`/`send`/`status`/…），也没有 daemon/UI 命令**——它们在 v0.7.0 随会话搬进 MCP 进程后被移除。

```sh
node scripts/agent-bridge.mjs mcp        # 运行 MCP server（stdio）——会话活在这个进程里
node scripts/agent-bridge.mjs doctor     # 报告后端可用性（omp/codex/claude/cursor/kimi/dsh）
node scripts/agent-bridge.mjs cleanup    # 回收被 kill 的 MCP server 残留的孤儿子进程（omp/codex/claude/dsh 长驻进程、cursor 的 create-chat / 活跃轮短进程、kimi 的活跃轮短进程）
```

`mcp` 由 MCP 客户端自动拉起，不用手动跑。`cleanup` 是安全网：只终止那些「owning MCP server 已经不在了」（例如被 `kill -9`）的后端子进程，并清理它们的 pid record；仍由活着的 `agent-bridge mcp` 进程持有的子进程不会被动到。

```sh
node scripts/agent-bridge.mjs cleanup --json
```

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

写权限模式的映射**逐后端不同**，六个后端里四个有独立的高权限开关：

- OMP：`--auto-approve --approval-mode yolo`
- Codex：`sandbox: workspace-write`（Windows 上为 `danger-full-access`，见上）（`approvalPolicy: never`）
- Claude：`--permission-mode bypassPermissions`
- DSH：`DSH_PERMISSION_MODE=danger-full-access`（写档）vs `read-only`（读档）。读档不是提示词约束：文件工具由 DSH 文件系统沙箱拦写、shell 走 ACL 受限令牌（enforcement 报 `partial`），并由桥的权限应答器拒绝升级请求——属**工具面**写围栏，**不是** codex 那种 OS 沙箱。
- Cursor / Kimi：**没有独立的高权限开关**——`read` 与 `write` 用的是**完全相同的一条启动**（cursor 同 `--force`；kimi 同一条 `kimi.exe` 调用），差别只在 `read` 档会前置一句「仅只读调查」的**软提示**、`write` 档去掉它。所以这两者的 `write` **不是更高的 OS 权限**，只是把那句约束撤掉；反过来说，它们的 `read` 也**不是**硬性的不可写保证（详见 README §Backends 与桥 skill 的对应条目）。

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
- Claude 的 headless 进程会退出
- DSH 的 `dsh --profile acp` 进程会退出（形状 A：每个桥会话一个持久 ACP 进程；close 先 `session/close`、再拆进程树，3 s 强杀兜底）
- Cursor 无长驻进程可退（形状 B：进程按轮短驻）——**在途轮的 `close` 默认被拒**（返回 `{blocked:true, runningSessionIds}`，什么都不关）；传 `force:true` 才会整树终止那个活跃的 create-chat / turn 短进程，再忘掉云端 `chatId`；**因 cursor 无 delete-chat，云端 chat 及其读入的仓库内容仍留在 Cursor 的留存边界，删不掉**
- Kimi 同样无长驻进程可退（形状 B）——同样**在途轮默认拒绝关**，`force:true` 才会整树终止那个活跃的轮短进程，再忘掉本地 session id；kimi 无云端 chat 存储可删，但**已发出的 prompt 早已到过 Moonshot 云端 API**，close 追不回来

MCP server 进程**直接持有**它打开的会话（不再代理给任何 daemon）。当它退出时（客户端退出 / stdin 关闭 / `SIGTERM`、`SIGINT`、`SIGHUP` / stdout `EPIPE` / 未捕获异常），会清理自己持有的所有后端子进程（omp/codex/claude/dsh 长驻，及 cursor 活跃轮 / create-chat 短进程、kimi 活跃轮短进程）。stdin 关闭时它会先等 pending MCP 响应写完再退出。优雅退出（code 0）还会删除本次 run 的日志目录 `~/.agent-bridge/logs/<runId>/`；崩溃（code≠0）保留以便排查。仍然建议在任务完成后显式调用 `agent_bridge_close_session`。

如果 Agent Bridge 被 `kill -9` 硬杀，清理逻辑来不及执行。此时它会依赖 `~/.agent-bridge/pids/` 里的 pid record，在下一次 MCP server 启动（或手动 `cleanup`）时回收上次残留的后端子进程（六后端同理）。

只有活着的 `agent-bridge mcp` 进程会被识别为 pid record owner（判据是**它在跑什么**：命令含 `agent-bridge.mjs` + `mcp`，不看 argv0 —— Electron 宿主如 DSH 桌面版下 argv0 是 `DeepSeek Harness.exe` 而非 `node`），`cleanup` 不会误杀它仍在使用的后端子进程；只回收 owner 已经死掉的孤儿子进程。

检查是否有残留：

```sh
ps -axo pid,ppid,command | rg 'agent-bridge|omp --mode rpc|codex app-server|--profile acp' || true
find "$HOME/.agent-bridge/pids" -type f -maxdepth 1 -print 2>/dev/null || true
```

## 11. 升级

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

DSH 也一样：MCP 那一行指向的是 `<REPO>` 绝对路径，`git pull` 即更新；桌面版 HMR 会重载 patch 文件，但正在运行的 MCP 子进程要等下一次会话 / 重启 App 才重连——在 DSH 里新开一个会话，让 `mcp__agent-bridge__agent_bridge_doctor` 输出新的版本号即可确认。skills 的 junction 指向仓库，正文每次加载都重读，`git pull` 后立即生效。

## 12. 卸载

注销 MCP server，并删除 skill 软链：

```sh
codex mcp remove agent-bridge                          # 或 claude mcp remove agent-bridge --scope user
rm -f ~/.codex/skills/agent-bridge  ~/.codex/skills/agent-bridge-dev  ~/.codex/skills/agent-bridge-roundtable  ~/.codex/skills/agent-bridge-loop  ~/.codex/skills/agent-bridge-graph
rm -f ~/.claude/skills/agent-bridge ~/.claude/skills/agent-bridge-dev ~/.claude/skills/agent-bridge-roundtable ~/.claude/skills/agent-bridge-loop ~/.claude/skills/agent-bridge-graph
```

DSH：删掉第 6.1 节追加的 `- insert:` 块（有备份就恢复；若用了 home 级 `~/.dsh/cordis.patch.yml` 则改那里），并删掉第 6.2 节的 5 个 junction：

```powershell
$root = Join-Path $env:USERPROFILE '.dsh\skills'
'agent-bridge','agent-bridge-dev','agent-bridge-roundtable','agent-bridge-loop','agent-bridge-graph' |
  ForEach-Object { Remove-Item (Join-Path $root $_) -Force -Recurse -ErrorAction SilentlyContinue }
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

然后重启 Codex。

### `agent_bridge_doctor` 找不到 Codex

设置：

```sh
export CODEX_BIN="$(command -v codex)"
```

然后重启 Codex。

### `agent_bridge_doctor` 找不到 DSH

先确认 `dsh --version` 能跑（桌面版安装会把它写进用户 PATH；长期运行的旧进程可能持过期 PATH，新开 shell 再试）。`doctor` 的解析顺序是 `DSH_BIN` → 标准桌面安装路径 → PATH；装在别处才需要覆盖（**必须是 launcher 文件路径，不能是裸名字**）：

```powershell
$env:DSH_BIN = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

`doctor` 有 `dsh: ok` 但 `open_session({agent:"dsh"})` 报错，常见两种：①DSH 版本太老/该安装没有 `--profile acp`（用 0.2.x；`dsh --profile acp --help` 应 exit 0）；②`model` / `effort` 不在该会话公布的 `configOptions` 里（错误里会列出可用值；`model` 用友好名或 `provider/model` 形式，别猜不存在的 id）。

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

### DSH 里看不到 `agent_bridge_*` 工具

按顺序排查：

1. `dsh -V` 是否为 0.2.x（更老版本没有 `dsh-mcp-client` 这一行，需升级 DSH）；
2. 行插对没有：桌面版改的是 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（**不是** `cordis.yml`），顶层是 `- insert:`，不要嵌进别的键；Windows 路径用**单引号**；
3. 只验证组装、不发模型请求：`dsh --profile headless --patch <overlay 文件> --dump-config`，输出里应出现 `mcp-agent-bridge`；报 YAML 错误就先修格式；
4. 先确认桥自己能跑：`node "<REPO>/scripts/agent-bridge.mjs" doctor`；
5. 工具名是**带命名空间**的 `mcp__agent-bridge__agent_bridge_*`（不是裸 `agent_bridge_*`），让模型按前者找；
6. `failOnStartupError: false` 会让 MCP 启动失败**静默**（工具直接不出现）；排查时先临时改成 `true` 让 DSH 在启动时报错，定位后再改回；
7. 桌面版保存后**新开一个会话**（host-plane 改动对新会话生效），仍不行再重启 App；若 patch 文件被 app 自愈重命名（目录里出现 `.bak-*`），把你的块重新加回去。

### DSH 里 `agent_bridge_wait` 提前超时

DSH 的 MCP 客户端默认每次调用 60 s 超时，而 `agent_bridge_wait` 默认要等 10 分钟。确认第 6.1 节的 `toolCallTimeoutMs: 900000` 在行里；改完让新会话生效（或在 headless 下重新运行）。这个超时是 DSH 侧的调用超时，不是桥的问题——桥的 `wait` 超时是非破坏性的，但 DSH 侧掐断后这一轮结果就不会回到模型上下文里。

### DSH 里委托 OMP 到含 `.mcp.json` 的目录会秒退

症状：`open_session({agent:"omp", cwd:<含 .mcp.json 的目录>})` 打开后约 5–6 s 变成 `failed`，`lastError: OMP RPC exited with code 1`。

原因（已定位，**v0.12.0 已修**）：OMP 会读取 cwd 的 `.mcp.json` 并把 agent-bridge 作为嵌套 MCP 挂载；嵌套桥启动时跑清理逻辑，而旧版桥的 owner 存活判定只认 `node` 开头的进程（Electron 宿主下是 `DeepSeek Harness.exe`），于是把外层 OMP 误判成孤儿并杀掉。

处置：升级到 v0.12.0 即可，委托 `cwd` 不必再避开 `.mcp.json`（另外这也验证了 owner 判活的新口径：命令含 `agent-bridge.mjs` + `mcp` 即视为存活）。回归测试：`node tests/repro-owner-electron-argv0.mjs`。
