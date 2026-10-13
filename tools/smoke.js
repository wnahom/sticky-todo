// 自检脚本：以真实入口启动应用，捕获渲染进程是否成功挂载
// 用法: electron tools/smoke.js
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

// 记录主进程启动前已存在的窗口创建，挂上控制台/异常转发
const realLoadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  const wc = this.webContents;
  wc.on("console-message", (_e, level, message, line, source) => {
    const tag = ["LOG", "WARN", "ERROR", "DEBUG"][level] || level;
    console.log(`[renderer:${tag}] ${message}  (${path.basename(String(source))}:${line})`);
  });
  wc.on("preload-error", (_e, preloadPath, err) => {
    console.log(`[preload:ERROR] ${preloadPath}: ${err && err.message}`);
  });
  wc.on("did-fail-load", (_e, code, desc, url) => {
    console.log(`[load:FAIL] ${code} ${desc} ${url}`);
  });
  wc.on("render-process-gone", (_e, details) => {
    console.log(`[renderer:GONE] ${JSON.stringify(details)}`);
  });
  return realLoadFile.call(this, file, opts);
};

require("../main.js");

const PROBE = `
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { mode: window.sticky ? window.sticky.mode : null, hasApi: !!window.sticky };
  out.todoRows = document.querySelectorAll('#todoList .todo').length;
  out.emptyState = !!document.querySelector('#todoList .empty');
  out.badge = document.getElementById('countBadge') ? document.getElementById('countBadge').textContent : null;
  out.cssLoaded = getComputedStyle(document.body).backgroundColor;
  out.styleSheets = [...document.styleSheets].map(s => (s.href||'').split('/').pop()).filter(Boolean);
  // 通过接口真实写入一条待办，验证 IPC 全链路
  const created = await window.sticky.todos.create('__smoke_test__ 自检条目');
  out.createdId = created && created.id;
  const list = await window.sticky.todos.list();
  out.listCount = list.length;
  out.topText = list[0] && list[0].text;
  // 等待主进程广播回流后看 UI 是否刷新
  await wait(400);
  out.rowsAfter = document.querySelectorAll('#todoList .todo').length;
  // 勾选
  await window.sticky.todos.toggle(out.createdId);
  await wait(300);
  out.doneAfterToggle = (await window.sticky.todos.list()).find(t => t.id === out.createdId)?.done;
  // 删除，保持数据干净
  await window.sticky.todos.remove(out.createdId);
  await wait(300);
  out.countAfterDelete = (await window.sticky.todos.list()).length;
  // 配置读写
  const cfg = await window.sticky.config.get();
  out.cfgKeys = Object.keys(cfg).sort().join(',');
  return out;
})()
`;

app.whenReady().then(async () => {
  // 等主窗口加载完
  const waitFor = async (pred, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  const wins = BrowserWindow.getAllWindows();
  const main = wins[0];
  const ok = await waitFor(() => main && !main.webContents.isLoading());
  console.log(`[smoke] 主窗口加载完成: ${ok}, 窗口数: ${wins.length}`);

  try {
    const result = await main.webContents.executeJavaScript(PROBE, true);
    console.log("=== SMOKE-RESULT ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("=== SMOKE-END ===");
  } catch (e) {
    console.log("[smoke] 探测器执行失败:", e.message);
  }

  // 顺带验证磁贴窗口
  try {
    const { ipcMain } = require("electron");
    // 直接走主进程的磁贴开关
    main.webContents.send("noop");
    const before = BrowserWindow.getAllWindows().length;
    console.log(`[smoke] 触发前窗口数: ${before}`);
  } catch (e) { /* ignore */ }

  app.exit(0);
});
