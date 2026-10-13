#!/usr/bin/env node
// ============================================================
// asar 校验器：解析头、按偏移提取每个文件并与源码逐字节比对
// ------------------------------------------------------------
// 头部布局（@electron/asar 与 electron-builder 产出物一致，已实测）：
//   [0]  uint32 = 4                  pickle 长度字段自身大小
//   [4]  uint32 = 头总长             本 pickle 总长度
//   [8]  uint32 = jsonLen            JSON 长度（含 4 字节对齐填充）
//   [12] uint32 = jsonRawLen         JSON 真实长度（未对齐）
//   [16] JSON + 空格填充
//   数据区基准 = 16 + align4(jsonRawLen)
//
// 用法：
//   node tools/verify-asar.js dist/StickyTodo/resources/app.asar
//   node tools/verify-asar.js F:/sticky/resources/app.asar --src . --list
// ============================================================
const fs = require("fs");
const path = require("path");

const JSON_START = 16;
const align4 = (n) => Math.ceil(n / 4) * 4;

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const total = fs.statSync(asarPath).size;
  const pre = Buffer.alloc(Math.min(total, 1 << 20));
  fs.readSync(fd, pre, 0, pre.length, 0);

  const pickleSize = pre.readUInt32LE(4);
  const jsonLen = pre.readUInt32LE(8);
  const jsonRawLen = pre.readUInt32LE(12);

  const raw = pre.slice(JSON_START, JSON_START + jsonRawLen).toString("utf8");
  const json = JSON.parse(raw.slice(0, raw.lastIndexOf("}") + 1));

  const files = [];
  (function walk(node, prefix) {
    for (const [name, e] of Object.entries(node.files || {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (e.files) walk(e, full);
      else files.push({ rel: full, size: e.size, offset: parseInt(e.offset, 10) });
    }
  })(json, "");

  const dataBase = JSON_START + align4(jsonRawLen);
  return { fd, total, pickleSize, jsonLen, jsonRawLen, files, dataBase };
}

function readEntry(fd, dataBase, entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataBase + entry.offset);
  return buf;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const asarPath = argv.find((a) => !a.startsWith("--"));
  const srcIdx = argv.indexOf("--src");
  const srcDir = srcIdx >= 0 ? argv[srcIdx + 1] : null;
  const doList = argv.includes("--list");

  if (!asarPath) {
    console.error("用法: node tools/verify-asar.js <app.asar> [--src <目录>] [--list]");
    process.exit(1);
  }

  const { fd, total, pickleSize, jsonLen, jsonRawLen, files, dataBase } = readHeader(asarPath);
  const sumData = files.reduce((n, f) => n + f.size, 0);
  // 数据区末尾可能再补 0~4 字节对齐（官方产出即如此），故允许小尾巴
  const gap = total - (dataBase + sumData);
  const tailOk = gap >= 0 && gap <= 4;

  console.log(`asar      : ${path.resolve(asarPath)}`);
  console.log(`总大小    : ${total} B   条目数: ${files.length}`);
  console.log(`头部      : pickleSize=${pickleSize}  jsonLen=${jsonLen}  jsonRawLen=${jsonRawLen}  数据区起点=${dataBase}`);
  console.log(`尾端校验  : ${dataBase} + ${sumData} = ${dataBase + sumData}，与总长差 ${gap} B → ${tailOk ? "吻合 ✓" : "不吻合 ✗"}`);
  console.log("");

  let bad = tailOk ? 0 : 1;
  console.log("文件                          大小      与源码");
  for (const f of files) {
    const buf = readEntry(fd, dataBase, f);
    let cmp = "-";
    if (srcDir) {
      const sp = path.join(srcDir, f.rel);
      if (f.rel === "package.json") {
        try {
          const a = JSON.parse(buf.toString("utf8"));
          const b = JSON.parse(fs.readFileSync(sp, "utf8"));
          const same = ["name", "version", "main"].every((k) => a[k] === b[k]);
          cmp = same ? "关键字段一致" : "字段不一致 ✗";
          if (!same) bad++;
        } catch { cmp = "解析失败 ✗"; bad++; }
      } else if (fs.existsSync(sp)) {
        const same = buf.equals(fs.readFileSync(sp));
        cmp = same ? "一致" : "不同 ✗";
        if (!same) bad++;
      } else { cmp = "源码缺失 ✗"; bad++; }
    }
    if (doList || cmp.includes("✗")) {
      console.log(`${f.rel.padEnd(28)} ${String(f.size).padStart(8)}  ${cmp}`);
    }
  }
  fs.closeSync(fd);
  if (!doList) console.log("（仅列出差异项，用 --list 查看全部）");
  console.log("");
  console.log(bad === 0 ? "校验结果: 通过 ✓" : `校验结果: 存在 ${bad} 处差异 ✗`);
  process.exit(bad === 0 ? 0 : 1);
}

module.exports = { readHeader, readEntry, JSON_START };
