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

/** 当天零点（本地时区） */
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 两个日期相差的自然天数（按本地日历日计算，不是 24 小时） */
export function dayDiff(target, base = new Date()) {
  return Math.round((startOfDay(target) - startOfDay(base)) / 86400000);
}

/**
 * 时间点 → 便于一眼判断的短文本。
 * 最近三天用「今天/明天/昨天」，同年省略年份，跨年补上年份。
 */
export function fmtSmart(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = dayDiff(d, now);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (diff === 0) return `今天 ${hhmm}`;
  if (diff === 1) return `明天 ${hhmm}`;
  if (diff === -1) return `昨天 ${hhmm}`;
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

/** 只有日期时（无具体时刻）→ 今天/明天/昨天 或 月/日 */
export function fmtSmartDate(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = dayDiff(d, now);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 10/13 18:55（保留原始形式，供需要完整信息的场合） */
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
