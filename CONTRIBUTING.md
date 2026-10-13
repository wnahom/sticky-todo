# 维护须知

本项目的开发环境有两个反复踩到的坑，改动前请先读这一页。

## 1. 不要用 PowerShell 写任何源文件（本机是 Windows PowerShell 5.1）

本机**没有安装 PowerShell 7**，`powershell` 指向
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，版本 5.1（Desktop）。
它的默认读写编码是 ANSI(GBK) 而非 UTF-8，因此：

- **读**：无 BOM 的 UTF-8 文件（含中文）会被当 ANSI 解码成乱码。
  更麻烦的是乱码的多字节序列可能"吃掉"换行，导致**下一行代码被并进注释**，
  表现为莫名其妙的语法错误。
- **写**：写回时按 ANSI 编码，中文注释直接损坏。

实测各种写法的结果（原始内容 `// 中文注释 test 测试\nconst a = 1;\n`）：

| 写法 | 结果 |
|------|------|
| `Set-Content -Encoding UTF8` | 加 BOM + 换行被改（尾部多出空行） |
| `Set-Content`（无 `-Encoding`） | 中文变乱码 |
| `Out-File -Encoding UTF8` | 加 BOM + 换行被改 |
| `Out-File -Encoding utf8NoBOM` | 该值在 5.1 不存在，命令报错 |
| `Add-Content -Encoding UTF8` | **中文变乱码** |
| `Get-Content \| Set-Content` 往返 | 加 BOM + 换行被改 |
| `[IO.File]::WriteAllText(p, s, UTF8Encoding($false))` | ✅ 唯一逐字节正确 |

**规则：**

- 改源码用 `edit` 工具（或 Node 的 `fs.writeFileSync(p, s, "utf8")`），不要用 PowerShell。
- PowerShell 只用于读取/检查、运行命令、以及 `[IO.File]::ReadAllBytes` 这类诊断。
- 批量替换**不能**用 `Get-Content | Set-Content` 图省事 —— 需要批量改时写个 Node 脚本。
- 万一怀疑文件已损坏，先看字节数与非 ASCII 字节占比：

  ```powershell
  $b = [System.IO.File]::ReadAllBytes("main.js")
  ($b | Where-Object { $_ -gt 127 }).Count   # 中文文件应为数百；接近 0 说明中文已丢
  ```

- 已踩过的实例：`main.js` 被 `Get-Content|Set-Content` 整文件转成乱码（已从 git 恢复）；
  `.gitignore` 被 `Add-Content` 写成 GBK+UTF-8 混合导致无法读取；`deploy.ps1` 的中文注释
  让下一行赋值语句被注释掉，脚本静默出错。

因此仓库内的 PowerShell 脚本（如历史上的 `deploy.ps1`）一律要求**纯 ASCII**，
部署逻辑现已改为 Node（`scripts/deploy.js`），从根本上避开这条坑。

## 2. 磁贴尺寸在高 DPI 屏上会被乘掉

多显示器且缩放率不同时（本机 100% + 150%），Windows 按窗口**所在屏**的缩放率重新解释尺寸。
实测请求 220×300 放在 150% 屏上：

| 做法 | 结果 |
|------|------|
| 构造时传 `width`/`height` | 330×450 |
| 隐藏状态下 `setBounds` 后立刻 `show()` | 330×450 |
| `setBounds` 后停顿约 150ms 再 `show()` | 220×300 ✓ |
| `show()` 之后 500ms 再 `setBounds` | 330×450（异步覆盖） |

所以尺寸不能用 `BrowserWindow` 构造参数，也不能和 `show()` 同时应用。
`createTile()` 的现有做法见注释；`boundsDirty` 标志用于防止迟到的旧 bounds
覆盖用户在启动阶段做出的修改（该竞态曾实际复现）。
回归测试：`tools/test-dpi.js`。

## 3. 打包必须用官方 @electron/asar

不要手写 asar 头。Chromium 的 `asar::Archive::Init` 会校验长度字段，
稍有偏差即报 `Failed to parse header from ...`，应用启动即退出且不显示任何窗口。
`scripts/deploy.js` 已封装官方工具，并在写入前后各做一次逐字节校验。
