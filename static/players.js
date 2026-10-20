let ytPromise;
function youtubeAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytPromise)
    ytPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        ytPromise = null;
        reject(
          new Error(
            "Не удалось загрузить YouTube. Проверьте доступ к сервису.",
          ),
        );
      };
      window.onYouTubeIframeAPIReady = resolve;
      document.head.append(script);
    });
  return ytPromise;
}
export function createPlayer(source, container, hooks) {
  container.replaceChildren();
  let disposed = false,
    player,
    frame,
    listener,
    timeout;
  const state = {
    ready: false,
    position: 0,
    duration: 0,
    playing: false,
    buffering: false,
    measured: Date.now(),
  };
  const fail = (message) => {
    if (!disposed) hooks.error(message);
  };
  const ready = () => {
    if (disposed || state.ready) return;
    state.ready = true;
    clearTimeout(timeout);
    hooks.ready();
  };
  const wrapper = {
    get ready() {
      return state.ready;
    },
    read() {
      if (source.provider === "youtube" && player && state.ready) {
        const s = player.getPlayerState();
        return {
          position: player.getCurrentTime() || 0,
          duration: player.getDuration() || 0,
          playing: s === 1,
          buffering: s === 3,
        };
      }
      if (source.provider === "vk" && player && state.ready)
        return {
          position: player.getCurrentTime() || 0,
          duration: player.getDuration() || 0,
          playing: player.getState() === "playing",
          buffering: state.buffering,
        };
      return {
        ...state,
        position:
          state.position +
          (state.playing && !state.buffering
            ? (Date.now() - state.measured) / 1000
            : 0),
      };
    },
    play() {
      if (!state.ready) return;
      if (source.provider === "youtube") player.playVideo();
      else if (source.provider === "vk") player.play();
      else post("play");
    },
    pause() {
      if (!state.ready) return;
      if (source.provider === "youtube") player.pauseVideo();
      else if (source.provider === "vk") player.pause();
      else post("pause");
    },
    seek(time) {
      if (!state.ready) return;
      time = Math.max(0, time);
      if (source.provider === "youtube") player.seekTo(time, true);
      else if (source.provider === "vk") player.seek(time);
      else post("setCurrentTime", { time });
    },
    volume(value) {
      if (!state.ready) return;
      if (source.provider === "youtube") player.setVolume(value * 100);
      else if (source.provider === "vk") player.setVolume(value);
      else post("setVolume", { volume: value });
    },
    destroy() {
      disposed = true;
      clearTimeout(timeout);
      if (listener) window.removeEventListener("message", listener);
      try {
        player?.destroy();
      } catch {}
      container.replaceChildren();
    },
  };
  function post(method, data = {}) {
    frame?.contentWindow?.postMessage(
      JSON.stringify({ type: "player:" + method, data }),
      "https://rutube.ru",
    );
  }
  timeout = setTimeout(
    () =>
      fail(
        "Плеер не ответил. Возможно, встраивание запрещено, требуется вход или сервис недоступен в вашей сети.",
      ),
    25000,
  );
  if (source.provider === "youtube") {
    const mount = document.createElement("div");
    container.append(mount);
    youtubeAPI()
      .then(() => {
        if (disposed) return;
        player = new window.YT.Player(mount, {
          videoId: source.id,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, origin: location.origin, rel: 0 },
          events: {
            onReady: () => {
              if (disposed) return;
              try {
                player.setPlaybackRate(1);
              } catch {}
              ready();
            },
            onStateChange: () => hooks.change(),
            onPlaybackRateChange: () => {
              try {
                player.setPlaybackRate(1);
              } catch {}
            },
            onAutoplayBlocked: () => hooks.blocked(),
            onError: (e) =>
              fail(
                {
                  100: "Видео удалено или недоступно.",
                  101: "Автор запретил встраивание этого видео.",
                  150: "Автор запретил встраивание этого видео.",
                  153: "YouTube не смог проверить источник запроса. Откройте сайт по HTTPS, не из файла.",
                }[e.data] || "Ошибка YouTube. Попробуйте другой ролик.",
              ),
          },
        });
      })
      .catch((e) => fail(e.message));
  } else {
    frame = document.createElement("iframe");
    frame.title = source.provider === "vk" ? "Плеер VK Видео" : "Плеер Rutube";
    frame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    if (source.provider === "vk") {
      // Public VK widget protocol. Only this exact frame and origin are trusted.
      const origin = "https://vk.ru";
      const params = new URLSearchParams({
        oid: source.oid,
        id: source.videoId,
        hd: "2",
        js_api: "1",
      });
      if (source.hash) params.set("hash", source.hash);
      function vk(method, extra = {}) {
        frame.contentWindow?.postMessage({ method, ...extra }, origin);
      }
      const cache = { time: 0, duration: 0, state: "uninited" };
      player = {
        play: () => vk("play"),
        pause: () => vk("pause"),
        seek: (time) => vk("seek", { time }),
        setVolume: (volume) => vk("set_volume", { volume }),
        getCurrentTime: () => cache.time,
        getDuration: () => cache.duration,
        getState: () => cache.state,
      };
      listener = (e) => {
        if (
          e.source !== frame.contentWindow ||
          e.origin !== origin ||
          !e.data ||
          typeof e.data !== "object"
        )
          return;
        const m = e.data;
        Object.assign(cache, m);
        if (m.event === "inited") ready();
        if (["started", "resumed"].includes(m.event)) cache.state = "playing";
        if (["paused", "ended"].includes(m.event)) cache.state = m.event;
        if (m.event === "adStarted") {
          state.buffering = true;
          hooks.notice(
            "Реклама у участников может отличаться. Синхронизация возобновится после неё.",
          );
        }
        if (m.event === "adCompleted") state.buffering = false;
        if (m.event === "error")
          fail(
            "VK не разрешил воспроизведение. Попробуйте код «Поделиться → Экспортировать» или другое видео.",
          );
        if (m.event === "autoplaySoundProhibited") hooks.blocked();
        if (
          ["paused", "started", "resumed", "seeked", "ended"].includes(m.event)
        )
          hooks.change();
      };
      window.addEventListener("message", listener);
      frame.onload = () => vk("init");
      frame.src = `${origin}/video_ext.php?${params}`;
    } else {
      listener = (e) => {
        if (
          e.source !== frame.contentWindow ||
          e.origin !== "https://rutube.ru"
        )
          return;
        let m = e.data;
        try {
          if (typeof m === "string") m = JSON.parse(m);
        } catch {
          return;
        }
        if (!m?.type) return;
        const d = m.data || {};
        if (m.type === "player:ready") {
          ready();
          post("setPlaybackSpeed", { speed: 1 });
        }
        if (m.type === "player:currentTime") {
          const v = Number(d.time ?? d.currentTime);
          if (Number.isFinite(v)) {
            state.position = v;
            state.measured = Date.now();
          }
          if (Number.isFinite(Number(d.duration)))
            state.duration = Number(d.duration);
        }
        if (m.type === "player:durationChange")
          state.duration = Number(d.duration) || 0;
        if (m.type === "player:changeState") {
          state.position = wrapper.read().position;
          state.measured = Date.now();
          state.buffering = d.state === "buffering";
          if (d.state === "playing") state.playing = true;
          if (["pause", "paused", "completed", "stopped"].includes(d.state))
            state.playing = false;
          hooks.change();
        }
        if (m.type === "player:playComplete") {
          state.playing = false;
          hooks.change();
        }
        if (m.type === "player:playbackSpeedChanged" && Number(d.speed) !== 1)
          post("setPlaybackSpeed", { speed: 1 });
        if (m.type === "player:error")
          fail(
            "Ошибка Rutube. Возможно, видео недоступно для встраивания или требует авторизации.",
          );
      };
      window.addEventListener("message", listener);
      frame.src = `https://rutube.ru/play/embed/${source.id}/?${source.key ? "p=" + encodeURIComponent(source.key) + "&" : ""}skinColor=9d4edd`;
    }
    container.append(frame);
  }
  return wrapper;
}

export function createMediaPlayer(source, container, hooks, localUrl) {
  if (["youtube", "vk", "rutube"].includes(source.kind))
    return createPlayer(source, container, hooks);
  container.replaceChildren();
  const video = document.createElement("video");
  video.className = "live-video";
  video.playsInline = true;
  video.preload = "metadata";
  video.controls = false;
  const isLive = source.kind === "screen";
  if (isLive) video.autoplay = true;
  let ready = false,
    disposed = false,
    hls;
  if (source.kind !== "local" && !isLive) video.crossOrigin = "anonymous";
  container.append(video);
  const callback = () => {
    if (!disposed) hooks.change();
  };
  const onready = () => {
    if (!ready && !disposed) {
      ready = true;
      hooks.ready();
    }
  };
  video.addEventListener("loadedmetadata", onready);
  video.addEventListener("error", () => {
    if (!disposed)
      hooks.error(
        "Видео не открылось. Проверьте доступность ссылки, CORS, срок её действия и поддержку кодеков браузером.",
      );
  });
  for (const event of [
    "play",
    "pause",
    "seeked",
    "waiting",
    "playing",
    "ended",
  ])
    video.addEventListener(event, callback);
  video.addEventListener("ratechange", () => {
    if (video.playbackRate !== 1) video.playbackRate = 1;
  });
  if (isLive) {
    ready = true;
    queueMicrotask(() => {
      if (!disposed) hooks.ready();
    });
  } else if (source.kind === "local") video.src = localUrl;
  else if (source.format === "hls") {
    if (video.canPlayType("application/vnd.apple.mpegurl"))
      video.src = source.url;
    else if (window.Hls?.isSupported()) {
      hls = new window.Hls({
        enableWorker: true,
        maxBufferLength: 30,
        backBufferLength: 30,
      });
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () =>
        hls.loadSource(source.url),
      );
      let recoveries = 0;
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data.fatal && recoveries++ < 2) {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR)
            hls.startLoad();
          else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR)
            hls.recoverMediaError();
          else hooks.error("HLS-поток не поддерживается.");
        } else if (data.fatal)
          hooks.error(
            "HLS-поток недоступен. Возможны CORS, истёкшая ссылка, ограничение по IP или ошибка источника.",
          );
      });
    } else
      queueMicrotask(() =>
        hooks.error(
          "Этот браузер не поддерживает HLS. Используйте актуальный Chrome, Edge или Safari.",
        ),
      );
  } else video.src = source.url;
  return {
    get ready() {
      return ready;
    },
    element: video,
    read() {
      return {
        position: video.currentTime || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        playing: !video.paused && !video.ended,
        buffering: video.readyState < 3 && !video.paused,
      };
    },
    play() {
      video.play().catch((e) => {
        if (e.name === "NotAllowedError") hooks.blocked();
      });
    },
    pause() {
      video.pause();
    },
    seek(time) {
      if (!isLive && Number.isFinite(time))
        try {
          video.currentTime = Math.max(0, time);
        } catch {}
    },
    volume(v) {
      video.volume = v;
    },
    attach(stream, mute = false) {
      video.srcObject = stream;
      video.muted = mute;
      video.play().catch(() => hooks.blocked());
    },
    destroy() {
      disposed = true;
      hls?.destroy();
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
      container.replaceChildren();
    },
  };
}
