// ============================================================
// 主窗口入口：列表 + 提醒面板 + 设置面板 + 快捷键
// ============================================================
import { $, toLocalDateInput, toLocalTimeInput } from "./utils.js";
import { store, renderList, wireToggle } from "./core.js";

const api = window.sticky;

let alarmTargetId = null;

// ---------- 渲染 ----------
function render() {
  const c = store.counts();
  $("countBadge").textContent = `${c.active}/${c.total}`;

  const list = $("todoList");
  const visible = store.visible();
  renderList(list, visible, {
    variant: "main",
    emptyText: store.todos.length ? "没有匹配的待办" : "还没有待办事项",
  });
  if (store.editingId) mountEditor(store.editingId);
}

// ---------- 新增 ----------
$("todoInput").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const input = $("todoInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await store.add(text);
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
$("btnSettings").addEventListener("click", async () => {
  try {
    const c = await store.loadConfig();
    $("settingOpacity").value = c.opacity ?? 0.92;
    $("opacityValue").textContent = c.opacity ?? 0.92;
    $("settingAlarmSound").checked = c.alarmSound !== false;
    $("settingTW").value = c.tileWidth || 260;
    $("twVal").textContent = c.tileWidth || 260;
    $("settingTH").value = c.tileHeight || 360;
    $("thVal").textContent = c.tileHeight || 360;
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
    tileWidth: parseInt($("settingTW").value, 10),
    tileHeight: parseInt($("settingTH").value, 10),
  });
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

(async () => {
  await store.load();
  store.setFilter("all");
})();
