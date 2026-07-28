(() => {
  const ext = () => window.__RYH_EXT__ || {};

  if (window.__RYH_RUTUBE_LOADED__) {
    if (ext().isExtensionContextValid?.()) {
      return;
    }
    document.getElementById('ryh-rutube-queue-btn')?.remove();
    document.getElementById('ryh-ext-reload-banner')?.remove();
  }
  window.__RYH_RUTUBE_LOADED__ = true;

  async function sendRuntimeMessage(payload) {
    if (ext().safeRuntimeSendMessage) {
      return ext().safeRuntimeSendMessage(payload);
    }
    return chrome.runtime.sendMessage(payload);
  }

  const BTN_ID = 'ryh-rutube-queue-btn';
  const TOAST_ID = 'ryh-rutube-toast';
  const VIDEO_ID_RE = /^[a-f0-9]{32}$/i;
  const PLAYER_CONTAINER_SELECTORS = [
    '[data-testid="player"]',
    '[data-testid="video-player"]',
    '[class*="video-player"]',
    '[class*="VideoPlayer"]',
    '[class*="player-module"]',
    '[class*="PlayerModule"]',
    '#video-player',
    '#player'
  ];

  let toastTimer = null;
  let mountTimer = null;
  let boundPlayer = null;
  let lastPathname = window.location.pathname;

  function getVideoId() {
    const pathname = window.location.pathname || '';
    const match = pathname.match(
      /^\/(?:video|play\/embed|shorts|live\/video|private\/video|yappy\/video)\/([a-f0-9]{32})\/?/i
    );
    if (match?.[1] && VIDEO_ID_RE.test(match[1])) {
      return match[1].toLowerCase();
    }

    const fromQuery = new URL(window.location.href).searchParams.get('v');
    if (fromQuery && VIDEO_ID_RE.test(fromQuery)) {
      return fromQuery.toLowerCase();
    }

    const ogUrl = document
      .querySelector('meta[property="og:url"]')
      ?.getAttribute('content');
    if (ogUrl) {
      const ogMatch = ogUrl.match(/\/(?:video|play\/embed)\/([a-f0-9]{32})/i);
      if (ogMatch?.[1]) {
        return ogMatch[1].toLowerCase();
      }
    }

    return null;
  }

  function getVideoUrl() {
    const videoId = getVideoId();
    return videoId ? `https://rutube.ru/video/${videoId}/` : null;
  }

  function getVideoTitle() {
    const ogTitle = document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute('content');
    if (ogTitle?.trim()) {
      return ogTitle.trim();
    }

    const twitterTitle = document
      .querySelector('meta[name="twitter:title"]')
      ?.getAttribute('content');
    if (twitterTitle?.trim()) {
      return twitterTitle.trim();
    }

    const heading = document.querySelector(
      'h1, [class*="video-title"], [data-testid="video-title"]'
    );
    if (heading?.textContent?.trim()) {
      return heading.textContent.trim();
    }

    const docTitle = document.title?.replace(/\s*[—|–-]\s*RUTUBE.*$/i, '').trim();
    return docTitle || 'Rutube видео';
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

  function findSizedAncestor(element) {
    let current = element;
    let best = element;

    for (let depth = 0; current && depth < 8; depth += 1) {
      if (isVisiblePlayer(current)) {
        best = current;
        const rect = current.getBoundingClientRect();
        if (rect.width >= 240 && rect.height >= 135) {
          return current;
        }
      }
      current = current.parentElement;
    }

    return best;
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
    if (video) {
      return findSizedAncestor(video.parentElement || video);
    }

    const embed = queryDeep(
      document,
      'iframe[src*="rutube.ru/play/embed"], iframe[src*="play/embed"]'
    );
    if (embed) {
      return findSizedAncestor(embed.parentElement || embed);
    }

    return null;
  }

  function showToast(text, type = '') {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }

    toast.textContent = text;
    toast.className = `ryh-rutube-toast ${type}`.trim();
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

    if (!getVideoId()) {
      return;
    }

    const computed = window.getComputedStyle(container);
    if (computed.position === 'static') {
      container.style.position = 'relative';
    }

    const button = document.createElement('button');
    button.id = BTN_ID;
    button.type = 'button';
    button.className = 'ryh-rutube-queue-btn';
    button.title = 'Добавить в очередь совместного просмотра Rutube';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M19 11H13V5h-2v6H5v2h6v6h2v-6h6z"/>
      </svg>
      <span>В очередь</span>
    `;

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const videoId = getVideoId();
      const videoUrl = getVideoUrl();
      if (!videoId || !videoUrl) {
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
          type: 'addToRutubeQueue',
          videoId,
          videoUrl,
          title: getVideoTitle()
        });

        if (!response?.ok) {
          throw new Error(response?.error || 'Ошибка добавления');
        }

        if (response.started) {
          showToast('Запущено на Twitch', 'success');
        } else if (response.alreadyPlaying) {
          showToast('Уже воспроизводится', 'success');
        } else if (response.alreadyQueued) {
          showToast('Уже в очереди', 'success');
        } else {
          showToast('Добавлено в очередь', 'success');
        }
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
    if (!getVideoId()) {
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
      if (window.location.pathname !== lastPathname) {
        lastPathname = window.location.pathname;
        scheduleMountQueueButton();
        setTimeout(mountQueueButton, 400);
        setTimeout(mountQueueButton, 1200);
      }
    }, 3000);
  }

  function bindNavigationListeners() {
    const remount = () => {
      lastPathname = window.location.pathname;
      scheduleMountQueueButton();
      setTimeout(mountQueueButton, 400);
      setTimeout(mountQueueButton, 1200);
    };

    window.addEventListener('popstate', remount);
    window.addEventListener('pageshow', remount);

    const wrapHistory = (methodName) => {
      const original = history[methodName];
      if (typeof original !== 'function') {
        return;
      }
      history[methodName] = function (...args) {
        const result = original.apply(this, args);
        remount();
        return result;
      };
    };

    wrapHistory('pushState');
    wrapHistory('replaceState');
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'ping') {
      sendResponse({ ok: Boolean(ext().isExtensionContextValid?.()) });
      return false;
    }

    if (message.type === 'getRutubeQueueState') {
      sendResponse({
        ok: true,
        videoId: getVideoId(),
        videoUrl: getVideoUrl()
      });
      return false;
    }

    if (message.type === 'refreshRutubeQueueButton') {
      mountQueueButton();
      sendResponse({ ok: true, videoId: getVideoId() });
      return false;
    }
  });

  function init() {
    mountQueueButton();
    observePlayer();
    bindNavigationListeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
