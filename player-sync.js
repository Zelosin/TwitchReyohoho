(() => {
  if (window.RYH_PlayerSync) {
    return;
  }

  const VIBIX_WS_ORIGIN = 'wss://sync.videoframe2.com';
  const MAX_RECONNECT_ATTEMPTS = 8;
  const RECONNECT_BASE_MS = 1000;
  const HEARTBEAT_MS = 25000;
  const SYNC_THRESHOLD = 2;

  let ws = null;
  let roomId = '';
  let username = '';
  let wsOrigin = VIBIX_WS_ORIGIN;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let intentionalClose = false;
  let applyingRemoteSeek = false;
  let applyingRemotePlayback = false;
  let roleAssigned = false;

  function emit(event, detail) {
    window.postMessage(
      {
        source: 'ryh-player-sync',
        type: event,
        detail: detail || {}
      },
      '*'
    );
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendMessage({ type: 'ping' });
    }, HEARTBEAT_MS);
  }

  function buildWsUrl() {
    return `${wsOrigin}?room=${encodeURIComponent(roomId)}`;
  }

  function scheduleReconnect() {
    if (intentionalClose || !roomId || !username) {
      return;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      emit('sync-error', { error: 'Не удалось переподключиться к серверу синхронизации' });
      return;
    }

    const delay = RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts);
    reconnectAttempts += 1;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function sendMessage(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function getOverlayFrame() {
    return document.getElementById('ryh-player-overlay')?.querySelector('.ryh-player-frame');
  }

  function postToPlayerFrame(message) {
    const iframe = getOverlayFrame();
    if (!iframe?.contentWindow) {
      return false;
    }

    try {
      iframe.contentWindow.postMessage(message, '*');
      return true;
    } catch {
      return false;
    }
  }

  function broadcastPlayback(event, time) {
    if (applyingRemoteSeek || applyingRemotePlayback) {
      return { ok: false, skipped: true };
    }

    const payload = {
      type: 'sync',
      event: String(event)
    };

    if (typeof time === 'number' && Number.isFinite(time)) {
      payload.time = Number(time);
    }

    const ok = sendMessage(payload);
    return { ok };
  }

  function applyRemotePlayback(event, time) {
    applyingRemotePlayback = true;
    emit('remote-playback', { event, time });

    postToPlayerFrame({
      source: 'ryh-player-sync-bridge',
      command: String(event),
      time: typeof time === 'number' ? time : undefined
    });

    postToPlayerFrame({
      type: 'playerCommand',
      command: String(event),
      value: typeof time === 'number' ? time : undefined,
      timestamp: Date.now()
    });

    window.setTimeout(() => {
      applyingRemotePlayback = false;
    }, 350);
  }

  function handleSyncEvent(data) {
    if (data.username && data.username === username) {
      return;
    }

    if (data.event === 'seek' && typeof data.time === 'number') {
      applyingRemoteSeek = true;
      emit('remote-seek', { time: data.time, username: data.username });
      postToPlayerFrame({
        source: 'ryh-player-sync-bridge',
        command: 'seek',
        time: data.time
      });
      window.setTimeout(() => {
        applyingRemoteSeek = false;
      }, 300);
      return;
    }

    if (data.event === 'play' || data.event === 'pause') {
      applyRemotePlayback(data.event, data.time);
    }
  }

  function extractSeekTimeFromPayload(data) {
    if (!data || typeof data !== 'object') {
      return null;
    }

    if (data.source === 'ryh-player-bridge' || data.source === 'ryh-player-sync') {
      return null;
    }

    if (data.type === 'playerEvent' && data.event === 'seek' && typeof data.time === 'number') {
      return data.time;
    }

    const eventName = String(data.event || data.type || data.name || data.method || '').toLowerCase();
    const isSeek =
      eventName === 'seek' ||
      eventName === 'seeked' ||
      eventName === 'jump' ||
      eventName === 'position' ||
      eventName === 'scrub' ||
      data.type === 'seek';

    if (!isSeek) {
      return null;
    }

    const candidates = [
      data.time,
      data.currentTime,
      data.position,
      data.seconds,
      data.value,
      data?.data?.time,
      data?.data?.seconds
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function handlePlayerEventFromFrame(data) {
    if (applyingRemoteSeek || applyingRemotePlayback) {
      return;
    }

    if (data.event === 'seek' && typeof data.time === 'number') {
      broadcastSeek(data.time);
      return;
    }

    if (data.event === 'play' || data.event === 'pause') {
      broadcastPlayback(data.event, data.time);
    }
  }

  function openSocket() {
    if (!roomId || !username) {
      return;
    }

    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    roleAssigned = false;

    try {
      ws = new WebSocket(buildWsUrl());
    } catch (error) {
      emit('sync-error', { error: error.message || 'WebSocket error' });
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      sendMessage({
        type: 'join',
        roomId,
        username,
        isHost: false
      });
      startHeartbeat();
    });

    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === 'viewers') {
        emit('sync-viewers', { count: data.count, roomId: data.roomId || roomId });
        return;
      }

      if (data.type === 'role_assigned') {
        roleAssigned = true;
        emit('sync-connected', { roomId, username, isHost: Boolean(data.isHost) });
        return;
      }

      if (data.type === 'sync') {
        handleSyncEvent(data);
        return;
      }

      if (data.type === 'state') {
        if (typeof data.time === 'number') {
          applyingRemoteSeek = true;
          emit('remote-seek', { time: data.time, username: data.username, fromState: true });
          postToPlayerFrame({
            source: 'ryh-player-sync-bridge',
            command: 'seek',
            time: data.time
          });
          window.setTimeout(() => {
            applyingRemoteSeek = false;
          }, 300);
        }

        if (data.playing === true) {
          applyRemotePlayback('play', data.time);
        } else if (data.playing === false) {
          applyRemotePlayback('pause', data.time);
        }
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      roleAssigned = false;
      stopHeartbeat();
      if (!intentionalClose) {
        emit('sync-disconnected', { roomId });
        scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      emit('sync-error', { error: 'Ошибка WebSocket-соединения' });
    });
  }

  function connect(options) {
    const nextRoomId = String(options?.roomId || '').trim();
    const nextUsername = String(options?.username || options?.clientId || '').trim();
    const nextWsOrigin = String(options?.wsOrigin || VIBIX_WS_ORIGIN).trim() || VIBIX_WS_ORIGIN;

    if (!nextRoomId || !nextUsername) {
      return { ok: false, error: 'roomId and username required' };
    }

    const forceReconnect = Boolean(options?.force);
    const roomChanged = Boolean(roomId && nextRoomId !== roomId);
    const usernameChanged = Boolean(username && nextUsername !== username);

    if (forceReconnect || roomChanged || usernameChanged || wsOrigin !== nextWsOrigin) {
      if (ws) {
        intentionalClose = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
        intentionalClose = false;
      }
    }

    roomId = nextRoomId;
    username = nextUsername;
    wsOrigin = nextWsOrigin;
    intentionalClose = false;
    reconnectAttempts = 0;
    clearReconnectTimer();

    openSocket();
    return { ok: true, roomId, username, wsOrigin };
  }

  function disconnect() {
    intentionalClose = true;
    clearReconnectTimer();
    stopHeartbeat();
    reconnectAttempts = 0;
    roleAssigned = false;

    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }

    roomId = '';
    emit('sync-disconnected', {});
    return { ok: true };
  }

  function broadcastSeek(time) {
    if (applyingRemoteSeek || applyingRemotePlayback) {
      return { ok: false, skipped: true };
    }

    const ok = sendMessage({
      type: 'sync',
      event: 'seek',
      time: Number(time)
    });

    return { ok };
  }

  function broadcastSeekDelta() {
    return { ok: true, localOnly: true };
  }

  function getState() {
    return {
      connected: Boolean(ws && ws.readyState === WebSocket.OPEN && roleAssigned),
      roomId,
      username,
      wsOrigin
    };
  }

  function setupRelay() {
    if (window.__RYH_SYNC_RELAY__) {
      return;
    }
    window.__RYH_SYNC_RELAY__ = true;

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data) {
        return;
      }

      if (data.source === 'ryh-player-bridge') {
        if (data.type === 'localSeek' && typeof data.time === 'number') {
          broadcastSeek(data.time);
          return;
        }

        if (data.type === 'localPlayback' && (data.event === 'play' || data.event === 'pause')) {
          broadcastPlayback(data.event, data.time);
        }
        return;
      }

      const overlayFrame = getOverlayFrame();
      if (!overlayFrame?.contentWindow || event.source !== overlayFrame.contentWindow) {
        return;
      }

      if (data.type === 'playerEvent') {
        handlePlayerEventFromFrame(data);
        return;
      }

      const seekTime = extractSeekTimeFromPayload(data);
      if (seekTime !== null) {
        broadcastSeek(seekTime);
      }
    });
  }

  setupRelay();

  window.RYH_PlayerSync = {
    connect,
    disconnect,
    broadcastSeek,
    broadcastSeekDelta,
    broadcastPlayback,
    getState,
    SYNC_THRESHOLD
  };
})();
