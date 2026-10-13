// ============================================================
// 磁贴窗口入口：紧凑列表 + 快速新增 + 置顶切换
// 只引入共用核心，不再加载主窗口的面板与逻辑
// ============================================================
import { $ } from "./utils.js";
import { store, renderList, wireToggle, onMinuteTick } from "./core.js";

const api = window.sticky;

/** 输入法组合期间不要触发提交（中文输入按 Enter 是上屏，不是确认） */
const isComposing = (e) => e.isComposing || e.keyCode === 229;

function render() {
  renderList($("tileList"), store.active(), {
    variant: "tile",
    emptyText: "~ 全部完成 ~",
  });
}

// 勾选切换：与主窗口共用同一实现
wireToggle($("tileList"));

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

// ---------- 置顶切换 ----------
// 按钮状态以主进程的 isAlwaysOnTop() 为准，避免窗口重建后显示与实际不一致
async function syncPinState() {
  try {
    const pinned = await api.tile.pinned();
    $("tilePinBtn").classList.toggle("active", !!pinned);
  } catch { /* 忽略，保持默认 */ }
}

$("tilePinBtn").addEventListener("click", async () => {
  const pinned = await api.tile.pin();
  $("tilePinBtn").classList.toggle("active", !!pinned);
});

// ---------- Esc 关闭磁贴 ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.tile.hide();
});

// ---------- 启动 ----------
store.subscribe(render);
api.onTodosChanged((todos) => store.setTodos(todos));
onMinuteTick(render);
syncPinState();
store.load();
