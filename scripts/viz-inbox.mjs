/**
 * 委托会话史观测台 —— 追问的信箱轮询器(桥侧)。
 *
 * 只做一件事:轮询 `VIZ_DIR/inbox/<sessionId>/req-*.json`,把每条请求原样交给调用方注入的
 * `handler`,结果写进 `VIZ_DIR/outbox/<sessionId>/resp-<reqId>.json`。它不知道"发消息"是什么
 * ——那是 `handler` 的事,这一层只管"请求进来、回执出去"这条传输线。
 *
 * 目录的读写者各自唯一:`inbox/` 由浏览器那一侧(`viz/serve.mjs`)写、这个模块读;
 * `outbox/` 由这个模块写、`viz/serve.mjs` 读。两条目录单写者单读者,不会撞车。
 *
 * ⚠️ **inbox 请求文件在调用 `handler` 之前就先 rename 认领掉**(改名成 `.claimed-*`,不在扫描
 *    范围里),认领不到就一条都不办。`handler` 背后真正的发送动作不是幂等操作,一旦调用就不能
 *    因为"outbox 没写成功"而重放。认领失败的代价只是"这一拍不办,下一拍再试";认领成功却重复
 *    执行的代价是**重复发送**,不可接受。两者代价不对称,所以失败方向一律倒向"这次不办"。
 *    (为什么是 rename 不是 unlink,见 `processOne()` 里那段。)
 *
 * ⚠️ **零副作用**:不调用 `.start()` 就不会碰任何文件,也不会建 `inbox`/`outbox` 目录。
 * ⚠️ **non-throwing**:所有公开方法吞异常,通过 `onDiagnostic` 上报,绝不让这一层影响桥的运行结局
 *    (跟 `viz-writer.mjs` 同一条纪律)。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const INBOX_DIRNAME = "inbox";
export const OUTBOX_DIRNAME = "outbox";

/** 单条追问请求上限。打字问的,不是传文件——64 KiB 已经很宽松。 */
export const REQUEST_MAX_BYTES = 64 * 1024;

/** 单个 tick 最多处理几条,防止极端情况下一拍吃光事件循环。多出来的留到下一拍,不会丢。 */
const MAX_PER_TICK = 8;

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const REQ_FILE_RE = /^req-(.+)\.json$/;

function isSafeSegment(id) {
  return typeof id === "string" && id.length > 0 && SAFE_ID.test(id) && id !== "." && id !== "..";
}

function defaultIo() {
  return {
    readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
    readFile: (p) => fsp.readFile(p, "utf8"),
    mkdir: (p) => fsp.mkdir(p, { recursive: true }),
    writeFile: (p, data) => fsp.writeFile(p, data),
    rename: (a, b) => fsp.rename(a, b),
    unlink: (p) => fsp.unlink(p),
  };
}

function nowIso() { return new Date().toISOString(); }

/**
 * 建一个轮询器。**不自动起**——调 `.start()` 才开始轮询,`.stop()` 立刻停(O(1),无 IO)。
 *
 * @param {string} dir           VIZ_DIR(这次观测台运行的根目录)。
 * @param {(sessionId: string, message: string, meta: {reqId:string, receivedAt:string}) => Promise<any>} handler
 *        真正处理一条追问的逻辑。返回值原样写进 outbox 的 `result` 字段;抛异常时 outbox 写
 *        `{ok:false, error:<message>}`。**不重试**——见文件头「rename 认领」的说明。
 * @param {number} [intervalMs]  轮询间隔,默认跟 `serve.mjs` 的 `POLL_MS` 同量级。
 * @param {(code: string, err: unknown) => void} [onDiagnostic]  best-effort 诊断回调。
 * @param {object} [io]          文件 IO 注入,测试用。
 */
export function createVizInbox({ dir, handler, intervalMs = 400, onDiagnostic = null, io = null }) {
  if (typeof dir !== "string" || !dir) throw new Error("createVizInbox: dir is required");
  if (typeof handler !== "function") throw new Error("createVizInbox: handler is required");

  const IO = io || defaultIo();
  const diag = (code, err) => { try { onDiagnostic?.(code, err); } catch {} };
  const inboxRoot = path.join(dir, INBOX_DIRNAME);
  const outboxRoot = path.join(dir, OUTBOX_DIRNAME);

  let timer = null;
  let ticking = false;
  let stopped = false;

  async function writeOutbox(sessionId, reqId, body) {
    const dirp = path.join(outboxRoot, sessionId);
    const finalPath = path.join(dirp, `resp-${reqId}.json`);
    // 点前缀:轮询器自己按 `req-*.json` 挑文件,临时文件天然不会被误认成一条新请求
    // (这里虽然是 outbox,不是 inbox,但同一套命名习惯,方便以后要是有别的东西扫这个目录)。
    const tmpPath = path.join(dirp, `.tmp-${reqId}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      await IO.mkdir(dirp);
      await IO.writeFile(tmpPath, Buffer.from(JSON.stringify(body), "utf8"));
      await IO.rename(tmpPath, finalPath);
    } catch (err) {
      diag("outbox_write_failed", err);
      try { await IO.unlink(tmpPath); } catch {}
    }
  }

  async function processOne(sessionId, entryName) {
    const reqPath = path.join(inboxRoot, sessionId, entryName);
    const m = REQ_FILE_RE.exec(entryName);
    const reqId = m ? m[1] : null;

    /**
     * ⚠️ **认领靠 rename,不靠 unlink——而且认领失败必须一次都不执行。**
     *
     * 第一版是「先 unlink,删失败只记一行诊断然后照样往下走」。那等于把这个模块最要紧的
     * 那条保证(至多执行一次)交给一个**会失败的操作**:Windows 上 Defender 扫一下、
     * 或者任何东西短暂持有句柄,unlink 就会失败,而请求文件还原地躺着 —— 下一拍
     * (400ms 后)再读到它、**再执行一遍**。对一条能让 agent 去改文件的指令来说,
     * 「偶尔发两次」是不可接受的;持续失败还会变成每 400ms 重放一次。
     *
     * rename 在 Win32 与 POSIX 上都是原子的,而且**成功就意味着独占**:
     *   · rename 成功 → 这条请求归我了,原名已经不在扫描范围里,再怎么样也不会被重读 → 执行
     *   · rename 失败 → 我没拿到(被锁/被别人抢/磁盘出错)→ **直接返回,一个字都不执行**,
     *                    留着下一拍再试。失败方向倒向「这次不办」,而不是「可能办两次」。
     *
     * 认领后的文件**故意保留到回执写完才删**:中途崩掉时磁盘上留下的 `.claimed-*` 就是
     * 「这条请求被接下了,但不知道办没办完」的现场——比什么都不留强。
     */
    const claimedPath = path.join(inboxRoot, sessionId, `.claimed-${entryName}`);
    try { await IO.rename(reqPath, claimedPath); }
    catch (err) { diag("inbox_claim_failed", err); return; }

    let raw;
    try { raw = await IO.readFile(claimedPath); }
    catch (err) {
      // 认领到手却读不出来:这条请求作废,但**必须把认领件清掉**,否则它会一直躺在那儿。
      diag("inbox_read_failed", err);
      try { await IO.unlink(claimedPath); } catch {}
      return;
    }

    if (!reqId || !isSafeSegment(reqId)) {
      diag("bad_request_filename", new Error(entryName));
      try { await IO.unlink(claimedPath); } catch {}
      return;
    }

    let body;
    try {
      // ⚠️ **按字节量,不是按 `raw.length`。** 那个数是 UTF-16 码元个数,对中文会低估约三倍——
      //    三万个汉字大约 90 KiB,`raw.length` 只有 3 万,一路放行,而报错文案还写着 "bytes",
      //    看上去像是量过了。HTTP 那一侧(`readBodyCapped`)量的本来就是字节,两侧口径必须一致,
      //    否则同一个上限在两条路上是两个值。
      const bytes = Buffer.byteLength(raw, "utf8");
      if (bytes > REQUEST_MAX_BYTES) {
        throw new Error(`request too large (${bytes} bytes, cap is ${REQUEST_MAX_BYTES})`);
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body is not an object");
      const message = parsed.message;
      if (typeof message !== "string" || !message.trim()) throw new Error("`message` is required and must be non-empty");
      const result = await handler(sessionId, message, { reqId, receivedAt: nowIso() });
      body = { reqId, ok: true, result: result ?? null, respondedAt: nowIso() };
    } catch (err) {
      body = {
        reqId, ok: false,
        error: err instanceof Error ? err.message : String(err),
        respondedAt: nowIso(),
      };
    }
    await writeOutbox(sessionId, reqId, body);
    // 回执落定之后才清认领件:在这之前崩掉,磁盘上留下的 `.claimed-*` 就是「接下了但没办完」的现场。
    try { await IO.unlink(claimedPath); } catch (err) { diag("claimed_unlink_failed", err); }
  }

  async function tick() {
    if (stopped) return;
    let sessionDirs;
    try { sessionDirs = await IO.readdir(inboxRoot); }
    catch { return; } // inbox 目录还没建(还没人发过追问)——正常,不是错误

    const queue = [];
    for (const sEnt of sessionDirs) {
      const isDir = typeof sEnt.isDirectory === "function" ? sEnt.isDirectory() : true;
      if (!isDir) continue;
      const sessionId = sEnt.name ?? sEnt;
      if (!isSafeSegment(sessionId)) { diag("bad_session_dirname", new Error(String(sessionId))); continue; }
      let files;
      try { files = await IO.readdir(path.join(inboxRoot, sessionId)); }
      catch { continue; }
      for (const fEnt of files) {
        const name = fEnt.name ?? fEnt;
        if (REQ_FILE_RE.test(name)) queue.push({ sessionId, name });
      }
    }
    if (queue.length > MAX_PER_TICK) {
      diag("inbox_backlog_deferred", new Error(`${queue.length - MAX_PER_TICK} request(s) deferred to next tick`));
    }
    for (const { sessionId, name } of queue.slice(0, MAX_PER_TICK)) {
      await processOne(sessionId, name);
    }
  }

  return {
    get running() { return timer !== null; },
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => {
        if (ticking) return; // 上一拍还没完(handler 理论上很快,防御一下,不无限堆积并发 tick)
        ticking = true;
        tick().catch((err) => diag("tick_failed", err)).finally(() => { ticking = false; });
      }, intervalMs);
      timer.unref?.();
    },
    /** O(1),无 IO——跟 `viz-writer.mjs` 的 `SerialWriter.stop()` 同一条纪律。 */
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    /** 测试用:同步跑一拍,不依赖定时器等待。 */
    _tickOnce: tick,
  };
}
