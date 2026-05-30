importScripts('socket.io.min.js', 'watchparty.js');

const REYOHOHO_ORIGIN = 'https://reyohoho.com';
const REYOHOHO_ORIGINS = ['https://reyohoho.com', 'https://www.reyohoho.com'];

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

async function searchMovies(query) {
  const path = `/?q=${encodeURIComponent(query.trim())}`;
  const html = await fetchReyohohoHtml(path);
  let raw = parseInitialMoviesData(html);

  if (!raw.length) {
    raw = parseMoviesFromGrid(html);
  }

  return raw.map(mapMovie);
}

async function getPlayerEmbed(filmId) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'searchMovies') {
    searchMovies(message.query)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getPlayerEmbed') {
    getPlayerEmbed(message.filmId)
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

  return false;
});
