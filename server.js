const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const onlineClients = new Map();
const ONLINE_TTL_MS = 60_000;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");

  if (requestUrl.pathname === "/api/online") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const now = Date.now();
    for (const [id, seen] of onlineClients) {
      if (now - seen > ONLINE_TTL_MS) onlineClients.delete(id);
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
      req.on("end", () => {
        let clientId = "";
        try { clientId = String(JSON.parse(body || "{}").clientId || ""); } catch {}
        if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId)) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "Invalid client ID" }));
        }
        onlineClients.set(clientId, Date.now());
        res.writeHead(200);
        return res.end(JSON.stringify({ online: onlineClients.size }));
      });
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET, POST" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify({ online: onlineClients.size }));
  }


  // Secure server-side proxy for checking the VK COIN account.
  // The API key is read only from Railway environment variables and is never sent to the browser.
  if (requestUrl.pathname === "/api/vkcoin/me") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }

    const apiKey = process.env.VKCOIN_API_KEY;
    const configuredUrl = process.env.VKCOIN_API_URL;
    if (!apiKey || !configuredUrl) {
      res.writeHead(503);
      return res.end(JSON.stringify({
        error: "VK COIN API is not configured",
        requiredVariables: ["VKCOIN_API_URL", "VKCOIN_API_KEY"]
      }));
    }

    try {
      const normalizedUrl = configuredUrl.replace(/\/+$/, "");
      const apiUrl = normalizedUrl.endsWith("/api/vkcoin/external/me")
        ? normalizedUrl
        : normalizedUrl + "/api/vkcoin/external/me";
      const upstream = await fetch(apiUrl, {
        method: "GET",
        headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10000)
      });
      const body = await upstream.text();
      let data;
      try { data = JSON.parse(body); } catch { data = { message: "VK COIN API returned a non-JSON response" }; }
      if (!upstream.ok) {
        res.writeHead(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
        return res.end(JSON.stringify({
          error: "VK COIN API request failed",
          upstreamStatus: upstream.status,
          details: data
        }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ connected: true, account: data }));
    } catch (error) {
      res.writeHead(502);
      return res.end(JSON.stringify({
        error: "Could not reach VK COIN API",
        details: error.name === "TimeoutError" ? "Request timed out" : "Network request failed"
      }));
    }
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }

  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(root, "." + pathname);

  if (!filePath.startsWith(root + path.sep) && filePath !== path.join(root, "index.html")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(port, "0.0.0.0", () => {
  console.log("VK Coin web app listening on port " + port);
});
