import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
  const hmacKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(checkString)));
  const actualHash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actualHash.length !== receivedHash.length) return null;
  let mismatch = 0;
  for (let i = 0; i < actualHash.length; i++) mismatch |= actualHash.charCodeAt(i) ^ receivedHash.charCodeAt(i);
  if (mismatch !== 0) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user.id) return null;
    return user;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!botToken || !supabaseUrl || !serviceKey) return response({ error: "Server is not configured" }, 503);

  try {
    const body = await req.json();
    const initData = String(body.initData || "");
    const user = await verifyTelegramInitData(initData, botToken);
    if (!user) return response({ error: "Откройте приложение внутри Telegram и попробуйте снова." }, 401);

    const kind = body.kind;
    const coins = Number(body.coin_amount);
    if (!["sell", "buy"].includes(kind) || !Number.isFinite(coins) || coins <= 0 || coins > 1_000_000_000_000) {
      return response({ error: "Некорректные данные заявки" }, 400);
    }
    if (kind === "sell" && coins < 50000) return response({ error: "Минимальная продажа — 50000.000 VK COIN" }, 400);

    const rate = kind === "sell" ? 10.76 / 11600 : 4.65 / 11600;
    const rub = Math.round(coins * rate * 100) / 100;
    const bank = kind === "sell" ? String(body.bank_name || "").trim().slice(0, 100) : null;
    const details = kind === "sell" ? String(body.payout_details || "").trim().slice(0, 200) : null;
    if (kind === "sell" && (!bank || details.length < 5)) return response({ error: "Укажите банк и корректные реквизиты для выплаты." }, 400);

    const db = createClient(supabaseUrl, serviceKey);
    const { data, error } = await db.from("exchange_requests").insert({
      kind,
      telegram_user_id: user.id,
      telegram_username: user.username || null,
      telegram_first_name: user.first_name || null,
      coin_amount: coins,
      rub_amount: rub,
      bank_name: bank,
      payout_details: details,
      status: kind === "sell" ? "pending" : "awaiting_payment",
    }).select("id,kind,coin_amount,rub_amount,status,created_at").single();
    if (error) {
      console.error("insert request failed", error.message);
      return response({ error: "Не удалось сохранить заявку. Попробуйте позже." }, 500);
    }
    return response({ request: data });
  } catch (error) {
    console.error("submit-request error", error);
    return response({ error: "Ошибка обработки заявки" }, 500);
  }
});
