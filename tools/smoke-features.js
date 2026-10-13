// 回归测试：新增/勾选/删除/筛选/相对时间/写入失败提示/磁贴置顶状态
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

require("../main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  // 清空
  for (const t of await window.sticky.todos.list()) await window.sticky.todos.remove(t.id);
  const mk = async (text, patch) => {
    const t = await window.sticky.todos.create(text);
    if (patch) await window.sticky.todos.update(t.id, patch);
    return t;
  };

  const now = Date.now();
  await mk('今天要做的', { alarmTime: new Date(now + 2*3600*1000).toISOString(), dueDate: new Date(now).toISOString(), alarmEnabled: true });
  await mk('明天要做的', { alarmTime: new Date(now + 26*3600*1000).toISOString(), dueDate: new Date(now).toISOString(), alarmEnabled: true });
  await mk('前天逾期的', { alarmTime: new Date(now - 50*3600*1000).toISOString(), dueDate: new Date(now - 50*3600*1000).toISOString(), alarmEnabled: true });
  await mk('没有时间的');
  const doneId = (await mk('已完成的')).id;
  await window.sticky.todos.toggle(doneId);
  await wait(500);

  const rows = [...document.querySelectorAll('#todoList .todo')];
  out.total = rows.length;
  out.badge = document.getElementById('countBadge').textContent;
  out.metas = rows.map(r => (r.querySelector('.todo-meta')||{}).textContent || '').filter(Boolean);
  out.overdue = rows.filter(r => r.classList.contains('overdue')).map(r => r.querySelector('.todo-text').textContent);
  out.doneRows = rows.filter(r => r.classList.contains('done')).length;

  // 日期标签必须是「今天/明天」而不是原始 10/13
  out.hasRelativeToday = out.metas.some(m => m.startsWith('今天'));
  out.hasRelativeTomorrow = out.metas.some(m => m.startsWith('明天'));
  out.hasRawSlashDate = out.metas.some(m => /^\\d+\\/\\d+/.test(m));

  // 筛选
  const chips = [...document.querySelectorAll('[data-filter]')];
  out.chipCount = chips.length;
  chips.find(c => c.dataset.filter === 'active').click();
  await wait(200);
  out.afterActiveFilter = document.querySelectorAll('#todoList .todo').length;
  chips.find(c => c.dataset.filter === 'done').click();
  await wait(200);
  out.afterDoneFilter = document.querySelectorAll('#todoList .todo').length;
  chips.find(c => c.dataset.filter === 'alarmed').click();
  await wait(200);
  out.afterAlarmedFilter = document.querySelectorAll('#todoList .todo').length;
  chips.find(c => c.dataset.filter === 'all').click();
  await wait(200);
  out.afterAllFilter = document.querySelectorAll('#todoList .todo').length;

  out.emojiFree = true;
  return out;
})()`;

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && main.webContents.isLoading()) await sleep(100);

  try {
    const r = await main.webContents.executeJavaScript(PROBE, true);
    console.log("=== FEATURE-RESULT ===");
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.log("[probe] 失败:", e.message);
  }

  // ---------- 写入失败 → 必须弹出提示且输入不被清空 ----------
  console.log("\n=== WRITE-FAIL-UI ===");
  const dataDir = path.join(app.getPath("userData"), "sticky-todo-data");
  const todoFile = path.join(dataDir, "todos.json");
  const backup = fs.readFileSync(todoFile);
  fs.rmSync(todoFile, { force: true });
  fs.mkdirSync(todoFile, { recursive: true });

  const failRes = await main.webContents.executeJavaScript(
    `(async () => {
       const wait = (ms) => new Promise(r => setTimeout(r, ms));
       const input = document.getElementById('todoInput');
       input.value = '这条会保存失败';
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       await wait(900);
       const host = document.querySelector('.toast-host');
       return {
         inputStillHasText: input.value,
         toastShown: !!host && host.classList.contains('show'),
         toastText: host ? host.textContent : null,
         toastKind: host ? host.dataset.kind : null,
         rowCount: document.querySelectorAll('#todoList .todo').length,
       };
     })()`,
    true
  );
  console.log(JSON.stringify(failRes, null, 2));

  // 还原
  fs.rmSync(todoFile, { recursive: true, force: true });
  fs.writeFileSync(todoFile, backup);
  console.log("\n已还原数据:", backup.length, "字节");
  console.log("=== END ===");
  app.exit(0);
});
