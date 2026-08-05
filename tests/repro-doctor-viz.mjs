// doctor 的观测台那一段 —— **零消耗**(只跑各后端的 `--version`,不开任何会话、不烧 token)。
//
// 它回答的是:**"观测记录在哪 / 到底开没开",桥能不能自己说出来。**
// 在此之前两个都只能靠人去 tmpdir 里扫 `agent-bridge-viz-*` 按时间戳猜——
// 同机开着几个客户端时那是**会猜错**的(挑到别的窗口的记录),而"扫不到"又被当成
// "观测台关着"的判据,于是一个隐私开关的状态要靠考古确认。
//
// 判据全都写死到**具体值**,不接受"非空就算过":
//   - self/on   那行给的路径,必须是**这个 server 自己**的目录(meta.json 的 pid 对得上);
//   - self/off  必须与 init_failed 说的**不是同一句话**,且一个路径都不许漏出来;
//   - scan      列出来的必须**真的包含**那个活着的 run(空列表也算过 = 没牙);
//   - scan      **一个目录都不许删**(它只看不动;删是 `cleanup` 的事)。
//
// 没覆盖:`init_failed`(要让 `mkdtempSync` 失败才能进那条分支,端到端造不出来)。
// 它与 `off` 走的是同一个 `scope:"self"` 出口、只差 `disabledReason`,渲染分叉就在那一处。
//
// 跑法:node tests/repro-doctor-viz.mjs

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(ROOT, "scripts/agent-bridge.mjs");

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);

// TMPDIR 隔离:viz 目录建在 `os.tmpdir()` 下,不隔离就得在满是别人临时文件的目录里猜哪个是自己的
// ——而"猜错目录"恰恰是这次要修的毛病本身。
const BOX = fs.mkdtempSync(path.join(os.tmpdir(), "ab-doctorviz-"));
const STATE = path.join(BOX, "state");
const TMP = path.join(BOX, "tmp");
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const PLANT_DEAD = path.join(TMP, "agent-bridge-viz-zzdead");

/**
 * 埋一个 owner 已经死掉的观测目录。
 *
 * ⚠️ **必须在最后一次开服之后调**,不能在文件顶部埋一次了事:
 *    `serveMcp()` 启动时本来就会扫掉孤儿目录(这是对的,不干净的退出会留下带全部委托原文的目录),
 *    埋在顶部的话 A、B 两次开服会先把它清掉。第一版就是这么写的,后果是**两条断言同时坏掉**:
 *      · D1 假红(以为 doctor 删了它,其实是开服删的);
 *      · C5 **假绿**(它"没出现在列表里"是因为已经不存在了,
 *        `vizList` 跳过死目录的那段逻辑根本没被考到)。
 */
function plantDead() {
  const deadPid = spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid;
  fs.mkdirSync(PLANT_DEAD, { recursive: true });
  fs.writeFileSync(path.join(PLANT_DEAD, "owner"),
    JSON.stringify({ pid: deadPid, processStartedAt: new Date(0).toISOString() }));
  fs.writeFileSync(path.join(PLANT_DEAD, "meta.json"),
    JSON.stringify({ runId: "mcp-zzdead", pid: deadPid, bridgeVersion: "0.0.0" }));
}

function baseEnv(extra = {}) {
  const env = { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE, TEMP: TMP, TMP, TMPDIR: TMP, ...extra };
  // 继承来的开关会让"默认开"那一格考的其实是别人的设置。显式删掉,除非本格自己要设。
  if (!("AGENT_BRIDGE_VIZ" in extra)) delete env.AGENT_BRIDGE_VIZ;
  return env;
}

/** 起一个真 MCP server,返回 {proc, callDoctor, stop}。 */
function startServer(extra = {}) {
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: baseEnv(extra),
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));

  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) responses.set(m.id, m); } catch {}
    }
  });
  let nextId = 1;
  const callDoctor = async (ms = 90000) => {
    const id = nextId++;
    srv.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "agent_bridge_doctor", arguments: {} },
    }) + "\n");
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (responses.has(id)) return responses.get(id)?.result?.content?.[0]?.text ?? "";
      if (exited) return "";
      await sleep(40);
    }
    return "";
  };
  return { srv, callDoctor, stop: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

/** doctor 文本里的 Viz 段:`Viz:` 那行 + 紧随其后的缩进行。 */
function vizBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const i = lines.findIndex(l => l.startsWith("Viz:"));
  if (i < 0) return null;
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j += 1) out.push(lines[j]);
  return out.join("\n");
}

const live = [];   // 收尾时要杀掉的 server

async function main() {
  // ── A. 本进程就是 server,观测台默认开 ────────────────────────────────
  sect("A · scope=self / on");
  const srvOn = startServer();
  live.push(srvOn);
  const textOn = await srvOn.callDoctor();
  const blockOn = vizBlock(textOn);
  ok("A1 doctor 里有 Viz 段", !!blockOn, JSON.stringify(String(textOn).slice(0, 200)));

  const m = /^Viz: on {3}(.+)$/m.exec(blockOn || "");
  ok("A2 那行报的是 on,并带一个路径", !!m, blockOn || "");
  const reported = m?.[1]?.trim() || "";
  ok("A3 报的路径真实存在,而且是个目录",
    !!reported && fs.existsSync(reported) && fs.statSync(reported).isDirectory(), reported);

  // ★ 有牙的一条:随便打印一个 tmpdir 下的 viz 目录(比如手埋的那个死的)也能过 A3,
  //   只有"meta.json 里的 pid == 这个 server 的 pid"能证明报的是**它自己**那份。
  let metaPid = null;
  try { metaPid = JSON.parse(fs.readFileSync(path.join(reported, "meta.json"), "utf8"))?.pid ?? null; } catch {}
  ok("A4 ★ 报的是这个 server 自己的目录(meta.json 的 pid 对得上)",
    metaPid === srvOn.srv.pid, `meta.pid=${metaPid} server.pid=${srvOn.srv.pid}`);
  ok("A5 报的路径落在隔离的 TMPDIR 里", reported.startsWith(TMP), reported);

  // ── B. 本进程就是 server,但开关关掉了 ────────────────────────────────
  sect("B · scope=self / off");
  const srvOff = startServer({ AGENT_BRIDGE_VIZ: "off" });
  live.push(srvOff);
  const textOff = await srvOff.callDoctor();
  const blockOff = vizBlock(textOff);
  ok("B1 关掉时明说 off,并点名是哪个开关",
    blockOff === "Viz: off (AGENT_BRIDGE_VIZ)", JSON.stringify(blockOff));
  // ★ "关掉了"与"起不来"必须是两句话:合成一行会把故障(磁盘满/权限)伪装成用户自己的选择。
  ok("B2 ★ off 这句话不等于 init_failed 那句",
    !/unavailable/i.test(blockOff || ""), JSON.stringify(blockOff));
  ok("B3 关掉时一个路径都不漏(没有目录可言,就别编一个)",
    !/agent-bridge-viz-/.test(blockOff || ""), JSON.stringify(blockOff));

  // ── C. 命令行跑 doctor:本进程不是 server ─────────────────────────────
  sect("C · scope=scan(命令行)");
  // 死目录埋在这里(最后一次开服之后),否则 C5 会假绿、D1 会假红 —— 见 plantDead() 上面那段。
  plantDead();
  ok("C0 前提:死目录此刻确实躺在 tmpdir 里(否则 C5/D1 什么都没考到)",
    fs.existsSync(PLANT_DEAD), PLANT_DEAD);
  const cli = spawnSync("node", [BRIDGE, "doctor"], {
    encoding: "utf8", windowsHide: true, env: baseEnv(), timeout: 120000,
  });
  const blockCli = vizBlock(cli.stdout || "");
  ok("C1 命令行 doctor 也有 Viz 段", !!blockCli, JSON.stringify(String(cli.stdout).slice(0, 200)));
  ok("C2 明说本进程不是 MCP server",
    /this process is not an MCP server/.test(blockCli || ""), JSON.stringify(blockCli));
  // ★ 命令行这个 shell 的 AGENT_BRIDGE_VIZ 跟 server 进程毫无关系,报 on/off 就是撒谎——
  //   而且撒的正是隐私开关的谎。
  ok("C3 ★ 绝不报 on/off(它无从得知别的进程启动时读到了什么)",
    !/^Viz: (on|off)\b/m.test(blockCli || ""), JSON.stringify(blockCli));
  // ★ 空列表也能让 C1/C2 全绿。必须真的把那个活着的 run 找出来。
  ok("C4 ★ 列出的目录里包含 A 那个还活着的 run",
    (blockCli || "").includes(reported), `want ${reported}\ngot ${blockCli}`);
  ok("C5 死掉的 run 不算活的,不出现在列表里",
    !(blockCli || "").includes(PLANT_DEAD), blockCli || "");

  // ── E. 本进程就是 server,但观测目录建不出来 ───────────────────────────
  sect("E · scope=self / init_failed");
  // 把 TMPDIR 指到一个**普通文件**,`mkdtempSync` 在文件底下建目录必然 ENOTDIR ——
  // 于是走到 `disabledRecorder("init_failed")`。这一格存在的意义是:
  // 只有真的观察到 unavailable 那句话,B2("off 不等于 init_failed")才算被证明,
  // 否则把两条分支合并成一行的实现照样能让 B2 全绿。
  //
  // ⚠️ 第一版用的是"父目录都不存在的路径",不成立:那条路径**照样被建出来了**
  //    (`...\nope\deeper\agent-bridge-viz-XXX` 真的出现在了输出里)。
  //    "父目录不存在 ⇒ mkdtemp 会失败"是想当然,拿一个文件挡路才是确定失败的。
  const NOT_A_DIR = path.join(BOX, "notadir");
  fs.writeFileSync(NOT_A_DIR, "占位:让 mkdtempSync 撞上 ENOTDIR");
  const srvBroken = startServer({ TEMP: NOT_A_DIR, TMP: NOT_A_DIR, TMPDIR: NOT_A_DIR });
  live.push(srvBroken);
  const textBroken = await srvBroken.callDoctor();
  const blockBroken = vizBlock(textBroken);
  ok("E1 建不出目录时说的是 unavailable,不是 off",
    blockBroken === "Viz: unavailable (recording dir could not be created)", JSON.stringify(blockBroken));
  // ⚠️ 光断言"两句不一样"是没牙的:E1 第一版红的时候(broken 那句是 `Viz: on …`),
  //    这一条照样绿。所以两边各自长什么样必须一起写死。
  ok("E2 ★ 故障那句与关掉那句确实不同(两次真实观察,不是靠断言措辞)",
    /unavailable/.test(blockBroken || "") && /^Viz: off\b/.test(blockOff || "") && blockBroken !== blockOff,
    `off=${JSON.stringify(blockOff)} broken=${JSON.stringify(blockBroken)}`);

  // ── D. scan 只看不动 ─────────────────────────────────────────────────
  sect("D · scan 的只读性");
  // ★ 这条是给未来的:哪天有人顺手把 `vizCleanup()` 接进 doctor,doctor 就变成了
  //   一条会删掉别人记录的命令,而 C 那几格照样全绿。
  ok("D1 ★ 跑完 doctor,手埋的死目录还在(doctor 不删东西)",
    fs.existsSync(PLANT_DEAD), PLANT_DEAD);
  ok("D2 ★ 活着的 run 目录当然也还在", fs.existsSync(reported), reported);
}

main().then(() => {
  for (const s of live) s.stop();
  console.log(`\n========================================================`);
  console.log(`  repro-doctor-viz: ${pass} passed, ${fail} failed`);
  console.log(fail ? "  >>> FAIL" : "  >>> PASS");
  try { fs.rmSync(BOX, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}).catch(err => {
  for (const s of live) s.stop();
  console.error(err);
  try { fs.rmSync(BOX, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
