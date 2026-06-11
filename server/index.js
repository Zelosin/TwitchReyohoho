const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3921;
const HEARTBEAT_MS = 30000;

/** @type {Map<string, Set<{ ws: WebSocket, clientId: string }>>} */
const rooms = new Map();

/** @type {WeakMap<WebSocket, { roomId: string, clientId: string }>} */
const clients = new WeakMap();

function normalizeRoomId(roomId) {
  return String(roomId || '').trim();
}

function getRoomClients(roomId) {
  const key = normalizeRoomId(roomId);
  if (!key) {
    return null;
  }

  if (!rooms.has(key)) {
    rooms.set(key, new Set());
  }

  return rooms.get(key);
}

function broadcastViewers(roomId) {
  const roomClients = getRoomClients(roomId);
  if (!roomClients) {
    return;
  }

  const payload = JSON.stringify({
    type: 'viewers',
    count: roomClients.size,
    roomId: normalizeRoomId(roomId)
  });

  for (const client of roomClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function removeClient(ws) {
  const meta = clients.get(ws);
  if (!meta) {
    return;
  }

  const roomClients = rooms.get(meta.roomId);
  if (roomClients) {
    for (const client of roomClients) {
      if (client.ws === ws) {
        roomClients.delete(client);
        break;
      }
    }

    if (roomClients.size === 0) {
      rooms.delete(meta.roomId);
    } else {
      broadcastViewers(meta.roomId);
    }
  }

  clients.delete(ws);
}

function handleJoin(ws, data) {
  const roomId = normalizeRoomId(data.roomId);
  const clientId = String(data.clientId || '').trim();

  if (!roomId || !clientId) {
    ws.send(JSON.stringify({ type: 'error', error: 'roomId and clientId required' }));
    return;
  }

  removeClient(ws);

  const roomClients = getRoomClients(roomId);
  roomClients.add({ ws, clientId });
  clients.set(ws, { roomId, clientId });

  ws.send(
    JSON.stringify({
      type: 'joined',
      roomId,
      clientId,
      count: roomClients.size
    })
  );

  broadcastViewers(roomId);
}

function handleSync(ws, data) {
  const meta = clients.get(ws);
  if (!meta) {
    ws.send(JSON.stringify({ type: 'error', error: 'Not in a room' }));
    return;
  }

  const roomClients = rooms.get(meta.roomId);
  if (!roomClients) {
    return;
  }

  const payload = JSON.stringify({
    type: 'sync',
    event: data.event,
    time: data.time,
    delta: data.delta,
    clientId: meta.clientId,
    roomId: meta.roomId
  });

  for (const client of roomClients) {
    if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function handleMessage(ws, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
    return;
  }

  switch (data.type) {
    case 'join':
      handleJoin(ws, data);
      break;
    case 'leave':
      removeClient(ws);
      ws.send(JSON.stringify({ type: 'left' }));
      break;
    case 'sync':
      handleSync(ws, data);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', error: 'Unknown message type' }));
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => handleMessage(ws, raw.toString()));

  ws.on('close', () => {
    removeClient(ws);
  });

  ws.on('error', () => {
    removeClient(ws);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      removeClient(ws);
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});

console.log(`Sync server listening on ws://localhost:${PORT}`);
