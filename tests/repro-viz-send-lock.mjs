// `skills/agent-bridge/viz/serve.mjs` 的「追问」锁与信箱传输的机器验收 —— 零消耗。
//
// 对应 docs/DESIGN-session-viz-send-lock-2026-08-04.md §3(HTTP 锁)与 §2(inbox/outbox 接线)。
// 起真的 serve.mjs 子进程,用真 HTTP 打它。`viz-inbox.mjs` 自己的合同在 repro-viz-inbox.mjs 里,
// 这里只测「浏览器到 serve.mjs 这一跳」：token / Origin / 方法 / 大小四道检查,以及
// outbox → SSE 的转发（用手写 outbox 文件模拟桥进程已经处理完的样子,不需要真桥）。
//
// 跑法：node tests/repro-viz-send-lock.mjs

import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const VIZ = path.join(ROOT, "skills/agent-bridge/viz");
const SERVE_FILE = path.join(VIZ, "serve.mjs");

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 起一个最小合法的 viz run 目录 ────────────────────────────────────────────

async function makeVizDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vizlocktest-"));
  const runId = "mcp-locktest";
  const startedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({
    runId, pid: process.pid, processStartedAt: startedAt, bridgeVersion: "test", createdAt: startedAt,
  }));
  const snapshot = {
    schemaVersion: 1, runId, generation: 1, updatedAt: startedAt,
    run: { pid: process.pid, bridgeVersion: "test", startedAt, status: "running", degraded: false, recordingErrors: [] },
    sessions: [],
  };
  await fs.writeFile(path.join(dir, "state.0.json"), JSON.stringify(snapshot));
  return dir;
}

// ── 起/停 serve.mjs 子进程(仿 tests/test-viz-session.mjs 的 startServe) ──────

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}

async function probeUrl(baseUrl) {
  try {
    const res = await fetch(new URL("/", baseUrl), { signal: AbortSignal.timeout(300) });
    await res.arrayBuffer();
    return res.status < 500;
  } catch { return false; }
}

async function startServe(vizDir) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [SERVE_FILE, vizDir, String(port)], {
    cwd: VIZ, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", d => { output += d.toString(); });
  child.stderr.on("data", d => { output += d.toString(); });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve.mjs 提前退出 code=${child.exitCode}: ${output}`);
    if (await probeUrl(baseUrl)) return { child, baseUrl, port, output: () => output };
    await sleep(80);
  }
  child.kill();
  throw new Error(`serve.mjs 10 秒内未就绪: ${output}`);
}

function stopServe(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1500);
  });
}

// ── 拿到页面里注入的凭证 ──────────────────────────────────────────────────────

async function fetchToken(baseUrl) {
  const res = await fetch(new URL("/", baseUrl));
  const html = await res.text();
  const m = /window\.__VIZ_TOKEN__=("[0-9a-f]+")/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

// ── 原生 http.request:fetch() 在部分实现里会限制 Origin 头,这里要精确控制它 ──

function rawPost(baseUrl, pathname, { headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rawGet(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(url, { method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ============================================================ */
async function main() {
  const vizDir = await makeVizDir();
  const { child, baseUrl, port } = await startServe(vizDir);
  try {
    const origin = `http://127.0.0.1:${port}`;
    const token = await fetchToken(baseUrl);
    ok("T0 页面里注入了凭证(不在 URL 里)", typeof token === "string" && token.length === 64, String(token));

    sect("T1 完全没带 Origin/token → 403（Origin 先查）");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      });
      ok("T1 status 403", r.status === 403, JSON.stringify(r));
    }

    sect("T2 Origin 对但没带 token → 401");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      });
      ok("T2 status 401", r.status === 401, JSON.stringify(r));
    }

    sect("T3 Origin 对、token 错 → 401");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "x-viz-token": "0".repeat(64), "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      });
      ok("T3 status 401", r.status === 401, JSON.stringify(r));
    }

    sect("T4 ★ token 对、Origin 是别的来源 → 403（凭证泄漏也挡得住伪造来源）");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin: "http://evil.example", "x-viz-token": token, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      });
      ok("T4 status 403", r.status === 403, JSON.stringify(r));
    }

    sect("T5 Origin + token 都对，但 Content-Type 不是 JSON → 415");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "x-viz-token": token, "content-type": "text/plain" },
        body: JSON.stringify({ sessionId: "s1", message: "hi" }),
      });
      ok("T5 status 415", r.status === 415, JSON.stringify(r));
    }

    sect("T6 请求体超过单条上限 → 413");
    {
      const big = "x".repeat(70 * 1024);
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "x-viz-token": token, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", message: big }),
      });
      ok("T6 status 413", r.status === 413, JSON.stringify({ status: r.status }));
    }

    sect("T7 sessionId 含 .. → 400");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "x-viz-token": token, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "../etc", message: "hi" }),
      });
      ok("T7 status 400", r.status === 400, JSON.stringify(r));
    }

    sect("T8 message 缺失 → 400");
    {
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "x-viz-token": token, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1" }),
      });
      ok("T8 status 400", r.status === 400, JSON.stringify(r));
    }

    sect("T9 非 POST 方法 → 405 + Allow 头");
    {
      const r = await rawGet(baseUrl, "/send", { origin, "x-viz-token": token });
      ok("T9 status 405", r.status === 405, JSON.stringify(r));
      ok("T9 带 Allow: POST", (r.headers.allow || "").includes("POST"), JSON.stringify(r.headers));
      // ⚠️ 只查状态码和 Allow 是不够的:§12.6 说死了 `/send` 的**所有**响应都是 JSON,
      //    照着合同写的客户端会对每个响应调 `response.json()`。这里曾经回的是共用的
      //    text/plain 405,状态码断言照样绿,而客户端当场抛。
      ok("T9 ★ Content-Type 是 JSON(合同说 /send 的所有响应都是 JSON)",
        /application\/json/i.test(r.headers["content-type"] || ""), r.headers["content-type"]);
      let parsed = null;
      try { parsed = JSON.parse(r.text); } catch {}
      ok("T9 ★ 正文是可解析的 JSON 且带 error 字段", !!parsed && typeof parsed.error === "string",
        String(r.text).slice(0, 120));
    }

    sect("T9b ★★ 上面每一条被拒的请求,都不许在 inbox/ 里留下任何东西");
    {
      // ⚠️ 只断言「返回了 4xx」是不够的 —— 那是表面回执。真正要守的是**副作用没有发生**:
      //    一条被拒的请求如果照样落了盘,桥那边的轮询器照样会把它捡起来执行,
      //    前面九条锁就全是摆设。这一类「负向用例不查副作用」正是这次复审抓出两个
      //    Critical 的同一个口子。
      const inboxRoot = path.join(vizDir, "inbox");
      let leftover = [];
      if (existsSync(inboxRoot)) {
        for (const sdir of await fs.readdir(inboxRoot)) {
          const files = await fs.readdir(path.join(inboxRoot, sdir)).catch(() => []);
          leftover.push(...files.map(f => `${sdir}/${f}`));
        }
      }
      ok("T9b ★★ 被拒的请求一个都没落盘(inbox 仍然是空的)", leftover.length === 0, JSON.stringify(leftover));
    }

    sect("T10 ★ 合法请求 → 202 + reqId，且原子写进了 inbox/");
    let reqId, sessionId;
    {
      sessionId = "sess-abc123";
      const r = await rawPost(baseUrl, "/send", {
        headers: { origin, "x-viz-token": token, "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message: "你好，追问一下" }),
      });
      ok("T10 status 202", r.status === 202, JSON.stringify(r));
      reqId = r.json?.reqId;
      ok("T10 返回了 reqId", typeof reqId === "string" && reqId.length > 0, JSON.stringify(r.json));
      const inboxFile = path.join(vizDir, "inbox", sessionId, `req-${reqId}.json`);
      const written = existsSync(inboxFile) ? JSON.parse(await fs.readFile(inboxFile, "utf8")) : null;
      ok("T10 inbox 文件内容就是 {message}", written?.message === "你好，追问一下", JSON.stringify(written));
    }

    sect("T11 ★ outbox 回执 → SSE 推 send-result 帧，推完删文件");
    {
      // 模拟桥进程已经处理完:直接写 outbox（真实场景由 viz-inbox.mjs 的轮询器写)。
      const outDir = path.join(vizDir, "outbox", sessionId);
      await fs.mkdir(outDir, { recursive: true });
      const respBody = { reqId, ok: true, result: { accepted: true }, respondedAt: new Date().toISOString() };
      await fs.writeFile(path.join(outDir, `resp-${reqId}.json`), JSON.stringify(respBody));

      const controller = new AbortController();
      const res = await fetch(new URL("/events", baseUrl), { headers: { Accept: "text/event-stream" }, signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let found = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 3000 && !found) {
        const { done, value } = await Promise.race([
          reader.read(),
          sleep(3100 - (Date.now() - t0)).then(() => ({ done: true, value: undefined })),
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const evLine = block.split("\n").find(l => l.startsWith("event:"));
          const dataLine = block.split("\n").find(l => l.startsWith("data:"));
          if (evLine?.slice(6).trim() === "send-result") {
            found = JSON.parse(dataLine.slice(5).trim());
          }
        }
      }
      controller.abort();
      ok("T11 收到了 send-result 帧，内容跟 outbox 写的一致", found?.reqId === reqId && found?.sessionId === sessionId && found?.ok === true, JSON.stringify(found));
      await sleep(200); // 给 pollOutbox 一拍时间把文件删掉
      ok("T11 outbox 文件读完即删", !existsSync(path.join(outDir, `resp-${reqId}.json`)));
    }

    sect("T12 ★★ 回执消费端自己校验一遍——正文不许冒充别的会话,reqId 对不上就整份丢掉");
    {
      // 合同 §12.1「两侧互不信任」。第一版是 `{ sessionId, ...body }` —— 展开在后,
      // **正文里的 sessionId 会盖掉目录来源**,一份 outbox/A/ 的回执只要正文写 B 就被广播成 B 的。
      const outDir = path.join(vizDir, "outbox", sessionId);
      await fs.mkdir(outDir, { recursive: true });

      // 先连上再写文件:pollOutbox 读完即删,先写后连有可能整帧丢在没人听的那一拍里。
      const controller = new AbortController();
      const res = await fetch(new URL("/events", baseUrl), { headers: { Accept: "text/event-stream" }, signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      const write = (name, body) => fs.writeFile(path.join(outDir, name), JSON.stringify(body));
      await write("resp-spoof.json", {
        reqId: "spoof", ok: true, result: { accepted: true },
        sessionId: "victim-session",           // ← 正文冒充别的会话
        respondedAt: new Date().toISOString(),
      });
      await write("resp-mismatch.json", { reqId: "SOMETHING-ELSE", ok: true, respondedAt: new Date().toISOString() });
      await write("resp-nook.json", { reqId: "nook", respondedAt: new Date().toISOString() }); // 缺 ok
      // ⚠️ 「缺字段」和「字段是错类型」是两种变异:只测前者的话,把判据写成"有这个字段就行"
      //    (`"ok" in body`)照样全绿。字符串 "false" 尤其阴——它是 truthy。
      await write("resp-strok.json", { reqId: "strok", ok: "false", respondedAt: new Date().toISOString() });
      await write("resp-numok.json", { reqId: "numok", ok: 1, respondedAt: new Date().toISOString() });

      const frames = [];
      let buf = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        const { done, value } = await Promise.race([
          reader.read(),
          sleep(Math.max(1, 2600 - (Date.now() - t0))).then(() => ({ done: true, value: undefined })),
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const evLine = block.split("\n").find(l => l.startsWith("event:"));
          const dataLine = block.split("\n").find(l => l.startsWith("data:"));
          if (evLine?.slice(6).trim() === "send-result" && dataLine) {
            try { frames.push(JSON.parse(dataLine.slice(5).trim())); } catch {}
          }
        }
      }
      controller.abort();

      const spoof = frames.find(f => f.reqId === "spoof");
      ok("T12 前提:那份回执确实被推出来了(否则下面几条是空考)", !!spoof, JSON.stringify(frames));
      ok("T12 ★★ sessionId 取的是目录来源,正文里的冒充值没有生效",
        spoof?.sessionId === sessionId, JSON.stringify(spoof));
      ok("T12 ★★ 没有任何一帧被归到被冒充的那个会话名下",
        !frames.some(f => f.sessionId === "victim-session"), JSON.stringify(frames));
      ok("T12 ★★ 文件名 reqId 跟正文对不上 ⇒ 整份丢掉,一帧都不推",
        !frames.some(f => f.reqId === "SOMETHING-ELSE" || f.reqId === "mismatch"), JSON.stringify(frames));
      ok("T12 ★ 缺 ok 字段的回执也丢掉", !frames.some(f => f.reqId === "nook"), JSON.stringify(frames));
      ok("T12 ★★ ok 是非布尔(字符串 \"false\" / 数字 1)的也丢掉——判据是类型,不是「字段在不在」",
        !frames.some(f => f.reqId === "strok" || f.reqId === "numok"), JSON.stringify(frames));
      await sleep(300);
      ok("T12 五份都读完即删(丢掉不等于留在盘上反复重放)",
        ["spoof", "mismatch", "nook", "strok", "numok"]
          .every(n => !existsSync(path.join(outDir, `resp-${n}.json`))));
    }
  } finally {
    await stopServe(child);
    await fs.rm(vizDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
console.log(`\n${"=".repeat(56)}\n  repro-viz-send-lock: ${pass} passed, ${fail} failed\n${"=".repeat(56)}`);
process.exit(fail ? 1 : 0);
