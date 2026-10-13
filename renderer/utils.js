// ============================================================
// 通用工具
// ============================================================

/** 取元素 */
export const $ = (id) => document.getElementById(id);

/** HTML 转义（待办文本一律经此进入 innerHTML） */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 本地时区日期 → YYYY-MM-DD（勿用 toISOString，那是 UTC，东八区凌晨会差一天） */
export function toLocalDateInput(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

/** 本地时区时间 → HH:MM */
export function toLocalTimeInput(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  return `${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

/** 10/13 18:55 */
export function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 10/13 */
export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 是否已逾期（以提醒时间为准；无提醒时间则不算逾期） */
export function isOverdue(todo, now = Date.now()) {
  if (!todo || todo.done || !todo.alarmEnabled || !todo.alarmTime) return false;
  const at = new Date(todo.alarmTime).getTime();
  return Number.isFinite(at) && at < now;
}
