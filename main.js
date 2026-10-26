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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CONFIG = {
  opacity: 0.92,
  alarmSound: true,
  systemNotification: true, // 关掉可避免每次提醒都产生一条失败日志
  tileWidth: 260,
  tileHeight: 360,
  tileBounds: null,
  tilePinned: true,
  focusId: null, // 当前专注的待办 id；只存一条，属于界面状态
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
/**
 * 用户一旦显式改过磁贴尺寸（设置面板滑块），就丢弃启动时排队中的
 * 兜底 bounds 应用 —— 否则迟到的旧尺寸会覆盖用户的修改。
 */
let boundsDirty = false;
let boundsTimer = null;
/** 置顶看门狗：定期检查磁贴是否真的置顶，被系统丢掉时补回 */
let tileWatch = null;

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

/**
 * 校正记忆的磁贴位置。
 * 原实现只要求与工作区有 20px 交叠，于是「大部分在屏幕外」的坐标也会被
 * 原样使用 —— 尤其把磁贴拖到副屏外侧、之后拔掉副屏时，窗口会跑到看不见的地方。
 * 现在改为：仍有交叠就夹回可见区域（保留用户想放哪块屏的意图），
 * 完全不沾边才回退居中。
 */
function usableBounds(saved) {
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
  const w = Math.min(Math.max(Math.round(saved.width) || 260, 180), 2000);
  const h = Math.min(Math.max(Math.round(saved.height) || 360, 150), 2000);
  const displays = screen.getAllDisplays();

  let best = null;
  let bestOverlap = 0;
  for (const d of displays) {
    const wa = d.workArea;
    // 与工作区的交叠面积
    const ox = Math.max(0, Math.min(saved.x + w, wa.x + wa.width) - Math.max(saved.x, wa.x));
    const oy = Math.max(0, Math.min(saved.y + h, wa.y + wa.height) - Math.max(saved.y, wa.y));
    const overlap = ox * oy;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = wa;
    }
  }
  if (!best) return null; // 完全不在任何屏幕内 → 回退到默认位置

  // 尺寸不能超过这块屏的工作区，否则再怎么夹也会有一部分在屏外
  const fitW = Math.min(w, best.width);
  const fitH = Math.min(h, best.height);
  // 夹进工作区，保证整个窗口可见
  const x = Math.round(Math.min(Math.max(saved.x, best.x), best.x + best.width - fitW));
  const y = Math.round(Math.min(Math.max(saved.y, best.y), best.y + best.height - fitH));
  return { x, y, width: fitW, height: fitH };
}

/** 置顶的意图以配置为准（窗口的实际 TOPMOST 位可能被系统事件丢掉） */
function tilePinnedIntent() {
  return cfg().tilePinned !== false;
}

/**
 * 把置顶意图落到磁贴窗口上。
 *
 * 背景：窗口的 WS_EX_TOPMOST 位会被系统在各种时机丢掉（跨显示器、点击、拖动…），
 * 丢掉之后窗口就沉到其它窗口下面，而且"点它/拖它"也回不到顶层 —— 这不是用户
 * 期待的普通窗口行为。
 *
 * 实测 Electron 的 isAlwaysOnTop() 会跟随系统的真实状态，因此这里只在真的
 * 不一致时才下发一次，避免每次调用都把窗口重新排一次（会造成闪烁）。
 */
function applyTilePinned() {
  if (!tileWin || tileWin.isDestroyed()) return;
  if (tileWin.isMinimized() || !tileWin.isVisible()) return;
  const want = tilePinnedIntent();
  let actual;
  try {
    actual = tileWin.isAlwaysOnTop();
  } catch {
    return;
  }
  if (actual === want) return;
  try {
    tileWin.setAlwaysOnTop(want);
  } catch (e) {
    console.error("[sticky] 应用置顶状态失败:", e.message);
  }
}

function rememberTileBounds() {
  if (!tileWin || tileWin.isDestroyed() || tileWin.isMinimized()) return;
  if (tileSaveTimer) clearTimeout(tileSaveTimer);
  // 拖动/缩放会高频触发，防抖后再落盘
  tileSaveTimer = setTimeout(() => {
    if (!tileWin || tileWin.isDestroyed()) return;
    const b = tileWin.getBounds();
    saveConfig({ tileBounds: b, tileWidth: b.width, tileHeight: b.height });
    broadcastTileBounds(b); // 让设置面板滑块同步，避免与拖拽结果不一致
    applyTilePinned(); // 跨屏拖动后系统可能丢掉置顶，这里补回
  }, 500);
}

/**
 * 解析磁贴初始 bounds。
 * 注意：不能把这些值交给 BrowserWindow 的 width/height 构造参数 ——
 * 实测在本机双屏（100% + 150%）环境下，构造参数与「什么都不做仅移动窗口」
 * 都会被乘上目标屏的缩放因子：请求 220x300 在 150% 屏上得到 330x450。
 * 而 setBounds()/setSize() 则严格按 DIP 生效。
 * 因此这里只算出数值，统一交给 ready-to-show 里的 setBounds() 落地。
 */
function resolveTileBounds() {
  const c = cfg();
  const saved = usableBounds(c.tileBounds);
  if (saved) return saved;
  const w = Math.min(Math.max(c.tileWidth || 260, 180), 2000);
  const h = Math.min(Math.max(c.tileHeight || 360, 150), 2000);
  return { width: w, height: h }; // 不指定 x/y，交给系统居中
}

function createTile() {
  const c = cfg();
  const bounds = resolveTileBounds();
  boundsDirty = false; // 新窗口，重新允许启动阶段的尺寸纠正
  tileWin = new BrowserWindow({
    frame: false,
    transparent: true,
    alwaysOnTop: tilePinnedIntent(),
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
  tileWin.once("ready-to-show", async () => {
    if (!tileWin || tileWin.isDestroyed()) return;
    const win = tileWin;

    // --- 高 DPI 屏上的尺寸落地（本机双屏 100% + 150% 实测） ---
    // 若在隐藏状态下立刻 show()，Windows 会按目标屏缩放因子重新解释尺寸，
    // 把设定值乘掉（220x300 → 330x450）。可用做法：先在隐藏状态应用 bounds，
    // 稍作停顿再显示；显示后再校验一次，不符则纠正。
    // 两个定时器都必须可取消：用户在此期间改了尺寸（tile:resize）的话，
    // 迟到的旧 bounds 会把它覆盖回去 —— 这个竞态已实测复现过。
    applyTileBounds(bounds);
    await sleep(150);
    if (win.isDestroyed() || boundsDirty) return;
    win.setOpacity(c.opacity ?? 0.92); // 首启不透明的问题在此一并修正
    win.show();
    applyTilePinned(); // 显示之后再落一次置顶，防止系统在迁移显示器时丢掉

    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || boundsDirty) return;
      const b = win.getBounds();
      if (b.width !== bounds.width || b.height !== bounds.height ||
          (bounds.x !== undefined && (b.x !== bounds.x || b.y !== bounds.y))) {
        applyTileBounds(bounds); // 兜底纠正被缩放掉的尺寸
      }
      applyTilePinned();
    }, 400);
  });
  tileWin.on("move", rememberTileBounds);
  tileWin.on("resize", rememberTileBounds);
  // 点击磁贴（聚焦）时也补一次：实测点击会让系统丢掉 TOPMOST 位
  tileWin.on("focus", applyTilePinned);
  // 看门狗：系统在任何时刻丢掉置顶位都能在 1 秒内补回。
  // 已经置顶时 applyTilePinned 会直接返回，不做任何窗口操作。
  if (tileWatch) clearInterval(tileWatch);
  tileWatch = setInterval(applyTilePinned, 1000);
  tileWin.on("closed", () => {
    tileWin = null;
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    if (tileWatch) { clearInterval(tileWatch); tileWatch = null; }
  });
}

/**
 * 把目标 bounds 落到磁贴窗口上。
 * 必须在窗口已经显示之后再调用：本机双屏（100% + 150%）实测，
 * 窗口在被移动到高 DPI 屏显示时，Windows 会按该屏缩放因子重新解释尺寸，
 * 把之前（含构造参数）设定的值乘掉 —— 请求 220x300 会变成 330x450。
 * 显示之后再 setBounds 才能得到精确的 DIP 尺寸。
 */
function applyTileBounds(bounds) {
  if (!tileWin || tileWin.isDestroyed()) return;
  try {
    tileWin.setBounds(bounds);
  } catch (e) {
    console.error("[sticky] 应用磁贴尺寸失败:", e.message);
  }
}

function toggleTile() {
  if (tileWin && !tileWin.isDestroyed()) {
    if (tileWin.isVisible()) tileWin.hide();
    else {
      tileWin.show();
      tileWin.focus();
      applyTilePinned(); // 重新显示时按配置补回置顶
    }
  } else {
    createTile();
  }
}

function broadcastTodos(list) {
  for (const w of [mainWin, tileWin]) {
    if (w && !w.isDestroyed()) w.webContents.send("todos-changed", list);
  }
  updateTrayTooltip(list);
}

function broadcastConfig(c) {
  // 磁贴也要知道 focusId（它据此决定只显示专注项），所以两个窗口都发
  for (const w of [mainWin, tileWin]) {
    if (w && !w.isDestroyed()) w.webContents.send("config-changed", c);
  }
}

/** 磁贴被拖动/缩放后通知主窗口，让设置面板的滑块跟着动 */
function broadcastTileBounds(bounds) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("tile-bounds-changed", bounds);
}

/** 托盘提示显示未完成数量，鼠标悬停即可看到进度 */
function updateTrayTooltip(list) {
  if (!tray) return;
  try {
    const todos = list || loadTodos();
    const now = Date.now();
    const active = todos.filter((t) => !t.done).length;
    const overdue = todos.filter(
      (t) => !t.done && t.alarmEnabled && t.alarmTime && new Date(t.alarmTime).getTime() < now
    ).length;
    tray.setToolTip(
      overdue
        ? `Sticky Todo — 未完成 ${active} 项（${overdue} 项已逾期）`
        : active
          ? `Sticky Todo — 未完成 ${active} 项`
          : "Sticky Todo — 全部完成"
    );
  } catch (e) {
    console.error("[sticky] 更新托盘提示失败:", e.message);
  }
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
    { label: "新建待办…", click: focusQuickAdd },
    { type: "separator" },
    { label: "打开主窗口", click: () => createMain() },
    { label: "磁贴", click: toggleTile },
    { type: "separator" },
    { label: "退出", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => createMain());
  updateTrayTooltip();
}

/** 从托盘快捷录入：唤出主窗口并把光标放进输入框 */
function focusQuickAdd() {
  createMain();
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.show();
  mainWin.focus();
  const send = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("focus-input");
  };
  // 首次创建时页面还没就绪，事件会丢，等加载完再发
  if (mainWin.webContents.isLoading()) mainWin.webContents.once("did-finish-load", send);
  else send();
}

// ============================================================
// 闹钟调度
// ============================================================
let alarmTimer = null;
let alarmWin = null;
const fired = loadFired();
/** 当前弹出中的提醒（供应用内提醒窗口显示） */
let pendingAlarms = [];

/**
 * 已触发标记不是用户数据，写入失败只可能造成重复提醒，
 * 不该让它抛出中断整轮闹钟检查（磁盘只读时会连锁报错）。
 */
function safeSaveFired() {
  try {
    saveFired(fired);
  } catch (e) {
    console.error("[sticky] 记录已触发提醒失败:", e.message);
  }
}

function fireAlarm(t) {
  fired[t.id] = Date.now();
  safeSaveFired();
  showAlarmWindow(t);
  if (cfg().systemNotification === false) return;
  if (!Notification.isSupported()) {
    console.warn("[sticky] 系统通知不可用，已改用应用内提醒窗口");
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

// ============================================================
// 应用内提醒窗口
// ------------------------------------------------------------
// 不能只依赖系统通知：HKCU\...\PushNotifications\ToastEnabled
// 为 0 时 Notification.show() 会静默失败，用户完全看不到提醒。
// ============================================================
function pushPending(t) {
  pendingAlarms = pendingAlarms.filter((x) => x.id !== t.id);
  pendingAlarms.unshift(t);
  for (const w of [alarmWin, mainWin]) {
    if (w && !w.isDestroyed()) w.webContents.send("alarms", pendingAlarms);
  }
}

function closeAlarmWindow() {
  if (alarmWin && !alarmWin.isDestroyed()) alarmWin.close();
  alarmWin = null;
}

function showAlarmWindow(t) {
  pushPending(t);
  if (alarmWin && !alarmWin.isDestroyed()) {
    alarmWin.show();
    alarmWin.focus();
    return;
  }
  const W = 340;
  const H = 176;
  let x, y;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    x = Math.round(wa.x + wa.width - W - 20);
    y = Math.round(wa.y + wa.height - H - 20);
  } catch { /* 取不到屏幕信息就让系统定位 */ }

  alarmWin = new BrowserWindow({
    width: W,
    height: H,
    ...(x !== undefined ? { x, y } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 提到最高层级，避免被其他置顶窗口盖住
  alarmWin.setAlwaysOnTop(true, "screen-saver");
  alarmWin.loadFile(path.join(__dirname, "renderer", "alarm.html"), { query: { mode: "alarm" } });
  alarmWin.once("ready-to-show", () => {
    if (!alarmWin || alarmWin.isDestroyed()) return;
    alarmWin.show();
    alarmWin.focus();
  });
  alarmWin.on("closed", () => { alarmWin = null; });
}

/** 从待办队列里移除某条提醒并广播；队列空了就关窗 */
function resolveAlarm(id) {
  pendingAlarms = pendingAlarms.filter((x) => x.id !== id);
  if (!pendingAlarms.length) closeAlarmWindow();
  else {
    for (const w of [alarmWin, mainWin]) {
      if (w && !w.isDestroyed()) w.webContents.send("alarms", pendingAlarms);
    }
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
        safeSaveFired();
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

/**
 * 规范化子项数组：过滤非法项与空文本，限制数量，补齐 id。
 * 子项只有 id/text/done —— 不带提醒与日期，避免数据模型膨胀。
 */
function normalizeChildren(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      id: c.id ? String(c.id) : newId(),
      text: String(c.text ?? "").trim(),
      done: !!c.done,
    }))
    .filter((c) => c.text)
    .slice(0, 200);
}

/** 有子项时，父项的完成状态由子项派生（全完成才算完成） */
function deriveParentDone(t) {
  if (Array.isArray(t.children) && t.children.length) {
    t.done = t.children.every((c) => c.done);
  }
  return t;
}

/** 专注项被完成或删除时清空焦点，避免焦点停在看不到/已完成的行上 */
function clearFocusIf(id) {
  if (cfg().focusId !== id) return false;
  const c = saveConfig({ focusId: null });
  broadcastConfig(c);
  return true;
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
    const allowed = ["text", "done", "dueDate", "alarmEnabled", "alarmTime", "children"];
    const patch = {};
    for (const k of allowed) {
      if (updates && Object.prototype.hasOwnProperty.call(updates, k)) patch[k] = updates[k];
    }
    if (Object.prototype.hasOwnProperty.call(patch, "alarmTime")) {
      delete fired[id]; // 改了提醒时间就重置已触发标记
      safeSaveFired();
    }
    if (Object.prototype.hasOwnProperty.call(patch, "children")) {
      patch.children = normalizeChildren(patch.children);
    }
    const next = { ...todos[i], ...patch };
    // 子项存在时以子项为准；没有子项则尊重显式传入的 done
    if (Array.isArray(next.children) && next.children.length) deriveParentDone(next);
    todos[i] = next;
    saveTodos(todos);
    if (next.done) clearFocusIf(id);
    broadcastTodos(todos);
    return todos[i];
  });

  ipcMain.handle("todos:toggle", (_, id) => {
    const todos = loadTodos();
    const i = todos.findIndex((x) => x.id === id);
    if (i === -1) return null;
    const t = todos[i];
    const next = !t.done;
    t.done = next;
    // 勾父项 = 级联所有子项（含"全选/全不选"两向）
    if (Array.isArray(t.children) && t.children.length) {
      for (const c of t.children) c.done = next;
    }
    saveTodos(todos);
    if (next) clearFocusIf(id);
    broadcastTodos(todos);
    return t;
  });

  /** 切换单个子项；父项完成状态随之派生。放在主进程做，磁贴勾选也一致 */
  ipcMain.handle("todos:toggle-child", (_, parentId, childId) => {
    const todos = loadTodos();
    const p = todos.find((x) => x.id === parentId);
    if (!p || !Array.isArray(p.children)) return null;
    const c = p.children.find((x) => x.id === childId);
    if (!c) return null;
    c.done = !c.done;
    deriveParentDone(p);
    saveTodos(todos);
    if (p.done) clearFocusIf(parentId);
    broadcastTodos(todos);
    return p;
  });

  ipcMain.handle("todos:delete", (_, id) => {
    const todos = loadTodos().filter((x) => x.id !== id);
    saveTodos(todos);
    delete fired[id];
    safeSaveFired();
    clearFocusIf(id);
    broadcastTodos(todos);
    return true;
  });

  ipcMain.handle("config:get", () => cfg());
  ipcMain.handle("config:save", (_, patch) => {
    const c = saveConfig(patch || {});
    broadcastConfig(c);
    return c;
  });

  // ---------- 应用内提醒窗口 ----------
  ipcMain.handle("alarm:pending", () => pendingAlarms);

  ipcMain.handle("alarm:dismiss", (_, id) => {
    resolveAlarm(id);
    return true;
  });

  ipcMain.handle("alarm:done", (_, id) => {
    const todos = loadTodos();
    const i = todos.findIndex((x) => x.id === id);
    if (i !== -1) {
      todos[i].done = true;
      if (Array.isArray(todos[i].children)) {
        for (const c of todos[i].children) c.done = true;
      }
      saveTodos(todos);
      clearFocusIf(id);
      broadcastTodos(todos);
    }
    resolveAlarm(id);
    return true;
  });

  /** 推迟：把提醒时间改到 n 分钟后，并清掉已触发标记让它能再次触发 */
  ipcMain.handle("alarm:snooze", (_, id, minutes) => {
    const mins = Math.max(1, Math.min(24 * 60, Number(minutes) || 10));
    const todos = loadTodos();
    const i = todos.findIndex((x) => x.id === id);
    if (i === -1) return null;
    todos[i].alarmTime = new Date(Date.now() + mins * 60000).toISOString();
    todos[i].alarmEnabled = true;
    saveTodos(todos);
    delete fired[id];
    safeSaveFired();
    broadcastTodos(todos);
    resolveAlarm(id);
    return todos[i];
  });

  ipcMain.handle("tile:show", () => toggleTile());
  ipcMain.handle("tile:hide", () => { if (tileWin && !tileWin.isDestroyed()) tileWin.hide(); });
  ipcMain.handle("tile:pinned", () => tilePinnedIntent());
  ipcMain.handle("tile:pin", () => {
    // 以配置为唯一真相：窗口的 TOPMOST 位可能被系统丢掉，
    // 若拿 isAlwaysOnTop() 取反，会和用户看到的按钮状态脱节
    const next = !tilePinnedIntent();
    saveConfig({ tilePinned: next });
    applyTilePinned();
    return next;
  });

  /** 磁贴当前实际尺寸；窗口没开时回落到配置值 */
  ipcMain.handle("tile:bounds", () => {
    if (tileWin && !tileWin.isDestroyed()) return tileWin.getBounds();
    const c = cfg();
    const b = c.tileBounds;
    return {
      width: b?.width ?? c.tileWidth ?? 260,
      height: b?.height ?? c.tileHeight ?? 360,
    };
  });

  /**
   * 从设置面板调整磁贴尺寸。
   * 必须同时清掉 tileBounds —— 否则 createTile() 里的
   * 「tileBounds 优先」逻辑会让这次修改在下次打开时被旧尺寸盖掉，
   * 滑块看起来完全没作用。
   */
  ipcMain.handle("tile:resize", (_, w, h) => {
    const width = Math.max(180, Math.min(2000, Math.round(Number(w) || 0)));
    const height = Math.max(150, Math.min(2000, Math.round(Number(h) || 0)));
    if (!width || !height) return null;
    boundsDirty = true; // 丢弃启动阶段排队中的兜底应用，避免覆盖这次修改
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    saveConfig({ tileWidth: width, tileHeight: height, tileBounds: null });
    if (tileWin && !tileWin.isDestroyed()) {
      tileWin.setSize(width, height); // resize 事件会经 rememberTileBounds 回写实际 bounds
    }
    return { width, height };
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
