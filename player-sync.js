(() => {
  if (window.RYH_PlayerSync) {
    return;
  }

  const VIBIX_WS_ORIGIN = 'wss://sync.videoframe2.com';
  const MAX_RECONNECT_ATTEMPTS = 8;
  const RECONNECT_BASE_MS = 1000;
  const HEARTBEAT_MS = 25000;
  const SYNC_THRESHOLD = 2;

  // Production WS reliably relays only play/pause/seek. Encode Rutube playlist
  // updates as seek times outside any real video duration (>= 190000).
  const RYH_MAGIC_MIN = 190000;
  const RYH_MAGIC_MAX = 1000000;
  const RYH_MAGIC_REQUEST = 190001;
  const RYH_MAGIC_MEDIA_COMMIT = 190002;
  const RYH_MAGIC_QUEUE_COMMIT = 190003;
  const RYH_MAGIC_STATE_COMMIT = 190005;
  const RYH_MAGIC_STATE_WITH_CURRENT = 190100;
  const RYH_MAGIC_STATE_QUEUE_ONLY = 190200;
  const RYH_CHUNK_BASE = 200000;
  const RYH_CHUNK_STRIDE = 100000;
  const RYH_MAGIC_SEND_GAP_MS = 30;

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
  let remoteGuardUntil = 0;
  let lastRemoteSeekTime = null;
  let lastRemoteSeekAt = 0;
  let statePlaybackBootstrapUntil = 0;
  let lastLocalPlaybackAt = 0;
  let lastLocalPlaybackEvent = '';
  let lastAppliedRemotePlayback = null;
  let pendingOutboundPlayback = null;
  const REMOTE_PLAYBACK_GUARD_MS = 1600;
  const LOCAL_INTENT_PRIORITY_MS = 1500;
  let roleAssigned = false;
  let magicSendChain = Promise.resolve();
  let magicRecv = {
    mode: '',
    chunks: [],
    expectedVideos: 0,
    videos: [],
    hasCurrent: true
  };

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

  function armRemoteGuard(durationMs) {
    remoteGuardUntil = Math.max(remoteGuardUntil, Date.now() + Math.max(0, Number(durationMs) || 0));
  }

  function isRemoteGuardActive() {
    return Date.now() < remoteGuardUntil;
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
    const cmd = String(event || '').toLowerCase();
    if (cmd !== 'play' && cmd !== 'pause') {
      return { ok: false, skipped: true };
    }

    const now = Date.now();
    lastLocalPlaybackAt = now;
    lastLocalPlaybackEvent = cmd;
    pendingOutboundPlayback = { event: cmd, at: now };

    const payload = {
      type: 'sync',
      event: cmd
    };

    if (typeof time === 'number' && Number.isFinite(time)) {
      payload.time = Number(time);
    }

    const ok = sendMessage(payload);
    return { ok };
  }

  function applyRemotePlayback(event, time) {
    const cmd = String(event || '').toLowerCase();
    if (cmd !== 'play' && cmd !== 'pause') {
      return;
    }

    const now = Date.now();
    const pending = pendingOutboundPlayback;
    // Ignore echo of our own outbound event.
    if (pending && pending.event === cmd && now - pending.at < 1200) {
      return;
    }

    // Prefer recent local user intent over opposite remote play/pause
    // (blocks startup/load echo without blocking same-direction sync forever).
    if (
      lastLocalPlaybackEvent &&
      lastLocalPlaybackEvent !== cmd &&
      now - lastLocalPlaybackAt < LOCAL_INTENT_PRIORITY_MS
    ) {
      return;
    }

    // Debounce identical remote playback.
    if (
      lastAppliedRemotePlayback &&
      lastAppliedRemotePlayback.event === cmd &&
      now - lastAppliedRemotePlayback.at < 900
    ) {
      return;
    }

    lastAppliedRemotePlayback = { event: cmd, at: now };
    applyingRemotePlayback = true;
    armRemoteGuard(REMOTE_PLAYBACK_GUARD_MS);

    let resolvedTime = typeof time === 'number' ? time : undefined;
    if (
      typeof lastRemoteSeekTime === 'number' &&
      Date.now() - lastRemoteSeekAt < 1800 &&
      (typeof resolvedTime !== 'number' || Math.abs(resolvedTime - lastRemoteSeekTime) > 1.25)
    ) {
      resolvedTime = lastRemoteSeekTime;
    }

    emit('remote-playback', { event: cmd, time: resolvedTime });

    postToPlayerFrame({
      source: 'ryh-player-sync-bridge',
      command: cmd,
      time: resolvedTime
    });

    postToPlayerFrame({
      type: 'playerCommand',
      command: cmd,
      value: resolvedTime,
      timestamp: Date.now()
    });

    window.setTimeout(() => {
      applyingRemotePlayback = false;
    }, REMOTE_PLAYBACK_GUARD_MS);
  }

  function isMagicSeekTime(time) {
    return typeof time === 'number' && Number.isFinite(time) && time >= RYH_MAGIC_MIN && time < RYH_MAGIC_MAX;
  }

  function resetMagicRecv() {
    magicRecv = {
      mode: '',
      chunks: [],
      expectedVideos: 0,
      videos: [],
      hasCurrent: true
    };
  }

  function chunksToHex32(chunks) {
    if (!Array.isArray(chunks) || chunks.length < 8) {
      return '';
    }
    let hex = '';
    for (let i = 0; i < 8; i += 1) {
      const value = chunks[i];
      if (typeof value !== 'number' || value < 0 || value > 65535) {
        return '';
      }
      hex += value.toString(16).padStart(4, '0');
    }
    return /^[a-f0-9]{32}$/.test(hex) ? hex : '';
  }

  function decodeMagicChunk(time) {
    if (time < RYH_CHUNK_BASE || time >= RYH_MAGIC_MAX) {
      return null;
    }
    const offset = Math.round(time - RYH_CHUNK_BASE);
    const index = Math.floor(offset / RYH_CHUNK_STRIDE);
    const value = offset - index * RYH_CHUNK_STRIDE;
    if (index < 0 || index > 7 || value < 0 || value > 65535) {
      return null;
    }
    return { index, value };
  }

  function emitRemoteRutube(eventName) {
    emit('remote-rutube', {
      event: eventName,
      username: '',
      roomId
    });
  }

  function finishMagicVideoFromChunks() {
    const videoId = chunksToHex32(magicRecv.chunks);
    magicRecv.chunks = [];
    return videoId;
  }

  function handleMagicSeek(time) {
    const rounded = Math.round(time);

    if (rounded === RYH_MAGIC_REQUEST) {
      emitRemoteRutube('rutube_request_state');
      return;
    }

    if (
      rounded >= RYH_MAGIC_STATE_WITH_CURRENT &&
      rounded < RYH_MAGIC_STATE_WITH_CURRENT + 100
    ) {
      magicRecv.mode = 'state';
      magicRecv.hasCurrent = true;
      magicRecv.expectedVideos = 1 + (rounded - RYH_MAGIC_STATE_WITH_CURRENT);
      magicRecv.videos = [];
      magicRecv.chunks = [];
      return;
    }

    if (
      rounded >= RYH_MAGIC_STATE_QUEUE_ONLY &&
      rounded < RYH_MAGIC_STATE_QUEUE_ONLY + 100
    ) {
      magicRecv.mode = 'state';
      magicRecv.hasCurrent = false;
      magicRecv.expectedVideos = rounded - RYH_MAGIC_STATE_QUEUE_ONLY;
      magicRecv.videos = [];
      magicRecv.chunks = [];
      return;
    }

    const chunk = decodeMagicChunk(rounded);
    if (chunk) {
      magicRecv.chunks[chunk.index] = chunk.value;
      if (magicRecv.mode === 'state') {
        const filled = magicRecv.chunks.filter((v) => typeof v === 'number').length;
        if (filled >= 8) {
          const videoId = finishMagicVideoFromChunks();
          if (videoId) {
            magicRecv.videos.push(videoId);
          }
          if (
            magicRecv.expectedVideos > 0 &&
            magicRecv.videos.length >= magicRecv.expectedVideos
          ) {
            const current = magicRecv.hasCurrent ? magicRecv.videos[0] || '-' : '-';
            const queue = magicRecv.hasCurrent
              ? magicRecv.videos.slice(1)
              : magicRecv.videos;
            emitRemoteRutube(`rutube_state:${current}:${queue.join(',')}`);
            resetMagicRecv();
          }
        }
      }
      return;
    }

    if (rounded === RYH_MAGIC_MEDIA_COMMIT) {
      const videoId = finishMagicVideoFromChunks();
      resetMagicRecv();
      if (videoId) {
        emitRemoteRutube(`rutube_media:${videoId}:Rutube`);
      }
      return;
    }

    if (rounded === RYH_MAGIC_QUEUE_COMMIT) {
      const videoId = finishMagicVideoFromChunks();
      resetMagicRecv();
      if (videoId) {
        emitRemoteRutube(`rutube_queue:${videoId}:Rutube`);
      }
      return;
    }

    if (rounded === RYH_MAGIC_STATE_COMMIT) {
      if (magicRecv.mode === 'state' && magicRecv.videos.length) {
        const current = magicRecv.hasCurrent ? magicRecv.videos[0] || '-' : '-';
        const queue = magicRecv.hasCurrent
          ? magicRecv.videos.slice(1)
          : magicRecv.videos;
        emitRemoteRutube(`rutube_state:${current}:${queue.join(',')}`);
      }
      resetMagicRecv();
    }
  }

  function queueMagicSeek(time) {
    magicSendChain = magicSendChain
      .then(
        () =>
          new Promise((resolve) => {
            sendMessage({
              type: 'sync',
              event: 'seek',
              time: Number(time)
            });
            window.setTimeout(resolve, RYH_MAGIC_SEND_GAP_MS);
          })
      )
      .catch(() => {});
    return magicSendChain;
  }

  function encodeHex32ToSeekTimes(videoId) {
    const id = String(videoId || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(id)) {
      return [];
    }
    const times = [];
    for (let i = 0; i < 8; i += 1) {
      const value = parseInt(id.slice(i * 4, i * 4 + 4), 16);
      times.push(RYH_CHUNK_BASE + i * RYH_CHUNK_STRIDE + value);
    }
    return times;
  }

  function broadcastHexViaMagicSeek(videoId, commitTime) {
    const times = encodeHex32ToSeekTimes(videoId);
    if (!times.length) {
      return { ok: false };
    }
    times.forEach((time) => {
      queueMagicSeek(time);
    });
    queueMagicSeek(commitTime);
    return { ok: true };
  }

  function broadcastRutubeEventViaMagicSeek(eventName) {
    const event = String(eventName || '').trim();

    if (event === 'rutube_request_state' || event.startsWith('rutube_request_state')) {
      queueMagicSeek(RYH_MAGIC_REQUEST);
      return { ok: true };
    }

    if (event.startsWith('rutube_media:')) {
      const videoId = event.split(':')[1] || '';
      return broadcastHexViaMagicSeek(videoId, RYH_MAGIC_MEDIA_COMMIT);
    }

    if (event.startsWith('rutube_queue:')) {
      const videoId = event.split(':')[1] || '';
      return broadcastHexViaMagicSeek(videoId, RYH_MAGIC_QUEUE_COMMIT);
    }

    if (event.startsWith('rutube_state:')) {
      const parts = event.split(':');
      const current = parts[1] === '-' ? '' : String(parts[1] || '').toLowerCase();
      const queue = String(parts[2] || '')
        .split(',')
        .map((id) => id.toLowerCase())
        .filter((id) => /^[a-f0-9]{32}$/.test(id));
      const videos = current && /^[a-f0-9]{32}$/.test(current) ? [current, ...queue] : [...queue];
      if (!videos.length) {
        return { ok: false };
      }

      if (current && /^[a-f0-9]{32}$/.test(current)) {
        queueMagicSeek(RYH_MAGIC_STATE_WITH_CURRENT + Math.min(queue.length, 99));
      } else {
        queueMagicSeek(RYH_MAGIC_STATE_QUEUE_ONLY + Math.min(queue.length, 99));
      }

      videos.forEach((videoId) => {
        encodeHex32ToSeekTimes(videoId).forEach((time) => {
          queueMagicSeek(time);
        });
      });
      queueMagicSeek(RYH_MAGIC_STATE_COMMIT);
      return { ok: true };
    }

    return { ok: false };
  }

  function handleSyncEvent(data) {
    if (data.username && data.username === username) {
      return;
    }
    if (data.clientId && data.clientId === username) {
      return;
    }

    const eventName = String(data.event || '');
    if (eventName.startsWith('rutube_')) {
      emit('remote-rutube', {
        event: eventName,
        username: data.username || data.clientId || '',
        roomId: data.roomId || roomId
      });
      return;
    }

    if (data.event === 'seek' && typeof data.time === 'number') {
      if (isMagicSeekTime(data.time)) {
        handleMagicSeek(data.time);
        return;
      }

      applyingRemoteSeek = true;
      lastRemoteSeekTime = data.time;
      lastRemoteSeekAt = Date.now();
      armRemoteGuard(1200);
      emit('remote-seek', { time: data.time, username: data.username });
      postToPlayerFrame({
        source: 'ryh-player-sync-bridge',
        command: 'seek',
        time: data.time
      });
      window.setTimeout(() => {
        applyingRemoteSeek = false;
      }, 1200);
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
    if (applyingRemoteSeek && data.event === 'seek') {
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
      // Only trust generic "state.playing" right after (re)connect.
      statePlaybackBootstrapUntil = Date.now() + 5000;
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
        if (typeof data.time === 'number' && !isMagicSeekTime(data.time)) {
          applyingRemoteSeek = true;
          lastRemoteSeekTime = data.time;
          lastRemoteSeekAt = Date.now();
          armRemoteGuard(1200);
          emit('remote-seek', { time: data.time, username: data.username, fromState: true });
          postToPlayerFrame({
            source: 'ryh-player-sync-bridge',
            command: 'seek',
            time: data.time
          });
          window.setTimeout(() => {
            applyingRemoteSeek = false;
          }, 1200);
        }

        const now = Date.now();
        const isBootstrapWindow = now <= statePlaybackBootstrapUntil;
        const hasRecentLocalIntent = now - lastLocalPlaybackAt < LOCAL_INTENT_PRIORITY_MS;
        // Only apply server playing-state once after connect, never while user is controlling.
        if (!hasRecentLocalIntent && isBootstrapWindow) {
          // Prefer seek-only bootstrap; apply pause only if explicitly paused.
          // Avoid applying "play" from stale room state — it fights local autoplay.
          if (data.playing === false) {
            applyRemotePlayback('pause', isMagicSeekTime(data.time) ? undefined : data.time);
          }
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
    if (applyingRemoteSeek || applyingRemotePlayback || isRemoteGuardActive()) {
      return { ok: false, skipped: true };
    }

    if (isMagicSeekTime(time)) {
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

  function broadcastRutubeEvent(eventName) {
    const event = String(eventName || '').trim();
    if (!event.startsWith('rutube_')) {
      return { ok: false, error: 'Invalid rutube sync event' };
    }

    // Best-effort custom event (works on open/local relays).
    sendMessage({
      type: 'sync',
      event
    });

    // Production-safe fallback: encode as seek times.
    return broadcastRutubeEventViaMagicSeek(event);
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
    broadcastRutubeEvent,
    getState,
    SYNC_THRESHOLD
  };
})();
