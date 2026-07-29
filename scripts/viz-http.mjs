/**
 * 观测台 HTTP 的**纯原语** —— ref 词法校验、越界判定、UTF-8 边界裁剪、响应原语。
 *
 * 为什么单独放在 `scripts/` 而不是某个 skill 目录里：
 *   仓里 `viz/` 目录已经有 roundtable / loop / graph 三份，session 是第 4 份。
 *   这套「怎么安全地把归档里的文件发出去」的判据**每份各写一遍就会各自漂**，
 *   而它恰恰是最不该漂的部分（写错一条就是任意文件读）。
 *   `scripts/` 是所有 skill 本来就依赖的位置（它们都要 `scripts/agent-bridge.mjs`），
 *   放这里不会让任何一个 skill 多出新的安装依赖。
 *
 * ⚠️ **纯函数**：不碰全局、不起服务、不读环境变量。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 允许出现在 ref 里的字符。**白名单，不是黑名单。** */
const REF_ALLOWED = /^[A-Za-z0-9._/-]+$/;

/**
 * 单份正文最多发多少字节；超出只发 UTF-8 完整边界前缀。
 *
 * ⚠️ **writer 与 serve 必须共用这一个数。** 两边各写各的会出现这种事：
 *    writer 按自己的上限判「没超，是完整的 ready」，serve 按自己的上限只发了前缀，
 *    于是页面拿到一个**前缀**，手里却只有**全文**的指纹——当场对证必然失败，
 *    而它其实什么都没坏。指纹对不上是很重的信号，不能让它被口径不一触发。
 */
export const VIZ_FILE_MAX_BYTES = Number(process.env.VIZ_FILE_MAX_MB || 8) * 1024 * 1024;

/**
 * ref 的**词法**校验。通过返回 `{ ok, ref }`，否则返回 `{ code, msg }`。
 *
 * ⚠️ 词法这一关只能拒明显非法的，**拦不住 symlink**——所以它后面必须再跟一次
 *    realpath 复核（`resolveWithin`）。**只测词法越界是不够的。**
 */
export function validateRef(rawRef) {
  if (!rawRef) return { code: 400, msg: "缺 ref" };
  let ref;
  try { ref = decodeURIComponent(rawRef); } catch { return { code: 400, msg: "ref 解码失败" }; }

  // ⚠️ **一条白名单顶掉整张黑名单。**
  //    早先这里是「挡住 NUL」式的排除法，于是空格、控制字符、反斜杠、Unicode 同形字
  //    全都漏了过去，只能一条条往上加——而这个仓库在「别再加排除清单」上已经被证伪两次。
  //    白名单还顺带解决了 NUL：它压根不在允许集里，**不需要为它单写一条**
  //    （也就不会再有人把一个字面 NUL 字节打进源码、让 grep 把整个文件判成 binary——
  //     那已经是本仓第三次踩同一个坑）。
  if (!REF_ALLOWED.test(ref)) return { code: 400, msg: "ref 含不允许的字符" };

  // 绝对路径与 `..` 段：词法阶段就拒，**不碰文件系统**。
  // 用 400 而不是 403 是刻意的：403 的语义是「我看过了，你不能拿」，那就得先解析路径；
  // 而这里的判据不需要任何 IO 就能给出——早拒一层，就少一层暴露面。
  if (path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref) || ref.split("/").includes("..")) {
    return { code: 400, msg: "ref 不是合法相对路径" };
  }
  return { ok: true, ref };
}

/**
 * 把 ref 解析成 root 之下的一个**普通文件**的真实路径。
 *
 * 顺序不能换：词法 → join → realpath → 用 `path.relative` 判包含 → 判是不是普通文件。
 *
 * ⚠️ **判包含必须用 `path.relative`，不是字符串前缀比较。**
 *    `/a/bc` 以 `/a/b` 为前缀，但它不在 `/a/b` 里。
 */
export function resolveWithin(rootAbs, rawRef, { requirePrefix = null } = {}) {
  const lex = validateRef(rawRef);
  if (lex.code) return lex;
  const ref = lex.ref;

  // 可选的额外前缀闸：root 本身可能很宽（比如仓库根），
  // 这时「没有绝对路径、没有 `..`、确实在 root 内」的请求仍可能是 `?ref=.env`。
  if (requirePrefix && !ref.startsWith(requirePrefix)) {
    return { code: 403, msg: "不在放行范围内" };
  }

  let rootReal;
  try { rootReal = fs.realpathSync.native(rootAbs); } catch { return { code: 500, msg: "根目录不可达" }; }

  let real;
  try { real = fs.realpathSync.native(path.join(rootAbs, ref)); }
  catch (e) { return e.code === "ENOENT" ? { code: 404, msg: "文件已不在" } : { code: 500, msg: "读取失败" }; }

  const rel = path.relative(rootReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { code: 403, msg: "不在放行范围内" };

  let st;
  try { st = fs.statSync(real); } catch { return { code: 500, msg: "读取失败" }; }
  if (!st.isFile()) return { code: 403, msg: "不是普通文件" };   // 拒绝目录

  return { abs: real, size: st.size };
}

/**
 * 在**完整 UTF-8 边界**上裁出前 `maxBytes` 字节。
 *
 * ⚠️ 直接 `buf.subarray(0, n)` 可能切在一个多字节序列中间，解码出来末尾是 `U+FFFD`。
 *    做法：从 `n` 往回退，退到第一个不是「后续字节」(`10xxxxxx`) 的位置为止。
 */
export function utf8BoundaryPrefix(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * 把一份归档文件发出去。
 *
 * ⚠️ **先把字节读进内存，再按这份内存里的字节同时算 `Content-Length` 与 sha256。**
 *    不许「stat 拿长度、再流式读发」：那两步之间文件仍可能被改，
 *    于是响应头描述的与响应体发出的是**两份不同的字节**——这正是本条要消灭的东西。
 * ⚠️ **短开短关**：读完立刻放手，不在整个传输期握着句柄（会挡住临时目录删除）。
 * ⚠️ **绝不按扩展名回 `text/html`**——归档里每一个字节都是模型写的。
 */
export function sendArchivedFile(req, res, abs, { shaHeader = "X-Viz-Sha256", maxBytes = null } = {}) {
  let bytes;
  try { bytes = fs.readFileSync(abs); }
  catch (e) {
    const code = e.code === "ENOENT" ? 404 : 500;
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(code === 404 ? "文件已不在\n" : "读取失败\n");
  }

  const full = bytes.length;
  let truncated = false;
  if (maxBytes && full > maxBytes) { bytes = utf8BoundaryPrefix(bytes, maxBytes); truncated = true; }

  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": bytes.length,
    [shaHeader]: crypto.createHash("sha256").update(bytes).digest("hex"),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (truncated) {
    // 页面必须知道自己拿到的只是前缀，否则「复制原文」会把截断件当原文交出去。
    headers["X-Viz-Truncated"] = "1";
    headers["X-Viz-Full-Bytes"] = String(full);
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  res.end(bytes);
}

export function sendPlain(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${msg}\n`);
}

/** 405 缺了 `Allow` 就不是一个合法的 405。 */
export function sendMethodNotAllowed(res, allow = "GET, HEAD") {
  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: allow });
  res.end("不支持的请求方法\n");
}
