import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "PATCH"].includes(req.method)) return response({ error: "Method not allowed" }, 405);

  const expectedPassword = Deno.env.get("ADMIN_PASSWORD");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const suppliedPassword = req.headers.get("x-admin-password") || "";
  if (!expectedPassword || !supabaseUrl || !serviceKey) return response({ error: "Server is not configured" }, 503);
  if (suppliedPassword.length !== expectedPassword.length) return response({ error: "Неверный пароль администратора" }, 401);
  let diff = 0;
  for (let i = 0; i < expectedPassword.length; i++) diff |= expectedPassword.charCodeAt(i) ^ suppliedPassword.charCodeAt(i);
  if (diff !== 0) return response({ error: "Неверный пароль администратора" }, 401);

  const db = createClient(supabaseUrl, serviceKey);
  if (req.method === "GET") {
    const { data, error } = await db.from("exchange_requests").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) return response({ error: "Не удалось загрузить заявки" }, 500);
    return response({ requests: data });
  }

  try {
    const body = await req.json();
    const id = String(body.id || "");
    const status = String(body.status || "");
    const allowed = ["pending", "reviewing", "paid", "rejected", "awaiting_payment"];
    if (!id || !allowed.includes(status)) return response({ error: "Некорректный статус или ID" }, 400);
    const { data, error } = await db.from("exchange_requests")
      .update({ status, admin_note: String(body.admin_note || "").slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", id).select("id,status,updated_at").single();
    if (error) return response({ error: "Не удалось обновить заявку" }, 500);
    return response({ request: data });
  } catch {
    return response({ error: "Некорректный запрос" }, 400);
  }
});
