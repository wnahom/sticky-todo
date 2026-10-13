// ============================================================
// 共享核心：数据读写 + 状态订阅 + 唯一的列表渲染器
// ------------------------------------------------------------
// 主窗口与磁贴窗口都引入本文件。原先两套并行的
// render() / renderTile() 已合并为 renderList()：
// 逾期判定、提醒时间显示、勾选态只有一份实现。
// ============================================================
import { esc, fmtDate, fmtDateTime, isOverdue } from "./utils.js";

const api = window.sticky;

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

  async add(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    const created = await api.todos.create(clean);
    await this.load(); // 以主进程返回的 id 为准，避免两端 id 不一致
    return created;
  },

  async toggle(id) { await api.todos.toggle(id); await this.load(); },

  async remove(id) { await api.todos.remove(id); await this.load(); },

  async update(id, patch) { await api.todos.update(id, patch); await this.load(); },

  async saveConfig(patch) {
    state.config = { ...state.config, ...(await api.config.save(patch)) };
    emit();
    return state.config;
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
export function todoHtml(t, { variant = "main", now = Date.now() } = {}) {
  const over = isOverdue(t, now);
  const cls = ["todo", t.done ? "done" : "", over ? "overdue" : ""].filter(Boolean).join(" ");

  // 提醒时间优先，其次截止日期
  let metaText = "";
  if (t.alarmEnabled && t.alarmTime) metaText = fmtDateTime(t.alarmTime);
  else if (t.dueDate) metaText = fmtDate(t.dueDate);
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
  const now = Date.now();
  container.innerHTML = todos.map((t) => todoHtml(t, { variant, now })).join("");
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
