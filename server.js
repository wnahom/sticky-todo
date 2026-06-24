const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PORT = 4321;
const FILE = path.join(__dirname, "app.html");

// 简单 HTTP 服务器
const server = http.createServer((req, res) => {
  if (req.url === "/data" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const d = JSON.parse(body);
        fs.writeFileSync(path.join(__dirname, "data.json"), JSON.stringify(d, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end("bad");
      }
    });
  } else if (req.url === "/data") {
    try {
      const raw = fs.readFileSync(path.join(__dirname, "data.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(raw);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
  } else if (req.url === "/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      fs.writeFileSync(path.join(__dirname, "config.json"), body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  } else if (req.url === "/config") {
    try {
      const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(raw);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ shortcut: "Ctrl+Shift+Space", opacity: 0.92, alwaysOnTop: true }));
    }
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(FILE, "utf-8"));
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  📌 Sticky Todo 已启动`);
  console.log(`  ─────────────────────────`);
  console.log(`  打开浏览器访问: ${url}`);
  console.log(`  按 Ctrl+C 停止服务器`);
  console.log(`  ─────────────────────────\n`);

  // 自动打开浏览器
  try {
    execSync(`start "" "${url}"`, { shell: true, timeout: 3000 });
    console.log("  已自动打开浏览器 ✓");
  } catch {
    console.log("  请手动打开浏览器");
  }
});
