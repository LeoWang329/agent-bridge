/**
 * graph 作用域 —— 一个 `withBridge` = 一个 graph = 一份 transcript = 一套不可变归档。
 *
 * 这个模块负责 docs/EVENTS-graph.md §1(落盘位置、谁写、归档布局)那一节的全部落地:
 *   · canonical outDir 绑定(§1.1)
 *   · `graphId` + transcript(`wx`)+ `nodeSeq` 分配
 *   · `nodes/.runs/<graphId>/<nodeSeq>-<id>/` 每节点一份**不可变**归档(§1.3)
 *
 * ⚠️ **两条贯穿全模块的纪律**(§1.2):
 *   ① **初始化成功之后,所有 emitter 与归档写入必须是 non-throwing 的。**
 *      观测层随便抛一个异常上去就会把节点的**业务结局**改掉(`runNode` 那条路变 `unknown`;
 *      `conversation` 那条路会顺着 `turn()` 冒进用户回调,最后成 `callback_error`)。
 *      **观测层永远无权改变节点的业务结局。**
 *   ② **初始化失败**(建归档根 / 建 transcript / 起 viewer)**在用户回调之前 fail-fast**。
 *      两者不是矛盾:回调之前失败没有业务结局可改,回调之后失败有。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createEventWriter } from "./viz-events.mjs";

/** viz 写出的**每一个字节**都在这个前缀之下。
 *  ⚠️ 不是洁癖:落在 `nodes/` 之外会被 write 节点的脏树闸算成主树未提交改动,
 *  把后续**每一个** write 节点全部拦死。**没有例外** —— 漏一个文件与全漏效果一样
 *  (脏树闸只需要一条脏条目就会拦)。 */
export const RUNS_REL = "nodes/.runs";

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

/** 解析成真实路径。**跨 git 与 Node 比较路径前必须做** —— 只 `path.resolve` 挡不住
 *  符号链接、Windows 8.3 短路径这类**指向同一目录的不同写法**,那会让「同一个 outDir」
 *  这条合同在别名下静默失效。 */
function realpathSafe(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** 流式算指纹。⚠️ **不许用 `readFileSync`**:同步整文件读会冻住事件循环,
 *  而本模块所在的这条路上还有别的并发节点在 wait(理由同 node-core 的 `sha256File`)。 */
function sha256File(p) {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("error", () => resolve(null));
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** 原子写:同目录临时文件 + rename。避免崩在半路留下一个不可 parse 的归档件。 */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** `input.json` 的序列化定死:**键名字典序**、2 空格缩进、UTF-8、结尾一个换行。
 *  稳定字节才能逐字节对比、才能自己进指纹。 */
export function stableJson(obj) {
  const keys = Object.keys(obj).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = obj[k];
  return JSON.stringify(ordered, null, 2) + "\n";
}

/* ============================================================
   AssetState 构造(§3.1)
   ============================================================ */

export const NOT_APPLICABLE = Object.freeze({ state: "not-applicable" });
export const unavailable = (code) => ({ state: "unavailable", code });
const present = (ref, sha256, byteCount) => ({ state: "present", ref, sha256, byteCount });

/* ============================================================
   节点归档
   ============================================================ */

/**
 * 一个节点的不可变归档目录。
 *
 * `put*` 一律返回 **`AssetState`**,**从不抛**。这是刻意的接缝:调用方拿到的就是
 * 能直接放进事件的那个判别联合,不必自己 try/catch 再翻译一次 —— 少一层翻译就少一处
 * 「翻译错了变成静默降级」的机会。
 */
function createNodeArchive(scope, nodeSeq, id) {
  const relDir = `${RUNS_REL}/${scope.graphId}/${nodeSeq}-${id}`;
  const absDir = path.join(scope.canonicalOutDir, relDir);
  let rootFailed = null;
  try {
    ensureDir(absDir);
  } catch (e) {
    // ⚠️ 这是**该节点自己的**归档子目录建不起来,不是 graph 归档根 ——
    //    后者建不起来属于初始化失败,在用户回调之前就 fail-fast 了,根本走不到这一层。
    rootFailed = e;
  }

  /** 归档一份内容,返回它的 AssetState。 */
  async function write(rel, produce) {
    // ① 归档根就没建起来 → 每个「本次本来就该归档」的资产**各自**标 unavailable,
    //    不能只在根上标一次(否则按逐资产规则它们会被读成"本来就没有")。
    if (rootFailed) return unavailable("archive-root-failed");
    const abs = path.join(absDir, rel);
    try {
      ensureDir(path.dirname(abs));
    } catch {
      return unavailable("write-failed");
    }
    let byteCount;
    try {
      byteCount = await produce(abs);
    } catch {
      return unavailable("write-failed");
    }
    if (byteCount === null) return unavailable("source-missing");
    const sha256 = await sha256File(abs);
    // ② 拷下来了但算不出指纹 —— **不能当 present**:指纹是复用与防篡改的判据。
    if (!sha256) return unavailable("sha-failed");
    return present(`${relDir}/${rel}`, sha256, byteCount);
  }

  return {
    relDir, absDir,
    get rootFailed() { return rootFailed; },

    /** 从 canonical 区**字节直传**一份文件进归档。源头不存在 → `source-missing`。 */
    putFile(rel, srcPath) {
      return write(rel, async (abs) => {
        let st;
        try { st = fs.statSync(srcPath); } catch { return null; } // 源头就没有可拷的东西
        if (!st.isFile()) return null;
        // 字节直传:不读出来再写 —— 不改字节、不花内存、不踩 Windows 编码转换的坑。
        fs.copyFileSync(srcPath, abs);
        return st.size;
      });
    },

    /** 把一段内存里的正文落进归档(冻结的 prompt / role 走这条)。 */
    putText(rel, text) {
      return write(rel, async (abs) => {
        const buf = Buffer.from(text, "utf8");
        writeAtomic(abs, buf);
        return buf.length;
      });
    },

    /** 落一份 JSON(`input.json` / `receipt.json` 走这条)。序列化按 `stableJson` 定死。 */
    putJson(rel, obj) {
      return write(rel, async (abs) => {
        const buf = Buffer.from(stableJson(obj), "utf8");
        writeAtomic(abs, buf);
        return buf.length;
      });
    },

    /** 该轮归档目录的相对前缀(拼 `turns/<key>/...` 用)。 */
    turnRel: (key) => `turns/${key}`,
  };
}

/* ============================================================
   graph 作用域
   ============================================================ */

/**
 * 建立一个 viz graph 作用域。**在用户回调之前调用**;任何一步失败都直接抛(fail-fast)。
 *
 * @param outDir        用户给的 out-dir。会被 `ensureDir` + `realpathSafe` 之后记为 canonical。
 * @param maxConcurrent 并发名额(进 `run:started`)。
 */
export function createGraphScope({ outDir, maxConcurrent }) {
  if (!outDir || typeof outDir !== "string") {
    // `viz:true` 时 outDir **必填**。没有它就没有 canonical 可绑,后面每条 ref 都无处安放。
    throw new Error("viz:true 时必须给 outDir —— 事件里的每个 ref 都是相对它的。");
  }
  ensureDir(outDir);
  const canonicalOutDir = realpathSafe(outDir);

  // ⚠️ **不从 pid / 时间 / outDir 推导**:那三样都会重复(pid 复用、同秒启动、
  //    同一 outDir 跑两波),而重复的 graphId 意味着两个 run 的事件混进一个文件。
  let graphId, runsDir, writer;
  for (let attempt = 0; ; attempt++) {
    graphId = crypto.randomUUID();
    runsDir = path.join(canonicalOutDir, RUNS_REL, graphId);
    try {
      ensureDir(runsDir);
      writer = createEventWriter({
        file: path.join(runsDir, "transcript.jsonl"),
        graphId,
        onRecordingFailed: (info) => { onRecordingFailed(info); },
      });
      break;
    } catch (e) {
      // `wx` 撞了就重生成(实际不会发生,但这条闸是免费的)。
      if (e?.code === "EEXIST" && attempt < 3) continue;
      throw e;
    }
  }

  let nodeSeqCounter = 0;
  let recordingFailure = null;
  const listeners = new Set();

  function onRecordingFailed(info) {
    if (recordingFailure) return;
    recordingFailure = info;
    // ⚠️ recorder 一坏,后面每条 emit 都静默 no-op —— 那是**对的**(观测层无权改业务结局),
    //    但开发期看不见根因会非常难查:一条不合 schema 的事件会让整份 transcript 只剩前几行。
    //    所以留一个诊断出口。**默认关**:它是给写插桩的人用的,不是给终端用户看的。
    if (process.env.AGENT_BRIDGE_VIZ_DEBUG) {
      console.error(`[viz] 记录损坏 @seq=${info.atSeq}: ${info.error?.message ?? info.error}`);
    }
    // 控制通道(§8.1)由上层接管 —— 这里只广播,不决定怎么送出去。
    for (const fn of listeners) { try { fn(info); } catch { /* 通知失败不改这里的结局 */ } }
  }

  return {
    graphId, canonicalOutDir, runsDir,

    /** 订阅 recorder 损坏(控制通道用)。 */
    onRecordingFailed(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get recordingFailure() { return recordingFailure; },

    /**
     * 节点级入口的 outDir 闸。**必须早于任何落盘**(包括建 `<id>.lock`)——
     * 否则拒绝之前已经在别人的目录里留了垃圾。
     *
     * ⚠️ **只约束 `runNode` 是不够的**:`bridge.conversation({outDir: B}, …)` 一旦放行,
     * 归档与 transcript 就分家了,事件里那些 ref 指向另一个 out-dir,`/file` 的前缀闸
     * 必然拒掉它 —— 页面上每一份输入与产出都点不开。
     */
    assertSameOutDir(nodeOutDir, apiName) {
      const got = realpathSafe(nodeOutDir);
      if (got !== canonicalOutDir) {
        throw new Error(
          `开了 viz 的这一段里,${apiName} 的 outDir 与 withBridge 绑定的不是同一个:\n` +
          `  withBridge: ${canonicalOutDir}\n  ${apiName}:   ${got}\n` +
          `一个 withBridge = 一个 graph = 一份 transcript = 一套归档。` +
          `要跑另一个 outDir,请另起一个 withBridge。`,
        );
      }
    },

    /** 分配一个 `nodeSeq`。**从 0 起、步长 1**,与 `seq` 一样稠密 —— 空洞 = 记录损坏。
     *
     *  ⚠️ **两个节点级入口(`runNode` 与 `conversation`)共用这一个计数器**,不是各发一套号:
     *  分家会让 `(graphId, nodeSeq)` 这个主键在同一个 graph 里撞车,页面把一段对话和一个
     *  普通节点叠成同一格,而它们的归档目录名 `<nodeSeq>-<id>/` 也会互相覆盖。
     *
     *  ⚠️ **不能只用 `<id>` 当目录名**:同一个 graph 里带 `force` 顺序重跑同一个 id 是合法的。 */
    nextNodeSeq() { return nodeSeqCounter++; },

    /** 建这个节点的归档目录。 */
    archiveFor(nodeSeq, id) { return createNodeArchive({ graphId, canonicalOutDir }, nodeSeq, id); },

    /**
     * 发一条事件。**永不抛** —— 见文件头那条纪律 ①。
     * @returns Promise<boolean> 写没写成(调用方一般不看;看的话别据此改业务结局)。
     */
    async emit(event, payload) {
      try { await writer.append(event, payload); return true; }
      catch { return false; }
    },

    get seq() { return writer.seq; },

    /** ⚠️ `close()` 抛错**不等于**写失败 —— 原样交给上层(§8.3 第 6 步据此分派)。 */
    close() { writer.close(); },
  };
}
