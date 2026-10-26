# 📌 Sticky Todo — 磁贴待办清单

Electron 桌面待办：主窗口管理清单，另有一个透明置顶小磁贴常驻桌面。

## 功能

- 待办增删改查、勾选完成、行内编辑
- **子项**：一条待办可拆成多个子项，父项显示 `1/3` 进度；勾父项级联子项，子项全完成时父项自动完成
- **专注**：标记一条为当前专注，主窗口其余条目变暗；磁贴只显示这一条并展开其子项
- 筛选：全部 / 未完成 / 已完成 / 有提醒
- 磁贴：透明置顶小窗，位置、尺寸、置顶状态自动记住，`Esc` 关闭
- 提醒：到点弹出应用内提醒窗口（右下角置顶），可「推迟 10 分钟 / 标记完成 / 知道了」
- 托盘：悬停显示未完成与逾期数量，菜单可「新建待办」直接聚焦输入框
- 设置：磁贴透明度 / 磁贴尺寸 / 提醒声音 / 系统通知 / 开机自启

### 子项与专注的行为

| 场景 | 行为 |
|------|------|
| 勾选父项 | 所有子项一起完成 / 取消 |
| 勾选子项 | 子项全完成时父项自动完成；取消任一子项则父项取消完成 |
| 添加子项 | 悬停父项点「＋」；或在行内编辑父项时按 `Shift+Enter`，保存后直接进入子项录入 |
| 点击靶心 | 设为专注；再点一次取消 |
| 专注项被完成或删除 | 自动清除专注 |
| 主窗口 | 父项默认展开；专注项及其子项保持高亮，其余变暗 |
| 磁贴·有专注 | 只显示专注项，并自动展开其子项 |
| 磁贴·无专注 | 显示全部顶层待办，父项默认折叠；展开后把后续条目挤出可视区（可滚动查看） |

磁贴窗口尺寸不随内容变化，只有拖动或设置面板才会改变。

## 运行

```bash
npm install
npm start          # 开发运行
npm run dev        # 开发运行 + 打开 DevTools
```

## 快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 添加待办（输入法组合中不会误触发）；行内编辑时保存 |
| `Shift+Enter` | 行内编辑父项时：保存文字并接着录入子项（可连续回车） |
| `Ctrl+N` | 聚焦输入框 |
| `Ctrl+Shift+Space` | 全局：显示/隐藏磁贴 |
| `Esc` | 关闭面板 / 隐藏磁贴 |
| 双击待办文本 | 行内编辑 |

## 目录结构

```
main.js              主进程：数据持久化 / 窗口托盘 / 全局快捷键 / 提醒调度 / IPC
preload.js           contextBridge 暴露 window.sticky
renderer/
  main.html/main.js  主窗口（列表、提醒面板、设置面板）
  tile.html/tile.js  磁贴窗口（紧凑列表、快速新增、置顶切换）
  alarm.html/alarm.js 应用内提醒窗口
  core.js            共用：数据读写、状态订阅、列表渲染
  utils.js           共用：DOM 取值、HTML 转义、日期格式化
styles/
  base.css           设计令牌 + 两端共用的条目样式
  main.css / tile.css 各窗口专属
scripts/
  deploy.js          打包 → 校验 → 部署到正式版目录
  verify-asar.js     asar 回读校验器（与源码逐字节比对）
```

主窗口与磁贴共用一套列表渲染：两者都调用 `renderer/core.js` 的
`todoHtml()` / `renderList()`，仅通过 `variant: "main" | "tile"` 区分密度与操作按钮。

## 数据

数据在用户目录，**不在仓库里**：

| 环境 | 路径 |
|------|------|
| 正式版（打包后） | `%APPDATA%\sticky-todo\sticky-todo-data\` |
| 开发版（`npm start`） | `%APPDATA%\sticky-todo-dev\sticky-todo-data\` |

- `todos.json` — 待办数据（子项嵌在父项的 `children` 里，只有 `id/text/done`）
- `config.json` — 设置（含磁贴位置、置顶状态、`focusId` 当前专注）
- `alarms-fired.json` — 已触发的提醒记录（避免重启后重复提醒）

说明：

- 开发版与正式版的数据相互隔离，`npm start` 不会影响正式版数据。
- 写入采用原子替换并保留 `.bak`；解析失败的文件会改名为 `.corrupt-<时间>` 留档，
  并尝试从 `.bak` 恢复，不会静默清空。
- 写入失败（磁盘只读、权限不足）时界面会弹出提示并以磁盘状态回滚，输入内容保留。
- 提醒调度「到点即触发」，不会因轮询错位漏报；应用未运行时错过的提醒会在下次启动补报一次。
- 提醒不依赖系统通知：Windows 的 toast 可能在系统层面被关闭（`PushNotifications\ToastEnabled`
  为 0 时 `Notification` 会静默失败），因此到点一律弹出应用内提醒窗口，系统通知仅作可选通道。

## 构建与部署

正式版的 Electron 外壳极少变动，改代码通常只需替换 `resources\app.asar`：

```bash
npm run deploy                  # 打包 + 校验 + 部署到 F:\sticky
npm run deploy -- --dry-run     # 只打包和校验，不动目标目录
npm run deploy -- --target "D:\apps\StickyTodo" --exe StickyTodo
npm run deploy -- --yes         # 目标在运行时直接结束进程，不询问
```

打包使用官方 `@electron/asar`；脚本会在写入前后各做一次逐字节校验。

需要重新生成安装包时（产物在 `release/`）：

```bash
npm run pack:dir   # 免安装目录版
npm run pack       # NSIS 安装包
```

`dist/` 与 `release/` 都是构建产物，未纳入 git。

## 许可

[MIT](LICENSE) © 2026 mohan
