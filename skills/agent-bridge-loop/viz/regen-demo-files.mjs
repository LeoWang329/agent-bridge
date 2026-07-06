#!/usr/bin/env node
// 维护工具:从 sample/ 磁盘文件逐字再生成 index.html 的 DEMO_FILES 块。
// 为什么存在:内联离线样例与 sample/ 夹具必须**字节同源**(双源会漂移,fe-e2e 有内容相等断言);
// 改了 sample/ 下任何旁挂 md 后,跑一次本脚本:`node regen-demo-files.mjs`。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIZ = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(VIZ, "sample");
const IDX = path.join(VIZ, "index.html");

// ref 清单从 transcript 提取(与 fe-e2e 同源逻辑)
const transcript = fs.readFileSync(path.join(SAMPLE, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const refs = [];
for (const ev of transcript) {
  const p = ev.payload || {};
  for (const k of ["contractRef", "genRef", "verdictRef", "summaryRef", "reviewRef", "reportRef"])
    if (p[k] && !refs.includes(p[k])) refs.push(p[k]);
}
if (!refs.length) { console.error("no refs found in transcript"); process.exit(1); }

const lines = refs.map(r => JSON.stringify(r) + ": " + JSON.stringify(fs.readFileSync(path.join(SAMPLE, r), "utf8")));
// 防 </script> 早闭合(样例内容目前不含,防御性替换)
const block = "var DEMO_FILES = {\n" + lines.join(",\n").replace(/<\//g, "<\\/") + "\n};";

let html = fs.readFileSync(IDX, "utf8");
const start = html.indexOf("var DEMO_FILES = {");
if (start < 0) { console.error("DEMO_FILES start not found"); process.exit(1); }
const end = html.indexOf("\n};", start);
if (end < 0) { console.error("DEMO_FILES end not found"); process.exit(1); }
html = html.slice(0, start) + block + html.slice(end + 3);
fs.writeFileSync(IDX, html);
console.log("REGENERATED DEMO_FILES:", refs.length, "files, byte-identical to sample/");
