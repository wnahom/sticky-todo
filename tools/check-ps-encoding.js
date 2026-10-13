// 实测各种「PowerShell 写文件」方式对中文的破坏情况
// 目的：得出可依赖的规则，而不是靠记性。结论见 CONTRIBUTING.md。
//
// 本机是 Windows PowerShell 5.1（未安装 pwsh 7）。运行：
//   node tools/check-ps-encoding.js
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(process.env.TEMP, "dsh-enc-test");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const SAMPLE = "// 中文注释 test 测试\nconst a = 1;\n";
const readBackOk = (f) => {
  const buf = fs.readFileSync(f);
  const txt = buf.toString("utf8");
  return { ok: txt === SAMPLE, bytes: buf.length, head: [...buf.slice(0, 3)].join(","), txt: txt.replace(/\n/g, "\\n").slice(0, 40) };
};

const cases = [
  ["Set-Content -Encoding UTF8", `Set-Content -Path "${dir}\\a.txt" -Value $s -Encoding UTF8`],
  ["Set-Content (默认, 无 -Encoding)", `Set-Content -Path "${dir}\\b.txt" -Value $s`],
  ["Out-File -Encoding UTF8", `$s | Out-File -FilePath "${dir}\\c.txt" -Encoding UTF8`],
  ["Out-File -Encoding utf8NoBOM", `$s | Out-File -FilePath "${dir}\\d.txt" -Encoding utf8NoBOM`],
  ["[IO.File]::WriteAllText + UTF8Encoding(false)", `[System.IO.File]::WriteAllText("${dir}\\e.txt", $s, (New-Object System.Text.UTF8Encoding($false)))`],
  ["[IO.File]::WriteAllText + UTF8Encoding(true)", `[System.IO.File]::WriteAllText("${dir}\\f.txt", $s, (New-Object System.Text.UTF8Encoding($true)))`],
  ["Get-Content|Set-Content 往返(改一行)", `$t = Get-Content "${dir}\\a.txt" -Raw; $t = $t -replace "a = 1","a = 2"; Set-Content -Path "${dir}\\g.txt" -Value $t -Encoding UTF8`],
  ["Add-Content -Encoding UTF8 (追加中文)", `Add-Content -Path "${dir}\\h.txt" -Value "# 追加中文" -Encoding UTF8`],
];

console.log("=== PowerShell 写文件编码实测 ===");
console.log("（判据：读回后是否 === 原始字符串）\n");

// 用文件传脚本，避免命令行引号问题
const runner = path.join(dir, "run.ps1");
const lines = ["$ErrorActionPreference='Stop'", `$s = [System.IO.File]::ReadAllText("${path.join(dir, "sample.txt")}", [System.Text.Encoding]::UTF8)`];
fs.writeFileSync(path.join(dir, "sample.txt"), SAMPLE, "utf8");
for (const [name, cmd] of cases) lines.push(`try { ${cmd} } catch { Write-Output "ERR" }`);
fs.writeFileSync(runner, lines.join("\n"), "utf8");

execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner], { stdio: "ignore" });

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
for (let i = 0; i < cases.length; i++) {
  const f = path.join(dir, `${files[i]}.txt`);
  if (!fs.existsSync(f)) { console.log(`  ?    ${cases[i][0]}  → 未生成`); continue; }
  const r = readBackOk(f);
  const verdict = cases[i][0].includes("Add-Content") ? "(追加，单独看)" : r.ok ? "OK  " : "损坏";
  console.log(`  ${verdict} ${cases[i][0].padEnd(44)} 字节=${String(r.bytes).padStart(3)} BOM=${r.head} 内容=${r.txt}`);
}

console.log("\n=== 结论 ===");
console.log("  Windows PowerShell 5.1 下，未显式指定编码的 Set-Content/Add-Content 会按 ANSI(GBK) 写盘，");
console.log("  中文写入后即成乱码；而 PowerShell 7 (pwsh) 默认 UTF-8 无 BOM，行为不同。");
fs.rmSync(dir, { recursive: true, force: true });
