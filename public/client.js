(() => {
  const $ = (id) => document.getElementById(id);
  const queue = [];
  let socket = null;
  let currentId = null;
  let role = null;
  let started = false;
  let joined = false;
  let connecting = false;
  let rxPackets = 0;
  let rxWindowAt = Date.now();
  let lastStateSentAt = 0;
  let player;

  window.madnessPoll = function () {
    if (!queue.length) return '';
    return queue.splice(0, 64).join('\n');
  };

  window.madnessSendState = function (x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !started) return;
    const now = performance.now();
    if (now - lastStateSentAt < 16) return;
    lastStateSentAt = now;
    socket.send(JSON.stringify({ type: 'state', state: { x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon } }));
  };

  window.madnessSendPvpHit = function (weapon, head) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !started) return;
    socket.send(JSON.stringify({ type: 'hit', weapon, head: head ? 1 : 0 }));
  };

  function pushToSwf(message) {
    if (message.startsWith('STATE|')) {
      const secondSeparator = message.indexOf('|', 6);
      const playerId = secondSeparator >= 0 ? message.slice(6, secondSeparator) : '';
      if (playerId) {
        const staleState = queue.findIndex((item) => item.startsWith(`STATE|${playerId}|`));
        if (staleState >= 0) queue.splice(staleState, 1);
      }
    }
    if (queue.length >= 600) {
      const stateAt = queue.findIndex((item) => item.startsWith('STATE|'));
      if (stateAt >= 0) queue.splice(stateAt, 1);
      else queue.shift();
    }
    queue.push(message);
  }

  function setStatus(text, kind = '') {
    $('lobbyStatus').textContent = text;
    $('lobbyStatus').className = `lobby-status ${kind}`;
  }

  function setConnection(online, text, error = false) {
    $('connectionDot').className = `dot ${online ? 'online' : error ? 'error' : ''}`;
    $('connectionText').textContent = text;
  }

  function setRoomControls() {
    const busy = connecting || joined;
    $('createRoomButton').disabled = busy;
    $('joinRoomButton').disabled = busy;
    $('roomInput').disabled = busy;
    $('nameInput').disabled = joined;
    $('leaveRoomButton').hidden = !joined;
    $('copyRoomButton').hidden = !joined;
    $('primaryWeapon').disabled = started;
    $('secondaryWeapon').disabled = started;
  }

  function updateRoster(players = []) {
    const me = players.find((peer) => peer.id === currentId);
    if (me) role = me.role;
    $('playerCount').innerHTML = `${players.length} <i>/</i> 2`;
    $('playerList').replaceChildren();
    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const sigil = document.createElement('span');
      sigil.className = 'empty-sigil';
      sigil.textContent = '✦';
      const text = document.createElement('span');
      text.innerHTML = '创建或进入房间后<br>成员将在此显示';
      empty.append(sigil, text);
      $('playerList').appendChild(empty);
    }
    for (const peer of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const icon = document.createElement('span');
      icon.className = 'player-icon';
      icon.textContent = peer.role === 'host' ? 'H' : 'P';
      const name = document.createElement('span');
      name.textContent = peer.name;
      const label = document.createElement('span');
      label.className = 'role';
      label.textContent = peer.id === currentId ? `你 · ${peer.role === 'host' ? '房主' : '玩家'}` : peer.role === 'host' ? '房主' : '玩家';
      row.append(icon, name, label);
      $('playerList').appendChild(row);
    }
    const canStart = joined && role === 'host' && players.length === 2 && !started;
    $('startButton').disabled = !canStart;
    $('startButton').textContent = started ? '已进入竞技场' : canStart ? '开始多人竞技场' : joined ? role === 'host' ? '等待对手加入' : '等待房主开始' : '等待进入房间';
  }

  function closeSocket() {
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  }

  function resetLobby(message = '已离开房间。') {
    currentId = null;
    role = null;
    started = false;
    joined = false;
    connecting = false;
    $('roomInput').disabled = false;
    $('nameInput').disabled = false;
    $('reloadButton').hidden = true;
    $('startButton').disabled = true;
    $('primaryWeapon').disabled = false;
    $('secondaryWeapon').disabled = false;
    $('roomInput').value = '';
    $('playerCount').innerHTML = '0 <i>/</i> 2';
    updateRoster([]);
    setRoomControls();
    setStatus(message);
    setConnection(false, '尚未进入房间');
  }

  function playerName() {
    const name = $('nameInput').value.trim().slice(0, 20) || 'Player';
    $('nameInput').value = name;
    localStorage.setItem('madness-player-name', name);
    return name;
  }

  function connectRoom(mode) {
    if (connecting || joined) return;
    const roomCode = $('roomInput').value.trim().toUpperCase();
    if (mode === 'join' && !roomCode) {
      $('roomInput').focus();
      setStatus('先输入房间码，再点击“进入房间”。', 'bad');
      return;
    }
    closeSocket();
    currentId = null;
    role = null;
    started = false;
    joined = false;
    connecting = true;
    setRoomControls();
    updateRoster([]);
    $('startButton').disabled = true;
    $('startButton').textContent = '正在连接…';
    setConnection(false, '正在连接竞技场…');
    setStatus(mode === 'create' ? '正在创建新的竞技场…' : `正在寻找房间 ${roomCode}…`);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const endpoint = `${scheme}//${location.host}/ws`;
    const ws = new WebSocket(endpoint);
    socket = ws;
    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      const name = playerName();
      ws.send(JSON.stringify(mode === 'create' ? { type: 'create', name } : { type: 'join', room: roomCode, name }));
    });
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') {
        currentId = message.id;
        role = message.role;
        joined = true;
        connecting = false;
        $('roomInput').value = message.room;
        localStorage.setItem('madness-last-room', message.room);
        setRoomControls();
        setConnection(true, `${message.room} · ${role === 'host' ? '房主' : '玩家'}`);
        setStatus(message.created ? `房间 ${message.room} 已创建，把房间码或邀请链接发给对手。` : `已加入房间 ${message.room}，等待房主开始。`, 'good');
      } else if (message.type === 'roster') {
        updateRoster(message.players || []);
        if (message.started && !started) setStatus('竞技场已启动。', 'good');
      } else if (message.type === 'start') {
        started = true;
        setRoomControls();
        pushToSwf(`PVP|${$('primaryWeapon').value}|${$('secondaryWeapon').value}`);
        pushToSwf(`START|${message.role === 'host' ? '1' : '0'}`);
        $('reloadButton').hidden = false;
        $('startButton').disabled = true;
        $('startButton').textContent = '已进入竞技场';
        setStatus('PVP 单挑已开局：双方进入游戏并完成角色选择即可开战。', 'good');
      } else if (message.type === 'pong') {
        const rtt = Math.max(0, Math.round(performance.now() - Number(message.sentAt)));
        $('latencyLabel').textContent = `${rtt} ms`;
        $('latencyLabel').className = rtt < 60 ? 'latency-good' : rtt < 120 ? 'latency-warn' : 'latency-bad';
      } else if (message.type === 'state') {
        rxPackets++;
        const s = message;
        pushToSwf(`STATE|${s.id}|${s.x}|${s.y}|${s.scale}|${s.frame}|${s.facing}|${s.status || ''}|${s.subStatus || ''}|${s.clipFrame}|${s.activeWeapon}|${s.primaryWeapon}|${s.secondaryWeapon}`);
      } else if (message.type === 'hit') {
        pushToSwf(`HIT|${message.weapon}|${message.head ? '1' : '0'}`);
      } else if (message.type === 'leave') {
        pushToSwf(`LEAVE|${message.id}`);
        setStatus('另一位玩家已离开房间。', 'bad');
      } else if (message.type === 'left') {
        resetLobby('已离开房间。可以创建房间或加入其他房间。');
      } else if (message.type === 'arena-reset') {
        started = false;
        setRoomControls();
        $('reloadButton').hidden = true;
        setStatus(message.reason || '房间已重置。', 'bad');
      } else if (message.type === 'error') {
        connecting = false;
        joined = false;
        setRoomControls();
        setConnection(true, '服务器已连接');
        setStatus(message.message || '无法进入房间。', 'bad');
      }
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      const wasJoined = joined;
      joined = false;
      connecting = false;
      currentId = null;
      role = null;
      started = false;
      setRoomControls();
      updateRoster([]);
      $('reloadButton').hidden = true;
      if (wasJoined || $('lobbyStatus').className.includes('bad')) {
        setConnection(false, '房间连接已断开', true);
        if (wasJoined) setStatus('连接已断开；请重新创建房间或输入房间码加入。', 'bad');
      } else {
        setConnection(false, '无法连接服务器', true);
        setStatus('连接已关闭。请检查网络后重试。', 'bad');
      }
    });
    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      setConnection(false, '服务器暂不可达', true);
      setStatus('无法连接服务器；请稍后重试。', 'bad');
    });
  }

  async function copyInvite() {
    if (!joined) return;
    const invite = new URL(location.href);
    invite.searchParams.set('room', $('roomInput').value);
    try {
      await navigator.clipboard.writeText(invite.toString());
      setStatus('邀请链接已复制，发给对手即可加入。', 'good');
    } catch {
      try {
        await navigator.clipboard.writeText($('roomInput').value);
        setStatus('房间码已复制：' + $('roomInput').value, 'good');
      } catch {
        setStatus('房间码：' + $('roomInput').value + '（长按选择并复制）', 'good');
      }
    }
  }

  $('createRoomButton').addEventListener('click', () => connectRoom('create'));
  $('joinRoomButton').addEventListener('click', () => connectRoom('join'));
  $('roomInput').addEventListener('input', () => { $('roomInput').value = $('roomInput').value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20); });
  $('roomInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') connectRoom('join'); });
  $('nameInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('roomInput').focus(); });
  $('copyRoomButton').addEventListener('click', copyInvite);
  $('leaveRoomButton').addEventListener('click', () => {
    if (socket && socket.readyState === WebSocket.OPEN && joined) socket.send(JSON.stringify({ type: 'leave' }));
    else { closeSocket(); resetLobby(); }
  });
  $('startButton').addEventListener('click', () => {
    if (role === 'host' && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'start', mode: 'pvp' }));
  });
  $('reloadButton').addEventListener('click', () => location.reload());
  $('nameInput').value = localStorage.getItem('madness-player-name') || `Player${String(Date.now()).slice(-4)}`;
  const queryRoom = new URLSearchParams(location.search).get('room');
  $('roomInput').value = (queryRoom || localStorage.getItem('madness-last-room') || '').toUpperCase().slice(0, 20);
  $('roomInput').disabled = false;
  $('createRoomButton').disabled = false;
  $('joinRoomButton').disabled = false;
  setInterval(() => {
    const now = Date.now();
    const elapsed = Math.max(1, now - rxWindowAt);
    $('packetRate').textContent = `${Math.round(rxPackets * 1000 / elapsed)} pkt/s`;
    rxPackets = 0;
    rxWindowAt = now;
    if (started && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', sentAt: performance.now() }));
    }
  }, 1000);

  window.RufflePlayer = window.RufflePlayer || {};
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const ruffle = window.RufflePlayer.newest();
      player = ruffle.createPlayer();
      player.style.width = '100%';
      player.style.height = '100%';
      $('ruffleContainer').replaceChildren(player);
      await player.ruffle().load({ url: '/game.swf?v=455477a', autoplay: 'on', allowScriptAccess: true, frameRate: 60, letterbox: 'on' });
      $('fpsLabel').textContent = 'RUFFLE · 60 FPS';
    } catch (error) {
      console.error(error);
      $('fpsLabel').textContent = '游戏加载失败';
      setStatus(`游戏加载失败：${error.message || error}`, 'bad');
    }
  }, { once: true });
})();
