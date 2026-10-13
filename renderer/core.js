// ============================================================
// 共享核心：数据读写 + 状态订阅 + 唯一的列表渲染器
// ------------------------------------------------------------
// 主窗口与磁贴窗口都引入本文件。原先两套并行的
// render() / renderTile() 已合并为 renderList()：
// 逾期判定、提醒时间显示、勾选态只有一份实现。
// ============================================================
import { esc, fmtSmart, fmtSmartDate, isOverdue } from "./utils.js";

const api = window.sticky;

// ============================================================
// 轻提示：主进程写入失败时，渲染层必须让用户看见
// ------------------------------------------------------------
// 主进程的 IPC 处理器会把 fs 错误 reject 回来（已实测），
// 但此前渲染层只有未处理的 Promise 拒绝 —— 用户输入被清空、
// 界面看起来一切正常，实际上什么都没保存。
// ============================================================
let toastHost = null;
let toastTimer = null;

export function toast(message, kind = "error") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  toastHost.textContent = message;
  toastHost.dataset.kind = kind;
  toastHost.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastHost.classList.remove("show"), 4000);
}

/** 统一包装：把失败转成可见提示 + 重新以磁盘状态为准 */
async function attempt(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error(`[sticky] ${label} 失败:`, msg);
    toast(`${label}失败：${/EPERM|EACCES|EROFS/.test(msg) ? "文件不可写（磁盘只读或权限不足）" : "操作未保存"}`);
    try { await store.load(); } catch { /* 连读取都失败就保持现状 */ }
    return null;
  }
}

export const FILTERS = {
  all: () => true,
  active: (t) => !t.done,
  done: (t) => !!t.done,
  alarmed: (t) => !!t.alarmEnabled,
};

const state = {
  todos: [],
  config: { opacity: 0.92, alarmSound: true, tileWidth: 260, tileHeight: 360, tileBounds: null },
  filter: "all",
  editingId: null,
};

const listeners = new Set();
function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error("[sticky] 订阅回调异常:", e); }
  }
}

export const store = {
  get todos() { return state.todos; },
  get config() { return state.config; },
  get filter() { return state.filter; },
  get editingId() { return state.editingId; },

  setFilter(f) { state.filter = f; emit(); },
  setEditing(id) { state.editingId = id; emit(); },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  visible() {
    return state.todos.filter(FILTERS[state.filter] || FILTERS.all);
  },

  active() { return state.todos.filter((t) => !t.done); },

  counts() {
    const done = state.todos.filter((t) => t.done).length;
    return { total: state.todos.length, done, active: state.todos.length - done };
  },

  /** 从主进程重新拉取全量数据（主进程是唯一真相源） */
  async load() {
    state.todos = (await api.todos.list()) || [];
    emit();
  },

  /** 主进程主动推送时直接替换本地副本 */
  setTodos(list) {
    state.todos = list || [];
    emit();
  },

  async loadConfig() {
    state.config = { ...state.config, ...(await api.config.get()) };
    emit();
    return state.config;
  },

  // 以下写操作都经 attempt 包装：失败会弹出提示并以磁盘状态回滚界面
  async add(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    return attempt("添加", async () => {
      const created = await api.todos.create(clean);
      await this.load(); // 以主进程返回的 id 为准，避免两端 id 不一致
      return created;
    });
  },

  async toggle(id) {
    return attempt("切换完成状态", async () => {
      await api.todos.toggle(id);
      await this.load();
    });
  },

  async remove(id) {
    return attempt("删除", async () => {
      await api.todos.remove(id);
      await this.load();
    });
  },

  async update(id, patch) {
    return attempt("保存", async () => {
      await api.todos.update(id, patch);
      await this.load();
    });
  },

  async saveConfig(patch) {
    return attempt("保存设置", async () => {
      state.config = { ...state.config, ...(await api.config.save(patch)) };
      emit();
      return state.config;
    });
  },
};

// ============================================================
// 渲染
// ============================================================
function actionsHtml() {
  return `<div class="todo-actions no-drag">
    <button data-action="alarm" title="设置提醒">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="10" cy="11" r="6"/><path d="M10 8v3l2 1.5"/>
      </svg>
    </button>
    <button class="del" data-action="delete" title="删除">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
  </div>`;
}

/**
 * 待办条目模板 —— 主窗口与磁贴唯一的来源。
 * variant: "main" | "tile"
 */
export function todoHtml(t, { variant = "main", now = new Date() } = {}) {
  const over = isOverdue(t, now.getTime());
  const cls = ["todo", t.done ? "done" : "", over ? "overdue" : ""].filter(Boolean).join(" ");

  // 提醒时间优先，其次截止日期；用「今天/明天/昨天」减少换算负担
  let metaText = "";
  if (t.alarmEnabled && t.alarmTime) metaText = fmtSmart(t.alarmTime, now);
  else if (t.dueDate) metaText = fmtSmartDate(t.dueDate, now);
  const meta = metaText
    ? `<div class="todo-meta${over ? " over" : ""}"><span class="due${over ? " over" : ""}">${esc(metaText)}</span></div>`
    : "";

  // 磁贴空间紧张：元信息内联在右侧，且不需要操作按钮
  if (variant === "tile") {
    return `<div class="${cls}" data-id="${esc(t.id)}">
      <div class="todo-check${t.done ? " checked" : ""}" data-action="toggle">${t.done ? "✓" : ""}</div>
      <span class="todo-text">${esc(t.text)}</span>
      ${meta}
    </div>`;
  }

  return `<div class="${cls}" data-id="${esc(t.id)}">
    <div class="todo-check${t.done ? " checked" : ""}" data-action="toggle">${t.done ? "✓" : ""}</div>
    <div class="todo-body">
      <div class="todo-text" data-action="edit">${esc(t.text)}</div>
      ${meta}
    </div>
    ${actionsHtml()}
  </div>`;
}

/** 把条目数组渲染进容器；空态文案可定制 */
export function renderList(container, todos, opts = {}) {
  const { variant = "main", emptyText = "还没有待办事项" } = opts;
  if (!todos.length) {
    container.innerHTML = `<div class="${variant === "tile" ? "tile-empty" : "empty"}">${esc(emptyText)}</div>`;
    return;
  }
  const now = new Date();
  container.innerHTML = todos.map((t) => todoHtml(t, { variant, now })).join("");
}

/**
 * 每分钟触发一次回调，用于刷新「今天/明天」这类相对时间。
 * 原先只在数据变化时重渲染，窗口开久了日期标签就停在旧值。
 */
export function onMinuteTick(fn) {
  let last = new Date().getMinutes();
  setInterval(() => {
    const m = new Date().getMinutes();
    if (m !== last) { last = m; try { fn(); } catch (e) { console.error(e); } }
  }, 20000);
}

// ============================================================
// 事件绑定（两端复用）
// ============================================================
/** 勾选切换：主窗口与磁贴行为一致 */
export function wireToggle(container) {
  container.addEventListener("click", async (e) => {
    const item = e.target.closest("[data-id]");
    if (!item) return;
    if (!e.target.closest('[data-action="toggle"]')) return;
    await store.toggle(item.dataset.id);
  });
}
