const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const users = new Map();

app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, app: 'Бутылочка' }));

function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, age: u.age, avatar: u.avatar,
    kisses: u.kisses, dislikes: u.dislikes, joinedAt: u.joinedAt };
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
  socket.on('profile:register', (payload = {}, cb = () => {}) => {
    const age = Number(payload.age);
    const name = String(payload.name || payload.username || '').trim().slice(0, 24);
    if (!name) return cb({ ok: false, error: 'Укажи никнейм.' });
    if (!Number.isInteger(age) || age < 13 || age > 99) return cb({ ok: false, error: 'Укажи возраст от 13 до 99 лет.' });
    const previous = users.get(socket.id);
    if (previous && previous.roomId) leaveRoom(socket);
    const tg = payload.telegram || {};
    users.set(socket.id, {
      id: socket.id, name, username: String(payload.username || tg.username || name).replace(/^@/, '').slice(0, 32),
      age, avatar: String(payload.avatar || tg.photo_url || '').slice(0, 500),
      kisses: previous ? previous.kisses : 0, dislikes: previous ? previous.dislikes : 0,
      joinedAt: previous ? previous.joinedAt : Date.now(), roomId: null
    });
    cb({ ok: true, user: publicUser(users.get(socket.id)) });
  });
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
    if (kind === 'kiss') target.kisses++; else target.dislikes++;
    room.lastResult = { picker: publicUser(picker), target: publicUser(target), kind, at: Date.now() };
    room.currentPicker = null; room.targetId = null;
    io.to(room.id).emit('turn:result', room.lastResult);
    emitRoom(room.id);
    cb({ ok: true });
  });
  socket.on('disconnect', () => { leaveRoom(socket); users.delete(socket.id); });
});

server.listen(PORT, '0.0.0.0', () => console.log('Бутылочка listening on ' + PORT));
