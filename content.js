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
    }
  ];

  const RYH_SHORT_PATTERN = /\bryh-([a-z0-9-]+)\b/gi;
  const APREL_SHORT_PATTERN =
    /\bapr-((?:films|serials|mults|anime|nocategory)(?:--[a-z0-9-]+)+)\b/gi;
  const MATRIX_SHORT_PATTERN = /\bmtr-(\d{3,})\b/gi;

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
    matrix: 'Matrix'
  };

  function getServiceLabel(service) {
    return SERVICE_LABELS[service] || SERVICE_LABELS.reyohoho;
  }

  function resolveFilmService(filmId, service) {
    if (service === 'aprel' || service === 'reyohoho' || service === 'matrix') {
      return service;
    }
    const id = String(filmId || '');
    if (id.includes('/')) {
      return 'aprel';
    }
    return 'reyohoho';
  }

  function getDefaultFilmPageUrl(filmId, service) {
    const resolvedService = resolveFilmService(filmId, service);
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
    return `https://reyohoho.com/films/${filmId}`;
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
    syncViewerCount: 0
  };

  let syncBridgeTimer = null;

  function isSyncSupportedMode(mode) {
    return mode === 'aprel' || mode === 'matrix';
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

    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
    }

    syncBridgeTimer = setTimeout(() => {
      syncBridgeTimer = null;
      rejoinPlayerSync().catch(() => {});
    }, 1500);
  }

  async function joinPlayerSync() {
    if (!playerState.syncEnabled || !isSyncSupportedMode(playerState.mode) || !playerState.filmId) {
      return { ok: false };
    }

    return sendRuntimeMessage({
      type: 'joinPlayerSync',
      service: playerState.mode,
      filmId: playerState.filmId
    }).catch(() => ({ ok: false }));
  }

  async function rejoinPlayerSync() {
    if (!playerState.syncEnabled || !isSyncSupportedMode(playerState.mode) || !playerState.filmId) {
      return { ok: false };
    }

    playerState.syncViewerCount = 0;
    updateSyncUi();

    return sendRuntimeMessage({
      type: 'rejoinPlayerSync',
      service: playerState.mode,
      filmId: playerState.filmId
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
        playerState.syncViewerCount = Number(data.detail?.count) || 0;
        updateSyncUi();
        return;
      }

      if (data.type === 'sync-disconnected') {
        if (playerState.syncEnabled) {
          playerState.syncViewerCount = 0;
          updateSyncUi();
        }
      }
    });
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
    const showSyncUi = isSyncSupportedMode(service || playerState.mode);

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
      <div class="ryh-player-body">
        <iframe
          class="ryh-player-frame"
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

    if (showSyncUi) {
      bindSyncControls(overlay);
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

  async function replacePlayer({
    filmId,
    embedUrl,
    title,
    pageUrl,
    players,
    activePlayerId,
    service
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

    if (syncBridgeTimer) {
      clearTimeout(syncBridgeTimer);
      syncBridgeTimer = null;
    }
    await leavePlayerSync();

    const storedSync = await storageGet(['playerSyncEnabled']);
    const syncEnabled =
      isSyncSupportedMode(filmService) &&
      (typeof storedSync.playerSyncEnabled === 'boolean'
        ? storedSync.playerSyncEnabled
        : Boolean(playerState.syncEnabled));

    playerState.syncEnabled = syncEnabled;

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
      syncViewerCount: 0
    };

    await storageSet({ playerState, playerSyncEnabled: syncEnabled });

    if (playerState.syncEnabled) {
      scheduleSyncBridgeJoin();
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
      syncViewerCount: 0
    };
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
        if (!filmId && !roomSlug) {
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
        window.setTimeout(async () => {
          try {
            if (linkFilmId) {
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
    if (parent.closest('.ryh-chat-emote, img')) {
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

  function wrapEmoteInTextNode(textNode, emoteInfo) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest('.ryh-chat-emote, img, .ryh-chat-link')) {
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
    img.className = 'ryh-chat-emote chat-line__message--emote';
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

  function initChatObserver() {
    initChatClickDelegation();
    observeChatRoot(document.body);
    attachChatObservers(document.body);
    scanAllChatLinks();

    if (chatScanInterval) {
      clearInterval(chatScanInterval);
    }
    chatScanInterval = setInterval(scanAllChatLinks, 2000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
          syncEnabled: playerState.syncEnabled
        });
      })().catch(() => {
        sendResponse({
          active: playerState.active,
          mode: playerState.mode,
          title: playerState.title,
          filmId: playerState.filmId,
          roomId: playerState.roomId,
          roomUrl: playerState.roomUrl,
          syncEnabled: playerState.syncEnabled
        });
      });
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

      if (!stored.playerState.embedUrl && !stored.playerState.pageUrl) {
        return;
      }

      playerState = {
        ...stored.playerState,
        syncEnabled: Boolean(stored.playerState.syncEnabled),
        syncViewerCount: 0
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
