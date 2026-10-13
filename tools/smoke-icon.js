// 验证压缩后的图标能被托盘与窗口正常使用
const { app, BrowserWindow, Tray, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

require("../main.js");

app.whenReady().then(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1200);

  const p = path.join(__dirname, "..", "assets", "icon.png");
  const raw = nativeImage.createFromPath(p);
  const traySized = raw.resize({ width: 16, height: 16 });

  console.log("=== ICON-RESULT ===");
  console.log(JSON.stringify({
    file: p,
    fileBytes: fs.statSync(p).size,
    readable: !raw.isEmpty(),
    sourceSize: raw.getSize(),
    traySize: traySized.getSize(),
    trayNotBlank: !traySized.isEmpty() && traySized.toPNG().length > 100,
    trayPngBytes: traySized.toPNG().length,
    // 托盘实际是否建成（主进程 createTray 已执行）
    windows: BrowserWindow.getAllWindows().length,
  }, null, 2));
  console.log("=== END ===");
  app.exit(0);
});
