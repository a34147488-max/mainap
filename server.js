const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const onlineClients = new Map();
const registeredPlayers = new Map();
const playerTransfers = [];
const playerGameRounds = [];
const marketListings = [];
const marketHistory = [];
const referredPlayerIds = new Set();
const PLAYER_DATA_FILE = path.join(root, '.vkcoin-player-data.json');
try {
  const saved = JSON.parse(fs.readFileSync(PLAYER_DATA_FILE, 'utf8'));
  for (const p of (saved.players || [])) if (p && p.id) registeredPlayers.set(p.id, p);
  for (const t of (saved.transfers || [])) playerTransfers.push(t);
  for (const id of (saved.referredPlayerIds || [])) referredPlayerIds.add(id);
  for (const item of (saved.marketListings || [])) marketListings.push(item);
  for (const item of (saved.marketHistory || [])) marketHistory.push(item);
} catch {}
function persistPlayerData() {
  try { fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify({players:[...registeredPlayers.values()], transfers:playerTransfers.slice(0,1000), referredPlayerIds:[...referredPlayerIds], marketListings, marketHistory:marketHistory.slice(-300)})); } catch (e) { console.error('Could not persist player data:', e.message); }
}
const START1_FILE = path.join(root, '.start1-activations.json');
let savedStart1Users=[];try{savedStart1Users=JSON.parse(fs.readFileSync(START1_FILE,'utf8'))}catch{}
const start1Users = new Set(Array.isArray(savedStart1Users)?savedStart1Users:[]);
const PREMIUM_FILE = path.join(root, '.premium-promos.json');
const PREMIUM_CODES = ['VKC-PREM-7D-A7K2','VKC-PREM-7D-M4Q9','VKC-PREM-7D-R8T3','VKC-PREM-7D-C6W1','VKC-PREM-7D-P2N5','VKC-PREM-7D-H9D4','VKC-PREM-7D-X3B7','VKC-PREM-7D-F5L8','VKC-PREM-7D-J1S6','VKC-PREM-7D-Z7G2'];
const PREMIUM_CODES_NEW = ["VKC-PREM-7D-Q8M2","VKC-PREM-7D-B4T9","VKC-PREM-7D-L6R3","VKC-PREM-7D-W2K7","VKC-PREM-7D-D9F5","VKC-PREM-7D-Y3H8","VKC-PREM-7D-C7N4","VKC-PREM-7D-G5P1","VKC-PREM-7D-T8V6","VKC-PREM-7D-Z4X2"];
let premiumPromos = {};
try { premiumPromos = JSON.parse(fs.readFileSync(PREMIUM_FILE, 'utf8')); } catch {}
for (const code of PREMIUM_CODES) if (!premiumPromos[code]) premiumPromos[code] = { usedBy: null, usedAt: null };
for (const code of PREMIUM_CODES_NEW) if (!premiumPromos[code]) premiumPromos[code] = { usedBy: null, usedAt: null };
function savePremiumPromos(){ fs.writeFileSync(PREMIUM_FILE, JSON.stringify(premiumPromos, null, 2)); }
// Always derive the premium expiry from the redeemed promo record as a fallback.
// This prevents a normal player profile sync from hiding an actually activated PREMIUM.
function getPremiumUntil(player){
  if(!player) return 0;
  const stored=Number(player.premiumUntil||0);
  const redeemed=Object.values(premiumPromos).find(x=>x && x.usedBy===player.id && Number(x.usedAt||0)>0);
  const recovered=redeemed ? Number(redeemed.usedAt)+7*86400000 : 0;
  return Math.max(stored,recovered);
}
const OBnova_FILE = path.join(root, '.obnova-activations.json');
let savedObnovaUsers=[];try{savedObnovaUsers=JSON.parse(fs.readFileSync(OBnova_FILE,'utf8'))}catch{}
const obnovaUsers = new Set(Array.isArray(savedObnovaUsers)?savedObnovaUsers:[]);

function makeRouletteMultipliers(){const nums=Array.from({length:37},(_,i)=>i);for(let i=nums.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[nums[i],nums[j]]=[nums[j],nums[i]]}const values=[5,10,15,20,25,50,100];for(let i=values.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[values[i],values[j]]=[values[j],values[i]]}const count=1+Math.floor(Math.random()*3);return nums.slice(0,count).map((number,i)=>({number,mult:values[i]}))}
let rouletteRoundSequence=1;
let currentRouletteRound={id:rouletteRoundSequence,startedAt:0,endsAt:0,status:'open',result:null,bets:[],multipliers:makeRouletteMultipliers()};
const gamePresence=new Map();
const GAME_TYPES=['ladder','nvuti','crash','olympus','bandit','wheel','flip','dice','cups','mines','csgo'];
setInterval(()=>{const now=Date.now();if(currentRouletteRound.status==='open'&&currentRouletteRound.endsAt>0&&now>=currentRouletteRound.endsAt){currentRouletteRound.status='resolved';currentRouletteRound.result=Math.floor(Math.random()*37);currentRouletteRound.resolvedAt=now}else if(currentRouletteRound.status==='resolved'&&now-currentRouletteRound.resolvedAt>=5000){rouletteRoundSequence++;currentRouletteRound={id:rouletteRoundSequence,startedAt:0,endsAt:0,status:'open',result:null,bets:[],multipliers:makeRouletteMultipliers()}}for(const [type,players] of gamePresence){for(const [id,seen] of players){if(now-seen>45000)players.delete(id)}if(!players.size)gamePresence.delete(type)}},250);
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

  // Serve Telegram profile photos through the server so the bot token never reaches the browser.
  if (requestUrl.pathname.startsWith("/api/telegram/avatar/")) {
    res.setHeader("Cache-Control", "public, max-age=21600");
    const telegramId = requestUrl.pathname.slice("/api/telegram/avatar/".length);
    if (!/^\d{1,20}$/.test(telegramId)) { res.writeHead(400); return res.end("Invalid Telegram user ID"); }
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); return res.end("Telegram avatar service is not configured"); }
    try {
      const photosResponse = await fetch("https://api.telegram.org/bot" + botToken + "/getUserProfilePhotos?user_id=" + encodeURIComponent(telegramId) + "&limit=1", { signal: AbortSignal.timeout(10000) });
      if (!photosResponse.ok) throw new Error("Telegram photo lookup failed");
      const photosData = await photosResponse.json();
      const sizes = photosData && photosData.ok && photosData.result && photosData.result.photos && photosData.result.photos[0];
      if (!sizes || !sizes.length) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("No Telegram profile photo"); }
      const photo = sizes[sizes.length - 1];
      const fileResponse = await fetch("https://api.telegram.org/bot" + botToken + "/getFile?file_id=" + encodeURIComponent(photo.file_id), { signal: AbortSignal.timeout(10000) });
      if (!fileResponse.ok) throw new Error("Telegram file lookup failed");
      const fileData = await fileResponse.json();
      const filePath = fileData && fileData.ok && fileData.result && fileData.result.file_path;
      if (!filePath) throw new Error("Telegram photo file not found");
      const imageResponse = await fetch("https://api.telegram.org/file/bot" + botToken + "/" + filePath, { signal: AbortSignal.timeout(15000) });
      if (!imageResponse.ok) throw new Error("Telegram photo download failed");
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      if (bytes.length > 5 * 1024 * 1024) { res.writeHead(413); return res.end("Avatar too large"); }
      res.writeHead(200, { "Content-Type": imageResponse.headers.get("content-type") || "image/jpeg", "X-Content-Type-Options": "nosniff" });
      return res.end(bytes);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end("Could not load Telegram avatar");
    }
  }

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
      const username = String(input.username || "").trim().replace(/^@/, "").toLowerCase();
      const name = String(input.name || "Игрок").slice(0, 40);
      const referredBy = String(input.referredBy || "");
      const telegramId = String(input.telegramId || "").slice(0, 32);
      const photoUrl = String(input.photoUrl || "").slice(0, 2048);
      const safePhotoUrl = /^https:\/\//i.test(photoUrl) ? photoUrl : "";
      const balance = Number(input.balance);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId) || !Number.isFinite(balance) || balance < 0 || balance > 1e15) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid player data" }));
      }
      if (username && !/^[a-z0-9_]{3,20}$/.test(username)) { res.writeHead(400); return res.end(JSON.stringify({ error: "Username: 3–20 символов, латиница, цифры и _." })); }
      const collision = username && [...registeredPlayers.values()].find(p => p.username === username && p.id !== clientId);
      if (collision) { res.writeHead(409); return res.end(JSON.stringify({ error: "Этот username уже занят." })); }
      const previous = registeredPlayers.get(clientId);
      const pendingCredits = previous ? Math.max(0, Number(previous.pendingCredits)||0) : 0;
      const creditedBalance = Math.round((balance + pendingCredits) * 1000) / 1000;
      // Recover an active premium period if an older profile sync had erased its fields.
      const usedPremiumPromo = Object.values(premiumPromos).find(x => x && x.usedBy === clientId && Number(x.usedAt || 0) + 7 * 86400000 > Date.now());
      const recoveredPremiumStart = usedPremiumPromo ? Number(usedPremiumPromo.usedAt) : 0;
      const inviterId = referredBy ? ([...registeredPlayers.values()].find(p => p.id === referredBy || (p.telegramId && p.telegramId === referredBy)) || {}).id : "";
      const resolvedInviterId = previous ? (previous.referredBy || "") : (inviterId && inviterId !== clientId ? inviterId : "");
      if (!previous && resolvedInviterId && !referredPlayerIds.has(clientId)) {
        referredPlayerIds.add(clientId);
        const inviter = registeredPlayers.get(resolvedInviterId);
        if (inviter) { inviter.referrals = (inviter.referrals || 0) + 1; inviter.pendingCredits = Math.round(((Number(inviter.pendingCredits)||0)+5000)*1000)/1000; }
      }
      registeredPlayers.set(clientId, {
        id: clientId,
        name: username ? "@" + username : (previous ? previous.name : name),
        username: username || (previous ? previous.username : ""),
        referredBy: previous ? previous.referredBy : (referredBy && referredBy !== clientId ? (inviterId || referredBy) : ""),
        telegramId: telegramId || (previous ? previous.telegramId || "" : ""),
        photoUrl: safePhotoUrl || (previous ? previous.photoUrl || "" : ""),
        referrals: previous ? (previous.referrals || 0) : 0,
        balance: creditedBalance,
        pendingCredits: 0,
        totalWon: previous ? Math.max(previous.totalWon || 0, Math.max(0, Math.round(Number(input.totalWon || 0) * 1000) / 1000)) : Math.max(0, Math.round(Number(input.totalWon || 0) * 1000) / 1000),
        // Preserve server-owned premium state when the client refreshes player profile.
        premiumUntil: Math.max(Number(previous && previous.premiumUntil || 0), recoveredPremiumStart ? recoveredPremiumStart + 7 * 86400000 : 0),
        autoClickEarned: previous && previous.autoClickEarned !== undefined ? Number(previous.autoClickEarned || 0) : 0,
        autoClickLastAt: Number(previous && previous.autoClickLastAt || recoveredPremiumStart || 0),
        premiumStartedAt: Number(previous && previous.premiumStartedAt || recoveredPremiumStart || 0),
        registeredAt: previous ? previous.registeredAt : new Date().toISOString(),
        lastSeen: Date.now()
      });
      // Resolve referrals that arrived before the inviter registered.
      const newlyRegistered = registeredPlayers.get(clientId);
      for (const referred of registeredPlayers.values()) {
        if (referred.id !== clientId && referred.referredBy && !referredPlayerIds.has(referred.id) &&
            (referred.referredBy === clientId || (newlyRegistered.telegramId && referred.referredBy === newlyRegistered.telegramId))) {
          referred.referredBy = clientId;
          referredPlayerIds.add(referred.id);
          newlyRegistered.referrals = (newlyRegistered.referrals || 0) + 1;
        }
      }
      persistPlayerData();
      res.writeHead(200);
      return res.end(JSON.stringify({ registered: true, referrals: registeredPlayers.get(clientId).referrals || 0, balance: registeredPlayers.get(clientId).balance }));
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
      .map(p => ({ id:p.id, name:p.name, username:p.username || "", photoUrl:p.photoUrl || "", telegramId:p.telegramId || "", balance:p.balance }));
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
      const senderId=String(input.clientId||""), recipientUsername=String(input.recipientUsername||"").trim().replace(/^@/,"").toLowerCase(), amount=Number(input.amount);
      if(!/^[a-zA-Z0-9_-]{12,80}$/.test(senderId)||!/^[a-z0-9_]{3,20}$/.test(recipientUsername)||!Number.isFinite(amount)||amount<=0||Math.round(amount*1000)!==amount*1000) {
        res.writeHead(400); return res.end(JSON.stringify({error:"Проверь получателя и сумму перевода."}));
      }
      const sender=registeredPlayers.get(senderId), recipient=[...registeredPlayers.values()].find(p => (p.username || "").toLowerCase() === recipientUsername);
      if(!sender||!recipient){res.writeHead(404);return res.end(JSON.stringify({error:"Отправитель или получатель не зарегистрирован."}));}
      if(sender.balance<amount){res.writeHead(400);return res.end(JSON.stringify({error:"Недостаточно средств на серверном балансе."}));}
      sender.balance=Math.round((sender.balance-amount)*1000)/1000;
      recipient.balance=Math.round((recipient.balance+amount)*1000)/1000;
      const entry={id:Date.now().toString(36)+Math.random().toString(36).slice(2,8),senderId,recipientId,amount,createdAt:new Date().toISOString(),senderName:sender.name,recipientName:recipient.name};
      playerTransfers.unshift(entry); if(playerTransfers.length>1000)playerTransfers.length=1000;
      persistPlayerData();
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

  if (requestUrl.pathname === "/api/market") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET") {
      const listings = marketListings.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
      return res.end(JSON.stringify({listings, history:marketHistory.slice(-60)}));
    }
    if (req.method !== "POST") { res.writeHead(405, {Allow:"GET, POST"}); return res.end(JSON.stringify({error:"Method not allowed"})); }
    let body = "";
    req.on("data", chunk => { body += chunk; if(body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let input; try { input=JSON.parse(body||"{}"); } catch { res.writeHead(400); return res.end(JSON.stringify({error:"Invalid JSON"})); }
      const action=String(input.action||""), clientId=String(input.clientId||""), listingId=String(input.listingId||"");
      const player=registeredPlayers.get(clientId);
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId) || !player) { res.writeHead(401); return res.end(JSON.stringify({error:"Сначала открой приложение и зарегистрируйся."})); }
      if (action==="create") {
        const amount=Number(input.amount), rate=Number(input.rate);
        if (!Number.isSafeInteger(amount)||amount<50000||amount>1e12||!Number.isFinite(rate)||rate<=0||rate>1e9) { res.writeHead(400); return res.end(JSON.stringify({error:"Минимум 50 000 монет. Укажи корректный курс за 1 000 монет."})); }
        if (player.balance<amount) { res.writeHead(400); return res.end(JSON.stringify({error:"На серверном балансе недостаточно монет для объявления."})); }
        player.balance=Math.round((player.balance-amount)*1000)/1000;
        const item={id:Date.now().toString(36)+Math.random().toString(36).slice(2,8),sellerId:clientId,sellerName:player.name||"Продавец",username:player.username||"",amount,rate:Math.round(rate*100)/100,createdAt:new Date().toISOString()};
        marketListings.push(item); marketHistory.push({at:item.createdAt,rate:item.rate,kind:"listing"}); persistPlayerData();
        res.writeHead(200); return res.end(JSON.stringify({success:true,listing:item,balance:player.balance}));
      }
      const idx=marketListings.findIndex(x=>x.id===listingId && x.sellerId===clientId);
      if (idx<0) { res.writeHead(404); return res.end(JSON.stringify({error:"Объявление не найдено или оно уже закрыто."})); }
      if (action==="edit") {
        const amount=Number(input.amount),rate=Number(input.rate),item=marketListings[idx];
        if(!Number.isSafeInteger(amount)||amount<50000||amount>1e12||!Number.isFinite(rate)||rate<=0||rate>1e9){res.writeHead(400);return res.end(JSON.stringify({error:"Минимум 50 000 монет и корректный курс за 1 000 монет."}));}
        const difference=amount-item.amount;
        if(difference>0&&player.balance<difference){res.writeHead(400);return res.end(JSON.stringify({error:"На балансе недостаточно монет для увеличения количества в объявлении."}));}
        player.balance=Math.round((player.balance-difference)*1000)/1000;
        item.amount=amount;item.rate=Math.round(rate*100)/100;item.updatedAt=new Date().toISOString();
        marketHistory.push({at:item.updatedAt,rate:item.rate,kind:"edit"});persistPlayerData();
        res.writeHead(200);return res.end(JSON.stringify({success:true,listing:item,balance:player.balance}));
      }
      if (action==="cancel") {
        const [item]=marketListings.splice(idx,1); player.balance=Math.round((player.balance+item.amount)*1000)/1000;
        marketHistory.push({at:new Date().toISOString(),rate:item.rate,kind:"cancel"}); persistPlayerData();
        res.writeHead(200); return res.end(JSON.stringify({success:true,balance:player.balance,returnedAmount:item.amount}));
      }
      if (action==="complete") {
        const buyerUsername=String(input.buyerUsername||"").trim().replace(/^@/,"").toLowerCase();
        if(!/^[a-z0-9_]{3,20}$/.test(buyerUsername)){res.writeHead(400);return res.end(JSON.stringify({error:"Укажи корректный Telegram username покупателя."}));}
        const buyer=[...registeredPlayers.values()].find(p=>String(p.username||"").toLowerCase()===buyerUsername);
        if(!buyer){res.writeHead(404);return res.end(JSON.stringify({error:"Покупатель с таким username не зарегистрирован в VKcoin. Попроси его открыть приложение и зарегистрироваться."}));}
        if(buyer.id===clientId){res.writeHead(400);return res.end(JSON.stringify({error:"Нельзя указать себя покупателем."}));}
        const [item]=marketListings.splice(idx,1);
        const completedAt=new Date().toISOString();
        buyer.pendingCredits=Math.round(((Number(buyer.pendingCredits)||0)+Number(item.amount))*1000)/1000;
        marketHistory.push({
          at:completedAt, rate:item.rate, kind:"sale", status:"Успешно",
          listingId:item.id, sellerId:item.sellerId, sellerName:item.sellerName||"Продавец",
          sellerUsername:player.username||"", buyerId:buyer.id, buyerUsername,
          amount:Number(item.amount), total:Math.round((Number(item.amount)/1000*Number(item.rate))*100)/100
        });
        persistPlayerData();
        res.writeHead(200); return res.end(JSON.stringify({success:true,status:"Успешно",listing:item,buyerUsername,buyerAmount:item.amount,completedAt}));
      }
      res.writeHead(400); return res.end(JSON.stringify({error:"Неизвестное действие."}));
    });
    return;
  }

  if (requestUrl.pathname === "/api/players/leaderboard") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }
    const rankMode = requestUrl.searchParams.get("mode") || "wins";
    const allPlayers = [...registeredPlayers.values()];
    const players = allPlayers
      .sort((a, b) => rankMode === "referrals" ? (b.referrals || 0) - (a.referrals || 0) : rankMode === "balance" ? (b.balance || 0) - (a.balance || 0) || a.registeredAt.localeCompare(b.registeredAt) : (b.totalWon || 0) - (a.totalWon || 0) || a.registeredAt.localeCompare(b.registeredAt))
      .slice(0, 100)
      .map((p) => ({ name: p.name, username: p.username || "", photoUrl: p.photoUrl || "", telegramId: p.telegramId || "", referrals: p.referrals || 0, totalWon: p.totalWon || 0, balance: p.balance || 0, premiumActive: getPremiumUntil(p) > Date.now(), premiumUntil: getPremiumUntil(p) > Date.now() ? getPremiumUntil(p) : 0, registeredAt: p.registeredAt }));
    res.writeHead(200);
    return res.end(JSON.stringify({ players, count: registeredPlayers.size }));
  }

  if (requestUrl.pathname === "/api/live-game") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (!globalThis.liveGamePool) globalThis.liveGamePool = { scorpion: 0, subzero: 0, bets: [] };
    const pool = globalThis.liveGamePool;
    const odds = () => {
      const total = pool.scorpion + pool.subzero;
      const calc = (side) => Math.max(1.5, Math.min(44, total > 0 && side > 0 ? total / side * 0.9 : 44));
      return { scorpion: +calc(pool.scorpion).toFixed(2), subzero: +calc(pool.subzero).toFixed(2) };
    };
    if (req.method === "GET") {
      res.writeHead(200);
      return res.end(JSON.stringify({ pool: { scorpion: pool.scorpion, subzero: pool.subzero }, odds: odds(), count: pool.bets.length }));
    }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "GET, POST" }); return res.end(JSON.stringify({ error: "Method not allowed" })); }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on("end", () => {
      let input; try { input = JSON.parse(body || "{}"); } catch { res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid JSON" })); }
      const side = String(input.side || ""), amount = Number(input.amount);
      if (!["scorpion", "subzero"].includes(side) || !Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
        res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid live bet" }));
      }
      const lockedOdds = odds()[side];
      pool[side] = Math.round((pool[side] + amount) * 1000) / 1000;
      pool.bets.unshift({ side, amount, odds: lockedOdds, at: Date.now() });
      if (pool.bets.length > 5000) pool.bets.length = 5000;
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, lockedOdds, pool: { scorpion: pool.scorpion, subzero: pool.subzero }, odds: odds(), count: pool.bets.length }));
    });
    return;
  }

  if (requestUrl.pathname === "/api/games/rounds") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        let input; try { input = JSON.parse(body || "{}"); } catch { res.writeHead(400); return res.end(JSON.stringify({error:"Invalid JSON"})); }
        const clientId=String(input.clientId||""), type=String(input.type||""), bet=Number(input.bet), net=Number(input.net);
        if(!registeredPlayers.has(clientId)||!["olympus","bandit","wheel","flip","dice","mines"].includes(type)||!Number.isFinite(bet)||bet<0||!Number.isFinite(net)){res.writeHead(400);return res.end(JSON.stringify({error:"Invalid round"}));}
        const p=registeredPlayers.get(clientId);
        playerGameRounds.unshift({id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),clientId,type,username:p.username||p.name,bet:Math.round(bet*1000)/1000,net:Math.round(net*1000)/1000,label:String(input.label||"Раунд").slice(0,100),createdAt:new Date().toISOString()});
        if(playerGameRounds.length>500)playerGameRounds.length=500;
        res.writeHead(200);return res.end(JSON.stringify({saved:true}));
      });
      return;
    }
    if(req.method!=="GET"){res.writeHead(405,{Allow:"GET, POST"});return res.end(JSON.stringify({error:"Method not allowed"}));}
    const type=String(requestUrl.searchParams.get("type")||"");
    const rounds=playerGameRounds.filter(x=>!type||x.type===type).slice(0,30);
    res.writeHead(200);return res.end(JSON.stringify({rounds}));
  }

  if (requestUrl.pathname === "/api/premium/status") {
    res.setHeader("Content-Type","application/json; charset=utf-8"); res.setHeader("Cache-Control","no-store");
    const clientId=String(requestUrl.searchParams.get("clientId")||"");
    const p=registeredPlayers.get(clientId);
    if(!p){res.writeHead(404);return res.end(JSON.stringify({error:"Игрок не зарегистрирован"}))}
    const now=Date.now(), until=getPremiumUntil(p), active=until>now;
    if(active){
      const last=Number(p.autoClickLastAt||p.premiumStartedAt||now), elapsed=Math.max(0,Math.min(now,until)-last);
      const previousEarned=Number(p.autoClickEarned||0);
      const earned=Math.min(75000,previousEarned+elapsed*(75000/(7*86400000)));
      p.autoClickEarned=earned;p.autoClickLastAt=Math.min(now,until);
      if(earned>previousEarned+0.000001)persistPlayerData();
    }
    return res.end(JSON.stringify({active,until:active?until:0,daysLeft:active?Math.ceil((until-now)/86400000):0,autoClickEarned:Number(p.autoClickEarned||0),autoClickCap:75000,clickMultiplier:active?5:1}));
  }
  if (requestUrl.pathname === "/api/premium/claim") {
    res.setHeader("Content-Type","application/json; charset=utf-8"); res.setHeader("Cache-Control","no-store");
    if(req.method!=="POST"){res.writeHead(405,{Allow:"POST"});return res.end(JSON.stringify({error:"Method not allowed"}))}
    let body="";req.on("data",c=>{body+=c;if(body.length>4096)req.destroy()});req.on("end",()=>{
      let input;try{input=JSON.parse(body||"{}")}catch{res.writeHead(400);return res.end(JSON.stringify({error:"Некорректный запрос"}))}
      const clientId=String(input.clientId||""),code=String(input.code||"").trim().toUpperCase();
      if(!registeredPlayers.has(clientId)){res.writeHead(400);return res.end(JSON.stringify({error:"Сначала зарегистрируй игрока"}))}
      if(!Object.prototype.hasOwnProperty.call(premiumPromos,code)){res.writeHead(400);return res.end(JSON.stringify({error:"Промокод PREMIUM не найден"}))}
      if(premiumPromos[code].usedBy){res.writeHead(409);return res.end(JSON.stringify({error:"Этот промокод уже активирован"}))}
      const p=registeredPlayers.get(clientId),now=Date.now();
      if(Number(p.premiumUntil||0)>now){res.writeHead(409);return res.end(JSON.stringify({error:"У тебя уже активен PREMIUM"}))}
      premiumPromos[code]={usedBy:clientId,usedAt:now};
      p.premiumUntil=now+7*86400000;p.autoClickEarned=0;p.autoClickLastAt=now;p.premiumStartedAt=now;
      try{savePremiumPromos();persistPlayerData()}catch(e){premiumPromos[code]={usedBy:null,usedAt:null};res.writeHead(500);return res.end(JSON.stringify({error:"Не удалось сохранить PREMIUM"}))}
      res.writeHead(200);return res.end(JSON.stringify({success:true,until:p.premiumUntil,daysLeft:7,autoClickCap:75000,clickMultiplier:5}));
    });return;
  }
  if (requestUrl.pathname === "/api/promos/redeem") {
    res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");
    if(req.method!=="POST"){res.writeHead(405,{Allow:"POST"});return res.end(JSON.stringify({error:"Method not allowed"}))}
    let body="";req.on("data",c=>{body+=c;if(body.length>4096)req.destroy()});req.on("end",()=>{let input;try{input=JSON.parse(body||"{}")}catch{res.writeHead(400);return res.end(JSON.stringify({error:"Invalid JSON"}))}
      const clientId=String(input.clientId||""),code=String(input.code||"").toUpperCase();
      if(!/^[a-zA-Z0-9_-]{12,80}$/.test(clientId)||!["START1","OBNOVA"].includes(code)){res.writeHead(400);return res.end(JSON.stringify({error:"Промокод недействителен"}))}
      if(!registeredPlayers.has(clientId)){res.writeHead(400);return res.end(JSON.stringify({error:"Сначала зарегистрируй игрока"}))}
      if(code==="OBNOVA"){
        if(obnovaUsers.has(clientId)){res.writeHead(409);return res.end(JSON.stringify({error:"Промокод obnova можно активировать только один раз на игрока"}))}
        if(obnovaUsers.size>=50){res.writeHead(409);return res.end(JSON.stringify({error:"Лимит в 50 активаций obnova уже исчерпан"}))}
        obnovaUsers.add(clientId);try{fs.writeFileSync(OBnova_FILE,JSON.stringify([...obnovaUsers]))}catch(e){obnovaUsers.delete(clientId);res.writeHead(500);return res.end(JSON.stringify({error:"Не удалось сохранить активацию. Попробуй ещё раз."}))}
        res.writeHead(200);return res.end(JSON.stringify({success:true,amount:3333,remaining:50-obnovaUsers.size}));
      }
      if(start1Users.has(clientId)){res.writeHead(409);return res.end(JSON.stringify({error:"START1 можно активировать только один раз на игрока"}))}
      if(start1Users.size>=50){res.writeHead(409);return res.end(JSON.stringify({error:"Лимит в 50 активаций START1 уже исчерпан"}))}
      start1Users.add(clientId);try{fs.writeFileSync(START1_FILE,JSON.stringify([...start1Users]))}catch{}
      res.writeHead(200);return res.end(JSON.stringify({success:true,amount:1000,remaining:50-start1Users.size}));
    });return;
  }
  if (requestUrl.pathname === "/api/games/presence") {
    res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");
    if(req.method==='POST'){let body='';req.on('data',c=>{body+=c;if(body.length>2048)req.destroy()});req.on('end',()=>{let input;try{input=JSON.parse(body||'{}')}catch{res.writeHead(400);return res.end(JSON.stringify({error:'Invalid JSON'}))}const clientId=String(input.clientId||''),type=String(input.type||'');if(!registeredPlayers.has(clientId)||!GAME_TYPES.includes(type)){res.writeHead(400);return res.end(JSON.stringify({error:'Invalid game presence'}))}if(!gamePresence.has(type))gamePresence.set(type,new Map());gamePresence.get(type).set(clientId,Date.now());res.writeHead(200);return res.end(JSON.stringify({success:true}))});return}
    if(req.method!=='GET'){res.writeHead(405,{Allow:'GET, POST'});return res.end(JSON.stringify({error:'Method not allowed'}))}const counts={};for(const type of GAME_TYPES)counts[type]=gamePresence.has(type)?gamePresence.get(type).size:0;res.writeHead(200);return res.end(JSON.stringify({counts}));
  }
  if (requestUrl.pathname === "/api/roulette/round") {
    res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");
    if(req.method!=="GET"){res.writeHead(405,{Allow:"GET"});return res.end(JSON.stringify({error:"Method not allowed"}))}
    const r=currentRouletteRound;return res.end(JSON.stringify({round:{id:r.id,startedAt:r.startedAt,endsAt:r.endsAt,status:r.status,result:r.result,multipliers:r.multipliers||[],bets:r.bets.map(x=>({clientId:x.clientId,username:x.username,amount:x.amount,choices:x.choices})),playerCount:new Set(r.bets.map(x=>x.clientId)).size}}));
  }
  if (requestUrl.pathname === "/api/roulette/bet") {
    res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");
    if(req.method!=="POST"){res.writeHead(405,{Allow:"POST"});return res.end(JSON.stringify({error:"Method not allowed"}))}
    let body="";req.on("data",c=>{body+=c;if(body.length>8192)req.destroy()});req.on("end",()=>{let input;try{input=JSON.parse(body||"{}")}catch{res.writeHead(400);return res.end(JSON.stringify({error:"Invalid JSON"}))}
      const clientId=String(input.clientId||""),amount=Number(input.amount),choices=Array.isArray(input.choices)?input.choices:[];
      if(!registeredPlayers.has(clientId)||!Number.isFinite(amount)||amount<1||!choices.length||choices.length>37){res.writeHead(400);return res.end(JSON.stringify({error:"Проверь сумму и исходы ставки"}))}
      if(currentRouletteRound.status!=="open"||(currentRouletteRound.endsAt>0&&Date.now()>=currentRouletteRound.endsAt)){res.writeHead(409);return res.end(JSON.stringify({error:"Ставки закрыты — дождись следующего раунда"}))}
      const allowed=new Set(["red","black","even","odd","range13","low","dozen1","range25","high","number","zero"]),clean=[];
      for(const c of choices){const kind=String(c.kind||""),number=Number(c.number);if(!allowed.has(kind)||(kind==="number"&&(!Number.isInteger(number)||number<0||number>36))){res.writeHead(400);return res.end(JSON.stringify({error:"Некорректный исход"}))}clean.push({kind,label:String(c.label||kind).slice(0,40),...(kind==="number"?{number}:{}),mult:kind==="number"?30:kind==="zero"?36:2})}
      const p=registeredPlayers.get(clientId);if(currentRouletteRound.endsAt===0){currentRouletteRound.startedAt=Date.now();currentRouletteRound.endsAt=currentRouletteRound.startedAt+25000}currentRouletteRound.bets.push({clientId,username:p.username?"@"+p.username:p.name,amount:Math.round(amount*1000)/1000,choices:clean,createdAt:new Date().toISOString()});
      res.writeHead(200);return res.end(JSON.stringify({accepted:true,round:{id:currentRouletteRound.id,endsAt:currentRouletteRound.endsAt}}));
    });return;
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
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": filePath.endsWith("index.html") ? "no-store, no-cache, must-revalidate, proxy-revalidate" : "no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(port, "0.0.0.0", () => {
  console.log("VK Coin web app listening on port " + port);
});
