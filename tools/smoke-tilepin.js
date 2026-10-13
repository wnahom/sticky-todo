// 验证磁贴：置顶状态同步/持久化、Esc 关闭、列表内容
const { app, BrowserWindow } = require("electron");

require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && main.webContents.isLoading()) await sleep(100);

  await main.webContents.executeJavaScript(
    `(async () => {
       for (const t of await window.sticky.todos.list()) await window.sticky.todos.remove(t.id);
       await window.sticky.todos.create('tile-test-plain');
       await window.sticky.todos.create('tile-test-alarmed');
     })()`, true);
  await sleep(300);

  console.log("=== TILE-TEST ===");
  const cfg0 = await main.webContents.executeJavaScript(`window.sticky.config.get()`, true);
  console.log("initial tilePinned =", cfg0.tilePinned);

  // 监听窗口创建，便于诊断
  const { ipcMain } = require("electron");
  main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
  for (let i = 0; i < 100; i++) {
    const ws = BrowserWindow.getAllWindows();
    if (i % 10 === 0) console.log(`  t=${i * 200}ms windows=${ws.length} urls=${JSON.stringify(ws.map(w => w.webContents.getURL().split('/').pop()))}`);
    if (ws.length >= 2) break;
    await sleep(200);
  }
  const tile = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("tile.html"));
  if (!tile) { console.log("tile did not open FAIL"); app.exit(1); return; }
  while (tile.webContents.isLoading()) await sleep(100);
  await sleep(500);

  const r1 = await tile.webContents.executeJavaScript(`(async () => ({
    mode: window.sticky.mode,
    rows: document.querySelectorAll('#tileList .todo').length,
    pinBtnActive: document.getElementById('tilePinBtn').classList.contains('active'),
    pinnedFromMain: await window.sticky.tile.pinned(),
  }))()`, true);
  console.log("on open     :", JSON.stringify(r1));

  const r2 = await tile.webContents.executeJavaScript(`(async () => {
    document.getElementById('tilePinBtn').click();
    await new Promise(r => setTimeout(r, 400));
    return { pinBtnActive: document.getElementById('tilePinBtn').classList.contains('active'), pinnedFromMain: await window.sticky.tile.pinned() };
  })()`, true);
  console.log("after unpin :", JSON.stringify(r2), "| win.isAlwaysOnTop =", tile.isAlwaysOnTop());

  const cfg1 = await main.webContents.executeJavaScript(`window.sticky.config.get()`, true);
  console.log("persisted tilePinned =", cfg1.tilePinned);

  tile.destroy();
  await sleep(600);
  main.webContents.executeJavaScript(`window.sticky.tile.show()`, true).catch(() => {});
  let tile2 = null;
  for (let i = 0; i < 100; i++) {
    const found = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("tile.html"));
    if (found) { tile2 = found; break; }
    await sleep(200);
  }
  if (!tile2) { console.log("tile did not reopen FAIL"); app.exit(1); return; }
  while (tile2.webContents.isLoading()) await sleep(100);
  await sleep(700);

  const r3 = await tile2.webContents.executeJavaScript(`(async () => ({
    pinBtnActive: document.getElementById('tilePinBtn').classList.contains('active'),
    pinnedFromMain: await window.sticky.tile.pinned(),
    rows: document.querySelectorAll('#tileList .todo').length,
  }))()`, true);
  console.log("after rebuild:", JSON.stringify(r3), "| win.isAlwaysOnTop =", tile2.isAlwaysOnTop());

  // 关键断言：重建后 按钮状态 / IPC 上报 / 真实窗口属性 三者必须一致，
  // 且与重建前持久化的 tilePinned 相同（原实现把按钮写死为 active）
  const consistent =
    r3.pinBtnActive === r3.pinnedFromMain &&
    r3.pinnedFromMain === tile2.isAlwaysOnTop() &&
    r3.pinnedFromMain === cfg1.tilePinned;
  console.log(
    consistent
      ? `>>> 重建后三者一致且等于持久化值 (${cfg1.tilePinned}) OK`
      : `>>> 不一致 FAIL  按钮=${r3.pinBtnActive} IPC=${r3.pinnedFromMain} 窗口=${tile2.isAlwaysOnTop()} 持久化=${cfg1.tilePinned}`
  );

  await tile2.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`, true);
  await sleep(400);
  console.log("visible after Esc?", tile2.isVisible(), "->", tile2.isVisible() ? "NOT hidden FAIL" : "hidden OK");

  await main.webContents.executeJavaScript(
    `(async () => { for (const t of await window.sticky.todos.list()) await window.sticky.todos.remove(t.id); })()`, true);
  await main.webContents.executeJavaScript(`window.sticky.config.save({ tilePinned: true })`, true);
  console.log("=== END ===");
  app.exit(0);
});
