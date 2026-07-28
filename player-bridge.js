(() => {
  if (window.RYH_PlayerBridge) {
    return;
  }

  const TIMEUPDATE_DEBOUNCE_MS = 800;
  const SEEK_THRESHOLD = 1.5;
  const TIME_POLL_MS = 450;
  // Seek times in this range are Rutube playlist control codes, never real media time.
  const MAGIC_SEEK_MIN = 100000;

  let lastReportedTime = 0;
  let timeupdateTimer = null;
  let applyingRemote = false;
  let lastPlaybackEvent = 'pause';
  let lastPolledTime = 0;
  let pollTimer = null;
  let lastUserGestureAt = 0;
  // Swallow load/buffer play-pause churn after remote commands.
  let suppressAutoPlaybackUntil = 0;
  const REMOTE_PLAYBACK_GUARD_MS = 1600;
  const LOAD_ECHO_SUPPRESS_MS = 2500;
  const USER_GESTURE_WINDOW_MS = 900;

  function markUserGesture() {
    lastUserGestureAt = Date.now();
  }

  function isRecentUserGesture() {
    return Date.now() - lastUserGestureAt < USER_GESTURE_WINDOW_MS;
  }

  function bindUserGestureCapture() {
    if (window.__RYH_BRIDGE_GESTURE__) {
      return;
    }
    window.__RYH_BRIDGE_GESTURE__ = true;
    const mark = () => markUserGesture();
    document.addEventListener('pointerdown', mark, true);
    document.addEventListener('keydown', (event) => {
      const key = String(event.key || '');
      if (key === ' ' || key === 'k' || key === 'K' || key === 'MediaPlayPause') {
        mark();
      }
    }, true);
  }

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

  function withApplyingRemote(durationMs, fn) {
    applyingRemote = true;
    try {
      return fn();
    } finally {
      window.setTimeout(() => {
        applyingRemote = false;
      }, durationMs);
    }
  }

  function isRealMediaTime(time) {
    return typeof time === 'number' && Number.isFinite(time) && time >= 0 && time < MAGIC_SEEK_MIN;
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

  function getPlaybackSnapshot() {
    const video = getPrimaryVideo();
    if (!video || !Number.isFinite(video.currentTime)) {
      return null;
    }
    return {
      time: video.currentTime,
      paused: Boolean(video.paused)
    };
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
    if (!isRealMediaTime(time)) {
      return false;
    }

    return withApplyingRemote(1200, () => {
      const target = Number(time);
      lastReportedTime = target;
      lastPolledTime = target;

      let applied = false;
      findVideos().forEach((video) => {
        try {
          video.currentTime = target;
          applied = true;
        } catch {
          /* ignore */
        }
      });

      postPlayerCommand('seek', target);
      return applied;
    });
  }

  function syncPlaybackTrackingFromVideo() {
    const snapshot = getPlaybackSnapshot();
    if (!snapshot) {
      return;
    }

    lastPlaybackEvent = snapshot.paused ? 'pause' : 'play';
  }

  function isLikelyBufferingPause(video) {
    if (!video) {
      return false;
    }
    // Transient pauses while media is still loading/buffering.
    return video.readyState < 3 || video.networkState === 2;
  }

  function emitLocalPlayback(event, time) {
    const nextEvent = String(event || '').toLowerCase();
    if (nextEvent !== 'play' && nextEvent !== 'pause') {
      return;
    }

    const fromUser = isRecentUserGesture();
    if (applyingRemote && !fromUser) {
      return;
    }

    const now = Date.now();
    // Auto play/pause from buffering after remote command — ignore.
    if (!fromUser && now < suppressAutoPlaybackUntil) {
      return;
    }

    if (!fromUser && nextEvent === 'pause') {
      const video = getPrimaryVideo();
      if (isLikelyBufferingPause(video)) {
        return;
      }
    }

    // Duplicate of already-known state — do not rebroadcast.
    if (nextEvent === lastPlaybackEvent) {
      return;
    }

    lastPlaybackEvent = nextEvent;

    const payload = { event: nextEvent };
    const snapshotTime = isRealMediaTime(time) ? time : getCurrentTime();
    if (isRealMediaTime(snapshotTime)) {
      payload.time = snapshotTime;
    }
    postToParent('localPlayback', payload);
  }

  function applyPlayback(command, time) {
    const cmd = String(command || '').toLowerCase();
    if (cmd !== 'play' && cmd !== 'pause') {
      return false;
    }

    return withApplyingRemote(REMOTE_PLAYBACK_GUARD_MS, () => {
      lastPlaybackEvent = cmd;
      // Ignore automatic opposite events while media settles.
      suppressAutoPlaybackUntil = Date.now() + LOAD_ECHO_SUPPRESS_MS;

      const videos = findVideos();

      if (isRealMediaTime(time)) {
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

      postPlayerCommand(cmd, isRealMediaTime(time) ? time : undefined);
      window.setTimeout(syncPlaybackTrackingFromVideo, 200);
      return true;
    });
  }

  function reportPlayback(event, time) {
    emitLocalPlayback(event, time);
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

    if (!isRealMediaTime(time)) {
      return;
    }

    const nextTime = Number(time);
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
    // New media element — ignore autoplay/load pause chatter briefly.
    suppressAutoPlaybackUntil = Math.max(
      suppressAutoPlaybackUntil,
      Date.now() + LOAD_ECHO_SUPPRESS_MS
    );
    lastPlaybackEvent = video.paused ? 'pause' : 'play';

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
      lastPlaybackEvent = data.event;
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
      emitLocalPlayback(data.event, data.time);
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
  bindUserGestureCapture();
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
    getPlaybackSnapshot,
    applySeekTime,
    applySeekDelta,
    applyPlayback
  };
})();
