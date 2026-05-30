(() => {
  const ext = () => window.__RYH_EXT__ || {};

  if (window.__RYH_YOUTUBE_LOADED__) {
    if (ext().isExtensionContextValid?.()) {
      return;
    }
    document.getElementById('ryh-youtube-queue-btn')?.remove();
    document.getElementById('ryh-ext-reload-banner')?.remove();
  }
  window.__RYH_YOUTUBE_LOADED__ = true;

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

  const BTN_ID = 'ryh-youtube-queue-btn';
  const TOAST_ID = 'ryh-youtube-toast';
  const PLAYER_CONTAINER_SELECTORS = [
    '.html5-video-player',
    '#movie_player',
    'ytd-player',
    '#player'
  ];

  let activeRoomId = null;
  let toastTimer = null;
  let mountTimer = null;
  let boundPlayer = null;

  function getVideoId() {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('v');
    if (fromQuery) {
      return fromQuery;
    }

    const match = window.location.pathname.match(
      /^\/(?:embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/
    );
    return match?.[1] || null;
  }

  function getVideoUrl() {
    const videoId = getVideoId();
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
  }

  function getVideoTitle() {
    const meta = document.querySelector('meta[name="title"]');
    if (meta?.content) {
      return meta.content;
    }

    const heading = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string, h1.ytd-shorts'
    );
    return heading?.textContent?.trim() || 'YouTube видео';
  }

  function queryDeep(root, selector) {
    if (!root) {
      return null;
    }

    try {
      const direct = root.querySelector(selector);
      if (direct) {
        return direct;
      }
    } catch {
      /* ignore */
    }

    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const element of elements) {
      if (!element.shadowRoot) {
        continue;
      }
      const found = queryDeep(element.shadowRoot, selector);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function isVisiblePlayer(element) {
    if (!element?.isConnected) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 80 && rect.height > 80;
  }

  function findPlayerContainer() {
    for (const selector of PLAYER_CONTAINER_SELECTORS) {
      const element = queryDeep(document, selector);
      if (element && isVisiblePlayer(element)) {
        return element;
      }
    }

    for (const selector of PLAYER_CONTAINER_SELECTORS) {
      const element = queryDeep(document, selector);
      if (element) {
        return element;
      }
    }

    const video = queryDeep(document, 'video');
    return video?.closest('.html5-video-player') || video?.parentElement || null;
  }

  function showToast(text, type = '') {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }

    toast.textContent = text;
    toast.className = `ryh-youtube-toast ${type}`.trim();
    toast.classList.add('visible');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2800);
  }

  function removeQueueButton() {
    document.getElementById(BTN_ID)?.remove();
    boundPlayer = null;
  }

  function bindPlayerHover(container, button) {
    if (boundPlayer === container) {
      return;
    }

    boundPlayer?.removeEventListener('mouseenter', boundPlayer.__ryhShowBtn__);
    boundPlayer?.removeEventListener('mouseleave', boundPlayer.__ryhHideBtn__);
    boundPlayer = container;

    const show = () => button.classList.add('visible');
    const hide = () => {
      if (!button.classList.contains('loading')) {
        button.classList.remove('visible');
      }
    };

    container.__ryhShowBtn__ = show;
    container.__ryhHideBtn__ = hide;
    container.addEventListener('mouseenter', show);
    container.addEventListener('mouseleave', hide);
  }

  function createQueueButton(container) {
    removeQueueButton();

    if (!activeRoomId) {
      return;
    }

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const button = document.createElement('button');
    button.id = BTN_ID;
    button.type = 'button';
    button.className = 'ryh-youtube-queue-btn';
    button.title = 'Добавить в очередь WatchParty';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M19 11H13V5h-2v6H5v2h6v6h2v-6h6z"/>
      </svg>
      <span>В очередь</span>
    `;

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const videoUrl = getVideoUrl();
      if (!videoUrl) {
        showToast('Не удалось определить видео', 'error');
        return;
      }

      if (button.classList.contains('loading')) {
        return;
      }

      button.classList.add('loading', 'visible');
      button.disabled = true;

      try {
        const response = await sendRuntimeMessage({
          type: 'addToWatchPartyQueue',
          roomId: activeRoomId,
          videoUrl,
          title: getVideoTitle()
        });

        if (!response?.ok) {
          throw new Error(response?.error || 'Ошибка добавления');
        }

        showToast('Добавлено в очередь', 'success');
      } catch (error) {
        showToast(error.message || 'Ошибка', 'error');
      } finally {
        button.classList.remove('loading');
        button.disabled = false;
      }
    });

    container.appendChild(button);
    bindPlayerHover(container, button);
  }

  function mountQueueButton() {
    if (!activeRoomId) {
      removeQueueButton();
      return;
    }

    const container = findPlayerContainer();
    if (!container) {
      return;
    }

    let button = document.getElementById(BTN_ID);
    if (button && (!button.isConnected || !container.contains(button))) {
      button.remove();
      button = null;
      boundPlayer = null;
    }

    if (!button) {
      createQueueButton(container);
      return;
    }

    bindPlayerHover(container, button);

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }
  }

  function scheduleMountQueueButton() {
    if (mountTimer) {
      return;
    }
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mountQueueButton();
    }, 120);
  }

  function observePlayer() {
    const observer = new MutationObserver(() => {
      scheduleMountQueueButton();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    setInterval(() => {
      syncRoomState().catch(() => {});
    }, 3000);
  }

  function bindNavigationListeners() {
    const remount = () => {
      scheduleMountQueueButton();
      setTimeout(mountQueueButton, 400);
      setTimeout(mountQueueButton, 1200);
    };

    document.addEventListener('yt-navigate-finish', remount);
    document.addEventListener('yt-page-data-updated', scheduleMountQueueButton);
    window.addEventListener('popstate', scheduleMountQueueButton);
    window.addEventListener('pageshow', () => {
      syncRoomState();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        syncRoomState();
      }
    });
  }

  async function syncRoomState() {
    try {
      const response = await sendRuntimeMessage({ type: 'getYoutubeJoinState' });
      activeRoomId =
        response?.ok && response.joined && response.roomId ? response.roomId : null;
    } catch {
      activeRoomId = null;
    }

    mountQueueButton();
  }

  if (ext().isExtensionContextValid?.()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') {
        return;
      }
      if (changes.youtubeRoomState || changes.playerState) {
        syncRoomState();
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'ping') {
      sendResponse({ ok: Boolean(ext().isExtensionContextValid?.()) });
      return false;
    }

    if (message.type === 'getYoutubeQueueState') {
      sendResponse({
        ok: true,
        roomId: activeRoomId,
        videoId: getVideoId(),
        videoUrl: getVideoUrl()
      });
      return false;
    }

    if (message.type === 'refreshYoutubeQueueButton') {
      syncRoomState()
        .then(() => sendResponse({ ok: true, roomId: activeRoomId }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });

  function init() {
    syncRoomState();
    observePlayer();
    bindNavigationListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
