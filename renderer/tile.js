// ============================================================
// 磁贴窗口入口：紧凑列表 + 快速新增 + 置顶切换
// 只引入共用核心，不再加载主窗口的面板与逻辑
// ============================================================
import { $ } from "./utils.js";
import { store, renderList, wireToggle } from "./core.js";

const api = window.sticky;

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
  input.value = "";
  await store.add(text);
  input.focus();
}

$("tileInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFromTile();
});
$("tileAddBtn").addEventListener("click", addFromTile);

// ---------- 置顶切换 ----------
$("tilePinBtn").addEventListener("click", async () => {
  const pinned = await api.tile.pin();
  $("tilePinBtn").classList.toggle("active", pinned);
});

// ---------- 启动 ----------
store.subscribe(render);
api.onTodosChanged((todos) => store.setTodos(todos));
store.load();
