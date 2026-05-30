(() => {
  if (window.RYH_VibixSync) {
    return;
  }

  const SYNC_LIB_URL = 'https://sync.videoframe2.com/sync-lib.js';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function loadSyncLib() {
    return new Promise((resolve, reject) => {
      if (window.WatchParty) {
        resolve();
        return;
      }

      const existing = document.querySelector(`script[src="${SYNC_LIB_URL}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener(
          'error',
          () => reject(new Error('Не удалось загрузить sync-lib.js')),
          { once: true }
        );
        return;
      }

      const script = document.createElement('script');
      script.src = SYNC_LIB_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Не удалось загрузить sync-lib.js'));
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function findVibixPlayerIframe() {
    const pane = document.querySelector('[data-player-pane="vibix"]');
    if (!pane) {
      return null;
    }

    const iframes = [...pane.querySelectorAll('iframe')].filter(
      (frame) => frame.src && !frame.src.startsWith('about:')
    );

    const nested = pane.querySelector('.film-vibix-frame iframe');
    if (nested?.src && !nested.src.startsWith('about:')) {
      return nested;
    }

    const playerFrame = iframes.find((frame) =>
      /videoframe|vibix|embed|player/i.test(frame.src)
    );

    return playerFrame || iframes[iframes.length - 1] || null;
  }

  function waitForIframeReady(iframe, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        resolve();
      };

      iframe.addEventListener('load', finish, { once: true });

      try {
        if (iframe.contentDocument?.readyState === 'complete' && iframe.src) {
          finish();
          return;
        }
      } catch {
        /* cross-origin iframe */
      }

      setTimeout(finish, timeoutMs);
    });
  }

  async function ensureSyncParamOnIframe(iframe) {
    if (!iframe?.src || iframe.src.startsWith('about:')) {
      return iframe;
    }

    try {
      const url = new URL(iframe.src);
      if (url.searchParams.has('sync')) {
        return iframe;
      }

      url.searchParams.set('sync', 'true');
      iframe.src = url.toString();
      await waitForIframeReady(iframe, 10000);
      await sleep(700);
    } catch {
      /* ignore malformed iframe URL */
    }

    return iframe;
  }

  async function waitForVibixPlayerIframe() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const iframe = findVibixPlayerIframe();
      if (iframe) {
        await waitForIframeReady(iframe);
        await sleep(400);
        return iframe;
      }
      await sleep(250);
    }

    throw new Error('Плеер Vibix ещё не загружен');
  }

  async function waitForWatchPartyReady(timeoutMs = 25000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const instance = window.watchPartyInstance;
      if (
        instance?.state?.connected &&
        instance.roleAssigned &&
        instance.state.playerReady
      ) {
        return instance;
      }

      if (instance?.state?.connected && instance.roleAssigned) {
        instance.sendCommandToPlayer?.('getState');
      }

      await sleep(350);
    }

    const instance = window.watchPartyInstance;
    if (instance?.state?.connected && instance.roleAssigned) {
      return instance;
    }

    return null;
  }

  function destroyWatchPartyInstance() {
    if (window.watchPartyInstance) {
      window.watchPartyInstance.destroy();
    }
  }

  async function join(filmId) {
    const numericId = Number(filmId);
    if (!numericId) {
      return { ok: false, error: 'Некорректный ID фильма' };
    }

    const roomId = `film_${numericId}`;
    const existing = window.watchPartyInstance;

    if (
      existing?.roomId === roomId &&
      existing.state?.connected &&
      existing.roleAssigned
    ) {
      return {
        ok: true,
        already: true,
        roomId,
        connected: true,
        playerReady: Boolean(existing.state?.playerReady)
      };
    }

    if (window.__RYH_VIBIX_SYNC_JOINING__ === roomId) {
      return { ok: true, already: true, roomId, pending: true };
    }

    window.__RYH_VIBIX_SYNC_JOINING__ = roomId;

    try {
      await loadSyncLib();

      if (!window.WatchParty) {
        return { ok: false, error: 'WatchParty недоступен' };
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        destroyWatchPartyInstance();
        await sleep(400);

        let iframe = await waitForVibixPlayerIframe();
        iframe = await ensureSyncParamOnIframe(iframe);

        new window.WatchParty({
          iframe,
          roomId
        });

        const instance = await waitForWatchPartyReady(22000);
        if (instance) {
          return {
            ok: true,
            roomId,
            connected: Boolean(instance.state?.connected),
            playerReady: Boolean(instance.state?.playerReady)
          };
        }

        destroyWatchPartyInstance();
        await sleep(1200);
      }

      return { ok: false, error: 'Не удалось подключиться к совместному просмотру' };
    } finally {
      window.__RYH_VIBIX_SYNC_JOINING__ = null;
    }
  }

  function leave() {
    window.__RYH_VIBIX_SYNC_JOINING__ = null;

    if (window.watchPartyInstance) {
      window.watchPartyInstance.destroy();
      return { ok: true, left: true };
    }

    return { ok: true, left: false };
  }

  window.RYH_VibixSync = {
    join,
    leave
  };
})();
