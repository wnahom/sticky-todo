const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// ============================================================
// 数据层
// ============================================================
const DATA_DIR = path.join(app.getPath("userData"), "sticky-todo-data");
const TODO_FILE = path.join(DATA_DIR, "todos.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadTodos() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(TODO_FILE, "utf-8")); } catch { return []; }
}
function saveTodos(d) { ensureDir(); fs.writeFileSync(TODO_FILE, JSON.stringify(d, null, 2), "utf-8"); }

function loadConfig() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); }
  catch { return { opacity: 0.92, alarmSound: true, tileWidth: 260, tileHeight: 360 }; }
}
function saveConfig(c) { ensureDir(); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), "utf-8"); }

// ============================================================
// 闹钟引擎
// ============================================================
let alarmInt = null;
let notified = new Set();

function startAlarm() {
  if (alarmInt) clearInterval(alarmInt);
  notified.clear();
  alarmInt = setInterval(() => {
    const todos = loadTodos();
    const now = Date.now();
    todos.forEach(t => {
      if (t.done || !t.alarmEnabled || !t.alarmTime) return;
      const ms = new Date(t.alarmTime).getTime();
      if (Math.abs(now - ms) < 30000 && !notified.has(t.id)) {
        notified.add(t.id);
        const n = new Notification({ title: "⏰ 待办提醒", body: t.text, silent: !loadConfig().alarmSound });
        n.on("click", () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } });
        n.show();
      }
    });
  }, 10000);
}

// ============================================================
// 窗口
// ============================================================
let mainWin = null;
let tileWin = null;
let tray = null;

function createMain() {
  mainWin = new BrowserWindow({
    width: 900, height: 620, minWidth: 700, minHeight: 500,
    title: "Sticky Todo",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(path.join(__dirname, "app.html"));
  mainWin.on("close", e => { if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); } });
}

function createTile() {
  const cfg = loadConfig();
  tileWin = new BrowserWindow({
    width: cfg.tileWidth || 260, height: cfg.tileHeight || 360, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  tileWin.loadFile(path.join(__dirname, "app.html"), { hash: "/tile" });
  tileWin.setOpacity(cfg.opacity || 0.92);
}

function toggleTile() {
  if (tileWin && !tileWin.isDestroyed()) {
    tileWin.isVisible() ? tileWin.hide() : (tileWin.show(), tileWin.focus());
  } else { createTile(); }
}

// ============================================================
// 托盘
// ============================================================
function createTray() {
  try {
    const p = path.join(__dirname, "assets", "icon.png");
    tray = new Tray(fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty());
  } catch { tray = new Tray(nativeImage.createEmpty()); }
  tray.setToolTip("Sticky Todo");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开", click: () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); } },
    { type: "separator" },
    { label: "磁贴", click: toggleTile },
    { type: "separator" },
    { label: "退出", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); });
}

// ============================================================
// IPC
// ============================================================
function setupIPC() {
  ipcMain.handle("todos:list", () => loadTodos());
  ipcMain.handle("todos:create", (_, text) => {
    const todos = loadTodos();
    const t = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), text, done: false, createdAt: new Date().toISOString(), dueDate: null, alarmEnabled: false, alarmTime: null };
    todos.unshift(t); saveTodos(todos); notify(); return t;
  });
  ipcMain.handle("todos:update", (_, id, updates) => {
    const todos = loadTodos();
    const i = todos.findIndex(x => x.id === id);
    if (i === -1) return null;
    todos[i] = { ...todos[i], ...updates }; saveTodos(todos); notify(); return todos[i];
  });
  ipcMain.handle("todos:delete", (_, id) => { saveTodos(loadTodos().filter(x => x.id !== id)); notify(); });
  ipcMain.handle("todos:toggle", (_, id) => {
    const todos = loadTodos();
    const i = todos.findIndex(x => x.id === id);
    if (i === -1) return null;
    todos[i].done = !todos[i].done; saveTodos(todos); notify(); return todos[i];
  });
  ipcMain.handle("config:get", () => loadConfig());
  ipcMain.handle("config:save", (_, c) => saveConfig(c));
  ipcMain.handle("tile:close", () => { if (tileWin) { tileWin.close(); tileWin = null; } });
  ipcMain.handle("tile:toggle", () => toggleTile());
  ipcMain.handle("tile:pin", () => {
    if (tileWin && !tileWin.isDestroyed()) {
      const onTop = !tileWin.isAlwaysOnTop();
      tileWin.setAlwaysOnTop(onTop);
      return onTop;
    }
    return false;
  });
  ipcMain.handle("tile:resize", (_, w, h) => {
    if (tileWin && !tileWin.isDestroyed()) {
      tileWin.setSize(w, h);
    }
  });
  ipcMain.handle("autostart:get", () => {
    try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
  });
  ipcMain.handle("autostart:set", (_, enable) => {
    try { app.setLoginItemSettings({ openAtLogin: enable }); return true; } catch { return false; }
  });
}

function notify() {
  const d = loadTodos();
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("todos-changed", d);
  if (tileWin && !tileWin.isDestroyed()) tileWin.webContents.send("todos-changed", d);
}

function createMenu() {
  const template = [
    {
      label: '便签待办',
      submenu: [
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.webContents.send('open-settings'); } } },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
// ============================================================
// 快捷键
// ============================================================
function regShortcut() {
  globalShortcut.unregisterAll();
  try { globalShortcut.register("Ctrl+Shift+Space", toggleTile); } catch {}
}

// ============================================================
// 生命周期
// ============================================================
app.isQuitting = false;

app.whenReady().then(() => {
  setupIPC();
  createMain();
  createMenu();
  createTray();
  regShortcut();
  startAlarm();
  if (process.argv.includes("--dev") && mainWin) mainWin.webContents.openDevTools();
});

app.on("before-quit", () => { app.isQuitting = true; if (alarmInt) clearInterval(alarmInt); globalShortcut.unregisterAll(); });
app.on("window-all-closed", () => {});
app.on("activate", () => { if (mainWin && !mainWin.isDestroyed()) mainWin.show(); });
