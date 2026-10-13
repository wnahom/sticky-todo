// 验证 DPI 修复：在 150% 屏上，重启后尺寸必须与配置一致（此前会被乘 1.5）
const { app, BrowserWindow, screen } = require("electron");
const fs = require("fs");
const path = require("path");

require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findTile = () =>
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("tile.html"));

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && main.webContents.isLoading()) await sleep(100);

  const cfgFile = path.join(app.getPath("userData"), "sticky-todo-data", "config.json");
  const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  const hi = screen.getAllDisplays().find((d) => d.scaleFactor > 1);

  console.log("=== DPI-FIX-TEST ===");
  console.log(`高 DPI 屏: scaleFactor=${hi.scaleFactor} workArea=${JSON.stringify(hi.workArea)}`);

  /** 写入指定 bounds 到配置，开磁贴，返回实际 bounds */
  async function trial(label, bounds, expect) {
    let t = findTile();
    if (t) { t.destroy(); await sleep(600); }
    const c = readCfg();
    c.tileBounds = bounds;
    fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
    // 主进程有配置缓存，这里换个方式：直接改内存配置缓存不可行，
    // 因此用 IPC 的 config:save 让它同步缓存
    await main.webContents.executeJavaScript(
      `window.sticky.config.save(${JSON.stringify({ tileBounds: bounds })})`, true);
    await sleep(300);

    main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
    t = null;
    for (let i = 0; i < 60; i++) { t = findTile(); if (t) break; await sleep(150); }
    if (!t) { console.log(`  ${label}: 磁贴未打开 FAIL`); return false; }
    while (t.webContents.isLoading()) await sleep(100);
    await sleep(800);
    const b = t.getBounds();
    const d = screen.getDisplayMatching(b);
    const ok = b.width === expect.w && b.height === expect.h;
    console.log(
      `  ${ok ? "OK  " : "FAIL"} ${label.padEnd(30)} 配置=${bounds.width}x${bounds.height}` +
      `${bounds.x !== undefined ? `@(${bounds.x},${bounds.y})` : ""} → 实际=${b.width}x${b.height}` +
      `@(${b.x},${b.y}) 屏=${d.scaleFactor}x` +
      (b.width === bounds.width ? "" : `  [宽差 ${(b.width / bounds.width).toFixed(3)}x]`)
    );
    return ok;
  }

  let pass = 0, total = 0;
  const cases = [
    ["150%屏上 220x300", { x: hi.workArea.x + 80, y: hi.workArea.y + 80, width: 220, height: 300 }, { w: 220, h: 300 }],
    ["150%屏上 250x340", { x: hi.workArea.x + 200, y: hi.workArea.y + 200, width: 250, height: 340 }, { w: 250, h: 340 }],
    ["150%屏上 300x420", { x: hi.workArea.x + 40, y: hi.workArea.y + 40, width: 300, height: 420 }, { w: 300, h: 420 }],
    ["跨屏边界处 260x360", { x: hi.workArea.x - 100, y: 100, width: 260, height: 360 }, { w: 260, h: 360 }],
    ["100%屏上 220x300", { x: 200, y: 200, width: 220, height: 300 }, { w: 220, h: 300 }],
  ];
  for (const [label, bounds, expect] of cases) {
    total++;
    if (await trial(label, bounds, expect)) pass++;
  }

  // 无记忆位置时：应按 tileWidth/Height 生效
  console.log("\n--- 无记忆位置（新装场景）---");
  total++;
  {
    let t = findTile();
    if (t) { t.destroy(); await sleep(600); }
    await main.webContents.executeJavaScript(
      `window.sticky.config.save(${JSON.stringify({ tileBounds: null, tileWidth: 230, tileHeight: 310 })})`, true);
    await sleep(300);
    main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
    t = null;
    for (let i = 0; i < 60; i++) { t = findTile(); if (t) break; await sleep(150); }
    while (t && t.webContents.isLoading()) await sleep(100);
    await sleep(800);
    const b = t.getBounds();
    const ok = b.width === 230 && b.height === 310;
    console.log(`  ${ok ? "OK  " : "FAIL"} tileWidth/Height=230x310 → 实际=${b.width}x${b.height}`);
    if (ok) pass++;
  }

  console.log(`\n结果: ${pass}/${total} 通过`);
  console.log("=== END ===");
  app.exit(pass === total ? 0 : 1);
});
