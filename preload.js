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
  onTodosChanged: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on("todos-changed", h); return () => ipcRenderer.removeListener("todos-changed", h); },
});
