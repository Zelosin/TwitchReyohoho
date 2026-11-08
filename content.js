(() => {
  const ext = () => window.__RYH_EXT__ || {};

  if (window.__RYH_TWITCH_LOADED__) {
    if (ext().isExtensionContextValid?.()) {
      return;
    }
    document.getElementById('ryh-player-overlay')?.remove();
    document.getElementById('ryh-ext-reload-banner')?.remove();
  }
  window.__RYH_TWITCH_LOADED__ = true;

  async function sendRuntimeMessage(payload) {
    if (ext().safeRuntimeSendMessage) {
      return ext().safeRuntimeSendMessage(payload);
    }
    return chrome.runtime.sendMessage(payload);
  }

  async function storageGet(keys) {
    if (ext().safeStorageGet) {
      return ext().safeStorageGet(keys);
    }
    return chrome.storage.local.get(keys);
  }

  async function storageSet(items) {
    if (ext().safeStorageSet) {
      return ext().safeStorageSet(items);
    }
    return chrome.storage.local.set(items);
  }

  async function storageRemove(keys) {
    if (ext().safeStorageRemove) {
      return ext().safeStorageRemove(keys);
    }
    return chrome.storage.local.remove(keys);
  }

  const OVERLAY_ID = 'ryh-player-overlay';
  const PIH_LIVE_URL = 'https://suseqa.moe/live';

  const PLAYER_SELECTORS = [
    '[data-a-target="video-player"]',
    '[data-a-target="player-container"]',
    '#channel-player',
    '.persistent-player',
    '.video-player',
    'div[class*="video-player"]',
    'div[class*="persistent-player"]'
  ];

  const CHAT_ROOT_SELECTORS = [
    '.stream-chat',
    '[data-a-target="video-player-chat-room"]',
    '#chat-room',
    '.chat-scrollable-area',
    '[class*="chat-scrollable"]',
    '#seventv-message-container',
    '.seventv-chat-list',
    '.seventv-message-container'
  ];

  const MESSAGE_TEXT_SELECTORS = [
    '.text-token',
    '.text-fragment',
    '[data-a-target="chat-message-text"]'
  ];

  const EMOTE_NAME_SELECTORS = [
    // Ник в чате
    '[data-a-target="chat-message-username"]',
    '.chat-author__display-name',
    '[data-a-target="chat-message-mention"]',
    '.seventv-chat-user-username',
    // Название / ник канала (актуальная вёрстка Twitch)
    'h1.tw-title',
    '.home-header-sticky h1',
    '.channel-info-content h1',
    '#offline-channel-main-content h1',
    '#live-channel-stream-information h1',
    '[data-a-target="channel-header-channel-link"]',
    '[data-a-target="user-channel-header-item"]',
    '[data-test-selector="user-display-name"]',
    'div[class*="metadata-layout"] a[href^="/"] h1',
    'div[class*="metadata-layout"] a[href^="/"] p',
    'a[data-a-target="player-info-guest"]'
  ];

  const CHAT_URL_PATTERNS = [
    { type: 'film', service: 'reyohoho', pattern: /https?:\/\/(?:www\.)?reyohoho\.com\/films\/(\d+)/gi },
    {
      type: 'film',
      service: 'aprel',
      pattern: /https?:\/\/(?:www\.)?aprelteam\.gokino\.by\/((?:films|serials|mults|anime|nocategory)(?:\/[^/\s?#]+)*\/\d+-[^/\s?#]+)\.html/gi
    },
    {
      type: 'film',
      service: 'matrix',
      pattern: /https?:\/\/(?:www\.)?gokino\.by\/matrix\/search\.php\?(?:[^#\s]*&)?q=(\d+)/gi
    },
    {
      type: 'film',
      service: 'matrix',
      pattern: /https?:\/\/(?:www\.)?matrix\.gokino\.by\/\?(?:[^#\s]*&)?q=(\d+)/gi
    },
    {
      type: 'watchparty',
      pattern: /https?:\/\/(?:www\.)?watchparty\.me\/watch\/([a-z0-9-]+)/gi
    },
    {
      type: 'film',
      service: 'rutube',
      pattern: /https?:\/\/(?:www\.)?rutube\.ru\/(?:video|play\/embed)\/([a-f0-9]{32})\/?/gi
    }
  ];

  const RYH_SHORT_PATTERN = /\bryh-([a-z0-9-]+)\b/gi;
  const APREL_SHORT_PATTERN =
    /\bapr-((?:films|serials|mults|anime|nocategory)(?:--[a-z0-9-]+)+)\b/gi;
  const MATRIX_SHORT_PATTERN = /\bmtr-(\d{3,})\b/gi;
  const RUTUBE_SHORT_PATTERN =
    /\brtb-(?:([a-f0-9]{32})|([a-z0-9]{8,16})(?:-([a-f0-9]{32}))?)\b/gi;

  const CUSTOM_CHAT_EMOTES = [
    {
      names: ['Мартимор', 'Martimor', 'Марти', 'Marti'],
      src: 'icons/nothere/marti.png',
      alt: 'Марти'
    },
    {
      names: ['mrtmrPAT'],
      src: 'icons/nothere/mrtmrPAT.gif',
      alt: 'mrtmrPAT'
    }
  ];

  const CUSTOM_EMOTE_BOUNDARY = '(?<![A-Za-zА-Яа-яЁё0-9_])';
  const CUSTOM_EMOTE_BOUNDARY_END = '(?![A-Za-zА-Яа-яЁё0-9_])';

  let customEmotePattern = null;
  const customEmoteLookup = new Map();

  (function initCustomEmotePattern() {
    const names = [];

    CUSTOM_CHAT_EMOTES.forEach((emote) => {
      emote.names.forEach((name) => {
        customEmoteLookup.set(name.toLowerCase(), emote);
        names.push(name);
      });
    });

    names.sort((left, right) => right.length - left.length);
    const escapedNames = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    customEmotePattern = new RegExp(
      `${CUSTOM_EMOTE_BOUNDARY}(${escapedNames.join('|')})${CUSTOM_EMOTE_BOUNDARY_END}`,
      'gi'
    );
  })();

  const APREL_PATH_CATEGORIES = ['films', 'serials', 'mults', 'anime', 'nocategory'];

  const SERVICE_LABELS = {
    reyohoho: 'ReYohoho',
    aprel: 'Aprel Kino',
    matrix: 'Matrix',
    rutube: 'Rutube',
    pih: 'PIH'
  };

  function getServiceLabel(service) {
    return SERVICE_LABELS[service] || SERVICE_LABELS.reyohoho;
  }

  function resolveFilmService(filmId, service) {
    if (
      service === 'aprel' ||
      service === 'reyohoho' ||
      service === 'matrix' ||
      service === 'rutube' ||
      service === 'pih'
    ) {
      return service;
    }
    const id = String(filmId || '');
    if (/^[a-f0-9]{32}$/i.test(id)) {
      return 'rutube';
    }
    if (id.includes('/')) {
      return 'aprel';
    }
    return 'reyohoho';
  }

  function getDefaultFilmPageUrl(filmId, service) {
    const resolvedService = resolveFilmService(filmId, service);
    if (resolvedService === 'pih') {
      return PIH_LIVE_URL;
    }
    if (resolvedService === 'matrix') {
      const kpId = String(filmId || '').replace(/\D/g, '');
      return `https://gokino.by/matrix/search.php?q=${kpId}`;
    }
    if (resolvedService === 'aprel') {
      const path = String(filmId || '')
        .replace(/^https?:\/\/(?:www\.)?aprelteam\.gokino\.by\//i, '')
        .replace(/^\//, '')
        .replace(/\.html$/i, '');
      return `https://aprelteam.gokino.by/${path}.html`;
    }
    if (resolvedService === 'rutube') {
      const id = String(filmId || '').toLowerCase();
      return `https://rutube.ru/video/${id}/`;
    }
    return `https://reyohoho.com/films/${filmId}`;
  }

  function getRutubeEmbedUrl(videoId) {
    return `https://rutube.ru/play/embed/${String(videoId || '').toLowerCase()}`;
  }

  function normalizeRutubeVideoId(value) {
    const raw = String(value || '').trim();
    const fromUrl = raw.match(
      /rutube\.ru\/(?:video|play\/embed|shorts|live\/video|private\/video)\/([a-f0-9]{32})/i
    );
    const id = (fromUrl?.[1] || raw).toLowerCase();
    return /^[a-f0-9]{32}$/.test(id) ? id : '';
  }

  function aprelPathToShortLink(filmPath) {
    const normalized = String(filmPath || '')
      .replace(/^https?:\/\/(?:www\.)?aprelteam\.gokino\.by\//i, '')
      .replace(/^\//, '')
      .replace(/\.html$/i, '');
    return `apr-${normalized.replace(/\//g, '--')}`;
  }

  function aprelShortLinkToPath(token) {
    const parts = String(token || '').split('--');
    if (parts.length < 2 || !APREL_PATH_CATEGORIES.includes(parts[0])) {
      return null;
    }

    const lastPart = parts[parts.length - 1];
    if (!/^\d+-/.test(lastPart)) {
      return null;
    }

    return parts.join('/');
  }

  const chatObservedRoots = new WeakSet();
  let chatScanTimer = null;
  let chatScanInterval = null;

  let playerState = {
    active: false,
    mode: '',
    filmId: null,
    title: '',
    embedUrl: '',
    pageUrl: '',
    roomId: '',
    roomUrl: '',
    players: [],
    activePlayerId: '',
    syncEnabled: false,
    syncViewerCount: 0,
    rutubeQueue: [],
    rutubeRoomId: ''
  };

  let syncBridgeTimer = null;
  let applyingRemoteRutube = false;
  let lastRutubeViewerCount = 0;

  function isSyncSupportedMode(mode) {
    return mode === 'aprel' || mode === 'matrix' || mode === 'rutube';
  }

  function createRutubeRoomId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`.slice(0, 16);
  }

  function ensureRutubeRoomId() {
    if (playerState.mode === 'rutube' && playerState.rutubeRoomId) {
      return playerState.rutubeRoomId;
    }
    const roomId = createRutubeRoomId();
    playerState.rutubeRoomId = roomId;
    return roomId;
  }

  function getSyncFilmIdForMode(mode = playerState.mode) {
    if (mode === 'rutube') {
      return playerState.rutubeRoomId || '';
    }
    return playerState.filmId;
  }

  function encodeRutubeTitle(title) {
    return encodeURIComponent(String(title || 'Rutube').slice(0, 120));
  }

  function decodeRutubeTitle(value) {
    try {
      return decodeURIComponent(String(value || '')) || 'Rutube';
    } catch {
      return 'Rutube';
    }
  }

  function buildRutubeMediaEvent(videoId, title) {
    return `rutube_media:${videoId}:${encodeRutubeTitle(title)}`;
  }

  function buildRutubeQueueEvent(videoId, title) {
    return `rutube_queue:${videoId}:${encodeRutubeTitle(title)}`;
  }

  function buildRutubeStateEvent() {
    const current = normalizeRutubeVideoId(playerState.filmId) || '-';
    const queue = (playerState.rutubeQueue || [])
      .map((item) => normalizeRutubeVideoId(item.id))
      .filter(Boolean)
      .join(',');
    return `rutube_state:${current}:${queue}`;
  }

  async function broadcastRutubeSyncEvent(eventName) {
    if (!playerState.syncEnabled || playerState.mode !== 'rutube' || applyingRemoteRutube) {
      return { ok: false, skipped: true };
    }

    return sendRuntimeMessage({
      type: 'playerSyncRutubeEvent',
      event: eventName
    }).catch(() => ({ ok: false }));
  }

  async function broadcastRutubePlaylistState() {
    if (!playerState.syncEnabled || playerState.mode !== 'rutube') {
      return { ok: false, skipped: true };
    }
    if (!normalizeRutubeVideoId(playerState.filmId) && !(playerState.rutubeQueue || []).length) {
      return { ok: false, skipped: true };
    }
    return broadcastRutubeSyncEvent(buildRutubeStateEvent());
  }

  async function requestRutubePlaylistState() {
    if (!playerState.syncEnabled || playerState.mode !== 'rutube') {
      return { ok: false, skipped: true };
    }
    return broadcastRutubeSyncEvent('rutube_request_state');
  }

  async function pushRutubePlaybackToPeers() {
    if (!playerState.syncEnabled || playerState.mode !== 'rutube') {
      return { ok: false, skipped: true };
    }
    if (!normalizeRutubeVideoId(playerState.filmId)) {
      return { ok: false, skipped: true };
    }
    return sendRuntimeMessage({
      type: 'playerSyncBroadcastPlayback'
    }).catch(() => ({ ok: false }));
  }

  let rutubePushTimer = null;
  let initialPlaybackSyncTimers = [];

  function clearInitialPlaybackSyncTimers() {
    initialPlaybackSyncTimers.forEach((timerId) => clearTimeout(timerId));
    initialPlaybackSyncTimers = [];
  }

  function scheduleInitialPlaybackSync(videoId) {
    clearInitialPlaybackSyncTimers();
    if (!playerState.syncEnabled || playerState.mode !== 'rutube') {
      return;
    }

    const id = normalizeRutubeVideoId(videoId);
    if (!id) {
      return;
    }

    // Re-broadcast media/state so peers in an empty room that missed the
    // first WS burst still receive the new current video.
    const mediaTimerId = window.setTimeout(() => {
      if (
        playerState.mode !== 'rutube' ||
        !playerState.syncEnabled ||
        normalizeRutubeVideoId(playerState.filmId) !== id
      ) {
        return;
      }
      pushRutubeStateToPeers({ withPlayback: false }).catch(() => {});
    }, 1200);
    initialPlaybackSyncTimers.push(mediaTimerId);

    // Media sync goes over several WS "magic seek" chunks, then the peer
    // still needs time to mount the Rutube embed. Push playhead twice.
    [2800, 5000].forEach((delay) => {
      const timerId = window.setTimeout(() => {
        if (
          playerState.mode !== 'rutube' ||
          !playerState.syncEnabled ||
          normalizeRutubeVideoId(playerState.filmId) !== id
        ) {
          return;
        }
        pushRutubePlaybackToPeers().catch(() => {});
      }, delay);
      initialPlaybackSyncTimers.push(timerId);
    });
  }

  async function pushRutubeStateToPeers({ withPlayback = false } = {}) {
    if (!playerState.syncEnabled || playerState.mode !== 'rutube') {
      return { ok: false, skipped: true };
    }

    const videoId = normalizeRutubeVideoId(playerState.filmId);
    if (!videoId) {
      return { ok: false, skipped: true };
    }

    await broadcastRutubeSyncEvent(
      buildRutubeMediaEvent(videoId, playerState.title || 'Rutube')
    );
    await broadcastRutubeSyncEvent(buildRutubeStateEvent());

    if (!withPlayback) {
      return { ok: true };
    }

    // Give peers a moment to load the embed, then sync playhead once.
    window.setTimeout(() => {
      if (
        playerState.mode === 'rutube' &&
        playerState.syncEnabled &&
        normalizeRutubeVideoId(playerState.filmId) === videoId
      ) {
        pushRutubePlaybackToPeers().catch(() => {});
      }
    }, 1800);

    return { ok: true };
  }

  function schedulePushRutubeStateToPeers(options = {}) {
    if (rutubePushTimer) {
      clearTimeout(rutubePushTimer);
    }
    rutubePushTimer = window.setTimeout(() => {
      rutubePushTimer = null;
      pushRutubeStateToPeers(options).catch(() => {});
    }, 350);
  }

  function scheduleRutubeStateRequest() {
    if (playerState.mode !== 'rutube' || !playerState.syncEnabled) {
      return;
    }
    if (normalizeRutubeVideoId(playerState.filmId)) {
      return;
    }

    // Empty-room peers often miss the first media burst; retry a few times.
    [400, 1800, 4000].forEach((delay) => {
      window.setTimeout(() => {
        if (
          playerState.mode === 'rutube' &&
          playerState.syncEnabled &&
          !normalizeRutubeVideoId(playerState.filmId)
        ) {
          requestRutubePlaylistState().catch(() => {});
        }
      }, delay);
    });
  }

  function scheduleRutubePlaybackPull() {
    if (playerState.mode !== 'rutube' || !playerState.syncEnabled) {
      return;
    }
    requestRutubePlaylistState().catch(() => {});
    window.setTimeout(() => {
      if (playerState.mode === 'rutube' && playerState.syncEnabled) {
        requestRutubePlaylistState().catch(() => {});
      }
    }, 1600);
  }

  function updateSyncUi(overlay) {
    if (!overlay) {
      overlay = document.getElementById(OVERLAY_ID);
    }
    if (!overlay) {
      return;
    }

    const supported = isSyncSupportedMode(playerState.mode);
    const syncWrap = overlay.querySelector('.ryh-sync-wrap');
    const seekWrap = overlay.querySelector('.ryh-sync-seek-wrap');
    if (syncWrap) {
      syncWrap.classList.toggle('hidden', !supported);
    }
    if (seekWrap) {
      seekWrap.classList.toggle('hidden', !supported || !playerState.syncEnabled);
    }

    const checkbox = overlay.querySelector('.ryh-sync-checkbox');
    if (checkbox) {
      checkbox.checked = Boolean(playerState.syncEnabled);
    }

    const viewerEl = overlay.querySelector('.ryh-sync-viewers');
    if (viewerEl) {
      if (!supported || !playerState.syncEnabled) {
        viewerEl.textContent = '';
        viewerEl.classList.add('hidden');
      } else {
        const count = Number(playerState.syncViewerCount) || 0;
        viewerEl.textContent = count > 0 ? `${count} зрит.` : '';
        viewerEl.classList.toggle('hidden', count <= 0);
      }
    }
  }

  function scheduleSyncBridgeJoin() {
    schedulePlayerSyncResync();
  }

  function schedulePlayerSyncResync() {
    if (!playerState.syncEnabled || !isSyncSupportedMode(playerState.mode)) {
      return;
    }

    if (!getSyncFilmIdForMode()) {
      return;
    }

    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
    }

    const delay =
      playerState.mode === 'rutube' && !normalizeRutubeVideoId(playerState.filmId)
        ? 400
        : 1500;

    syncBridgeTimer = setTimeout(() => {
      syncBridgeTimer = null;
      rejoinPlayerSync().catch(() => {});
    }, delay);
  }

  async function joinPlayerSync() {
    if (!playerState.syncEnabled || !isSyncSupportedMode(playerState.mode)) {
      return { ok: false };
    }

    const syncFilmId = getSyncFilmIdForMode();
    if (!syncFilmId) {
      return { ok: false };
    }

    return sendRuntimeMessage({
      type: 'joinPlayerSync',
      service: playerState.mode,
      filmId: syncFilmId
    }).catch(() => ({ ok: false }));
  }

  async function rejoinPlayerSync() {
    if (!playerState.syncEnabled || !isSyncSupportedMode(playerState.mode)) {
      return { ok: false };
    }

    const syncFilmId = getSyncFilmIdForMode();
    if (!syncFilmId) {
      return { ok: false };
    }

    playerState.syncViewerCount = 0;
    updateSyncUi();

    return sendRuntimeMessage({
      type: 'rejoinPlayerSync',
      service: playerState.mode,
      filmId: syncFilmId
    }).catch(() => ({ ok: false }));
  }

  async function leavePlayerSync() {
    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
      syncBridgeTimer = null;
    }

    playerState.syncViewerCount = 0;
    return sendRuntimeMessage({ type: 'leavePlayerSync' }).catch(() => ({ ok: true }));
  }

  async function setPlayerSyncEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === playerState.syncEnabled) {
      updateSyncUi();
      return { ok: true };
    }

    playerState.syncEnabled = next;
    playerState.syncViewerCount = 0;
    await storageSet({ playerState, playerSyncEnabled: next });
    updateSyncUi();

    if (next) {
      await joinPlayerSync();
    } else {
      await leavePlayerSync();
    }

    return { ok: true };
  }

  async function handleSyncSeekDelta(delta) {
    if (!playerState.syncEnabled) {
      return;
    }

    await sendRuntimeMessage({
      type: 'playerSyncSeekDelta',
      delta: Number(delta)
    }).catch(() => {});
  }

  function bindSyncControls(overlay) {
    const syncWrap = overlay.querySelector('.ryh-sync-wrap');
    if (!syncWrap) {
      return;
    }

    const checkbox = overlay.querySelector('.ryh-sync-checkbox');
    checkbox?.addEventListener('change', () => {
      setPlayerSyncEnabled(checkbox.checked).catch(() => {});
    });

    overlay.querySelector('.ryh-seek-back')?.addEventListener('click', (event) => {
      event.stopPropagation();
      handleSyncSeekDelta(-10).catch(() => {});
    });

    overlay.querySelector('.ryh-seek-forward')?.addEventListener('click', (event) => {
      event.stopPropagation();
      handleSyncSeekDelta(10).catch(() => {});
    });

    updateSyncUi(overlay);
  }

  function updateRutubeQueueUi(overlay) {
    if (!overlay) {
      overlay = document.getElementById(OVERLAY_ID);
    }
    if (!overlay) {
      return;
    }

    const skipBtn = overlay.querySelector('.ryh-rutube-skip-btn');
    const queueBadge = overlay.querySelector('.ryh-rutube-queue-count');
    const queueLen = Array.isArray(playerState.rutubeQueue)
      ? playerState.rutubeQueue.length
      : 0;

    if (skipBtn) {
      skipBtn.disabled = queueLen <= 0;
      skipBtn.classList.toggle('hidden', playerState.mode !== 'rutube');
      skipBtn.title =
        queueLen > 0 ? `Следующее видео (${queueLen} в очереди)` : 'Очередь пуста';
    }

    if (queueBadge) {
      queueBadge.textContent = queueLen > 0 ? String(queueLen) : '';
      queueBadge.classList.toggle('hidden', queueLen <= 0);
    }
  }

  async function loadRutubeById(
    videoId,
    title = '',
    { keepQueue = true, broadcast = true } = {}
  ) {
    const id = normalizeRutubeVideoId(videoId);
    if (!id) {
      return { ok: false, error: 'Некорректный ID Rutube' };
    }

    clearInitialPlaybackSyncTimers();

    const roomId =
      playerState.mode === 'rutube' && playerState.rutubeRoomId
        ? playerState.rutubeRoomId
        : createRutubeRoomId();

    const preservedQueue =
      keepQueue && playerState.mode === 'rutube'
        ? (playerState.rutubeQueue || []).filter((item) => item.id !== id)
        : [];

    const embedUrl = getRutubeEmbedUrl(id);
    const pageUrl = getDefaultFilmPageUrl(id, 'rutube');
    const videoTitle = title || 'Rutube';
    const result = await replacePlayer({
      filmId: id,
      embedUrl,
      title: videoTitle,
      pageUrl,
      players: [
        {
          id: 'rutube',
          name: 'Rutube',
          type: 'iframe',
          url: embedUrl
        }
      ],
      activePlayerId: 'rutube',
      service: 'rutube',
      rutubeRoomId: roomId,
      rutubeQueue: preservedQueue
    });

    if (result?.ok) {
      playerState.rutubeRoomId = roomId;
      playerState.rutubeQueue = preservedQueue;
      await storageSet({ playerState });
      updateRutubeQueueUi();

      if (broadcast) {
        await broadcastRutubeSyncEvent(buildRutubeMediaEvent(id, videoTitle));
        await broadcastRutubePlaylistState();
        // Align playhead after peers have time to switch media.
        scheduleInitialPlaybackSync(id);
      }
    }

    return result;
  }

  async function addToRutubeQueue({ videoId, title, videoUrl }) {
    const id = normalizeRutubeVideoId(videoId || videoUrl);
    if (!id) {
      return { ok: false, error: 'Некорректный ID Rutube' };
    }

    const videoTitle = String(title || '').trim() || 'Rutube';

    if (!playerState.active || playerState.mode !== 'rutube') {
      const result = await loadRutubeById(id, videoTitle, {
        keepQueue: false,
        broadcast: true
      });
      if (!result?.ok) {
        return result;
      }
      return { ok: true, started: true, filmId: id, queueLength: 0 };
    }

    ensureRutubeRoomId();

    if (!playerState.filmId) {
      const result = await loadRutubeById(id, videoTitle, {
        keepQueue: true,
        broadcast: true
      });
      if (!result?.ok) {
        return result;
      }
      return {
        ok: true,
        started: true,
        filmId: id,
        queueLength: (playerState.rutubeQueue || []).length
      };
    }

    if (String(playerState.filmId).toLowerCase() === id) {
      return {
        ok: true,
        alreadyPlaying: true,
        filmId: id,
        queueLength: (playerState.rutubeQueue || []).length
      };
    }

    const queue = Array.isArray(playerState.rutubeQueue)
      ? [...playerState.rutubeQueue]
      : [];
    if (queue.some((item) => item.id === id)) {
      return {
        ok: true,
        alreadyQueued: true,
        filmId: playerState.filmId,
        queueLength: queue.length
      };
    }

    queue.push({ id, title: videoTitle });
    playerState.rutubeQueue = queue;
    await storageSet({ playerState });
    updateRutubeQueueUi();
    await broadcastRutubeSyncEvent(buildRutubeQueueEvent(id, videoTitle));
    await broadcastRutubePlaylistState();

    return {
      ok: true,
      queued: true,
      filmId: playerState.filmId,
      queueLength: queue.length
    };
  }

  async function skipRutubeQueue() {
    if (playerState.mode !== 'rutube') {
      return { ok: false, error: 'Rutube не активен' };
    }

    const queue = Array.isArray(playerState.rutubeQueue)
      ? [...playerState.rutubeQueue]
      : [];
    if (!queue.length) {
      return { ok: false, error: 'Очередь пуста' };
    }

    const next = queue.shift();
    playerState.rutubeQueue = queue;
    await storageSet({ playerState });

    return loadRutubeById(next.id, next.title, { keepQueue: true, broadcast: true });
  }

  function initSyncMessageListener() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data;
      if (data?.source !== 'ryh-player-sync') {
        return;
      }

      if (data.type === 'sync-viewers') {
        const count = Number(data.detail?.count) || 0;
        const grew = count > lastRutubeViewerCount;
        playerState.syncViewerCount = count;
        updateSyncUi();

        if (
          grew &&
          playerState.mode === 'rutube' &&
          playerState.syncEnabled &&
          normalizeRutubeVideoId(playerState.filmId)
        ) {
          schedulePushRutubeStateToPeers({ withPlayback: true });
        }
        lastRutubeViewerCount = count;
        return;
      }

      if (data.type === 'sync-connected') {
        if (playerState.mode === 'rutube' && playerState.syncEnabled) {
          if (normalizeRutubeVideoId(playerState.filmId)) {
            // Share playlist only — avoid play/pause fight on join.
            schedulePushRutubeStateToPeers({ withPlayback: false });
          } else {
            scheduleRutubeStateRequest();
          }
        }
        return;
      }

      if (data.type === 'remote-rutube') {
        handleRemoteRutubeEvent(data.detail?.event || '').catch(() => {});
        return;
      }

      if (data.type === 'sync-disconnected') {
        if (playerState.syncEnabled) {
          playerState.syncViewerCount = 0;
          lastRutubeViewerCount = 0;
          updateSyncUi();
        }
      }
    });
  }

  let pendingRemoteRutubeEvents = [];

  async function handleRemoteRutubeEvent(rawEvent) {
    if (playerState.mode !== 'rutube') {
      return;
    }

    const eventName = String(rawEvent || '');
    if (!eventName.startsWith('rutube_')) {
      return;
    }

    if (applyingRemoteRutube) {
      pendingRemoteRutubeEvents.push(eventName);
      return;
    }

    applyingRemoteRutube = true;
    try {
      await processRemoteRutubeEvent(eventName);
    } finally {
      applyingRemoteRutube = false;
      const next = pendingRemoteRutubeEvents.shift();
      if (next) {
        handleRemoteRutubeEvent(next).catch(() => {});
      }
    }
  }

  async function processRemoteRutubeEvent(eventName) {
    if (eventName === 'rutube_request_state' || eventName.startsWith('rutube_request_state')) {
      if (normalizeRutubeVideoId(playerState.filmId)) {
        schedulePushRutubeStateToPeers({ withPlayback: true });
      }
      return;
    }

    if (eventName.startsWith('rutube_media:')) {
      const parts = eventName.split(':');
      const videoId = normalizeRutubeVideoId(parts[1] || '');
      const title = decodeRutubeTitle(parts.slice(2).join(':'));
      if (!videoId) {
        return;
      }
      if (normalizeRutubeVideoId(playerState.filmId) === videoId) {
        return;
      }

      await loadRutubeById(videoId, title, { keepQueue: true, broadcast: false });
      return;
    }

    if (eventName.startsWith('rutube_queue:')) {
      const parts = eventName.split(':');
      const videoId = normalizeRutubeVideoId(parts[1] || '');
      const title = decodeRutubeTitle(parts.slice(2).join(':'));
      if (!videoId) {
        return;
      }
      if (normalizeRutubeVideoId(playerState.filmId) === videoId) {
        return;
      }

      // Empty room: first "queue" item should become the current video.
      if (!normalizeRutubeVideoId(playerState.filmId)) {
        await loadRutubeById(videoId, title, { keepQueue: true, broadcast: false });
        return;
      }

      const queue = Array.isArray(playerState.rutubeQueue)
        ? [...playerState.rutubeQueue]
        : [];
      if (queue.some((item) => item.id === videoId)) {
        return;
      }

      queue.push({ id: videoId, title });
      playerState.rutubeQueue = queue;
      await storageSet({ playerState });
      updateRutubeQueueUi();
      return;
    }

    if (eventName.startsWith('rutube_state:')) {
      const parts = eventName.split(':');
      const currentId = parts[1] === '-' ? '' : normalizeRutubeVideoId(parts[1] || '');
      const queueIds = String(parts[2] || '')
        .split(',')
        .map((id) => normalizeRutubeVideoId(id))
        .filter(Boolean);

      if (!currentId) {
        if (normalizeRutubeVideoId(playerState.filmId)) {
          return;
        }
        if (queueIds.length) {
          // Empty room received playlist without current — start the first item.
          const [firstId, ...restIds] = queueIds;
          playerState.rutubeQueue = restIds.map((id) => ({ id, title: 'Rutube' }));
          await loadRutubeById(firstId, 'Rutube', {
            keepQueue: true,
            broadcast: false
          });
        }
        return;
      }

      playerState.rutubeQueue = queueIds
        .filter((id) => id !== currentId)
        .map((id) => ({ id, title: 'Rutube' }));

      if (normalizeRutubeVideoId(playerState.filmId) !== currentId) {
        await loadRutubeById(currentId, 'Rutube', {
          keepQueue: true,
          broadcast: false
        });
      } else {
        await storageSet({ playerState });
        updateRutubeQueueUi();
      }
    }
  }

  let sourceMenuCloser = null;
  let vibixIsolationTimers = [];
  let vibixFilmReloadCount = 0;
  let vibixIsolationDone = false;
  let playerSourceLoadGeneration = 0;
  let restoreLoadToken = 0;

  function cancelPendingPlayerLoads() {
    restoreLoadToken += 1;
    playerSourceLoadGeneration += 1;
    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
      syncBridgeTimer = null;
    }
  }

  function isGokinoPageUrl(url) {
    try {
      const parsed = new URL(String(url || '').trim(), 'https://aprelteam.gokino.by');
      const host = parsed.hostname.toLowerCase();
      if (!host.includes('gokino.by')) {
        return false;
      }

      const path = parsed.pathname.toLowerCase();
      if (/\/matrix\/search\.php/i.test(path)) {
        return true;
      }

      if (host === 'matrix.gokino.by' && parsed.searchParams.has('q')) {
        return true;
      }

      return (
        /\.html$/i.test(path) &&
        /\/(films|serials|mults|anime|nocategory)\//i.test(path)
      );
    } catch {
      return false;
    }
  }

  function pickEmbeddableUrl(...candidates) {
    for (const candidate of candidates) {
      const url = String(candidate || '').trim();
      if (!url || url === 'about:blank') {
        continue;
      }
      if (isGokinoPageUrl(url)) {
        continue;
      }
      return url;
    }
    return '';
  }

  function resolveIframeSrc(player, filmPageUrl, fallbackEmbedUrl, allPlayers = []) {
    const playerList = Array.isArray(allPlayers) ? allPlayers : [];
    const embedUrl = pickEmbeddableUrl(
      player?.url,
      fallbackEmbedUrl,
      ...playerList.map((item) => item?.url)
    );

    if (embedUrl) {
      return embedUrl;
    }

    if (filmPageUrl && !isGokinoPageUrl(filmPageUrl)) {
      return filmPageUrl;
    }

    return '';
  }
  const VIBIX_ISOLATION_FALLBACK_MS = 4000;
  const VIBIX_MAX_FILM_RELOADS = 2;

  function clearVibixIsolationTimers() {
    vibixIsolationTimers.forEach((timerId) => clearTimeout(timerId));
    vibixIsolationTimers = [];
  }

  function resetVibixFilmReloadCount() {
    vibixFilmReloadCount = 0;
  }

  function markVibixIsolationDone() {
    vibixIsolationDone = true;
    clearVibixIsolationTimers();
  }

  function requestVibixIsolation() {
    if (vibixIsolationDone) {
      return;
    }
    sendRuntimeMessage({ type: 'isolateVibixFrame' }).catch(() => {});
  }

  function scheduleVibixIsolation() {
    clearVibixIsolationTimers();
    vibixIsolationDone = false;
    requestVibixIsolation();
    vibixIsolationTimers.push(
      setTimeout(() => {
        if (!vibixIsolationDone) {
          requestVibixIsolation();
        }
      }, VIBIX_ISOLATION_FALLBACK_MS)
    );
  }

  function retryVibixFilmPage() {
    if (vibixFilmReloadCount >= VIBIX_MAX_FILM_RELOADS) {
      return;
    }

    const overlay = document.getElementById(OVERLAY_ID);
    const iframe = overlay?.querySelector('.ryh-player-frame');
    if (!iframe || !playerState.filmId) {
      return;
    }

    const activePlayer = playerState.players?.find(
      (player) => player.id === playerState.activePlayerId
    );
    const isVibixActive =
      playerState.activePlayerId === 'vibix' ||
      activePlayer?.id === 'vibix' ||
      activePlayer?.type === 'vibix';

    if (!isVibixActive) {
      return;
    }

    vibixFilmReloadCount += 1;
    const filmPageUrl =
      playerState.pageUrl || getDefaultFilmPageUrl(playerState.filmId, playerState.mode);
    const reloadUrl = new URL(filmPageUrl);
    reloadUrl.searchParams.set('_ryh', String(Date.now()));

    clearVibixIsolationTimers();
    iframe.onload = () => {
      resetVibixFilmReloadCount();
      scheduleVibixIsolation();
      scheduleAutoJoinWatchParty();
    };
    iframe.src = reloadUrl.toString();
    scheduleVibixIsolation();
  }

  let watchPartyJoinedFilmId = null;
  let watchPartyJoinTimer = null;
  let youtubeTitlePollTimer = null;

  function initVibixRetryListener() {
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'ryh-vibix-isolated') {
        markVibixIsolationDone();
        scheduleAutoJoinWatchParty();
        return;
      }
      if (event.data?.type !== 'ryh-vibix-retry') {
        return;
      }
      retryVibixFilmPage();
    });
  }

  function scheduleAutoJoinWatchParty() {
    if (watchPartyJoinTimer) {
      clearTimeout(watchPartyJoinTimer);
    }
    watchPartyJoinTimer = setTimeout(() => {
      watchPartyJoinTimer = null;
      autoJoinWatchParty().catch(() => {});
    }, 800);
  }

  async function autoJoinWatchParty() {
    if (!playerState.filmId || !isVibixPlayer(playerState.activePlayerId)) {
      return;
    }

    if (watchPartyJoinedFilmId === playerState.filmId) {
      return;
    }

    const response = await sendRuntimeMessage({
        type: 'joinWatchParty',
        filmId: playerState.filmId
      }).catch(() => null);

    if (response?.ok && response.connected !== false) {
      watchPartyJoinedFilmId = playerState.filmId;
    }
  }

  async function disconnectWatchParty() {
    if (watchPartyJoinTimer) {
      clearTimeout(watchPartyJoinTimer);
      watchPartyJoinTimer = null;
    }

    watchPartyJoinedFilmId = null;
    await sendRuntimeMessage({ type: 'leaveWatchParty' }).catch(() => {});
  }

  function isVibixPlayer(playerOrId) {
    if (!playerOrId) {
      return false;
    }

    if (typeof playerOrId === 'string') {
      if (playerOrId === 'vibix') {
        return true;
      }
      const player = playerState.players?.find((item) => item.id === playerOrId);
      return player?.id === 'vibix' || player?.type === 'vibix';
    }

    return playerOrId.id === 'vibix' || playerOrId.type === 'vibix';
  }

  async function applyPlayerSource(
    overlay,
    player,
    filmId,
    pageUrl,
    service,
    fallbackEmbedUrl,
    allPlayers = []
  ) {
    const iframe = overlay.querySelector('.ryh-player-frame');
    if (!iframe) {
      return;
    }

    const filmService = resolveFilmService(filmId, service || playerState.mode);
    const filmPageUrl = pageUrl || getDefaultFilmPageUrl(filmId, filmService);
    const isVibix = filmService === 'reyohoho' && isVibixPlayer(player);
    const loadGeneration = ++playerSourceLoadGeneration;
    const iframeSrc = resolveIframeSrc(player, filmPageUrl, fallbackEmbedUrl, allPlayers);

    if (!iframeSrc || iframeSrc === 'about:blank') {
      throw new Error('Не найден embed URL плеера');
    }

    if (!isVibix) {
      await disconnectWatchParty();
    }

    if (isSyncSupportedMode(filmService) && !playerState.syncEnabled) {
      await leavePlayerSync();
    }

    if (loadGeneration !== playerSourceLoadGeneration) {
      throw new Error('Загрузка плеера отменена');
    }

    clearVibixIsolationTimers();
    resetVibixFilmReloadCount();
    vibixIsolationDone = false;
    iframe.classList.remove('ryh-hidden');
    iframe.removeAttribute('sandbox');

    if (isVibix) {
      watchPartyJoinedFilmId = null;
      iframe.onload = () => {
        scheduleVibixIsolation();
        scheduleAutoJoinWatchParty();
      };
      iframe.src = filmPageUrl;
      return;
    }

    iframe.onload = null;
    iframe.src = iframeSrc;

    if (isSyncSupportedMode(filmService) && playerState.syncEnabled) {
      iframe.onload = () => {
        if (loadGeneration !== playerSourceLoadGeneration) {
          return;
        }
        schedulePlayerSyncResync();
      };
    }
  }

  function getStoredEmbedRef(player, filmId, pageUrl, service, allPlayers = []) {
    const filmService = resolveFilmService(filmId, service || playerState.mode);
    if (filmService === 'reyohoho' && (player.id === 'vibix' || player.type === 'vibix')) {
      return pageUrl || getDefaultFilmPageUrl(filmId, filmService);
    }

    const embedUrl = pickEmbeddableUrl(
      player?.url,
      ...allPlayers.map((item) => item?.url)
    );
    if (embedUrl) {
      return embedUrl;
    }

    const page = pageUrl || getDefaultFilmPageUrl(filmId, filmService);
    return isGokinoPageUrl(page) ? '' : page;
  }

  function deepQuerySelector(root, selector) {
    if (!root) {
      return null;
    }

    try {
      const direct = root.querySelector(selector);
      if (direct) {
        return direct;
      }
    } catch {
      /* ignore invalid selectors in some roots */
    }

    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const element of elements) {
      if (element.shadowRoot) {
        const nested = deepQuerySelector(element.shadowRoot, selector);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  function findVideoElement() {
    const direct = document.querySelector('video');
    if (direct) {
      return direct;
    }
    return deepQuerySelector(document, 'video');
  }

  function findPlayerContainer() {
    for (const selector of PLAYER_SELECTORS) {
      const element = deepQuerySelector(document, selector);
      if (element) {
        return element;
      }
    }

    const video = findVideoElement();
    if (!video) {
      return null;
    }

    const preferred = [
      video.closest('[data-a-target="video-player"]'),
      video.closest('#channel-player'),
      video.closest('[class*="video-player"]'),
      video.closest('[class*="persistent-player"]'),
      video.closest('[class*="player"]')
    ].find(Boolean);

    if (preferred) {
      return preferred;
    }

    let node = video.parentElement;
    for (let depth = 0; depth < 10 && node; depth += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 320 && rect.height >= 180) {
        return node;
      }
      node = node.parentElement;
    }

    return video.parentElement;
  }

  function pauseTwitchVideo() {
    const videos = [];
    document.querySelectorAll('video').forEach((video) => videos.push(video));

    const deepVideo = deepQuerySelector(document, 'video');
    if (deepVideo && !videos.includes(deepVideo)) {
      videos.push(deepVideo);
    }

    videos.forEach((video) => {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
    });
  }

  function stopYoutubeTitlePolling() {
    if (youtubeTitlePollTimer) {
      clearInterval(youtubeTitlePollTimer);
      youtubeTitlePollTimer = null;
    }
  }

  function updateYoutubeVideoTitle(title) {
    const nextTitle = String(title || '').trim();
    if (!nextTitle || playerState.mode !== 'youtube') {
      return false;
    }

    if (playerState.title === nextTitle) {
      return true;
    }

    playerState.title = nextTitle;
    const titleEl = document.getElementById(OVERLAY_ID)?.querySelector('.ryh-player-title');
    if (titleEl) {
      titleEl.textContent = nextTitle;
    }

    storageSet({ playerState }).catch(() => {});
    return true;
  }

  async function refreshYoutubeVideoTitle() {
    if (!playerState.active || playerState.mode !== 'youtube') {
      return playerState.title || '';
    }

    const response = await sendRuntimeMessage({ type: 'getWatchpartyVideoTitle' });
    if (response?.ok && response.title) {
      updateYoutubeVideoTitle(response.title);
      return response.title;
    }

    return playerState.title || '';
  }

  function startYoutubeTitlePolling() {
    stopYoutubeTitlePolling();
    refreshYoutubeVideoTitle().catch(() => {});
    youtubeTitlePollTimer = setInterval(() => {
      refreshYoutubeVideoTitle().catch(() => {});
    }, 4000);
  }

  function removeOverlay() {
    clearVibixIsolationTimers();
    resetVibixFilmReloadCount();
    vibixIsolationDone = false;
    stopYoutubeTitlePolling();
    if (sourceMenuCloser) {
      document.removeEventListener('click', sourceMenuCloser);
      sourceMenuCloser = null;
    }
    const existing = document.getElementById(OVERLAY_ID);
    existing?._ryhControlsCleanup?.();
    existing?.remove();
  }

  function bindWatchpartyIframe(overlay) {
    const iframe = overlay.querySelector('.ryh-watchparty-frame');
    if (!iframe) {
      return;
    }

    const scheduleLayoutReset = () => {
      window.setTimeout(() => {
        sendRuntimeMessage({ type: 'resetWatchpartyLayout' }).catch(() => {});
        const showControls = overlay.classList.contains('ryh-wp-controls-visible');
        sendRuntimeMessage({
          type: 'setWatchpartyControlsVisible',
          visible: showControls
        }).catch(() => {});
        refreshYoutubeVideoTitle().catch(() => {});
      }, 1800);
    };

    iframe.addEventListener('load', scheduleLayoutReset);
    if (iframe.contentDocument?.readyState === 'complete') {
      scheduleLayoutReset();
    }

    startYoutubeTitlePolling();
  }

  async function skipWatchpartyVideo() {
    const response = await sendRuntimeMessage({ type: 'skipWatchPartyVideo' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Не удалось пропустить видео');
    }

    window.setTimeout(() => {
      refreshYoutubeVideoTitle().catch(() => {});
    }, 1200);

    return response;
  }

  function createYoutubeOverlay(container, { title, roomUrl }) {
    removeOverlay();

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'ryh-player-overlay ryh-youtube-overlay';
    overlay.innerHTML = `
      <div class="ryh-player-bar">
        <span class="ryh-player-title">${escapeHtml(title)}</span>
        <div class="ryh-bar-actions">
          <button type="button" class="ryh-wp-skip-btn" title="Следующее видео" aria-label="Следующее видео">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M5 5v14h2V5H5zm12 0v14l7-7-7-7z"/>
            </svg>
          </button>
          <button type="button" class="ryh-restore-btn" title="Вернуть Twitch" aria-label="Вернуть Twitch"><span aria-hidden="true">×</span></button>
        </div>
      </div>
      <div class="ryh-player-body">
        <div class="ryh-watchparty-crop">
          <div class="ryh-watchparty-stretch">
            <iframe
              class="ryh-watchparty-frame"
              src="${escapeHtml(roomUrl)}"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowfullscreen
              referrerpolicy="origin"
            ></iframe>
          </div>
        </div>
      </div>
    `;

    overlay.querySelector('.ryh-wp-skip-btn').addEventListener('click', () => {
      skipWatchpartyVideo().catch((error) => {
        const titleEl = overlay.querySelector('.ryh-player-title');
        if (!titleEl) {
          return;
        }
        const previous = titleEl.textContent;
        titleEl.textContent = error?.message || 'Не удалось пропустить';
        window.setTimeout(() => {
          if (titleEl.textContent === (error?.message || 'Не удалось пропустить')) {
            titleEl.textContent = previous;
          }
        }, 2500);
      });
    });

    overlay.querySelector('.ryh-restore-btn').addEventListener('click', () => {
      restorePlayer();
    });

    bindWatchpartyIframe(overlay);
    bindAutoHideControls(overlay);
    container.appendChild(overlay);
    pauseTwitchVideo();
  }

  function bindSourceMenu(overlay, players, activePlayerId, filmId, pageUrl) {
    const sourceBtn = overlay.querySelector('.ryh-source-btn');
    const sourceMenu = overlay.querySelector('.ryh-source-menu');

    if (!sourceBtn || !sourceMenu) {
      return;
    }

    sourceBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      overlay.classList.add('ryh-controls-visible');
      const isOpen = !sourceMenu.classList.contains('hidden');
      sourceMenu.classList.toggle('hidden', isOpen);
      sourceBtn.setAttribute('aria-expanded', String(!isOpen));
    });

    sourceMenu.querySelectorAll('.ryh-source-option').forEach((option) => {
      option.addEventListener('click', async (event) => {
        event.stopPropagation();
        const player = players.find((item) => item.id === option.dataset.playerId);
        if (!player) {
          return;
        }

        await applyPlayerSource(
          overlay,
          player,
          filmId,
          pageUrl,
          playerState.mode,
          getStoredEmbedRef(player, filmId, pageUrl, playerState.mode, players),
          players
        );
        sourceBtn.textContent = `${player.name} ▾`;
        sourceMenu.querySelectorAll('.ryh-source-option').forEach((item) => {
          item.classList.toggle('active', item.dataset.playerId === player.id);
        });
        sourceMenu.classList.add('hidden');
        sourceBtn.setAttribute('aria-expanded', 'false');

        playerState.activePlayerId = player.id;
        playerState.embedUrl = getStoredEmbedRef(player, filmId, pageUrl, playerState.mode);
        storageSet({ playerState });

        if (isVibixPlayer(player)) {
          watchPartyJoinedFilmId = null;
        }
      });
    });

    sourceMenuCloser = (event) => {
      if (!overlay.contains(event.target)) {
        sourceMenu.classList.add('hidden');
        sourceBtn.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('click', sourceMenuCloser);
  }

  function bindAutoHideControls(overlay) {
    const playerBody = overlay.querySelector('.ryh-player-body');
    const isYoutube = overlay.classList.contains('ryh-youtube-overlay');

    const showOverlayControls = () => {
      overlay.classList.add('ryh-controls-visible');
    };

    const hideOverlayControls = () => {
      const sourceMenu = overlay.querySelector('.ryh-source-menu');
      if (sourceMenu && !sourceMenu.classList.contains('hidden')) {
        return;
      }
      overlay.classList.remove('ryh-controls-visible');
    };

    const syncWatchpartyControlsVisibility = (visible) => {
      sendRuntimeMessage({
        type: 'setWatchpartyControlsVisible',
        visible: Boolean(visible)
      }).catch(() => {});
    };

    const showWpControls = () => {
      overlay.classList.add('ryh-wp-controls-visible');
      syncWatchpartyControlsVisibility(true);
    };

    const hideWpControls = () => {
      overlay.classList.remove('ryh-wp-controls-visible');
      syncWatchpartyControlsVisibility(false);
    };

    const isInsideRect = (clientX, clientY, element) => {
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    };

    const syncWpControls = (clientX, clientY) => {
      if (!isYoutube || !playerBody) {
        return;
      }
      if (isInsideRect(clientX, clientY, playerBody)) {
        showWpControls();
      } else {
        hideWpControls();
      }
    };

    const onPointerMove = (event) => {
      if (isInsideRect(event.clientX, event.clientY, overlay)) {
        showOverlayControls();
      } else {
        hideOverlayControls();
      }
      syncWpControls(event.clientX, event.clientY);
    };

    const onPlayerPointerEnter = () => {
      if (isYoutube) {
        showWpControls();
      }
    };

    const onPlayerPointerLeave = (event) => {
      if (!isYoutube) {
        return;
      }
      syncWpControls(event.clientX, event.clientY);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
    playerBody?.addEventListener('pointerenter', onPlayerPointerEnter);
    playerBody?.addEventListener('pointerleave', onPlayerPointerLeave);

    overlay._ryhControlsCleanup = () => {
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      playerBody?.removeEventListener('pointerenter', onPlayerPointerEnter);
      playerBody?.removeEventListener('pointerleave', onPlayerPointerLeave);
    };
  }

  async function createOverlay(
    container,
    { title, players, activePlayerId, filmId, pageUrl, service, fallbackEmbedUrl }
  ) {
    removeOverlay();

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const activePlayer = players.find((item) => item.id === activePlayerId) || players[0];
    const hasMultipleSources = players.length > 1;
    const filmService = service || playerState.mode;
    const showSyncUi = isSyncSupportedMode(filmService);
    const showRutubeQueueUi = filmService === 'rutube';

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'ryh-player-overlay';
    overlay.innerHTML = `
      <div class="ryh-player-bar">
        <span class="ryh-player-title">${escapeHtml(title)}</span>
        <div class="ryh-bar-actions">
          ${
            showSyncUi
              ? `<div class="ryh-sync-wrap">
                  <label class="ryh-sync-toggle" title="Синхронизировать перемотку с другими зрителями">
                    <input type="checkbox" class="ryh-sync-checkbox" />
                    <span class="ryh-sync-label">Синхр.</span>
                  </label>
                  <span class="ryh-sync-viewers hidden"></span>
                  <div class="ryh-sync-seek-wrap hidden">
                    <button type="button" class="ryh-seek-btn ryh-seek-back" title="−10 сек">−10</button>
                    <button type="button" class="ryh-seek-btn ryh-seek-forward" title="+10 сек">+10</button>
                  </div>
                </div>`
              : ''
          }
          ${
            showRutubeQueueUi
              ? `<button type="button" class="ryh-rutube-skip-btn" title="Следующее видео" aria-label="Следующее видео">
                  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M5 5v14h2V5H5zm12 0v14l7-7-7-7z"/>
                  </svg>
                  <span class="ryh-rutube-queue-count hidden"></span>
                </button>`
              : ''
          }
          ${
            hasMultipleSources
              ? `<div class="ryh-source-wrap">
                  <button type="button" class="ryh-source-btn" aria-expanded="false">
                    ${escapeHtml(activePlayer.name)} ▾
                  </button>
                  <div class="ryh-source-menu hidden">
                    ${players
                      .map(
                        (player) => `
                      <button
                        type="button"
                        class="ryh-source-option${player.id === activePlayer.id ? ' active' : ''}"
                        data-player-id="${escapeHtml(player.id)}"
                      >
                        ${escapeHtml(player.name)}
                      </button>`
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }
          <button type="button" class="ryh-restore-btn" title="Вернуть Twitch" aria-label="Вернуть Twitch"><span aria-hidden="true">×</span></button>
        </div>
      </div>
      <div class="ryh-player-body${filmService === 'pih' ? ' ryh-clip-scroll' : ''}">
        <iframe
          class="ryh-player-frame"
          src="about:blank"
          scrolling="no"
          allowfullscreen
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          referrerpolicy="origin"
        ></iframe>
      </div>
    `;

    overlay.querySelector('.ryh-restore-btn').addEventListener('click', () => {
      restorePlayer();
    });

    if (showSyncUi) {
      bindSyncControls(overlay);
    }

    if (showRutubeQueueUi) {
      overlay.querySelector('.ryh-rutube-skip-btn')?.addEventListener('click', () => {
        skipRutubeQueue().catch((error) => {
          const titleEl = overlay.querySelector('.ryh-player-title');
          if (!titleEl) {
            return;
          }
          const previous = titleEl.textContent;
          titleEl.textContent = error?.message || 'Очередь пуста';
          window.setTimeout(() => {
            if (titleEl.textContent === (error?.message || 'Очередь пуста')) {
              titleEl.textContent = previous;
            }
          }, 2500);
        });
      });
      updateRutubeQueueUi(overlay);
    }

    if (hasMultipleSources) {
      bindSourceMenu(overlay, players, activePlayer.id, filmId, pageUrl);
    }

    bindAutoHideControls(overlay);

    container.appendChild(overlay);
    pauseTwitchVideo();

    try {
      await applyPlayerSource(
        overlay,
        activePlayer,
        filmId,
        pageUrl,
        service,
        fallbackEmbedUrl,
        players
      );
    } catch (error) {
      removeOverlay();
      throw error;
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function replaceYoutubePlayer({ roomId, roomUrl, title }) {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) {
      return { ok: false, error: 'ID комнаты не получен' };
    }

    let container = findPlayerContainer();
    if (!container) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      container = findPlayerContainer();
    }

    if (!container) {
      return { ok: false, error: 'Плеер Twitch не найден. Обновите страницу.' };
    }

    await disconnectWatchParty();

    if (playerState.mode === 'youtube') {
      await sendRuntimeMessage({ type: 'clearYoutubeRoom' }).catch(() => {});
    }

    const resolvedRoomUrl =
      roomUrl || `https://www.watchparty.me/watch/${normalizedRoomId.replace(/^\//, '')}`;

    createYoutubeOverlay(container, {
      title: title || 'YouTube',
      roomUrl: resolvedRoomUrl
    });

    playerState = {
      active: true,
      mode: 'youtube',
      filmId: null,
      title: title && !/^YouTube\s·/i.test(title) ? title : 'YouTube',
      embedUrl: resolvedRoomUrl,
      pageUrl: resolvedRoomUrl,
      roomId: normalizedRoomId,
      roomUrl: resolvedRoomUrl,
      players: [],
      activePlayerId: ''
    };

    const youtubeRoomState = {
      roomId: normalizedRoomId,
      roomUrl: resolvedRoomUrl,
      slug: normalizedRoomId.replace(/^\//, '')
    };

    await storageSet({
      playerState,
      youtubeRoomState
    });

    return { ok: true, title: playerState.title, roomUrl: resolvedRoomUrl };
  }

  async function createRutubePlaceholderOverlay(container) {
    removeOverlay();

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'ryh-player-overlay ryh-rutube-overlay';
    overlay.innerHTML = `
      <div class="ryh-player-bar">
        <span class="ryh-player-title">Rutube</span>
        <div class="ryh-bar-actions">
          <div class="ryh-sync-wrap">
            <label class="ryh-sync-toggle" title="Синхронизировать перемотку с другими зрителями">
              <input type="checkbox" class="ryh-sync-checkbox" />
              <span class="ryh-sync-label">Синхр.</span>
            </label>
            <span class="ryh-sync-viewers hidden"></span>
            <div class="ryh-sync-seek-wrap hidden">
              <button type="button" class="ryh-seek-btn ryh-seek-back" title="−10 сек">−10</button>
              <button type="button" class="ryh-seek-btn ryh-seek-forward" title="+10 сек">+10</button>
            </div>
          </div>
          <button type="button" class="ryh-rutube-skip-btn hidden" title="Следующее видео" aria-label="Следующее видео">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M5 5v14h2V5H5zm12 0v14l7-7-7-7z"/>
            </svg>
            <span class="ryh-rutube-queue-count hidden"></span>
          </button>
          <button type="button" class="ryh-restore-btn" title="Вернуть Twitch" aria-label="Вернуть Twitch"><span aria-hidden="true">×</span></button>
        </div>
      </div>
      <div class="ryh-player-body">
        <div class="ryh-rutube-placeholder">
          <div class="ryh-rutube-placeholder-title">Rutube</div>
          <div class="ryh-rutube-placeholder-text">
            Откройте видео на rutube.ru и нажмите «В очередь»
          </div>
        </div>
        <iframe
          class="ryh-player-frame ryh-hidden"
          src="about:blank"
          allowfullscreen
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          referrerpolicy="origin"
        ></iframe>
      </div>
    `;

    overlay.querySelector('.ryh-restore-btn').addEventListener('click', () => {
      restorePlayer();
    });

    bindSyncControls(overlay);
    overlay.querySelector('.ryh-rutube-skip-btn')?.addEventListener('click', () => {
      skipRutubeQueue().catch(() => {});
    });
    bindAutoHideControls(overlay);
    container.appendChild(overlay);
    pauseTwitchVideo();
    updateRutubeQueueUi(overlay);
  }

  async function replaceRutubePlayer({ rutubeRoomId, filmId } = {}) {
    let container = findPlayerContainer();
    if (!container) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      container = findPlayerContainer();
    }

    if (!container) {
      return { ok: false, error: 'Плеер Twitch не найден. Обновите страницу.' };
    }

    cancelPendingPlayerLoads();
    await disconnectWatchParty();

    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
      syncBridgeTimer = null;
    }
    await leavePlayerSync();

    if (playerState.mode === 'youtube') {
      await sendRuntimeMessage({ type: 'clearYoutubeRoom' }).catch(() => {});
      await storageRemove('youtubeRoomState');
    }

    const joiningExistingRoom = Boolean(String(rutubeRoomId || '').trim());
    const storedSync = await storageGet(['playerSyncEnabled']);
    const syncEnabled = joiningExistingRoom
      ? true
      : typeof storedSync.playerSyncEnabled === 'boolean'
        ? storedSync.playerSyncEnabled
        : true;

    const roomId = String(rutubeRoomId || '').trim() || createRutubeRoomId();
    const joinVideoId = normalizeRutubeVideoId(filmId);

    await createRutubePlaceholderOverlay(container);

    playerState = {
      active: true,
      mode: 'rutube',
      filmId: null,
      title: 'Rutube',
      embedUrl: '',
      pageUrl: '',
      roomId: '',
      roomUrl: '',
      players: [],
      activePlayerId: '',
      syncEnabled,
      syncViewerCount: 0,
      rutubeQueue: [],
      rutubeRoomId: roomId
    };
    lastRutubeViewerCount = 0;

    await storageSet({ playerState, playerSyncEnabled: syncEnabled });
    updateSyncUi();

    if (syncEnabled) {
      scheduleSyncBridgeJoin();
    }

    if (joinVideoId) {
      await loadRutubeById(joinVideoId, 'Rutube', {
        keepQueue: false,
        broadcast: false
      });
      scheduleRutubePlaybackPull();
    }

    if (joiningExistingRoom && syncEnabled) {
      if (!joinVideoId) {
        scheduleRutubeStateRequest();
      } else {
        scheduleRutubePlaybackPull();
      }
    }

    return {
      ok: true,
      title: 'Rutube',
      filmId: joinVideoId || null,
      syncEnabled,
      rutubeRoomId: roomId
    };
  }

  async function replacePlayer({
    filmId,
    embedUrl,
    title,
    pageUrl,
    players,
    activePlayerId,
    service,
    rutubeRoomId,
    rutubeQueue
  }) {
    cancelPendingPlayerLoads();

    const filmService = resolveFilmService(filmId, service);
    const sources = Array.isArray(players) && players.length ? players : [];
    if (!sources.length && !embedUrl) {
      return { ok: false, error: 'URL плеера не получен' };
    }

    if (!sources.length && embedUrl) {
      sources.push({
        id: 'default',
        name: getServiceLabel(filmService),
        type: 'iframe',
        url: embedUrl
      });
    }

    const activeId = activePlayerId || sources[0].id;
    const filmPageUrl = pageUrl || getDefaultFilmPageUrl(filmId, filmService);
    const activeSource = sources.find((item) => item.id === activeId) || sources[0];
    const resolvedUrl =
      pickEmbeddableUrl(embedUrl, activeSource?.url, ...sources.map((item) => item?.url)) ||
      getStoredEmbedRef(activeSource, filmId, filmPageUrl, filmService, sources);

    if (!resolvedUrl) {
      return { ok: false, error: 'Не найден embed URL плеера' };
    }

    let container = findPlayerContainer();
    if (!container) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      container = findPlayerContainer();
    }

    if (!container) {
      return { ok: false, error: 'Плеер Twitch не найден. Обновите страницу.' };
    }

    if (watchPartyJoinedFilmId && watchPartyJoinedFilmId !== filmId) {
      await disconnectWatchParty();
    }

    if (!isVibixPlayer(activeId)) {
      await disconnectWatchParty();
    }

    const nextRutubeRoomId =
      filmService === 'rutube'
        ? String(rutubeRoomId || playerState.rutubeRoomId || '').trim() || createRutubeRoomId()
        : '';
    const keepRutubeSync =
      filmService === 'rutube' &&
      playerState.mode === 'rutube' &&
      playerState.syncEnabled &&
      Boolean(playerState.rutubeRoomId) &&
      playerState.rutubeRoomId === nextRutubeRoomId;

    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
      syncBridgeTimer = null;
    }
    if (!keepRutubeSync) {
      await leavePlayerSync();
    }

    const storedSync = await storageGet(['playerSyncEnabled']);
    const syncEnabled =
      isSyncSupportedMode(filmService) &&
      (typeof storedSync.playerSyncEnabled === 'boolean'
        ? storedSync.playerSyncEnabled
        : Boolean(playerState.syncEnabled));

    playerState.syncEnabled = syncEnabled;

    const nextQueue =
      filmService === 'rutube'
        ? Array.isArray(rutubeQueue)
          ? rutubeQueue
          : playerState.rutubeQueue || []
        : [];

    try {
      await createOverlay(container, {
        title: title || `Фильм ${filmId}`,
        players: sources,
        activePlayerId: activeId,
        filmId,
        pageUrl: filmPageUrl,
        service: filmService,
        fallbackEmbedUrl: resolvedUrl
      });
    } catch (error) {
      return { ok: false, error: error?.message || 'Не удалось загрузить плеер' };
    }

    playerState = {
      active: true,
      mode: filmService,
      filmId,
      title: title || `Фильм ${filmId}`,
      embedUrl: resolvedUrl,
      pageUrl: filmPageUrl,
      roomId: '',
      roomUrl: '',
      players: sources,
      activePlayerId: activeId,
      syncEnabled,
      syncViewerCount: keepRutubeSync ? playerState.syncViewerCount : 0,
      rutubeQueue: nextQueue,
      rutubeRoomId: nextRutubeRoomId
    };

    await storageSet({ playerState, playerSyncEnabled: syncEnabled });

    if (playerState.syncEnabled) {
      if (keepRutubeSync) {
        window.setTimeout(() => {
          sendRuntimeMessage({ type: 'ensurePlayerBridgeInTab' }).catch(() => {});
        }, 700);
        window.setTimeout(() => {
          sendRuntimeMessage({ type: 'ensurePlayerBridgeInTab' }).catch(() => {});
        }, 1800);
      } else {
        scheduleSyncBridgeJoin();
      }
    }

    return { ok: true, title: playerState.title };
  }

  async function restorePlayer() {
    const wasYoutube = playerState.mode === 'youtube';

    if (!wasYoutube) {
      await disconnectWatchParty();
    }

    await leavePlayerSync();

    removeOverlay();
    playerState = {
      active: false,
      mode: '',
      filmId: null,
      title: '',
      embedUrl: '',
      pageUrl: '',
      roomId: '',
      roomUrl: '',
      players: [],
      activePlayerId: '',
      syncEnabled: false,
      syncViewerCount: 0,
      rutubeQueue: [],
      rutubeRoomId: ''
    };
    lastRutubeViewerCount = 0;
    await storageSet({ playerState });
    if (wasYoutube) {
      await storageRemove('youtubeRoomState');
      await sendRuntimeMessage({ type: 'clearYoutubeRoom' }).catch(() => {});
    }
    return { ok: true };
  }

  async function loadFilmById(filmId, service) {
    cancelPendingPlayerLoads();

    const resolvedService = resolveFilmService(filmId, service);
    if (resolvedService === 'rutube') {
      return loadRutubeById(filmId, '', { keepQueue: false });
    }

    const response = await sendRuntimeMessage({
      type: 'getPlayerEmbed',
      filmId,
      service: resolvedService
    });

    if (!response?.ok) {
      return { ok: false, error: response?.error || 'Ошибка загрузки фильма' };
    }

    const data = response.data || {};
    const sources = Array.isArray(data.players) ? data.players : [];
    const embedUrl =
      pickEmbeddableUrl(data.embedUrl, ...sources.map((item) => item?.url)) || data.embedUrl;

    return replacePlayer({
      filmId: data.filmId || filmId,
      embedUrl,
      title: data.title,
      pageUrl: data.pageUrl,
      players: sources,
      activePlayerId: data.activePlayerId,
      service: data.service || resolvedService
    });
  }

  async function loadWatchPartyRoom(slug) {
    const normalizedSlug = String(slug || '')
      .trim()
      .replace(/^\//, '');
    if (!/^[a-z0-9-]+$/i.test(normalizedSlug)) {
      return { ok: false, error: 'Некорректная комната WatchParty' };
    }

    return replaceYoutubePlayer({
      roomId: `/${normalizedSlug}`,
      roomUrl: `https://www.watchparty.me/watch/${normalizedSlug}`
    });
  }

  function deepQueryAll(root, selector) {
    const results = [];
    if (!root) {
      return results;
    }

    try {
      root.querySelectorAll(selector).forEach((element) => results.push(element));
    } catch {
      /* ignore invalid selectors in some roots */
    }

    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const element of elements) {
      if (element.shadowRoot) {
        deepQueryAll(element.shadowRoot, selector).forEach((item) => results.push(item));
      }
    }

    return results;
  }

  function scheduleChatScan() {
    if (chatScanTimer) {
      return;
    }
    chatScanTimer = setTimeout(() => {
      chatScanTimer = null;
      scanAllChatLinks();
    }, 120);
  }

  function getChatRoots() {
    const roots = new Set();
    CHAT_ROOT_SELECTORS.forEach((selector) => {
      deepQueryAll(document.body, selector).forEach((element) => roots.add(element));
    });
    if (!roots.size) {
      roots.add(document.body);
    }
    return [...roots];
  }

  function walkTextNodes(root, visit) {
    if (!root) {
      return;
    }

    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.TEXT_NODE) {
        visit(node);
        continue;
      }

      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        continue;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') {
          continue;
        }
      }

      const children = node.childNodes;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }

      if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
        stack.push(node.shadowRoot);
      }
    }
  }

  function initChatClickDelegation() {
    document.addEventListener(
      'click',
      async (event) => {
        const target = event.target.closest('.ryh-chat-link');
        if (!target) {
          return;
        }

        const filmId = target.dataset.filmId;
        const filmService = target.dataset.filmService;
        const roomSlug = target.dataset.roomSlug;
        const rutubeRoomId = target.dataset.rutubeRoomId;
        if (!filmId && !roomSlug && !rutubeRoomId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (target.classList.contains('ryh-chat-link-loading')) {
          return;
        }

        target.classList.add('ryh-chat-link-loading');
        const linkFilmId = filmId;
        const linkService = filmService || resolveFilmService(filmId);
        const linkRutubeRoomId = rutubeRoomId;
        window.setTimeout(async () => {
          try {
            if (linkRutubeRoomId) {
              const result = await replaceRutubePlayer({
                rutubeRoomId: linkRutubeRoomId,
                filmId:
                  linkService === 'rutube' ? normalizeRutubeVideoId(linkFilmId) : ''
              });
              if (!result?.ok) {
                console.warn('[RYH] Не удалось войти в Rutube комнату:', result?.error);
              }
            } else if (linkFilmId) {
              const result = await loadFilmById(linkFilmId, linkService);
              if (!result?.ok) {
                console.warn('[RYH] Не удалось загрузить фильм:', result?.error);
              }
            } else {
              await loadWatchPartyRoom(roomSlug);
            }
          } catch (error) {
            console.warn('[RYH] Ошибка загрузки из чата:', error);
          } finally {
            target.classList.remove('ryh-chat-link-loading');
          }
        }, 0);
      },
      true
    );
  }

  function markReyohohoAnchors(root) {
    deepQueryAll(root, 'a[href*="reyohoho.com/films/"]').forEach((anchor) => {
      if (anchor.classList.contains('ryh-chat-link')) {
        return;
      }

      const match = anchor.href.match(/\/films\/(\d+)/);
      if (!match) {
        return;
      }

      anchor.classList.add('ryh-chat-link');
      anchor.dataset.filmId = match[1];
      anchor.dataset.filmService = 'reyohoho';
      anchor.title = `Смотреть на ReYohoho (ID: ${match[1]})`;
    });
  }

  function markAprelAnchors(root) {
    deepQueryAll(root, 'a[href*="aprelteam.gokino.by/"]').forEach((anchor) => {
      if (anchor.classList.contains('ryh-chat-link')) {
        return;
      }

      const match = anchor.href.match(
        /aprelteam\.gokino\.by\/((?:films|serials|mults|anime|nocategory)(?:\/[^/?#]+)*\/\d+-[^/?#]+)\.html/i
      );
      if (!match) {
        return;
      }

      anchor.classList.add('ryh-chat-link');
      anchor.dataset.filmId = match[1];
      anchor.dataset.filmService = 'aprel';
      anchor.title = `Смотреть на Aprel Kino (${match[1]})`;
    });
  }

  function markMatrixAnchors(root) {
    deepQueryAll(
      root,
      'a[href*="gokino.by/matrix/search.php"], a[href*="matrix.gokino.by/?q="], a[href*="matrix.gokino.by?"]'
    ).forEach((anchor) => {
      if (anchor.classList.contains('ryh-chat-link')) {
        return;
      }

      const match = anchor.href.match(/[?&]q=(\d{3,})/i);
      if (!match) {
        return;
      }

      anchor.classList.add('ryh-chat-link');
      anchor.dataset.filmId = match[1];
      anchor.dataset.filmService = 'matrix';
      anchor.title = `Смотреть на Matrix (KP ${match[1]})`;
    });
  }

  function markRutubeAnchors(root) {
    deepQueryAll(
      root,
      'a[href*="rutube.ru/video/"], a[href*="rutube.ru/play/embed/"]'
    ).forEach((anchor) => {
      if (anchor.classList.contains('ryh-chat-link')) {
        return;
      }

      const videoId = normalizeRutubeVideoId(anchor.href);
      if (!videoId) {
        return;
      }

      anchor.classList.add('ryh-chat-link');
      anchor.dataset.filmId = videoId;
      anchor.dataset.filmService = 'rutube';
      anchor.title = `Смотреть на Rutube (${videoId.slice(0, 8)}…)`;
    });
  }

  function parseRyhShortLink(match) {
    const token = match[1];
    if (/^\d+$/.test(token)) {
      return {
        type: 'film',
        service: 'reyohoho',
        fullMatch: match[0],
        index: match.index,
        filmId: token,
        slug: null
      };
    }

    if (/[a-z]/i.test(token)) {
      return {
        type: 'watchparty',
        fullMatch: match[0],
        index: match.index,
        filmId: null,
        slug: token.toLowerCase()
      };
    }

    return null;
  }

  function parseMatrixShortLink(match) {
    const kpId = match[1];
    return {
      type: 'film',
      service: 'matrix',
      fullMatch: match[0],
      index: match.index,
      filmId: kpId,
      slug: null
    };
  }

  function parseRutubeShortLink(match) {
    const bareVideoId = String(match[1] || '').toLowerCase();
    const roomToken = String(match[2] || '').toLowerCase();
    const roomVideoId = String(match[3] || '').toLowerCase();

    if (/^[a-f0-9]{32}$/.test(bareVideoId)) {
      return {
        type: 'film',
        service: 'rutube',
        fullMatch: match[0],
        index: match.index,
        filmId: bareVideoId,
        slug: null,
        rutubeRoomId: null
      };
    }

    if (!/^[a-z0-9]{8,16}$/.test(roomToken)) {
      return null;
    }

    return {
      type: 'rutube_room',
      service: 'rutube',
      fullMatch: match[0],
      index: match.index,
      filmId: /^[a-f0-9]{32}$/.test(roomVideoId) ? roomVideoId : null,
      slug: roomToken,
      rutubeRoomId: roomToken
    };
  }

  function parseAprelShortLink(match) {
    const path = aprelShortLinkToPath(match[1]);
    if (!path) {
      return null;
    }

    return {
      type: 'film',
      service: 'aprel',
      fullMatch: match[0],
      index: match.index,
      filmId: path,
      slug: null
    };
  }

  function extractChatLinkFromText(text) {
    if (!text) {
      return null;
    }

    let best = null;

    for (const { type, service, pattern } of CHAT_URL_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (!match) {
        continue;
      }

      const item = {
        type,
        service: service || (type === 'film' ? 'reyohoho' : ''),
        fullMatch: match[0],
        index: match.index,
        filmId: type === 'film' ? match[1] : null,
        slug: type === 'watchparty' ? match[1].toLowerCase() : null
      };

      if (!best || item.index < best.index) {
        best = item;
      }
    }

    RYH_SHORT_PATTERN.lastIndex = 0;
    const ryhMatch = RYH_SHORT_PATTERN.exec(text);
    if (ryhMatch) {
      const item = parseRyhShortLink(ryhMatch);
      if (item && (!best || item.index < best.index)) {
        best = item;
      }
    }

    APREL_SHORT_PATTERN.lastIndex = 0;
    const aprelMatch = APREL_SHORT_PATTERN.exec(text);
    if (aprelMatch) {
      const item = parseAprelShortLink(aprelMatch);
      if (item && (!best || item.index < best.index)) {
        best = item;
      }
    }

    MATRIX_SHORT_PATTERN.lastIndex = 0;
    const matrixMatch = MATRIX_SHORT_PATTERN.exec(text);
    if (matrixMatch) {
      const item = parseMatrixShortLink(matrixMatch);
      if (item && (!best || item.index < best.index)) {
        best = item;
      }
    }

    RUTUBE_SHORT_PATTERN.lastIndex = 0;
    const rutubeMatch = RUTUBE_SHORT_PATTERN.exec(text);
    if (rutubeMatch) {
      const item = parseRutubeShortLink(rutubeMatch);
      if (item && (!best || item.index < best.index)) {
        best = item;
      }
    }

    return best;
  }

  function extractCustomEmoteFromText(text) {
    if (!text || !customEmotePattern) {
      return null;
    }

    customEmotePattern.lastIndex = 0;
    const match = customEmotePattern.exec(text);
    if (!match) {
      return null;
    }

    const fullMatch = match[1];
    const emote = customEmoteLookup.get(fullMatch.toLowerCase());
    if (!emote) {
      return null;
    }

    return {
      fullMatch,
      index: match.index,
      src: emote.src,
      alt: emote.alt || fullMatch
    };
  }

  function markElementAsChatLink(element, linkInfo) {
    if (!element || element.classList.contains('ryh-chat-link')) {
      return;
    }

    element.classList.add('ryh-chat-link');
    element.setAttribute('role', 'link');

    if (linkInfo.type === 'film') {
      element.dataset.filmId = linkInfo.filmId;
      element.dataset.filmService = linkInfo.service || 'reyohoho';
      element.title = `Смотреть на ${getServiceLabel(linkInfo.service || 'reyohoho')} (${linkInfo.filmId})`;
      return;
    }

    if (linkInfo.type === 'rutube_room') {
      element.dataset.rutubeRoomId = linkInfo.rutubeRoomId || linkInfo.slug;
      if (linkInfo.filmId) {
        element.dataset.filmId = linkInfo.filmId;
        element.dataset.filmService = 'rutube';
      }
      element.title = `Присоединиться к Rutube (${linkInfo.rutubeRoomId || linkInfo.slug})`;
      return;
    }

    element.dataset.roomSlug = linkInfo.slug;
    element.title = `Присоединиться к WatchParty (${linkInfo.slug})`;
  }

  function markElementAsWatchPartyLink(element, slug) {
    markElementAsChatLink(element, { type: 'watchparty', slug });
  }

  function markChatMessagesByOriginalText(root) {
    deepQueryAll(
      root,
      '.chat-line__message[data-original-text], .seventv-chat-message-container[data-original-text]'
    ).forEach((container) => {
      if (container.querySelector('.ryh-chat-link')) {
        return;
      }

      const extracted = extractChatLinkFromText(container.getAttribute('data-original-text'));
      if (!extracted) {
        return;
      }

      for (const selector of MESSAGE_TEXT_SELECTORS) {
        const target = container.querySelector(selector);
        if (target?.textContent?.includes(extracted.fullMatch)) {
          markElementAsChatLink(target, extracted);
          return;
        }
      }
    });
  }

  function markWatchpartyAnchors(root) {
    deepQueryAll(root, 'a[href*="watchparty.me/watch/"]').forEach((anchor) => {
      if (anchor.classList.contains('ryh-chat-link')) {
        return;
      }

      const match = anchor.href.match(/watchparty\.me\/watch\/([a-z0-9-]+)/i);
      if (!match) {
        return;
      }

      markElementAsWatchPartyLink(anchor, match[1]);
    });
  }

  function scanAllChatLinks() {
    getChatRoots().forEach((root) => {
      markReyohohoAnchors(root);
      markAprelAnchors(root);
      markMatrixAnchors(root);
      markRutubeAnchors(root);
      markWatchpartyAnchors(root);
      markChatMessagesByOriginalText(root);

      walkTextNodes(root, (textNode) => {
        if (!isLinkableTextNode(textNode)) {
          return;
        }

        const text = textNode.textContent;
        if (!text) {
          return;
        }

        const extracted = extractChatLinkFromText(text);
        if (extracted) {
          wrapLinkInTextNode(textNode, extracted);
          return;
        }

        if (!isEmoteableTextNode(textNode)) {
          return;
        }

        const emote = extractCustomEmoteFromText(text);
        if (emote) {
          wrapEmoteInTextNode(textNode, emote);
        }
      });
    });

    // Ники в чате и название канала — вне обычного обхода сообщений
    scanEmoteNameTargets(document.body);
  }
  function attachChatObservers(element) {
    if (!(element instanceof Element)) {
      return;
    }

    if (element.shadowRoot) {
      observeChatRoot(element.shadowRoot);
    }

    element.querySelectorAll('*').forEach((child) => {
      if (child.shadowRoot) {
        observeChatRoot(child.shadowRoot);
      }
    });
  }

  function observeChatRoot(root) {
    if (!root || chatObservedRoots.has(root)) {
      return;
    }

    chatObservedRoots.add(root);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            attachChatObservers(node);
          }
        });
      }
      scheduleChatScan();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });

    scheduleChatScan();
  }

  function isLinkableTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) {
      return false;
    }
    if (parent.closest('.ryh-chat-link')) {
      return false;
    }
    if (parent.closest('textarea, input, [contenteditable="true"]')) {
      return false;
    }
    if (parent.closest('[data-a-target="chat-input"], [data-a-target="chat-input-text"]')) {
      return false;
    }
    return true;
  }

  function isEmoteableTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) {
      return false;
    }
    if (parent.closest('.ryh-chat-emote, .ryh-channel-emote, img')) {
      return false;
    }
    return true;
  }

  function wrapLinkInTextNode(textNode, linkInfo) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest('.ryh-chat-link')) {
      return;
    }

    const text = textNode.textContent;
    const index = text.indexOf(linkInfo.fullMatch);
    if (index === -1) {
      return;
    }

    const before = text.slice(0, index);
    const after = text.slice(index + linkInfo.fullMatch.length);

    const link = document.createElement('span');
    link.className = 'ryh-chat-link';
    link.textContent = linkInfo.fullMatch;
    link.setAttribute('role', 'link');

    if (linkInfo.type === 'film') {
      link.dataset.filmId = linkInfo.filmId;
      link.dataset.filmService = linkInfo.service || 'reyohoho';
      link.title = `Смотреть на ${getServiceLabel(linkInfo.service || 'reyohoho')} (${linkInfo.filmId})`;
    } else if (linkInfo.type === 'rutube_room') {
      link.dataset.rutubeRoomId = linkInfo.rutubeRoomId || linkInfo.slug;
      if (linkInfo.filmId) {
        link.dataset.filmId = linkInfo.filmId;
        link.dataset.filmService = 'rutube';
      }
      link.title = `Присоединиться к Rutube (${linkInfo.rutubeRoomId || linkInfo.slug})`;
    } else {
      link.dataset.roomSlug = linkInfo.slug;
      link.title = `Присоединиться к WatchParty (${linkInfo.slug})`;
    }

    const fragment = document.createDocumentFragment();
    if (before) {
      fragment.appendChild(document.createTextNode(before));
    }
    fragment.appendChild(link);
    if (after) {
      fragment.appendChild(document.createTextNode(after));
    }

    parent.replaceChild(fragment, textNode);
  }

  function wrapEmoteInTextNode(textNode, emoteInfo, emoteClassName = 'ryh-chat-emote') {
    const parent = textNode.parentElement;
    if (!parent || parent.closest('.ryh-chat-emote, .ryh-channel-emote, img, .ryh-chat-link')) {
      return;
    }

    const text = textNode.textContent;
    const index = text.indexOf(emoteInfo.fullMatch, emoteInfo.index);
    if (index === -1) {
      return;
    }

    const before = text.slice(0, index);
    const after = text.slice(index + emoteInfo.fullMatch.length);

    const img = document.createElement('img');
    img.className = `${emoteClassName} chat-line__message--emote`;
    img.src = chrome.runtime.getURL(emoteInfo.src);
    img.alt = emoteInfo.alt;
    img.title = emoteInfo.fullMatch;

    const fragment = document.createDocumentFragment();
    if (before) {
      fragment.appendChild(document.createTextNode(before));
    }
    fragment.appendChild(img);
    if (after) {
      fragment.appendChild(document.createTextNode(after));
    }

    parent.replaceChild(fragment, textNode);
  }

  function isChannelNameElement(element) {
    return !element.closest(
      '.stream-chat, [data-a-target="video-player-chat-room"], #chat-room, .chat-scrollable-area, .seventv-chat-list, .seventv-message-container, [data-a-target="chat-message-username"], .chat-author__display-name, [data-a-target="chat-message-mention"]'
    );
  }

  function applyChannelNameEmote(element, emote) {
    if (!element || !emote) {
      return false;
    }

    const host = element.parentElement || element;
    let img =
      (element.nextElementSibling?.classList?.contains('ryh-channel-emote')
        ? element.nextElementSibling
        : null) ||
      host.querySelector(':scope > .ryh-channel-emote');

    if (!img) {
      img = document.createElement('img');
      img.className = 'ryh-channel-emote';
      img.src = chrome.runtime.getURL(emote.src);
      img.alt = emote.alt;
      img.title = emote.fullMatch || emote.alt;
      // Sibling рядом с h1 — React может перезаписать textContent h1, но sibling останется
      element.insertAdjacentElement('afterend', img);
    } else {
      img.src = chrome.runtime.getURL(emote.src);
      img.alt = emote.alt;
      img.title = emote.fullMatch || emote.alt;
      if (img.previousElementSibling !== element) {
        element.insertAdjacentElement('afterend', img);
      }
    }

    // На всякий случай убираем дубли в том же родителе
    host.querySelectorAll(':scope > .ryh-channel-emote').forEach((node) => {
      if (node !== img) {
        node.remove();
      }
    });

    element.classList.add('ryh-emote-hidden-text');
    element.setAttribute('data-ryh-emote-name', emote.fullMatch || emote.alt);
    element.setAttribute('aria-hidden', 'true');
    // Inline !important — на случай, если styled-components перебьют класс
    element.style.setProperty('position', 'absolute', 'important');
    element.style.setProperty('width', '0', 'important');
    element.style.setProperty('height', '0', 'important');
    element.style.setProperty('overflow', 'hidden', 'important');
    element.style.setProperty('opacity', '0', 'important');
    element.style.setProperty('font-size', '0', 'important');
    element.style.setProperty('line-height', '0', 'important');
    element.style.setProperty('margin', '0', 'important');
    element.style.setProperty('padding', '0', 'important');
    return true;
  }

  function scanEmoteNameTargets(root = document.body) {
    if (!root) {
      return;
    }

    const seen = new Set();

    EMOTE_NAME_SELECTORS.forEach((selector) => {
      deepQueryAll(root, selector).forEach((element) => {
        if (seen.has(element)) {
          return;
        }
        seen.add(element);

        const text = String(element.textContent || '').trim();
        if (!text) {
          return;
        }

        const emote = extractCustomEmoteFromText(text);
        if (!emote) {
          return;
        }

        // Для названия канала целиком (Martimor) — прячем текст и ставим img рядом,
        // иначе React Twitch сразу откатывает замену text node.
        if (isChannelNameElement(element) && text === emote.fullMatch) {
          applyChannelNameEmote(element, emote);
          return;
        }

        if (element.querySelector('.ryh-chat-emote, .ryh-channel-emote')) {
          return;
        }

        const emoteClassName = isChannelNameElement(element)
          ? 'ryh-channel-emote'
          : 'ryh-chat-emote';

        walkTextNodes(element, (textNode) => {
          if (!isEmoteableTextNode(textNode)) {
            return;
          }

          const nodeEmote = extractCustomEmoteFromText(textNode.textContent);
          if (nodeEmote) {
            wrapEmoteInTextNode(textNode, nodeEmote, emoteClassName);
          }
        });
      });
    });
  }

  function insertTextIntoTwitchChat(text) {
    const value = String(text || '');
    if (!value) {
      return false;
    }

    // Мост в MAIN world (shadow-open.js): attribute + Event, без CustomEvent.detail.
    document.documentElement.setAttribute('data-ryh-insert-chat', value);
    document.documentElement.dispatchEvent(new Event('ryh-insert-chat-text'));
    return true;
  }

  const RYH_FAVICON_ATTR = 'data-ryh-favicon';
  let ryhFaviconActiveSrc = '';
  let ryhFaviconObserver = null;
  let ryhTitlePatched = false;
  let ryhOriginalTitle = '';

  function getTwitchChannelLogin() {
    const parts = String(location.pathname || '')
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
    if (!parts.length) {
      return '';
    }

    // /popout/martimor/chat  или  /moderator/martimor/...
    if (/^(popout|moderator|embed)$/i.test(parts[0]) && parts[1]) {
      return parts[1].toLowerCase();
    }

    const path = parts[0];
    if (
      /^(directory|videos|downloads|jobs|privacy|products|search|settings|subs|turbo|wallet|inventory|drops|prime|p)$/i.test(
        path
      )
    ) {
      return '';
    }
    return path.toLowerCase();
  }

  function findChannelFaviconEmote() {
    const login = getTwitchChannelLogin();
    if (login && customEmoteLookup.has(login)) {
      return customEmoteLookup.get(login);
    }

    const title = String(document.title || '');
    // "Martimor - Twitch" или "Martimor - Chat - Twitch"
    for (const [name, emote] of customEmoteLookup.entries()) {
      if (new RegExp(`(^|[\\s\\-_|])${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}([\\s\\-_|]|$)`, 'i').test(title)) {
        return emote;
      }
    }

    const heading = document.querySelector(
      'h1.tw-title, .home-header-sticky h1, .channel-info-content h1, #live-channel-stream-information h1'
    );
    const headingText = heading?.textContent?.trim();
    if (headingText && customEmoteLookup.has(headingText.toLowerCase())) {
      return customEmoteLookup.get(headingText.toLowerCase());
    }

    return null;
  }

  function stripEmoteNamesFromTitle(title, emote) {
    let next = String(title || '');
    const names = [...(emote?.names || []), emote?.alt, emote?.fullMatch].filter(Boolean);
    names
      .sort((left, right) => String(right).length - String(left).length)
      .forEach((name) => {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        next = next.replace(new RegExp(escaped, 'gi'), '');
      });

    next = next
      .replace(/\s*[-|•·]\s*/g, ' - ')
      .replace(/^\s*[-|•·]\s*|\s*[-|•·]\s*$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return next || 'Twitch';
  }

  function applyChannelTabTitle(emote) {
    const current = String(document.title || '');
    const cleaned = stripEmoteNamesFromTitle(current, emote);
    if (current === cleaned) {
      return;
    }

    if (!ryhTitlePatched) {
      ryhOriginalTitle = current;
      ryhTitlePatched = true;
    }
    document.title = cleaned;
  }

  function restoreChannelTabTitle() {
    if (!ryhTitlePatched) {
      return;
    }
    if (ryhOriginalTitle) {
      document.title = ryhOriginalTitle;
    }
    ryhTitlePatched = false;
    ryhOriginalTitle = '';
  }

  function ensureFaviconLinks() {
    const links = [
      ...document.querySelectorAll("link[rel='icon'], link[rel='shortcut icon']")
    ];
    if (links.length) {
      return links;
    }

    const link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    document.head.appendChild(link);
    return [link];
  }

  function restoreDefaultFavicon() {
    if (!ryhFaviconActiveSrc) {
      return;
    }

    document.querySelectorAll(`link[${RYH_FAVICON_ATTR}]`).forEach((link) => {
      const original = link.getAttribute(RYH_FAVICON_ATTR);
      if (original) {
        link.href = original;
      } else {
        link.remove();
      }
      link.removeAttribute(RYH_FAVICON_ATTR);
    });
    ryhFaviconActiveSrc = '';
  }

  function applyChannelFavicon(emote) {
    const href = chrome.runtime.getURL(emote.src);
    if (ryhFaviconActiveSrc === href) {
      // Twitch иногда возвращает свой favicon — подправляем
      ensureFaviconLinks().forEach((link) => {
        if (link.href !== href) {
          if (!link.hasAttribute(RYH_FAVICON_ATTR)) {
            link.setAttribute(RYH_FAVICON_ATTR, link.href || '');
          }
          link.href = href;
          link.type = emote.src.endsWith('.gif') ? 'image/gif' : 'image/png';
        }
      });
      return;
    }

    restoreDefaultFavicon();
    ensureFaviconLinks().forEach((link) => {
      if (!link.hasAttribute(RYH_FAVICON_ATTR)) {
        link.setAttribute(RYH_FAVICON_ATTR, link.href || '');
      }
      link.href = href;
      link.type = emote.src.endsWith('.gif') ? 'image/gif' : 'image/png';
    });
    ryhFaviconActiveSrc = href;
  }

  function updateChannelFavicon() {
    const emote = findChannelFaviconEmote();
    if (emote) {
      applyChannelFavicon(emote);
      applyChannelTabTitle(emote);
    } else {
      restoreDefaultFavicon();
      restoreChannelTabTitle();
    }
  }

  function initChannelFaviconWatcher() {
    if (ryhFaviconObserver || !document.head) {
      return;
    }

    ryhFaviconObserver = new MutationObserver(() => {
      if (ryhFaviconActiveSrc || ryhTitlePatched) {
        updateChannelFavicon();
      }
    });
    ryhFaviconObserver.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'rel']
    });

    // Twitch часто меняет title через JS
    const titleEl = document.querySelector('title');
    if (titleEl) {
      ryhFaviconObserver.observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    window.addEventListener('popstate', () => {
      setTimeout(updateChannelFavicon, 50);
    });
  }

  function initMrtmrPatHotkey() {
    document.addEventListener(
      'keydown',
      (event) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
          return;
        }
        if (event.code !== 'KeyM') {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        insertTextIntoTwitchChat('mrtmrPAT');
      },
      true
    );
  }

  function initChatObserver() {
    initChatClickDelegation();
    initMrtmrPatHotkey();
    initChannelFaviconWatcher();
    observeChatRoot(document.body);
    attachChatObservers(document.body);
    scanAllChatLinks();
    updateChannelFavicon();

    if (chatScanInterval) {
      clearInterval(chatScanInterval);
    }
    chatScanInterval = setInterval(() => {
      scanAllChatLinks();
      updateChannelFavicon();
    }, 2000);
  }

  async function replacePihPlayer() {
    return replacePlayer({
      filmId: 'pih',
      embedUrl: PIH_LIVE_URL,
      title: 'PIH',
      pageUrl: PIH_LIVE_URL,
      players: [
        {
          id: 'pih',
          name: 'PIH',
          type: 'iframe',
          url: PIH_LIVE_URL
        }
      ],
      activePlayerId: 'pih',
      service: 'pih'
    });
  }

  function showPihLiveBanner() {
    let banner = document.getElementById('ryh-pih-live-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ryh-pih-live-banner';
      banner.innerHTML = `
        <div class="ryh-pih-live-card">
          <div class="ryh-pih-live-title">PIH</div>
          <div class="ryh-pih-live-text">Трансляция началась</div>
          <div class="ryh-pih-live-actions">
            <button type="button" class="ryh-pih-live-watch">Смотреть</button>
            <button type="button" class="ryh-pih-live-close">Закрыть</button>
          </div>
        </div>
      `;
      document.documentElement.appendChild(banner);
      banner.querySelector('.ryh-pih-live-watch').addEventListener('click', () => {
        banner.remove();
        replacePihPlayer().catch(() => {});
      });
      banner.querySelector('.ryh-pih-live-close').addEventListener('click', () => {
        banner.remove();
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'pihLiveStarted') {
      showPihLiveBanner();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'replacePlayer') {
      replacePlayer(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'replaceYoutubePlayer') {
      replaceYoutubePlayer(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'replaceRutubePlayer') {
      replaceRutubePlayer(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'replacePihPlayer') {
      replacePihPlayer()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'restorePlayer') {
      restorePlayer()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'getState') {
      (async () => {
        if (playerState.active && playerState.mode === 'youtube') {
          await refreshYoutubeVideoTitle();
        }

        sendResponse({
          active: playerState.active,
          mode: playerState.mode,
          title: playerState.title,
          filmId: playerState.filmId,
          roomId: playerState.roomId,
          roomUrl: playerState.roomUrl,
          syncEnabled: playerState.syncEnabled,
          queueLength: Array.isArray(playerState.rutubeQueue)
            ? playerState.rutubeQueue.length
            : 0,
          rutubeRoomId: playerState.rutubeRoomId || ''
        });
      })().catch(() => {
        sendResponse({
          active: playerState.active,
          mode: playerState.mode,
          title: playerState.title,
          filmId: playerState.filmId,
          roomId: playerState.roomId,
          roomUrl: playerState.roomUrl,
          syncEnabled: playerState.syncEnabled,
          queueLength: Array.isArray(playerState.rutubeQueue)
            ? playerState.rutubeQueue.length
            : 0,
          rutubeRoomId: playerState.rutubeRoomId || ''
        });
      });
      return true;
    }

    if (message.type === 'addToRutubeQueue') {
      addToRutubeQueue(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'skipRutubeQueue') {
      skipRutubeQueue()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'setPlayerSyncEnabled') {
      setPlayerSyncEnabled(Boolean(message.enabled))
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'loadFilmById') {
      loadFilmById(message.filmId, message.service)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'loadWatchPartyRoom') {
      loadWatchPartyRoom(message.slug)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === 'ping') {
      sendResponse({ ok: Boolean(ext().isExtensionContextValid?.()) });
      return false;
    }
  });

  function restoreYoutubeFromStorage(stored) {
    playerState = stored.playerState;
    const roomUrl =
      stored.youtubeRoomState?.roomUrl ||
      playerState.roomUrl ||
      playerState.embedUrl;
    if (!roomUrl) {
      return;
    }

    const tryRestore = (attempt = 0) => {
      const container = findPlayerContainer();
      if (container) {
        createYoutubeOverlay(container, {
          title: playerState.title || 'YouTube',
          roomUrl
        });
        storageSet({ youtubeRoomState: stored.youtubeRoomState });
        startYoutubeTitlePolling();
        return;
      }
      if (attempt < 20) {
        setTimeout(() => tryRestore(attempt + 1), 500);
      }
    };

    tryRestore();
  }

  function restoreFromStorage() {
    storageGet(['playerState', 'youtubeRoomState', 'playerSyncEnabled']).then((stored) => {
      if (!stored.playerState?.active) {
        return;
      }

      if (typeof stored.playerSyncEnabled === 'boolean') {
        stored.playerState.syncEnabled = stored.playerSyncEnabled;
      }

      if (stored.playerState.mode === 'youtube') {
        restoreYoutubeFromStorage(stored);
        return;
      }

      if (stored.playerState.mode === 'rutube' && !stored.playerState.filmId) {
        playerState = {
          ...stored.playerState,
          filmId: null,
          syncEnabled: Boolean(stored.playerState.syncEnabled),
          syncViewerCount: 0,
          rutubeQueue: Array.isArray(stored.playerState.rutubeQueue)
            ? stored.playerState.rutubeQueue
            : [],
          rutubeRoomId: stored.playerState.rutubeRoomId || createRutubeRoomId()
        };
        lastRutubeViewerCount = 0;

        const restoreToken = restoreLoadToken;
        const tryRestore = async (attempt = 0) => {
          if (restoreToken !== restoreLoadToken) {
            return;
          }

          const container = findPlayerContainer();
          if (container) {
            try {
              await createRutubePlaceholderOverlay(container);
              updateSyncUi();
              if (playerState.syncEnabled) {
                scheduleSyncBridgeJoin();
              }
            } catch {
              return;
            }
            return;
          }

          if (attempt < 20) {
            setTimeout(() => {
              tryRestore(attempt + 1).catch(() => {});
            }, 500);
          }
        };

        tryRestore().catch(() => {});
        return;
      }

      if (!stored.playerState.embedUrl && !stored.playerState.pageUrl) {
        return;
      }

      playerState = {
        ...stored.playerState,
        syncEnabled: Boolean(stored.playerState.syncEnabled),
        syncViewerCount: 0,
        rutubeQueue: Array.isArray(stored.playerState.rutubeQueue)
          ? stored.playerState.rutubeQueue
          : [],
        rutubeRoomId:
          stored.playerState.mode === 'rutube'
            ? stored.playerState.rutubeRoomId || createRutubeRoomId()
            : ''
      };
      const filmService = resolveFilmService(playerState.filmId, playerState.mode);
      const restoreToken = restoreLoadToken;
      const tryRestore = async (attempt = 0) => {
        if (restoreToken !== restoreLoadToken) {
          return;
        }

        const container = findPlayerContainer();
        if (container) {
          const players = playerState.players?.length
            ? playerState.players
            : [{
                id: 'default',
                name: getServiceLabel(filmService),
                type: 'iframe',
                url: playerState.embedUrl || playerState.pageUrl
              }];

          try {
            await createOverlay(container, {
              title: playerState.title,
              players,
              activePlayerId: playerState.activePlayerId || players[0].id,
              filmId: playerState.filmId,
              pageUrl: playerState.pageUrl,
              service: filmService,
              fallbackEmbedUrl:
                pickEmbeddableUrl(
                  playerState.embedUrl,
                  ...players.map((item) => item?.url)
                ) || playerState.embedUrl
            });
          } catch {
            return;
          }

          if (restoreToken !== restoreLoadToken) {
            removeOverlay();
            return;
          }

          if (filmService === 'rutube') {
            updateRutubeQueueUi();
          }

          if (playerState.syncEnabled) {
            scheduleSyncBridgeJoin();
          }
          return;
        }
        if (attempt < 20) {
          setTimeout(() => {
            tryRestore(attempt + 1).catch(() => {});
          }, 500);
        }
      };
      tryRestore().catch(() => {});
    });
  }

  initSyncMessageListener();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initVibixRetryListener();
      initChatObserver();
      restoreFromStorage();
    });
  } else {
    initVibixRetryListener();
    initChatObserver();
    restoreFromStorage();
  }
})();
