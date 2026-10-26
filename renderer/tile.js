// ============================================================
// 磁贴窗口入口：紧凑列表 + 快速新增 + 置顶切换
// ------------------------------------------------------------
// 两条显示规则：
//   有专注 → 只显示专注的那一条，并自动展开其子项
//   无专注 → 显示全部顶层待办，父项默认折叠
// 展开父项时后续条目被挤出可视区（列表可滚动），
// 任何内容变化都不改变窗口尺寸。
// ============================================================
import { $ } from "./utils.js";
import { store, renderList, wireToggle, onMinuteTick } from "./core.js";

const api = window.sticky;

/** 已展开的父项（默认折叠）。专注项会在获得焦点时自动加入 */
const expanded = new Set();
let lastFocusId = null;

/** 输入法组合期间不要触发提交（中文输入按 Enter 是上屏，不是确认） */
const isComposing = (e) => e.isComposing || e.keyCode === 229;

function render() {
  const focusId = store.focusId;

  // 专注项自动展开、并在失去专注时恢复折叠。
  // 这样"无专注时父项默认折叠"不会被上一次的自动展开破坏，
  // 同时用户仍可在专注期间手动折叠（点击箭头）。
  if (focusId !== lastFocusId) {
    if (lastFocusId) expanded.delete(lastFocusId);
    if (focusId) expanded.add(focusId);
    lastFocusId = focusId;
  }

  // 有专注时只渲染那一条
  const list = focusId ? store.todos.filter((t) => t.id === focusId) : store.active();

  renderList($("tileList"), list, {
    variant: "tile",
    emptyText: focusId ? "" : "~ 全部完成 ~",
    focusId,
    isCollapsed: (id) => !expanded.has(id),
  });
}

// 勾选切换：父子项都与主窗口共用同一实现
wireToggle($("tileList"));

// ---------- 折叠 / 展开 ----------
$("tileList").addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="collapse"]');
  if (!btn) return;
  const row = btn.closest(".todo[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  render();
});

// ---------- 快速新增 ----------
async function addFromTile() {
  const input = $("tileInput");
  const text = input.value.trim();
  if (!text) return;
  const created = await store.add(text);
  if (created) input.value = ""; // 保存失败时保留文字，避免白打
  input.focus();
}

$("tileInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !isComposing(e)) addFromTile();
});
$("tileAddBtn").addEventListener("click", addFromTile);

// ---------- Esc 关闭磁贴 ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.tile.hide();
});

// ---------- 启动 ----------
store.subscribe(render);
api.onTodosChanged((todos) => store.setTodos(todos));
api.onConfigChanged((c) => store.applyConfig(c)); // 专注变化要立即反映
onMinuteTick(render);

(async () => {
  try {
    await store.loadConfig(); // 先拿到 focusId，避免首帧显示全部后再跳变
  } catch { /* 读不到配置就按无专注处理 */ }
  try {
    await store.load();
  } catch (e) {
    console.error("[sticky] 磁贴读取待办失败:", e);
  }
})();
