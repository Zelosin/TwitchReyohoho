importScripts('socket.io.min.js', 'watchparty.js');

const REYOHOHO_ORIGIN = 'https://reyohoho.com';
const REYOHOHO_ORIGINS = ['https://reyohoho.com', 'https://www.reyohoho.com'];
const APREL_ORIGIN = 'https://aprelteam.gokino.by';
const MATRIX_ORIGIN = 'https://gokino.by';
const MATRIX_FALLBACK_ORIGIN = 'https://matrix.gokino.by';
const VIBIX_SYNC_WS_ORIGIN = 'wss://sync.videoframe2.com';

const FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache'
};

let vibixIsolateInFlight = false;
let vibixIsolateQueued = false;

async function notifyYoutubeQueueTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/*', 'https://youtube.com/*']
    });

    await Promise.all(
      tabs.map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, { type: 'refreshYoutubeQueueButton' })
          .catch(() => {})
      )
    );
  } catch {
    /* ignore */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.youtubeRoomState) {
    return;
  }
  notifyYoutubeQueueTabs();
});

const TWITCH_TAB_URLS = ['https://www.twitch.tv/*', 'https://twitch.tv/*'];

async function findLiveYoutubeSession() {
  const tabs = await chrome.tabs.query({ url: TWITCH_TAB_URLS });

  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }

    try {
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
      if (state?.active && state.mode === 'youtube' && state.roomId) {
        return {
          tabId: tab.id,
          roomId: state.roomId,
          roomUrl: state.roomUrl || ''
        };
      }
    } catch {
      /* content script unavailable */
    }
  }

  return null;
}

async function clearYoutubeSessionIfNoLiveTab() {
  const session = await findLiveYoutubeSession();
  if (session) {
    return;
  }

  const stored = await chrome.storage.local.get(['playerState', 'youtubeRoomState']);
  const hadYoutubeSession =
    Boolean(stored.playerState?.active && stored.playerState?.mode === 'youtube') ||
    Boolean(stored.youtubeRoomState?.roomId);

  if (!hadYoutubeSession) {
    return;
  }

  try {
    await RYH_WatchParty.disconnectWatchPartySockets();
  } catch {
    /* ignore */
  }

  await chrome.storage.local.remove('youtubeRoomState');

  if (stored.playerState?.mode === 'youtube') {
    await chrome.storage.local.set({
      playerState: {
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
      }
    });
  }

  notifyYoutubeQueueTabs();
}

chrome.tabs.onRemoved.addListener(() => {
  clearYoutubeSessionIfNoLiveTab().catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url && !/twitch\.tv/i.test(changeInfo.url)) {
    clearYoutubeSessionIfNoLiveTab().catch(() => {});
  }
});

async function fetchReyohohoHtml(path) {
  let lastError = null;

  for (const origin of REYOHOHO_ORIGINS) {
    try {
      const response = await fetch(`${origin}${path}`, {
        method: 'GET',
        headers: FETCH_HEADERS,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store'
      });

      if (!response.ok) {
        lastError = new Error(`Ошибка запроса: ${response.status}`);
        continue;
      }

      return response.text();
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError?.message === 'Failed to fetch') {
    throw new Error('Не удалось подключиться к reyohoho.com. Проверьте интернет и обновите расширение.');
  }

  throw lastError || new Error('Не удалось загрузить reyohoho.com');
}

async function getVideoService() {
  const stored = await chrome.storage.local.get(['videoService']);
  if (stored.videoService === 'reyohoho') {
    return 'reyohoho';
  }
  if (stored.videoService === 'matrix') {
    return 'matrix';
  }
  return 'aprel';
}

function resolveVideoService(filmId, service) {
  if (service === 'aprel' || service === 'reyohoho' || service === 'matrix') {
    return service;
  }

  const id = String(filmId ?? '');
  if (id.includes('/')) {
    return 'aprel';
  }

  return null;
}

function normalizeKinopoiskId(filmId) {
  const raw = String(filmId || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?gokino\.by\/matrix\/search\.php\?(?:[^#]*&)?q=/i, '')
    .replace(/^https?:\/\/(?:www\.)?matrix\.gokino\.by\/\?(?:[^#]*&)?q=/i, '')
    .replace(/[^\d].*$/, '');

  if (!/^\d{3,}$/.test(raw)) {
    throw new Error('Некорректный ID Кинопоиска');
  }

  return raw;
}

function matrixPageUrlFromKpId(kpId) {
  return `${MATRIX_ORIGIN}/matrix/search.php?q=${kpId}`;
}

function getMatrixFetchUrls(kpId) {
  return [
    matrixPageUrlFromKpId(kpId),
    `${MATRIX_FALLBACK_ORIGIN}/?q=${kpId}`
  ];
}

async function fetchMatrixHtml(kpId) {
  let lastError = null;

  for (const pageUrl of getMatrixFetchUrls(kpId)) {
    try {
      const response = await fetch(pageUrl, {
        method: 'GET',
        headers: FETCH_HEADERS,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store'
      });

      if (!response.ok) {
        lastError = new Error(`Ошибка запроса: ${response.status}`);
        continue;
      }

      return {
        html: await response.text(),
        pageUrl
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError?.message === 'Failed to fetch') {
    throw new Error(
      'Не удалось подключиться к gokino.by / matrix.gokino.by. Проверьте интернет и обновите расширение.'
    );
  }

  throw lastError || new Error('Не удалось загрузить Matrix');
}

function resolveMatrixPlayerUrl(url, pageUrl) {
  let resolved = decodeHtmlEntities(String(url || '').trim());
  if (!resolved) {
    return '';
  }

  if (resolved.startsWith('//')) {
    resolved = `https:${resolved}`;
  } else if (resolved.startsWith('/')) {
    let pageOrigin = MATRIX_ORIGIN;
    try {
      pageOrigin = new URL(pageUrl).origin;
    } catch {
      /* keep default */
    }
    resolved = `${pageOrigin}${resolved}`;
  }

  return resolved;
}

function buildMatrixFallbackPlayers(kpId, pageUrl) {
  return [
    {
      id: 'player-1',
      name: 'Плеер 1',
      type: 'iframe',
      url: `https://api.variyt.ws/embed/kp/${kpId}`
    },
    {
      id: 'player-2',
      name: 'Плеер 2',
      type: 'iframe',
      url: `https://a7c5ea7c.obrut.show/embed/1EjM/kinopoisk/${kpId}`
    },
    {
      id: 'player-3',
      name: 'Плеер 3',
      type: 'iframe',
      url: `https://p.lumex.space/aoeIJGBZSi3y?kp_id=${kpId}`
    },
    {
      id: 'player-9',
      name: 'Плеер 9',
      type: 'iframe',
      url: `https://kinovibe.co/embed/kinopoisk/${kpId}/`
    },
    {
      id: 'player-12',
      name: 'Плеер 12',
      type: 'iframe',
      url: `https://player0.flixcdn.space/show/kinopoisk/${kpId}`
    },
    {
      id: 'page',
      name: 'Matrix',
      type: 'iframe',
      url: pageUrl
    }
  ];
}

function parseMatrixPlayers(html, kpId, pageUrl) {
  const players = [];
  const seen = new Set();

  const addPlayer = (url, name, idHint = '') => {
    const resolved = resolveMatrixPlayerUrl(url, pageUrl);
    if (!resolved || seen.has(resolved)) {
      return;
    }

    seen.add(resolved);
    players.push({
      id: idHint || `player-${players.length + 1}`,
      name: name || `Плеер ${players.length + 1}`,
      type: 'iframe',
      url: resolved
    });
  };

  const selectBlocks = html.match(/<select[^>]*>[\s\S]*?<\/select>/gi) || [];
  for (const block of selectBlocks) {
    const optionPattern = /<option[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionPattern.exec(block)) !== null) {
      const label = decodeHtmlEntities(optionMatch[2].replace(/<[^>]+>/g, '').trim());
      if (!label || /выбор/i.test(label)) {
        continue;
      }
      addPlayer(optionMatch[1], label);
    }
  }

  const buttonPattern =
    /<(button|a)[^>]*(?:data-(?:src|url|link|player)=("|')([^"']+)\2|onclick="([^"]+)")[^>]*>([\s\S]*?)<\/\1>/gi;
  let buttonMatch;
  while ((buttonMatch = buttonPattern.exec(html)) !== null) {
    const label = decodeHtmlEntities(buttonMatch[5].replace(/<[^>]+>/g, '').trim());
    if (!/плеер/i.test(label)) {
      continue;
    }

    const dataUrl = buttonMatch[3];
    const onclick = buttonMatch[4] || '';
    const onclickUrl =
      onclick.match(/(?:src|url)\s*=\s*['"]([^'"]+)['"]/i)?.[1] ||
      onclick.match(/(['"])(https?:\/\/[^'"]+)\1/i)?.[2] ||
      onclick.match(/(['"])(\/[^'"]+)\1/i)?.[2];

    addPlayer(dataUrl || onclickUrl, label);
  }

  const iframePattern = /<iframe[^>]+(?:data-src|src)="([^"]+)"/gi;
  let iframeMatch;
  while ((iframeMatch = iframePattern.exec(html)) !== null) {
    const url = iframeMatch[1];
    if (/about:blank|^$/i.test(url)) {
      continue;
    }
    addPlayer(url, `Плеер ${players.length + 1}`);
  }

  const kpUrlPattern = new RegExp(
    `(https?:\\/\\/[^"'\\s<>]+(?:kinopoisk|(?:\\/|\\?|&)kp(?:_id)?=?)${kpId}[^"'\\s<>]*)`,
    'gi'
  );
  let kpUrlMatch;
  while ((kpUrlMatch = kpUrlPattern.exec(html)) !== null) {
    addPlayer(kpUrlMatch[1], `Плеер ${players.length + 1}`);
  }

  if (!players.length) {
    return buildMatrixFallbackPlayers(kpId, pageUrl);
  }

  if (!players.some((player) => player.url === pageUrl)) {
    players.push({
      id: 'page',
      name: 'Matrix',
      type: 'iframe',
      url: pageUrl
    });
  }

  return players;
}

async function getMatrixPlayerEmbed(filmId) {
  const kpId = normalizeKinopoiskId(filmId);
  const { html, pageUrl } = await fetchMatrixHtml(kpId);
  const titleMatch =
    html.match(/Фильм по ID\s*(\d+)/i) ||
    html.match(/<h1[^>]*>([^<]*ID[^<]*\d+[^<]*)<\/h1>/i) ||
    html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].trim())
    : `Кинопоиск #${kpId}`;
  const players = parseMatrixPlayers(html, kpId, pageUrl);
  const defaultPlayer = players[0];

  return {
    filmId: kpId,
    title,
    pageUrl,
    players,
    activePlayerId: defaultPlayer.id,
    embedUrl: defaultPlayer.url,
    service: 'matrix'
  };
}

async function fetchAprelHtml(path) {
  try {
    const response = await fetch(`${APREL_ORIGIN}${path}`, {
      method: 'GET',
      headers: FETCH_HEADERS,
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Ошибка запроса: ${response.status}`);
    }

    return response.text();
  } catch (error) {
    if (error?.message === 'Failed to fetch') {
      throw new Error(
        'Не удалось подключиться к aprelteam.gokino.by. Проверьте интернет и обновите расширение.'
      );
    }
    throw error;
  }
}

function normalizeAprelPath(filmId) {
  const raw = String(filmId || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?aprelteam\.gokino\.by\//i, '')
    .replace(/^\//, '')
    .replace(/\.html$/i, '');

  if (!raw) {
    throw new Error('Некорректная ссылка Aprel Kino');
  }

  return raw;
}

function aprelPageUrlFromPath(filmPath) {
  return `${APREL_ORIGIN}/${filmPath}.html`;
}

function aprelPathFromUrl(url) {
  const match = String(url || '').match(/aprelteam\.gokino\.by\/(.+?)\.html/i);
  return match ? match[1] : null;
}

function resolveAprelPlayerUrl(url, pageUrl) {
  let resolved = decodeHtmlEntities(String(url || '').trim());
  if (!resolved) {
    return '';
  }

  if (resolved.startsWith('//')) {
    resolved = `https:${resolved}`;
  } else if (resolved.startsWith('/')) {
    resolved = `${APREL_ORIGIN}${resolved}`;
  }

  return resolved;
}

async function getWatchPartyFrameId(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const watchpartyFrames = frames.filter(
    (frame) => frame.url && /https:\/\/(www\.)?watchparty\.me\/watch\//i.test(frame.url)
  );

  if (!watchpartyFrames.length) {
    return null;
  }

  return watchpartyFrames[watchpartyFrames.length - 1].frameId;
}

async function setWatchPartyControlsVisibleInTab(tabId, visible) {
  const frameId = await getWatchPartyFrameId(tabId);
  if (frameId === null) {
    return { ok: false, error: 'Плеер WatchParty не найден' };
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (show) => {
      const STYLE_ID = 'ryh-wp-controls-style';
      const CONTROLS_SELECTOR = '[class*="_controls_"]';

      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
          [class*="_expandButton"] {
            display: none !important;
          }
          ${CONTROLS_SELECTOR}.ryh-wp-controls-anim {
            overflow: hidden;
            max-height: 48px;
            opacity: 1;
            transition:
              max-height 0.22s ease,
              opacity 0.22s ease,
              margin 0.22s ease,
              padding 0.22s ease;
          }
          ${CONTROLS_SELECTOR}.ryh-wp-controls-anim.ryh-wp-controls-hidden {
            max-height: 0 !important;
            opacity: 0;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
            pointer-events: none;
          }
        `;
        document.head.appendChild(style);
      }

      const controls = document.querySelector(CONTROLS_SELECTOR);
      if (!controls) {
        return { ok: false, error: 'Панель управления не найдена' };
      }

      controls.style.display = '';
      controls.classList.add('ryh-wp-controls-anim');
      controls.classList.toggle('ryh-wp-controls-hidden', !show);
      return { ok: true };
    },
    args: [Boolean(visible)]
  });

  return result?.result || { ok: false, error: 'Не удалось изменить панель' };
}

async function getWatchPartyVideoTitleInTab(tabId) {
  const frameId = await getWatchPartyFrameId(tabId);
  if (frameId === null) {
    return { ok: false, error: 'Плеер WatchParty не найден' };
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: () => {
      const ytFrame = document.querySelector('#leftYt');
      const ytTitle = ytFrame?.getAttribute('title')?.trim();
      if (ytTitle) {
        return { ok: true, title: ytTitle };
      }

      const video = document.querySelector('#leftVideo');
      const videoTitle = video?.getAttribute('title')?.trim() || video?.title?.trim();
      if (videoTitle) {
        return { ok: true, title: videoTitle };
      }

      return { ok: false };
    }
  });

  return result?.result || { ok: false, error: 'Название видео не найдено' };
}

async function skipWatchPartyVideoInTab(tabId) {
  const frameId = await getWatchPartyFrameId(tabId);
  if (frameId === null) {
    throw new Error('Плеер WatchParty не найден');
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: () => {
      function walkAllFibers(fiber) {
        let found = null;

        (function walk(node) {
          if (!node || found) {
            return;
          }

          const instance = node.stateNode;
          if (
            instance &&
            typeof instance.roomPlaylistPlay === 'function' &&
            instance.socket
          ) {
            found = instance;
            return;
          }

          walk(node.child);
          walk(node.sibling);
        })(fiber);

        return found;
      }

      function findAppInstance() {
        const root = document.getElementById('root');
        if (!root) {
          return null;
        }

        for (const key of Object.keys(root)) {
          let fiber = root[key];
          if (!fiber) {
            continue;
          }
          if (fiber.current) {
            fiber = fiber.current;
          }
          if (fiber?.child) {
            const found = walkAllFibers(fiber.child);
            if (found) {
              return found;
            }
          }
          if (fiber?.tag !== undefined) {
            const found = walkAllFibers(fiber);
            if (found) {
              return found;
            }
          }
        }

        return null;
      }

      const app = findAppInstance();
      if (app?.state?.playlist?.length > 0) {
        app.roomPlaylistPlay(0);
        return { ok: true, method: 'roomPlaylistPlay' };
      }

      const controls = document.querySelector('[class*="_controls_"]');
      const skipIcon = controls?.querySelector('.tabler-icon-player-skip-forward-filled');
      if (skipIcon) {
        const target = skipIcon.closest('svg') || skipIcon;
        target.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
        );
        return { ok: true, method: 'click' };
      }

      if (app?.socket) {
        app.socket.emit('CMD:playlistNext', app.state?.roomMedia || null);
        return { ok: true, method: 'socket' };
      }

      return {
        ok: false,
        error: 'В очереди нет следующего видео'
      };
    }
  });

  const payload = result?.result;
  if (!payload?.ok) {
    throw new Error(payload?.error || 'Не удалось пропустить видео');
  }

  return payload;
}

async function resetWatchPartyLayoutInTab(tabId) {
  const frameId = await getWatchPartyFrameId(tabId);
  if (frameId === null) {
    throw new Error('Плеер WatchParty не найден');
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const rightCol = document.querySelector('[class*="rightColumn"]');
        const expandWrap = document.querySelector('[class*="expandButton"]');
        const expandBtn = expandWrap?.querySelector('button') || expandWrap;

        if (rightCol && expandBtn) {
          const width = rightCol.getBoundingClientRect().width;
          if (width < 80) {
            expandBtn.click();
            await sleep(400);
            return { ok: true, action: 'expanded' };
          }
          return { ok: true, action: 'already_ok' };
        }

        await sleep(200);
      }

      location.reload();
      return { ok: true, action: 'reload' };
    }
  });

  return result?.result || { ok: false, error: 'Не удалось сбросить вид' };
}

async function getReyohohoFilmFrameId(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const filmFrames = frames.filter(
    (frame) => frame.url && /https:\/\/(www\.)?reyohoho\.com\/films\//i.test(frame.url)
  );

  if (!filmFrames.length) {
    return null;
  }

  return filmFrames[filmFrames.length - 1].frameId;
}

async function ensureVibixSyncApi(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    files: ['vibix-sync.js']
  });
}

async function callVibixSync(tabId, method, filmId) {
  const frameId = await getReyohohoFilmFrameId(tabId);
  if (frameId === null) {
    throw new Error('Плеер Vibix не найден. Замените плеер и выберите источник Vibix.');
  }

  await ensureVibixSyncApi(tabId, frameId);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: async (syncMethod, syncFilmId) => {
      const api = window.RYH_VibixSync;
      if (!api) {
        return { ok: false, error: 'Модуль синхронизации недоступен' };
      }

      if (syncMethod === 'join') {
        return api.join(syncFilmId);
      }

      if (syncMethod === 'leave') {
        return api.leave();
      }

      return { ok: false, error: 'Неизвестное действие' };
    },
    args: [method, filmId ?? null]
  });

  return result?.result || { ok: false, error: 'Нет ответа от плеера' };
}

async function joinWatchPartyInTab(tabId, filmId) {
  const numericFilmId = Number(filmId);
  if (!numericFilmId) {
    throw new Error('Некорректный ID фильма');
  }

  const result = await callVibixSync(tabId, 'join', numericFilmId);
  if (!result.ok) {
    throw new Error(result.error || 'Не удалось подключиться к совместному просмотру');
  }
  return result;
}

async function leaveWatchPartyInTab(tabId) {
  try {
    const frameId = await getReyohohoFilmFrameId(tabId);
    if (frameId !== null) {
      await ensureVibixSyncApi(tabId, frameId);
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        func: () => window.RYH_VibixSync?.leave?.()
      });
    }
  } catch {
    /* ignore */
  }

  return { ok: true };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSyncRoomId(service, filmId) {
  if (service === 'matrix') {
    const kpId = String(filmId || '').replace(/\D/g, '');
    return kpId ? `matrix_${kpId}` : '';
  }

  if (service === 'aprel') {
    const path = String(filmId || '')
      .replace(/^https?:\/\/(?:www\.)?aprelteam\.gokino\.by\//i, '')
      .replace(/^\//, '')
      .replace(/\.html$/i, '')
      .replace(/\//g, '_');
    return path ? `aprel_${path}` : '';
  }

  return '';
}

async function getSyncServerOrigin() {
  const stored = await chrome.storage.local.get(['syncServerUrl']);
  const raw = String(stored.syncServerUrl || VIBIX_SYNC_WS_ORIGIN).trim();
  return raw.split('?')[0].replace(/\/$/, '') || VIBIX_SYNC_WS_ORIGIN;
}

async function getPlayerSyncClientId() {
  const stored = await chrome.storage.local.get(['watchpartyClientId', 'playerSyncClientId']);
  let clientId = stored.watchpartyClientId || stored.playerSyncClientId;

  if (!clientId) {
    clientId = crypto.randomUUID
      ? crypto.randomUUID()
      : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
          (
            +c ^
            (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
          ).toString(16)
        );
    await chrome.storage.local.set({
      playerSyncClientId: clientId,
      watchpartyClientId: clientId
    });
  }

  return clientId;
}

async function ensurePlayerSyncApi(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['player-sync.js']
  });
}

async function getOverlayEmbedSrc(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const iframe = document
        .getElementById('ryh-player-overlay')
        ?.querySelector('.ryh-player-frame');
      const src = iframe?.src || '';
      return src && !src.startsWith('about:') ? src : '';
    }
  });

  return result?.result || '';
}

function collectDescendantFrameIds(frames, rootId) {
  const ids = new Set([rootId]);
  let growing = true;

  while (growing) {
    growing = false;
    for (const frame of frames) {
      if (ids.has(frame.parentFrameId) && !ids.has(frame.frameId)) {
        ids.add(frame.frameId);
        growing = true;
      }
    }
  }

  return [...ids];
}

async function getOverlayPlayerFrameIds(tabId) {
  const embedSrc = await getOverlayEmbedSrc(tabId);
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const roots = [];

  if (embedSrc) {
    let embedOrigin = '';
    try {
      embedOrigin = new URL(embedSrc).origin;
    } catch {
      embedOrigin = '';
    }

    for (const frame of frames) {
      if (!frame.url || frame.url === 'about:blank') {
        continue;
      }

      if (frame.url === embedSrc || (embedOrigin && frame.url.startsWith(embedOrigin))) {
        roots.push(frame.frameId);
      }
    }
  }

  if (!roots.length) {
    for (const frame of frames) {
      if (
        frame.url &&
        (/https:\/\/aprelteam\.gokino\.by\//i.test(frame.url) ||
          /https:\/\/(?:www\.)?gokino\.by\/matrix\//i.test(frame.url) ||
          /https:\/\/(?:www\.)?matrix\.gokino\.by\//i.test(frame.url))
      ) {
        roots.push(frame.frameId);
      }
    }
  }

  if (!roots.length) {
    return [];
  }

  const allIds = new Set();
  for (const rootId of roots) {
    collectDescendantFrameIds(frames, rootId).forEach((id) => allIds.add(id));
  }

  return [...allIds];
}

async function getFilmPlayerFrameId(tabId) {
  const frameIds = await getOverlayPlayerFrameIds(tabId);
  return frameIds.length ? frameIds[frameIds.length - 1] : null;
}

async function ensurePlayerBridgesInTab(tabId) {
  const frameIds = await getOverlayPlayerFrameIds(tabId);
  let injected = 0;

  for (const frameId of frameIds) {
    try {
      await ensurePlayerBridge(tabId, frameId);
      injected += 1;
    } catch {
      /* нет прав на домен или фрейм исчез */
    }
  }

  return { ok: true, injected, total: frameIds.length };
}

async function ensurePlayerBridge(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    files: ['player-bridge.js']
  });
}

async function callPlayerSync(tabId, method, args = {}) {
  await ensurePlayerSyncApi(tabId);
  const wsOrigin = await getSyncServerOrigin();

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (syncMethod, syncArgs, syncWsOrigin) => {
      const api = window.RYH_PlayerSync;
      if (!api) {
        return { ok: false, error: 'Модуль синхронизации недоступен' };
      }

      const overlayFrame = document
        .getElementById('ryh-player-overlay')
        ?.querySelector('.ryh-player-frame');

      if (syncMethod === 'connect') {
        return api.connect({
          roomId: syncArgs.roomId,
          username: syncArgs.username || syncArgs.clientId,
          wsOrigin: syncWsOrigin,
          force: Boolean(syncArgs.force)
        });
      }

      if (syncMethod === 'disconnect') {
        return api.disconnect();
      }

      if (syncMethod === 'broadcastSeek') {
        return api.broadcastSeek(syncArgs.time);
      }

      if (syncMethod === 'broadcastSeekDelta') {
        overlayFrame?.contentWindow?.postMessage(
          {
            source: 'ryh-player-sync-bridge',
            command: 'seek_delta',
            delta: syncArgs.delta
          },
          '*'
        );
        return api.broadcastSeekDelta(syncArgs.delta);
      }

      if (syncMethod === 'getState') {
        return { ok: true, state: api.getState() };
      }

      return { ok: false, error: 'Неизвестное действие синхронизации' };
    },
    args: [method, args, wsOrigin]
  });

  return result?.result || { ok: false, error: 'Нет ответа от модуля синхронизации' };
}

async function joinPlayerSyncInTab(tabId, { service, filmId, force = false } = {}) {
  const roomId = buildSyncRoomId(service, filmId);
  if (!roomId) {
    throw new Error('Не удалось сформировать комнату синхронизации');
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const bridgeResult = await ensurePlayerBridgesInTab(tabId);
    if (bridgeResult.injected > 0) {
      break;
    }
    if (attempt < 23) {
      await sleepMs(500);
    }
  }

  const clientId = await getPlayerSyncClientId();
  const result = await callPlayerSync(tabId, 'connect', {
    roomId,
    username: `ryh_${clientId.slice(0, 8)}`,
    clientId,
    force: Boolean(force)
  });
  if (!result.ok) {
    throw new Error(result.error || 'Не удалось подключиться к синхронизации');
  }

  return { ok: true, roomId, clientId, connected: true };
}

async function rejoinPlayerSyncInTab(tabId, { service, filmId }) {
  await leavePlayerSyncInTab(tabId);
  await sleepMs(350);
  return joinPlayerSyncInTab(tabId, { service, filmId, force: true });
}

async function leavePlayerSyncInTab(tabId) {
  try {
    await callPlayerSync(tabId, 'disconnect');
  } catch {
    /* ignore */
  }

  return { ok: true };
}

async function playerSyncSeekDeltaInTab(tabId, delta) {
  await callPlayerSync(tabId, 'broadcastSeekDelta', { delta: Number(delta) });
  await sleepMs(180);

  const frameIds = await getOverlayPlayerFrameIds(tabId);
  for (const frameId of frameIds) {
    const [timeResult] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        const time = window.RYH_PlayerBridge?.getCurrentTime?.();
        return typeof time === 'number' ? time : null;
      }
    });

    if (typeof timeResult?.result === 'number') {
      return callPlayerSync(tabId, 'broadcastSeek', { time: timeResult.result });
    }
  }

  return { ok: true };
}

async function getPlayerSyncStateInTab(tabId) {
  const result = await callPlayerSync(tabId, 'getState');
  return {
    ok: true,
    ...(result.state || { connected: false, roomId: '', clientId: '' })
  };
}

async function isolateVibixInTab(tabId) {
  if (vibixIsolateInFlight) {
    vibixIsolateQueued = true;
    return;
  }

  vibixIsolateInFlight = true;

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const targetFrames = frames.filter(
      (frame) =>
        frame.url &&
        /https:\/\/(www\.)?reyohoho\.com\/films\//i.test(frame.url)
    );

    if (!targetFrames.length) {
      return;
    }

    await chrome.scripting.executeScript({
      target: {
        tabId,
        frameIds: targetFrames.map((frame) => frame.frameId)
      },
      world: 'MAIN',
      files: ['vibix-isolate.js']
    });
  } finally {
    vibixIsolateInFlight = false;
    if (vibixIsolateQueued) {
      vibixIsolateQueued = false;
      await isolateVibixInTab(tabId);
    }
  }
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function mapMovie(movie) {
  return {
    id: movie.Id,
    name: movie.Name,
    year: movie.Year,
    posterUrl: movie.PosterUrl || '',
    kp: movie.Kp,
    imdb: movie.Imdb
  };
}

function parseInitialMoviesData(html) {
  const match = html.match(
    /<script id="initialMoviesData" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) {
    return [];
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function parseMoviesFromGrid(html) {
  const movies = [];
  const cardPattern =
    /<a class="movie-card-link" href="\/films\/(\d+)">[\s\S]*?<h3 class="movie-title">([\s\S]*?)<\/h3>[\s\S]*?(?:<div class="movie-year">(\d*)<\/div>)?/g;

  let match;
  while ((match = cardPattern.exec(html)) !== null) {
    movies.push({
      Id: Number(match[1]),
      Name: decodeHtmlEntities(match[2].trim()),
      Year: match[3] ? Number(match[3]) : 0,
      PosterUrl: '',
      Kp: '-',
      Imdb: '-'
    });
  }

  const seen = new Set();
  return movies.filter((movie) => {
    if (seen.has(movie.Id)) {
      return false;
    }
    seen.add(movie.Id);
    return true;
  });
}

function readInsAttributes(insTag) {
  const attrs = {};
  const pattern = /data-([a-zA-Z0-9-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(insTag)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseAllPlayers(html, filmId) {
  const players = [];
  const definitions = [
    { id: 'vibix', name: 'Vibix' },
    { id: 'videoseed', name: 'VideoSeed' },
    { id: 'veoveo', name: 'VeoVeo' },
    { id: 'alloha', name: 'Alloha' }
  ];

  for (const def of definitions) {
    const blockMatch = html.match(
      new RegExp(`data-player-pane="${def.id}"[\\s\\S]*?(?=data-player-pane="|film-related-section)`, 'i')
    );
    if (!blockMatch) {
      continue;
    }

    const block = blockMatch[0];
    const iframeMatch = block.match(/data-src="([^"]+)"/);
    if (iframeMatch) {
      players.push({
        id: def.id,
        name: def.name,
        type: 'iframe',
        url: decodeHtmlEntities(iframeMatch[1])
      });
      continue;
    }

    const insMatch = block.match(/<ins[^>]+>/);
    if (insMatch) {
      const attrs = readInsAttributes(insMatch[0]);
      if (attrs.id && attrs.type && attrs['publisher-id']) {
        players.push({
          id: def.id,
          name: def.name,
          type: 'vibix'
        });
      }
    }
  }

  if (!players.length) {
    players.push({
      id: 'page',
      name: 'ReYohoho',
      type: 'iframe',
      url: `${REYOHOHO_ORIGIN}/films/${filmId}`
    });
  }

  return players;
}

function resolvePlayerUrl(player, filmId, pageUrl) {
  if (player.type === 'iframe' && player.url) {
    return player.url;
  }

  if (player.type === 'vibix' || player.id === 'vibix') {
    return pageUrl || `${REYOHOHO_ORIGIN}/films/${filmId}`;
  }

  return pageUrl || `${REYOHOHO_ORIGIN}/films/${filmId}`;
}

function normalizeAprelPosterUrl(url) {
  let resolved = decodeHtmlEntities(String(url || '').trim());
  if (!resolved || /\/uploads\/posts\/watermark\.jpg/i.test(resolved)) {
    return '';
  }

  if (resolved.startsWith('//')) {
    resolved = `https:${resolved}`;
  } else if (resolved.startsWith('/')) {
    resolved = `${APREL_ORIGIN}${resolved}`;
  }

  return resolved;
}

function parseAprelSearchResults(html) {
  const movies = [];
  const seen = new Set();
  const cardPattern = /<article class="scard">([\s\S]*?)<\/article>/gi;

  let cardMatch;
  while ((cardMatch = cardPattern.exec(html)) !== null) {
    const block = cardMatch[1];
    const titleMatch = block.match(/data-copy="title"\s+data-title="([^"]+)"/);
    const linkMatch = block.match(
      /data-copy="link"\s+data-link="(https:\/\/aprelteam\.gokino\.by\/[^"]+)"/
    );

    if (!titleMatch || !linkMatch) {
      continue;
    }

    const titleRaw = decodeHtmlEntities(titleMatch[1].trim());
    const pageUrl = linkMatch[1];
    const path = aprelPathFromUrl(pageUrl);
    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);

    const posterMatch =
      block.match(/class="scard__img[^"]*"[\s\S]*?<img[^>]+src="([^"]+)"/i) ||
      block.match(/class="scard__poster"[\s\S]*?<img[^>]+src="([^"]+)"/i);
    const posterUrl = posterMatch ? normalizeAprelPosterUrl(posterMatch[1]) : '';

    const yearMatch = titleRaw.match(/\((\d{4})\)\s*$/);
    movies.push({
      id: path,
      name: yearMatch ? titleRaw.replace(/\s*\(\d{4}\)\s*$/, '').trim() : titleRaw,
      year: yearMatch ? Number(yearMatch[1]) : 0,
      posterUrl,
      kp: '-',
      imdb: '-'
    });
  }

  return movies;
}

function isAprelFilmPageUrl(url, pageUrl) {
  const resolved = String(url || '').trim();
  if (!resolved) {
    return false;
  }
  if (pageUrl && resolved === String(pageUrl).trim()) {
    return true;
  }
  return /aprelteam\.gokino\.by\/(?:films|serials|mults|anime|nocategory)\/[^?#]+\.html/i.test(
    resolved
  );
}

function pickAprelEmbedPlayer(players, pageUrl) {
  const embedPlayer = players.find(
    (player) => player?.url && !isAprelFilmPageUrl(player.url, pageUrl)
  );
  return embedPlayer || players[0] || null;
}

function parseAprelPlayers(html, pageUrl) {
  const players = [];
  const selectMatch = html.match(/<select id="player-select"[\s\S]*?<\/select>/i);

  if (selectMatch) {
    const optionPattern = /<option value="([^"]*)">([\s\S]*?)<\/option>/gi;
    let optionMatch;
    let index = 0;

    while ((optionMatch = optionPattern.exec(selectMatch[0])) !== null) {
      const url = resolveAprelPlayerUrl(optionMatch[1], pageUrl);
      const name = decodeHtmlEntities(optionMatch[2].replace(/<[^>]+>/g, '').trim());
      if (!url || !name || /выбор/i.test(name)) {
        continue;
      }
      if (isAprelFilmPageUrl(url, pageUrl)) {
        continue;
      }

      index += 1;
      players.push({
        id: `player-${index}`,
        name: name || `Плеер ${index}`,
        type: 'iframe',
        url
      });
    }
  }

  if (!players.length) {
    const iframeMatch = html.match(/<iframe id="film_main"[^>]*data-src="([^"]+)"/i);
    if (iframeMatch) {
      const url = resolveAprelPlayerUrl(iframeMatch[1], pageUrl);
      if (url) {
        players.push({
          id: 'default',
          name: 'Aprel',
          type: 'iframe',
          url
        });
      }
    }
  }

  if (!players.length) {
    players.push({
      id: 'page',
      name: 'Aprel Kino',
      type: 'iframe',
      url: pageUrl
    });
  }

  return players;
}

async function searchAprelMovies(query) {
  const path = `/?do=search&mode=advanced&subaction=search&story=${encodeURIComponent(query.trim())}`;
  const html = await fetchAprelHtml(path);
  return parseAprelSearchResults(html);
}

async function getAprelPlayerEmbed(filmId) {
  const filmPath = normalizeAprelPath(filmId);
  const pagePath = `/${filmPath}.html`;
  const html = await fetchAprelHtml(pagePath);
  const pageUrl = aprelPageUrlFromPath(filmPath);
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : `Фильм ${filmPath}`;
  const players = parseAprelPlayers(html, pageUrl);
  const defaultPlayer = pickAprelEmbedPlayer(players, pageUrl);
  if (!defaultPlayer?.url || isAprelFilmPageUrl(defaultPlayer.url, pageUrl)) {
    throw new Error('Не удалось найти embed-плеер Aprel для этого фильма');
  }

  return {
    filmId: filmPath,
    title,
    pageUrl,
    players,
    activePlayerId: defaultPlayer.id,
    embedUrl: defaultPlayer.url,
    service: 'aprel'
  };
}

async function searchReyohohoMovies(query) {
  const path = `/?q=${encodeURIComponent(query.trim())}`;
  const html = await fetchReyohohoHtml(path);
  let raw = parseInitialMoviesData(html);

  if (!raw.length) {
    raw = parseMoviesFromGrid(html);
  }

  return raw.map(mapMovie);
}

async function getReyohohoPlayerEmbed(filmId) {
  const path = `/films/${filmId}`;
  const html = await fetchReyohohoHtml(path);
  const url = `${REYOHOHO_ORIGIN}/films/${filmId}`;
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch
    ? decodeHtmlEntities(
        titleMatch[1].replace(/\s*-\s*ReYohoho\s*$/, '').trim()
      )
    : `Фильм ${filmId}`;

  const players = parseAllPlayers(html, filmId);
  const defaultPlayer =
    players.find((player) => player.id === 'videoseed') ||
    players.find((player) => player.type === 'iframe') ||
    players[0];

  return {
    filmId,
    title,
    pageUrl: url,
    players,
    activePlayerId: defaultPlayer.id,
    embedUrl: resolvePlayerUrl(defaultPlayer, filmId, url)
  };
}

async function searchMovies(query, service) {
  const resolvedService = service || (await getVideoService());
  if (resolvedService === 'matrix') {
    return [];
  }
  if (resolvedService === 'aprel') {
    return searchAprelMovies(query);
  }
  return searchReyohohoMovies(query);
}

async function getPlayerEmbed(filmId, service) {
  const resolvedService =
    resolveVideoService(filmId, service) || (await getVideoService());

  if (resolvedService === 'aprel') {
    return getAprelPlayerEmbed(filmId);
  }

  if (resolvedService === 'matrix') {
    return getMatrixPlayerEmbed(filmId);
  }

  return getReyohohoPlayerEmbed(filmId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'searchMovies') {
    searchMovies(message.query, message.service)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getPlayerEmbed') {
    getPlayerEmbed(message.filmId, message.service)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'isolateVibixFrame') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    isolateVibixInTab(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'joinWatchParty') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    joinWatchPartyInTab(tabId, message.filmId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'leaveWatchParty') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    leaveWatchPartyInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'createYoutubeRoom') {
    RYH_WatchParty.createWatchPartyRoom()
      .then(async (room) => {
        const youtubeRoomState = {
          roomId: room.roomId,
          roomUrl: room.roomUrl,
          slug: room.slug
        };
        await chrome.storage.local.set({ youtubeRoomState });
        sendResponse({ ok: true, data: youtubeRoomState });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'addToWatchPartyQueue') {
    const roomId = message.roomId;
    const videoUrl = message.videoUrl;

    RYH_WatchParty.addVideoToWatchPartyQueue(roomId, videoUrl)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'clearYoutubeRoom') {
    RYH_WatchParty.disconnectWatchPartySockets()
      .then(async () => {
        await chrome.storage.local.remove('youtubeRoomState');
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'setWatchpartyControlsVisible') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    setWatchPartyControlsVisibleInTab(tabId, Boolean(message.visible))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'resetWatchpartyLayout') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    resetWatchPartyLayoutInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getWatchpartyVideoTitle') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    getWatchPartyVideoTitleInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'skipWatchPartyVideo') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    skipWatchPartyVideoInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getYoutubeJoinState') {
    findLiveYoutubeSession()
      .then(async (session) => {
        if (session) {
          sendResponse({
            ok: true,
            joined: true,
            roomId: session.roomId,
            roomUrl: session.roomUrl
          });
          return;
        }

        await clearYoutubeSessionIfNoLiveTab();
        sendResponse({ ok: true, joined: false, roomId: null, roomUrl: '' });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'ensurePlayerBridgeInTab') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    ensurePlayerBridgesInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'joinPlayerSync') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    joinPlayerSyncInTab(tabId, {
      service: message.service,
      filmId: message.filmId
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'rejoinPlayerSync') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    rejoinPlayerSyncInTab(tabId, {
      service: message.service,
      filmId: message.filmId
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'leavePlayerSync') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    leavePlayerSyncInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'playerSyncSeekDelta') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    playerSyncSeekDeltaInTab(tabId, message.delta)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getPlayerSyncState') {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Вкладка не найдена' });
      return false;
    }

    getPlayerSyncStateInTab(tabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
