const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  todos: {
    list: () => ipcRenderer.invoke("todos:list"),
    create: (t) => ipcRenderer.invoke("todos:create", t),
    update: (id, u) => ipcRenderer.invoke("todos:update", id, u),
    delete: (id) => ipcRenderer.invoke("todos:delete", id),
    toggle: (id) => ipcRenderer.invoke("todos:toggle", id),
  },
  config: { get: () => ipcRenderer.invoke("config:get"), save: (c) => ipcRenderer.invoke("config:save", c) },
  tile: { close: () => ipcRenderer.invoke("tile:close"), toggle: () => ipcRenderer.invoke("tile:toggle"), pin: () => ipcRenderer.invoke("tile:pin"), resize: (w,h) => ipcRenderer.invoke("tile:resize", w, h) },
  onOpenSettings: (cb) => { const h = () => cb(); ipcRenderer.on('open-settings', h); return () => ipcRenderer.removeListener('open-settings', h); },
  onTodosChanged: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on("todos-changed", h); return () => ipcRenderer.removeListener("todos-changed", h); },
  autostart: { get: () => ipcRenderer.invoke("autostart:get"), set: (v) => ipcRenderer.invoke("autostart:set", v) },
});
