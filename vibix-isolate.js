(() => {
  if (!/reyohoho\.com$/i.test(location.hostname)) {
    return;
  }
  if (!/^\/films\//.test(location.pathname)) {
    return;
  }

  const MAX_INNER_RELOADS = 2;
  const MAX_PARENT_RETRIES = 2;
  const POST_LOAD_DELAY_MS = 1200;

  function postRetryToParent() {
    const retries = window.__RYH_VIBIX_PARENT_RETRIES__ || 0;
    if (retries >= MAX_PARENT_RETRIES) {
      return;
    }
    window.__RYH_VIBIX_PARENT_RETRIES__ = retries + 1;
    try {
      window.parent.postMessage({ type: 'ryh-vibix-retry' }, '*');
    } catch {
      /* ignore */
    }
  }

  function notifyIsolated() {
    try {
      window.parent.postMessage({ type: 'ryh-vibix-isolated' }, '*');
    } catch {
      /* ignore */
    }
  }

  function whenPlayerReady(pane, callback) {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      callback();
    };

    const playerIframe = pane.querySelector('iframe');
    const playerIns = pane.querySelector('ins[data-publisher-id]');

    if (playerIframe) {
      playerIframe.addEventListener('load', finish, { once: true });
      try {
        if (playerIframe.contentDocument?.readyState === 'complete') {
          finish();
          return;
        }
      } catch {
        /* cross-origin iframe */
      }
      setTimeout(finish, POST_LOAD_DELAY_MS + 800);
      return;
    }

    if (playerIns) {
      setTimeout(finish, POST_LOAD_DELAY_MS);
      return;
    }

    setTimeout(finish, 800);
  }

  function applyPaneLayout(pane) {
    pane.style.cssText =
      'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;' +
      'margin:0!important;padding:0!important;z-index:2147483647!important;background:#000!important;' +
      'display:block!important';

    const vibixFrame = pane.querySelector('.film-vibix-frame');
    if (vibixFrame) {
      vibixFrame.style.cssText =
        'width:100%!important;height:100%!important;min-height:100%!important;display:block!important';
    }

    pane.querySelectorAll('iframe').forEach((frame) => {
      frame.style.cssText =
        'width:100%!important;height:100%!important;border:0!important;display:block!important';
    });
  }

  function isPageCropped(pane) {
    return (
      pane &&
      document.body.contains(pane) &&
      document.body.childElementCount === 1 &&
      document.body.firstElementChild === pane
    );
  }

  function cropPageToPane(pane) {
    document.documentElement.style.cssText =
      'overflow:hidden!important;background:#000!important';
    document.body.style.cssText =
      'margin:0!important;overflow:hidden!important;background:#000!important';

    if (pane.parentElement !== document.body) {
      document.body.appendChild(pane);
    }

    if (!isPageCropped(pane)) {
      document.body.replaceChildren(pane);
    }

    applyPaneLayout(pane);
  }

  function hasConnectionError(doc) {
    const text = doc?.body?.innerText || '';
    return /подключение было сброшено|connection was reset|err_connection|net::err_/i.test(text);
  }

  function reloadInnerFrame(frame) {
    const reloads = window.__RYH_VIBIX_INNER_RELOADS__ || 0;
    if (reloads >= MAX_INNER_RELOADS) {
      postRetryToParent();
      return;
    }
    window.__RYH_VIBIX_INNER_RELOADS__ = reloads + 1;

    try {
      const src = frame.src;
      frame.src = '';
      frame.src = src;
    } catch {
      postRetryToParent();
    }
  }

  function watchPlayerHealth(pane) {
    if (window.__RYH_VIBIX_HEALTH_WATCH__) {
      return;
    }
    window.__RYH_VIBIX_HEALTH_WATCH__ = true;

    const check = () => {
      if (!pane.isConnected || !window.__RYH_VIBIX_ISOLATED__) {
        return;
      }

      const frames = pane.querySelectorAll('iframe');
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (doc && hasConnectionError(doc)) {
            reloadInnerFrame(frame);
            return;
          }
        } catch {
          /* cross-origin iframe */
        }
      }
    };

    setTimeout(check, 4000);
    setTimeout(check, 9000);
    setInterval(check, 15000);
  }

  function finishIsolate(pane) {
    if (window.__RYH_VIBIX_ISOLATED__ && isPageCropped(pane)) {
      applyPaneLayout(pane);
      window.__RYH_VIBIX_ISOLATING__ = false;
      notifyIsolated();
      return;
    }

    cropPageToPane(pane);
    window.__RYH_VIBIX_ISOLATED__ = true;
    window.__RYH_VIBIX_ISOLATING__ = false;
    watchPlayerHealth(pane);
    notifyIsolated();
  }

  const pane = document.querySelector('[data-player-pane="vibix"]');
  if (window.__RYH_VIBIX_ISOLATED__ && isPageCropped(pane)) {
    applyPaneLayout(pane);
    return;
  }

  if (window.__RYH_VIBIX_ISOLATING__) {
    return;
  }

  window.__RYH_VIBIX_ISOLATING__ = true;

  const tryIsolate = (attempt) => {
    if (window.__RYH_VIBIX_ISOLATED__) {
      const currentPane = document.querySelector('[data-player-pane="vibix"]');
      if (isPageCropped(currentPane)) {
        applyPaneLayout(currentPane);
        window.__RYH_VIBIX_ISOLATING__ = false;
        return;
      }
    }

    if (window.__RYH_VIBIX_ISOLATE_SCHEDULED__) {
      return;
    }

    const currentPane = document.querySelector('[data-player-pane="vibix"]');
    if (!currentPane) {
      if (attempt < 80) {
        setTimeout(() => tryIsolate(attempt + 1), 250);
      } else {
        window.__RYH_VIBIX_ISOLATING__ = false;
      }
      return;
    }

    const playerIframe = currentPane.querySelector('iframe');
    const playerIns = currentPane.querySelector('ins[data-publisher-id]');

    if (!playerIframe && !playerIns) {
      if (attempt < 80) {
        setTimeout(() => tryIsolate(attempt + 1), 250);
      } else {
        window.__RYH_VIBIX_ISOLATING__ = false;
      }
      return;
    }

    window.__RYH_VIBIX_ISOLATE_SCHEDULED__ = true;
    whenPlayerReady(currentPane, () => {
      setTimeout(() => finishIsolate(currentPane), POST_LOAD_DELAY_MS);
    });
  };

  tryIsolate(0);
})();
