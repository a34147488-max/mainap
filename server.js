// Deployment sync: valid current server entrypoint
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const users = new Map();
const friendships = new Map();
const savedProfiles = new Map();
const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:false}}) : null;
const dbReady = pool ? pool.query('CREATE TABLE IF NOT EXISTS game_profiles (account_id TEXT PRIMARY KEY, profile JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS game_friendships (account_id TEXT NOT NULL, friend_account_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(account_id,friend_account_id), CHECK(account_id <> friend_account_id));').then(async()=>{const r=await pool.query('SELECT account_id,profile FROM game_profiles');for(const row of r.rows)savedProfiles.set(row.account_id,row.profile);console.log('PostgreSQL ready:',r.rows.length,'profiles loaded')}).catch(e=>{console.error('PostgreSQL init failed:',e.message);throw e;}) : Promise.resolve();

app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, app: 'Бутылочка' }));

const GIFT_CATALOG = [{id:'rose',name:'Роза',emoji:'🌹'},{id:'heart',name:'Сердце',emoji:'❤️'},{id:'chocolate',name:'Шоколад',emoji:'🍫'},{id:'teddy',name:'Мишка',emoji:'🧸'},{id:'crown',name:'Корона',emoji:'👑'},{id:'diamond',name:'Бриллиант',emoji:'💎'},{id:'ring',name:'Колечко',emoji:'💍'},{id:'bouquet',name:'Букет',emoji:'💐'},{id:'cake',name:'Торт',emoji:'🎂'},{id:'star',name:'Звезда',emoji:'⭐'},{id:'fire',name:'Огонь',emoji:'🔥'},{id:'moon',name:'Луна',emoji:'🌙'},{id:'sun',name:'Солнышко',emoji:'☀️'},{id:'cherry',name:'Вишенки',emoji:'🍒'},{id:'peach',name:'Персик',emoji:'🍑'},{id:'unicorn',name:'Единорог',emoji:'🦄'},{id:'gift',name:'Подарок',emoji:'🎁'},{id:'champagne',name:'Бокалы',emoji:'🥂'},{id:'sparkle',name:'Блеск',emoji:'✨'},{id:'trophy',name:'Кубок',emoji:'🏆'}].map(g=>({...g,price:25}));
const channelBonusClaims=new Set();
function dayKey(){return new Date().toISOString().slice(0,10)}
function refreshCredits(u){const now=Date.now();if(u.credits==null){u.credits=100;u.creditUpdatedAt=now;return}const step=864000;const elapsed=Math.max(0,now-(u.creditUpdatedAt||now));const gained=Math.floor(elapsed/step);if(gained>0){u.credits=Math.min(100,u.credits+gained);u.creditUpdatedAt=u.credits===100?now:(u.creditUpdatedAt||now)+gained*step}}
function accountId(u){return u.telegramId?'tg:'+String(u.telegramId):'socket:'+String(u.id)}
function serializableUser(u){return {name:u.name,username:u.username,age:u.age,avatar:u.avatar,kisses:u.kisses||0,dislikes:u.dislikes||0,credits:u.credits??100,creditUpdatedAt:u.creditUpdatedAt||Date.now(),gifts:u.gifts||[],telegramId:u.telegramId||'',subscriptionBonusClaimed:!!u.subscriptionBonusClaimed,dailyKisses:u.dailyKisses||0,dailyKissesDay:u.dailyKissesDay||dayKey(),dailyKissBonusClaimed:!!u.dailyKissBonusClaimed,joinedAt:u.joinedAt||Date.now()}}
async function persistUser(u){if(!pool||!u||!u.telegramId)return;const id=accountId(u),profile=serializableUser(u);savedProfiles.set(id,profile);try{await dbReady;await pool.query('INSERT INTO game_profiles(account_id,profile,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(account_id) DO UPDATE SET profile=EXCLUDED.profile,updated_at=NOW()',[id,JSON.stringify(profile)])}catch(e){console.error('Profile save failed:',e.message)}}
async function getSavedProfile(telegramId){if(!pool||!telegramId)return null;await dbReady;const id='tg:'+String(telegramId);const r=await pool.query('SELECT profile FROM game_profiles WHERE account_id=$1',[id]);if(r.rows[0]){savedProfiles.set(id,r.rows[0].profile);return r.rows[0].profile}return null}
async function getSavedFriendIds(u){if(!pool||!u.telegramId)return [];await dbReady;const r=await pool.query('SELECT friend_account_id FROM game_friendships WHERE account_id=$1',[accountId(u)]);return r.rows.map(x=>x.friend_account_id)}
function publicUser(u){
  refreshCredits(u);
  return { id: u.id, name: u.name, username: u.username, age: u.age, avatar: u.avatar,
    kisses: u.kisses, dislikes: u.dislikes, joinedAt: u.joinedAt, credits:u.credits, gifts:u.gifts||[] };
}
function roomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return { id: room.id, players: [...room.players.values()].map(publicUser),
    spinning: room.spinning, currentPicker: room.currentPicker, targetId: room.targetId,
    lastResult: room.lastResult, createdAt: room.createdAt };
}
function emitRoom(roomId) {
  const state = roomState(roomId);
  if (state) io.to(roomId).emit('room:state', state);
}
function roomFor(socket) {
  const u = users.get(socket.id);
  return u && u.roomId ? rooms.get(u.roomId) : null;
}
function leaveRoom(socket) {
  const u = users.get(socket.id);
  if (!u || !u.roomId) return;
  const room = rooms.get(u.roomId);
  const roomId = u.roomId;
  socket.leave(roomId);
  u.roomId = null;
  if (room) {
    room.players.delete(socket.id);
    if (room.currentPicker === socket.id) {
      room.currentPicker = null;
      room.targetId = null;
      room.spinning = false;
    }
    if (room.players.size === 0) rooms.delete(roomId);
    else emitRoom(roomId);
  }
}
io.on('connection', socket => {
  socket.on('profile:register', async (payload = {}, cb = () => {}) => {
    const age = Number(payload.age);
    const name = String(payload.name || payload.username || '').trim().slice(0, 24);
    if (!name) return cb({ ok: false, error: 'Укажи никнейм.' });
    if (!Number.isInteger(age) || age < 13 || age > 99) return cb({ ok: false, error: 'Укажи возраст от 13 до 99 лет.' });
    await dbReady;
    const previous = users.get(socket.id) || await getSavedProfile(payload.telegramId||'');
    if (previous && previous.roomId) leaveRoom(socket);
    const tg = payload.telegram || {};
    users.set(socket.id, {
      id: socket.id, name, username: String(payload.username || tg.username || name).replace(/^@/, '').slice(0, 32),
      age, avatar: String(payload.avatar || tg.photo_url || '').slice(0, 500),
      kisses: previous ? previous.kisses : 0, dislikes: previous ? previous.dislikes : 0, credits:previous ? previous.credits : 100, creditUpdatedAt:previous ? previous.creditUpdatedAt : Date.now(), gifts:previous ? previous.gifts||[] : [], telegramId:String(payload.telegramId||previous?.telegramId||'').slice(0,32), subscriptionBonusClaimed:previous ? !!previous.subscriptionBonusClaimed : false, dailyKisses:previous&&previous.dailyKissesDay===dayKey()?(previous.dailyKisses||0):0, dailyKissesDay:previous&&previous.dailyKissesDay===dayKey()?previous.dailyKissesDay:dayKey(), dailyKissBonusClaimed:previous&&previous.dailyKissesDay===dayKey()?!!previous.dailyKissBonusClaimed:false,
      joinedAt: previous ? previous.joinedAt : Date.now(), roomId: null
    });
    await persistUser(users.get(socket.id));
    cb({ ok: true, user: publicUser(users.get(socket.id)) });
  });
  socket.on('profile:change', async (payload={},cb=()=>{})=>{
    const u=users.get(socket.id);if(!u)return cb({ok:false,error:'Сначала создай профиль.'});refreshCredits(u);
    const field=String(payload.field||'');const value=String(payload.value||'').trim();
    if(!['name','age'].includes(field))return cb({ok:false,error:'Можно изменить только никнейм или возраст.'});
    if(u.credits<25)return cb({ok:false,error:'Нужно 25 кредитов.'});
    if(field==='name'){if(!value||value.length>24)return cb({ok:false,error:'Никнейм должен быть от 1 до 24 символов.'});u.name=value;}
    else {const age=Number(value);if(!Number.isInteger(age)||age<13||age>99)return cb({ok:false,error:'Возраст должен быть от 13 до 99 лет.'});u.age=age;}
    u.credits-=25;await persistUser(u);cb({ok:true,user:publicUser(u)});
  });
  socket.on('bonus:channel:claim',async (_payload={},cb=()=>{})=>{
    const u=users.get(socket.id);if(!u)return cb({ok:false,error:'Сначала создай профиль.'});
    if(!u.telegramId)return cb({ok:false,error:'Открой игру внутри Telegram, чтобы проверить подписку.'});
    await dbReady;
    if(u.subscriptionBonusClaimed||channelBonusClaims.has(u.telegramId))return cb({ok:false,message:'Бонус за подписку уже получен. Повторно получить его нельзя.'});
    if(!process.env.TELEGRAM_BOT_TOKEN)return cb({ok:false,message:'Проверка подписки пока не настроена. Администратору нужно добавить TELEGRAM_BOT_TOKEN в Railway и дать боту права администратора канала.'});
    try{const response=await fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/getChatMember?chat_id=@vkcoinnew&user_id='+encodeURIComponent(u.telegramId));const data=await response.json();if(!data.ok)return cb({ok:false,error:'Telegram не смог проверить подписку. Проверь права бота в канале.'});const status=data.result&&data.result.status;if(!['member','administrator','creator'].includes(status))return cb({ok:false,message:'Подписка не найдена. Подпишись на @vkcoinnew и попробуй снова.'});u.credits=Math.min(100,u.credits+50);u.subscriptionBonusClaimed=true;channelBonusClaims.add(u.telegramId);await persistUser(u);cb({ok:true,credits:u.credits,message:'Подписка подтверждена! Начислено 50 кредитов.'});}catch(e){cb({ok:false,error:'Не удалось проверить подписку. Попробуй позже.'})}
  });
  socket.on('tops:list', (cb = () => {}) => {
    if(typeof cb!=='function') return;
    cb({ok:true,users:[...users.values()].map(publicUser)});
  });
  socket.on('friends:list', async (cb = () => {}) => {
    const me=users.get(socket.id);if(!me)return cb({ok:false,error:'Сначала создай профиль.'});
    const ids=new Set(await getSavedFriendIds(me));
    for(const id of friendships.get(socket.id)||[]){const u=users.get(id);if(u)ids.add(accountId(u))}
    const online=[...users.values()].filter(u=>u.id!==socket.id&&accountId(u)!==accountId(me)).map(u=>({...publicUser(u),online:true,isFriend:ids.has(accountId(u)),roomId:u.roomId}));
    const onlineIds=new Set(online.map(u=>accountId(u))),offline=[];
    for(const id of ids){if(onlineIds.has(id))continue;const profile=savedProfiles.get(id);if(profile)offline.push({...profile,id:id.replace(/^tg:/,''),accountKey:id,online:false,isFriend:true,roomId:null})}
    cb({ok:true,users:[...online,...offline]});
  });
  socket.on('friends:add', async (payload = {}, cb = () => {}) => {
    const me=users.get(socket.id),target=users.get(String(payload.targetId||''));
    if(!me||!target)return cb({ok:false,error:'Игрок недоступен.'});
    if(target.id===me.id||accountId(target)===accountId(me))return cb({ok:false,error:'Нельзя добавить самого себя в друзья.'});
    if(!friendships.has(socket.id))friendships.set(socket.id,new Set());
    if(!friendships.has(target.id))friendships.set(target.id,new Set());
    friendships.get(socket.id).add(target.id);friendships.get(target.id).add(socket.id);
    if(pool&&me.telegramId&&target.telegramId){try{await dbReady;await pool.query('INSERT INTO game_friendships(account_id,friend_account_id) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING',[accountId(me),accountId(target)])}catch(e){console.error('Friend save failed:',e.message);return cb({ok:false,error:'Не удалось сохранить дружбу.'})}}
    cb({ok:true});io.to(target.id).emit('friends:updated',{name:me.name});
  });
  socket.on('friends:invite', async (payload = {}, cb = () => {}) => {
    const me=users.get(socket.id),room=roomFor(socket),target=users.get(String(payload.targetId||''));
    if(!me||!room)return cb({ok:false,error:'Сначала зайди за стол.'});
    if(!target||target.id===me.id||accountId(target)===accountId(me))return cb({ok:false,error:'Нельзя пригласить самого себя.'});
    if(!(friendships.get(socket.id)||new Set()).has(target.id)&&!(await getSavedFriendIds(me)).includes(accountId(target)))return cb({ok:false,error:'Добавь игрока в друзья.'});
    if(room.players.size>=5)return cb({ok:false,error:'Стол заполнен.'});
    io.to(target.id).emit('room:invite',{roomId:room.id,from:me.name});cb({ok:true});
  });
  socket.on('room:accept-invite', (payload = {}, cb = () => {}) => {
    const u=users.get(socket.id),room=rooms.get(String(payload.roomId||'').toUpperCase());
    if(!u||!room)return cb({ok:false,error:'Стол не найден.'});
    if(room.players.size>=5)return cb({ok:false,error:'Стол заполнен.'});
    if(room.spinning||room.currentPicker)return cb({ok:false,error:'Идёт ход.'});
    leaveRoom(socket);u.roomId=room.id;room.players.set(socket.id,u);socket.join(room.id);
    emitRoom(room.id);cb({ok:true,room:roomState(room.id)});
  });
  socket.on('gifts:list', cb => { if(typeof cb==='function') cb(GIFT_CATALOG); });
  socket.on('gift:send', (payload={},cb=()=>{}) => { const sender=users.get(socket.id), room=roomFor(socket); if(!sender||!room)return cb({ok:false,error:'Сначала зайди за стол.'}); refreshCredits(sender); const target=room.players.get(String(payload.targetId||'')); const gift=GIFT_CATALOG.find(g=>g.id===payload.giftId); if(!target||target.id===sender.id)return cb({ok:false,error:'Выбери другого игрока за столом.'}); if(!gift)return cb({ok:false,error:'Подарок не найден.'}); if(sender.credits<gift.price)return cb({ok:false,error:'Недостаточно кредитов.'}); sender.credits-=gift.price; const received={...gift,fromId:sender.id,fromName:sender.name,at:Date.now()}; target.gifts=target.gifts||[]; target.gifts.push(received);void persistUser(sender);void persistUser(target); io.to(room.id).emit('gift:received',{targetId:target.id,gift:received}); emitRoom(room.id); cb({ok:true,credits:sender.credits,gift}); });
  socket.on('rooms:list', cb => {
    if (typeof cb !== 'function') return;
    cb([...rooms.values()].map(r => ({ id: r.id, count: r.players.size, players: [...r.players.values()].map(publicUser), spinning: r.spinning })));
  });
  socket.on('room:create', (payload = {}, cb = () => {}) => {
    const u = users.get(socket.id);
    if (!u) return cb({ ok: false, error: 'Сначала создай профиль.' });
    leaveRoom(socket);
    let id;
    do { id = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(id));
    const room = { id, players: new Map(), spinning: false, currentPicker: null, targetId: null, lastResult: null, createdAt: Date.now() };
    rooms.set(id, room);
    u.roomId = id; room.players.set(socket.id, u);
    socket.join(id); emitRoom(id); cb({ ok: true, room: roomState(id) });
  });
  socket.on('room:join', (payload = {}, cb = () => {}) => {
    const u = users.get(socket.id);
    if (!u) return cb({ ok: false, error: 'Сначала создай профиль.' });
    const id = String(payload.id || '').toUpperCase().trim();
    const room = rooms.get(id);
    if (!room) return cb({ ok: false, error: 'Стол не найден.' });
    if (room.players.size >= 5) return cb({ ok: false, error: 'За столом уже 5 человек.' });
    if (room.spinning || room.currentPicker) return cb({ ok: false, error: 'Сейчас идёт ход. Попробуй чуть позже.' });
    leaveRoom(socket);
    u.roomId = id; room.players.set(socket.id, u); socket.join(id);
    emitRoom(id); cb({ ok: true, room: roomState(id) });
  });
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('bottle:spin', (cb = () => {}) => {
    const u = users.get(socket.id), room = roomFor(socket);
    if (!u || !room) return cb({ ok: false, error: 'Сначала зайди за стол.' });
    if (room.spinning || room.currentPicker) return cb({ ok: false, error: 'Сначала заверши текущий ход.' });
    if (room.players.size < 2) return cb({ ok: false, error: 'Нужно хотя бы два игрока.' });
    const players = [...room.players.keys()].filter(id => id !== socket.id);
    const targetId = players[Math.floor(Math.random() * players.length)];
    room.spinning = true; room.lastResult = null; room.targetId = targetId; emitRoom(room.id);
    setTimeout(() => {
      const latest = rooms.get(room.id);
      if (!latest) return;
      if (!latest.players.has(socket.id) || !latest.players.has(targetId)) {
        latest.spinning = false; latest.targetId = null; emitRoom(latest.id);
        return;
      }
      latest.spinning = false;
      latest.currentPicker = targetId;
      io.to(targetId).emit('turn:choose', { picker: publicUser(latest.players.get(targetId)), roomId: latest.id });
      emitRoom(latest.id);
    }, 3000);
    cb({ ok: true });
  });
  socket.on('turn:vote', (payload = {}, cb = () => {}) => {
    const room = roomFor(socket);
    if (!room || room.currentPicker !== socket.id) return cb({ ok: false, error: 'Сейчас не твой ход.' });
    const targetId = String(payload.targetId || '');
    const kind = payload.kind;
    if (!room.players.has(targetId) || targetId === socket.id) return cb({ ok: false, error: 'Выбери другого участника за столом.' });
    if (!['kiss', 'dislike'].includes(kind)) return cb({ ok: false, error: 'Выбери поцелуй или дизлайк.' });
    const picker = room.players.get(socket.id), target = room.players.get(targetId);
    if (kind === 'kiss') { target.kisses++; if(target.dailyKissesDay!==dayKey()){target.dailyKissesDay=dayKey();target.dailyKisses=0;target.dailyKissBonusClaimed=false;} target.dailyKisses=(target.dailyKisses||0)+1; if(target.dailyKisses>50&&!target.dailyKissBonusClaimed){target.credits=100;target.dailyKissBonusClaimed=true;io.to(target.id).emit('credits:updated',{userId:target.id,credits:100,reason:'daily-kisses'});}void persistUser(target);} else {target.dislikes++;void persistUser(target)}
    room.lastResult = { picker: publicUser(picker), target: publicUser(target), kind, at: Date.now() };
    room.currentPicker = null; room.targetId = null;
    io.to(room.id).emit('turn:result', room.lastResult);
    emitRoom(room.id);
    cb({ ok: true });
  });
  socket.on('disconnect', () => {const u=users.get(socket.id);if(u)void persistUser(u);leaveRoom(socket);users.delete(socket.id);friendships.delete(socket.id);for(const set of friendships.values())set.delete(socket.id)});
});

server.listen(PORT, '0.0.0.0', () => console.log('Бутылочка listening on ' + PORT));
