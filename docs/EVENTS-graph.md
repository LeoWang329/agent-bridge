# agent-bridge-graph 事件 schema(`transcript.jsonl`)—— **唯一规范**

**关联** `docs/DESIGN-graph-viz-2026-07-26.md`(理由书:只回答「为什么这样定」)、`docs/UI-REQUIREMENTS-graph-viz-2026-07-26.md`、`skills/agent-bridge-graph/tools/node-core.mjs`(事件的产生方)。

> **这份文件是规范,不是说明。** writer(`node-core.mjs` 里的记录层)与 viewer(`viz/serve.mjs` + `viz/index.html`)**只读这一份**就能写出来:字段、类型、可空性、上限与数值域、顺序、控制通道与 SSE 的 wire 格式、判定优先级、安全边界都在这里,不需要回头翻 DESIGN。
> DESIGN 解释每条规定**为什么**是这样(以及历轮复审删掉了什么、代价是什么);两份打架时**以本文件为准**,并回去把 DESIGN 改对。
>
> ⚠️ **本文件里没有「待定」。** 每一条都是可以直接照着施工的合同。真拿不准的,先定下来再写进来——**规范里的 TBD 是假规范**:它让实现者以为自己拿到了合同,而两个实现者会各定各的。

## 0. 这份文件规定什么、不规定什么

### 0.1 边界判据(**先看这一条**)

> **本文件规定的是「可观测合同」**——落到磁盘、管道、SSE 上的**字节**,它们的**顺序**与**含义**。
>
> 「`node-core` 内部怎么做到」——admission 怎么封、in-flight promise 用什么结构登记、冻结内容用哪条通道派发、`RECEIPT_VERSION` 怎么迁移、回执自身的字段合同——**属于 DESIGN 与施工清单,不进这里**。

**判据只有一句:一个只写 viewer / 只写页面的人,需要知道这件事吗?** 需要 → 进本文件;不需要 → 不进。

⚠️ 这不是"详见 DESIGN §X"那种偷懒——**可观测的部分必须在这里定义完整,一个字都不许外包**。
但反过来同样要守:把 DESIGN 的实现段落整段搬进来,得到的是**同一件事的第二份全文**,而两份全文一定会漂,漂了之后谁也说不清哪份算数。**一份规定字节、一份解释为什么**,才是能长期维持的分工。

### 0.2 阅读约定

- **`?` = 这个键可以缺席**(整个键不出现),不是"值可以是 null"。
- **`| null` = 这个键恒在,值可以是 null**。
- schema 里**没有**写 `?` 的键 **恒在**;**没有**写 `| null` 的键**不得**写成 null。这两条是 §7 那条有界化不变式能成立的前提。
- **未列出的键一律不许出现。** 消费方遇到未知键必须忽略(不崩),但生产方发未知键就是违约。
- 「字节」一律指 **UTF-8 字节数**。
- ⚠️ **本文件里所有按"个数"计量的字段——`charCount`(尝试级 §5.6、轮级 §5.4 与 `TurnSummary`、进度 §5.7,共四处)与 `node:progress.tail`——单位都是 JavaScript 的 UTF-16 code unit,不是 Unicode 字符**。它们是桥的快照与 `text.length` 原样给的,一个 emoji 计 2。**页面不许把它显示成"字符数"。**
- 类型 `hex64` = 64 位小写十六进制字符串(`/^[0-9a-f]{64}$/`);`hex40` / `hex32` 同理但 40 / 32 位。
- ⚠️ **指纹字段有两种长度,不许"统一成 64"**:**内容**指纹(`sha256` / `inputSha256` / `promptSha256` / `roleSha256`)是 `hex64`;**任务单**指纹(`turns[].turnSpecHash`,以及 `input.json` 里的 `specHash`)是 **`hex32`** —— 源码对两者用的是同一个约定:SHA-256 取**前 32 个 hex 字符**(`.slice(0, 32)`)。把 `turnSpecHash` 当 `hex64` 校验,会把**每一条合法记录**判成违约。
- 所有 `number` 的取值域集中在 **§6.1**;`NaN` / `Infinity` **在任何字段上都非法**。

---

## 1. 落盘位置、谁写、归档布局

### 1.1 事件流

```
<out-dir>/nodes/.runs/<graphId>/transcript.jsonl
```

- **每个 graph 一份**。`<graphId>` 是每次 **viz-enabled** 的 `withBridge` 调用生成的一个 `crypto.randomUUID()`,**不从 pid / 时间 / outDir 推导**;transcript 用 `wx` 创建(撞了就重新生成 graphId)。
- **不在 out-dir 根部**,也不在 `<out-dir>/runs/`:viz 写出的**每一个字节**都必须落在 `<out-dir>/nodes/` 之下,否则会被 write 节点的脏树闸算成主树未提交改动、把后续每个 write 节点全部拦死。
- `viz:true` 时 `outDir` **必填**;`withBridge` 入口先 `ensureDir` → `realpathSafe` 绑定 canonical outDir,再起 viewer、建 transcript、跑用户回调。**`runNode` 与 `conversation` 两个节点级入口**拿到的 outDir 与它不符 → `UsageError`(且必须早于任何落盘,包括建 `<id>.lock`)。⚠️ **只约束 `runNode` 是不够的**:`bridge.conversation({outDir: B}, …)` 一旦放行,归档与 transcript 就分家了,事件里那些 `ref` 指向另一个 out-dir,`/file` 的前缀闸(§10.5)必然拒掉它——页面上每一份输入与产出都点不开。
- **viz 关闭时不写 transcript、不建归档**,本文件描述的一切都不存在。

### 1.2 谁写

- **单 writer,由结构保证,不靠锁**:没有任何代码路径会去 append 一份已存在的 transcript(目录名带随机 UUID)。**不要加共享 writer 锁**。
- **单 writer ≠ 有序**:writer 必须用**一个长期打开的 fd + 同步 `writeSync`**,或把所有 append 串到**一条 Promise 链**上。否则并发节点(默认 4 个名额)会让 `seq=11` 落在 `seq=10` 前面。
- **`append()` 的合同(四条,缺一不可)**:
  1. **循环补齐**:直到该行(**含结尾换行符**)的全部 UTF-8 字节写完才 resolve。`fs.writeSync` 与异步 `write` **都可能短写**。
  2. **返回 0 / 抛错 / 中途失败** → 视为 recorder 损坏,走 §8 的 `recording-failed`,并带上损坏**之前**的 `lastGoodOffset`。
  3. resolve 点是**底层 write 的回调/Promise 完成**,不是"加入队列",也不是 `stream.write()` 的返回值。
  4. **不做 `fsync`**(刻意的边界:普通强杀发生在 `write` 返回之后,已交给内核页缓存的数据不会随进程消失;抗断电/内核崩溃不在需求里)。
- **初始化成功之后,所有 emitter 与归档写入必须是 non-throwing 的**:内部自己 try/catch,对外只返回"写没写成"。**两个节点级入口(`runNode` 与 `conversation`)各有一个兜底 catch**,观测层随便抛一个异常上去就会把节点的业务结局改掉(`runNode` 那条路改成 `unknown`;`conversation` 那条路会顺着 `turn()` 冒进用户回调,最后成 `callback_error`)—— **观测层永远无权改变节点的业务结局**。
- 初始化失败(建归档根 / 建 transcript / 起 viewer)**在用户回调之前 fail-fast**;初始化之后的任何观测写入失败**只影响资产状态**(§3)。

### 1.3 归档布局(事件里的 `ref` 只能指向这里)

```
<out-dir>/nodes/                                  ← canonical 区(执行与复用,行为完全不变,viz 不碰)
<out-dir>/nodes/.runs/<graphId>/
        ├── transcript.jsonl                      ← 本文件定义的事件流
        └── <nodeSeq>-<id>/                       ← 每个节点一份不可变归档
            ├── input.json                        冻结的 spec 字段快照   → node:observed.spec
            ├── role.md                           冻结的 system 侧原文    → node:observed.role(没配 roleFile 就没有)
            ├── receipt.json                      收尾返回的内存对象      → node:settled.receipt
            ├── change.diff                       write 节点才有          → node:settled.diff
            └── turns/<key>/                      **每一轮一份**,`<key>` 就是 `node:turn.turnKey`
                ├── prompt.md                     该轮冻结的 user 侧原文  → node:turn.input
                │                                 **同时就是本轮 attempt 1 的输入**
                ├── attempt-<n>.input.md          **n ≥ 2 才有**          → node:attempt.input
                ├── attempt-<n>.output.md         该轮每次尝试都有        → node:attempt-settled.output
                └── scene/                        **该轮**非 ok 才有      → node:turn-settled.scene.files
                    ├── session.log                   → scene.files.sessionLog
                    ├── answer.txt                    → scene.files.answer
                    └── status.json                   → scene.files.status
```

⚠️ **`turns/` 这一层没有例外**:单轮节点(`runNode`)的那一轮 `key` 恒为 **`"main"`**,它的输入原文就在 `turns/main/prompt.md`,产出就在 `turns/main/attempt-1.output.md`。**归档布局里不存在"没有轮的那条老路"**——留一条,两条路迟早漂,而页面必须为两种布局各写一遍解析。

- **目录里有什么,不靠 manifest、不靠目录 ref,全靠事件**:每个资产由**产生它的那条事件** announce(§3)。**没有任何事件字段指向 `<nodeSeq>-<id>/` 这个目录本身**(`archiveRef` 已删)。
- `<nodeSeq>` 是该节点在本 graph 内的序号(分配时机见 §5.2),**不能只用 `<id>`**:同一个 graph 里带 `force` 顺序重跑同一个 id 是合法的。
- **归档必须是传递闭包**:写进归档的 `receipt.json`,其内部所有相对 ref(顶层 `artifactRef`/`diffRef`/`sceneRef`,以及**每一轮**的 `turns[].artifactRef`/`turns[].sceneRef`/`turns[].attempts[].inputRef`/`turns[].attempts[].artifactRef`)**一律重写**到当前 `<graphId>/<nodeSeq>-<id>/`;页面能点到的 ref **不得跨 graph、不得指 canonical**。⚠️ **新增一层就要重写一层**:漏掉 `turns[]` 里那些,页面点开的就是 canonical 区里会被下一波覆盖的文件。
- ⚠️ **重写 ref 的同时,要把 canonical 区的那条绝对路径删掉** —— 顶层与每一层的 `artifactPath`、`diffPath`、`scene.dir` 在归档回执里**一个都不留**。
  理由与"不得指 canonical"是同一条:canonical 区的 `<outDir>/nodes/<id>.md` 会被同 id 带 `force` 的下一波**原地覆盖**。留着那条路径,等于给读的人一条"打开这个"的指示,而打开之后读到的是**另一次运行**的字节 —— **伪造历史,比缺失更糟**。
  ⚠️ 这条规则早先只被应用到 `diffPath` 一个字段上,`artifactPath` 三层(顶层 / 轮 / 每次尝试)原样留着 —— **同一条规则只落实到一个字段**,与上面"新增一层就要重写一层"是同一个坑的两种长相。
- **先原子写成功归档文件,再发引用它的事件。** 顺序反了,页面会读到 404 并当成"文件丢了"。
- **复用命中的节点也归档**(每一轮的产出与回执各拷一份),且归档时机在**复用闸之后**——那道闸刚刚逐项坐实了每一轮的产出 sha、diff sha、基线 commit 与分支现状,所以归档下来的是**刚被验证过**的东西。
- ⚠️ **canonical 区里每次尝试各存一份审计原件**(`<id>.a<n>.md` / 对话是 `<id>.t-<key>.a<n>.md`)——**v2 起第一次的产出不再被第二次覆盖**。归档区照抄这个形状:`turns/<key>/attempt-<n>.output.md` **每次尝试各一份**。
  ⚠️ 本节早先写的是「一轮之内每次尝试都覆盖该轮那一个 `artifactPath`」——那句话**相对 v2 的代码已经过时**,而且它误导过一次真实的实现:复用命中时照它去做,会只归档最后那一份、把早先几次标成"只剩指纹",**否认几份确实还在磁盘上的证据**("被打回的那一次到底写了什么"恰恰是复审时最想看的东西)。**轮级**那一个 `artifactPath` 仍然每次被覆盖(它是"这一轮当前的产出"),但**每次尝试另有自己的原件**。
- **每一轮的 attempt 1 输入不另存一份**:该轮第一次发的就是这一轮 `prompt` / `promptFile` 的**原文**,所以本轮 `attempts` 中 `.n === 1` 那一项的 `input.ref` 直接指向 `turns/<key>/prompt.md`,且 **它的 `inputSha256` 必然等于 `node:turn.input` 的 `sha256`**(这是可验的断言,不是约定)。
- **单轮节点的 `node:observed.prompt` 与 `node:turn{turnKey:"main"}.input` 是同一份字节**:两者的 `ref` 与 `sha256` **必须逐字节相同**,都指向 `turns/main/prompt.md`。**不许为 `node:observed` 另存一份 `<nodeSeq>-<id>/prompt.md`**——那是同一段正文的第二个副本,而两份"本该相同"的字节迟早会被改成不同。
  ⚠️ 对话节点**没有节点级的 prompt**(逐轮才有,见 §5.2),那时 `node:observed.prompt` 是 `{state:"not-applicable"}`。
- **顶层产出同样不另存一份:归档里没有 `artifact.md`。** `node:settled.artifact` 指向**该节点最后一次成功复制到本地的那份 `turns/<key>/attempt-<n>.output.md`**。

  **"哪一项"与"它是什么状态"是两步,不能合并成一句"取最后一个 present"。**

  1. **先选那一项**:按「**最后一次成功复制到本地**」选——即 `turns[]` 里最后一个"有过本地原件"的轮,再取该轮 `attempts` 中**唯一满足 `.n === n`** 的那一项。⚠️ **消费方从 wire 上就分得出**,按 code 分两类:**没有本地原件** = `source-missing`(从来没有过)与 `fingerprint-only`(有过,但这一次够不着——在上一次运行的归档区里,或当初就没落盘);**有本地原件、只是这一层没保住** = `present` 以及 `write-failed` / `sha-failed` / `archive-root-failed`。
     ⚠️ **只把 `source-missing` 当"没有"是不够的。** `fingerprint-only` 划错边会让"最后一次只剩指纹"的那一轮,在生产者眼里选中**更早那次**、在校验器眼里选中**最后那次** —— 同一个问题两个答案,而这条规则的全部意义就是让两边选中同一项。
  2. **再照抄它的状态**:那一项归档成功 ⇒ `artifact` 是 `present` 且 `sha256`/`ref` 与它逐字相同;那一项**归档失败** ⇒ `artifact` 是 `unavailable` 且 **`code` 与它相同**(§5.8 说的"同生同灭")。

  ⚠️ **为什么不能"回退到上一个 present"**:那会把一份**更早的、已经被后一次覆盖掉结论的**产出,当成这个节点的交付物摆在最显眼的位置。用户点开看到的是**旧答案**,而页面上没有任何迹象说明这不是最终那一份——**静默地拿旧内容冒充结果**,比诚实地说一句"这一份没归档成功"坏得多。

  并且 **`artifact.sha256` 必须等于那一项 `output.sha256`,也必须等于该轮 `TurnSummary.output.sha256`**(可验的断言)。**一次成功复制都没有过** → `artifact` 是 `{state:"unavailable", code:"source-missing"}`(§5.8)。
  ⚠️ **`attempts[n]` 这种写法在本文件里一律非法**:`n` 是 **1-based**,而数组是 0-based(attempt 1 躺在下标 0)。任何"第 n 次尝试"都必须表述成「`attempts` 中**唯一满足 `.n === n`** 的那一项」——这条同时也是 writer 的义务:**同一轮的 `attempts` 里 `n` 不得重复**,所以"唯一"是可以断言的。
  ⚠️ `artifact` 与它所指的那一项 `output` **同生同灭**:那一项归档失败(`unavailable`)时,`artifact` 也只能是 `unavailable` 且 **`code` 相同**——ref 指向一个不存在的文件就是死链接,而死链接比"给不出"更坏(页面会显示成"点得开")。

#### 冻结:事件描述的那份字节,**就是真派发出去的那份**

- `role` 资产的字节,**是 `normalizeSpec` 阶段冻结的那一份**;**每一轮的 `prompt` 字节,是那一轮被受理(`node:turn` 之前)时冻结的那一份**。都不是"事件发出时再去读一次文件"。
- `attempts[].inputSha256` 是**该次尝试实际派发出去的 user 侧字节**的 SHA-256。
- **派发用的必须是同一份字节。** 否则事件在撒谎:`specHash` 与归档描述的是一份**从未被派发过**的输入。节点在并发闸上等几分钟是常态,这中间文件被改过就足以让"页面上那份输入"与"模型真收到的那份"分家,而页面上没有任何迹象。

⚠️ 冻结下来的内容用哪条通道、以什么形式送到后端,是 `node-core` 的实现细节,**按 §0.1 的判据不进本文件**。可观测的只有上面三句。

#### 每次尝试恒写一份产出原件(canonical 区的命名,**一条投影规则**)

**每一次尝试都写一份产出原件到 canonical 区,与 viz 开关无关。** 文件名按下面这条**唯一**的投影规则:

| 谁跑的 | 该轮产出 | 该轮第 N 次尝试的原件 | 该轮现场 |
|---|---|---|---|
| `runNode`(N=1,`key` 恒为 `"main"`) | `nodes/<id>.md` | `nodes/<id>.a<N>.md` | `nodes/<id>.scene/` |
| `conversation()` 的每一轮 | `nodes/<id>.t-<key>.md` | `nodes/<id>.t-<key>.a<N>.md` | `nodes/<id>.t-<key>.scene/` |

- **投影按"调用的是哪个 API"分派,不按 `key` 的字面量分派**:一段对话里的某一轮完全可以也叫 `main`,它照样写 `nodes/<id>.t-main.md`。
- ⚠️ **`<N>` 在每一轮内从 1 重新开始**(§5.6),所以**没有 `.t-<key>` 这一段就会撞名**:`draft` 轮的第 1 次与 `fix` 轮的第 1 次会写进同一个文件,后写的把前一份**审计原件**盖掉。
- ⚠️ 这条投影**只作用于 canonical 区**(viz 不碰的那半边)。**归档区一律是 `turns/<key>/`,没有投影、没有例外**——页面看到的布局对单轮与多轮完全一致。

这条必须写在这里:`attempts[].output` 与 `node:attempt-settled.output` 的**全部**资产状态都建立在"这个文件存在"之上——归档器拷的就是它。它是可观测合同的地基,不是 viz 的附属品;viz 关着时它照样写,所以**下一波开着 viz 命中复用时,每一轮、每一次尝试的产出都还在**。

#### `input.json` 的键集与序列化

`input.json` **只是 spec 的快照,不兼任资产目录**——它不列举归档里有哪些文件(那是各条事件的职责),也**不含 prompt / role 的正文**(正文是 `prompt.md` / `role.md`,这里只放指纹)。

```js
{ id, nodeSeq, agent, model, effort, access, cwd, timeoutMs, reask, baseRef,
  schema, outputShape, promptSha256, roleSha256, specHash }
```

- **这 15 个键恒在**;没设置的可选项写 `null`,**不省略键**(键集固定才谈得上"可对比")。**多轮不改这个键集**——轮级参数不进 `input.json`,它们在 `node:turn` 里逐轮给出。
- `promptSha256` / `roleSha256` 是**冻结内容**的指纹(`hex64`);没配 `roleFile` → `roleSha256: null`。⚠️ **`specHash` 不是 `hex64`,是 `hex32`**(任务单指纹取 SHA-256 前 32 个 hex 字符,与 `turnSpecHash` 同一个约定,§0.2)——**同一个文件里两种长度并存,页面别用同一条正则去校验**。
- ⚠️ **对话节点的 `promptSha256` / `timeoutMs` / `schema` / `outputShape` / `reask` 五个键恒为 `null`**:这五样是**逐轮**参数,写在顶层任务单上直接 `UsageError`(§5.2)。**它们为 null 不是"没设置",是"这一层没有这个概念"**,页面不许显示成"用了默认值"。
- **序列化定死**:**键名字典序**、2 空格缩进、UTF-8、结尾一个换行。稳定字节才能逐字节对比、才能自己进指纹。

---

## 2. 信封(每行都有)

每行是一个 JSON 对象 + 一个 `\n`,UTF-8:

```
{ v, seq, ts, graphId, event, payload }
```

| 字段 | 类型 | 可空 | 含义 |
|---|---|---|---|
| `v` | number | 否 | schema 版本,**恒为 `1`**。见下面的跨版本规则 |
| `seq` | number | 否 | 序号,**从 `0` 起、步长 `1`**,writer 维护。消费方用它**去重 + 排序**,并可据它自查记录完整性(见下) |
| `ts` | number | 否 | epoch **毫秒**(非负安全整数)。它就是这条事件发生的时刻——所以 `run:started` 不带 `startedAt`、`node:turn` 不带 `waitingSince` |
| `graphId` | string | 否 | 本次 graph 的 UUID。**每条都带**,所以事件的 payload 里**永远不再出现 `graphId`** |
| `event` | string | 否 | 事件类型,取值见 §4 |
| `payload` | object | 否 | 事件专属字段。**恒是对象**(哪怕只有一个键) |

**append-only。** 已经写下的行永不修改、永不删除。

#### `v` 的跨版本规则(**只有一条**)

消费方见到 **`v > 1`** 的行:**整条标成「更新的 schema」,不解析它的 `payload`,不据它推断任何节点状态**。

只标不解析,是因为"逐字段猜"必然猜错:一个新版本可以改字段含义而不改字段名。**标出来**则页面能诚实地说"这里有我读不懂的记录",而不是**漏掉**——漏掉会让缺失的终态变成一个假的 `abandoned`(§10.1 第 4 档)。`v` 相同则整条按本文件解析,未知键忽略(§0.2)。

#### `seq` 必须是稠密的

**writer 侧的顺序定死:先有界化(§7)→ 再分配 `seq` → 然后才写。**

- **被丢弃的 `node:progress` 不占号**——它在分配之前就被丢了(§7 只允许丢这一种事件)。
- **转 `recording-failed` 的那一条占号**——它就是 `atSeq`(§8.1),消费方需要一个"从这里开始不可信"的锚点,而锚点必须是个具体的号。

于是 transcript 里的 `seq` 是 `0, 1, 2, …` **连续无空洞**,唯一的边界是:`[0, atSeq)` 稠密,`atSeq` 那一条本身没落盘,之后不再有任何行。

⚠️ **这给了 viewer 一条白送的自查不变式:出现空洞 = 记录损坏**,不需要任何额外字段。
`recording-failed`(§8.1)与"看见空洞"是**两个独立的损坏信号**,任一出现都必须整体标注(§10.1),**不许拿空洞去推断"那个节点本来就没有"**。

#### 两种时间口径**并存**,不许统一

- 信封 `ts` 与控制消息 `owner-final.endedAt`:**epoch 毫秒**(number)。
- `node:progress.lastEvent.at`:**桥原样给的 ISO 8601 字符串**(§5.7)。

这是事实,不是疏漏:`lastEvent` 整个对象来自后端,我们只做白名单裁剪,**不改写它的值**——改写就等于替后端断言它那个时间戳的时区与精度。**实现时别混用**,页面上也要分清哪个是我们记的、哪个是转述的。

### 2.1 三条硬约束

1. **整行 UTF-8 字节 ≤ 1 MiB**(含换行符)。writer 落盘前**再量一次**;超限的处置见 §7。
2. **半行容错**:writer 崩溃可能留下无换行结尾的半行。**回放与 tail 都必须缓冲到下一个 `\n` 再解析**,绝不 `JSON.parse` 半行。**只有末尾那一行**允许不完整;**非末尾**位置的坏行是历史损坏(§10.4)。
3. **页面的唯一键是 `(graphId, nodeSeq)`**。写法上可以记作 `nodeRunId = "<graphId>:<nodeSeq>"`,但 **`nodeRunId` 不是 wire 字段**——`graphId` 在信封里、`nodeSeq` 在 payload 里,**由客户端自己拼**。`id` 只是逻辑名与显示标签,**不是主键**(同一个 graph 里可以有两个 `id` 相同的节点)。
   **往下两层同理**:轮的唯一键是 **`(graphId, nodeSeq, turnKey)`**(`turnKey` 只在**它所属的那个节点内**唯一,不同节点可以都有一轮叫 `main`);尝试的唯一键是 **`(graphId, nodeSeq, turnKey, n)`**。⚠️ **少带一层就会归并错**:全 graph 有多少个节点,就有多少个 `turnKey === "main"`;一段 5 轮的对话里就有 5 个 `n === 1`(§5.6)。
   ⚠️ **同一个 `(nodeSeq, turnKey)` 绝不会出现两次,哪怕那一轮压根没跑起来**:`key` 是这一轮的身份(也是归档目录名),**入场失败之后它也不还回来**——同一个 key 再来一轮当场 `UsageError`,要重试必须换一个 key(§5.4「没能开始的轮」)。所以**页面按 `turnKey` 建 map 是安全的**:不会有后一条把前一条盖掉。这条由工具的回归钉死,不是靠编排自觉。

---

## 3. 公共类型

### 3.1 `AssetState` —— 每个可点击资产都是一个判别联合

**事件层只讲 `AssetState`,不出现 `*Ref` 这种可空字符串。**(回执里的 `artifactRef`/`diffRef`/`sceneRef`/`attempts[].inputRef` 是**另一份合同**,不受此约束,也不进事件。)

```js
{ state: "present",        ref: string, sha256: string, byteCount: number }
{ state: "not-applicable" }
{ state: "unavailable",    code: string }
```

| `state` | 含义 | 附带字段 |
|---|---|---|
| `present` | 东西在归档里,页面点得开 | **`ref`/`sha256`/`byteCount` 三样恒有,一个都不能少** |
| `not-applicable` | **本来就没有**(没配 role、read 节点没有 diff、正常收场因而没保现场) | 无(不许有任何其它键) |
| `unavailable` | **期望能给出,但给不出**——原因看 `code` | **`code` 恒有** |

- `ref`:**相对 out-dir** 的 POSIX 相对路径,**必须**以 `nodes/.runs/<本条事件信封里的 graphId>/` 开头;不得是绝对路径、不得含 `..`。
- `sha256`:`hex64`,该文件**内容**的指纹。**空文件也有 SHA**(`e3b0c442…`),所以零字节产出照样是 `present`。
- `byteCount`:非负整数,该文件的字节数。**可以是 0**。
- **`{state:"present"}` 却没有 `ref`,等于没有**:页面知道"东西在"却点不开。`sha256`/`byteCount` 同理进 schema(它们是"页面上这份 = 磁盘上那份"的唯一对证手段)。

#### `pending` 为什么不需要编码

**"那条事件还没出现、而节点仍在跑"本身就是这个意思。** 资产由**产生它的那条事件**announce,事件没来 ⟺ 还没产生。给它一个 `state:"pending"` 只会多出一个必须被写进磁盘、又必须被后来的事件推翻的状态,而它没有任何一条消费逻辑依赖。

#### 还有一种状态**不在**这套联合里

`recording-failed`(§8)发生在某个资产的生产事件**之前**时,那个资产**根本没有 AssetState**:既不能说 `not-applicable`(不知道适不适用),也不能说 `unavailable`(不知道有没有尝试过),owner 都结束了更不能一直显示"等待中"。

**这是 viewer 的派生态,不进 schema**:「记录从第 N 条起不完整,这一项的状态未知」。⚠️ **全局的记录损坏必须盖过逐资产的推断**——否则页面会拿"没看到事件"去推"本来就没有"。

#### `code` 是**开放字符串**,不是封闭枚举

下面这张表是**目前已知需要各自文案**的取值,**以后会加**:

| `code` | 意思 |
|---|---|
| `archive-root-failed` | **这个节点自己的归档子目录**(`<nodeSeq>-<id>/`)建不起来,于是它的东西一样都没落下。⚠️ **不是 graph 归档根**——那个建不起来属于初始化失败,在用户回调之前就 fail-fast 了,根本走不到逐资产这一层 |
| `write-failed` | 该资产自己写盘失败 |
| `source-missing` | 源头就没有可拷的东西(如 `textRef` 取不回来) |
| `sha-failed` | 拷下来了但算不出指纹。**不能当 present**:指纹是复用与防篡改的判据 |
| `fingerprint-only` | 「**这一层拿不到正文,指纹还在**」。成因不止一种:原运行 viz-off(是选择)、复用时 n≥2 的重说提示这一次没有、候选正文与 `inputSha256` 对不上因而**拒绝落盘**(是保护)、产出原件当时**复制失败**(是故障)。⚠️ **它本身不表示"记录失败",但也不等于"一定不是故障"** —— 早先这里写死成"没有任何'出错了'的含义",页面照着它在真故障时反过来安慰用户 |
| `unknown` | 兜底:**确实拿不到,但连原因都没分辨出来**。它是「已知的未知」 |

**生产方**:分辨得出原因就写具体 code;分辨不出才写 `unknown`。

**消费方(UI)必须能显示一个没见过的 code**:
- **原样显示** + 通用兜底文案;
- **不得崩**;
- **不得**静默降级成 `not-applicable`(那是把"给不出"谎报成"本来就没有");
- **不得**归到某条已知原因上;
- **不得**先偷偷改写成 `unknown` 再显示——字面量 `unknown` 与"没见过的 code"必须有**不同**的文案。

#### 两条逐槽位规则

1. **`archive-root-failed` 时,该节点每个「本次本来就该归档」的资产都要各自标 `unavailable`**,不能只在根上标一次——否则按逐资产规则它们会被读成"本来就没有"。
2. **但先天不适用的槽位仍然是 `not-applicable`**:没配 role 的节点、read 节点的 diff、正常收场因而没有 scene。把它们也标成 `unavailable`,就是把"从来不适用"谎报成"本该拿得到、现在拿不到"。

#### 各槽位的取值范围(**收窄,便于判别**)

| 槽位 | 可能的 state | 说明 |
|---|---|---|
| `node:observed.spec` | `present` / `unavailable` | 冻结内容一定存在于内存,**永远不会**是 `not-applicable` |
| `node:observed.prompt` | `present` / `not-applicable` / `unavailable` | **`not-applicable` ⟺ 这是个对话节点**(prompt 是逐轮参数,顶层压根没有,§5.2)。单轮节点一定 `present` 或 `unavailable`。⚠️ **这个 ⟺ 是页面判别「这是不是一段对话」的唯一判据**——§10.8 的"封口点"派生就靠它(**不为此新加字段**,§5.4) |
| `node:observed.role` | `present` / `not-applicable` / `unavailable` | 没配 `roleFile` → `not-applicable` |
| `node:turn.input` | `present` / `unavailable` | 该轮实际冻结的提问一定存在过 |
| `node:attempt.input` | `present` / `unavailable` | 该次尝试实际派发的内容一定存在过 |
| `node:attempt-settled.output`、`turns[].attempts[].output` | `present` / `unavailable` | 见 §5.6 的 status × output 矩阵。**`no-output` 也可能是 `present`** |
| `node:turn-settled.output`、`turns[].output` | `present` / `unavailable` | 该轮产出。**一次成功复制都没有过** → `unavailable{code:"source-missing"}`(「没能开始的轮」`status:"not-started"` 恒落在这一格,§5.4) |
| `node:settled.receipt` / `.artifact` | `present` / `unavailable` | **顶层产出对任何节点都不是"先天不适用"**(0 轮的节点也一样,那时是 `unavailable{code:"source-missing"}`)。归档那一步失败 → `unavailable` 且 `code` 与它所指的那一项 `output` 相同(§1.3) |
| `node:settled.diff` | 三态皆可 | read 节点、以及 `outcome === "no-changes"` 的 write 节点 → `not-applicable` |
| `node:turn-settled.scene` | 见 §3.2 | **scene 是轮级的**,`node:settled` 上**没有**这个槽(§3.2) |

### 3.2 `SceneState` —— scene 是**容器**,不是普通资产,而且**挂在轮上**

`saveScene()` 建的是一个**目录**,里面**分别**尝试写三个文件;而 `/file` 只放行普通文件、拒绝目录。所以 scene 不能套 `AssetState`(目录没有有意义的 sha 与字节数,`ref` 也点不开),它有自己的形状:

```js
{ state: "not-applicable" }                 // 正常收场,压根没保现场
{ state: "unavailable", code: string }      // 该保没保成(含 archive-root-failed)
{ state: "present", files: {
    sessionLog: AssetState,                 // ← session.log
    answer:     AssetState,                 // ← answer.txt
    status:     AssetState,                 // ← status.json
}}
```

- **`present` 时 `files` 的三个键恒在,各自是一个完整的 `AssetState`**——三件套本来就可能只拿到一两件(`answer.txt` 取决于 `textRef` 还在不在,`status.json` 取决于 `agent_bridge_status` 调不调得通)。
- **容器本身没有 `ref`/`sha256`/`byteCount`**,页面**不得**把 scene 渲染成一个可点击的目录链接。
- **scene 只出现在 `node:turn-settled.scene` 这一个槽位上,`node:settled` 上没有它。** 理由是可数的:一段对话里**每一轮都可能各自留一份现场**(第 1 轮超时、第 2 轮后端挂了 ⇒ 两份),节点级只有一个槽,放不下;而"放最严重那一轮的"是把另一份**确实存在的证据**藏起来。⚠️ 单轮节点不是特例——它的现场同样只在**它那一轮**的 `node:turn-settled` 上(§5.4)。
- **容器这一层的判据要说准**:`saveScene()` 只在**结束这一轮**时、且该轮 status **既不是 `"ok"` 也不是 `"not-started"`** 时跑(⚠️ `not-started` 那一轮压根没走到"结束这一轮"那一步,连会话都多半没开 ⇒ 它的 `scene` 恒 `{state:"not-applicable"}`,§5.4;现场必须**当轮**冻结:桥的 `textRef` 是会话级的单一路径,每轮覆盖同一个文件,延到收尾再取就会把后一轮的答案标成前一轮的现场)。而 write 节点的交付降级、回执落盘失败降级、回调异常降级**都发生在所有轮之后**。所以 **`node:settled.status === "unknown"`(或 `callback_error`)且该节点每一轮的 `scene.state` 都是 `not-applicable` 是一个合法组合**(每一轮本来都 ok,是节点收尾才降的级),页面**不许**据此判定"该保没保成"。
- **强杀路径根本进不到收尾**,所以那时该轮既没有 scene、也没有 `node:turn-settled`,节点更没有 `node:settled`。

#### `files` 三个槽各自的判据(**逐槽定死,不许套用同一句**)

| 槽 | `not-applicable` | `unavailable` | `present` |
|---|---|---|---|
| `sessionLog` | **不会出现** | 该保没保成:取不回来、写盘失败,或本节点的归档子目录建不起来 | 拿到了 |
| `answer` | **不会出现** | 同上 | 拿到了 |
| `status` | **没有 `sessionId`**——会话压根没建起来,**无状态可查** | 有 `sessionId`,但取状态或写盘失败 | 拿到了 |

⚠️ **只有 `status` 有 `not-applicable` 这一档。** 另外两个槽一旦进了 `saveScene()`,就都是"本该拿得到"的东西,给不出就得说给不出——把它们标成 `not-applicable`,是把"没保住现场"谎报成"本来就没有现场"。

### 3.3 `BoundedSummary` —— 唯一的降级形状

```js
{ totalBytes: number, sha256: string, head: string, tail: string, omittedBytes: number }
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `totalBytes` | number | **原始完整字符串**的 UTF-8 字节数 |
| `sha256` | `hex64` | **原始完整字符串**的指纹——让"页面上这段"与"真实那段"可对证 |
| `head` | string | 开头保留的一段,**≤1 KiB** |
| `tail` | string | **结尾**保留的一段,**≤1 KiB** |
| `omittedBytes` | number | 中间被省掉的字节数 |

**五个字段全部恒在。** ⚠️ **没有 `name`、没有 `code`**:`name` 是"这段摘要属于哪个字段",而它永远挂在那个字段上——**位置本身就说明了它是谁**;`code` 只有一个取值("太长了"),是个死字段。这套设计已经因为"没有消费者的字段"栽过好几次(`pid`、`archiveRef`、`halt`),不再留新的。

**切分规则(定死):**

1. **触发**:该字段的 UTF-8 字节数**超过 §6 给它的上限**时才降级。
2. **头 1 KiB、尾 1 KiB**,各自按 UTF-8 计。
3. ⚠️ **按 UTF-8 字符边界切,绝不切开多字节序列**——切开会产生非法 UTF-8,JSON 序列化会把它换成 `U+FFFD`,于是"页面上这段"与 `sha256` 描述的那段再也对不上。允许因此比配额少留几个字节,**不允许多留**。
4. **地板**:`totalBytes ≤ 2 KiB`(= 头尾配额之和)时**不降级,原样留字符串**——头尾加起来已经覆盖全文,摘要给不出任何新信息。所以**只要 `BoundedSummary` 出现了,`omittedBytes` 恒 `> 0`**。
5. **恒等式:`omittedBytes === totalBytes − head 的 UTF-8 字节数 − tail 的 UTF-8 字节数`**。头尾**不重叠**——这条恒等式就是不重叠的形式表述(重叠会让右边算出负数,而第 4 条恰好把那种情况挡在门外)。

⚠️ **必须同时留头和尾。** 只截头是这类实现最常见的错——**报错的根因往往在最后一行**(`… caused by: EACCES`),只留开头等于把最有用的那段丢掉。**只留头要判红。**

⚠️ **§6 的上限是「什么时候该降级」,不是「降级后有多大」**——两者不是同一个数,不要试图让它们相等。
由第 1、4 条可得每个可降级字段落盘时的**实际字节上界**:`max(2 KiB 原文, 头尾各 1 KiB 的摘要对象)`。

⚠️ **所有可降级字段(§3.4 那四个)的触发阈值一律是 2 KiB(§6),不许给其中任何一个定更小的数。** 第 4 条那道地板(`totalBytes ≤ 2 KiB` 原样留字符串)由头尾配额之和决定,对它们一视同仁;**谁的阈值比 2 KiB 小,那个阈值就永远触发不了**——writer 判"该降级了",又被地板原样退回字符串,于是这条规则一次都执行不到。历轮给 `rejectedReason` 写过 1 KiB,后果不是"更严",而是**两个实现分别在 1 KiB 与 2 KiB 降级,同一段文本在两处长得不一样**。想让摘要更小也不该动这个阈值:强行把头尾压进几百字节,而这几个字段全都是给人读的错误正文,压到那个份上就等于没留。真正要守死的是 §2.1 那条 **1 MiB 行上限**,而它们加起来最多几 KiB,离它极远。

### 3.4 允许降级的字段:**只有四个**

**"超限一律换成 `BoundedSummary`"这句话有个洞**:它套到 `id` / `ref` / `code` / `sha256` / `path` / `branch` / `turnKey` / `turnSpecHash` 这类**结构字段**上,会让一个字符串**突然变成一个对象**——页面拿着 `ref` 去拼链接,结果拿到 `{totalBytes, sha256, head, tail, omittedBytes}`,当场违反 schema。

**定死:只有显式声明为 `string | BoundedSummary` 的字段才允许降级,目前只有四个:**

| 字段 | 出现位置 |
|---|---|
| `error` | `node:rejected.error`、控制消息 `recording-failed.error` |
| `errorSummary` | `node:settled.errorSummary`、`node:turn-settled.errorSummary` |
| `rejectedReason` | `node:attempt-settled.rejectedReason`、`node:settled.turns[].attempts[].rejectedReason` |
| `reason` | SSE 控制帧 `history-read-failure.reason`(§10.4) |

**四个的共同点,也是判据**:它们全都是**给人读的错误正文**,长度不受任何上游约束,而且**截掉尾巴就等于截掉根因**(§3.3)。不满足这条的字符串一律不给降级路径。

⚠️ **`tail`(`node:progress.tail`)不在其中**:它本来就被定义成"末 240 个 UTF-16 code unit",**天生有界**(UTF-8 下最多 720 字节),再给它一条降级路径是凭空多一个形状。

⚠️ **结构字段永远保持原类型**。超出上限说明上游给了一个不合合同的值(比如 600 字节的分支名),**那属于 recorder 层的失败,走 `recording-failed`,不许悄悄换类型**。

---

## 4. 事件总表

**共 13 种。** 「不可丢」列见 §7;顺序保证见 §9。

**三层,记清楚谁在哪一层**:节点(`node:observed` … `node:settled`)⊃ 轮(`node:turn` … `node:turn-settled`)⊃ 尝试(`node:attempt` … `node:attempt-settled`)。

| `event` | 层 | 何时 | 只发一次? |
|---|---|---|---|
| `run:started` | run | **viz 初始化做完之后**(canonical outDir 绑定 + transcript `wx` 建成)、**用户回调之前** | 每个 graph 恰好一条,**`seq === 0`** |
| `node:observed` | 节点 | 建 `nodes/` 与本节点归档目录之后、**并发撞车检查与建 `<id>.lock` 之前**(见 §9.2) | 每个 nodeSeq 一条 |
| `node:rejected` | 节点 | 本地闸拒绝 / 准备失败(抛 `UsageError` 出去) | 每个 nodeSeq 至多一条,**且是该节点的终态** |
| `node:turn` | **轮** | 该轮**被受理之后**(串行闸过、`key` 校验过、本轮 prompt 已冻结并归档)、**取任何闸之前** | **每一轮一条** |
| `node:started` | **轮** | 该轮 `bridge._gate.acquire()` 返回、`run.startClock(本轮 timeoutMs)` 之后 | **每一轮至多一条** |
| `node:workspace-intent` | 节点 | write:二次脏树检查与 `makeBranchName` **都跑完之后**、`git worktree add` **紧之前**(**只发生在"入场还没成功过"的轮里**) | **每次入场尝试各一条**——通常就一条,但 `git worktree add` 失败后换个 key 重试会再来一条(§9.2) |
| `node:workspace-created` | 节点 | write:`createWorktree` 成功(**只发生在"入场还没成功过"的轮里**) | 每个 nodeSeq **至多一条**(建成之后不会再建) |
| `node:attempt` | 尝试 | 尝试循环里**剩余预算检查通过之后、`send_message` 紧之前** | 每轮内每次尝试一条 |
| `node:attempt-settled` | 尝试 | 该次尝试收场时**立刻**——在决定要不要打回重说、或结束这一轮**之前** | 每次尝试一条,**四种 status 都发** |
| `node:progress` | 尝试 | 内层 wait 切片超时、**拿到了** `pendingSnapshots[0]` 时(**节流 ≥5s**;快照取不到就**不发**) | 多条 |
| `node:turn-settled` | **轮** | **两种落点**:①正常结束这一轮时——定完本轮 status、(非 ok 时)**冻结完本轮现场**、归档完本轮产出之后,**释放执行闸之前**;②**这一轮入场就失败**时(脏树复查 / 算分支名 / 建工作树抛 `UsageError`)——把异常交给回调**之前**、同样在**释放执行闸之前**,发一条 `status:"not-started"`(§5.4) | **每一轮至多一条**(非强杀时**恰好**一条) |
| `node:settled` | 节点 | 节点收尾返回、归档 `receipt.json` 写完之后 | 每个 nodeSeq 至多一条,**且是该节点的终态** |
| `run:final` | run | 收尾第 5 步(封 admission → 排空 → `bridge.close()` → 定 result **之后**,见 §8.3) | 每个 graph 至多一条,且是最后一条 |

⚠️ **`node:started` 读作「这一轮拿到执行名额、开始烧预算」,不是「这个节点第一次开跑」。** 每一轮各自排队、各自起钟(预算是**逐轮**声明的),所以一个节点有几轮就有几条。**N=1 时两者恰好相同**,这也正是它不改名的原因。要"节点第一次开跑"就取**第一条** `node:started`(§10.8)。

⚠️ **`node:turn` 与 `node:turn-settled` 一一对应,这是轮这一层的核心不变式**:每一条 `node:turn` 都恰好由一条 `node:turn-settled` 闭合(强杀除外),**入场就失败的那一轮也不例外**——它由 `status:"not-started"` 闭合(§5.4)。**这条不变式比"少一档 status"值钱**,所以入场失败**不新造事件**:多一个事件类型 = 页面多一条解析路径;而少一个终态 = 那一轮永远悬着,页面只能把它合成 `abandoned`(§10.3),于是"这个节点还在跑吗"整个判不出来。

**明确不存在的事件**(历轮复审删掉的,别加回来):

- `node:queued` —— **被 `node:turn` 取代**(同一个落点的同一件事)。它的 payload 只有 `{nodeSeq}`,全部含义就是"开始等名额"这个时刻;而每一轮都要排一次队,于是它会与 `node:turn` **逐条同时发生**,变成同一事实的第二个副本。「这一轮在等名额、一个字都还没发给 AI」现在由 **`node:turn` 已发、`node:started` 未发** 这个区间表示(§10.3)。
- `run:terminated` —— 与 `run:final` 重复。
- `viz:started` / `viz:stopped` —— **都不进 transcript**。页面能收到事件本身就证明 viewer 起来了;`url`/`port` 是启动器打印给人看的信息。`viz:stopped` 连 SSE 事件都不留(正常自灭发生在已经没有客户端的时候,异常停服浏览器有 `EventSource.onerror`)。
- **没有"节点级的 attempt 事件"**:`node:attempt` / `node:attempt-settled` **恒挂在某一轮下面**,恒带 `turnKey`。**不许为单轮节点留一条"没有 turn 的旧路径"**——那会让页面必须实现两套解析,而两套迟早漂。

**不产生任何事件的路径**(页面上这个节点根本不存在,不是"消失了"):

- `normalizeSpec` 抛 `UsageError`:spec 非法、文件不存在、**`deps` 超过 200 项或含非法项**(§5.2)——这些都是**入口拒绝**,连 `nodeSeq` 都还没分配;
- canonical outDir 比对失败(它必须早于任何落盘);
- 收尾封住 admission 之后迟到的**节点级调用**(它不属于这次 run,返回一个 **rejected Promise**)。⚠️ **四条公开路径全都要堵**:`runNode(bridge, spec)` / `bridge.runNode(spec)` / `conversation(bridge, spec, fn)` / `bridge.conversation(spec, fn)`——漏掉任何一条,它就能在 run 已经收场之后往 transcript 里追加事件,而那时 `run:final` 已经写完了(§8.3 第 1 步),`run:final` 是最后一条这条保证当场作废。**反例是现成的**:回调里 `setTimeout(() => bridge.conversation(...), 0)` 然后立刻返回。

---

## 5. 逐事件 payload

⚠️ **每一条 `node:*` 事件都必须带 `nodeSeq`**(下面逐条列出,不省略)。
⚠️ **逻辑名 `id` 只出现在 `node:observed` 一处**,后续事件不再带它:`node:observed` 保证先发、不可丢、且能完整回放,客户端拿 `nodeSeq` 一查就知道这是谁。再带一份就是同一事实的第二个副本。
⚠️ **`turnKey` 恰好出现在这六种事件上,一个不多、一个不少**:`node:turn`、`node:started`、`node:attempt`、`node:attempt-settled`、`node:progress`、`node:turn-settled`。**它与 `id` 的处置相反**——`id` 只发一次是因为 `node:observed` 恒在、恒可回放;`turnKey` 每条都发是因为**同一个节点的多轮事件会在时间轴上交错到一起**,没有它就没法归位(而且轮**没有**"恒在且不可丢的身份事件"可查:`node:turn` 在多轮场景下会有 N 条,不是 1 条)。
⚠️ **节点级事件(`node:observed` / `node:rejected` / `node:workspace-*` / `node:settled`)不带 `turnKey`**,因为它们说的就是整个节点的事——**给它们补一个"当前是哪一轮"是假信息**(工作副本是 N 轮共用的,回执是整段的)。

### 5.1 `run:started`

```js
{ outDir, maxConcurrent }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `outDir` | string | 否 | canonical 化(`realpathSafe`)之后的**绝对路径**。≤512 字节 |
| `maxConcurrent` | number | 否 | 并发闸名额(`startBridge` 的 `maxConcurrent`,默认 **4**)。≥1 的整数 |

**不带**:`graphId`(信封里有)、`startedAt`(就是信封的 `ts`)、`launcherCwd`、`label`、`pid`、`halt`。前两个是同一事实的第二份副本,会和来源打架;后几个**没有任何消费者**——留一个没人用的 pid,最后总会被人拿去判活,而判活只有一条合同(§10.2)。

### 5.2 `node:observed`

**R2 的落点**:此刻连节点锁都还没拿。

```js
{ nodeSeq, id, agent, model, effort, access, cwd, group?,
  declaredDeps, inferredDeps, inferredDepsTruncated, spec, prompt, role }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `nodeSeq` | number | 否 | 本 graph 内的实例序号,**从 `0` 起、步长 `1`**。与 `graphId` 一起构成页面主键,**也是归档子目录名 `<nodeSeq>-<id>/` 的前半段**。分配时机见下 |
| `id` | string | 否 | 逻辑名(`spec.id`)。**只在这里出现**。字符集受源码约束:`/^[A-Za-z0-9._-]+$/`。≤200 字节 |
| `agent` | string | 否 | `"omp"` \| `"codex"` \| `"claude"` \| `"cursor"` \| `"kimi"`(封闭枚举,源码 `normalizeSpec` 校验) |
| `model` | string \| null | **可 null** | 未显式指定 → `null`(后端用默认模型)。≤200 字节 |
| `effort` | string \| null | **可 null** | 同上。≤200 字节 |
| `access` | string | 否 | `"read"` \| `"write"` |
| `cwd` | string | 否 | **绝对路径**(`normalizeSpec` 已 resolve)。⚠️ 这是**调用方给的 cwd**;write 节点实际执行发生在 worktree 里,那个路径由 `node:workspace-*` 给出。≤512 字节 |
| `group` | string | **可缺席** | 使用者自己传的分组标签(如 `"round-2"`)。不传 → **整个键不出现**(不是 null)。≤200 字节 |
| `declaredDeps` | string[] | 否 | A 档拓扑:spec 上可选的 `deps`,**原样按声明顺序**。**未传时是 `[]`**。≤200 项(超了在 `normalizeSpec` 就抛 `UsageError`),每项 ≤200 字节 |
| `inferredDeps` | string[] | 否 | B 档拓扑:扫**冻结后的 prompt 正文**得到。**未推断出时是 `[]`**。≤200 项(超了取前 200),每项 ≤200 字节 |
| `inferredDepsTruncated` | boolean | 否 | **恒在。** `true` = 候选超过 200 项、这里只放了前 200 |
| `spec` | `AssetState` | 否 | 冻结的 spec 字段快照(`input.json`) |
| `prompt` | `AssetState` | 否 | **节点级**的 user 侧原文。单轮节点:指向 `turns/main/prompt.md`,**与 `node:turn{turnKey:"main"}.input` 的 `ref`/`sha256` 逐字节相同**,且**同时就是那一轮 attempt 1 的输入**。**对话节点没有节点级 prompt** → `{state:"not-applicable"}` |
| `role` | `AssetState` | 否 | 冻结的 system 侧原文(`role.md`);没配 `roleFile` → `{state:"not-applicable"}` |

⚠️ **输入三件套的资产状态由 `node:observed` 承担**,不能挂在 `node:settled` 上:它发生在拿锁之前,而节点接下来完全可能直接走 `node:rejected`——**那条路上没有 `node:settled` 可挂**。

⚠️ **`prompt` 是唯一一个"这一层可能压根没有这个概念"的槽**:`conversation()` 的 `prompt`/`promptFile`/`timeoutMs`/`schema`/`outputShape`/`reask` **全是逐轮参数,写在顶层任务单上直接 `UsageError`**。所以对话节点在 `node:observed` 这一刻**确实还没有任何提问**——第一句话要到 `node:turn` 才出现。⚠️ 页面**不许**把这种 `not-applicable` 显示成"提问丢了";它与"单轮节点的 prompt 归档失败(`unavailable`)"是两件事。

⚠️ **两档 deps 的可靠性完全不同,页面不许画成一样**:`declaredDeps` 是**调用方的声明,系统既不校验也不执行**(执行路径上没有任何代码读它,所以它也**不进 `specHash`**);`inferredDeps` 是启发式,会漏也会多。

#### `nodeSeq` 的分配时机(**它同时定死了磁盘布局**)

**在节点级入口(`runNode` **与** `conversation`)的公共段里同步分配:admission 检查通过、`normalizeSpec` 通过之后,任何 `await` 之前。**

⚠️ **两个入口共用同一个计数器**,不是各发一套号:分家会让 `(graphId, nodeSeq)` 这个主键在同一个 graph 里撞车(§2.1),页面把一段对话和一个普通节点叠成同一格,而它们的归档目录名 `<nodeSeq>-<id>/` 也会互相覆盖。

由此三件事同时成立:

1. **与调用顺序一致**——分配是同步的,中间不让出事件循环。
2. **拿到号的调用一定会发 `node:observed`**,所以走 `node:rejected` 的节点照样有号(它的归档目录也已经建好了)。
3. **`nodeSeq` 与 `seq` 一样稠密**(`0, 1, 2, …`):§4 那三条"不产生任何事件"的路径都在分配之前就返回了,一个号都不占。**空洞 = 记录损坏**,不是"有个节点悄悄跑了"。

⚠️ **起点一旦定下就同时定死了归档目录名**(`<nodeSeq>-<id>/`)——改起点等于改磁盘布局。

#### 两档 deps 的产生算法(**writer 侧,定死到可以照着写**)

**`declaredDeps`(来自调用方)——在 `normalizeSpec` 阶段校验,不合格就抛 `UsageError`:**

1. 每项必须匹配 `^[A-Za-z0-9._-]+$`(与 `id` 同一字符集)、非空;
2. 去重后**保持声明顺序**;
3. **> 200 项 → 抛 `UsageError`**(入口拒绝,这一路**一个事件都不发**)。用户写了 300 个 `deps` 是**用法错**,不是 recorder 故障——让一个注解把整个 run 的记录报废是荒唐的处置。
4. ⚠️ **不校验它指向的节点是否存在。** 那是拓扑的事,而 §10.7 已经有"实例不唯一或不存在就不画边"的规则;在入口拒绝会让"先声明、后创建"这种完全合法的写法跑不起来。

**`inferredDeps`(我们自己扫出来的)——在发 `node:observed` 之前算,**⚠️ **`node:turn.inferredDeps` 用的是同一个算法、同一段代码**,只是输入换成那一轮的正文:

1. **输入是冻结后的 prompt 正文**,不是原文件——文件可能在排队期间被改,拿改后的文件推断,得到的边描述的是一份没被派发过的输入;
2. 匹配 `nodes/<id>.md`,其中 `<id>` 取 `[A-Za-z0-9._-]+`;**`/` 与 `\` 两种分隔符都认**;
3. **只认相对形式**;绝对路径**不匹配**——跨 out-dir 的引用不是本图的边;
4. **去重、去掉自依赖、按首次出现顺序排**;
5. **> 200 项 → 取前 200,并把 `inferredDepsTruncated` 置 `true`**。

⚠️ **`inferredDepsTruncated` 这个标志必须有,不许省。** 在这套设计里**静默截断永远等价于"伪装成本来就没有"**——页面拿着 200 条边,没有任何迹象说明还有第 201 条。它与 `declaredDeps` 的处置不同也正是因为这个:声明是**用户写的**,截掉就是改用户的意思,所以宁可当场拒绝;推断是**我们猜的**,截掉只损失猜测,但**必须说出来**。

⚠️ **对话节点在 `node:observed` 这一刻一个字的正文都没有**(提问是逐轮的),所以它的 `inferredDeps` 恒 `[]`、`inferredDepsTruncated` 恒 `false`。**这不等于"这个节点没有推断出来的依赖"**——同一个理由:那会把"这一层没得扫"伪装成"扫过了,没有"。**推断边由逐轮的 `node:turn.inferredDeps` 给出**,而这恰恰是对话的头号用法所在(第 2 轮的提问通常就是照着另一个节点的产出写的)。§10.7 因此规定 B 档取**三处的并集**:`node:observed.inferredDeps` ∪ 该节点每一条 `node:turn.inferredDeps` ∪ `node:settled.turns[].inferredDeps`。
⚠️ **第三处不是对称美,少了它就有一整类节点没有边**:**复用命中的对话一条 `node:turn` 都不发**(§5.9),事件流里只有 `node:observed → node:settled`;只读前两处的消费端会看到 `inferredDeps` 恒 `[]` 又找不到任何轮事件,于是同一个任务跑第二遍时**整段的推断边凭空消失**(§5.8 的 `turns[].inferredDeps` 正是为此恒有,§10.7 逐条写了三处各自兜住的是谁)。

### 5.3 `node:rejected`

**本地闸拒绝 / 准备失败**:源码在这几关**原样重抛 `UsageError`,不写回执**。这**不是** `unknown`,**也不是** `abandoned`——它是明确的、本地的、**还没派活**的拒绝。

```js
{ nodeSeq, phase, error }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `nodeSeq` | number | 否 | |
| `phase` | string | 否 | **封闭枚举**,六档,见下表 |
| `error` | string \| `BoundedSummary` | 否 | 抛出去的那个异常的消息(绝大多数是 `UsageError`)。≤2 KiB,超限降级 |

| `phase` | 什么情况 |
|---|---|
| `"lock"` | **三种,不止"锁文件已存在"**:①同一个 bridge 内 `ACTIVE_NODES` 撞车(**并发跑同一个 `<outDir, id>`**);②`<id>.lock` 已存在(跨 bridge / 跨进程撞了,或上次异常退出留下陈旧锁);③锁文件创建或写入 **I/O 失败**(磁盘满等) |
| `"preflight"` | write 的仓库体检 / 脏树闸不通过 |
| `"reuse-check"` | 回执已存在但指纹不符 / 上次不是 ok / 产出缺失或指纹对不上 / 基线漂移 / 分支已不在;**多轮再加**:回执不是对话形状、某一轮的任务单指纹变了、轮序列多一轮少一轮或顺序不同、某一轮的产出被换过 |
| `"workspace-setup"` | 算分支名或清残留失败、分支或目录已存在且没给 `force`、`git worktree add` 失败 |
| `"turn-validation"` | **某一次 `turn()` 当场被拒**。⚠️ **枚举名比它的实际语义窄,别照名字理解**——它涵盖两类:①**参数不合法**(`key` 非法 / `key` 在这个节点里重复 / `prompt` 与 `promptFile` 没二选一 / `promptFile` 不存在或不是普通文件 / 缺 `timeoutMs` 或它 ≤0 / `reask` 不是 0\|1 / `schema` 给了非 codex 后端 / `outputShape` 形状不对);②**用法/状态不允许**(上一轮还没结束就并发 `turn()` / `fn` 已经返回了才来 / 这段对话已被毒化 / 超过 20 轮)。两类都在**任何副作用之前**被同一道门挡下,事件流表现完全一样,所以合成一档。⚠️ **判据是 `turnCalls > 0` 且 `turns[]` 为空**(见下面的决策树),**不看回调有没有把异常吞掉**——`try { await turn(...) } catch {}` 照样算"调过"。⚠️ **触发它的那一次 `turn()` 一个事件都没发过**(校验在任何副作用之前,连 `node:turn` 都还没发,见下面那张两行表);但**同一个节点上更早的轮可能已经发过事件**(§9.2 的 `⟨没起来的轮段⟩`)。它必须有自己的一档——`zero-turn` 会把"调过但被拒了"谎报成"压根没调过",而两者的处置完全不同(一个去看那次 `turn()` 怎么调的,一个去看编排为什么空转) |
| `"zero-turn"` | **回调从未调用过 `turn()`**(**字面意思:一次都没调**,判据 `turnCalls === 0`),于是**不写回执**(一张空回执没有任何复用判据)。它是"你的编排一轮都没起过"的兜底诊断。⚠️ **只要 `turnCalls > 0` 就一律不是这一档**,哪怕那几次调用全被回调 `catch` 吞掉、外面一个异常都没看见:**当场被拒**(参数不合法**或**用法不允许)→ `turn-validation`;已经发出 `node:turn` 才失败 → 归那一关(`preflight` / `workspace-setup`) |

#### `node:rejected` 什么时候发(**多轮之后必须重申一次**)

> **它只在「这个节点确实以抛异常结束、并且没有写出回执」那一刻发一条。**

**`phase` 怎么取(决策树,**按顺序取第一个匹配**):**

1. **在任何一轮之前就被拦下** → `lock` / `preflight`(**第一次**仓库体检与脏树闸)/ `reuse-check`。那时回调还没开始跑,事件流里只有一条 `node:observed`;
2. 否则(回调跑过了),**最后一次失败的那次 `turn()` 已经发出过 `node:turn` 才失败**(那一轮以 `node:turn-settled{status:"not-started"}` 闭合)→ 归那一关:`preflight`(**第二次**脏树复查)/ `workspace-setup`;
3. 否则按 **`turnCalls`** 取,**判据写死**:

| 条件 | `phase` |
|---|---|
| `turnCalls === 0` | `zero-turn` |
| `turnCalls > 0` 且 `turns[]` 为空 | `turn-validation` |

**`turnCalls` 是什么**:回调调用 `turn()` 的**次数**,在 `turn()` **最顶上无条件 +1**,与"有没有一轮进得去"完全无关(源码里就叫 `run.turnCalls`,与 `run.turns` 分开记账)。
⚠️ **不许拿 `turns.length === 0` 当"回调没调过"的替身**——回调完全可以写 `try { await turn({ key: "bad/key", … }); } catch {}`:那时 `turns[]` 是空的、外面一个异常都没看见,但"编排一轮都没起过"是**假话**,它起过,只是参数写错了。两者的处置完全不同(一个去看那次 `turn()` 传了什么,一个去看编排那段 JS 为什么空转),所以这个计数必须**独立于 `turns[]`** 记账。

⚠️ **第 2 条必须排在第 3 条前面**:那条路上 `error` 是**那一关**抛出来的正文(脏树复查 / 算分支名 / `git worktree add`),而 `turn-validation` 的处置提示是"与工作区、与后端都无关,去看参数"——顺序反了就把人指到错的地方。判别不需要新字段:事件流里那一轮以 `node:turn-settled{status:"not-started"}` 闭合(§5.4、§9.2)。
⚠️ **第 1 条也不能与第 3 条颠倒**:被 `lock` 拦下的节点同样 `turnCalls === 0`,先判第 3 条会把每一次撞 id 都报成 `zero-turn`。

**`error` 取什么** —— ⚠️ **`error` 合同不破例**:它恒是**抛出去那个异常的消息**,三种情况都不例外:

- `turnCalls > 0` 且回调**把被拒的异常吞了** ⇒ 收尾发现"零轮但调过",**自己合成并抛出**一个 `UsageError`,正文里已经写着**调用了几次 `turn()`**、**最后一次没进去的原因**(源码记在 `run.lastTurnFailure`,回调吞了也留得住)、以及"别在回调里静默吞 `turn()` 的用法错"。`error` 就是这一句。⚠️ **这一句里不含任何归类词**——它只说"每次都被拒了 / 最后一次没进去的原因是 ⋯",**不说是不是参数问题**(并发闸、毒化闸拒掉的也在这个计数里)。消费端**不许**从这句话反推失败类别;
- `turnCalls > 0` 且回调**让异常穿了出去** ⇒ `error` 就是那个异常原样的消息(回调自己抛的根因优先,收尾的零轮诊断**不许盖它**);
- `turnCalls === 0` ⇒ `error` 是"这段对话一轮都没跑(回调一次 `turn()` 都没调)"那一句。

⚠️ **`phase` 与 `error` 是两个独立的事实,渲染时不许互相推断。** 已知的一条混合路径:回调**吞掉**了入场被拒的异常、
随后**自己**抛了一个与那次 `turn()` 毫无关系的异常(读文件失败、自己的断言炸了…)。那时:

- `phase` 仍是 `turn-validation`(判据只看 `turnCalls > 0` 且 `turns[]` 为空,**它不知道回调后来又出了什么事**);
- `error` 是**回调那个无关异常**的消息(上面第 2 条:根因优先)。

⚠️ **消费端不得把这种 `error` 渲染成"那次 `turn()` 的参数错"**,也不得因为 `error` 看着不像用法错就改判 `phase`。
**照抄 `error`、按 `phase` 归类,两件事分开做。**
⚠️ 这是**已知限制,不是遗漏**:六档 `phase` 刻意封闭不扩容,而 `callback_error` 是**节点级**状态、以"有回执"为前提(§5.8),
这条路上节点连回执都没有,落不进去。

⚠️ **这两句话在运行时就是分开的,页面也不许合并**:"调了 3 次没一次进得去"与"一次都没调"指向两段完全不同的代码。
⚠️ **`zero-turn` 与 `turn-validation` 只可能出现在对话节点上**:`runNode` 没有回调,它那一轮的参数在 `normalizeSpec` 就校验完了,而那条路**一个事件都不发**(§4)。

⚠️ **`node:rejected` 只在「一轮都没跑起来」时出现。** 只要有**一轮真的跑起来过**(`turns[]` 非空),节点就一定写回执、一定以 `node:settled` 收场——哪怕后面某一次 `turn()` 又抛了参数校验错、哪怕回调自己炸了:那时那个异常走的是节点级 `status:"callback_error"`(§5.8),**不是** `node:rejected{phase:"turn-validation"}`。**同一个 `UsageError`,落在哪一层取决于"这个节点有没有回执"**,这条必须写死,否则两个实现会一个发 rejected、一个发 settled。

**入场失败的两种,事件层完全不同(必须分开实现):**

| 什么时候失败 | 这个 `key` 登记了吗 | 事件流里有东西吗 | 规范怎么写 |
|---|---|---|---|
| **参数校验就没过**(`normalizeTurn` 抛:`key` 非法/重复、`timeoutMs` 不合法、`promptFile` 不存在…) | **没有** | **一个字都没有**——`node:turn` 还没发 | 这一轮**从未存在**。⚠️ 准确的说法**只有一句:这次校验失败不新增占用**(`turnKeys` 里没多出东西),**不是**"这个 `key` 保证可用"——`key` 本身不合法(`"bad/key"`)的话,再试多少次都会被同一条格式校验(`/^[A-Za-z0-9._-]+$/`)拒;是因为**重复**被拒的话,说明它早被别的轮占着,再来还是拒。回调要重试,**必须换一个合法且没被占过的 `key`** |
| **已经开过头才失败**(`runTurn` 抛:第二次脏树复查、算分支名、`git worktree add`) | **登记了** | `node:turn`(以及 `node:started`)**已经发出去了** | 必须有一条**轮级失败终态**把它闭合:`node:turn-settled{status:"not-started"}`(§5.4)。该 `key` **就此作废**,永不再现(§2.1) |

- **单轮节点**:入场那几关一旦不过,节点当场结束 ⇒ 事件上紧跟着就是 `node:rejected`,与多轮之前一模一样。
- **对话节点**:某一轮入场失败只结束**那一轮**(那一轮不进 `turns[]`),回调理论上还能换一个 `key` 再起一轮。所以 **writer 不许在抛出点就发 `node:rejected`**——发早了,后面还会有事件排在这条"终态"之后,§5.10 的恒等式当场作废(那个节点会被数两次)。
- ⚠️ 于是事件流里可能出现**一条以 `status:"not-started"` 收场的轮**,而 `node:settled.turns[]` 里**没有它**。**这不是记录损坏,是一处故意的不一致**:事件流记的是"发生过什么",`turns[]` 记的是"哪几轮真的跑了"(它是复用判据,一条没跑过的轮进去会毒化下一次回放比对)。两者都为真,页面**必须同时接受**——见 §5.8 与 §10.8 各自那一条。

⚠️ **`phase` 是"哪一关拦下的",不是"第几次拦下的"。** `preflight` 与 `workspace-setup` 各自都有**两个抛点**(脏树查两次;建工作副本的准备与 `git worktree add` 分列 `node:workspace-intent` 两侧),它们**同关同义**,所以共用一个 `phase` 是对的。**要分辨发生在哪一次,看这个 nodeSeq 之前出现过哪些事件**——那正是 §9.2 那张状态机存在的理由。

⚠️ **反过来这条要守死:每个 `UsageError` 抛点只能对应一个 `phase`,不许两处抛同一个 `phase` 而语义不同。** 一旦同名不同义,页面给的处置提示就会把人引到错的地方,而这六档的全部价值就是"该去看哪儿"。

⚠️ **`preflight`(第二次)与 `workspace-setup` 这两关跑在「第一轮」的入场段里**(入场懒挂在第一轮上,§9.2),所以它们前面**已经有** `node:turn` 与 `node:started`,后面**紧跟一条** `node:turn-settled{status:"not-started"}`(那一轮压根没跑起来,连一条消息都没发出去),**然后**才是节点级的 `node:rejected`。**页面必须能画出"一条没能开始的轮"**——它有开头也有结尾,只是结论是"没开始",不是"结果不明"。

⚠️ **不重复带 `spec`/`prompt`/`role`**:插桩顺序保证 `node:observed` 一定在它之前,而 observed 不可丢、可完整回放;writer 若已经坏了,这条 rejected 本身也写不进去。

⚠️ **页面必须逐个区分六种 phase 并给出各自的处置提示**(撞 id → 先分辨是不是有人在跑;`workspace-setup` → 去看残留;`turn-validation` → 去看那次 `turn()` **是怎么调的**(可能是参数写错,**也可能是并发/来晚/毒化后/超 20 轮**),**照抄 `error` 正文、别自己起标题**——**回调把异常吞了时,`error` 是收尾合成的那句**,里面写着调了几次、最后一次没进去的原因;`zero-turn` → 去看编排那段 JS 为什么一轮都没起)。把六种渲染成同一句"被拒绝了"是假绿。

### 5.4 `node:turn` / `node:turn-settled` —— **轮这一层**

```js
node:turn          { nodeSeq, turnKey, input, inputSha256, timeoutMs, reask,
                     inferredDeps, inferredDepsTruncated }
node:turn-settled  { nodeSeq, turnKey, status, sessionReusable, output,
                     charCount, durationMs, scene, errorSummary? }
```

⚠️ **`node:turn` 上**没有** `turnSpecHash`。** 它在 live 流里是第二个副本:这一轮问的**正文**就在旁边(`input` 的 `ref` + `sha256` 指着 `turns/<key>/prompt.md`),而任务单里另外那几样(`timeoutMs` / `reask`)也各自在这条 payload 上。**`turns[].turnSpecHash` 保留**,理由完全不同——复用命中时**一条 turn 事件都不发**,那份指纹是"这一轮问的是什么"的唯一证据(§5.8、§5.9)。

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `turnKey` | string | 否 | 这一轮的名字。字符集受源码约束:`/^[A-Za-z0-9._-]+$/`,≤200 字节,**同一个节点内唯一**(重复当场 `UsageError`)。**单轮节点恒为 `"main"`**。它就是归档目录名 `turns/<key>/` 的那一段 |
| `input` | `AssetState` | 否 | **这一轮**冻结的 user 侧原文(`turns/<key>/prompt.md`),**同时就是本轮 attempt 1 的输入** |
| `inputSha256` | `hex64` | 否 | **总是有**。该轮冻结正文的指纹。**这一轮真的发出过消息时,它恒等于本轮 `attempts` 中 `.n === 1` 那一项的 `inputSha256`**;⚠️ `status:"not-started"` 的轮**没有任何 attempt**(那条断言对它不适用,但这个字段照样恒有——正文确实冻结过、也确实归档了) |
| `timeoutMs` | number | 否 | **这一轮自己的**预算(正安全整数)。⚠️ **预算是逐轮声明的**,`input.json.timeoutMs` 对对话节点恒 `null`(§1.3),页面要显示倒计时**只能**用这里的值 |
| `reask` | number | 否 | `0` \| `1`,这一轮允许打回重说几次。它解释了"为什么这一轮只有一次尝试就结束了" |
| `inferredDeps` | string[] | 否 | 扫**本轮冻结正文**得到,算法与 `node:observed.inferredDeps` **完全相同**(§5.2)。≤200 项,每项 ≤200 字节 |
| `inferredDepsTruncated` | boolean | 否 | **恒在。** 同 §5.2 |
| `status` | string | 否 | **封闭枚举六档**:`"ok"` \| `"contract_error"` \| `"backend_failed"` \| `"timeout"` \| `"unknown"` \| **`"not-started"`**。⚠️ **轮级没有 `callback_error`**——那是节点级才有的结局(§5.8)。⚠️ **`not-started` 只出现在这条事件上,不出现在 `turns[]` 里**(那一轮不进 `turns[]`,所以 `TurnSummary.status` 仍是五档,§5.8) |
| `sessionReusable` | boolean | 否 | 这一轮之后**这个会话还能不能接着用**,由工具判、不由调用方声明。判据见下表 |
| `output` | `AssetState` | 否 | 这一轮的产出。**`sha256` 必须等于本轮最后一次成功复制的那一项 `attempts` 的 `output.sha256`**(可验断言,§1.3) |
| `charCount` | number \| null | **可 null** | 该轮产出的长度,**单位是 UTF-16 code unit**;拿不到时 null |
| `durationMs` | number | 否 | **这一轮**从起钟到收场的耗时,**不含排队**(非负整数)。⚠️ 与 `node:settled.durationMs` 不是一个口径,见下 |
| `scene` | `SceneState` | 否 | **本轮**的现场(§3.2)。`status === "ok"` **或** `"not-started"` ⇒ 恒 `{state:"not-applicable"}` |
| `errorSummary` | string \| `BoundedSummary` | **只在 `status !== "ok"` 时可能出现** | 这一轮失败原因的正文;拿不到原因时缺席。⚠️ **`status:"not-started"` 时恒有**(就是那个 `UsageError` 的消息——那一轮为什么没能开始,只有这里说得出来)。≤2 KiB,超限降级 |

#### `sessionReusable` 的判定表(**封闭,不许扩**)

| 该轮 `status` | `sessionReusable` | 为什么 |
|---|---|---|
| `ok` | `true` | — |
| `contract_error` | `true` | 后端好好的,只是答得不合格 |
| `timeout` **且** 本轮 abort 被桥明确回报打断 | `true` | 那一轮确实停了 |
| `timeout` **且** abort 没被确认 | **`false`** | ⚠️ 那一轮**可能还在后台跑**,再发一句就是往同一个会话里并发发消息 |
| `backend_failed` | **`false`** | 会话已经没了 |
| `unknown` | **`false`** | 不知道后端干没干,正是最不能再叠一轮的情况 |
| **`not-started`** | **`true`** | ⚠️ **不封口**:那一轮一条消息都没发出去,会话(如果已经有)没被碰过,工具也**确实允许**回调换一个 `key` 再来一轮。**它不进 `turns[]`,所以对下面那条毒化派生完全没有影响** |

- **`sessionReusable === false` ⇒ 这个节点不会再有下一轮**:工具当场把整段封口,之后任何一轮都被拒(拒在任何副作用之前,**不产生任何事件**)。所以「**`turns[]` 里第一个 `sessionReusable === false` 的轮**」就是毒化点,页面据此显示「这段对话在这一轮之后被封口」。**不另设 `poisonedAfter` 字段**——它完全由这条规则派生,而没有独立消费者的字段本仓已经栽过好几次(`pid`、`archiveRef`、`halt`)。
- ⚠️ **但这条派生前面必须先过一道闸:这个节点得是一段对话。** 判据用事件里已经有的东西:**`node:observed.prompt.state === "not-applicable"` ⟺ 对话节点**(§3.1、§5.2),**不新加字段**。
  **不是对话节点(`runNode`)时,"封口"这个概念压根不存在,页面一律不显示**——普通 `runNode` 报 `backend_failed` 时,它那一轮合成出来的 `sessionReusable` 就是 `false`(§5.8 的投影算法),无闸的派生会把一个**根本不是对话**的节点显示成"对话被封口"。那一轮失败了就是失败了,和"后面本来还想聊"没有关系。
  ⚠️ **这道闸只判"是不是对话",不判"聊了几轮"**:一段**只聊了一轮就被毒化**的对话,封口恰恰是"为什么只有一轮"的真正解释(编排的标准写法就是 `if (!r1.sessionReusable) return;`),必须显示。**别把它误收窄成 `turns.length ≥ 2`。**

⚠️ **轮的 `status` 与它那几次尝试的 `status` 不是同一个东西,页面不许自己从 `attempts[]` 反推一遍**(同 `outcome` 那条规矩):**轮级 `status` 是工具给的权威值**。只有两条关系可以拿来对齐显示,**不能拿来推断**:①一轮里 attempt 1 `rejected`、attempt 2 `accepted` 是**正常**的,那一轮照样 `ok`——**"这一轮被打回重说过"不等于"这一轮失败了"**;②`attempts` 为空 ⇒ 那一轮一条消息都没发出去(只可能是第一轮开会话就失败了)。

#### 落点与时钟(**逐条锚死**)

- **`node:turn` 发在该轮被受理之后、取任何闸之前**:此刻 `key` 已经查重、参数已经全部校验通过、正文已经冻结并归档,而**一个名额都还没拿、一个字都还没发给后端**。⚠️ **反过来说:参数校验没过的那次 `turn()`,`node:turn` 压根不发**(§5.3 那张两行表的第一行)。
- **`node:turn` 已发、`node:started` 未发 ⟺ 这一轮在排队**。⚠️ **首轮的这段区间里还夹着「对话闸」的等待**(界的是"同时有几段对话持着活会话",与执行闸不是一把);后续轮只等执行闸。两种等待页面都只需说「在等名额」。
- **`node:started` 在 `acquire()` 返回、`startClock(本轮 timeoutMs)` 之后**:预算从这一刻起算,**排队不计入预算**,页面不能让排队中的轮显示倒计时。
- **`node:turn-settled` 在释放执行闸之前发**:该轮的现场必须**当轮**冻结(§3.2),而现场是它 payload 的一部分,先放闸就可能让下一轮的产出覆盖掉这一轮的答案文件。⚠️ **入场失败那一条也在释放执行闸之前发**,而且要**早于把异常交给回调**——回调一拿到异常就可能立刻起下一轮,那一轮的 `node:turn` 排在这条终态之后才对(§9.2)。
- **两个 `durationMs` 不许混用**:轮级 = 本轮起钟→本轮收场;节点级(§5.8)= **第一轮起钟**→节点收尾,**包含轮与轮之间回调在干别的事的时间**。所以 **`node:settled.durationMs ≥ Σ turns[].durationMs`**,差额不是误差,是回调自己花掉的时间(它可能在两轮之间跑了另一个节点)。⚠️ **`not-started` 的轮不在这条不等式里**(它不进 `turns[]`),但它烧掉的墙上时间**确实**算在节点级 `durationMs` 里——差额里包含它。

⚠️ **`node:turn-settled` 不可丢**,理由与 `node:attempt-settled` 完全相同:强杀发生在下一轮时,它是这一轮产出与现场**唯一**的公布渠道。`status:"not-started"` 那一条同样不可丢:丢了,那一轮就成了一条**永远没有终态**的轮,页面只能把它合成 `abandoned`(§10.3),于是一次"这一轮没能开始、但节点后来跑成了"会被显示成事故。

#### 「没能开始的轮」——`status: "not-started"`(**逐字段定死**)

**什么时候发**:这一轮**已经发过 `node:turn` 与 `node:started`**,随后在入场段抛了 `UsageError`(第二次脏树复查、算分支名/清残留、`git worktree add`)。那一轮**一条消息都没发出去**,多半连会话都还没开。

| 字段 | 取值 |
|---|---|
| `status` | `"not-started"` |
| `sessionReusable` | **`true`**(不封口,见上表) |
| `output` | 恒 `{state:"unavailable", code:"source-missing"}`——一次成功复制都没有过(§3.1) |
| `charCount` | 恒 `null` |
| `durationMs` | **本轮起钟 → 抛出那一刻**(非负整数;`node:started` 已经起过钟,所以这个数是真的) |
| `scene` | 恒 `{state:"not-applicable"}`(压根没走到"结束这一轮"那一步,§3.2) |
| `errorSummary` | **恒有**,就是那个 `UsageError` 的消息 |

- **这一轮出现在事件流里,但不出现在 `node:settled.turns[]` 里。** 这是事件层与回执层的一处**故意的**不一致(§5.3 那张两行表、§5.8 的 `turns[]`、§10.8 的"聊了几轮"三处都点明了),**页面必须同时接受两者**:事件流记"发生过什么",`turns[]` 记"哪几轮真的跑了"。
- **它的 `turnKey` 就此作废**,永不再现(§2.1)。回调要重试**必须换一个 key**,同一个 key 再来一轮当场 `UsageError`(重复 key,`normalizeTurn` 拒)。
  ⚠️ **这个 `UsageError` 落在哪一层,取决于「这个节点有没有回执」,不取决于它是哪一类用法错**(§5.3 那条,**别在这里写死成 `node:rejected`**):
  - 此刻**还没有任何一轮真的跑起来**(`turns[]` 仍为空)⇒ 节点不写回执,以 `node:rejected` 收场,`phase` 按 §5.3 那棵决策树取;
  - **已经有真实轮**了 ⇒ 节点**照样写回执**,以 `node:settled{status:"callback_error"}` 收场(§5.8),**不是** `node:rejected`。典型时序:`draft` 入场失败(本节这一条)→ 换 `fix` 跑成了、进了 `turns[]` → 再调一次 `draft` 撞重复 key 且异常没被接住。
- **它的归档目录 `turns/<key>/` 是存在的**:`prompt.md` 已经冻结并归档(`node:turn.input` 就指着它),只是里面没有任何 `attempt-*.output.md`、没有 `scene/`。
- ⚠️ **同一段 `UsageError` 正文可能同时出现在这一轮的 `errorSummary` 与节点的 `node:rejected.error` 上,那不是副本**:两者作用域不同(一轮为什么没起来 / 这个节点为什么结束),而且**回调接住它、换个 key 重试成功时,节点根本没有 `node:rejected`**——那时这段正文只存在于轮这一层。

### 5.5 `node:started` / `node:workspace-intent` / `node:workspace-created`

```js
node:started            { nodeSeq, turnKey, queuedMs }
node:workspace-intent   { nodeSeq, path, branch, baseCommit }
node:workspace-created  { nodeSeq, path, branch, baseCommit }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `turnKey` | string | 否 | 哪一轮拿到了名额。**每一轮各一条 `node:started`** |
| `queuedMs` | number | 否 | **这一轮**在执行闸上的等待(单调时钟)。≥0。⚠️ **首轮不含对话闸上的等待**,那段要用 `node:started.ts − node:turn.ts` 去看 |
| `path` | string | 否 | worktree 的绝对路径(`<repoRoot>/.graph/wt/<runKey>/<id>`)。≤512 字节 |
| `branch` | string | 否 | 分支名(`graph/<runKey>/<id>`,已过 `git check-ref-format`)。≤512 字节 |
| `baseCommit` | string | 否 | 解析后的基线 commit(`hex40`)。≤512 字节 |

- **`node:started` 不带 `n`**:此刻本轮第一次 attempt 还没开始,带 `n` 是假信息。
- **`node:workspace-*` 是 write 独有**:建工作副本挂在**入场**段上,而入场懒挂在"第一轮"上,**N 轮共享一棵工作树、一条分支**(§10.3、§5.8)。所以真的跑起来一轮之后,后面每一轮的 `node:started` 之后**直接**就是 `node:attempt`。
  ⚠️ **`created` 至多一条,`intent` 可能多于一条**:入场失败(那一轮 `status:"not-started"`)之后回调换个 key 重试,会再走一遍"二次脏树复查 → 算分支名 → `git worktree add`",于是再发一条 `intent`,而且 `path`/`branch` **可能与上一条不同**(分支名是重新算的)。**要用路径就取最后一条**(§9.2、§10.3)。
- **复用命中的节点不发 `node:turn` / `node:started`**(幂等闸后直接返回,连闸都没走到,§5.9)。
- **两条事件必须分开,含义相反**:`intent` 说**"该去哪儿找"**(未确认),`created` 才有资格说**"它确实在那儿"**。在 `intent` 之前,正确答案是**"别找了,确定还没建"**——`node:started` 到 `intent` 之间还夹着二次脏树检查与算分支名(都是 git 调用,大仓上不快),那段窗口里 `git worktree add` 一次都还没被调用。
- **UI 的「运行中」包含"准备工作副本"这一段**;**绝不能**把 worktree 创建时间算进 `queuedMs`,那会让"闸开太小"这个诊断信号失真。

### 5.6 `node:attempt` / `node:attempt-settled`

```js
node:attempt          { nodeSeq, turnKey, n, input, inputSha256 }
node:attempt-settled  { nodeSeq, turnKey, n, output, status, rejectedReason?, durationMs, charCount }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `turnKey` | string | 否 | **这次尝试属于哪一轮。恒在,没有例外**——`node:attempt*` 永远挂在某一轮下面(§4) |
| `n` | number | 否 | **1-based,且在每一轮内从 1 重新开始**——它是"**本轮**第几次尝试",不是"这个节点第几次尝试"。`reask` 逐轮声明且限死 `∈ {0,1}`,所以每一轮内 `n ∈ {1,2}` |
| `input` | `AssetState` | 否 | 该次尝试**实际派发的 user 侧内容**。`n===1` 时 ref 指向本轮的 `turns/<turnKey>/prompt.md`;`n≥2` 时指向 `turns/<turnKey>/attempt-<n>.input.md` |
| `inputSha256` | `hex64` | 否 | **总是有**。该次实际派发内容的指纹 |
| `output` | `AssetState` | 否 | 该次产出的归档状态,见下面的矩阵 |
| `status` | string | 否 | **封闭枚举**四档,见下表 |
| `rejectedReason` | string \| `BoundedSummary` | **只在 `status === "rejected"` 时出现** | 契约不通过的原因(`weakCheck` 或 codex `schemaError` 拼出来的)。≤2 KiB,超限降级 |
| `durationMs` | number \| null | **可 null** | 该次尝试耗时;死在 `send_message` 或等待阶段时为 null |
| `charCount` | number \| null | **可 null** | 该次产出的长度,**单位是 UTF-16 code unit**(桥给的快照值,取不到时退回 `text.length`——两者同口径);拿不到时为 null |

⚠️ **`(nodeSeq, turnKey, n)` 才是一次尝试的唯一标识,`(nodeSeq, n)` 不是。** 一段 5 轮的对话里有 5 个 `n === 1`。**页面按 `(nodeSeq, n)` 归并 = 把 5 轮的第一次尝试叠成一条**,时间轴上会看到一次尝试"反复重新开始"。

#### `status` 四档的判定表

| 值 | 什么时候 |
|---|---|
| `accepted` | 拿到产出**且**契约校验通过 |
| `rejected` | 拿到产出但契约不通过(`rejectedReason` 必填) |
| `no-output` | **已经确认产出是零字节**——注意是"确认为空",不是"没拿到" |
| `failed` | 这次尝试开始之后发生**后端 / RPC / 本地处理**失败:send 被拒收、wait 断管、超时、**拿不到或读不了 `textRef`**、拿到文本但本地复制失败 |

⚠️ **"拿不到 `textRef`" 必须归 `failed` 而不是 `no-output`**:拿不到**不等于**对方没说话——运行时无法证明"它确实什么都没输出",只能证明"我取不回来"。把取不回来说成"它没输出",是这个页面替系统撒的一个谎。(对应的节点总结局是 `unknown`。)

⚠️ **`open_session` 失败不在这张表里**:那时尝试循环还没进,该轮 `attempts: []`,**一条 attempt 事件都不发**——但**那一轮的 `node:turn` 与 `node:turn-settled` 照发**(status 是 `backend_failed` / `timeout` / `unknown`)。开会话只发生在**第一轮**,所以这种 0 尝试的轮**只可能是第一轮**。
⚠️ **它不是 `not-started`,别混**:开会话失败是**业务结局**(工具正常收场、写回执、那一轮**进 `turns[]`**、`sessionReusable` 按判定表多半是 `false` 于是整段封口);`not-started` 是**入场时抛 `UsageError`**(不进 `turns[]`、不封口、`key` 作废)。**判据是"有没有进 `turns[]`",不是"会话开没开起来"**(§5.4)。

⚠️ **attempt 条目的创建时机锚死在"剩余预算检查通过之后"**:一进 `while` 就写 `attempts[]` 会凭空造出一次**从未发送**的假尝试(源码在预算耗尽时明说"还没来得及发第 N 轮")。

#### `status` × `output` 矩阵(**两个维度不能合并**)

`status` 说的是**这一次尝试的结局**;`AssetState` 说的是**证据有没有被成功归档**。⚠️ **它也不是轮的结局**:一轮里 attempt 1 `rejected`、attempt 2 `accepted` 是常态,那一轮是 `ok`。

| 该次尝试的 `status` | `output` 的资产状态 |
|---|---|
| `accepted` / `rejected` | `present`(拿到产出并归档成功)或 `unavailable`(归档失败) |
| `no-output` | **`present`**(`byteCount: 0` + 空内容的 SHA);归档失败才是 `unavailable` |
| `failed` | **`present` 或 `unavailable`** —— **不能一律写死成 `unavailable`** |

⚠️ **`no-output` 不是 `not-applicable`**:每次尝试一律写一份产出原件到 canonical 区(§1.3 那张投影表),而 `copyBytes()` 对零字节文件照常成功、空文件的 SHA 也算得出来。**磁盘上确实躺着一份审计原件**,事件却说"不适用",就是在否认一份存在的证据。

⚠️ **`failed` 同理**:源码里存在"**文件已经复制成功、后续本地处理才失败**"这个窗口(`copyBytes` 成功、`readFileSync` 抛错 → 判 `unknown`)。把 output 写死成 `unavailable`,就是把一份**已经保住的证据**说成没保住。

#### 为什么 `node:attempt-settled` 不是冗余

只靠终态里的 `turns[].attempts[]` 有一条会断的路:attempt 1 的产出**已经归档好了**、attempt 2 正在跑、这时 owner 被强杀,于是**永远不会有 `node:settled`**,那份确实存在的产出**从没被任何事件公布过**。**每次尝试的产出一落盘就宣布**,这条路才闭合。

⚠️ **加了轮之后这条路更长了,不是更短了**:一段 6 轮的对话在第 6 轮被强杀,前 5 轮的产出全都只能靠 `node:turn-settled` / `node:attempt-settled` 公布——`node:settled` 那份 `turns[]` 永远不会来。

### 5.7 `node:progress`

活进度。**唯一允许整条丢弃的事件**(丢一条无所谓,下一条 5 秒后就来)。

```js
{ nodeSeq, turnKey, n, charCount, tail, status, lastEvent, contextUsage }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `turnKey` | string | 否 | 这条进度属于哪一轮。**恒在**——没有它,页面无法把在途正文贴到正确的那一轮上,多轮对话的 `tail` 会全部堆到最后一轮下面 |
| `n` | number | 否 | 当前在跑**本轮**第几次尝试(**1-based,每轮重置**,§5.6) |
| `charCount` | number | **否,恒有** | 已产出的长度。⚠️ 单位是 **UTF-16 code unit**(桥那边就是 `string.length`),**不是 Unicode 字符**——一个 emoji 计 2 |
| `tail` | string | **否,恒有** | 在途正文的**末尾 ≤240 个 UTF-16 code unit**(桥那边就是 `slice(-240)`)。**可能是空串**。**天生有界,不允许降级成 `BoundedSummary`** |
| `status` | string | **否,恒有** | 桥快照里的**会话状态**,原样透传。已知取值 `starting` / `running` / `idle` / `failed` / `closed`,**开放字符串**——没见过的值原样显示。≤200 字节 |
| `lastEvent` | object \| null | **可 null** | **只取白名单两个键**:`{ at, type }`。`at` 是桥给的 **ISO 8601 字符串**(⚠️ 与信封的 `ts` **不同口径**,见 §2),≤200 字节;`type` ≤200 字节。⚠️ 桥给的原始对象还有 `status`/`source`/`count`,**一律丢掉** |
| `contextUsage` | object \| null | **可 null** | **只取白名单四个键**:`{ tokens, live, isCompacting, autoCompactionEnabled }`。桥的真实形状是 `{tokens:number, live:boolean, isCompacting?:boolean, autoCompactionEnabled?:boolean}` 或 `null`;**缺席的键就不写**,不要补 null |

⚠️ **前四项的可空性是按桥快照的真实形状定的,不许"图省事一律放宽成 null"**:`status` / `charCount` / `tail` 在正常快照里恒有,把它们标成可 null,页面就得为一个**永远不会发生**的分支写文案,而真正会发生的两个(`lastEvent` / `contextUsage`)反倒淹没在里面。

⚠️ **`contextUsage: null` 的意思是「未知」,不是「0」。** cursor 与 kimi 两个后端**恒为 null**。把未知渲染成 0,页面上"没占上下文"与"没测到"长得一模一样——这是本设计的头号敌人(§6.1)。

⚠️ **快照本身取不到时:这条 `node:progress` 干脆不发。** **不许发一条全 `null` 的假进度**——`node:progress` 是唯一允许整条丢的事件(§7),下一条 5 秒后就来,而一条假进度会在时间轴上留下一个"它还活着而且什么都没产出"的错误证据。

⚠️ **`tail` 按 code unit 切会切开代理对**(半个 emoji)。定死:**切完之后若首字符是落单的低代理(low surrogate),把它丢掉。** 剩下的原样发。⚠️ **不许因此声称这里的单位是"Unicode 字符"**——丢掉半个代理对只是防止页面上出现 `U+FFFD`,并没有把计量口径改成字符。

⚠️ **`lastEvent` 与 `contextUsage` 必须走白名单**,理由完全一样:**它们是后端原样给的对象**,形状没有任何约束,直接透传等于把一个无上限的东西塞进 transcript。

⚠️ **节流 ≥5s**,且**零额外 RPC**——数据已经在内层 wait 切片超时返回的 `pendingSnapshots[0]` 里。

### 5.8 `node:settled` —— 完整形状

```js
{
  nodeSeq, status, execution, durationMs,
  outcome?,                 // write 节点才有
  receipt, artifact, diff,
  turns,                    // **恒有**,1..20 项,每项是一个 TurnSummary
  workspaceSummary?,        // **只在 receipt.state !== "present" 时**出现,字段封闭
  errorSummary?             // 同上
}
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `nodeSeq` | number | 否 | |
| `status` | string | 否 | **封闭枚举六档**:`"ok"` \| `"contract_error"` \| `"backend_failed"` \| `"timeout"` \| `"unknown"` \| `"callback_error"`。判定优先级见下 |
| `execution` | string | 否 | `"fresh"` \| `"reused"`。**`reused` 不是 status**,是正交标记——复用返回的是旧回执的 `status:"ok"` |
| `durationMs` | number | 否 | **第一轮起钟 → 节点收尾**,**包含轮与轮之间回调在干别的事的时间**(所以 `≥ Σ turns[].durationMs`,§5.4)。⚠️ **复用时这是「原来那次执行」的耗时**,不是这次复用检查的耗时。页面**必须标成"原执行耗时"**,否则一次 200ms 的复用会显示成"跑了 40 分钟" |
| `outcome` | string | **write 节点才有,read 节点缺席** | `"delivered"` \| `"no-changes"` \| `"unknown"`。**这是 write 节点交付结论的唯一权威判据**,页面**不得**自己拿 `committed`/`filesChanged` 再推一遍。⚠️ **它是节点级的:N 轮共享一棵工作树、一条分支,整段只提交一次** |
| `receipt` | `AssetState` | 否 | 归档里的 `receipt.json` |
| `artifact` | `AssetState` | 否 | 顶层产出,**`ref` 指向该节点最后一次成功复制的那份 `turns/<key>/attempt-<n>.output.md`**(归档里没有 `artifact.md`,见 §1.3)。⚠️ 语义是**最后一次成功复制到本地的产出**,不等于"采纳的那份"——`contract_error` 收场时它是**被判不合格**的那份,页面不能标成"采纳" |
| `diff` | `AssetState` | 否 | write 节点的 `change.diff`;read 节点与 `no-changes` → `not-applicable` |
| `turns` | array | 否 | **恒有**,**`1..20` 项**(`maxTurns = 20`,超了当场 `UsageError`),每项是一个 `TurnSummary`,见下。**按轮的实际发生顺序排**。⚠️ **单轮节点也有,`[{key:"main", …}]`**——没有"没有轮的旧形状"。⚠️ **下界是 1,不是 0**:一轮都没跑起来的节点**根本不会有 `node:settled`**(它不写回执,走 `node:rejected`,见下与 §5.3),所以空数组在合法记录里**不存在**,收到了就按 §10.1 的"记录不完整"处置。**全文三处(这里、上面的形状注释、下面那条"0 轮的节点")口径一致** |
| `workspaceSummary` | object | **只在 `receipt.state !== "present"` 时出现** | 字段封闭,见下 |
| `errorSummary` | string \| `BoundedSummary` | **只在 `receipt.state !== "present"` 时可能出现** | 回执里 `error` 的摘要;回执本来就没有 error 时缺席。≤2 KiB |

⚠️ **`node:settled` 上没有 `scene`,也没有节点级的 `attempts[]`**——两样都下沉到轮:现场在 `node:turn-settled.scene`(一段对话可能有多份,§3.2),尝试摘要在 `turns[].attempts[]`。**页面不许再去 `node:settled` 上找它们。**

#### `turns[]` 的每一项 = `TurnSummary`(**有界摘要,不是回执同形对象**)

```js
{ key, status, sessionReusable, output, turnSpecHash, charCount, durationMs,
  inferredDeps, inferredDepsTruncated, attempts }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `key` | string | 否 | 这一轮的 `turnKey`,**与该轮 `node:turn.turnKey` 逐字节相同** |
| `status` | string | 否 | 轮级**五档**封闭枚举,同 §5.4(**没有 `callback_error`**,**也没有 `not-started`**——`not-started` 的轮不进 `turns[]`) |
| `sessionReusable` | boolean | 否 | 同 §5.4。**第一个 `false` 就是毒化点**(⚠️ 派生前要先过"这是不是对话节点"那道闸,§5.4、§10.8) |
| `output` | `AssetState` | 否 | 该轮产出的归档状态 |
| `turnSpecHash` | **`hex32`** | 否 | 该轮任务单指纹:SHA-256 取**前 32 个 hex 字符**(§0.2),覆盖 key / 该轮冻结正文 / `timeoutMs` / `schema` / `outputShape` / `reask`。⚠️ **不是 `hex64`**;⚠️ 事件层**只有这一处**有它(`node:turn` 上那份已删,§5.4) |
| `charCount` | number \| null | **可 null** | UTF-16 code unit |
| `durationMs` | number | 否 | **该轮**耗时(非负整数) |
| `inferredDeps` | string[] | 否 | **恒有。** 扫**该轮冻结正文**得到,算法与 `node:observed.inferredDeps` / `node:turn.inferredDeps` **完全相同**(§5.2),只截取**前 20 项**(上限比事件级那份小,理由见下)。每项 ≤200 字节 |
| `inferredDepsTruncated` | boolean | 否 | **恒在。** `true` = 该轮扫出的候选**超过 20 项**,这里只放了前 20 |
| `attempts` | array | 否 | **恒有**,`0..2` 项,见下。`open_session` 失败的那一轮是 `[]` |

⚠️ **`inferredDeps` 必须在这里再出现一次,不是对称美**:**复用命中的对话一条 turn 事件都不发**(§5.9),而它的 `node:observed.inferredDeps` 恒 `[]`(对话在那一刻一个字的正文都没有,§5.2)。少了这一份,**一命中复用,整段对话的推断边就全没了**——而"第 2 轮照着另一个节点的产出提问"正是这个功能的头号用法。理由与 `attempts[].inputSha256` 恒有那条**完全一样**:复用命中时它是唯一来源。

**来源(两条路都要能给出,`fresh` 与 `reused` 用的是同一段字节):**

- 输入恒为**本次冻结的那一轮正文**——`fresh` 时就是刚发出去的那份;`reused` 时是本次为比对而冻结的那份,而 `turnSpecHash` 已经逐轮比对过(§5.9),**正文与原运行必然相同**。所以这一份**不依赖旧回执里有没有这个字段**,也就不受 `RECEIPT_VERSION` 的施工顺序影响(与 `attempts[]` 那条不同,见下)。
- ⚠️ **`fresh` 时它必须是该轮 `node:turn.inferredDeps` 的前 20 项**(同一算法、同一输入、同一顺序 ⇒ 逐项相同)。**这是可验的断言**,不是约定:两者对不上就是 writer 有 bug。

⚠️ **为什么这一份的条数上限是 20,而 `node:turn` 那份是 200**:`node:turn` 一轮一条**独立的行**,40 KB 的最坏情况离 1 MiB 很远;而 `turns[]` 是**内联进 `node:settled` 这一行**的,20 轮 × 200 项 × 200 字节 = **800 KB**,叠上 §7 实测的 attempt 摘要就会顶穿行上限 —— 那条 `node:settled` 会被转 `recording-failed`,页面就此合成一个**假的 `abandoned`**(§7)。**20 这个数与 `maxTurns = 20` 同级,是有界性论证的一部分,谁调大就必须重算 §7 那一段。** 截断照旧**绝不静默**:每一项自带 `inferredDepsTruncated`,页面必须说出来(§10.7)。

⚠️ **`TurnSummary` 刻意比 `node:turn-settled` 少 `scene` 与 `errorSummary`**,原因不是"图省事",而是这两样在 `node:settled` 这条路上**必然为空**:`node:settled` 里的 `turns[]` 只有两种来源——本次跑完(每一轮的 scene 与 error 早已由不可丢的 `node:turn-settled` 逐条公布过),或**复用命中**(而回放闸要求**每一轮旧 status 都是 `ok`** 才放行,`ok` 的轮既没有 scene 也没有 error)。**留一个恒为 `not-applicable` 的槽,只会让页面为一个不存在的分支写文案。** ⚠️ 唯一那种"`errorSummary` 恒有"的轮(`status:"not-started"`)**压根不进 `turns[]`**,所以这条论证不受它影响。

⚠️ **轮级没有 `rejectedReason`**:契约打回的原因就在 `attempts[].rejectedReason` 里,轮级再放一份是同一事实的第二个副本。

#### `turns[].attempts[]` 的每一项(**内联兜底摘要,只带指纹与状态,不含正文**)

```js
{ n, inputSha256, input, output, status, rejectedReason? }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `n` | number | 否 | **1-based,本轮内的序号**(§5.6)。⚠️ **同一轮内不得重复**——"第 n 次尝试"在本文件里一律指「`attempts` 中**唯一满足 `.n === n`** 的那一项」,**永远不是 `attempts[n]`**(`n` 是 1-based,数组是 0-based) |
| `inputSha256` | `hex64` | 否 | **恒有,这一条是必须的,不是对称美**(理由见下) |
| `input` | `AssetState` | 否 | 该次输入的归档状态 |
| `output` | `AssetState` | 否 | 该次产出的归档状态(同 §5.6 的矩阵) |
| `status` | string | 否 | 四档封闭枚举,同 §5.6 |
| `rejectedReason` | string \| `BoundedSummary` | 只在 `status === "rejected"` 时出现 | ≤2 KiB,超限降级 |

⚠️ **这里的每项比 `node:attempt-settled` 少 `durationMs`/`charCount`**:它是兜底摘要,不是那两条事件的复制。(回执里的 `attempts[]` 另有这两项,那是**回执合同**,不是事件合同。)

⚠️ **`inputSha256` 恒有的理由是一条确定会断的路**:
1. 原运行 **viz-off** → 重说的输入原文当初没落盘,只有指纹;
2. 本次**复用**命中 → `input = {state:"unavailable", code:"fingerprint-only"}`;
3. 归档那份 `receipt.json` **也写失败** → 页面打不开回执。

此时既没有 `node:attempt`(**复用命中的节点不发任何 turn / attempt 事件**),`unavailable` 联合里又只有 `code`、没有 SHA——UI 要求显示的「**仅保留指纹**」连那串指纹都拿不出来。而指纹恰恰是那一段仅存的审计价值。

⚠️ **这不违反"事件不复制大字段"**:`maxTurns = 20`、每轮 ≤2 次尝试 ⇒ **全节点最多 40 项**,每项只有指纹与状态、不含正文(§7 给了整块的字节上界)。

⚠️ **`inputSha256`(以及整个 `attempts[]`)在盘上有持久来源**:`RECEIPT_VERSION` 2 起,回执两级(顶层与 `turns[]`)都带 `attempts`。
⚠️ 本行早先写的是"今天在盘上还没有持久来源"——**那是施工中途的状态,早已过时**,而且它与下一小节末尾那段自相矛盾。照它去实现会重新长出一条"reused 拿不到 attempts"的兼容分支。

#### `turns[]` 从哪儿来(**writer 现构;回执层不是它的来源**)

⚠️ **`turns[]` 是 writer 现构的,不是从回执里搬过来的。** 这一条必须写死——否则实现者会去回执里找一个**在 `runNode` 上压根不存在**的数组:
⚠️ **"现构"说的是这个数组本身,不是说它的每一个字段都无中生有。** 复用命中时,`status` / `turnSpecHash` / `charCount` / `attempts[].inputSha256` 等**照抄旧回执**(它们记录的是**原运行**发生了什么);而 `output` / `input` 由归档器按**本次实际拷贝结果**给出,`inferredDeps` **本次重算**。两句话不矛盾:**数组是现构的,里面哪些字段来自旧回执有明确清单**(见 §5.9)。

| 节点 / 路径 | 回执里有 `turns[]` 吗 | writer 怎么给出事件里的 `turns[]` |
|---|---|---|
| `conversation` + `fresh` | **有**(每轮一项) | 用它在途看到的那些轮构造(`node:turn` … `node:turn-settled`),**并跳过 `status:"not-started"` 的轮** |
| `conversation` + `reused` | **有**(旧回执那份) | 逐轮照抄旧回执:`turnSpecHash` / `status` / `durationMs` / `charCount` / `attempts[].inputSha256` / `attempts[].status` 照抄;`output` / `input` 由归档器按**本次实际拷贝结果**给出;`sessionReusable` 恒 `true`(回放闸要求每轮旧 status 都是 `ok`);`inferredDeps` **本次重算**(见上) |
| `runNode` + `fresh` | **没有**(那一轮**就是**回执本身) | **投影出恰好一项 `key:"main"`**,算法见下 |
| `runNode` + `reused` | **没有** | 同上,但字段取自**旧回执的顶层** |

**`main` 的投影算法(逐字段定死,`fresh` 与 `reused` 共用一份):**

| `TurnSummary` 字段 | 取什么 |
|---|---|
| `key` | 字面量 `"main"` |
| `status` | 回执顶层 `status`。⚠️ 顶层六档里的 `callback_error` **不可能**出现在 `runNode` 上(它没有回调),所以投影结果必然落在轮级五档内 |
| `sessionReusable` | **writer 按 §5.4 那张判定表派生**(`ok` / `contract_error` → `true`;`timeout` 且 abort 被确认 → `true`;其余 → `false`)。⚠️ **`runNode` 的回执里压根没有这个键**(源码只给对话加),所以它**只能**是算出来的 —— **这正是 §5.4 那道"先判是不是对话"闸存在的原因**:一个 `backend_failed` 的 `runNode` 投影出来就是 `false`,没有那道闸,页面会把一个根本不是对话的节点显示成"对话被封口" |
| `output` | 归档器按**本次实际拷贝结果**给出 |
| `turnSpecHash` | 用**同一个算法**在这一轮上算:key = `"main"`、正文 = 本次冻结的 prompt、`timeoutMs` / `schema` / `outputShape` / `reask` 取**节点顶层**那四个(单轮节点把逐轮参数写在顶层,§1.3)。⚠️ **它不参与 `runNode` 的复用闸**(那道闸比的是 `specHash`),页面**不许**把它当"复用判据";它在这里的唯一用处是让轮级摘要的形状**对单轮与多轮完全一致**(§10.9 第 7 条 —— 与"归档区一律 `turns/<key>/`、零例外"是同一个取舍) |
| `charCount` / `durationMs` | 回执顶层同名字段(`reused` 时是**原执行**的值,同 `node:settled.durationMs` 那条口径) |
| `inferredDeps` / `inferredDepsTruncated` | 扫**本次冻结的 prompt 正文**、取前 20 项(见上)。⚠️ 单轮节点这一份**不是**唯一来源(`node:observed.inferredDeps` 有同一个集合的完整版),§10.7 取并集即可 |
| `attempts` | `fresh`:由在途的 `node:attempt*` 构造;`reused`:见下 |

**⚠️ `attempts[]` 的来源(施工已完成,下面这段记的是历史与理由):**

- 现状:`RECEIPT_VERSION` 是 **2**,**回执两级(顶层与 `turns[]`)都带 `attempts`**,每次尝试各有自己的产出原件与输入指纹。`fresh` 路径从在途事件构造,`reused` 路径从旧回执里逐项读 —— **两条路都拿得到**。
  ⚠️ 本段早先写的是「现状 `RECEIPT_VERSION` 还是 1、reused 路径拿不到」——**那是施工中途的状态,早已过时**。照它去实现会以为复用节点没有逐次尝试可展示,于是重新长出一条"reused 没有 attempts"的兼容分支,而 v1 的回执其实**在复用闸上就被拒了**(版本严格等值)。
- **定死的处置:`attempts[]` 落地那一批必须同时 bump `RECEIPT_VERSION`**(viz 施工第 5 项一次给回执与事件两级加 `attempts[]`)。bump 之后**不存在"没有 `attempts` 的旧回执还能命中复用"这种局面**:复用闸对 `receiptVersion` 做**全等**比对,对不上当场 `UsageError` ⇒ 页面上就是一条 **`node:rejected{phase:"reuse-check"}`**(正文写着"回执存在但版本对不上"),要重跑得显式加 `force`。**旧回执一律不复用,是响亮的拒绝,不是静默降级。**
- **明确不采用的两种**:①给 `reused` 路径发一个"没有 `attempts` 的降级形状"——那是为一个过渡期往 schema 里加分支,页面得为它写文案,而过渡期结束后那段代码不会有人删;②让 `inputSha256` 变成可缺席——它恒有正是为了上面那条"仅保留指纹"的路。
- ⚠️ **所以本小节的 `attempts[]` 合同要与那一项一起验收**:在它落地之前,`reused` 节点给不出符合本文件的 `turns[].attempts`。**这不是文档的洞,是施工顺序上的依赖。**

#### 节点级 `status` 的判定优先级(**从低到高,后者改写前者**)

| # | 判据 | 结果 |
|---|---|---|
| 1 | `turns[]` 全部 `ok` | `ok` |
| 2 | 有非 ok 的轮 | **各轮里最严重的那一个**,严重度序 `ok < contract_error < backend_failed < timeout < unknown` |
| 3 | 回调抛了异常,**且**此刻 status 仍是 `ok` | `callback_error` |
| 4 | **`access === "write"` 且工作树确实建起来了**,而 `outcome` 不是 `delivered`/`no-changes` | `unknown` |
| 5 | 回执写入失败 | `unknown` |

- **第 2 级取"最严重",不是"第一个非 ok"、也不是"最后一轮"**:前者会被后面更坏的轮遮住(第 1 轮 `contract_error`、第 2 轮 timeout 且未确认打断 ⇒ 报 `contract_error`,而那按语义是"改改 prompt 就能重跑",实际上第 2 轮可能还在后台跑);后者会被前面更坏的轮遮住("第 2 轮挂了、第 3 轮碰巧成了"报成功)。⚠️ **N=1 时这条与"就是那一轮的 status"恒等**——所以单轮节点的语义一个字没变。
- **`callback_error` 的意思是"每一轮都好好的,是编排那段 JS 自己炸了"**。它只可能出现在**有回调的那种节点**上(单轮的 `runNode` 没有回调,产生不了它),但它**是一个正经的第六档,不是边角料**:页面必须给它单独文案,并且**不许**显示成"AI 失败了"——失败的是调用方那段代码。⚠️ **它不是"轮数多"才有**:一段只聊了一轮的对话,回调在拿到结果后自己抛异常,照样是 `callback_error`。
- **一轮都没跑起来的节点不会有 `node:settled`**:那样的段落**不写回执**(一张 `turns: []` 的回执会让复用闸面对一个没有任何判据的对象),它走 `node:rejected`,`phase` 按 §5.3 那棵决策树取——**最后一次失败的 `turn()` 已经发出过 `node:turn` ⇒ `preflight` / `workspace-setup`(先判这条);否则 `turnCalls === 0`(一次都没调)⇒ `zero-turn`;`turnCalls > 0` 而 `turns[]` 为空 ⇒ `turn-validation`**。⚠️ **别把这三种都写成 `zero-turn`**:那会把"参数写错了"和"编排空转"混成一句话。⚠️ 消费方**万一**收到空 `turns[]`,按 §10.1 的"记录不完整"处置,**不许显示成"成功但没说话"**(同 `turns` 那一行的 `1..20`)。
- ⚠️ **事件流里那些 `status:"not-started"` 的轮不进 `turns[]`,所以顶层 `status` 也绝不受它们影响**:第 2 级取的是"`turns[]` 里最严重的那一轮",而它们不在里面。**一条"某轮没能开始、后面换个 key 跑成了"的节点,顶层照样可以是 `ok`** —— 页面不许因为看到一条 `not-started` 就把节点标成失败。
- **`status` 与"哪一轮出的事"是两件事**:顶层只说最严重的那一档,**具体是哪一轮**必须去 `turns[]` 里看每轮自己的 `status`——这也是 `turns[]` 恒有的理由之一。

#### `workspaceSummary`(**字段封闭**)

```js
{ path, branch, baseCommit, headCommit, removed, changesKnown }
```

| 字段 | 类型 | 可空 | 含义 |
|---|---|---|---|
| `path` | string \| null | **可 null** | worktree 路径。≤512 字节 |
| `branch` | string \| null | **可 null** | 交付分支;`no-changes` 且空分支被删掉时为 `null` |
| `baseCommit` | **`hex40`** \| null | **可 null** | `git rev-parse` 给的完整 SHA(**不是短 SHA**);拿不到为 `null` |
| `headCommit` | **`hex40`** \| null | **可 null** | 没提交成功时为 `null` |
| `removed` | boolean | 否 | ⚠️ **准确读法**:`true` = 收尾时确认删掉了;`false` = **收尾时没有确认清理**(可能没删、可能删了但没确认)。**推不出"这个目录现在还在磁盘上"**,页面文案统一用「收尾时未确认清理」 |
| `changesKnown` | boolean | 否 | 「我们**确知**这棵工作树里有没有改动」。`false` = git 探测失败,既不能说有也不能说没有 |

⚠️ **`workspaceSummary` 一旦出现,这六个键就一个都不能少**(值可以是 `null`,键不许缺席)。
理由就是这一层存在的**全部**意义:回执没归档成功时,它是"人怎么找到现场"的唯一线索。
一份 `{}`(或者只剩 `removed`)照样是合法 JSON、照样能过 schema,而页面这时候连
**该去核对哪个目录、基于哪个提交**都说不出——那等于兜底没兜住,却又不报错。
⚠️ **`null` 是唯一的"拿不到"表示 —— 既不许省略这个键,也不许用空字符串顶替。**
空串会当场撞上 `hex40` 那道校验,把一条**本该合法**的 `node:settled` 变成 `recording-failed`:
兜底那一层的作用是"回执没了也让人找得到现场",它自己**绝不能**成为记录失败的原因。
⚠️ **拿不到时用 `null`,不要省略这个键。** 「键不在」与「值是 null」在页面上必须是同一件事(未知),
做成可缺席就会有两套分支各写各的——同 §3.1 对 `AssetState` 的一贯口径:**不许用缺席表达未知**。

⚠️ **没有 `diffRef`** —— diff 只有顶层那一个真理源(`node:settled.diff`)。
⚠️ **刻意不含 `filesChanged` 与 `diagnostics`**:两者都无上限,内联进事件就是把事件流变成第二个真理源。**兜底的职责是"让人能找到现场",不是"复刻回执"。**
⚠️ **read 节点恒无 `workspaceSummary`**(源码里 read 的 `workspace` 恒为 `null`),哪怕 `receipt` 不是 present。

#### 两级兜底,顺序固定

1. 归档那份 `receipt.json` 由 viz 层**从节点收尾返回的内存对象**另写一次(**不是拷贝 canonical 文件**)——canonical 写失败时这一次往往仍然成功,页面照样有完整回执。
2. 归档也写失败,才走上面那个**字段封闭**的内联兜底。

**为什么 `receipt` 这个资产必须允许 `unavailable`**(⚠️ **不是字段可空**——`receipt` 这个**键恒在**,恒是一个 `AssetState`,变化的是它的 `state`):**节点收尾**的最后一步才 `writeAtomic(receiptPath, …)`,失败时它只把**内存里**的对象改成 `unknown` 并记下原因,**不会再写一次**;而 `writeAtomic` 在 rename 失败时会把临时文件删掉,**也不能指望从 tmp 捞**。此时磁盘上要么没有本次回执,要么留着**上一版的旧回执**——让事件硬指一个"回执一定在"的 ref,等于把页面导向一份不属于这次运行的文件。

⚠️ **不再有独立的 `recordingError` 字段**:每个资产自己带 `state` 与 `code`,"哪一样没记下来"是逐资产读出来的。

#### `status` × `outcome` 的合法组合(**页面判别的依据**)

| `outcome` | 合法的顶层 `status` |
|---|---|
| `delivered` | `ok` · `contract_error` · `backend_failed` · `timeout` · **`unknown`** · **`callback_error`** |
| `no-changes` | 同上 |
| `unknown` | **只能是 `unknown`** |

- **`callback_error × delivered` 是一格真实存在的组合**:每一轮都好好的、代码也好好地提交在分支上,只是编排那段 JS 自己炸了。⚠️ **页面绝不能因为 status 不是 ok 就把分支藏起来**(同下一条)。
- **失败三档 × `outcome:"unknown"` 根本不存在**:**节点收尾**在 outcome 既非 delivered 也非 no-changes 时**强制把顶层降级为 `unknown`**。理由:`backend_failed`/`timeout` 在本工具契约里意味着"可以安全换个人重跑",而重跑通常带 `force`,`force` 会**把正因说不清才保留的工作树连同分支一起删掉**——工作区状态不明时宣称可安全重跑,等于亲手安排了一次数据销毁。
- **`unknown + delivered/no-changes` 是真实存在的一格,不是边角料**:代码可能**已经好好地提交在分支上**,只是这次执行的结局说不清(至少三种来源:`open_session` 返回形状不认识 / `send_message` 的 ack 形状不认识 / 回执落盘失败)。**页面绝不能因为 status 是 unknown 就把分支藏起来。**
- **两个"说不清"必须用不同的话说**:`status:"unknown"` = 「这个环节干没干完,说不清」;`outcome:"unknown"` = 「改动有没有落到分支上,说不清」。
- **`delivered` 允许 `filesChanged` 为空**(agent 建了空提交、或提交完又 revert:HEAD 前进了但净改动为零,diff 是 0 字节,源码判为**合法的 delivered**)。页面不能写「已交付 = 有一批文件改动」。
- **`outcome` 与"工作区清理状态"是两件事**:`delivered` 与 `no-changes` **都可能 `removed:false`**。UI 必须把「交付结论」与「工作副本清理状态」**分成两栏**。

### 5.9 复用命中的节点长什么样

源码在幂等闸后直接 `return { ...prev, reused: true }`,所以它的事件序列**只有两条**:

```
node:observed  →  node:settled{ execution: "reused" }
```

**没有** `node:turn` / `node:started` / `node:turn-settled` / `node:workspace-*` / `node:attempt` / `node:attempt-settled` / `node:progress`。

⚠️ **复用命中只发那一条 `node:settled` 的历史摘要,绝不伪造 `node:turn`。** 对话的复用要跑一遍回调来**逐轮比对**(每一轮的 `turnSpecHash` 与产出 SHA 都要对上),那期间 `turn()` **一条消息都不发、一个闸都不拿、会话都不开**。为它补一条 `node:turn` 会在时间轴上画出一段**本次并没有发生**的对话——「这一轮什么时候开始的」必须是真的发生过。**历史那 N 轮的全部信息都在 `node:settled.turns[]` 里**,那才是它们该出现的地方。

- **`turns[]` 是 writer 现构的,不是"从旧回执整块搬过来"**——逐字段的来源见 §5.8 那张投影表,这里只重申三条最容易写错的:
  - **`conversation` 的复用**:`turnSpecHash` / `status` / `durationMs` / `charCount` / `attempts[].inputSha256` / `attempts[].status` **照抄旧回执**;`output` / `input` 由归档器按**本次实际拷贝结果**给出;**`inferredDeps` 本次重算**(见下一条)。
  - **`runNode` 的复用**:旧回执里**根本没有 `turns[]`**(单轮节点的那一轮就是回执本身),事件里那一项 `key:"main"` 是 writer 从**回执顶层字段**投影出来的,`sessionReusable` 更是**算出来的**(§5.8)。**别去旧回执里找 `turns`,那儿没有。**
  - **`attempts[]` 拿得到**(`RECEIPT_VERSION` 已是 **2**,回执两级都带 `attempts`,每次尝试各有自己的产出原件与输入指纹)。⚠️ 本行早先写的是「今天还拿不到(`RECEIPT_VERSION` 仍是 1)」——**那是施工中途的状态,早已过时**;照它去实现会以为复用节点没有逐次尝试可展示,于是整段 attempts 被跳过。
- ⚠️ **`inferredDeps` 是复用命中时拓扑边的唯一来源,而它由 writer 本次重算,不来自旧回执**:对话节点的 `node:observed.inferredDeps` 恒 `[]`、又没有任何 `node:turn`,所以**少了 `turns[].inferredDeps`,一命中复用整段的推断边就全没了**(§10.7 因此规定复用节点从这里取)。重算是安全的:回放时每一轮的正文都被重新冻结过,而 `turnSpecHash` 逐轮比对过 ⇒ **正文与原运行必然是同一份字节**。
- ⚠️ **复用命中时,每一轮的提问原文只能从该轮 `attempts` 里 `.n === 1` 那一项的 `input` 拿**——`TurnSummary` 本身没有 `input` 槽(它是那一项的第二个副本)。这也是那一项 `inputSha256` 恒有的用处所在。
- **回放闸要求每一轮的旧 status 都是 `ok`**,所以复用命中的节点里 `turns[].status` 恒为 `"ok"`、`sessionReusable` 恒为 `true`、没有任何一轮有现场。
- 原运行 **viz-off** 时,每一轮 attempt 1 的输入仍能从**本次冻结的那一轮正文**恢复(`turnSpecHash` 已经逐项比对过,正文必然相同);而 **n≥2 的输入只剩指纹**。
- **归档器(不是 viewer)可以按当时的模板构造一个候选重说输入,但只有候选的 SHA 与 `inputSha256` 逐字节一致时才落盘并给出 `present`**;对不上 → `{state:"unavailable", code:"fingerprint-only"}`,页面显示「原运行未归档输入原文,仅保留指纹」。**既不造内容,也不给死链接。**
  (被禁止的是**无校验的重构**;指纹逐字节对上不算伪造历史。)

### 5.10 `run:final`

```js
{ result, counts, durationMs }
```

| 字段 | 类型 | 可空/可缺席 | 含义 |
|---|---|---|---|
| `result` | string | 否 | `"completed"` \| `"failed"`,见下面的判据 |
| `counts` | object | 否 | **固定键集**,九个键**全部恒在**,值是非负安全整数 |
| `durationMs` | number | 否 | 本次 graph 的总耗时,**定义为 `run:final.ts − run:started.ts`**(两条都在同一份 transcript 里,页面可以自己验) |

#### `counts` 九个键的精确口径

| 键 | 数什么 |
|---|---|
| `observed` | 发出过 `node:observed` 的节点数 |
| `rejected` | 发出过 `node:rejected` 的节点数 |
| `ok` / `contract_error` / `backend_failed` / `timeout` / `unknown` / `callback_error` | `node:settled.status` 取各该值的**节点**数 |
| `reused` | `node:settled.execution === "reused"` 的节点数 |

⚠️ **`counts` 数的是节点,不是轮。** 这里**没有** `turns` 计数:一个 12 轮的节点仍然只在这九个桶里占一格。**所以那些 `status:"not-started"` 的轮完全不进这九个桶,也完全不影响下面两条恒等式**——它们是轮这一层的事,而恒等式只在"每个节点恰好一个终态"这一层成立。要按轮统计,页面自己去数 `node:settled.turns[]`——**`counts` 的全部价值是那条恒等式**,而恒等式只在"每个节点恰好一个终态"这一层成立。

**两条恒等式(页面可据此自查):**

1. **`observed === rejected + ok + contract_error + backend_failed + timeout + unknown + callback_error`**
   ——每个已 observed 的节点在 `run:final` 之前**恰好**有一个终态事件,这正是收尾第 2 步"排空"保证的(§8.3、§9.1)。**等式不成立 = 记录不完整**,页面必须整体标注,而不是去猜差额是哪几个节点。
   ⚠️ **`callback_error` 必须在这条等式里**:它是一个正经的终态档,漏掉它,每一个"轮都好好的、编排那段 JS 自己炸了"的节点都会让等式差 1,于是一次正常记录被判成"记录不完整"。
2. **`reused ≤ ok`**。

⚠️ **`reused` 是 `ok` 的子集,不是并列的桶**(复用返回的就是一张 `status:"ok"` 的旧回执)——**九项加起来不等于总数,页面别去求和。** 第 1 条恒等式里没有 `reused`,原因就在这里。

#### `result` 只由三样决定(**不看节点回执**)

| 情况 | `result` |
|---|---|
| 用户回调抛了异常 | `failed` |
| 回调正常返回、`bridge.close()` 也成功 | `completed` |
| 回调正常返回、**排空期间看到 failed / unknown 回执** | **仍是 `completed`** —— **节点结局不是 run 结局** |
| 回调正常返回、**只有 `close()` 失败** | `failed` |

⚠️ **观测台不裁决业务成败。** 节点对六档业务结局一律**正常 resolve**,"一个环节挂了怎么办"按 SKILL 的明文规定**是调用方的策略**。让收尾去看回执再判整个 run 失败,就是把只读观测台变成隐式的流程裁判(`allSettled` 甚至看不出那个 `contract_error` 是不是回调有意接住并处理掉的)。

⚠️ **`callback_error` 是唯一一个"既有 `node:settled`、又向调用方抛了异常"的结局**:那个节点的收尾照常走完(关会话、收工作区、写回执),然后**原样重抛**回调那个异常。所以页面上它是一个**有终态的节点**,而 graph 那层的 `run:final.result` 是不是 `failed`,取决于编排那段 JS 有没有把它接住——**两件事,不许互相推断**。

⚠️ **不带 `halt`**:它是调用方那段 JS 的返回值,没有任何流程语义,UI 也没有消费它的地方;塞进事件就得为"回调返回任意 JS"背上一整套序列化与摘要合同。

---

## 6. 字段上限表

**每一个自由字符串、每一个数组都必须有上限。** 这不是洁癖:超过**行上限 1 MiB** 的行会被丢弃,而丢的若是 `node:settled` 或 `run:final`,页面就会合成一个**假的 `abandoned`**——一条"事件太长"最后表现成"运行被掐断"。

| 字段 | 上限 | 超限怎么办 |
|---|---|---|
| **整行**(含换行) | **1 MiB** | 见 §7 |
| `node:rejected.error` | 2 KiB(**降级触发阈值**) | ✅ 降级成 `BoundedSummary`(§3.3) |
| `node:settled.errorSummary` / `node:turn-settled.errorSummary` | 2 KiB(**降级触发阈值**) | ✅ 降级成 `BoundedSummary` |
| `rejectedReason`(`node:attempt-settled` 与 `turns[].attempts[]` 两处) | **2 KiB**(**降级触发阈值**,与另两个可降级字段**同档**) | ✅ 降级成 `BoundedSummary` |
| `AssetState.code` / `SceneState.code` | **200 字节**(一个短码,不是错误正文) | ❌ 结构字段 → `recording-failed` |
| `node:progress.tail` | **240 个 UTF-16 code unit**(UTF-8 下 ≤720 字节) | ❌ 天生有界,**不许降级** |
| `node:observed.id` | 200 字节 | ❌ → `recording-failed` |
| `node:observed.group` | 200 字节 | ❌ → `recording-failed` |
| `node:observed.model` / `.effort` | 各 200 字节(源码只 `requireString()`,不限长) | ❌ → `recording-failed` |
| **`turnKey`**(`node:turn` / `node:turn-settled` / `node:started` / `node:attempt` / `node:attempt-settled` / `node:progress` / `turns[].key` 七处) | **200 字节**(源码同限,且拿来做文件名) | ❌ 结构字段(它是归档目录名的一段)→ `recording-failed` |
| **`turnSpecHash`**(**只在 `turns[].turnSpecHash` 一处**——`node:turn` 上那份已删,§5.4) | 固定 **`hex32`**(⚠️ **不是 `hex64`**,见 §0.2) | ❌ 形状不对 → `recording-failed` |
| `declaredDeps` / `inferredDeps` 的**每个字符串**(`node:observed` / `node:turn` / `turns[]` 三处同档) | 各 200 字节 | ❌ → `recording-failed` |
| `declaredDeps` 的**条数** | **200 项** | ❌ **`normalizeSpec` 抛 `UsageError`**(入口拒绝,一个事件都不发,§5.2) |
| `inferredDeps` 的**条数**:`node:observed` 与**每条** `node:turn` 各自计 | **各 200 项** | ⚠️ **取前 200 项 + 该条事件自己的 `inferredDepsTruncated: true`**(§5.2)。**绝不静默截断** |
| `inferredDeps` 的**条数**:**`turns[]` 的每一项**各自计 | **各 20 项**(⚠️ **比事件级那份小**:它内联在 `node:settled` 一行里,20 轮 × 200 项会顶穿行上限,算术见 §7) | ⚠️ **取前 20 项 + 该项自己的 `inferredDepsTruncated: true`**(§5.8)。**绝不静默截断** |
| `AssetState.ref` | **512 字节**(相对路径,形状由我们自己构造) | ❌ → `recording-failed` |
| `sha256` / `inputSha256` | 固定 `hex64` | ❌ 形状不对 → `recording-failed` |
| 所有 `number` | 见 **§6.1** | ❌ 出域 → `recording-failed` |
| `run:started.outDir` | 512 字节 | ❌ → `recording-failed` |
| `node:observed.cwd` | 512 字节 | ❌ → `recording-failed` |
| `node:workspace-*.path` / `.branch` / `.baseCommit` | 各 512 字节 | ❌ → `recording-failed` |
| `workspaceSummary.path` / `.branch` / `.baseCommit` / `.headCommit` | 各 512 字节 | ❌ → `recording-failed` |
| `node:progress.contextUsage` | **只取白名单** `tokens` / `live` / `isCompacting` / `autoCompactionEnabled` | 其余键**丢弃** |
| `node:progress.lastEvent` | **只取白名单** `at` / `type`;**两者各 ≤200 字节** | 其余键**丢弃**;白名单内超限 → `recording-failed` |
| `node:progress.status` | **200 字节** | ❌ → `recording-failed` |
| `run:final.counts` | **固定键集**(九个键) | 多余的键不许出现 |
| **`node:settled.turns[]` 的条数** | **20**(`maxTurns = 20`,源码超了当场 `UsageError`) | ❌ → `recording-failed` |
| `attempts[]` 的条数(**每一轮各自计**) | **2**(`reask` 逐轮声明且限死 `∈ {0,1}`) | ❌ → `recording-failed` |
| 控制消息 `recording-failed.error` | 2 KiB(**降级触发阈值**,同 `error` 档) | ✅ 降级成 `BoundedSummary` |
| SSE 控制帧 `history-read-failure.reason` | 2 KiB(**降级触发阈值**,同上) | ✅ 降级成 `BoundedSummary` |
| **每客户端 outbound 队列** | **32 MiB**(按下发 SSE 帧的 UTF-8 字节计;心跳不计入) | ⚠️ 发一帧 `viz:overflow` 后 `res.end()` 断开(§10.4),**绝不静默丢事件** |

**允许降级的只有 §3.4 那四个字段。其余一律保持原类型。**

⚠️ **`maxTurns = 20` 这个数就是 `node:settled` 有界的全部理由,不是一个"够用就行"的手感值。** 轮数无上限 ⇒ 内联的 `turns[]` 无上限 ⇒ 顶穿 §2.1 的 1 MiB 行上限 ⇒ 那条 `node:settled` 被转 `recording-failed`,而页面就此合成一个**假的 `abandoned`**。**超过 20 轮是响亮的 `UsageError`,不是静默截断**(下同)——同 `declaredDeps` 那条:用户写的东西宁可当场拒,不许悄悄改掉他的意思。

⚠️ **`node:progress.status` 与 `lastEvent.at` 与 `lastEvent.type` 同档(200 字节),理由也相同**:三者都是**后端原样给的字符串**,形状没有任何约束。漏掉其中任何一个,§6 开头那句"每一个自由字符串都有上限"与 §7 的有界化不变式就都不成立了。

### 6.1 数值域(**每个 `number` 都要有,不是只有字符串需要**)

| 字段 | 域 |
|---|---|
| `seq` / `nodeSeq` / `atSeq` / `lastGoodOffset` | **非负安全整数**(`Number.isSafeInteger(x) && x >= 0`) |
| `n`(attempt 序号) | `Number.isSafeInteger(x) && x >= 1`(**1-based**,`0` 非法) |
| `ts` / `owner-final.endedAt` | 非负安全整数(epoch 毫秒) |
| `queuedMs` / `durationMs`(节点级与轮级两处) | **非负整数**(取整;由单调时钟测得) |
| `node:turn.timeoutMs` | `Number.isSafeInteger(x) && x >= 1`(**正数**,源码 `<= 0` 当场 `UsageError`) |
| `node:turn.reask` | **只能是 `0` 或 `1`** |
| `charCount` / `byteCount` / `totalBytes` / `omittedBytes` | 非负安全整数 |
| `contextUsage.tokens` | **有限**非负数(`Number.isFinite`;允许小数) |
| `maxConcurrent` | `Number.isSafeInteger(x) && x >= 1` |
| `run:final.counts` 的九个值 | 非负安全整数 |

⚠️ **`NaN` 与 `Infinity` 一律在写盘前拦下,转 `recording-failed`,不许放行。**
`JSON.stringify` 会把它们**静默变成 `null`**——于是页面上"未知"、"0"、"没测到"三种截然不同的事实长得一模一样。**这类静默降级是本设计的头号敌人**:它不报错、不留痕,而且看起来像一个正常的答案。

⚠️ 只写 `number` 而不给域,等于允许负数、小数、超安全整数(`2^53` 以上的整数在 JSON round-trip 后会**变值**)。`seq` 一旦变值,§2 那条稠密性自查就会把好记录判成损坏。

---

## 7. 有界化不变式(**写盘前的最后一道**)

> **除 `node:progress` 外:字段级有界化之后,schema 里实际存在的字段一个都不能少;只有语义上标 `?` 的字段可以缺席。若一条完整的、已经有界化的事件仍然超过行上限,说明是 §6 的上限本身定失算了——这时转 `recording-failed`,而不是砍字段。**

三条推论:

1. **只有 `node:progress` 可以整条丢**(丢一条无所谓,下一条 5 秒后就来)。**其余任何事件都不许因为超长被丢弃或被砍字段。**
2. **连有界骨架都还超限**(病态输入)→ **转 `recording-failed`**,**绝不静默丢行**。静默丢是这套设计里最坏的失败方式:**它会伪装成"本来就没有"。**
3. **结构字段超限也走 `recording-failed`**,不许悄悄换成 `BoundedSummary`(§3.4)。

**为什么必须是不变式而不是"哪些字段重要"的清单**:历轮复审每一次列清单都会漏掉一批(`execution`、`outcome`、`counts`、`inputSha256`、`rejectedReason` 都被漏过)。**"每轮重新猜哪些小字段可以牺牲"这件事本身就是缺陷源。** §6 已经给每个字段、每个数组、每个资产、`turns[]` 与每轮的 `attempts[]` 都定了上限,所以"完整事件"天然有界,不需要再挑一遍。

**三条最容易被砍错的**:

- **资产的 `ref` 必须和 `state` 一起在**(`{state:"present"}` 却没有 `ref`,页面知道"东西在"却**点不开**,等于没有);
- **`scene` 容器保的是整个 `files` map**(它本身没有 ref/sha——三个子文件各自有);
- **`turns[]` 不许"只留最后几轮"**。它是 `node:settled` 里唯一会随用法变长的东西,于是也最容易被想成"截一下无所谓"。**截掉的每一轮都会在页面上表现成"这段对话本来就只有 K 轮"**——又一次"静默截断伪装成本来就没有"。真超限就整条转 `recording-failed`(那是**响亮的**),不许砍。

#### `node:settled` 到底能有多大(**算给你看,别凭感觉**)

`maxTurns = 20`、每轮 ≤2 次尝试 ⇒ **`turns[]` ≤20 项、`attempts` 合计 ≤40 项**。

**这里给的是实测值,不是估算** —— 历轮按"每项 attempt ≈3.5 KiB、每轮 ≈1 KiB ⇒ 合计约 200 KiB、余量 5 倍"算过一次,**那个数是错的**:它把**字符数当字节数**,而 JSON 序列化要转义 —— 一个控制字符会被转义成**六个字符**的 unicode 转义序列(**1 字节 → 6 字节**),引号与反斜杠各变 2 字节。`rejectedReason` 是**给人读的错误正文**,里面完全可以全是控制字符,**光这一项就低估约 3 倍**。

| 项 | 最坏字节数 |
|---|---|
| 一条塞满的 `node:settled`(20 轮 × 2 次尝试,`rejectedReason` 用允许的控制字符填满 40 项) | **实测 658,772**(第 3 轮复审跑出来的数) |
| `turns[].inferredDeps`(20 轮 × 20 项 × 200 字节,§5.8 / §6) | **≈ 80,000** |
| 合计 | **≈ 740 KB** |

**结论仍成立**:740 KB < §2.1 那条 **1 MiB = 1,048,576 字节**。**但余量只有约 1.4 倍,不是 5 倍。**

⚠️ **后来人加字段时要看到的是这个 1.4,不是那个 5。** 三条上限(`maxTurns = 20`、每轮 ≤2 次尝试、`turns[].inferredDeps` ≤20 项)**都是有界性论证的地基**:动其中任何一个、或往 `TurnSummary` / `attempts[]` 里加任何新字段,都必须**重新按转义后的字节**算这一段。顶穿之后不是"稍微大了点",而是那条 `node:settled` 被转 `recording-failed`,页面就此合成一个**假的 `abandoned`**(§6 开头那句)。

**非终态事件同样不许整条丢**:`node:observed` 带着 spec/prompt/role 三份资产状态,`node:turn` 带着**这一轮的提问**(多轮节点里它是那句话**唯一**的公布渠道,`node:observed.prompt` 那时是 `not-applicable`),`node:attempt` 带着本次尝试的 input,`node:turn`/`node:started`/`node:workspace-*` 决定了中断时落在六档 `abandoned` 的哪一档,`node:turn-settled` 是那一轮产出与现场唯一的公布渠道。**这些一旦没进 transcript,"从文件完整回放"也回放不出来**——那正是无 manifest 方案的地基。

---

## 8. 控制通道(父子之间那条生命管道)

**这不是 transcript,是 `withBridge`(父)与 viewer(子)之间的那条生命管道。** transcript 写不下去之后,它是唯一还能说话的通道。

- **传输**:优先用 Node 的 **IPC 通道**(`fork` 自带,天然是消息边界)。若改用字节流,则**必须是 UTF-8 NDJSON 并缓冲到完整换行再解析**——半条消息与粘包在这里和 transcript 的半行是同一类问题。
- **管道 EOF ⟺ owner 结束**(§10.2)。这条管道必须由 `withBridge` 自己在收尾时**显式关闭**,不能等整个 Node 进程退出——同一个脚本顺序跑多波时,第一波的 viewer 会**永远等不到 EOF**。
- **只有两种消息**,各**只发一次**;viewer 各存**一槽**,只记第一条。
- ⚠️ **每条消息必须带判别字段 `kind`**,取值就是消息名。少了它,viewer 收到一个对象**根本不知道自己收到的是哪一种**——两种消息的字段集不相交,靠"有没有 `atSeq`"去猜是把判别联合退化成结构探测,加第三种消息的那天就会静默错判。完整 wire 形状:

```js
{ kind: "recording-failed", atSeq, lastGoodOffset, error }   // error: string | BoundedSummary
{ kind: "owner-final",      result, endedAt }                 // result: "completed" | "failed"
```

### 8.1 `recording-failed`

**何时**:transcript writer **首次**损坏(`append()` 返回 0 / 抛错 / 中途失败;**`run:final` 自己写失败也算**)。

```js
{ kind: "recording-failed", atSeq, lastGoodOffset, error }
```

| 字段 | 类型 | 可空 | 含义 |
|---|---|---|---|
| `kind` | string | 否 | 恒为 `"recording-failed"` |
| `atSeq` | number | 否 | **写失败的那一条事件的 `seq`**。消费方的过滤合同是 **`seq < atSeq`**:记录都从 N 断了,之后的东西不该以"正常事件"的身份出现 |
| `lastGoodOffset` | number | 否 | 见下 |
| `error` | string \| `BoundedSummary` | 否 | 失败原因。≤2 KiB |

#### `lastGoodOffset` 的精确定义(**它是两条通道之间唯一的排序依据**)

> **`lastGoodOffset` = transcript 文件里「最后一个完整换行之后」的排他字节偏移**——即 `[0, lastGoodOffset)` 这段字节**全部是完整的行**。

**writer 侧两条:**

1. 它**只在一整行(含 `\n`)的全部字节都写完时一次性推进**,由**累加已写字节**维护。
2. ⚠️ **短写之后,物理 EOF 会比它大,但绝不许推进它;失败时更不许拿 `stat().size` 去重算**——那正好会把半行算进"可信边界",而这套设计里所有关于"末尾半行"的处理都建立在"可信边界只到完整行"上。

**为什么需要它**:控制消息走 IPC(**立刻到**),而正常事件靠 viewer 每 500ms tail 文件(**慢一拍**)。于是有一条**必现**的错误时序:

1. writer 成功写入 `seq=11 node:settled`(**字节已经在盘上**);
2. viewer 的下一次 poll 还没发生,它**根本不知道有 seq 11**;
3. writer 写 `seq=12 run:final` 失败 → IPC 立刻送来 `recording-failed{atSeq:12}` + `owner-final`;
4. viewer 此刻缓冲区是空的,于是**直接公布控制状态**;
5. 下一次 poll 才读到 seq 11 —— **终态控制消息排到了更早的正常事件前面**。

**viewer 侧四条:**

1. **全局只有一个 tail reader**,它独占 `bytesRead` / `pendingBuf` / decoder 三样状态。
2. 收到 `recording-failed` **不是另起一个 reader 去 drain**,而是**把那个唯一 reader 的 `targetOffset` 提到 `lastGoodOffset` 并 await 它**。⚠️ 两个 reader 同时从旧偏移读,会**重复广播**、会把 decoder 的**多字节字符拼坏**——这是确定的竞态。
3. 已经预读进来、位置 **> `lastGoodOffset`** 的字节**全部丢弃,永不解析**(那正是那半行)。
4. **drain 自己失败也必须有出口**:进入「历史读取失败」态,**然后照样公开 `recordingFailure` / `ownerFinal`**。⚠️ **不能因为 drain 失败就永远不公开控制槽**——那样页面会一直假装"还在运行中"。

**为什么不选"writer 每写一条就报一次 `transcript-advanced{endOffset}`"**:那等于把整条事件流在控制通道上再走一遍(**第二个真理源**),还把控制通道从"两条消息"变成高频流。**损坏是一次性事件**,只在那一刻需要一个偏移量。

### 8.2 `owner-final`

**何时**:transcript **已经坏了**、但父进程**完成了受控收尾**。必须在**关管道之前完整写出**(完整消息先于 EOF)。

```js
{ kind: "owner-final", result, endedAt }
```

| 字段 | 类型 | 可空 | 含义 |
|---|---|---|---|
| `kind` | string | 否 | 恒为 `"owner-final"` |
| `result` | string | 否 | `"completed"` \| `"failed"`,判据与 `run:final.result` 完全相同(§5.10) |
| `endedAt` | number | 否 | 收尾时刻,**epoch 毫秒**(与信封 `ts` 同口径,见 §2) |

**为什么必须有它**:只发 `recording-failed` 只解决了一半——writer 一旦坏了,`run:final` 就再也写不进 transcript,于是「**坏了之后正常收场**」与「**坏了之后又被强杀**」在 viewer 眼里长得一模一样(都是 `recording-failed` + EOF + 没有 final)。

### 8.3 收尾的可观测时序(**十步,顺序不能换**)

下面列的是**收尾期间外部能看见的每一个动作及其先后**——落盘的字节、管道上的消息、管道的 EOF、调用方拿到的异常。
(`node-core` 内部怎么持有 in-flight promise、用什么结构登记、怎么移除,按 §0.1 不在这里。)

| # | 动作 | 为什么它是可观测的 |
|---|---|---|
| 1 | **封住 admission**:此后**任何节点级调用**一律**返回 rejected Promise**(不是同步抛),**且不产生任何事件**——`runNode(bridge, spec)` / `bridge.runNode(spec)` / `conversation(bridge, spec, fn)` / `bridge.conversation(spec, fn)` **四条公开路径都要堵**(§4) | 少堵一条,就会有事件排在 `run:final` 之后 |
| 2 | **排空在途节点**,循环到集合为空 | ⚠️ **这是"每个已 observed 的节点都有一个终态事件"的唯一来源**,也是 §5.10 那条恒等式成立的前提 |
| 3 | `bridge.close()` | 它的成败进第 4 步 |
| 4 | **定 `run:final.result`**:**只看三件事**——回调抛没抛 / 回调返回且 close 成功 / close 失败。**永不看节点回执**(§5.10) | 结论本身就是要发出去的字节 |
| 5 | **写 `run:final` 并确认落盘** | `await append(final)` 成功**就是**确认落盘(§1.2 的四条合同),**不需要第二个 flush 概念** |
| 6 | 第 5 步失败(或 writer 早已损坏)→ 发 `recording-failed`(若还没发过),并**准备好 `owner-final`** | 这一步整条漏掉,就会出现"记录坏了却什么都没说" |
| 7 | **关事件 writer**。`close()` **对外 non-throwing**,错误只累积进诊断 | ⚠️ **它不再宣布 recording failure**——viewer 的判定第 1 档是"transcript 里有 `run:final` 就按它算",所以"关 fd 失败也转 `recording-failed`"这条分支**永远显示不出来**,对应验收还是假绿。**关 fd 失败只是清理诊断** |
| 8 | **关生命管道——无条件。** 关之前:**若** writer 已损坏(第 6 步准备了 `owner-final`),**必须先把它完整写进管道**,写完再关;writer 健康则不发 `owner-final`,**直接关**。 | ⚠️ **两件事的条件性不一样,分开记:发 `owner-final` 是条件性的,关管道是无条件的。** 把"关管道"写进"writer 已损坏"的分支里,健康路径就**永远不关管道**——那与 §8 那条"每次收尾必须由 `withBridge` 显式关闭"直接打架,后果是同一个脚本顺序跑多波时,第一波的 viewer **永远等不到 EOF**、`ownerEnded` 永远为 false(§10.2)、进程赖着不走。<br>而**有** `owner-final` 时**完整消息必须先于 EOF**:反过来 viewer 就只剩"EOF 且没有 final",落到第 4 档(§10.1),把一次受控收场显示成事故 |
| 9 | 删掉本次 run 的临时目录 | ⚠️ **它排在关管道之后是有意的**:`owner-final` 的语义是「桥与记录器的生命周期已经结束」,清理属于其后的 **best-effort 收尾**,清不掉也不改变任何结论。**页面不得把 `owner-final` 读成"临时文件已经清干净了"**(强杀时它本来就可能残留) |
| 10 | **原样重抛回调的原始异常** | ⚠️ **优先于排空与 close 的诊断**——那些是次生错误,盖掉死因就等于把真正的失败原因从调用方眼前拿走 |

⚠️ **第 5～8 步顺序敏感,不能合并成一句"收尾"**——历轮设计正是把它们挤成一步,结果"发 `recording-failed`"与"补发 `owner-final`"**双双漏掉**,于是「记录坏了之后受控收场」这条路在页面上完全无法与强杀区分。

⚠️ **第 8 步只有一个动作是无条件的:关管道。** 按上表施工,两条路都必须走到 EOF:

```
writer 健康  → (不发 owner-final) → 关管道 → EOF
writer 损坏  →  完整发 owner-final → 关管道 → EOF
```

**任何一条路走不到 EOF,就是把"判活只有一条合同 = 生命管道"(§10.9 第 1 条)这件事从根上废掉。**

⚠️ **`controlRevision` 是 viewer 进程内部的计数器,不是 wire 字段**——它既不进 transcript,也不进 SSE,更不在控制消息里。

---

## 9. 顺序保证(**很多消费逻辑依赖它**)

### 9.1 全局

1. **`run:started` 是第一条,`seq === 0`**——viz 初始化做完之后、用户回调之前。
2. **`run:final` 是最后一条**;它之前,**每个已 observed 的节点都已经有终态**(`node:settled` 或 `node:rejected`)——收尾先封 admission、再排空到集合为空,然后才 `bridge.close()`(§8.3 第 1~3 步)。
   ⚠️ **这个"排空"只是生命周期屏障,不参与业务判定**(§5.10)。
3. **`seq` 从 0 起、步长 1、稠密**;消费方按 `seq` 去重(SSE 断线重连是一次**全量回放**,不去重会让计数翻倍、时间轴重影),并按 §2 那条稠密性自查记录完整性。
4. **先原子写成功归档文件,再发引用它的事件**(§1.3)。

### 9.2 单个节点(同一 `nodeSeq`)

**这张图覆盖全部合法前缀。** 中断可以停在任何一格,但**不许出现图上没有的转移**。

```
node:observed
  │
  ├─→ node:rejected{phase:"lock"}             ← 并发撞车 / 锁文件已存在 / 建锁 I/O 失败
  ├─→ node:rejected{phase:"preflight"}        ← 第一次仓库体检与脏树闸        [write only]
  ├─→ node:rejected{phase:"reuse-check"}      ← 复用闸 / 回放闸逐项核对不过
  ├─→ node:rejected{phase:"zero-turn"}        ← 回调**从未调用** turn()(turnCalls === 0,一条轮事件都没有)
  ├─→ node:rejected{phase:"turn-validation"}  ← turnCalls > 0 但 turns[] 仍为空:每次 turn() 都当场被拒
  │                                             (参数不合法**或**用法不允许:并发/来晚/毒化后/超 20 轮;
  │                                              **那几次调用一个事件都没发**,回调吞没吞异常都算)
  ├─→ node:settled{execution:"reused"}        ← 复用命中(**不发任何 turn / started / attempt / progress**)
  │
  ├─→ ⟨没起来的轮段⟩⁺ → node:rejected{phase:"preflight" | "workspace-setup" | "turn-validation"}
  │                                            ← 一轮都没跑起来 ⇒ 不写回执(§5.3)
  │
  └─→ ⟨没起来的轮段⟩* → ⟨轮段(key₁)⟩ → ⟨轮段(keyᵢ)⟩* → node:settled
                                               (**`turns[]` 里 1 ≤ 轮数 ≤ 20**;"没起来的轮"不计入)

⟨没起来的轮段(key)⟩ =                          [write only,**只可能在第一轮真的跑起来之前**]
  node:turn(key) → node:started(key)
    │
    ├─→ node:turn-settled(key){status:"not-started"}          ← **第二次**脏树检查 / 算分支名 / 清残留失败
    │                                                           (**还没发 intent**)
    └─→ node:workspace-intent
          └─→ node:turn-settled(key){status:"not-started"}     ← `git worktree add` 失败

⟨轮段(key)⟩ =
  node:turn(key) → node:started(key)
    │
    ├─→ node:workspace-intent                        [write only,**只在入场还没成功过时**]
    │     └─→ node:workspace-created → ⟨尝试段⟩ → node:turn-settled(key)
    │
    └─→ ⟨尝试段⟩ → node:turn-settled(key)      [read 节点、以及**第二轮起的每一轮**走这条]

⟨尝试段⟩ = ε
         | node:attempt(1) → node:progress* → node:attempt-settled(1)
             [ → node:attempt(2) → node:progress* → node:attempt-settled(2) ]
```

⚠️ **`⟨尝试段⟩` 的文法只有这两条路,`attempt(2)` 不能独立出现。** 把两次尝试各自标成可选(`(…1…)? → (…2…)?`)在形式上允许「只有 attempt 2、没有 attempt 1」——那条路**不存在**,而一个照着文法写的 viewer 会为它准备分支、甚至把它当成合法输入渲染出来。**`n` 是本轮内从 1 开始的连续序号,没有 1 就没有 2。**

⚠️ **`⟨尝试段⟩` 整段可以是空的(`ε`)**:`open_session` 失败时尝试循环根本没进,该轮 `attempts: []`,**一条 attempt 事件都不发**,直接 `node:turn-settled`(§5.6)。⚠️ 但**那一轮的 `node:turn` 与 `node:turn-settled` 照发**——"这一轮开了口但一个字都没发出去"必须能看见。

⚠️ **`⟨没起来的轮段⟩` 有开头也有结尾,结尾就是 `node:turn-settled{status:"not-started"}`**(§5.4)。入场那两关(第二次脏树复查、`workspace-setup`)拦下时,那一轮当场被这条终态闭合;节点则要等到**它确实结束的那一刻**才发 `node:rejected`(§5.3)。**页面必须能画一条"没能开始的轮"**——它不是"结果不明"的轮,它的结论是确定的。
⚠️ **它只可能出现在第一个真的跑起来的轮段之前**:入场(建工作树、开会话)懒挂在"第一轮"上,前一轮没起来 ⇒ 下一轮**仍然**背着入场段,所以可以连着好几条;而一旦有一轮真的跑起来过,工作树与会话都已经就位,后面的轮**再没有会抛 `UsageError` 的入场关**。
⚠️ **`turns[]` 里没有它们**(§5.8),所以「事件流里 5 条 `node:turn`、`turns[]` 里 3 项」是**合法记录**,不是空洞——这一点 §5.3 / §5.8 / §10.8 三处都写了,页面按 `node:turn-settled.status` 分辨。

⚠️ **`node:workspace-*` 只出现在"入场还没成功过"的那些轮段里**:N 轮共享一棵工作树、一条分支,**真的跑起来一轮之后就再也不建了**。所以**第二轮(指 `turns[]` 里的第二轮)起,`node:started` 之后直接就是 `node:attempt`。**
⚠️ **`node:workspace-intent` 可以出现多于一条,`node:workspace-created` 至多一条**:每一次入场尝试各发一条 `intent`(`git worktree add` 失败 → 那一轮 `not-started` → 回调换个 key 再试 → 又一条 `intent`,而且 `branch`/`path` 可能与上一条不同,因为分支名是重新算的);而 `created` 一旦发出,那一轮就**不会**是 `not-started`(工作树建成之后的失败都是业务结局,不是 `UsageError`),于是也不会有下一次建树。**页面凡是要用工作副本路径的地方,一律取最后一条 `intent`。**

⚠️ **`node:rejected` 不是只能紧跟在 `node:observed` 后面**——它可以出现在 `node:turn-settled{status:"not-started"}` 之后,也可以出现在**一串这样的轮段之后**(回调接住了那个 `UsageError` 又换个 key 起了一轮,还是没入场成功)。把生命周期图画成"observed 之后要么 rejected 要么往下走",实现者会照着写出一个**跑不到那几种真实路径**的 viewer,而那些路径全都有源码可核。
⚠️ **反过来,`node:rejected` 绝不会出现在一个「真的跑起来过的」`⟨轮段⟩` 之后**(判据:该轮 `node:turn-settled.status !== "not-started"`)。理由:入场只发生在第一轮(建工作树、开会话都挂在它上面),只要有一轮真的跑起来过,后面就再没有会抛 `UsageError` 的**入场**关了。⚠️ **但"再没有 `UsageError`"是不对的**——后面某次 `turn()` 照样可能当场被拒(key 重复、`timeoutMs` 不合法、并发、毒化后、超 20 轮…)。**那时节点已经有 `turns[]`、会写回执,所以它以 `node:settled` 收场**,那个异常表现为顶层 `status:"callback_error"`(§5.8),**不是** `node:rejected{phase:"turn-validation"}`。**同一个 `UsageError` 落在哪一层,取决于这个节点有没有回执。**

⚠️ **`phase` 相同、位置不同,含义就不同**,页面的处置提示必须据**位置**给:
- `preflight` 出现在第一条 `node:started` **之前** → 是开跑前那次体检没过,主树本来就脏;
- `preflight` 出现在第一条 `node:started` **之后** → 是**排队期间**主树被动过,该去看这中间谁改了工作区;
- `workspace-setup` 在(最后一条)`intent` **之前** → **确定没有工作副本**,别去找;
- `workspace-setup` 在(最后一条)`intent` **之后** → `git worktree add` 试过了,**目录可能有残留**,去看那条 `intent` 给的路径;
- `turn-validation` → 与工作区、与后端都无关,去看那次 `turn()` **是怎么调的**(参数不合法,**或**用法不允许:并发 / `fn` 已返回才来 / 毒化后 / 超 20 轮)。**渲染时照抄 `error` 正文,别自己起"参数错误"这类标题**——`error` 里写着的才是真原因;⚠️ **回调把异常吞了时,`error` 是收尾合成的那句**——里面写着调了几次 `turn()`、最后一次没进去的原因,§5.3。⚠️ **它前面可以有 `⟨没起来的轮段⟩`**(先撞工作区、接住后又换个 key 撞参数),那时 `phase` 取的是**最后一次**失败的那一关。

**逐条的先后关系(全部必须守):**

- **`node:observed` 必先于该 nodeSeq 的任何其它事件**,且**不可丢、必须能从文件完整回放**——它是 `id` / `agent` / `access` / 三份输入资产的**唯一**来源。
  ⚠️ 因此它必须发在**并发撞车检查与建 `<id>.lock` 之前**:`phase:"lock"` 那三种拒绝**都发生在拿锁这一关**,而它们同样要在页面上以一个具名节点的身份出现。发晚一格,撞 id 的那次就成了一条**没有 observed 的 rejected**——`nodeSeq` 查不到任何身份信息。
- **`node:rejected` 与 `node:settled` 都是终态**:之后该 nodeSeq **不再有任何事件**,且**二者互斥**。
- **轮这一层(严格)**:`node:turn(k)` 必先于 `node:started(k)`;`node:started(k)` 必先于本轮任何 `node:attempt`;本轮任何 `node:attempt-settled` 必先于 `node:turn-settled(k)`。合起来就是那条不许打乱的链:
  **`node:turn → node:attempt → node:attempt-settled → node:turn-settled`**。
- **轮与轮之间不重叠**:`node:turn(k₂)` 必在 `node:turn-settled(k₁)` **之后**(同一时刻只许有一轮,由工具的串行闸强制,不是纪律)。**页面可以据此把一个节点的轮画成一条不交叉的序列**——它不会出现两轮并行。
- **`node:started` 必先于 `node:workspace-intent`**;`node:workspace-intent` 必先于 `node:workspace-created`;**它们只发生在"入场还没成功过"的轮段内**(可能有多条 `intent`、至多一条 `created`,见上)。
- **`node:attempt(turnKey, n)` 必先于 `node:attempt-settled(turnKey, n)`**;同一轮内 `node:attempt(n+1)` 必在 `node:attempt-settled(n)` **之后**。⚠️ **跨轮不比较 `n`**:第 2 轮的 `n=1` 出现在第 1 轮的 `n=2` 之后是**正常的**,那不是倒序。
- **每个已经进入某一轮 `attempts[]` 的尝试,非强杀情况下恰好发一条 `node:attempt-settled`**(四种 status 都发);**每一条 `node:turn` 非强杀情况下恰好由一条 `node:turn-settled` 闭合,没有例外**——入场失败的那一轮也有,它的 `status` 是 `"not-started"`(§5.4)。⚠️ **这条是 §5.10 那条节点级恒等式在轮这一层的对应物**:少一个终态,页面就只能把那一轮合成 `abandoned`。
- **`node:progress(turnKey, n)` 只出现在同一轮的 `node:attempt(n)` 与 `node:attempt-settled(n)` 之间**。

### 9.3 不可丢清单

**除 `node:progress` 外,全部不可丢。** 其中这几条丢了会直接让页面撒谎:

| 事件 | 丢了会怎样 |
|---|---|
| `node:observed` | 该节点的 `id`/`agent`/`access` 与三份输入**永久消失**,而后续事件只有 `nodeSeq` |
| `node:rejected` | 一次干净利落的本地拒绝被合成成 `abandoned`(「结局不明、现场可能还在」)——**把拒绝显示成事故** |
| `node:turn` | **多轮节点里它是那一轮提问的唯一公布渠道**(节点级 `prompt` 是 `not-applicable`),丢了这一轮就成了一段"没有问题的回答";而且时间轴上会少掉一整轮,**看起来像这个节点只聊过 N−1 次** |
| `node:workspace-intent` / `-created` | 中断时分不出「确定还没建」与「可能建了、位置未确认」,用户会去找一个**可以证明不存在**的目录 |
| `node:attempt-settled` | 强杀时它是该次尝试产出**唯一**的公布渠道 |
| `node:turn-settled` | 强杀时它是**那一轮**产出与**现场**唯一的公布渠道(`node:settled.turns[]` 永远不会来了);丢了,一轮已经完成的对话看起来像"卡在中间"。⚠️ **`status:"not-started"` 那一条同样不可丢**:它是那一轮**唯一**的终态(那一轮压根不进 `turns[]`),丢了就是一条永远悬着的轮 |
| `node:settled` / `run:final` | 直接合成假 `abandoned` / 假"运行被掐断" |

---

## 10. 消费约定(给 viewer)

### 10.1 四档判定优先级(**按顺序取第一个匹配**)

| # | 条件 | 结论 |
|---|---|---|
| 1 | transcript 里有 `run:final` | **按 transcript 说的算** |
| 2 | `recording-failed` + `owner-final` | **受控结束,但观测记录损坏** |
| 3 | `recording-failed` + EOF,**没有** `owner-final` | **观测损坏,且 owner 也丢了** |
| 4 | 以上都没有、EOF 前也没 final | **「未观测到正常收尾」** |

⚠️ **第 2、3 档不得共用同一句文案。**

⚠️ **表里的「EOF」对页面来说是一条 `control{kind:"owner-lost"}`**(§10.4)——管道的另一端在 viewer 手里,页面自己看不到 EOF。**它与 `owner-final` 是两条不同的帧,不许在消费侧归并成一个布尔**:归并之后第 2、3 档必然共用同一句文案,而那正是上一条禁止的事。

⚠️ **第 4 档的措辞要留余地**:它**绝大多数**情况确实是强杀,但**两条通道同时坏掉**时 owner 其实可能有序收了场。这是一个**消不掉**的双故障——不必为它加机制(再加一条通道只是把问题挪到第三条上),但页面**不能替它下"进程一定被杀了"的结论**。

⚠️ **`recording-failed` 之后,viewer 必须整体标注「从 seq N 起记录不完整」,而不是把缺失的节点事件逐个合成 `abandoned`**——那些节点很可能好好地跑完了,只是没人记下来。**把记录故障摊派成一堆节点事故,是这个页面能犯的最有误导性的错误之一。**

⚠️ **「历史读取失败」(viewer 内部叫 `historyReadFailure`,下发到页面时是 `event: control` + `kind: "history-read-failure"`,见 §10.4)是另一回事**:`recording-failed` 是**我们写不下去**,历史读取失败是**我们读不回来**。后者**绝不能**被显示成「运行被掐断」——那是关于 owner 的结论,而出问题的是读历史这一侧,owner 可能好端端地在跑。**并且此时禁止据缺失事件推断任何节点或资产不存在。**

### 10.2 `ownerEnded` 谓词(把"owner 结束了没有"收成一处)

```
ownerEnded = 见过 run:final          (transcript)
          OR 见过 owner-final        (控制通道)
          OR 生命管道 EOF 且最终 drain **已结束**
             (成功结束,或者失败并已转成 historyReadFailure —— 两者都算结束)
```

⚠️ **第三条里"已结束"不能读成"成功完成"**:drain 允许失败。若这里要求"成功",就会出现一个**死角**——管道 EOF、没有 `run:final`、没有 `owner-final`、最终 drain 又失败:`ownerEnded` 永远为 false,于是 **viewer 永不退出**。一个读历史失败的进程赖着不走,是纯粹的资源泄漏,还谁都不报错。

**实现上只要一条**:drain 的 resolve 与 reject **汇入同一条收尾路径**——reject 先置 `historyReadFailure`,然后**照样**重算 `ownerEnded`。

⚠️ **`ownerEnded` 必须涵盖这三条**:四档收场里**有三档没有 `run:final`**(writer 坏掉后受控收尾、坏掉后被强杀、普通强杀)。

**自灭政策四条:**

| 条件 | 行为 |
|---|---|
| `ownerEnded === false` | **绝不退出**——哪怕一直没人打开页面。⚠️ **不许有"无客户端 N 分钟就退出"的兜底**:它不要求 run 已结束,于是两小时的运行只要前十分钟没人看,viewer 就在半途消失了 |
| `ownerEnded && clients.size === 0` | 起 **60 秒** grace 计时 |
| 任一客户端接入(**包括还在 `replaying` 的**) | **同步**取消 grace(取消动作必须与"把客户端登记进 `clients`"处在**同一个同步段**里) |
| 最后一个客户端断开 | 从**断开那一刻**重新起 60 秒 |

### 10.3 `abandoned` 的六种子形态(viewer 合成,**不是 status**)

`abandoned` 的正确含义是「**观测者没有看到终态**」,**不是**「结果永远拿不到了」——worktree、分支、锁、已复制的 attempt 产出**都还在**,缺的只是权威终态回执。

**判据按"该节点最后一条事件"取,并且只看下面这六格**(多轮不增加档位:轮的位置只改变**措辞里的那一句**,不改变档位):

| 中断时最后停在 | 页面必须说 |
|---|---|
| `node:observed` | 「本地准备中,还没派发」 |
| `node:turn`(还没 `node:started`) | 「**这一轮**在等名额,**一个字都还没发给 AI**」 |
| `node:started` / `node:attempt*` / `node:progress` / `node:turn-settled`(**`status !== "not-started"`**;read 节点) | 「执行结果不明」+ **只列确实落了盘的 ref**(⚠️ 现场只在**结束某一轮**时才保,强杀路径根本进不去 → 那一轮的现场三件套**可能压根不存在**,不许给死链接) |
| `node:started`(write,**没见过 intent**) | 「正在做建工作副本前的检查——**还没开始创建,不会有工作副本**」 |
| 见过 `node:workspace-intent`、**没见过 `-created`** | 「工作副本**可能**已经开始创建,**位置未确认**」+ **最后一条 `intent` 给的路径**(可能有多条,§9.2) |
| 见过 `node:workspace-created` | 「执行与代码去向都不明」+ **路径 + 分支 + 禁止自动重跑** |

⚠️ **第 4、5 格的文案必须相反,不能合并**:第 5 格说"可能有,去看看",第 4 格说"没有"。**把第 4 格并进第 5 格,就是让用户去找一个可以证明不存在的目录**;用户一旦扑空一次,第 6 格那句最不该被怀疑的话就跟着掉价。

**多轮之后必须补的四条(它们改的是措辞,不是档位):**

1. **已经收场的轮不是"没结果"**:被中断的节点里,**每一条 `node:turn-settled` 都是一份权威的轮级结局**,页面必须把它们照常列出来(产出可点开、状态照实显示),只把**最后那一轮**标成结局不明。⚠️ **把整个节点一律涂成"结果不明"是这里最容易犯的错**——一段 6 轮的对话在第 6 轮被强杀,前 5 轮的产出**明明都在盘上、也都公布过**。
2. **`node:turn` 已发、`node:started` 未发 ⟺ 这一轮在排队**,与"上一轮已经结束"并不矛盾:节点整体在跑,这一轮在等名额。
3. **最后一条是 `node:turn-settled{status:"not-started"}` 时,那一轮的结论是确定的**:页面必须说「**上一轮没能开始**」(原因就在它的 `errorSummary` 里)+「这个节点接下来做了什么不明」。⚠️ **不许拿第 3 格那句"执行结果不明"去描述那一轮**——它的结果一点都不含糊:**它没开始**。`not-started` **不新增档位**,档位仍按下一条取。
4. **第 4~6 格只看那三条 `node:workspace-*` 的有无,与停在第几轮无关**:工作副本是**节点级**的(N 轮共享一棵树),第 5 轮被中断时它早就建好了,档位当然是第 6 格。⚠️ `intent` 有多条时按**最后一条**取路径(§9.2)。

### 10.4 回放与传输(SSE)

#### SSE 的 wire 格式(**endpoint、响应头、逐字节的 framing,全部写死**)

**endpoint:`GET /events`。**

**成功响应的状态行与响应头(逐条必需):**

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

- ⚠️ **`Content-Type` 必须是 `text/event-stream`**。不是它,浏览器原生 `EventSource` **直接判错**(`onerror`),页面一个事件都收不到,而服务端日志上看起来一切正常。
- **`charset=utf-8` 与"整条响应体是 UTF-8"是同一件事**:SSE 规范本身就规定 UTF-8,这里写出来是为了让实现者别按系统默认编码写。
- `no-transform` 与 `X-Accel-Buffering: no` 挡的是中间层缓冲(有人会把 viewer 挂在反代后面),缓冲会让"实时"变成"每 4 KiB 来一批"。
- **不发 `Content-Length`**、不启用压缩。

**帧结构 —— 一个帧 = 若干行 + 一个空行,空行就是帧结束:**

```
event: tx\n
data: {"v":1,"seq":11,…}\n
\n
```

逐条写死:

1. **每一帧恰好由 `event: <名字>\n`、`data: <一行 JSON>\n`、`\n` 三部分按序拼成**,**没有 `id:`、没有 `retry:`**(重连由客户端自己发起,回放是全量的,§10.4 后半)。
2. ⚠️ **结尾那个空行(`\n\n`)是帧边界,不是可选的美观**。少了它,浏览器会一直把这一帧当成"还没写完"缓着,页面**永远**收不到任何事件——这是自己写 SSE 服务端最常见的一次性错误。
3. **`data:` 只有一行**:`data` 的值是**一行 JSON,内部不含任何换行**(transcript 本来就是一行一条,§2)。**不许**为了好看把 JSON 缩进后跨多行发。
4. **`data:` 与值之间恰好一个空格**(`data: {`)。
5. **全部按 UTF-8 编码写出**;`event` 名与 JSON 都不做任何转义之外的加工。
6. **心跳帧是 SSE 注释帧,自成一帧**:`: hb\n\n`——一个冒号、一个空格、`hb`、换行,**再一个空行**。⚠️ 注释帧**浏览器不会交给页面**,所以它**只能**用来保活、**不能承载任何语义**——这也正是 `viz:overflow` 必须是具名事件的原因。心跳**不计入**积压队列。

**四种具名帧:**

| `event:` | `data:`(一行 JSON) | 什么时候 |
|---|---|---|
| `hello` | `{"graphId":"…","v":1}` | 连上之后的**第一帧** |
| `tx` | **transcript 那一行的原始 JSON,原样一行** | 每条事件——**回放与 live 用同一种 frame** |
| `control` | 见下面的**四个**形状 | 控制槽 |
| `viz:overflow` | `{"queuedBytes":N,"limitBytes":33554432}` | 该客户端积压超限,**发完立刻 `res.end()`** |

- ⚠️ **`tx` 的 data 是原样透传**:viewer **不重新序列化、不加字段、不改键序**。它是 transcript 的搬运工,**不是第二个 writer**——一旦它自己序列化一遍,页面看到的字节就与磁盘上的不是同一份,而 `sha256` 那套对证手段全部建立在"同一份"上。
- **`event: control` 的 data 恰好是这四个形状之一,靠 `kind` 判别**(前三个与 §8 的 IPC 消息**共用同一个判别字段与同一份字段集**;`owner-lost` 是 viewer **自己**根据管道 EOF 合成的,父进程那条通道上没有它——同 `history-read-failure`):

  ```js
  { "kind": "recording-failed", "atSeq": number, "lastGoodOffset": number, "error": string | BoundedSummary }
  { "kind": "owner-final",      "result": "completed" | "failed", "endedAt": number }
  { "kind": "owner-lost" }
  { "kind": "history-read-failure", "reason": string | BoundedSummary }
  ```

  - **`owner-lost` 只有 `kind` 一个键**,意思是「**生命管道 EOF 且最终 drain 已结束,而 owner 从没说过它收场了**」。
    ⚠️ **它与 `owner-final` 互斥**:owner 有序收场时发的是 `owner-final`(带 `result`),
    这一条**只在 owner 一句话没留下就没了**时发。两者同时下发是实现 bug。
    ⚠️ **transcript 里已经有 `run:final` 时不发** —— 那一档由 transcript 自己说了算(§10.1 第 1 档),
    这一帧一个字的新信息都不带。于是**健康路径一条 control 帧都不发**,这本身是个有用的不变量:
    它等于一句「没出任何异常」。
    ⚠️ **它不是"运行失败了"**:§10.1 第 4 档的措辞留余地那一条照旧适用。

    **为什么非有它不可**:§10.1 的第 3、4 档判据里都有「EOF」这个事实,而 EOF **只有 viewer 知道**
    (它是那条生命管道的另一端)。没有这一帧,页面分不开「还在跑、暂时没消息」与「跑完了、就是没有 final」,
    只能一直显示"运行中" —— **一次被强杀的运行会永远装作还活着**。
    ⚠️ **消费方不许把它与 `owner-final` 归并成一个布尔**:归并之后第 2、3 档就共用同一句文案了,
    而 §10.1 明令两档不得共用。

  - `history-read-failure` **只有 `kind` 与 `reason` 两个键,都恒在**;`reason` 是 **`string | BoundedSummary`**,阈值 2 KiB:**超过 2 KiB 才降级,`≤2 KiB` 必须原样留字符串**(§3.3 第 1、4 条;§3.4 第四个可降级字段——它与另外两条控制消息的 `error` **同档同阈值**)。⚠️ **这里的口径必须与 §3.3 逐字一致**:写成"≤2 KiB 触发降级"会让两个实现对 `"EACCES"` 这种短正文一个发字符串、一个发对象。它是 **viewer 自己的读侧故障**,父进程管道上没有这种消息(§10.1)。
  - ⚠️ **`history-read-failure` 不是 `recording-failed`**:前者是"我们读不回来",后者是"我们写不下去"。**两条文案不许共用**,更不许把前者显示成「运行被掐断」——owner 可能好端端地在跑。
- **`viz:overflow` 的数值域**:`queuedBytes` 与 `limitBytes` 都是**非负安全整数**(§6.1 同一套规矩),`limitBytes` 恒为 `33554432`(32 MiB),`queuedBytes` 是**发这一帧那一刻**该客户端 outbound 队列里已排队的 SSE 帧字节数(按 UTF-8 计,心跳不计入),满足 `queuedBytes > limitBytes`。⚠️ **它是传输层的具名 SSE 事件,不进 transcript**,与 §4 的 13 种事件不是一回事。
- ⚠️ **队列上限之外要给 `viz:overflow` 预留余量**,否则"超限时发一帧"这件事自己就发不出去,页面看到的只有一次无声的断开。

**新 SSE 连接直接从 transcript 文件完整回放**(全局内存历史数组**不存在**,它不承担任何正确性职责)。**每客户端 replay buffer,五步:**

1. 捕获**最后一个完整换行**的 `cutOffset`;
2. 把该客户端登记为 `replaying`,并开始缓存所有 `endOffset > cutOffset` 的 live 事件。⚠️ **第 1、2 步之间不得让出事件循环**(不能有 `await`);
3. **异步流式**读 `[0, cutOffset)` 下发,**遵守 SSE 背压**(`res.write()` 返回 false 就等 `drain`)。⚠️ **不许同步整文件读**:本文件只封了每行 1 MiB,**从没封过 transcript 的总行数或总字节**;
4. 回放结束 → **先按 `seq` 去重冲刷缓存** → **再补发当前控制槽**(顺序不能反:否则客户端会先看到"记录损坏、运行已结束",然后才看到更早的事件);
5. 在**同一个事件循环 turn 内**转 live。

配套:

- 已知损坏时,新连接的 `cutOffset` 取 **`min(最后完整换行, lastGoodOffset)`**;
- 冲刷出去的事件必须满足 **`seq < recordingFailure.atSeq`**;
- 控制槽固定按 **`recordingFailure` → `ownerFinal`** 的顺序发;
- **每个新 SSE 客户端的下发顺序固定**:先 transcript 回放 → **再补发当前控制状态** → 才进 live。**少了中间这一步,刷新一次页面就把"记录已损坏"忘了**;
- **每客户端一条 outbound 队列(回放缓存与 live 积压是同一条),上限 32 MiB**(按下发 SSE 帧的 UTF-8 字节计,**不能按条数**——单行上限 1 MiB,一万条就是 10 GiB;心跳不计入,事件与控制消息都计入)。超限的动作是 **`res.end()` 断开让它重连**,**绝不静默丢事件**;
- 断开**之前**发一条 **`event: viz:overflow` 的具名 SSE 事件**(有界 data),让页面显示成"数据太快,正在重连"而不是"服务停了"。⚠️ **不能用 SSE 注释帧**(`:` 开头的帧规范上就是保活用的,**浏览器根本不把它交给页面**);队列上限之外要**预留这一帧的余量**。
  ⚠️ `viz:overflow` 是**传输层的具名 SSE 事件,不进 transcript**,与 §4 的 13 种事件不是一回事。

### 10.5 `/file` 的范围与 wire 格式

**`GET /file?ref=<相对 out-dir 的路径>`**(`ref` 按 URL query 规则百分号编码;服务端先解码再做下面的检查)。

**放行判据(顺序不能换):**

- 事件里的 `ref` 写成**相对 out-dir** 的形式(好读),但**服务端只接受 `nodes/.runs/<当前 graphId>/` 前缀**;
- 词法检查(**拒绝绝对路径、拒绝 `..`**)之后**再用 `realpath` 确认真实目标仍在当前 graph 的归档根内**(挡符号链接逃逸);
- **拒绝目录**,只放行普通文件(这正是 `scene` 必须是容器、每个子文件各自带 ref 的原因);
- ⚠️ **收到 out-dir 就不够**:graph 的 outDir 是**调用方给的任意目录**,可能是仓库根或 `repo/src`,那时 `/file?ref=.env` 是一个"没有绝对路径、没有 `..`、确实在 out-dir 内"的合法请求。

**200 响应体 = 那个文件**此刻**的原始字节,一个字节不多、一个字节不少。**

```
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: <本次响应体的字节数 = 读到的那份字节数>
X-Graph-Sha256: <本次响应体那份字节的 SHA-256,hex64>
X-Content-Type-Options: nosniff
Cache-Control: no-store
```

- ⚠️ **不是 JSON 包装。** 没有 `{"content":…}` 这一层——页面拿到的就是文件本身,于是**页面可以直接对响应体算 SHA-256 与事件里的 `sha256` 对证**。包一层 JSON 就等于让 viewer 变成第二个 writer(要转义、要选编码),那套对证手段当场失效。
- **`Content-Type` 对所有放行的文件都是 `text/plain; charset=utf-8`**(归档里只有 `.md` / `.json` / `.diff` / `.txt` / `.log` 五种,全是 UTF-8 文本)。⚠️ **绝不按扩展名回 `text/html`**,那会让模型写的字节在浏览器里当页面执行(§10.6 第 2 条)。`nosniff` 是同一件事的第二道闸。
- **`Content-Length` 必须给,它是**本次响应体**的字节数,不是事件里那个 `byteCount`。** ⚠️ **这两个数可能对不上**——归档区理论上不可变,但它就在磁盘上,谁都可能改;要求 `Content-Length` 等于事件里记的 `byteCount`,文件一被改就**不存在任何合法 HTTP 响应**了(要么响应头撒谎,要么服务端只能拒绝服务一份确实存在的文件)。**零字节文件照常 200,`Content-Length: 0`**(空产出是合法的 `present`,§3.1)。
- **判别"我拿到的不是当初那份"由 `X-Graph-Sha256` 承担(定死):**
  - 服务端**先把字节读进内存,再按这份内存里的字节同时算出 `Content-Length` 与 `X-Graph-Sha256`,然后才开始发**。⚠️ 不许"`stat` 拿长度、再流式读发":那两步之间文件仍可能被改,于是响应头描述的和响应体发出的是两份不同的字节——这正是本条要消灭的东西。
  - **页面必须比对 `X-Graph-Sha256` 与事件里那个 `sha256`**;不等时显示「**这不是事件记录的那一份(文件已被改动)**」,**不许静默显示**。⚠️ **不许因此判 4xx/5xx**:文件确实在、也确实读到了,拒绝服务只会让人以为文件丢了。
  - 它也是 **`HEAD` 唯一有用的产出**:没有响应体可算指纹时,这个头就是"还是不是当初那份"的答案。
  - ⚠️ 页面**也可以**自己对响应体算一遍 SHA-256 再对证(这正是响应体不做 JSON 包装的理由,见上)。两条路结论必须一致——`X-Graph-Sha256` 只是替页面省一次哈希,**不是第二个真理源**。
- **`HEAD` 与 `GET` 同样处理**(同样的检查、同样的响应头,只是不发响应体);**其它方法一律 `405`,并且必须带 `Allow: GET, HEAD`**(缺了这个头就不是一个合法的 405)。

**错误状态码(**逐档定死,页面要据此给不同文案**):**

| 码 | 什么时候 | 页面该说 |
|---|---|---|
| `400` | 缺 `ref`;`ref` 不是合法相对路径(绝对路径 / 含 `..` / 解码失败) | 「链接不合法」——这是 viewer 或页面自己的 bug |
| `403` | 词法或 `realpath` 之后**落在当前 graph 归档根之外**;目标是目录、符号链接指向根外、或不是普通文件 | 「不在本次运行的归档范围内」 |
| `404` | 检查全过,但文件**不存在** | 「文件已不在」——**注意它与事件说的 `present` 冲突,页面必须显式提示这一点**,别静默显示成空文件 |
| `405` | 方法不是 `GET` 也不是 `HEAD` | 「不支持的请求方法」——这是 viewer 或页面自己的 bug。⚠️ **响应必须带 `Allow: GET, HEAD`** |
| `500` | 读盘本身失败 | 「读取失败」 |

- **错误响应体是 `text/plain; charset=utf-8` 的一行短消息**,**不是 JSON**——它只给人看,页面按状态码分派,**不许去解析这行字**。
- ⚠️ **`403` 与 `404` 必须分开**:合成一档,一次越界尝试与一份真丢了的产出就长得一样,而这两件事的处置完全相反。

### 10.6 两条安全边界(**缺一条,上面那些收窄全都白做**)

1. **只监听 localhost。** 无鉴权**只在这个前提下**成立——一旦绑到 `0.0.0.0`,`/file` 就成了一个把本机 graph 归档(里面是完整的 prompt 明文与模型产出)对整个网段开放的服务。
2. **Markdown 渲染必须「先转义,再套受控标签」。** 归档里的每一个字节都是**模型写的**,把它当 HTML 渲染等于让模型直接往页面里注入脚本。⚠️ **`/file` 的 realpath 收窄替代不了这一条**:那道闸管的是"能读到哪些文件",这条管的是"读到的内容怎么显示"——两件互不重叠的事。

### 10.7 拓扑怎么画(`declaredDeps` / `inferredDeps` 的解析规则)

| 档 | 来源 | 画法 |
|---|---|---|
| **A 显式声明(未执行验证)** | `node:observed.declaredDeps` | 实线箭头 + tooltip「仅展示,不影响调度」 |
| **B 推断** | **三处取并集**:`node:observed.inferredDeps` ∪ 该节点每一条 `node:turn.inferredDeps` ∪ `node:settled.turns[].inferredDeps` | **虚线**箭头 + 悬浮标"推断" |
| **C 兜底** | 只有时间先后与并行关系 | 泳道时间轴,**不画箭头** |

- ⚠️ **B 档必须读三处,少读一处就有一整类节点没有推断边:**
  - 漏掉 **`node:turn`** 那一处 ⇒ **fresh 的对话节点**没有推断边:它在 `node:observed` 这一刻一个字的正文都没有(§5.2),推断边**全部**在逐轮的 `node:turn` 上——而"第 2 轮照着另一个节点的产出提问"正是这个功能的头号用法。
  - 漏掉 **`turns[].inferredDeps`** 那一处 ⇒ **复用命中的对话**没有推断边:它**一条 turn 事件都不发**(§5.9),`node:observed.inferredDeps` 又恒 `[]`,于是同一个任务只要跑第二遍(命中复用),图上的边就**整片消失**。⚠️ **这是最隐蔽的一档**:第一次跑边是全的,第二次跑边没了,而两次的节点状态都显示成功。
  - `node:observed` 那一处则是**单轮节点**的唯一来源。
- **同一条边在三处重复出现是正常的**(单轮节点的 `node:observed` / `node:turn` / `turns[]` 说的是同一份正文),按下面那条**按 `id` 去重**处理即可。⚠️ 注意 `turns[].inferredDeps` 只保留**前 20 项**(§5.8),所以它是 `node:turn` 那份的**前缀**,并集不会因此丢东西——**除非**那个节点是复用命中的(那时它是唯一来源,超出 20 项的部分确实拿不到,而 `inferredDepsTruncated` 会说出来)。
- **同一条边被多轮推出来时按 `id` 去重,画一条**;鼠标悬浮可以说明"来自第 2、4 轮",但**不许画成多条平行边**(那会让页面显得依赖比实际多)。
- **不许把 A 和 B 画成一样。** 推断有假阳/假阴,混在一起就是把猜测冒充事实。
- **两档的端点都是逻辑 `id`,而 `id` 会重复**,所以要有解析规则:目标 `id` 在本 graph 里**恰好出现 1 次** → 连向那个 `nodeSeq`;**0 次或 ≥2 次** → **不画实例边**,改标一句「依赖指向逻辑名 `x`,但实例不唯一」。**不许取"最近的那一次"**——那是一次没有依据的推断。
- **A 档不能叫"精确/确定"**:`deps` 是纯注解,用户完全可以声明「B 依赖 A」却在 `Promise.all` 里同时启动两者。若时间轴显示 B 早于 A 完成而 A→B 有声明边,页面应给**一致性警告**。
- **并发闸会伪造出"先后关系"**(B 在 A 之后跑很可能只是没名额了),所以 C 档时间轴**必须把排队区间与执行区间画成两段**,且**纯时间先后绝不能渲染成任何箭头**。
- ⚠️ **任意一处的 `inferredDepsTruncated === true` 时,页面必须说出来**(「这个节点的推断边被截断了,图上不是全部」)。**每条事件、`turns[]` 的每一项都各自计数、各自带标志**(事件级上限 200 项、`turns[]` 里 20 项,§6),所以**只要有一处为真就要说**。不说,用户看到的就是一张**看起来完整**的图。

### 10.8 由轮派生的量(**页面自己算,事件里不再重复**)

下面这些**不是** wire 字段,是**规定好的派生规则**。写在这里是为了让两个页面算出同一个数——而不是为了让谁再往事件里加字段。

| 想显示的 | 怎么算 |
|---|---|
| 「这个节点第一次开跑」 | **第一条** `node:started` 的 `ts`(⚠️ 那一轮可能是**没能开始的轮**,它照样起过钟、也照样烧了墙上时间) |
| 「这个节点聊了几轮」 | 跑完的节点:`node:settled.turns.length`;跑到一半的:**已见的 `node:turn` 条数 − 已见的 `node:turn-settled{status:"not-started"}` 条数**。⚠️ **两者算的是同一个量**(真的跑起来的轮数),因为 `turns[]` 里不含没能开始的轮(§5.8)——**别拿 `node:turn` 的原始条数去和 `turns.length` 对账,对不上不是记录损坏** |
| 「有没有轮没能开始」 | 看有没有 `node:turn-settled{status:"not-started"}`;**它们不在 `turns[]` 里**,页面要显示就只能从事件流拿(§5.4)。措辞见 §10.3 第 3 条 |
| 「哪一轮把这段对话封了口」 | **先过闸:`node:observed.prompt.state === "not-applicable"` ⟺ 这是一段对话**(§3.1)。**不是对话就没有"封口"这回事,一律不显示**——普通 `runNode` 报 `backend_failed` 时,它投影出来的 `main.sessionReusable` 就是 `false`(§5.8),无闸的派生会把一个根本不是对话的节点显示成"对话被封口"。是对话时:取 `turns[]` 里**第一个** `sessionReusable === false` 的轮;没有就是没封口。⚠️ 它**恒是最后一项**(封口之后不会再有轮),**对不上就是记录不完整**,页面按 §10.1 整体标注。⚠️ **闸只判"是不是对话",不判轮数**:只聊了一轮就被封口的对话,封口正是"为什么只有一轮"的解释(§5.4) |
| 「这一轮打回重说过吗」 | 该轮 `attempts` 里有没有 `.n === 2` 的那一项 |
| 「这个节点总共尝试了几次」 | `Σ turns[].attempts.length`(**≤40**) |
| 「轮之间等了多久 / 回调在忙什么」 | `node:turn(kᵢ₊₁).ts − node:turn-settled(kᵢ).ts`。⚠️ 这段时间**不属于任何一轮**,也**不烧任何一轮的预算**——它是编排那段 JS 自己在跑别的东西(常见是跑一个复审节点)。页面**不许**把它画进任何一轮的耗时条 |

⚠️ **一条都不许反过来"补成字段"。** 每一个都是纯函数、且输入全在事件里;塞进 wire 就多出一份必须与来源保持一致的副本,而这份文档已经因为"没有独立消费者的字段"删过 `pid` / `archiveRef` / `halt` / `BoundedSummary.name` / `node:queued` 五样了。

### 10.9 负合同(**明确不做的,别"顺手补回来"**)

下面每一条都是被明确否决过的机制。**它们不是"还没做",是"不做"**——实现者补回其中任何一条都不算增强:

1. **viewer 不写任何 pid / state 文件。** 判活只有一条合同:**生命管道**(§10.2)。留一个状态文件,最后一定会有人拿它去判活,而它与真实进程状态之间没有任何同步保证。
2. **v1 不提供"重开旧 run"的入口。** 归档就在磁盘上,但 viewer 没有独立入口,也不接受"给我看上次那个 graph"。
3. **不做跨波聚合、不做跨 out-dir 的历史聚合与多 run 对比。** 一个 `withBridge` = 一个 graph = 一份 transcript。
4. **页面只读**:不提供暂停、重跑、改参数、合分支。观测台不裁决、也不驱动业务(§5.10 同一条原则的另一面)。
5. **不给 `withBridge` 加信号处理器。** 信号处理器既无法可靠等待 git 收尾,也覆盖不了 `SIGKILL`;中断判定归**管道 EOF**,不归信号。
6. **viewer 的生命周期只依赖 per-`withBridge` 的那条生命管道**——不看进程树、不看端口、不看时钟。
7. **不给单轮节点留"没有 turn 的旧路径"。** `runNode` 产出的事件流里同样有 `node:turn{turnKey:"main"}` 与 `node:turn-settled`,归档里同样有 `turns/main/`。⚠️ **这条最容易被"优化"掉**:实现者会觉得"单轮加一层是噪声"。但两条路径意味着页面要写两套解析,而**两套解析迟早只有一套被改**——这份文档前两轮复审里一半的问题就是"某一节改了、另一节还写着旧的"。
8. **不做轮级的复用/重跑。** 复用的粒度就是**整个节点**:要么整段命中(`execution:"reused"`),要么整段拒绝。**没有"前 k 轮复用、从第 k+1 轮接着聊"**——那需要把后端会话的内部状态恢复出来,而"重放前 k 轮的文本"不等于"后端当时的内部状态"。页面上**不许**出现任何按轮重跑的入口(它也违反第 4 条)。
9. **不在事件里放 `poisonedAfter`、`turnIndex`、`attemptCount`、`turnCount` 这类派生量**(§10.8)。
10. **不为"没能开始的轮"另造事件类型。** 它由 `node:turn-settled{status:"not-started"}` 闭合(§5.4)——**「`node:turn` 与 `node:turn-settled` 一一对应」这条不变式比"少一档 status"值钱**:多一个事件类型 = 页面多一条解析路径;少一个终态 = 那一轮永远悬着,只能被合成 `abandoned`。⚠️ **反方向的"顺手优化"同样不许**:别把这种轮塞进 `turns[]` 图省事——`turns[]` 是**复用判据**,塞一条从没跑过的轮进去,下一次回放就会拿它去比对一份**根本不存在的产出**,把一张好回执判死。

⚠️ 这一节存在的理由:**规范只写"该做什么",读起来就全是缺口,而缺口看起来永远像是该补上的。** 第 1 条尤其危险——viewer 曾经写过状态文件,删掉之后若不写明,下一个人补回来时会觉得自己在修 bug;第 7 条同理,它看起来像"给单轮省一层",实际是把两条会漂的路径重新引进来。
