// ============================================================
// 主窗口入口：列表（含子项）+ 提醒面板 + 设置面板 + 快捷键
// ============================================================
import { $, toLocalDateInput, toLocalTimeInput } from "./utils.js";
import { store, renderList, wireToggle, onMinuteTick } from "./core.js";

const api = window.sticky;

let alarmTargetId = null;

/** 折叠中的父项 id。主窗口默认展开，便于管理子项 */
const collapsed = new Set();

/** 行内编辑目标：childId 为 null 表示编辑父项本身 */
let editing = null;

/** 正在输入的子项输入框状态（DOM 由 render 负责重建，不直接持有） */
let childDraft = null;

/**
 * render() 重建列表时会摘掉旧输入框，而 blur 是在摘除过程中同步触发的
 * ——那一刻元素仍算 connected，会被误判成"用户点了别处"而关闭输入框。
 * 用这个同步标志把这段窗口挡掉。
 */
let suppressChildBlur = false;

/** 输入法组合期间不要触发提交（中文输入按 Enter 是上屏，不是确认） */
const isComposing = (e) => e.isComposing || e.keyCode === 229;

// ---------- 渲染 ----------
function render() {
  const c = store.counts();
  $("countBadge").textContent = `${c.active}/${c.total}`;

  // 重渲染会重建 innerHTML，先记录焦点与滚动位置，稍后还原
  const active = document.activeElement;
  const keepInput = active && active.id === "todoInput";
  const list = $("todoList");
  const scrollTop = list.scrollTop;

  suppressChildBlur = true;
  renderList(list, store.visible(), {
    variant: "main",
    emptyText: store.todos.length ? "没有匹配的待办" : "还没有待办事项",
    focusId: store.focusId,
    isCollapsed: (id) => collapsed.has(id),
  });
  suppressChildBlur = false;

  if (editing) mountEditor();
  // 子项输入框也是 render 的产物：重渲染后必须重新挂出来，否则会被抹掉
  if (childDraft) mountChildInput();

  list.scrollTop = scrollTop;
  // 编辑态下输入框有自己的焦点，不要抢回来
  if (keepInput && !editing) {
    const el = $("todoInput");
    if (el && el.selectionStart === 0 && el.selectionEnd === 0) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }
}

// ---------- 新增 ----------
$("todoInput").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || isComposing(e)) return;
  const input = $("todoInput");
  const text = input.value.trim();
  if (!text) return;
  // 先尝试保存，成功后再清空输入框 —— 失败时文字还在，用户不用重打
  const created = await store.add(text);
  if (created) input.value = "";
});

// ---------- 筛选 ----------
document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    store.setFilter(btn.dataset.filter);
    document.querySelectorAll("[data-filter]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
  });
});

// ---------- 列表交互 ----------
wireToggle($("todoList"));

$("todoList").addEventListener("click", async (e) => {
  const action = e.target.closest("[data-action]")?.dataset?.action;
  if (!action || action === "toggle") return; // toggle 由 wireToggle 处理

  // 子项行
  const childRow = e.target.closest(".todo--child");
  if (childRow) {
    const { parent: parentId, child: childId } = childRow.dataset;
    if (action === "delete-child") await store.removeChild(parentId, childId);
    else if (action === "edit") startEdit(parentId, childId);
    return;
  }

  // 父项行
  const item = e.target.closest(".todo[data-id]");
  if (!item) return;
  const id = item.dataset.id;

  if (action === "delete") await store.remove(id);
  else if (action === "alarm") openAlarm(id);
  else if (action === "edit") startEdit(id, null);
  else if (action === "focus") await store.setFocus(id);
  else if (action === "add-child") openChildInput(id);
  else if (action === "collapse") toggleCollapse(id);
});

/** 折叠/展开父项 */
function toggleCollapse(id) {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  render();
}

// ---------- 行内编辑（父项与子项共用） ----------
function startEdit(parentId, childId = null) {
  if (editing) return;
  editing = { parentId, childId };
  render(); // 由 render → mountEditor 统一挂载，避免两处逻辑
}

function mountEditor() {
  const { parentId, childId } = editing;
  const selector = childId
    ? `.todo--child[data-child="${childId}"]`
    : `.todo[data-id="${parentId}"]`;
  const row = document.querySelector(selector);
  const original = childId
    ? store.childrenOf(parentId).find((c) => c.id === childId)
    : store.byId(parentId);
  const target = row && row.querySelector(".todo-text");
  if (!row || !target || !original) { editing = null; return; }

  const inp = document.createElement("input");
  inp.className = "edit-input";
  inp.value = original.text;
  target.replaceWith(inp);
  inp.focus();
  inp.select();

  let settled = false;
  // Shift+Enter：保存本次修改后立刻展开子项输入，便于连续录入多个子项。
  // 从子项行触发时，新子项插在该子项之后；从父项行触发则追加到末尾。
  let openChildAfter = false;
  let openChildAfterId = null;

  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const v = inp.value.trim();
    editing = null; // 先清状态再触发重渲染，避免递归
    if (save && v && v !== original.text) {
      if (childId) await store.renameChild(parentId, childId, v);
      else await store.update(parentId, { text: v });
    } else render();
    // 渲染完成后再挂输入框，保证父项行已存在
    if (openChildAfter) {
      openChildAfter = false;
      openChildInput(parentId, openChildAfterId);
    }
  };

  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // 父项与子项都支持：父项→从头加子项，子项→在该子项后面接着加
      if (e.shiftKey) {
        openChildAfter = true;
        openChildAfterId = childId || null;
      }
      e.preventDefault();
      inp.blur();
    } else if (e.key === "Escape") {
      openChildAfter = false;
      inp.value = original.text;
      inp.blur();
    }
  });
}

// ---------- 添加子项 ----------
// 输入框是 #todoList 里的一行，而 render() 会重建该容器 —— 所以不能把 DOM
// 当作状态：这里只保存 childDraft，由 render() 负责把它重新挂出来。
// （否则任何一次重渲染，包括每分钟的时间刷新，都会把输入框抹掉）
function closeChildInput() {
  if (!childDraft) return;
  childDraft = null;
  const el = document.querySelector("#todoList .todo-child-input");
  if (el) el.remove();
}

/**
 * 打开子项输入框（连续回车可继续添加）。
 * afterChildId：新子项插入在该子项之后；省略则追加到末尾。
 */
function openChildInput(parentId, afterChildId = null) {
  if (collapsed.has(parentId)) collapsed.delete(parentId);
  childDraft = { parentId, insertAfter: afterChildId, value: "" };
  render(); // 由 render → mountChildInput 统一挂载
}

/** 按 childDraft 在列表里挂出输入框（每次 render 后调用） */
function mountChildInput() {
  const draft = childDraft;
  if (!draft) return;
  const row = document.querySelector(`.todo[data-id="${draft.parentId}"]`);
  if (!row) { childDraft = null; return; }

  const anchor = draft.insertAfter
    ? document.querySelector(`.todo--child[data-child="${draft.insertAfter}"]`)
    : null;

  const wrap = document.createElement("div");
  wrap.className = "todo-child-input no-drag";
  wrap.innerHTML = `<span class="todo-check"></span>
    <input type="text" placeholder="子项内容，Enter 添加，Esc 取消">`;
  (anchor || row).after(wrap);

  const inp = wrap.querySelector("input");
  inp.value = draft.value || "";
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);

  // 记住正在输入的内容，重渲染后可以原样恢复
  inp.addEventListener("input", () => { if (childDraft === draft) draft.value = inp.value; });

  inp.addEventListener("blur", () => {
    // 重渲染导致的摘除不算失焦；否则输入框刚重建就被自己关掉
    if (suppressChildBlur || !wrap.isConnected) return;
    closeChildInput();
  });

  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeChildInput(); return; }
    if (e.key !== "Enter" || isComposing(e)) return;
    e.preventDefault();
    const text = inp.value.trim();
    if (!text) { closeChildInput(); return; }
    const parentId = draft.parentId;
    const insertAfter = draft.insertAfter;
    draft.value = ""; // 重渲染时挂出空白框
    const created = await store.addChild(parentId, text, insertAfter);
    if (!created) return; // 失败已由 attempt 弹提示，输入框保留
    if (childDraft === draft) {
      childDraft.insertAfter = created.id; // 下一条排在这条之后
      childDraft.value = "";
      render();
    }
  });
}

// ---------- 提醒面板 ----------
function openAlarm(id) {
  const t = store.byId(id);
  if (!t) return;
  alarmTargetId = id;
  const now = new Date();

  $("alarmDate").value = t.alarmTime ? toLocalDateInput(t.alarmTime) : toLocalDateInput(now);
  $("alarmTime").value = t.alarmTime ? toLocalTimeInput(t.alarmTime) : "09:00";
  $("alarmEnabled").checked = t.alarmEnabled !== false;
  $("alarmOverlay").classList.remove("hidden");
}

$("btnAlarmSave").addEventListener("click", async () => {
  const id = alarmTargetId;
  if (!id) return;
  const d = $("alarmDate").value;
  const tm = $("alarmTime").value;
  const enabled = $("alarmEnabled").checked;

  // 用本地时间构造，避免 new Date("YYYY-MM-DDTHH:MM") 的时区歧义
  const dueDate = d ? new Date(`${d}T23:59:59`).toISOString() : null;
  const alarmTime = d && tm && enabled ? new Date(`${d}T${tm}:00`).toISOString() : null;

  await store.update(id, { dueDate, alarmTime, alarmEnabled: enabled && !!alarmTime });
  $("alarmOverlay").classList.add("hidden");
  alarmTargetId = null;
});

$("btnAlarmClear").addEventListener("click", async () => {
  const id = alarmTargetId;
  if (!id) return;
  await store.update(id, { dueDate: null, alarmTime: null, alarmEnabled: false });
  $("alarmOverlay").classList.add("hidden");
  alarmTargetId = null;
});

$("btnAlarmCancel").addEventListener("click", () => {
  $("alarmOverlay").classList.add("hidden");
  alarmTargetId = null;
});

// ---------- 设置面板 ----------
/** 把尺寸滑块与标签设为给定值 */
function setSizeInputs(w, h) {
  $("settingTW").value = w;
  $("twVal").textContent = w;
  $("settingTH").value = h;
  $("thVal").textContent = h;
}

$("btnSettings").addEventListener("click", async () => {
  try {
    const c = await store.loadConfig();
    $("settingOpacity").value = c.opacity ?? 0.92;
    $("opacityValue").textContent = c.opacity ?? 0.92;
    $("settingAlarmSound").checked = c.alarmSound !== false;
    $("settingSysNotify").checked = c.systemNotification !== false;
    // 尺寸以磁贴实际 bounds 为准：拖动过之后配置里的 tileWidth/Height
    // 与滑块显示必须一致，否则面板会显示一个窗口并不使用的数字
    const b = await api.tile.bounds();
    setSizeInputs(b.width ?? c.tileWidth ?? 260, b.height ?? c.tileHeight ?? 360);
    $("settingAutoStart").checked = await api.autostart.get();
  } catch (e) {
    console.error("[sticky] 读取设置失败:", e);
  }
  $("settingsOverlay").classList.remove("hidden");
});

$("btnCloseSettings").addEventListener("click", async () => {
  await api.autostart.set($("settingAutoStart").checked);
  await store.saveConfig({
    opacity: parseFloat($("settingOpacity").value),
    alarmSound: $("settingAlarmSound").checked,
    systemNotification: $("settingSysNotify").checked,
  });
  // 尺寸走专用通道：它会同时更新 tileWidth/Height 并清掉旧的 tileBounds，
  // 否则 createTile() 里 tileBounds 优先，滑块改了也不生效
  await api.tile.resize(parseInt($("settingTW").value, 10), parseInt($("settingTH").value, 10));
  await store.loadConfig();
  $("settingsOverlay").classList.add("hidden");
});

$("settingOpacity").addEventListener("input", () => {
  $("opacityValue").textContent = $("settingOpacity").value;
});
$("settingTW").addEventListener("input", () => {
  $("twVal").textContent = $("settingTW").value;
});
$("settingTH").addEventListener("input", () => {
  $("thVal").textContent = $("settingTH").value;
});

// ---------- 窗口按钮 ----------
$("btnTile").addEventListener("click", () => api.tile.show());
$("btnCloseWin").addEventListener("click", () => api.win.close());

// ---------- 全局键盘 ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".overlay:not(.hidden)").forEach((el) => el.classList.add("hidden"));
    alarmTargetId = null;
    closeChildInput();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    $("todoInput").focus();
  }
});

// 点遮罩关闭
document.querySelectorAll(".overlay").forEach((el) => {
  el.addEventListener("click", (e) => { if (e.target === el) el.classList.add("hidden"); });
});

// ---------- 启动 ----------
store.subscribe(render);
api.onTodosChanged((todos) => store.setTodos(todos));
api.onConfigChanged((c) => store.applyConfig(c));
// 托盘「新建待办」唤出窗口后把光标送进输入框
api.onFocusInput(() => {
  const el = $("todoInput");
  if (el) { el.focus(); el.select(); }
});
// 提醒到点：把主窗口带到前台，方便直接处理
api.onAlarms((list) => {
  if (list && list.length) {
    console.log("[sticky] 有新的提醒:", list.map((t) => t.text).join(" / "));
  }
});
// 拖动/缩放磁贴时同步设置面板的尺寸滑块
api.onTileBoundsChanged((b) => {
  if (b && document.getElementById("settingsOverlay") &&
      !$("settingsOverlay").classList.contains("hidden")) {
    setSizeInputs(b.width, b.height);
  }
});
// 「今天/明天」这类相对时间需要随时间推移刷新
onMinuteTick(render);

(async () => {
  try {
    await store.load();
    await store.loadConfig(); // 专注状态存在配置里，必须初始加载
  } catch (e) {
    console.error("[sticky] 初始加载失败:", e);
    const list = $("todoList");
    list.innerHTML = '<div class="empty"><div class="txt">读取待办失败，请检查数据目录权限</div></div>';
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = "重试";
    btn.addEventListener("click", async () => {
      try { await store.load(); } catch { /* 仍失败则保持提示 */ }
    });
    list.querySelector(".empty").appendChild(btn);
    return;
  }
  store.setFilter("all");
})();
