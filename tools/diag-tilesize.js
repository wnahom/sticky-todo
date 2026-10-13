// 诊断磁贴尺寸：配置值 vs 记忆位置 vs 实际窗口尺寸 vs 设置滑块
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath("userData"), "sticky-todo-data");
  const cfgFile = path.join(dataDir, "config.json");

  console.log("=== TILE-SIZE-DIAG ===");
  console.log("userData      :", app.getPath("userData"));
  console.log("config.json   :", fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf8").replace(/\s+/g, " ") : "(不存在)");

  const main = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && main.webContents.isLoading()) await sleep(100);

  const cfg = await main.webContents.executeJavaScript(`window.sticky.config.get()`, true);
  console.log("config:get ->", JSON.stringify(cfg));

  // 打开磁贴并测量
  main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
  let tile = null;
  for (let i = 0; i < 60; i++) {
    tile = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("tile.html"));
    if (tile) break;
    await sleep(200);
  }
  if (!tile) { console.log("磁贴未打开"); app.exit(1); return; }
  while (tile.webContents.isLoading()) await sleep(100);
  await sleep(600);

  const b = tile.getBounds();
  console.log("实际窗口 bounds :", JSON.stringify(b));

  // 设置面板滑块读取的值
  const sliders = await main.webContents.executeJavaScript(`(async () => {
    document.getElementById('btnSettings').click();
    await new Promise(r => setTimeout(r, 600));
    const tw = document.getElementById('settingTW');
    const th = document.getElementById('settingTH');
    return { twValue: tw.value, thValue: th.value,
             twRange: tw.min + '~' + tw.max, thRange: th.min + '~' + th.max,
             twLabel: document.getElementById('twVal').textContent,
             thLabel: document.getElementById('thVal').textContent };
  })()`, true);
  console.log("设置面板滑块 :", JSON.stringify(sliders));

  // CSS 实际可用宽度（窗口 250 宽，扣掉滚动条/内边距后内容区多少）
  const inner = await tile.webContents.executeJavaScript(`({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    listClientWidth: document.getElementById('tileList').clientWidth,
    firstTextWidth: (() => { const e = document.querySelector('.todo-text'); return e ? Math.round(e.getBoundingClientRect().width) : null; })(),
    textSample: (() => { const e = document.querySelector('.todo-text'); return e ? e.textContent.slice(0, 24) : null; })(),
    truncated: (() => { const e = document.querySelector('.todo-text'); return e ? e.scrollWidth > e.clientWidth + 1 : null; })(),
  })`, true);
  console.log("磁贴内部尺寸 :", JSON.stringify(inner));

  console.log("\n=== 结论 ===");
  console.log(`配置里的 tileWidth/Height = ${cfg.tileWidth} x ${cfg.tileHeight}`);
  console.log(`tileBounds 记忆           = ${JSON.stringify(cfg.tileBounds)}`);
  console.log(`实际生效尺寸              = ${b.width} x ${b.height}`);
  console.log(`滑块显示                  = ${sliders.twValue} x ${sliders.thValue}`);

  // 还原：关闭设置面板
  await main.webContents.executeJavaScript(`document.getElementById('btnSettings').click()`, true).catch(() => {});
  console.log("=== END ===");
  app.exit(0);
});
