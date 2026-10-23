(() => {
  const $ = (id) => document.getElementById(id);
  const queue = [];
  let socket = null;
  let currentId = null;
  let role = null;
  let started = false;
  let rxPackets = 0;
  let rxWindowAt = Date.now();
  let player;

  window.madnessPoll = function () {
    if (!queue.length) return '';
    return queue.splice(0, 64).join('\n');
  };

  window.madnessSendState = function (x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !started) return;
    socket.send(JSON.stringify({
      type: 'state',
      state: { x, y, scale, frame, facing, status, subStatus, clipFrame, activeWeapon, primaryWeapon, secondaryWeapon },
    }));
  };

  window.madnessSendPvpHit = function (weapon, head) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !started) return;
    socket.send(JSON.stringify({ type: 'hit', weapon, head: head ? 1 : 0 }));
  };

  function pushToSwf(message) {
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

  function updateRoster(players = []) {
    const me = players.find((peer) => peer.id === currentId);
    if (me) role = me.role;
    $('playerCount').textContent = `${players.length} / 2`;
    $('playerList').replaceChildren();
    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '等待连接房间…';
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
      label.textContent = peer.id === currentId ? '你 · ' + (peer.role === 'host' ? '房主' : '玩家') : peer.role === 'host' ? '房主' : '玩家';
      row.append(icon, name, label);
      $('playerList').appendChild(row);
    }
    const canStart = role === 'host' && players.length === 2 && !started;
    $('startButton').disabled = !canStart;
    $('startButton').textContent = started ? '已进入竞技场' : role === 'host' ? players.length === 2 ? '开始多人竞技场' : '等待第二位玩家' : '等待房主开始';
  }

  function closeSocket() {
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  }

  function connectRoom() {
    closeSocket();
    currentId = null;
    role = null;
    started = false;
    $('roomInput').disabled = false;
    $('nameInput').disabled = false;
    $('primaryWeapon').disabled = false;
    $('secondaryWeapon').disabled = false;
    $('reloadButton').hidden = true;
    $('startButton').disabled = true;
    $('startButton').textContent = '连接中…';
    updateRoster([]);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const endpoint = `${scheme}//${location.host}/ws`;
    setConnection(false, `连接 ${endpoint}`);
    setStatus('正在建立局域网连接…');
    socket = new WebSocket(endpoint);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', room: $('roomInput').value || 'LOCAL', name: $('nameInput').value || 'Player' }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') {
        currentId = message.id;
        role = message.role;
        $('roomInput').disabled = true;
        $('nameInput').disabled = true;
        setConnection(true, `已连接 · ${message.room} · ${role === 'host' ? '房主' : '玩家'}`);
        setStatus('连接成功；双开另一个浏览器窗口后即可开始。', 'good');
      } else if (message.type === 'roster') {
        updateRoster(message.players || []);
        if (message.started && !started) setStatus('竞技场已启动。', 'good');
      } else if (message.type === 'start') {
        started = true;
        $('primaryWeapon').disabled = true;
        $('secondaryWeapon').disabled = true;
        pushToSwf(`PVP|${$('primaryWeapon').value}|${$('secondaryWeapon').value}`);
        pushToSwf(`START|${message.role === 'host' ? '1' : '0'}`);
        $('reloadButton').hidden = false;
        $('startButton').disabled = true;
        $('startButton').textContent = '已进入竞技场';
        setStatus('PVP 单挑已开局：本地载入所选武器，命中事件与动作同步。', 'good');
      } else if (message.type === 'state') {
        rxPackets++;
        const s = message;
        pushToSwf(`STATE|${s.id}|${s.x}|${s.y}|${s.scale}|${s.frame}|${s.facing}|${s.status || ''}|${s.subStatus || ''}|${s.clipFrame}|${s.activeWeapon}|${s.primaryWeapon}|${s.secondaryWeapon}`);
      } else if (message.type === 'hit') {
        pushToSwf(`HIT|${message.weapon}|${message.head ? '1' : '0'}`);
      } else if (message.type === 'leave') {
        pushToSwf(`LEAVE|${message.id}`);
        setStatus('另一位玩家已离开房间。', 'bad');
      } else if (message.type === 'arena-reset') {
        started = false;
        $('primaryWeapon').disabled = false;
        $('secondaryWeapon').disabled = false;
        $('reloadButton').hidden = true;
        setStatus(message.reason || '房间已重置。', 'bad');
      } else if (message.type === 'error') {
        setStatus(message.message || '连接错误。', 'bad');
        setConnection(false, '房间连接错误', true);
      }
    });
    socket.addEventListener('close', () => {
      setConnection(false, '已断开', true);
      setStatus('WebSocket 已关闭；点击“连接 / 重连”再试。', 'bad');
      updateRoster([]);
    });
    socket.addEventListener('error', () => {
      setConnection(false, '无法连接本地服务器', true);
      setStatus('连不上服务器。请先运行 start.ps1，再刷新页面。', 'bad');
    });
  }

  $('connectButton').addEventListener('click', connectRoom);
  $('startButton').addEventListener('click', () => {
    if (role === 'host' && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'start', mode: 'pvp' }));
  });
  $('reloadButton').addEventListener('click', () => location.reload());
  $('nameInput').value = `Player${String(Date.now()).slice(-6)}`;
  setInterval(() => {
    const now = Date.now();
    const elapsed = Math.max(1, now - rxWindowAt);
    $('packetRate').textContent = `${Math.round(rxPackets * 1000 / elapsed)} pkt/s`;
    rxPackets = 0;
    rxWindowAt = now;
  }, 1000);

  window.RufflePlayer = window.RufflePlayer || {};
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const ruffle = window.RufflePlayer.newest();
      player = ruffle.createPlayer();
      player.style.width = '100%';
      player.style.height = '100%';
      $('ruffleContainer').appendChild(player);
      await player.ruffle().load({ url: '/game.swf', autoplay: 'on', allowScriptAccess: true, frameRate: 60, letterbox: 'on' });
      $('fpsLabel').textContent = 'Ruffle · 60 FPS';
    } catch (error) {
      console.error(error);
      $('fpsLabel').textContent = 'Ruffle / SWF 加载失败';
      setStatus(`游戏加载失败：${error.message || error}`, 'bad');
    }
  }, { once: true });

  connectRoom();
})();
