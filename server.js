const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const onlineClients = new Map();
const registeredPlayers = new Map();
const playerTransfers = [];
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

  if (requestUrl.pathname === "/api/players/register") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let input;
      try { input = JSON.parse(body || "{}"); } catch {
        res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      const clientId = String(input.clientId || "");
      const name = String(input.name || "Игрок").slice(0, 40);
      const balance = Number(input.balance);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId) || !Number.isFinite(balance) || balance < 0 || balance > 1e15) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid player data" }));
      }
      const previous = registeredPlayers.get(clientId);
      registeredPlayers.set(clientId, {
        id: clientId,
        name: previous ? previous.name : name,
        balance: previous ? previous.balance : Math.round(balance * 1000) / 1000,
        registeredAt: previous ? previous.registeredAt : new Date().toISOString(),
        lastSeen: Date.now()
      });
      res.writeHead(200);
      return res.end(JSON.stringify({ registered: true }));
    });
    return;
  }

  if (requestUrl.pathname === "/api/players/list") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const clientId = String(requestUrl.searchParams.get("clientId") || "");
    if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId)) {
      res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid player ID" }));
    }
    const players = [...registeredPlayers.values()].filter(p => p.id !== clientId)
      .sort((a,b) => a.name.localeCompare(b.name))
      .map(p => ({ id:p.id, name:p.name, balance:p.balance }));
    res.writeHead(200); return res.end(JSON.stringify({ players }));
  }

  if (requestUrl.pathname === "/api/players/transfer") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") { res.writeHead(405, { Allow:"POST" }); return res.end(JSON.stringify({error:"Method not allowed"})); }
    let body = "";
    req.on("data", chunk => { body += chunk; if(body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let input;
      try { input = JSON.parse(body || "{}"); } catch { res.writeHead(400); return res.end(JSON.stringify({error:"Invalid JSON"})); }
      const senderId=String(input.clientId||""), recipientId=String(input.recipientId||""), amount=Number(input.amount);
      if(!/^[a-zA-Z0-9_-]{12,80}$/.test(senderId)||!/^[a-zA-Z0-9_-]{12,80}$/.test(recipientId)||senderId===recipientId||!Number.isFinite(amount)||amount<=0||Math.round(amount*1000)!==amount*1000) {
        res.writeHead(400); return res.end(JSON.stringify({error:"Проверь получателя и сумму перевода."}));
      }
      const sender=registeredPlayers.get(senderId), recipient=registeredPlayers.get(recipientId);
      if(!sender||!recipient){res.writeHead(404);return res.end(JSON.stringify({error:"Отправитель или получатель не зарегистрирован."}));}
      if(sender.balance<amount){res.writeHead(400);return res.end(JSON.stringify({error:"Недостаточно средств на серверном балансе."}));}
      sender.balance=Math.round((sender.balance-amount)*1000)/1000;
      recipient.balance=Math.round((recipient.balance+amount)*1000)/1000;
      const entry={id:Date.now().toString(36)+Math.random().toString(36).slice(2,8),senderId,recipientId,amount,createdAt:new Date().toISOString(),senderName:sender.name,recipientName:recipient.name};
      playerTransfers.unshift(entry); if(playerTransfers.length>1000)playerTransfers.length=1000;
      res.writeHead(200); return res.end(JSON.stringify({success:true,amount,recipient:{name:recipient.name,balance:recipient.balance},sender:{balance:sender.balance}}));
    });
    return;
  }

  if (requestUrl.pathname === "/api/players/transfers") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const clientId=String(requestUrl.searchParams.get("clientId")||"");
    if(!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId)){res.writeHead(400);return res.end(JSON.stringify({error:"Invalid player ID"}));}
    const history=playerTransfers.filter(t=>t.senderId===clientId||t.recipientId===clientId).slice(0,50).map(t=>({direction:t.recipientId===clientId?"in":"out",counterparty:t.recipientId===clientId?t.senderName:t.recipientName,amount:t.amount,createdAt:t.createdAt}));
    res.writeHead(200); return res.end(JSON.stringify({history}));
  }

  if (requestUrl.pathname === "/api/players/leaderboard") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    const players = [...registeredPlayers.values()]
      .sort((a, b) => b.balance - a.balance || a.registeredAt.localeCompare(b.registeredAt))
      .slice(0, 100)
      .map((p) => ({ name: p.name, balance: p.balance, registeredAt: p.registeredAt }));
    res.writeHead(200);
    return res.end(JSON.stringify({ players, count: registeredPlayers.size }));
  }

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
