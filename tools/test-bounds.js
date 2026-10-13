// 直接验证 usableBounds 的夹取逻辑。
// 该函数是纯函数（只依赖 screen.getAllDisplays()），但它是 main.js 的私有函数，
// 无法 import。因此从源码文本中提取该函数体再求值，确保测的是真实实现，
// 而不是我另抄一份（那样会重蹈「自己的校验器验证自己的格式」的覆辙）。
const { app, screen } = require("electron");
const fs = require("fs");
const path = require("path");

app.whenReady().then(() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  // 提取 function usableBounds(...) { ... } 的完整文本（按大括号配平）
  const start = src.indexOf("function usableBounds(");
  if (start === -1) { console.log("未找到 usableBounds"); app.exit(1); return; }
  let depth = 0, end = -1, seen = false;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") { depth--; if (seen && depth === 0) { end = i + 1; break; } }
  }
  const fnText = src.slice(start, end);
  console.log("提取到函数长度:", fnText.length, "字符");
  console.log("首行:", fnText.split("\n")[0]);

  const usableBounds = eval(`(${fnText})`);

  const ds = screen.getAllDisplays();
  console.log("\n显示器工作区:");
  for (const d of ds) console.log("  ", JSON.stringify(d.workArea));

  console.log("\n=== usableBounds 直接测试 ===");
  const cases = [
    ["正常位置(副屏内)", { x: 2020, y: 80, width: 260, height: 300 }, "keep"],
    ["大部分在屏外", { x: 3597, y: 50, width: 260, height: 300 }, "clamp"],
    ["完全在屏外", { x: 9000, y: 9000, width: 260, height: 300 }, "fallback"],
    ["负坐标", { x: -500, y: -300, width: 260, height: 300 }, "fallback"],
    ["尺寸超过工作区", { x: 1920, y: 0, width: 1900, height: 1000 }, "clamp"],
    ["主屏右下角内", { x: 1600, y: 700, width: 260, height: 300 }, "keep"],
    ["主屏右下角外", { x: 1900, y: 1000, width: 260, height: 300 }, "clamp"],
    ["无效坐标", { x: NaN, y: 0, width: 260, height: 300 }, "fallback"],
    ["空值", null, "fallback"],
    ["仅尺寸无坐标", { width: 260, height: 300 }, "fallback"],
  ];

  let pass = 0, fail = 0;
  for (const [label, saved, expect] of cases) {
    const r = usableBounds(saved);
    let ok, note;
    if (expect === "fallback") {
      ok = r === null;
      note = r === null ? "回退居中" : `非预期地返回了 ${JSON.stringify(r)}`;
    } else {
      if (!r) { ok = false; note = "意外回退居中"; }
      else {
        const fully = ds.some((d) => {
          const wa = d.workArea;
          return r.x >= wa.x && r.y >= wa.y &&
                 r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;
        });
        const samePos = saved && r.x === saved.x && r.y === saved.y;
        ok = fully && (expect === "clamp" ? true : samePos);
        note = `→ ${JSON.stringify(r)} 完全可见=${fully}${expect === "keep" ? ` 位置保持=${samePos}` : ""}`;
      }
    }
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(16)} 期望=${expect.padEnd(8)} ${note}`);
    ok ? pass++ : fail++;
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  console.log("=== END ===");
  app.exit(fail === 0 ? 0 : 1);
});
