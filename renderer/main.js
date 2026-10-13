// ============================================================
// 主窗口入口：列表 + 提醒面板 + 设置面板 + 快捷键
// ============================================================
import { $, toLocalDateInput, toLocalTimeInput } from "./utils.js";
import { store, renderList, wireToggle, onMinuteTick } from "./core.js";

const api = window.sticky;

let alarmTargetId = null;

/** 输入法组合期间不要触发提交（中文输入按 Enter 是上屏，不是确认） */
const isComposing = (e) => e.isComposing || e.keyCode === 229;

// ---------- 渲染 ----------
function render() {
  const c = store.counts();
  $("countBadge").textContent = `${c.active}/${c.total}`;

  // 重渲染会重建 innerHTML，先记录焦点与滚动位置，稍后还原
  const active = document.activeElement;
  const refocusId = active && active.id === "todoInput" ? "todoInput" : null;
  const list = $("todoList");
  const scrollTop = list.scrollTop;

  renderList(list, store.visible(), {
    variant: "main",
    emptyText: store.todos.length ? "没有匹配的待办" : "还没有待办事项",
  });
  if (store.editingId) mountEditor(store.editingId);

  list.scrollTop = scrollTop;
  // 编辑态下输入框有自己的焦点，不要抢回来
  if (refocusId && !store.editingId) {
    const el = $(refocusId);
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
  const item = e.target.closest(".todo[data-id]");
  if (!item) return;
  const id = item.dataset.id;
  const action = e.target.closest("[data-action]")?.dataset?.action;

  if (action === "delete") await store.remove(id);
  else if (action === "alarm") openAlarm(id);
  else if (action === "edit") startEdit(id);
});

// ---------- 行内编辑 ----------
function startEdit(id) {
  if (store.editingId) return;
  store.setEditing(id);
}

function mountEditor(id) {
  const item = document.querySelector(`.todo[data-id="${id}"]`);
  if (!item) { store.setEditing(null); return; }

  const target = item.querySelector(".todo-text");
  const t = store.todos.find((x) => x.id === id);
  if (!target || !t) { store.setEditing(null); return; }

  const inp = document.createElement("input");
  inp.className = "edit-input";
  inp.value = t.text;
  target.replaceWith(inp);
  inp.focus();
  inp.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const v = inp.value.trim();
    store.setEditing(null); // 先清状态再触发重渲染，避免递归
    if (save && v && v !== t.text) await store.update(id, { text: v });
    else render();
  };

  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") inp.blur();
    else if (e.key === "Escape") { inp.value = t.text; inp.blur(); }
  });
}

// ---------- 提醒面板 ----------
function openAlarm(id) {
  const t = store.todos.find((x) => x.id === id);
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
api.onConfigChanged((c) => { Object.assign(store.config, c); });
// 托盘「新建待办」唤出窗口后把光标送进输入框
api.onFocusInput(() => {
  const el = $("todoInput");
  if (el) { el.focus(); el.select(); }
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
