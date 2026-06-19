const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const selectedFilmEl = document.getElementById('selectedFilm');
const selectedFilmTitle = document.getElementById('selectedFilmTitle');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const copyRoomLinkBtn = document.getElementById('copyRoomLinkBtn');
const replaceBtn = document.getElementById('replaceBtn');
const replaceYoutubeBtn = document.getElementById('replaceYoutubeBtn');
const restoreBtn = document.getElementById('restoreBtn');
const statusBadge = document.getElementById('statusBadge');
const messageEl = document.getElementById('message');
const logoText = document.getElementById('logoText');
const serviceReyohohoBtn = document.getElementById('serviceReyohoho');
const serviceAprelBtn = document.getElementById('serviceAprel');
const serviceMatrixBtn = document.getElementById('serviceMatrix');
const searchLabel = document.getElementById('searchLabel');
const syncToggleWrap = document.getElementById('syncToggleWrap');
const syncToggle = document.getElementById('syncToggle');

const SEARCH_DELAY_MS = 500;
const SERVICE_LABELS = {
  reyohoho: 'ReYohoho',
  aprel: 'Aprel',
  matrix: 'Matrix'
};

let searchTimer = null;
let searchRequestId = 0;
let selectedFilm = null;
let lastSearchResults = [];
let activePlayerFilmId = null;
let activeYoutubeSlug = null;
let videoService = 'reyohoho';

function showMessage(text, type = '') {
  messageEl.textContent = text || '';
  messageEl.className = `message ${type}`.trim();
}

function escapeHtml(text) {
  const el = document.createElement('div');
  el.textContent = text;
  return el.innerHTML;
}

function getServiceLabel(service = videoService) {
  return SERVICE_LABELS[service] || SERVICE_LABELS.reyohoho;
}

function updateServiceUi() {
  const isAprel = videoService === 'aprel';
  const isMatrix = videoService === 'matrix';
  serviceReyohohoBtn.classList.toggle('active', videoService === 'reyohoho');
  serviceAprelBtn.classList.toggle('active', isAprel);
  serviceAprelBtn.classList.toggle('aprel', isAprel);
  serviceMatrixBtn.classList.toggle('active', isMatrix);
  serviceMatrixBtn.classList.toggle('matrix', isMatrix);
  logoText.textContent = getServiceLabel();
  logoText.classList.toggle('aprel', isAprel);
  logoText.classList.toggle('matrix', isMatrix);
  searchLabel.textContent = isMatrix ? 'ID Кинопоиска' : 'Поиск фильма';
  searchInput.placeholder = isMatrix ? 'Например: 46959' : 'Название фильма...';
  updateReplaceButton();
}

async function setVideoService(service) {
  videoService =
    service === 'matrix' ? 'matrix' : service === 'reyohoho' ? 'reyohoho' : 'aprel';
  await chrome.storage.local.set({ videoService });
  updateServiceUi();
  clearSelection();
  searchResults.classList.add('hidden');
  searchResults.innerHTML = '';
  showMessage('');
}

function updateSyncToggleUi(active, mode, syncEnabled = false) {
  const supported = active && (mode === 'aprel' || mode === 'matrix');
  syncToggleWrap.classList.toggle('hidden', !supported);
  if (supported) {
    syncToggle.checked = Boolean(syncEnabled);
  }
}

function setFilmActive(active, service = videoService) {
  const label = getServiceLabel(service);
  statusBadge.textContent = active ? label : 'Twitch';
  statusBadge.className = `badge${active ? ' active' : ''}${active && service === 'aprel' ? ' aprel' : ''}${active && service === 'matrix' ? ' matrix' : ''}`;
  restoreBtn.classList.toggle('hidden', !active);
  if (active) {
    clearYoutubeRoomSelection();
  }
}

function setReyohohoActive(active) {
  setFilmActive(active, 'reyohoho');
}

function setYoutubeActive(active, roomUrl = '', roomId = '') {
  statusBadge.textContent = active ? 'YouTube' : 'Twitch';
  statusBadge.className = `badge${active ? ' youtube' : ''}`;
  restoreBtn.classList.toggle('hidden', !active);
  updateSyncToggleUi(false, 'youtube', false);
  if (active) {
    applyYoutubeRoomFromState({ roomId, roomUrl });
    return;
  }

  clearYoutubeRoomSelection();
}

function applyFilmFromPlayerState(state) {
  if (!state?.filmId) {
    return;
  }

  activePlayerFilmId = state.filmId;
  const service =
    state.mode === 'matrix' ? 'matrix' : state.mode === 'aprel' ? 'aprel' : 'reyohoho';

  if (!selectedFilm?.id || selectedFilm.id !== state.filmId) {
    selectedFilm = {
      id: state.filmId,
      name: state.title || `Фильм ${state.filmId}`,
      year: '',
      service
    };
    selectedFilmTitle.textContent = state.title || `Фильм #${state.filmId}`;
    selectedFilmEl.classList.remove('hidden');
    updateReplaceButton();
  }
}

function getMatrixShareLink(kpId) {
  return `mtr-${String(kpId || '').replace(/\D/g, '')}`;
}

function getAprelShareLink(filmPath) {
  const normalized = String(filmPath || '')
    .replace(/^https?:\/\/(?:www\.)?aprelteam\.gokino\.by\//i, '')
    .replace(/^\//, '')
    .replace(/\.html$/i, '');
  return `apr-${normalized.replace(/\//g, '--')}`;
}

function getRyhShareLink(value) {
  return `ryh-${value}`;
}

function getFilmShareLink(filmId, service = videoService) {
  if (service === 'matrix') {
    return getMatrixShareLink(filmId);
  }
  if (service === 'aprel') {
    return getAprelShareLink(filmId);
  }
  return getRyhShareLink(filmId);
}

function getWatchPartyShareLink(slug) {
  return getRyhShareLink(slug);
}

function extractWatchPartySlug(roomId, roomUrl) {
  const fromId = String(roomId || '')
    .trim()
    .replace(/^\//, '');
  if (fromId) {
    return fromId;
  }

  const match = String(roomUrl || '').match(/watchparty\.me\/watch\/([a-z0-9-]+)/i);
  return match?.[1] || '';
}

function applyYoutubeRoomFromState(state) {
  const slug = extractWatchPartySlug(state?.roomId, state?.roomUrl);
  activeYoutubeSlug = slug || null;
  copyRoomLinkBtn.classList.toggle('hidden', !slug);
}

function clearYoutubeRoomSelection() {
  activeYoutubeSlug = null;
  copyRoomLinkBtn.classList.add('hidden');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

async function copyRoomLink() {
  if (!activeYoutubeSlug) {
    showMessage('Комната не активна', 'error');
    return;
  }

  const link = getWatchPartyShareLink(activeYoutubeSlug);

  try {
    await copyTextToClipboard(link);
    copyRoomLinkBtn.classList.add('copied');
    copyRoomLinkBtn.title = 'Скопировано';
    showMessage('Ссылка на комнату скопирована', 'success');
    setTimeout(() => {
      copyRoomLinkBtn.classList.remove('copied');
      copyRoomLinkBtn.title = 'Копировать ссылку';
    }, 2000);
  } catch {
    showMessage('Не удалось скопировать ссылку', 'error');
  }
}
async function copyFilmLink() {
  if (!selectedFilm?.id) {
    showMessage('Сначала выберите фильм', 'error');
    return;
  }

  const link = getFilmShareLink(selectedFilm.id, selectedFilm.service || videoService);

  try {
    await copyTextToClipboard(link);
    copyLinkBtn.classList.add('copied');
    copyLinkBtn.title = 'Скопировано';
    showMessage('Ссылка скопирована', 'success');
    setTimeout(() => {
      copyLinkBtn.classList.remove('copied');
      copyLinkBtn.title = 'Копировать ссылку';
    }, 2000);
  } catch {
    showMessage('Не удалось скопировать ссылку', 'error');
  }
}

function updateReplaceButton() {
  const canReplace = Boolean(selectedFilm?.id);
  replaceBtn.disabled = !canReplace;
  replaceBtn.textContent = `Заменить на ${getServiceLabel()}`;
}

function clearSelection() {
  selectedFilm = null;
  selectedFilmEl.classList.add('hidden');
  selectedFilmTitle.textContent = '';
  updateReplaceButton();
}

function selectFilm(movie) {
  selectedFilm = {
    id: movie.id,
    name: movie.name,
    year: movie.year,
    service: videoService
  };

  selectedFilmTitle.textContent = `${movie.name}${movie.year ? ` (${movie.year})` : ''}`;
  selectedFilmEl.classList.remove('hidden');
  updateReplaceButton();
  showMessage(`Нажмите «Заменить на ${getServiceLabel()}»`, '');

  searchResults.classList.add('hidden');
}

function setReplaceLoading(loading) {
  replaceBtn.disabled = loading || !selectedFilm?.id;
  replaceBtn.textContent = loading ? 'Загрузка...' : `Заменить на ${getServiceLabel()}`;
}

function setYoutubeReplaceLoading(loading) {
  replaceYoutubeBtn.disabled = loading;
  replaceYoutubeBtn.textContent = loading ? 'Создание комнаты...' : 'Заменить на YouTube';
}

function isStaleContentScriptError(error) {
  const message = String(error?.message || error);
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection') ||
    message.includes('Extension context invalidated')
  );
}

async function runtimeMessage(payload) {
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response) {
      throw new Error('Нет ответа от расширения. Обновите его на chrome://extensions/');
    }
    return response;
  } catch (error) {
    let message = error.message || 'Ошибка расширения';
    if (message.includes('Extension context invalidated')) {
      message = 'Расширение было обновлено. Обновите страницу Twitch (F5).';
    } else if (message === 'Failed to fetch') {
      const messages = {
        matrix:
          'Не удалось подключиться к gokino.by / matrix.gokino.by. Проверьте интернет и обновите расширение.',
        aprel:
          'Не удалось подключиться к aprelteam.gokino.by. Проверьте интернет и обновите расширение.',
        reyohoho:
          'Не удалось подключиться к reyohoho.com. Проверьте интернет и обновите расширение.'
      };
      message = messages[videoService] || messages.reyohoho;
    }
    throw new Error(message);
  }
}

async function getActiveTwitchTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes('twitch.tv')) {
    return null;
  }
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (ping?.ok) {
      return true;
    }
  } catch {
    /* inject below */
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.__RYH_TWITCH_LOADED__ = false;
    }
  });

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content.css']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['extension-utils.js', 'content.js']
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return true;
}

async function sendToContentScript(type, payload = {}, retried = false) {
  const tab = await getActiveTwitchTab();
  if (!tab) {
    throw new Error('Откройте страницу Twitch');
  }

  await ensureContentScript(tab.id);

  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...payload });
  } catch (error) {
    if (!retried && isStaleContentScriptError(error)) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.__RYH_TWITCH_LOADED__ = false;
        }
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['extension-utils.js', 'content.js']
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      return sendToContentScript(type, payload, true);
    }

    if (isStaleContentScriptError(error)) {
      throw new Error('Расширение было обновлено. Обновите страницу Twitch (F5).');
    }
    throw error;
  }
}

function renderResults(results) {
  lastSearchResults = results;

  if (!results.length) {
    searchResults.innerHTML = '<div class="loading">Ничего не найдено</div>';
    searchResults.classList.remove('hidden');
    return;
  }

  searchResults.innerHTML = results
    .map(
      (movie) => `
      <button
        class="result-item${selectedFilm?.id === movie.id ? ' selected' : ''}"
        data-id="${escapeHtml(String(movie.id))}"
        type="button"
      >
        ${
          movie.posterUrl
            ? `<img class="result-poster" src="${escapeHtml(movie.posterUrl)}" alt="" />`
            : '<div class="result-poster placeholder">—</div>'
        }
        <div class="result-info">
          <div class="result-title">${escapeHtml(movie.name)}</div>
          <div class="result-meta">${movie.year || '—'} · KP ${movie.kp || '—'}</div>
        </div>
      </button>`
    )
    .join('');

  searchResults.querySelectorAll('.result-item').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.id;
      const movie = lastSearchResults.find((item) => String(item.id) === id);
      if (movie) {
        selectFilm(movie);
      }
    });
  });

  searchResults.classList.remove('hidden');
}

async function runSearch(query) {
  if (videoService === 'matrix') {
    return;
  }

  const requestId = ++searchRequestId;

  searchResults.innerHTML = '<div class="loading">Поиск...</div>';
  searchResults.classList.remove('hidden');

  try {
    const response = await runtimeMessage({
      type: 'searchMovies',
      query,
      service: videoService
    });

    if (requestId !== searchRequestId) {
      return;
    }

    if (!response.ok) {
      searchResults.innerHTML = `<div class="loading">${escapeHtml(response.error || 'Ошибка поиска')}</div>`;
      showMessage(response.error || 'Ошибка поиска', 'error');
      return;
    }

    renderResults(response.results);
    showMessage('');
  } catch (error) {
    if (requestId !== searchRequestId) {
      return;
    }
    searchResults.innerHTML = `<div class="loading">${escapeHtml(error.message)}</div>`;
    showMessage(error.message, 'error');
  }
}

copyLinkBtn.addEventListener('click', () => {
  copyFilmLink();
});

copyRoomLinkBtn.addEventListener('click', () => {
  copyRoomLink();
});

serviceReyohohoBtn.addEventListener('click', () => {
  if (videoService !== 'reyohoho') {
    setVideoService('reyohoho');
  }
});

serviceAprelBtn.addEventListener('click', () => {
  if (videoService !== 'aprel') {
    setVideoService('aprel');
  }
});

serviceMatrixBtn.addEventListener('click', () => {
  if (videoService !== 'matrix') {
    setVideoService('matrix');
  }
});

function handleMatrixInput(rawValue) {
  const kpId = String(rawValue || '').trim();
  if (!/^\d{3,}$/.test(kpId)) {
    clearSelection();
    return;
  }

  selectedFilm = {
    id: kpId,
    name: `Кинопоиск #${kpId}`,
    year: '',
    service: 'matrix'
  };
  selectedFilmTitle.textContent = selectedFilm.name;
  selectedFilmEl.classList.remove('hidden');
  updateReplaceButton();
  showMessage(`Нажмите «Заменить на ${getServiceLabel()}»`, '');
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  clearSelection();

  const query = searchInput.value.trim();
  if (videoService === 'matrix') {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    if (query.length >= 3) {
      handleMatrixInput(query);
    } else {
      showMessage(query.length ? 'ID Кинопоиска — минимум 3 цифры' : '');
    }
    return;
  }

  if (query.length < 2) {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    showMessage('');
    return;
  }

  searchTimer = setTimeout(() => {
    runSearch(query);
  }, SEARCH_DELAY_MS);
});

searchInput.addEventListener('focus', () => {
  if (searchResults.innerHTML && searchInput.value.trim().length >= 2) {
    searchResults.classList.remove('hidden');
  }
});

replaceBtn.addEventListener('click', async () => {
  if (!selectedFilm?.id) {
    showMessage('Выберите фильм из списка', 'error');
    return;
  }

  setReplaceLoading(true);
  showMessage('Загрузка плеера...', '');

  try {
    const filmService = selectedFilm.service || videoService;
    const embedResponse = await runtimeMessage({
      type: 'getPlayerEmbed',
      filmId: selectedFilm.id,
      service: filmService
    });

    if (!embedResponse.ok) {
      throw new Error(embedResponse.error || 'Ошибка загрузки плеера');
    }

    const response = await sendToContentScript('replacePlayer', {
      filmId: selectedFilm.id,
      embedUrl: embedResponse.data.embedUrl,
      title: embedResponse.data.title,
      pageUrl: embedResponse.data.pageUrl,
      players: embedResponse.data.players,
      activePlayerId: embedResponse.data.activePlayerId,
      service: embedResponse.data.service || filmService
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Не удалось заменить плеер');
    }

    setFilmActive(true, filmService);
    showMessage(`Воспроизводится: ${embedResponse.data.title}`, 'success');
    searchResults.classList.add('hidden');
  } catch (error) {
    showMessage(error.message, 'error');
  } finally {
    setReplaceLoading(false);
  }
});

replaceYoutubeBtn.addEventListener('click', async () => {
  setYoutubeReplaceLoading(true);
  showMessage('Создание комнаты WatchParty...', '');

  try {
    const roomResponse = await runtimeMessage({
      type: 'createYoutubeRoom'
    });

    if (!roomResponse.ok) {
      throw new Error(roomResponse.error || 'Не удалось создать комнату');
    }

    const { roomUrl, roomId } = roomResponse.data;

    const response = await sendToContentScript('replaceYoutubePlayer', {
      roomId,
      roomUrl
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Не удалось заменить плеер');
    }

    setYoutubeActive(true, roomUrl, roomId);

    const stateResponse = await sendToContentScript('getState');
    showMessage(
      stateResponse?.title && stateResponse.title !== 'YouTube'
        ? `Сейчас: ${stateResponse.title}`
        : 'Комната создана. Добавляйте видео с YouTube.',
      'success'
    );
  } catch (error) {
    showMessage(error.message, 'error');
  } finally {
    setYoutubeReplaceLoading(false);
  }
});

restoreBtn.addEventListener('click', async () => {
  try {
    const stateResponse = await sendToContentScript('getState');
    const response = await sendToContentScript('restorePlayer');
    if (response?.ok) {
      if (stateResponse?.mode === 'youtube') {
        await runtimeMessage({ type: 'clearYoutubeRoom' });
        setYoutubeActive(false);
      } else {
        setFilmActive(false, stateResponse?.mode === 'aprel' ? 'aprel' : stateResponse?.mode === 'matrix' ? 'matrix' : 'reyohoho');
      }
      activePlayerFilmId = null;
      showMessage('Плеер Twitch восстановлен', 'success');
    }
  } catch (error) {
    showMessage(error.message, 'error');
  }
});

document.addEventListener('click', (event) => {
  const inSearch = event.target.closest('.search-section');
  if (!inSearch) {
    searchResults.classList.add('hidden');
  }
});

async function syncState() {
  updateReplaceButton();

  const tab = await getActiveTwitchTab();
  if (!tab) {
    showMessage('Откройте страницу Twitch', 'error');
    return;
  }

  try {
    await ensureContentScript(tab.id);
    const response = await sendToContentScript('getState');
    if (response?.active && response.mode === 'youtube') {
      setYoutubeActive(true, response.roomUrl, response.roomId);
      showMessage(
        response.title && response.title !== 'YouTube'
          ? `Сейчас: ${response.title}`
          : '',
        'success'
      );
    } else if (response?.active && response.filmId) {
      clearYoutubeRoomSelection();
      const service =
        response.mode === 'matrix' ? 'matrix' : response.mode === 'aprel' ? 'aprel' : 'reyohoho';
      setFilmActive(true, service);
      updateSyncToggleUi(true, service, response.syncEnabled);
      applyFilmFromPlayerState(response);
      showMessage(response.title ? `Сейчас: ${response.title}` : '', 'success');
    } else {
      activePlayerFilmId = null;
      clearYoutubeRoomSelection();
      updateSyncToggleUi(false, videoService, false);
      if (!selectedFilm?.id) {
        showMessage('');
      }
    }
  } catch {
    showMessage('');
  }
}

async function initPopup() {
  const stored = await chrome.storage.local.get(['videoService', 'playerSyncEnabled']);
  videoService =
    stored.videoService === 'reyohoho'
      ? 'reyohoho'
      : stored.videoService === 'matrix'
        ? 'matrix'
        : 'aprel';
  updateServiceUi();
  if (typeof stored.playerSyncEnabled === 'boolean') {
    syncToggle.checked = stored.playerSyncEnabled;
  }
  await syncState();
}

syncToggle?.addEventListener('change', async () => {
  const enabled = syncToggle.checked;
  await chrome.storage.local.set({ playerSyncEnabled: enabled });

  const tab = await getActiveTwitchTab();
  if (!tab) {
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await sendToContentScript('setPlayerSyncEnabled', { enabled });
  } catch {
    /* ignore */
  }
});

initPopup();
