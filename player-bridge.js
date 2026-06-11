(() => {
  if (window.RYH_PlayerBridge) {
    return;
  }

  const TIMEUPDATE_DEBOUNCE_MS = 800;
  const SEEK_THRESHOLD = 1.5;

  let lastReportedTime = 0;
  let timeupdateTimer = null;
  let applyingRemote = false;
  let lastPlaybackEvent = '';

  function postToParent(type, payload) {
    try {
      window.parent.postMessage(
        {
          source: 'ryh-player-bridge',
          type,
          ...payload
        },
        '*'
      );
    } catch {
      /* ignore */
    }
  }

  function findVideos() {
    const videos = [...document.querySelectorAll('video')];
    const nested = [];

    document.querySelectorAll('iframe').forEach((iframe) => {
      try {
        if (iframe.contentDocument) {
          iframe.contentDocument.querySelectorAll('video').forEach((video) => {
            nested.push(video);
          });
        }
      } catch {
        /* cross-origin iframe */
      }
    });

    return [...videos, ...nested];
  }

  function getPrimaryVideo() {
    const videos = findVideos();
    if (!videos.length) {
      return null;
    }

    return videos.reduce((best, video) => {
      if (!best) {
        return video;
      }
      return video.duration > best.duration ? video : best;
    }, null);
  }

  function getCurrentTime() {
    const video = getPrimaryVideo();
    if (!video || !Number.isFinite(video.currentTime)) {
      return null;
    }
    return video.currentTime;
  }

  function postPlayerCommand(command, value) {
    document.querySelectorAll('iframe').forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage(
          {
            type: 'playerCommand',
            command,
            value,
            timestamp: Date.now()
          },
          '*'
        );
      } catch {
        /* ignore */
      }
    });

    try {
      window.postMessage(
        {
          type: 'playerCommand',
          command,
          value,
          timestamp: Date.now()
        },
        '*'
      );
    } catch {
      /* ignore */
    }
  }

  function applySeekTime(time) {
    const target = Number(time);
    if (!Number.isFinite(target)) {
      return false;
    }

    applyingRemote = true;

    const videos = findVideos();
    let applied = false;

    videos.forEach((video) => {
      try {
        video.currentTime = target;
        applied = true;
      } catch {
        /* ignore */
      }
    });

    postPlayerCommand('seek', target);

    window.setTimeout(() => {
      applyingRemote = false;
    }, 300);

    return applied;
  }

  function applyPlayback(command, time) {
    const cmd = String(command || '').toLowerCase();
    if (cmd !== 'play' && cmd !== 'pause') {
      return false;
    }

    applyingRemote = true;
    lastPlaybackEvent = cmd;

    const videos = findVideos();

    if (typeof time === 'number' && Number.isFinite(time)) {
      videos.forEach((video) => {
        try {
          video.currentTime = time;
        } catch {
          /* ignore */
        }
      });
      postPlayerCommand('seek', time);
    }

    videos.forEach((video) => {
      try {
        if (cmd === 'play') {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      } catch {
        /* ignore */
      }
    });

    postPlayerCommand(cmd, time);

    window.setTimeout(() => {
      applyingRemote = false;
    }, 300);

    return true;
  }

  function reportPlayback(event, time) {
    if (applyingRemote) {
      return;
    }

    const nextEvent = String(event || '').toLowerCase();
    if (nextEvent !== 'play' && nextEvent !== 'pause') {
      return;
    }

    if (nextEvent === lastPlaybackEvent) {
      return;
    }

    lastPlaybackEvent = nextEvent;
    const payload = { event: nextEvent };
    if (typeof time === 'number' && Number.isFinite(time)) {
      payload.time = time;
    }
    postToParent('localPlayback', payload);
  }

  function applySeekDelta(delta) {
    const current = getCurrentTime();
    if (current === null) {
      return false;
    }
    return applySeekTime(Math.max(0, current + Number(delta)));
  }

  function reportSeek(time) {
    if (applyingRemote) {
      return;
    }

    const nextTime = Number(time);
    if (!Number.isFinite(nextTime)) {
      return;
    }

    if (Math.abs(nextTime - lastReportedTime) < SEEK_THRESHOLD) {
      return;
    }

    lastReportedTime = nextTime;
    postToParent('localSeek', { time: nextTime });
  }

  function bindVideo(video) {
    if (!video || video.dataset.ryhBridgeBound) {
      return;
    }

    video.dataset.ryhBridgeBound = '1';

    video.addEventListener('seeked', () => {
      reportSeek(video.currentTime);
    });

    video.addEventListener('play', () => {
      reportPlayback('play', video.currentTime);
    });

    video.addEventListener('pause', () => {
      reportPlayback('pause', video.currentTime);
    });

    video.addEventListener('timeupdate', () => {
      if (applyingRemote) {
        return;
      }

      if (timeupdateTimer) {
        clearTimeout(timeupdateTimer);
      }

      timeupdateTimer = setTimeout(() => {
        timeupdateTimer = null;
        if (video.seeking) {
          return;
        }
        const drift = Math.abs(video.currentTime - lastReportedTime);
        if (drift >= SEEK_THRESHOLD) {
          reportSeek(video.currentTime);
        }
      }, TIMEUPDATE_DEBOUNCE_MS);
    });
  }

  function bindVideos() {
    findVideos().forEach(bindVideo);
  }

  function bindPostMessage() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.type !== 'playerEvent') {
        return;
      }

      if (data.event === 'seek' && typeof data.time === 'number') {
        reportSeek(data.time);
        return;
      }

      if (data.event === 'play' || data.event === 'pause') {
        reportPlayback(data.event, data.time);
      }
    });
  }

  function bindParentCommands() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'ryh-player-sync-bridge') {
        return;
      }

      if (data.command === 'seek' && typeof data.time === 'number') {
        applySeekTime(data.time);
        return;
      }

      if (data.command === 'seek_delta' && typeof data.delta === 'number') {
        applySeekDelta(data.delta);
        return;
      }

      if (data.command === 'play') {
        applyPlayback('play', data.time);
        return;
      }

      if (data.command === 'pause') {
        applyPlayback('pause', data.time);
      }
    });
  }

  bindPostMessage();
  bindParentCommands();
  bindVideos();

  const observer = new MutationObserver(() => {
    bindVideos();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.RYH_PlayerBridge = {
    getCurrentTime,
    applySeekTime,
    applySeekDelta,
    applyPlayback
  };
})();
