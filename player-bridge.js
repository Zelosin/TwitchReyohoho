(() => {
  if (window.RYH_PlayerBridge) {
    return;
  }

  const TIMEUPDATE_DEBOUNCE_MS = 800;
  const SEEK_THRESHOLD = 1.5;
  const TIME_POLL_MS = 450;

  let lastReportedTime = 0;
  let timeupdateTimer = null;
  let applyingRemote = false;
  let lastPlaybackEvent = '';
  let lastPolledTime = 0;
  let pollTimer = null;

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

  function extractSeekTime(data) {
    if (!data || typeof data !== 'object') {
      return null;
    }

    if (data.type === 'playerEvent' && data.event === 'seek' && typeof data.time === 'number') {
      return data.time;
    }

    const eventName = String(data.event || data.type || data.name || data.method || '').toLowerCase();
    const isSeek =
      eventName === 'seek' ||
      eventName === 'seeked' ||
      eventName === 'time' ||
      eventName === 'timeupdate' ||
      eventName === 'jump' ||
      eventName === 'position' ||
      eventName === 'scrub' ||
      eventName === 'timechange';

    if (!isSeek && data.type !== 'seek') {
      return null;
    }

    const candidates = [
      data.time,
      data.currentTime,
      data.position,
      data.seconds,
      data.value,
      data?.data?.time,
      data?.data?.currentTime,
      data?.data?.position,
      data?.data?.seconds
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function extractPlaybackEvent(data) {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const eventName = String(data.event || data.type || data.name || data.method || '').toLowerCase();
    if (eventName === 'play' || eventName === 'playing' || eventName === 'started' || eventName === 'start') {
      return 'play';
    }
    if (eventName === 'pause' || eventName === 'paused') {
      return 'pause';
    }
    return null;
  }

  function extractPlaybackTime(data) {
    const candidates = [data?.time, data?.currentTime, data?.position, data?.data?.time];
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  function collectVideosFromRoot(root, videos) {
    if (!root || !root.querySelectorAll) {
      return;
    }

    root.querySelectorAll('video').forEach((video) => {
      videos.push(video);
    });

    root.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) {
        collectVideosFromRoot(element.shadowRoot, videos);
      }
    });
  }

  function findVideos() {
    const videos = [];
    collectVideosFromRoot(document, videos);

    document.querySelectorAll('iframe').forEach((iframe) => {
      try {
        if (iframe.contentDocument) {
          collectVideosFromRoot(iframe.contentDocument, videos);
        }
      } catch {
        /* cross-origin iframe */
      }
    });

    return videos;
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
    lastReportedTime = target;
    lastPolledTime = target;

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
      lastReportedTime = time;
      lastPolledTime = time;
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
    lastPolledTime = nextTime;
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

    video.addEventListener('seeking', () => {
      if (!applyingRemote) {
        reportSeek(video.currentTime);
      }
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

  function startTimePoll() {
    if (pollTimer) {
      return;
    }

    pollTimer = window.setInterval(() => {
      if (applyingRemote) {
        return;
      }

      const time = getCurrentTime();
      if (time === null) {
        return;
      }

      if (
        Math.abs(time - lastPolledTime) >= SEEK_THRESHOLD &&
        Math.abs(time - lastReportedTime) >= SEEK_THRESHOLD
      ) {
        reportSeek(time);
      }

      lastPolledTime = time;
    }, TIME_POLL_MS);
  }

  function relayChildBridgeMessage(data) {
    if (!data || data.source !== 'ryh-player-bridge') {
      return false;
    }

    if (data.type === 'localSeek' && typeof data.time === 'number') {
      postToParent('localSeek', { time: data.time });
      return true;
    }

    if (data.type === 'localPlayback' && (data.event === 'play' || data.event === 'pause')) {
      const payload = { event: data.event };
      if (typeof data.time === 'number' && Number.isFinite(data.time)) {
        payload.time = data.time;
      }
      postToParent('localPlayback', payload);
      return true;
    }

    return false;
  }

  function relayPlayerEvent(data) {
    if (!data || data.type !== 'playerEvent') {
      return false;
    }

    if (data.event === 'seek' && typeof data.time === 'number') {
      postToParent('localSeek', { time: data.time });
      return true;
    }

    if (data.event === 'play' || data.event === 'pause') {
      const payload = { event: data.event };
      if (typeof data.time === 'number' && Number.isFinite(data.time)) {
        payload.time = data.time;
      }
      postToParent('localPlayback', payload);
      return true;
    }

    return false;
  }

  function bindPostMessage() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source === 'ryh-player-sync-bridge') {
        return;
      }

      if (relayChildBridgeMessage(data) || relayPlayerEvent(data)) {
        return;
      }

      const seekTime = extractSeekTime(data);
      if (seekTime !== null) {
        reportSeek(seekTime);
        return;
      }

      const playbackEvent = extractPlaybackEvent(data);
      if (playbackEvent) {
        reportPlayback(playbackEvent, extractPlaybackTime(data));
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
  startTimePoll();

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
