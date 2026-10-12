import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
function response(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}})}
async function verifyTelegramInitData(initData:string,botToken:string){
 const params=new URLSearchParams(initData),receivedHash=params.get("hash");if(!receivedHash)return null;params.delete("hash");
 const checkString=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n"),encoder=new TextEncoder();
 const sk=await crypto.subtle.importKey("raw",encoder.encode(botToken),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const secret=await crypto.subtle.sign("HMAC",sk,encoder.encode("WebAppData"));
 const hk=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const digest=new Uint8Array(await crypto.subtle.sign("HMAC",hk,encoder.encode(checkString)));
 const actual=[...digest].map(b=>b.toString(16).padStart(2,"0")).join("");
 if(actual.length!==receivedHash.length)return null;let mismatch=0;for(let i=0;i<actual.length;i++)mismatch|=actual.charCodeAt(i)^receivedHash.charCodeAt(i);if(mismatch)return null;
 const authDate=Number(params.get("auth_date")||0);if(!authDate||Date.now()/1000-authDate>3600||authDate>Date.now()/1000+30)return null;
 try{const user=JSON.parse(params.get("user")||"{}");return user.id?user:null}catch{return null}
}
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});if(req.method!=="POST")return response({error:"Method not allowed"},405);
 const botToken=Deno.env.get("TELEGRAM_BOT_TOKEN"),url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!botToken||!url||!key)return response({error:"Server is not configured"},503);
 try{
  const body=await req.json(),user=await verifyTelegramInitData(String(body.initData||""),botToken);
  if(!user)return response({error:"Открой приложение внутри Telegram для подтверждения аккаунта."},401);
  const db=createClient(url,key,{auth:{persistSession:false}}),username=typeof user.username==="string"?user.username.replace(/^@/,"").slice(0,64):null,firstName=typeof user.first_name==="string"?user.first_name.slice(0,128):null;
  const {error:regErr}=await db.from("player_wallets").upsert({telegram_user_id:user.id,username,first_name:firstName,updated_at:new Date().toISOString()},{onConflict:"telegram_user_id"});
  if(regErr){console.error("wallet registration failed",regErr.message);return response({error:"Не удалось зарегистрировать кошелёк."},500)}
  if(body.action==="register"||body.action==="balance"){
   const {data,error}=await db.from("player_wallets").select("telegram_user_id,username,first_name,balance").eq("telegram_user_id",user.id).single();
   if(error)return response({error:"Не удалось загрузить кошелёк."},500);return response({wallet:data});
  }
  if(body.action==="transfer"){
   const recipient=String(body.recipient||"").trim().replace(/^@/,""),amount=Number(body.amount);
   if(!/^[a-zA-Z0-9_]{3,64}$/.test(recipient)||!Number.isFinite(amount)||amount<=0||amount>1e12||Math.round(amount*1000)!==amount*1000)return response({error:"Укажи Telegram username и сумму с точностью до 0,001 VKC."},400);
   const {data,error}=await db.rpc("execute_player_transfer",{p_sender_id:user.id,p_recipient_username:recipient,p_amount:amount});
   if(error){const map:Record<string,[number,string]>={RECIPIENT_NOT_REGISTERED:[404,"Получатель ещё не зарегистрировал кошелёк в приложении."],SENDER_NOT_REGISTERED:[404,"Сначала зарегистрируй свой кошелёк."],SELF_TRANSFER:[400,"Нельзя переводить самому себе."],INSUFFICIENT_BALANCE:[409,"Недостаточно средств на серверном балансе."],INVALID_AMOUNT:[400,"Некорректная сумма."],INVALID_RECIPIENT:[400,"Некорректный получатель."]};const matched=Object.entries(map).find(([code])=>error.message.includes(code));return response({error:matched?.[1][1]||"Перевод не выполнен. Попробуй позже."},matched?.[1][0]||500)}
   const {data:wallet}=await db.from("player_wallets").select("balance,username").eq("telegram_user_id",user.id).single();return response({transfer:data,wallet});
  }
  if(body.action==="history"){
   const {data,error}=await db.from("player_transfers").select("id,sender_id,recipient_id,amount,created_at,sender:player_wallets!player_transfers_sender_id_fkey(username,first_name),recipient:player_wallets!player_transfers_recipient_id_fkey(username,first_name)").or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`).order("created_at",{ascending:false}).limit(50);
   if(error){console.error("transfer history failed",error.message);return response({error:"Не удалось загрузить историю."},500)}
   return response({history:(data||[]).map(row=>({id:row.id,amount:row.amount,created_at:row.created_at,direction:String(row.sender_id)===String(user.id)?"out":"in",counterparty:String(row.sender_id)===String(user.id)?(row.recipient?.username||row.recipient?.first_name||"Игрок"):(row.sender?.username||row.sender?.first_name||"Игрок")}))});
  }
  return response({error:"Неизвестное действие."},400);
 }catch(error){console.error("player-transfers error",error);return response({error:"Ошибка обработки перевода."},500)}
});