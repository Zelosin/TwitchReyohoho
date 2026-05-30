const WATCHPARTY_ORIGIN = 'https://www.watchparty.me';

const socketCache = new Map();

function createUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16)
  );
}

async function getStoredIds() {
  const stored = await chrome.storage.local.get([
    'watchpartyClientId',
    'watchpartySessionId'
  ]);

  let clientId = stored.watchpartyClientId;
  let sessionId = stored.watchpartySessionId;

  if (!clientId) {
    clientId = createUuid();
  }
  if (!sessionId) {
    sessionId = createUuid();
  }

  await chrome.storage.local.set({
    watchpartyClientId: clientId,
    watchpartySessionId: sessionId
  });

  return { clientId, sessionId };
}

function normalizeRoomId(roomId) {
  const trimmed = String(roomId || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function roomIdToSlug(roomId) {
  return normalizeRoomId(roomId).replace(/^\//, '');
}

function roomIdToWatchUrl(roomId) {
  const slug = roomIdToSlug(roomId);
  return `${WATCHPARTY_ORIGIN}/watch/${slug}`;
}

async function createWatchPartyRoom() {
  const response = await fetch(`${WATCHPARTY_ORIGIN}/createRoom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    throw new Error(`Не удалось создать комнату (${response.status})`);
  }

  const data = await response.json();
  if (!data?.name) {
    throw new Error('Сервер не вернул ID комнаты');
  }

  const roomId = normalizeRoomId(data.name);
  return {
    roomId,
    roomUrl: roomIdToWatchUrl(roomId),
    slug: roomIdToSlug(roomId)
  };
}

function waitForSocketConnect(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Таймаут подключения к WatchParty'));
    }, timeoutMs);

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error?.message || error)));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

async function getWatchPartySocket(roomId) {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    throw new Error('ID комнаты не указан');
  }

  const cached = socketCache.get(normalizedRoomId);
  if (cached?.connected) {
    return cached;
  }

  if (typeof io === 'undefined') {
    throw new Error('Socket.IO недоступен');
  }

  const { clientId, sessionId } = await getStoredIds();
  const shardResponse = await fetch(
    `${WATCHPARTY_ORIGIN}/resolveShard${normalizedRoomId}`
  );
  const shard = (await shardResponse.text()) || '';

  const socket = io(`${WATCHPARTY_ORIGIN}${normalizedRoomId}`, {
    transports: ['websocket'],
    query: {
      clientId,
      password: '',
      shard,
      roomId: roomIdToSlug(normalizedRoomId)
    },
    auth: {
      sessionId
    }
  });

  await waitForSocketConnect(socket);
  socketCache.set(normalizedRoomId, socket);

  socket.on('disconnect', () => {
    if (socketCache.get(normalizedRoomId) === socket) {
      socketCache.delete(normalizedRoomId);
    }
  });

  return socket;
}

async function addVideoToWatchPartyQueue(roomId, videoUrl) {
  const url = String(videoUrl || '').trim();
  if (!url) {
    throw new Error('URL видео не указан');
  }

  const socket = await getWatchPartySocket(roomId);
  socket.emit('CMD:playlistAdd', url);
  return { ok: true };
}

async function skipWatchPartyVideo(roomId, currentVideoUrl = null) {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    throw new Error('ID комнаты не указан');
  }

  const socket = await getWatchPartySocket(normalizedRoomId);
  const payload = currentVideoUrl ? String(currentVideoUrl).trim() : null;
  socket.emit('CMD:playlistNext', payload);
  return { ok: true };
}

async function disconnectWatchPartySockets() {
  for (const socket of socketCache.values()) {
    try {
      socket.disconnect();
    } catch {
      /* ignore */
    }
  }
  socketCache.clear();
}

globalThis.RYH_WatchParty = {
  WATCHPARTY_ORIGIN,
  createWatchPartyRoom,
  addVideoToWatchPartyQueue,
  skipWatchPartyVideo,
  disconnectWatchPartySockets,
  roomIdToWatchUrl,
  roomIdToSlug,
  normalizeRoomId
};
