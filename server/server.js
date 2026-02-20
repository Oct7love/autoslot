/* ─────────────────────────────────────────────
   Slot Sentinel – 远程监控服务器
   零依赖，纯 Node.js，SSE 推送
   用法: SS_TOKEN=xxx PORT=9800 node server.js
   ───────────────────────────────────────────── */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "9800", 10);
const TOKEN = process.env.SS_TOKEN || crypto.randomBytes(12).toString("hex");

const MAX_LOGS = 500;
let logs = [];
let states = {};
const sseClients = new Set();

// ── 工具函数 ────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(frame); } catch (_) { sseClients.delete(c); }
  }
}

// ── HTTP 服务器 ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── 面板页面 ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (_) {
      res.writeHead(500); res.end("dashboard.html not found");
    }
    return;
  }

  // ── SSE 实时推送（面板连接此端点）────────────────────────────────
  if (req.method === "GET" && url.pathname === "/events") {
    const token = url.searchParams.get("token");
    if (token !== TOKEN) { res.writeHead(401); res.end("Unauthorized"); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    // 初始数据：最近 100 条日志 + 所有扩展状态
    res.write(`event: init\ndata: ${JSON.stringify({ logs: logs.slice(-100), states })}\n\n`);
    sseClients.add(res);

    // Keep-alive 每 25 秒
    const ka = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch (_) { clearInterval(ka); sseClients.delete(res); }
    }, 25000);
    req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  // ── POST 端点鉴权 ───────────────────────────────────────────────
  if (req.method === "POST") {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end("Unauthorized"); return; }
  }

  // ── 接收日志 ────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/log") {
    try {
      const data = await parseBody(req);
      const entry = { ...data, serverTs: Date.now() };
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
      broadcast("log", entry);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (_) { res.writeHead(400); res.end("Bad Request"); }
    return;
  }

  // ── 接收状态 ────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/state") {
    try {
      const data = await parseBody(req);
      const id = data.clientId || "default";
      states[id] = { ...data, serverTs: Date.now() };
      // 清理超过 60 秒没更新的实例
      const now = Date.now();
      for (const [k, v] of Object.entries(states)) {
        if (now - v.serverTs > 120000) delete states[k];
      }
      broadcast("state", states[id]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (_) { res.writeHead(400); res.end("Bad Request"); }
    return;
  }

  res.writeHead(404); res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  ⚡ Slot Sentinel 远程监控服务器");
  console.log("  ────────────────────────────────");
  console.log(`  面板:  http://localhost:${PORT}/`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  端口:  ${PORT}`);
  console.log("");
  console.log("  在插件 Popup「远程监控」里填入:");
  console.log(`    服务器地址: http://<你的公网IP>:${PORT}`);
  console.log(`    Token:      ${TOKEN}`);
  console.log("");
});
