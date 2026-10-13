// 验证尺寸滑块修复：
//  1) 磁贴开着时改设置 → 立刻生效
//  2) 磁贴关着时改设置 → 下次打开生效（这是原 bug：被旧 tileBounds 盖掉）
//  3) 拖动磁贴 → 设置面板滑块同步
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findTile() {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("tile.html"));
}
async function waitTile(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = findTile();
    if (t) return t;
    await sleep(150);
  }
  return null;
}

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && main.webContents.isLoading()) await sleep(100);
  const cfgFile = path.join(app.getPath("userData"), "sticky-todo-data", "config.json");
  const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, "utf8"));

  console.log("=== TILE-RESIZE-TEST ===");

  // ---------- 场景 1：磁贴开着时改尺寸 ----------
  main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
  let tile = await waitTile();
  if (!tile) { console.log("磁贴打不开 FAIL"); app.exit(1); return; }
  while (tile.webContents.isLoading()) await sleep(100);
  await sleep(500);
  console.log("1) 初始 bounds      :", JSON.stringify(tile.getBounds()));

  const r1 = await main.webContents.executeJavaScript(
    `(async () => { const r = await window.sticky.tile.resize(440, 300); await new Promise(s=>setTimeout(s,700)); return r; })()`, true);
  await sleep(900);
  console.log("   resize() 返回    :", JSON.stringify(r1));
  console.log("   实际 bounds      :", JSON.stringify(tile.getBounds()));
  const cfg1 = readCfg();
  console.log("   配置 tileW/H     :", cfg1.tileWidth, "x", cfg1.tileHeight, "| tileBounds:",
    cfg1.tileBounds ? `${cfg1.tileBounds.width}x${cfg1.tileBounds.height}` : "null");
  const ok1 = tile.getBounds().width === 440 && tile.getBounds().height === 300;
  console.log("   ->", ok1 ? "开着时立刻生效 OK" : "未生效 FAIL");

  // ---------- 场景 2：磁贴关掉后改尺寸，再打开 ----------
  tile.destroy();
  await sleep(700);
  console.log("\n2) 磁贴已关闭，现在改尺寸为 300x400");
  await main.webContents.executeJavaScript(`window.sticky.tile.resize(300, 400)`, true);
  await sleep(600);
  const cfg2 = readCfg();
  console.log("   配置 tileW/H     :", cfg2.tileWidth, "x", cfg2.tileHeight,
    "| tileBounds:", cfg2.tileBounds === null ? "null（已清除，关键）" : JSON.stringify(cfg2.tileBounds));

  main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
  tile = await waitTile();
  while (tile.webContents.isLoading()) await sleep(100);
  await sleep(700);
  const b2 = tile.getBounds();
  console.log("   重新打开 bounds  :", JSON.stringify(b2));
  const ok2 = b2.width === 300 && b2.height === 400;
  console.log("   ->", ok2 ? "关着时改的尺寸在下次打开生效 OK" : "被旧 tileBounds 盖掉了 FAIL");

  // ---------- 场景 3：拖动磁贴，设置面板滑块同步 ----------
  console.log("\n3) 打开设置面板，然后程序化缩放磁贴，检查滑块是否同步");
  await main.webContents.executeJavaScript(`(async () => { document.getElementById('btnSettings').click(); await new Promise(s=>setTimeout(s,700)); })()`, true);
  const before = await main.webContents.executeJavaScript(
    `({ tw: document.getElementById('settingTW').value, th: document.getElementById('settingTH').value })`, true);
  console.log("   改尺寸前滑块     :", JSON.stringify(before));

  tile.setSize(360, 260);
  await sleep(1400); // 等防抖 500ms + 广播

  const after = await main.webContents.executeJavaScript(
    `({ tw: document.getElementById('settingTW').value, th: document.getElementById('settingTH').value,
        twLabel: document.getElementById('twVal').textContent, thLabel: document.getElementById('thVal').textContent })`, true);
  console.log("   缩放后滑块       :", JSON.stringify(after));
  const ok3 = after.tw === "360" && after.th === "260";
  console.log("   ->", ok3 ? "滑块跟着磁贴实际尺寸同步 OK" : "滑块未同步 FAIL");

  // ---------- 场景 4：设置面板自身读取的是实际 bounds ----------
  console.log("\n4) 关闭再打开设置面板，检查初始显示");
  await main.webContents.executeJavaScript(`(async () => {
    document.getElementById('btnCloseSettings').click();
    await new Promise(s=>setTimeout(s,800));
    document.getElementById('btnSettings').click();
    await new Promise(s=>setTimeout(s,700));
  })()`, true);
  const reopen = await main.webContents.executeJavaScript(
    `({ tw: document.getElementById('settingTW').value, th: document.getElementById('settingTH').value })`, true);
  const actual = tile.getBounds();
  console.log("   面板显示         :", JSON.stringify(reopen), "| 窗口实际:", `${actual.width}x${actual.height}`);
  const ok4 = reopen.tw === String(actual.width) && reopen.th === String(actual.height);
  console.log("   ->", ok4 ? "面板显示与窗口一致 OK" : "显示不一致 FAIL");

  console.log("\n=== 汇总 ===");
  console.log(`场景1 开着时改尺寸 : ${ok1 ? "OK" : "FAIL"}`);
  console.log(`场景2 关着时改尺寸 : ${ok2 ? "OK" : "FAIL"}`);
  console.log(`场景3 拖动后同步   : ${ok3 ? "OK" : "FAIL"}`);
  console.log(`场景4 面板显示一致 : ${ok4 ? "OK" : "FAIL"}`);

  // 还原成默认尺寸
  await main.webContents.executeJavaScript(`window.sticky.tile.resize(260, 360)`, true);
  await main.webContents.executeJavaScript(`document.getElementById('btnCloseSettings').click()`, true).catch(() => {});
  console.log("=== END ===");
  app.exit(0);
});
