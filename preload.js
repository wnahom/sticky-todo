const { contextBridge, ipcRenderer } = require("electron");

// 窗口角色由主进程通过 loadFile 的 query 传入：main | tile
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "tile" ? "tile" : "main";

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("sticky", {
  mode,

  todos: {
    list: () => ipcRenderer.invoke("todos:list"),
    create: (text) => ipcRenderer.invoke("todos:create", text),
    update: (id, patch) => ipcRenderer.invoke("todos:update", id, patch),
    toggle: (id) => ipcRenderer.invoke("todos:toggle", id),
    remove: (id) => ipcRenderer.invoke("todos:delete", id),
  },

  config: {
    get: () => ipcRenderer.invoke("config:get"),
    save: (patch) => ipcRenderer.invoke("config:save", patch),
  },

  tile: {
    show: () => ipcRenderer.invoke("tile:show"),
    hide: () => ipcRenderer.invoke("tile:hide"),
    pin: () => ipcRenderer.invoke("tile:pin"),
    pinned: () => ipcRenderer.invoke("tile:pinned"),
    bounds: () => ipcRenderer.invoke("tile:bounds"),
    resize: (w, h) => ipcRenderer.invoke("tile:resize", w, h),
  },

  win: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    close: () => ipcRenderer.invoke("win:close"),
  },

  // 应用内提醒窗口（系统 toast 被关闭时的可靠兜底）
  alarm: {
    pending: () => ipcRenderer.invoke("alarm:pending"),
    dismiss: (id) => ipcRenderer.invoke("alarm:dismiss", id),
    done: (id) => ipcRenderer.invoke("alarm:done", id),
    snooze: (id, minutes) => ipcRenderer.invoke("alarm:snooze", id, minutes),
  },
  onAlarms: on("alarms"),

  autostart: {
    get: () => ipcRenderer.invoke("autostart:get"),
    set: (v) => ipcRenderer.invoke("autostart:set", v),
  },

  // 主进程推送：数据/配置变更
  onTodosChanged: on("todos-changed"),
  onConfigChanged: on("config-changed"),

  // 托盘「新建待办」：把光标送进输入框
  onFocusInput: (cb) => on("focus-input")(() => cb()),

  // 磁贴被拖动/缩放：设置面板据此同步尺寸滑块
  onTileBoundsChanged: on("tile-bounds-changed"),
});
