// ============================================================
// StickyTodo 主进程
// 职责：数据持久化 / 窗口与托盘 / 全局快捷键 / 闹钟调度 / IPC
// ============================================================
const {
  app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu,
  Notification, nativeImage, screen,
} = require("electron");
const path = require("path");
const fs = require("fs");

// ============================================================
// H1 数据隔离：开发版必须写自己的目录，绝不能碰正式版数据
// ------------------------------------------------------------
// 打包后 app.getName() === "sticky-todo"（取自 package.json），
// 与开发版解析结果完全相同 —— 若不隔离，`npm start` 会直接覆写
// 用户 %APPDATA%\sticky-todo\sticky-todo-data\todos.json。
// 必须在 app.whenReady() 之前调用。
// ============================================================
const IS_DEV = !app.isPackaged;
if (IS_DEV) {
  app.setPath("userData", path.join(app.getPath("appData"), "sticky-todo-dev"));
}

const DATA_DIR = path.join(app.getPath("userData"), "sticky-todo-data");
const TODO_FILE = path.join(DATA_DIR, "todos.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const FIRED_FILE = path.join(DATA_DIR, "alarms-fired.json");
const BACKUP_KEEP = 3;

const DEFAULT_CONFIG = {
  opacity: 0.92,
  alarmSound: true,
  tileWidth: 260,
  tileHeight: 360,
  tileBounds: null,
};

// ============================================================
// 数据层
// ============================================================
function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * H2 原子写入：先写 .tmp，再 rename 覆盖，并轮换 .bak。
 * 直接 writeFileSync 覆盖原文件时若中途崩溃，会留下截断的 JSON，
 * 下一次 load 静默返回 []，随后一次保存就会清空用户全部待办。
 */
function atomicWrite(file, content) {
  ensureDir();
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd); // 先落盘，再允许 rename
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, bak);
    } catch { /* 备份失败不应阻断保存 */ }
  }
  fs.renameSync(tmp, file);
}

/**
 * 读取并解析 JSON。返回 { ok, data } 以便调用方区分
 * 「文件不存在（首次运行）」与「文件存在但已损坏」。
 */
function readJson(file) {
  if (!fs.existsSync(file)) return { ok: false, missing: true, data: null };
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, missing: false, data: null, raw };
  }
}

/** 损坏文件改名留档，绝不静默丢弃用户数据 */
function quarantine(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${file}.corrupt-${stamp}`;
    fs.renameSync(file, dest);
    console.error(`[sticky] ${path.basename(file)} 解析失败，已留档为 ${path.basename(dest)}`);
    return dest;
  } catch (e) {
    console.error("[sticky] 留档损坏文件失败:", e.message);
    return null;
  }
}

function loadTodos() {
  try {
    const r = readJson(TODO_FILE);
    if (r.ok && Array.isArray(r.data)) return r.data;
    if (!r.missing) {
      quarantine(TODO_FILE);
      // 主文件损坏时尝试回退到备份，避免用户看到"待办全没了"
      const b = readJson(`${TODO_FILE}.bak`);
      if (b.ok && Array.isArray(b.data)) {
        console.warn("[sticky] 已从 todos.json.bak 恢复");
        return b.data;
      }
    }
    return [];
  } catch (e) {
    console.error("[sticky] 读取待办失败:", e.message);
    return [];
  }
}

function saveTodos(list) {
  atomicWrite(TODO_FILE, JSON.stringify(list, null, 2));
}

function loadConfig() {
  try {
    const r = readJson(CONFIG_FILE);
    if (r.ok && r.data && typeof r.data === "object") {
      return { ...DEFAULT_CONFIG, ...r.data };
    }
    if (!r.missing) {
      quarantine(CONFIG_FILE);
      const b = readJson(`${CONFIG_FILE}.bak`);
      if (b.ok && b.data && typeof b.data === "object") return { ...DEFAULT_CONFIG, ...b.data };
    }
    return { ...DEFAULT_CONFIG };
  } catch (e) {
    console.error("[sticky] 读取配置失败:", e.message);
    return { ...DEFAULT_CONFIG };
  }
}

// 配置缓存：原实现每次弹通知都同步重读并解析 config.json
let configCache = null;
function cfg() {
  if (!configCache) configCache = loadConfig();
  return configCache;
}
function saveConfig(patch) {
  configCache = { ...cfg(), ...patch };
  atomicWrite(CONFIG_FILE, JSON.stringify(configCache, null, 2));
  return configCache;
}

// ============================================================
// 已触发闹钟：跨重启持久化，避免重启后重复提醒同一条
// ============================================================
function loadFired() {
  try {
    const r = readJson(FIRED_FILE);
    return r.ok && r.data && typeof r.data === "object" ? r.data : {};
  } catch { return {}; }
}
function saveFired(map) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const trimmed = {};
  for (const [k, v] of Object.entries(map)) if (v > cutoff) trimmed[k] = v;
  atomicWrite(FIRED_FILE, JSON.stringify(trimmed, null, 2));
}

// ============================================================
// 窗口
// ============================================================
let mainWin = null;
let tileWin = null;
let tray = null;
let tileSaveTimer = null;

function createMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    show: false,
    title: "便签待办",
    backgroundColor: "#f5f0eb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, "renderer", "main.html"), { query: { mode: "main" } });
  mainWin.once("ready-to-show", () => mainWin.show());
  // 关窗即隐藏，常驻托盘
  mainWin.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on("closed", () => { mainWin = null; });
}

/** 校验记忆的磁贴位置是否仍落在当前某块屏幕内，否则回退居中 */
function usableBounds(saved) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  const w = Math.min(Math.max(saved.width || 260, 180), 2000);
  const h = Math.min(Math.max(saved.height || 360, 150), 2000);
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    if (
      saved.x + w > wa.x + 20 && saved.x < wa.x + wa.width - 20 &&
      saved.y + h > wa.y + 20 && saved.y < wa.y + wa.height - 20
    ) {
      return { x: Math.round(saved.x), y: Math.round(saved.y), width: w, height: h };
    }
  }
  return null; // 原屏幕已拔掉/分辨率变了 → 用默认位置
}

function rememberTileBounds() {
  if (!tileWin || tileWin.isDestroyed() || tileWin.isMinimized()) return;
  if (tileSaveTimer) clearTimeout(tileSaveTimer);
  // 拖动/缩放会高频触发，防抖后再落盘
  tileSaveTimer = setTimeout(() => {
    if (!tileWin || tileWin.isDestroyed()) return;
    const b = tileWin.getBounds();
    saveConfig({ tileBounds: b, tileWidth: b.width, tileHeight: b.height });
  }, 500);
}

function createTile() {
  const c = cfg();
  const saved = usableBounds(c.tileBounds);
  tileWin = new BrowserWindow({
    width: saved ? saved.width : (c.tileWidth || 260),
    height: saved ? saved.height : (c.tileHeight || 360),
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tileWin.loadFile(path.join(__dirname, "renderer", "tile.html"), { query: { mode: "tile" } });
  tileWin.once("ready-to-show", () => {
    if (!tileWin || tileWin.isDestroyed()) return;
    tileWin.setOpacity(c.opacity ?? 0.92); // 创建时即应用，修正首启不透明的问题
    tileWin.show();
  });
  tileWin.on("move", rememberTileBounds);
  tileWin.on("resize", rememberTileBounds);
  tileWin.on("closed", () => { tileWin = null; });
}

function toggleTile() {
  if (tileWin && !tileWin.isDestroyed()) {
    if (tileWin.isVisible()) tileWin.hide();
    else { tileWin.show(); tileWin.focus(); }
  } else {
    createTile();
  }
}

function broadcastTodos(list) {
  for (const w of [mainWin, tileWin]) {
    if (w && !w.isDestroyed()) w.webContents.send("todos-changed", list);
  }
}

function broadcastConfig(c) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("config-changed", c);
}

// ============================================================
// 托盘
// ============================================================
function createTray() {
  let img = nativeImage.createEmpty();
  try {
    const p = path.join(__dirname, "assets", "icon.png");
    if (fs.existsSync(p)) img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  } catch { /* 用空图标兜底，不让托盘创建失败 */ }
  try {
    tray = new Tray(img);
  } catch (e) {
    console.error("[sticky] 托盘创建失败:", e.message);
    return;
  }
  tray.setToolTip("Sticky Todo");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开主窗口", click: () => createMain() },
    { type: "separator" },
    { label: "磁贴", click: toggleTile },
    { type: "separator" },
    { label: "退出", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => createMain());
}

// ============================================================
// 闹钟调度
// ============================================================
let alarmTimer = null;
const fired = loadFired();

function fireAlarm(t) {
  fired[t.id] = Date.now();
  saveFired(fired);
  if (!Notification.isSupported()) {
    console.warn("[sticky] 系统通知不可用，闹钟仅在应用内提示");
    return;
  }
  try {
    const n = new Notification({
      title: "⏰ 待办提醒",
      body: t.text,
      silent: !cfg().alarmSound,
    });
    n.on("click", () => {
      createMain();
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.show();
        mainWin.focus();
      }
    });
    n.on("failed", (_, err) => console.error("[sticky] 通知发送失败:", err));
    n.show();
  } catch (e) {
    console.error("[sticky] 通知异常:", e.message);
  }
}

function checkAlarms() {
  const now = Date.now();
  for (const t of loadTodos()) {
    if (t.done || !t.alarmEnabled || !t.alarmTime) continue;
    const at = new Date(t.alarmTime).getTime();
    if (!Number.isFinite(at)) continue;
    if (fired[t.id]) continue;
    // 只在到点后提醒（不再用 ±30s 窗口，避免错过）
    if (at <= now) {
      if (now - at > 12 * 3600 * 1000) {
        fired[t.id] = now; // 太久远的不补报，只记账
        saveFired(fired);
        continue;
      }
      fireAlarm(t);
    }
  }
}

function startAlarms() {
  if (alarmTimer) clearInterval(alarmTimer);
  checkAlarms();
  alarmTimer = setInterval(checkAlarms, 5000);
}

// ============================================================
// IPC
// ============================================================
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function setupIPC() {
  ipcMain.handle("todos:list", () => loadTodos());

  ipcMain.handle("todos:create", (_, text) => {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    const todos = loadTodos();
    const t = {
      id: newId(),
      text: clean,
      done: false,
      createdAt: new Date().toISOString(),
      dueDate: null,
      alarmEnabled: false,
      alarmTime: null,
    };
    todos.unshift(t);
    saveTodos(todos);
    broadcastTodos(todos);
    return t; // 返回主进程生成的对象，渲染层以此为唯一真相
  });

  ipcMain.handle("todos:update", (_, id, updates) => {
    const todos = loadTodos();
    const i = todos.findIndex((x) => x.id === id);
    if (i === -1) return null;
    // 白名单字段，避免渲染层写入任意键
    const allowed = ["text", "done", "dueDate", "alarmEnabled", "alarmTime"];
    const patch = {};
    for (const k of allowed) {
      if (updates && Object.prototype.hasOwnProperty.call(updates, k)) patch[k] = updates[k];
    }
    if (Object.prototype.hasOwnProperty.call(patch, "alarmTime")) {
      delete fired[id]; // 改了提醒时间就重置已触发标记
      saveFired(fired);
    }
    todos[i] = { ...todos[i], ...patch };
    saveTodos(todos);
    broadcastTodos(todos);
    return todos[i];
  });

  ipcMain.handle("todos:toggle", (_, id) => {
    const todos = loadTodos();
    const i = todos.findIndex((x) => x.id === id);
    if (i === -1) return null;
    todos[i].done = !todos[i].done;
    saveTodos(todos);
    broadcastTodos(todos);
    return todos[i];
  });

  ipcMain.handle("todos:delete", (_, id) => {
    const todos = loadTodos().filter((x) => x.id !== id);
    saveTodos(todos);
    delete fired[id];
    saveFired(fired);
    broadcastTodos(todos);
    return true;
  });

  ipcMain.handle("config:get", () => cfg());
  ipcMain.handle("config:save", (_, patch) => {
    const c = saveConfig(patch || {});
    broadcastConfig(c);
    return c;
  });

  ipcMain.handle("tile:show", () => toggleTile());
  ipcMain.handle("tile:hide", () => { if (tileWin && !tileWin.isDestroyed()) tileWin.hide(); });
  ipcMain.handle("tile:pin", () => {
    if (!tileWin || tileWin.isDestroyed()) return false;
    const onTop = !tileWin.isAlwaysOnTop();
    tileWin.setAlwaysOnTop(onTop);
    return onTop;
  });

  ipcMain.handle("win:minimize", () => { if (mainWin && !mainWin.isDestroyed()) mainWin.minimize(); });
  ipcMain.handle("win:close", () => { if (mainWin && !mainWin.isDestroyed()) mainWin.close(); });

  ipcMain.handle("autostart:get", () => {
    try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
  });
  ipcMain.handle("autostart:set", (_, enable) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enable });
      return app.getLoginItemSettings().openAtLogin;
    } catch (e) {
      console.error("[sticky] 设置开机自启失败:", e.message);
      return false;
    }
  });
}

// ============================================================
// 生命周期
// ============================================================
app.isQuitting = false;

// H3 单实例：两个实例会各自持有一份内存副本并互覆盖 todos.json，
// 还会重复注册全局快捷键、弹两次通知。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    } else {
      createMain();
    }
  });

  app.whenReady().then(() => {
    // 让 Windows 通知显示为应用名而非 "Electron"
    if (process.platform === "win32") app.setAppUserModelId("com.stickytodo.app");
    Menu.setApplicationMenu(null);
    setupIPC();
    createMain();
    createTray();
    startAlarms();
    try {
      globalShortcut.register("Ctrl+Shift+Space", toggleTile);
    } catch (e) {
      console.error("[sticky] 全局快捷键注册失败:", e.message);
    }
    if (process.argv.includes("--dev") && mainWin) mainWin.webContents.openDevTools();
    // 启动时直接弹出磁贴，省去手动点击
    if (process.argv.includes("--open-tile")) toggleTile();
  });
}

app.on("before-quit", () => {
  app.isQuitting = true;
  if (alarmTimer) clearInterval(alarmTimer);
  if (tileSaveTimer) clearTimeout(tileSaveTimer);
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => { /* 常驻托盘，不退出 */ });
app.on("activate", () => createMain());
