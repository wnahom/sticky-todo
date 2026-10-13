# 📌 Sticky Todo — 磁贴待办清单

Electron 桌面待办：主窗口管理清单，另有一个透明置顶小磁贴常驻桌面。

## 运行

```bash
npm install
npm start          # 开发运行
npm run dev        # 开发运行 + 打开 DevTools
```

## 目录结构

```
main.js              主进程：数据持久化 / 窗口托盘 / 全局快捷键 / 闹钟调度 / IPC
preload.js           contextBridge 暴露 window.sticky（todos / config / tile / win / autostart）
renderer/
  main.html          主窗口
  main.js            主窗口逻辑（列表、提醒面板、设置面板）
  tile.html          磁贴窗口
  tile.js            磁贴逻辑（紧凑列表、快速新增、置顶切换）
  core.js            共用：数据读写、状态订阅、唯一的列表渲染器
  utils.js           共用：DOM 取值、HTML 转义、本地时区日期格式化
styles/
  base.css           设计令牌 + 两端共用的条目样式
  main.css           主窗口专属
  tile.css           磁贴专属
tools/
  verify-asar.js     asar 回读校验器（与源码逐字节比对）
  compress-icon.js   图标压缩（无损 / JPEG 中转两种模式）
  smoke.js           主窗口自检
  smoke-features.js  功能回归（筛选、相对时间、写入失败提示）
  smoke-tilepin.js   磁贴置顶状态同步与持久化自检
scripts/
  deploy.js          打包 → 校验 → 部署到正式版目录
```

主窗口与磁贴**不各写一套列表渲染**：两者都调用 `renderer/core.js` 的 `todoHtml()` / `renderList()`，
仅通过 `variant: "main" | "tile"` 区分密度与是否显示操作按钮。

### 磁贴尺寸的高 DPI 陷阱（改动前务必先读）

多显示器且缩放率不同时（例如本机 100% + 150%），Windows 会按窗口**所在屏**的缩放率
重新解释尺寸。实测：

| 做法 | 请求 220×300 的实际结果 |
|------|------------------------|
| 构造时传 `width`/`height` | 150% 屏上变成 **330×450** |
| 隐藏状态下 `setBounds` 后立刻 `show()` | 仍然 **330×450** |
| `setBounds` 后停顿约 150ms 再 `show()` | 220×300 ✓ |

因此 `createTile()` 的做法是：构造时不传尺寸 → 隐藏状态先 `setBounds` → 停顿 150ms →
`show()` → 400ms 后再校验一次并在不符时纠正。这两个定时器都受 `boundsDirty` 保护：
若用户在此期间从设置面板改了尺寸，迟到的旧 bounds 会被丢弃（该竞态曾实际复现）。
`tools/test-dpi.js` 覆盖了这些场景。

## 功能

- 待办增删改查、勾选完成、行内编辑
- 筛选：全部 / 未完成 / 已完成 / 有提醒
- 磁贴模式（透明置顶小窗，位置、尺寸、置顶状态自动记住，`Esc` 关闭）
- 提醒：到点弹出**应用内提醒窗口**（右下角置顶），可直接「推迟 10 分钟 / 标记完成 / 知道了」
- 托盘：悬停显示未完成与逾期数量，菜单可「新建待办」直接聚焦输入框
- 设置：磁贴透明度 / 磁贴尺寸 / 提醒声音 / 系统通知 / 开机自启

### 关于提醒的实现

提醒**不依赖系统通知**。原因是 Windows 的 toast 可能在系统层面被关闭：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled = 0
```

此时 `Notification.show()` 会静默失败，只留下一条日志：

```
Notification failed - Settings prevent the notification type from being delivered. (HRESULT: -2143420140)
```

用户完全看不到提醒，且应用无法感知。因此到点一律弹出应用内提醒窗口，系统通知仅作为可选的额外通道
（设置面板可关，关掉后就不再产生上面的失败日志）。

若希望恢复系统通知，把 `ToastEnabled` 置为 1 并重启资源管理器：

```powershell
Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications" ToastEnabled 1
```

## 快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 添加待办（输入法组合中不会误触发） |
| `Ctrl+N` | 聚焦输入框 |
| `Ctrl+Shift+Space` | 全局：显示/隐藏磁贴 |
| `Esc` | 关闭面板 / 隐藏磁贴 |
| 双击待办文本 | 行内编辑 |

## 数据

数据在用户目录，**不在仓库里**：

| 环境 | 路径 |
|------|------|
| 正式版（打包后） | `%APPDATA%\sticky-todo\sticky-todo-data\` |
| 开发版（`npm start`） | `%APPDATA%\sticky-todo-dev\sticky-todo-data\` |

目录内容：

- `todos.json` — 待办数据
- `config.json` — 设置（含 `tileBounds` 位置与 `tilePinned` 置顶状态）
- `alarms-fired.json` — 已触发的提醒记录（避免重启后重复提醒）

**开发版与正式版的数据是隔离的**（`main.js` 顶部 `app.setPath("userData", …)`）。
两者若共用目录，`npm start` 会直接覆写正式版的 `todos.json` —— 修改这段代码前请留意。

写入采用原子替换（临时文件 → fsync → rename）并保留 `.bak`；若 `todos.json`
解析失败会被改名为 `.corrupt-<时间>` 留档，并尝试从 `.bak` 恢复，不会静默清空。

写入失败（磁盘只读、权限不足）时界面会弹出红色提示并以磁盘状态回滚，
输入框内容保留，不会出现「看起来添加成功、其实没保存」。

提醒的可靠性：调度器每 5 秒检查一次，采用「到点即触发」而非时间窗匹配，因此不会
因为轮询错位而漏报；若到点时应用未运行，下次启动会补报一次（超过 12 小时的旧提醒
只记录不再补报）。已触发记录持久化在 `alarms-fired.json`，重启不会重复提醒。

## 构建与部署

正式版的 Electron 外壳极少变动，改代码通常只需替换 `resources\app.asar`：

```bash
npm run deploy                  # 打包 + 校验 + 部署到 F:\sticky
npm run deploy -- --dry-run     # 只打包和校验，不动目标目录
npm run deploy -- --target "D:\apps\StickyTodo" --exe StickyTodo
npm run deploy -- --yes         # 目标在运行时直接结束进程，不询问
```

打包使用**官方 `@electron/asar`**（随全局 electron-builder 一起安装）。
切勿手写 asar 头：Chromium 的 `asar::Archive::Init` 会校验长度字段，
稍有偏差就报 `Failed to parse header from ...`，应用启动即退出且不显示任何窗口
（2026-10-13 曾因此踩坑）。脚本会校验打包结果与源码逐字节一致后才写入。

需要重新生成安装包时（产物在 `release/`）：

```bash
npm run pack:dir   # 免安装目录版
npm run pack       # NSIS 安装包
```

`dist/` 与 `release/` 都是构建产物，未纳入 git。

## 许可

[MIT](LICENSE) © 2026 mohan
