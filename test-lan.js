const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const port = 8788;
const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  cwd: __dirname,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

function makeClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const backlog = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else backlog.push(message);
  });
  return {
    ws,
    wait(type, predicate = () => true) {
      const index = backlog.findIndex((message) => message.type === type && predicate(message));
      if (index >= 0) return Promise.resolve(backlog.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate: (message) => message.type === type && predicate(message),
          resolve,
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            reject(new Error(`Timed out waiting for ${type}. Backlog: ${JSON.stringify(backlog)}`));
          }, 4000),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* server starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not start. ${serverOutput}`);
}

async function main() {
  try {
    await waitForServer();
    const swfResponse = await fetch(`http://127.0.0.1:${port}/game.swf`);
    assert.equal(swfResponse.status, 200, 'SWF served over HTTP');
    assert.ok(Number(swfResponse.headers.get('content-length')) > 10_000_000, 'full game SWF served');
    const swfBytes = Buffer.from(await swfResponse.arrayBuffer());
    assert.equal(swfBytes.subarray(0, 3).toString(), 'FWS', 'Ruffle receives an uncompressed SWF signature');
    const ruffleResponse = await fetch(`http://127.0.0.1:${port}/ruffle/ruffle.js`);
    assert.equal(ruffleResponse.status, 200, 'Ruffle self-hosted JavaScript served');

    const host = makeClient();
    await new Promise((resolve, reject) => {
      host.ws.once('open', resolve);
      host.ws.once('error', reject);
    });
    const missingRoom = host.wait('error');
    host.ws.send(JSON.stringify({ type: 'join', room: 'MISSING', name: 'PlayerHost' }));
    assert.equal((await missingRoom).code, 'ROOM_NOT_FOUND', 'join must require an existing room');

    const hostWelcome = host.wait('welcome');
    const hostRoster1 = host.wait('roster');
    host.ws.send(JSON.stringify({ type: 'create', name: 'PlayerHost' }));
    const welcome = await hostWelcome;
    assert.equal(welcome.role, 'host');
    assert.equal(welcome.created, true, 'create action creates a fresh room');
    assert.match(welcome.room, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal((await hostRoster1).players.length, 1);

    const guest = makeClient();
    await new Promise((resolve, reject) => {
      guest.ws.once('open', resolve);
      guest.ws.once('error', reject);
    });
    const guestWelcome = guest.wait('welcome');
    const guestRoster = guest.wait('roster');
    const hostRoster2 = host.wait('roster');
    guest.ws.send(JSON.stringify({ type: 'join', room: welcome.room.toLowerCase(), name: 'PlayerGuest' }));
    const guestInfo = await guestWelcome;
    assert.equal(guestInfo.role, 'guest');
    assert.equal((await guestRoster).players.length, 2);
    assert.equal((await hostRoster2).players.length, 2);

    const hostStart = host.wait('start');
    const guestStart = guest.wait('start');
    host.ws.send(JSON.stringify({ type: 'start' }));
    const hostStartInfo = await hostStart;
    const guestStartInfo = await guestStart;
    assert.equal(hostStartInfo.role, 'host');
    assert.equal(guestStartInfo.role, 'guest');
    assert.equal(hostStartInfo.mode, 'pvp');
    assert.equal(guestStartInfo.mode, 'pvp');
    const pong = host.wait('pong');
    host.ws.send(JSON.stringify({ type: 'ping', sentAt: 123.5 }));
    assert.equal((await pong).sentAt, 123.5, 'server echoes RTT probe timestamp');

    const pvpHit = host.wait('hit');
    guest.ws.send(JSON.stringify({ type: 'hit', weapon: 'spas12', head: 1 }));
    const hit = await pvpHit;
    assert.equal(hit.weapon, 'spas12');
    assert.equal(hit.head, true);

    const stateReceived = host.wait('state');
    guest.ws.send(JSON.stringify({ type: 'state', state: { x: 410, y: 260, scale: 100, frame: 4, clipFrame: 12, facing: 'left', status: 'idle', subStatus: '', activeWeapon: 1, primaryWeapon: 'spas12', secondaryWeapon: 'beretta' } }));
    const state = await stateReceived;
    assert.equal(state.x, 410);
    assert.equal(state.facing, 'left');
    assert.equal(state.clipFrame, 12);
    assert.equal(state.id, guestInfo.id);
    assert.equal(state.activeWeapon, 1);
    assert.equal(state.primaryWeapon, 'spas12');
    assert.equal(state.secondaryWeapon, 'beretta');

    const leaveReceived = host.wait('leave');
    const leftAck = guest.wait('left');
    guest.ws.send(JSON.stringify({ type: 'leave' }));
    await leftAck;
    await leaveReceived;
    host.ws.close();
    console.log('PASS: HTTP game/Ruffle assets; create/join room flow and missing-room rejection; 1v1 PVP relay; explicit leave event.');
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
