const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const WebSocket = require('ws');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PVP_WEAPONS = new Set(['glock20', 'beretta', 'deagle', 'mp7', 'mp5', 'ak74', 'ak74u', 'm16', 'spas12', 'dragonsword']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const requested = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server, path: '/ws', perMessageDeflate: false, maxPayload: 16 * 1024 });
const rooms = new Map();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function roster(room) {
  return [...room.players.values()].map((peer) => ({ id: peer.id, name: peer.name, role: peer.role }));
}

function broadcastRoster(room) {
  const players = roster(room);
  for (const peer of room.players.values()) send(peer.socket, { type: 'roster', players, started: room.started });
}

function leave(peer) {
  if (!peer.room) return;
  const room = peer.room;
  room.players.delete(peer.id);
  peer.room = null;
  for (const other of room.players.values()) send(other.socket, { type: 'leave', id: peer.id });
  if (room.players.size === 0) {
    rooms.delete(room.name);
  } else {
    if (room.started) room.started = false;
    if (room.players.size) {
      const [first] = room.players.values();
      first.role = 'host';
      for (const other of room.players.values()) send(other.socket, { type: 'arena-reset', reason: 'A player left; the remaining player is now host.' });
      broadcastRoster(room);
    }
  }
}

function normalizeRoomName(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

function joinRoom(socket, peer, roomName, playerName, created = false) {
  let room = rooms.get(roomName);
  if (created) {
    room = { name: roomName, players: new Map(), started: false };
    rooms.set(roomName, room);
  }
  if (!room) {
    send(socket, { type: 'error', code: 'ROOM_NOT_FOUND', message: '找不到这个房间；请检查房间码，或创建新房间。' });
    return;
  }
  if (room.players.size >= 2) {
    send(socket, { type: 'error', code: 'ROOM_FULL', message: '这个房间已满（每个竞技场最多 2 人）。' });
    return;
  }
  peer.name = playerName;
  peer.room = room;
  peer.role = room.players.size === 0 ? 'host' : 'guest';
  room.players.set(peer.id, peer);
  send(socket, { type: 'welcome', id: peer.id, role: peer.role, room: room.name, created });
  broadcastRoster(room);
  if (room.started) send(socket, { type: 'start', role: peer.role });
}
wss.on('connection', (socket) => {
  const peer = { id: crypto.randomBytes(5).toString('hex'), socket, room: null, name: 'Player', role: 'guest', lastStateAt: 0, lastHitAt: 0 };
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === 'ping') {
      const sentAt = Number(message.sentAt);
      if (Number.isFinite(sentAt)) send(socket, { type: 'pong', sentAt });
      return;
    }

    if (message.type === 'create') {
      if (peer.room) return;
      const roomName = createRoomCode();
      const playerName = String(message.name || 'Player').trim().replace(/[|\r\n]/g, '').slice(0, 20) || 'Player';
      joinRoom(socket, peer, roomName, playerName, true);
      return;
    }

    if (message.type === 'join') {
      if (peer.room) return;
      const roomName = normalizeRoomName(message.room);
      const playerName = String(message.name || 'Player').trim().replace(/[|\r\n]/g, '').slice(0, 20) || 'Player';
      if (!roomName) {
        send(socket, { type: 'error', code: 'ROOM_CODE_REQUIRED', message: '请输入房间码。' });
        return;
      }
      joinRoom(socket, peer, roomName, playerName);
      return;
    }

    if (message.type === 'leave' && peer.room) {
      send(socket, { type: 'left' });
      leave(peer);
      return;
    }

    if (!peer.room) return;
    if (message.type === 'start') {
      if (peer.role !== 'host') {
        send(socket, { type: 'error', message: '只有房主可以开始。' });
        return;
      }
      if (peer.room.players.size < 2) {
        send(socket, { type: 'error', message: '先让另一位玩家加入同一房间。' });
        return;
      }
      peer.room.started = true;
      for (const player of peer.room.players.values()) send(player.socket, { type: 'start', role: player.role, mode: 'pvp' });
      broadcastRoster(peer.room);
      return;
    }

    if (message.type === 'hit' && peer.room.started) {
      const now = Date.now();
      if (now - peer.lastHitAt < 2) return;
      peer.lastHitAt = now;
      const weapon = String(message.weapon || 'glock20');
      if (!PVP_WEAPONS.has(weapon)) return;
      const packet = { type: 'hit', weapon, head: message.head === 1 || message.head === true };
      for (const other of peer.room.players.values()) if (other !== peer) send(other.socket, packet);
      return;
    }

    if (message.type === 'state' && peer.room.started) {
      const now = Date.now();
      if (now - peer.lastStateAt < 10) return;
      peer.lastStateAt = now;
      const state = message.state || {};
      const x = Number(state.x), y = Number(state.y), scale = Number(state.scale), frame = Number(state.frame), clipFrame = Number(state.clipFrame);
      if (![x, y, scale, frame, clipFrame].every(Number.isFinite)) return;
      const primaryWeapon = PVP_WEAPONS.has(String(state.primaryWeapon || '').toLowerCase()) ? String(state.primaryWeapon).toLowerCase() : 'glock20';
      const secondaryWeapon = PVP_WEAPONS.has(String(state.secondaryWeapon || '').toLowerCase()) ? String(state.secondaryWeapon).toLowerCase() : 'mp7';
      const activeWeaponValue = Number(state.activeWeapon);
      const activeWeapon = activeWeaponValue === 1 ? 1 : 0;
      const packet = {
        type: 'state', id: peer.id,
        x: Math.max(-2000, Math.min(5000, x)),
        y: Math.max(-2000, Math.min(5000, y)),
        scale: Math.max(-500, Math.min(500, scale)),
        frame: Math.max(1, Math.min(5000, Math.round(frame))),
        clipFrame: Math.max(1, Math.min(5000, Math.round(clipFrame))),
        facing: state.facing === 'left' ? 'left' : 'right',
        status: String(state.status || '').slice(0, 32).replace(/[|\r\n]/g, ''),
        subStatus: String(state.subStatus || '').slice(0, 32).replace(/[|\r\n]/g, ''),
        activeWeapon, primaryWeapon, secondaryWeapon,
      };
      for (const other of peer.room.players.values()) if (other !== peer) send(other.socket, packet);
    }
  });
  socket.on('close', () => leave(peer));
  socket.on('error', () => leave(peer));
});

setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 15000).unref();
wss.on('connection', (socket) => socket.on('pong', () => { socket.isAlive = true; }));

server.listen(PORT, HOST, () => {
  console.log(`本地联机网页: http://localhost:${PORT}`);
  console.log(`同一 Wi-Fi/LAN 的其他设备请使用下面任一地址:`);
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const info of entries || []) if (info.family === 'IPv4' && !info.internal) console.log(`  http://${info.address}:${PORT}  (${name})`);
  }
});

function shutdown() {
  for (const socket of wss.clients) socket.close(1001, 'Server stopped');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
