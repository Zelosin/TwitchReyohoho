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
    { type: 'film', pattern: /https?:\/\/(?:www\.)?reyohoho\.com\/films\/(\d+)/gi },
    {
      type: 'watchparty',
      pattern: /https?:\/\/(?:www\.)?watchparty\.me\/watch\/([a-z0-9-]+)/gi
    }
  ];

  const RYH_SHORT_PATTERN = /\bryh-([a-z0-9-]+)\b/gi;

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
    activePlayerId: ''
  };

  let sourceMenuCloser = null;
  let vibixIsolationTimers = [];
  let vibixFilmReloadCount = 0;
  let vibixIsolationDone = false;
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
      playerState.pageUrl || `https://reyohoho.com/films/${playerState.filmId}`;
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

  async function applyPlayerSource(overlay, player, filmId, pageUrl) {
    const iframe = overlay.querySelector('.ryh-player-frame');
    if (!iframe) {
      return;
    }

    const filmPageUrl = pageUrl || `https://reyohoho.com/films/${filmId}`;
    const isVibix = isVibixPlayer(player);

    if (!isVibix) {
      await disconnectWatchParty();
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
    iframe.src =
      player.type === 'iframe' && player.url ? player.url : filmPageUrl;
  }

  function getStoredEmbedRef(player, filmId, pageUrl) {
    if (player.id === 'vibix' || player.type === 'vibix') {
      return pageUrl || `https://reyohoho.com/films/${filmId}`;
    }
    return player.url || pageUrl || `https://reyohoho.com/films/${filmId}`;
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

        await applyPlayerSource(overlay, player, filmId, pageUrl);
        sourceBtn.textContent = `${player.name} ▾`;
        sourceMenu.querySelectorAll('.ryh-source-option').forEach((item) => {
          item.classList.toggle('active', item.dataset.playerId === player.id);
        });
        sourceMenu.classList.add('hidden');
        sourceBtn.setAttribute('aria-expanded', 'false');

        playerState.activePlayerId = player.id;
        playerState.embedUrl = getStoredEmbedRef(player, filmId, pageUrl);
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

  function createOverlay(container, { title, players, activePlayerId, filmId, pageUrl }) {
    removeOverlay();

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const activePlayer = players.find((item) => item.id === activePlayerId) || players[0];
    const hasMultipleSources = players.length > 1;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'ryh-player-overlay';
    overlay.innerHTML = `
      <div class="ryh-player-bar">
        <span class="ryh-player-title">${escapeHtml(title)}</span>
        <div class="ryh-bar-actions">
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

    applyPlayerSource(overlay, activePlayer, filmId, pageUrl).catch(() => {});

    overlay.querySelector('.ryh-restore-btn').addEventListener('click', () => {
      restorePlayer();
    });

    if (hasMultipleSources) {
      bindSourceMenu(overlay, players, activePlayer.id, filmId, pageUrl);
    }

    bindAutoHideControls(overlay);

    container.appendChild(overlay);
    pauseTwitchVideo();
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
    activePlayerId
  }) {
    const sources = Array.isArray(players) && players.length ? players : [];
    if (!sources.length && !embedUrl) {
      return { ok: false, error: 'URL плеера не получен' };
    }

    if (!sources.length && embedUrl) {
      sources.push({
        id: 'default',
        name: 'ReYohoho',
        type: 'iframe',
        url: embedUrl
      });
    }

    const activeId = activePlayerId || sources[0].id;
    const filmPageUrl = pageUrl || `https://reyohoho.com/films/${filmId}`;
    const activeSource = sources.find((item) => item.id === activeId) || sources[0];
    const resolvedUrl = getStoredEmbedRef(activeSource, filmId, filmPageUrl);

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

    createOverlay(container, {
      title: title || `Фильм ${filmId}`,
      players: sources,
      activePlayerId: activeId,
      filmId,
      pageUrl: filmPageUrl
    });

    playerState = {
      active: true,
      mode: 'reyohoho',
      filmId,
      title: title || `Фильм ${filmId}`,
      embedUrl: resolvedUrl,
      pageUrl: filmPageUrl,
      roomId: '',
      roomUrl: '',
      players: sources,
      activePlayerId: activeId
    };

    await storageSet({ playerState });
    return { ok: true, title: playerState.title };
  }

  async function restorePlayer() {
    const wasYoutube = playerState.mode === 'youtube';

    if (!wasYoutube) {
      await disconnectWatchParty();
    }

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
      activePlayerId: ''
    };
    await storageSet({ playerState });
    if (wasYoutube) {
      await storageRemove('youtubeRoomState');
      await sendRuntimeMessage({ type: 'clearYoutubeRoom' }).catch(() => {});
    }
    return { ok: true };
  }

  async function loadFilmById(filmId) {
    const response = await sendRuntimeMessage({
      type: 'getPlayerEmbed',
      filmId
    });

    if (!response?.ok) {
      return { ok: false, error: response?.error || 'Ошибка загрузки фильма' };
    }

    return replacePlayer({
      filmId,
      embedUrl: response.data.embedUrl,
      title: response.data.title,
      pageUrl: response.data.pageUrl,
      players: response.data.players,
      activePlayerId: response.data.activePlayerId
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
        if (filmId) {
          await loadFilmById(Number(filmId));
        } else {
          await loadWatchPartyRoom(roomSlug);
        }
        target.classList.remove('ryh-chat-link-loading');
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
      anchor.title = `Смотреть на ReYohoho (ID: ${match[1]})`;
    });
  }

  function parseRyhShortLink(match) {
    const token = match[1];
    if (/^\d+$/.test(token)) {
      return {
        type: 'film',
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

  function extractChatLinkFromText(text) {
    if (!text) {
      return null;
    }

    let best = null;

    for (const { type, pattern } of CHAT_URL_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (!match) {
        continue;
      }

      const item = {
        type,
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

    return best;
  }

  function markElementAsChatLink(element, linkInfo) {
    if (!element || element.classList.contains('ryh-chat-link')) {
      return;
    }

    element.classList.add('ryh-chat-link');
    element.setAttribute('role', 'link');

    if (linkInfo.type === 'film') {
      element.dataset.filmId = linkInfo.filmId;
      element.title = `Смотреть на ReYohoho (ID: ${linkInfo.filmId})`;
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
      link.title = `Смотреть на ReYohoho (ID: ${linkInfo.filmId})`;
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
          roomUrl: playerState.roomUrl
        });
      })().catch(() => {
        sendResponse({
          active: playerState.active,
          mode: playerState.mode,
          title: playerState.title,
          filmId: playerState.filmId,
          roomId: playerState.roomId,
          roomUrl: playerState.roomUrl
        });
      });
      return true;
    }

    if (message.type === 'loadFilmById') {
      loadFilmById(message.filmId)
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
    storageGet(['playerState', 'youtubeRoomState']).then((stored) => {
      if (!stored.playerState?.active) {
        return;
      }

      if (stored.playerState.mode === 'youtube') {
        restoreYoutubeFromStorage(stored);
        return;
      }

      if (!stored.playerState.embedUrl) {
        return;
      }

      playerState = stored.playerState;
      const tryRestore = (attempt = 0) => {
        const container = findPlayerContainer();
        if (container) {
          const players = playerState.players?.length
            ? playerState.players
            : [{
                id: 'default',
                name: 'ReYohoho',
                type: 'iframe',
                url: playerState.embedUrl
              }];

          createOverlay(container, {
            title: playerState.title,
            players,
            activePlayerId: playerState.activePlayerId || players[0].id,
            filmId: playerState.filmId,
            pageUrl: playerState.pageUrl
          });
          return;
        }
        if (attempt < 20) {
          setTimeout(() => tryRestore(attempt + 1), 500);
        }
      };
      tryRestore();
    });
  }

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
