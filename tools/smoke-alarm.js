// 验证应用内提醒：到点弹窗、多个提醒、推迟、完成、关闭
// 注意：调用 fireAlarm 的路径是 checkAlarms()（每 5 秒轮询），
// 这里直接把 alarmTime 设成「刚刚过去」，等轮询自然触发。
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findAlarmWin = () =>
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("alarm.html"));

async function waitFor(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && main.webContents.isLoading()) await sleep(100);

  console.log("=== ALARM-TEST ===");

  // 清空
  await main.webContents.executeJavaScript(
    `(async () => { for (const t of await window.sticky.todos.list()) await window.sticky.todos.remove(t.id); })()`, true);

  // 造一条「提醒时间已过」的待办 —— 与用户遇到的情形一致
  const id = await main.webContents.executeJavaScript(
    `(async () => {
       const t = await window.sticky.todos.create('考试提醒测试');
       await window.sticky.todos.update(t.id, {
         alarmTime: new Date(Date.now() - 3000).toISOString(),
         alarmEnabled: true,
       });
       return t.id;
     })()`, true);
  console.log("已创建待办 id =", id, "（提醒时间 3 秒前，等轮询触发）");

  // 等 checkAlarms 轮询（间隔 5 秒）
  const win = await waitFor(findAlarmWin, 15000);
  if (!win) { console.log("提醒窗口未出现 FAIL"); app.exit(1); return; }
  await sleep(900);
  console.log("提醒窗口已弹出 ✓");

  const view = await win.webContents.executeJavaScript(`({
    text: document.getElementById('alarmText').textContent,
    time: document.getElementById('alarmTime').textContent,
    more: document.getElementById('moreLabel').textContent,
    buttons: [...document.querySelectorAll('.alarm-actions button')].map(b => b.textContent.trim()),
    alwaysOnTop: null,
  })`, true);
  console.log("窗口内容:", JSON.stringify(view));
  console.log("alwaysOnTop =", win.isAlwaysOnTop(), "| 可见 =", win.isVisible());
  console.log("位置:", JSON.stringify(win.getBounds()));

  // ---------- 推迟 10 分钟 ----------
  await win.webContents.executeJavaScript(`document.getElementById('btnSnooze').click()`, true);
  await sleep(1200);
  const afterSnooze = await main.webContents.executeJavaScript(
    `(async () => { const t = (await window.sticky.todos.list())[0]; return { alarmTime: t.alarmTime, enabled: t.alarmEnabled }; })()`, true);
  const mins = Math.round((new Date(afterSnooze.alarmTime).getTime() - Date.now()) / 60000);
  console.log("\n推迟后:", JSON.stringify(afterSnooze), `-> 约 ${mins} 分钟后`);
  console.log("提醒窗口已关闭?", findAlarmWin() ? "否 FAIL" : "是 OK");
  const fired = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "sticky-todo-data", "alarms-fired.json"), "utf8"));
  console.log("已触发标记已清除?", fired[id] === undefined ? "是 OK（推迟后能再次触发）" : "否 FAIL");

  // ---------- 两条同时到点 ----------
  console.log("\n--- 两条同时到点 ---");
  await main.webContents.executeJavaScript(
    `(async () => {
       for (const t of await window.sticky.todos.list()) await window.sticky.todos.remove(t.id);
       for (const txt of ['A 提醒','B 提醒']) {
         const t = await window.sticky.todos.create(txt);
         await window.sticky.todos.update(t.id, { alarmTime: new Date(Date.now()-3000).toISOString(), alarmEnabled: true });
       }
     })()`, true);
  const win2 = await waitFor(findAlarmWin, 15000);
  await sleep(1500);
  const multi = await win2.webContents.executeJavaScript(`({
    text: document.getElementById('alarmText').textContent,
    more: document.getElementById('moreLabel').textContent,
  })`, true);
  console.log("两条到点:", JSON.stringify(multi));

  // ---------- 标记完成 ----------
  await win2.webContents.executeJavaScript(`document.getElementById('btnDone').click()`, true);
  await sleep(1500);
  const afterDone = await main.webContents.executeJavaScript(
    `(async () => (await window.sticky.todos.list()).filter(t => t.done).map(t => t.text))()`, true);
  console.log("标记完成后已完成的条目:", JSON.stringify(afterDone));

  // ---------- 知道了（剩下那条）----------
  const win3 = findAlarmWin();
  if (win3) {
    await win3.webContents.executeJavaScript(`document.getElementById('btnDismiss').click()`, true);
    await sleep(1000);
  }
  console.log("全部处理完，提醒窗口还在?", findAlarmWin() ? "在 FAIL" : "已关闭 OK");

  // 清理
  await main.webContents.executeJavaScript(
    `(async () => { for (const t of await window.sticky.todos.list()) await window.sticky.todos.remove(t.id); })()`, true);
  console.log("=== END ===");
  app.exit(0);
});
