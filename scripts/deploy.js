#!/usr/bin/env node
// ============================================================
// 打包并部署到正式版目录
// ------------------------------------------------------------
// 用法：
//   node scripts/deploy.js                  # 打包 + 校验 + 部署到 F:\sticky
//   node scripts/deploy.js --dry-run        # 只打包和校验
//   node scripts/deploy.js --target D:\apps\StickyTodo --exe StickyTodo
//   node scripts/deploy.js --yes            # 目标在运行时直接结束进程，不询问
//
// 为什么用 Node 而不是 PowerShell 脚本：Windows PowerShell 5.1 会把无 BOM 的
// UTF-8 脚本当 ANSI 读，中文注释会吞掉下一行（曾导致 $pkgText 赋值整行被注释掉）。
// Node 原生 UTF-8，不存在这个问题。
//
// 打包必须使用官方 @electron/asar。手写 asar 头极难正确：Chromium 的
// asar::Archive::Init 校验长度字段，稍有偏差就报 "Failed to parse header"，
// 应用启动即退出且不显示任何窗口。
// ============================================================
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const TARGET = val("--target", "F:\\sticky");
const EXE = val("--exe", "StickyTodo");
const DRY = has("--dry-run");
const YES = has("--yes");

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const step = (m) => console.log(c.cyan(`\n==> ${m}`));
const ok = (m) => console.log(c.green(`    OK  ${m}`));
const warn = (m) => console.log(c.yellow(`    !!  ${m}`));
function die(m) {
  console.log(c.red(`    XX  ${m}`));
  process.exit(1);
}

/** 应用文件白名单（与 package.json 的 build.files 保持一致） */
const APP_FILES = ["main.js", "preload.js"];
const APP_DIRS = ["renderer", "styles", "assets"];
const PKG_FIELDS = ["name", "version", "description", "main", "license"];

// ---------- 0. 定位官方 asar ----------
function findAsar() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "electron-builder", "node_modules", "@electron", "asar", "bin", "asar.js"),
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "@electron", "asar", "bin", "asar.js"),
    path.join(ROOT, "node_modules", "@electron", "asar", "bin", "asar.js"),
    path.join(ROOT, "node_modules", "asar", "bin", "asar.js"),
    path.join(ROOT, "node_modules", "asar", "bin", "asar.cmd"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function runAsar(asarCli, args) {
  // .js 走 node，.cmd 直接执行
  if (asarCli.endsWith(".js")) execFileSync(process.execPath, [asarCli, ...args], { stdio: "inherit" });
  else execFileSync(asarCli, args, { stdio: "inherit" });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

/**
 * 找出占用目标 asar 的运行中主进程。
 *
 * 必须按「可执行文件的完整路径」匹配，而不是只按进程名：
 * 同一台机器上可能同时存在正式版与测试副本（同名 exe），
 * 只按名字会把另一个实例一起杀掉。
 */
function runningPids(exeName, targetDir) {
  const wanted = path.join(targetDir, `${exeName}.exe`).toLowerCase();
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='${exeName}.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("|");
        return { pid: l.slice(0, i), exe: l.slice(i + 1) };
      })
      // 拿不到路径时保守保留（宁可多问一句，也不要漏杀导致替换失败）
      .filter((r) => !r.exe || r.exe.toLowerCase() === wanted)
      .map((r) => r.pid);
  } catch {
    return [];
  }
}

(async function main() {
  // ---------- 定位 asar ----------
  step("定位 @electron/asar");
  const asarCli = findAsar();
  if (!asarCli) die("未找到 @electron/asar。请先安装：npm i -g electron-builder（或 npm i -D @electron/asar）");
  ok(asarCli);

  // ---------- 源码完整性 ----------
  step("检查源文件");
  const required = [
    ...APP_FILES, "package.json",
    ...APP_DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => `${d}/${e.name}`)),
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) die(`缺少文件: ${missing.join(", ")}`);
  ok(`${required.length} 个文件齐全`);

  // ---------- 构造 staging ----------
  step("构造 staging 目录");
  const stage = path.join(ROOT, "dist", ".stage");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const f of APP_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
  for (const d of APP_DIRS) fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true });

  const full = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const slim = {};
  for (const k of PKG_FIELDS) if (full[k] !== undefined) slim[k] = full[k];
  if (!slim.name || !slim.main) die(`精简 package.json 失败（得到: ${JSON.stringify(slim)}）`);
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(slim, null, 2) + "\n", "utf8");
  const staged = fs.readdirSync(stage, { recursive: true }).filter((f) => fs.statSync(path.join(stage, f)).isFile());
  ok(`${staged.length} 个文件，package.json 精简为 ${Object.keys(slim).join(", ")}`);

  // ---------- 打包 ----------
  step("用官方 @electron/asar 打包");
  const out = path.join(ROOT, "dist", "StickyTodo", "resources", "app.asar");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  runAsar(asarCli, ["pack", stage, out]);
  if (!fs.existsSync(out)) die("asar pack 未产出文件");
  const packedSize = fs.statSync(out).size;
  ok(`${out}  (${(packedSize / 1024).toFixed(1)} KB)`);

  // ---------- 校验 ----------
  step("校验打包结果");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-asar.js"), out, "--src", stage, "--list"], { stdio: "inherit" });
  } catch {
    die("校验未通过，已中止部署（目标目录未被改动）");
  }
  ok("打包内容与源文件逐字节一致");

  if (DRY) { warn("--dry-run：未写入目标目录"); return; }

  // ---------- 目标检查 ----------
  step(`检查目标 ${TARGET}`);
  const targetAsar = path.join(TARGET, "resources", "app.asar");
  const exePath = path.join(TARGET, `${EXE}.exe`);
  if (!fs.existsSync(TARGET)) die(`目标目录不存在: ${TARGET}`);
  if (!fs.existsSync(targetAsar)) die(`${TARGET} 下没有 resources/app.asar，可能不是有效的安装目录`);
  if (!fs.existsSync(exePath)) die(`找不到可执行文件: ${exePath}（可用 --exe 指定）`);

  const pids = runningPids(EXE, TARGET);
  if (pids.length) {
    warn(`正式版正在运行 (PID ${pids.join(",")})，app.asar 被占用`);
    let go = YES;
    if (!go) go = /^y/i.test(await ask("    结束进程后继续？(y/N) "));
    if (!go) die("已取消。请手动退出 StickyTodo 后重试");
    for (const pid of pids) {
      try { execFileSync("taskkill", ["/PID", pid, "/F", "/T"], { stdio: "ignore" }); } catch { /* 已退出 */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
    ok("已结束进程");
  } else {
    ok("无运行中的实例");
  }

  // ---------- 替换 ----------
  step("部署");
  const oldSize = fs.statSync(targetAsar).size;
  fs.copyFileSync(out, targetAsar);
  const newSize = fs.statSync(targetAsar).size;
  if (newSize !== packedSize) die(`写入后大小不符（期望 ${packedSize}，实际 ${newSize}）`);
  ok(`已替换 ${targetAsar}`);
  console.log(`    旧 ${(oldSize / 1024).toFixed(1)} KB  ->  新 ${(newSize / 1024).toFixed(1)} KB`);

  // ---------- 落地校验 ----------
  step("落地校验");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-asar.js"), targetAsar, "--src", stage], { stdio: "inherit" });
  } catch {
    die("部署后的文件校验失败！");
  }

  console.log(c.green(`\n部署完成。启动：${exePath}`));
})().catch((e) => die(e.message));
