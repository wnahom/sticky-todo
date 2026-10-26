// ============================================================
// 共享核心：数据读写 + 状态订阅 + 唯一的列表渲染器
// ------------------------------------------------------------
// 主窗口与磁贴窗口都引入本文件，渲染逻辑只有一份：
// 逾期判定、提醒时间、勾选态、子项进度都不再各写一套。
//
// 数据形态：
//   { id, text, done, createdAt, dueDate, alarmEnabled, alarmTime,
//     children?: [{ id, text, done }] }
//   子项只有 id/text/done —— 不带提醒与日期。
// ============================================================
import { esc, fmtSmart, fmtSmartDate, isOverdue } from "./utils.js";

const api = window.sticky;

// ============================================================
// 轻提示：主进程写入失败时，渲染层必须让用户看见
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

const newChildId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const state = {
  todos: [],
  config: {
    opacity: 0.92, alarmSound: true, tileWidth: 260, tileHeight: 360,
    tileBounds: null, tilePinned: true, focusId: null,
  },
  filter: "all",
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

  /** 当前专注的待办 id。指向已删除或已完成的条目时视为没有专注 */
  get focusId() {
    const id = state.config.focusId;
    if (!id) return null;
    const t = state.todos.find((x) => x.id === id);
    return t && !t.done ? id : null;
  },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  setFilter(f) { state.filter = f; emit(); },

  visible() {
    return state.todos.filter(FILTERS[state.filter] || FILTERS.all);
  },

  active() { return state.todos.filter((t) => !t.done); },

  byId(id) { return state.todos.find((x) => x.id === id) || null; },

  childrenOf(id) {
    const t = this.byId(id);
    return t && Array.isArray(t.children) ? t.children : [];
  },

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

  /** 主进程推送配置变更时合并（不重复请求） */
  applyConfig(patch) {
    state.config = { ...state.config, ...(patch || {}) };
    emit();
  },

  // ---------- 专注 ----------
  /** 再次点击同一条表示取消专注；已完成项不允许设为专注 */
  async setFocus(id) {
    const t = this.byId(id);
    if (!t || t.done) return null;
    const next = this.focusId === id ? null : id;
    return this.saveConfig({ focusId: next });
  },

  async clearFocus() {
    if (!this.focusId) return null;
    return this.saveConfig({ focusId: null });
  },

  // ---------- 写操作（均经 attempt 包装） ----------
  async add(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    return attempt("添加", async () => {
      const created = await api.todos.create(clean);
      await this.load();
      return created;
    });
  },

  async toggle(id) {
    return attempt("切换完成状态", async () => {
      await api.todos.toggle(id);
      await this.load();
    });
  },

  async toggleChild(parentId, childId) {
    return attempt("切换子项", async () => {
      await api.todos.toggleChild(parentId, childId);
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
      const r = await api.todos.update(id, patch);
      await this.load();
      return r; // 失败时 attempt 返回 null，成功时返回主进程的待办对象
    });
  },

  async saveConfig(patch) {
    return attempt("保存设置", async () => {
      state.config = { ...state.config, ...(await api.config.save(patch)) };
      emit();
      return state.config;
    });
  },

  // ---------- 子项 ----------
  async setChildren(parentId, children) {
    return this.update(parentId, { children });
  },

  async addChild(parentId, text) {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    const children = [...this.childrenOf(parentId), { id: newChildId(), text: clean, done: false }];
    return this.setChildren(parentId, children);
  },

  async removeChild(parentId, childId) {
    const children = this.childrenOf(parentId).filter((c) => c.id !== childId);
    return this.setChildren(parentId, children);
  },

  async renameChild(parentId, childId, text) {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    const children = this.childrenOf(parentId).map((c) => (c.id === childId ? { ...c, text: clean } : c));
    return this.setChildren(parentId, children);
  },
};

// ============================================================
// 渲染
// ============================================================

/** 下拉箭头：折叠态由 CSS 旋转 */
function chevronHtml(collapsed) {
  return `<button class="todo-chevron${collapsed ? " collapsed" : ""}" data-action="collapse"
    title="${collapsed ? "展开子项" : "折叠子项"}">
    <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>
  </button>`;
}

/** 专注靶心 */
function focusBtnHtml(isFocus) {
  return `<button class="focus-btn${isFocus ? " on" : ""}" data-action="focus"
    title="${isFocus ? "取消专注" : "专注这一条"}">
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round">
      <circle cx="10" cy="10" r="4.2"/><path d="M10 2.2v3M10 14.8v3M2.2 10h3M14.8 10h3"/>
    </svg></button>`;
}

function addChildBtnHtml() {
  return `<button data-action="add-child" title="添加子项">
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg></button>`;
}

function actionsHtml({ isFocus, hasChildren, collapsed, done }) {
  return `<div class="todo-actions no-drag">
    ${hasChildren ? chevronHtml(collapsed) : ""}
    ${addChildBtnHtml()}
    ${done ? "" : focusBtnHtml(isFocus)}
    <button data-action="alarm" title="设置提醒">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="10" cy="11" r="6"/><path d="M10 8v3l2 1.5"/>
      </svg>
    </button>
    <button class="del" data-action="delete" title="删除">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>`;
}

function childHtml(c, parent, { variant, inFocus }) {
  const cls = ["todo", "todo--child", c.done ? "done" : "", inFocus ? "in-focus" : ""]
    .filter(Boolean).join(" ");
  const check = `<div class="todo-check${c.done ? " checked" : ""}" data-action="toggle">${c.done ? "✓" : ""}</div>`;

  if (variant === "tile") {
    return `<div class="${cls}" data-parent="${esc(parent.id)}" data-child="${esc(c.id)}">
      ${check}<span class="todo-text">${esc(c.text)}</span>
    </div>`;
  }
  return `<div class="${cls}" data-parent="${esc(parent.id)}" data-child="${esc(c.id)}">
    ${check}
    <div class="todo-body"><div class="todo-text" data-action="edit">${esc(c.text)}</div></div>
    <div class="todo-actions no-drag">
      <button class="del" data-action="delete-child" title="删除子项">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  </div>`;
}

/**
 * 待办块（父项 + 未折叠时的子项）
 * variant: "main" | "tile"
 */
export function todoHtml(t, opts = {}) {
  const { variant = "main", now = new Date(), focusId = null, isCollapsed = () => false } = opts;
  const over = isOverdue(t, now.getTime());
  const isFocus = !!focusId && t.id === focusId;
  const children = Array.isArray(t.children) ? t.children : [];
  const hasChildren = children.length > 0;
  const collapsed = hasChildren && isCollapsed(t.id);
  const doneCount = children.filter((c) => c.done).length;

  const cls = ["todo", t.done ? "done" : "", over ? "overdue" : "", isFocus ? "todo--focus" : ""]
    .filter(Boolean).join(" ");

  // 提醒时间优先，其次截止日期；用「今天/明天/昨天」减少换算负担
  let metaText = "";
  if (t.alarmEnabled && t.alarmTime) metaText = fmtSmart(t.alarmTime, now);
  else if (t.dueDate) metaText = fmtSmartDate(t.dueDate, now);
  const meta = metaText
    ? `<div class="todo-meta${over ? " over" : ""}"><span class="due${over ? " over" : ""}">${esc(metaText)}</span></div>`
    : "";

  const progress = hasChildren
    ? `<span class="todo-progress${doneCount === children.length ? " all-done" : ""}">${doneCount}/${children.length}</span>`
    : "";

  const check = `<div class="todo-check${t.done ? " checked" : ""}" data-action="toggle">${t.done ? "✓" : ""}</div>`;

  const parentRow = variant === "tile"
    ? `<div class="${cls}" data-id="${esc(t.id)}">
        ${check}<span class="todo-text">${esc(t.text)}</span>
        ${progress}${hasChildren ? chevronHtml(collapsed) : ""}
      </div>`
    : `<div class="${cls}" data-id="${esc(t.id)}">
        ${check}
        <div class="todo-body">
          <div class="todo-text" data-action="edit">${esc(t.text)}</div>
          ${meta}
        </div>
        ${progress}
        ${actionsHtml({ isFocus, hasChildren, collapsed, done: t.done })}
      </div>`;

  if (!hasChildren || collapsed) return parentRow;
  return parentRow + children.map((c) => childHtml(c, t, { variant, inFocus: isFocus })).join("");
}

/**
 * 把条目数组渲染进容器。
 * focusId 用于加 todo--focus；容器加 has-focus 后主窗口才会变暗非专注项。
 */
export function renderList(container, todos, opts = {}) {
  const {
    variant = "main",
    emptyText = "还没有待办事项",
    focusId = null,
    isCollapsed = () => false,
  } = opts;

  // 只有专注项确实在当前可见列表里时才启用变暗，否则会出现「整页全暗」
  const hasFocus = !!focusId && todos.some((t) => t.id === focusId);
  container.classList.toggle("has-focus", hasFocus);

  if (!todos.length) {
    container.innerHTML = `<div class="${variant === "tile" ? "tile-empty" : "empty"}">${esc(emptyText)}</div>`;
    return;
  }
  const now = new Date();
  container.innerHTML = todos.map((t) => todoHtml(t, { variant, now, focusId, isCollapsed })).join("");
}

/**
 * 每分钟触发一次回调，用于刷新「今天/明天」这类相对时间。
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
/** 勾选切换：父项与子项、主窗口与磁贴共用同一实现 */
export function wireToggle(container) {
  container.addEventListener("click", async (e) => {
    if (!e.target.closest('[data-action="toggle"]')) return;
    const childRow = e.target.closest(".todo--child");
    if (childRow) {
      await store.toggleChild(childRow.dataset.parent, childRow.dataset.child);
      return;
    }
    const item = e.target.closest(".todo[data-id]");
    if (item) await store.toggle(item.dataset.id);
  });
}
