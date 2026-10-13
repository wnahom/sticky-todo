// ============================================================
// 应用内提醒窗口
// ------------------------------------------------------------
// 为什么需要它：本机 HKCU\...\PushNotifications\ToastEnabled = 0，
// 系统级 toast 被关闭，Notification.show() 静默失败（无任何报错）。
// 提醒是核心功能，不能依赖系统通知开关，因此改为应用内弹出置顶小窗。
// ============================================================
import { $ } from "./utils.js";

const api = window.sticky;

let todos = [];
let currentId = null;

function current() {
  return todos.find((t) => t.id === currentId) || null;
}

function render() {
  const t = current();
  if (!t) {
    $("alarmText").textContent = "没有待处理的提醒";
    $("alarmTime").textContent = "";
    $("moreLabel").textContent = "";
    document.querySelector(".alarm-actions").style.visibility = "hidden";
    return;
  }
  document.querySelector(".alarm-actions").style.visibility = "visible";
  $("alarmText").textContent = t.text;
  $("alarmTime").textContent = t.alarmTime
    ? `提醒时间 ${new Date(t.alarmTime).toLocaleString("zh-CN", { hour12: false })}`
    : "";
  const others = todos.length - 1;
  $("moreLabel").textContent = others > 0 ? `还有 ${others} 条` : "";
}

/** 主进程推送新的提醒列表 */
api.onAlarms((list) => {
  todos = list || [];
  if (!todos.some((t) => t.id === currentId)) currentId = todos[0]?.id ?? null;
  render();
});

$("btnDismiss").addEventListener("click", async () => {
  if (currentId) await api.alarm.dismiss(currentId);
});

$("btnSnooze").addEventListener("click", async () => {
  if (currentId) await api.alarm.snooze(currentId, 10);
});

$("btnDone").addEventListener("click", async () => {
  if (currentId) await api.alarm.done(currentId);
});

// 键盘：Esc 等于「知道了」
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("btnDismiss").click();
});

// 初始拉取（窗口可能是后创建的，先取一次当前队列）
(async () => {
  try {
    todos = (await api.alarm.pending()) || [];
    currentId = todos[0]?.id ?? null;
  } catch { /* 忽略 */ }
  render();
})();
