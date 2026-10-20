import { parseAnySource, providers } from "./sources.js";
import { createMediaPlayer } from "./players.js";
const $ = (id) => document.getElementById(id),
  demo =
    Boolean(window.VELOCE_DEMO) ||
    new URLSearchParams(location.search).has("preview");
const store = {
  get(k, d = "") {
    try {
      return localStorage.getItem(k) || d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
let name = store.get("veloce-name", "Зритель"),
  roomId = "",
  socket,
  self = "",
  host = "",
  members = [],
  source = null,
  player = null,
  connected = false;
let remote = {
    time: 0,
    playing: false,
    at: Date.now(),
    revision: 0,
    source_revision: 0,
  },
  offset = 0,
  retry = 0,
  retryTimer,
  pingTimer,
  toastTimer;
let isRemoteAction = false,
  remoteTimer,
  suppressUntil = 0,
  lastPublished = 0,
  sourceGeneration = 0,
  mode = "link",
  config = { peer: {} },
  selected = null,
  details = null,
  detailsGeneration = 0,
  searchController,
  searchGeneration = 0,
  currentPage = 1;
let peer,
  voiceStream = null,
  cameraStream = null,
  screenStream = null,
  muted = false,
  audioContext,
  meterFrame;
let mediaGeneration = 0;
let socialOpen = false,
  unread = 0,
  savedScroll = 0,
  lastChatTrigger;
let activeCatalog = null,
  episodeBusy = false,
  pendingAutoplayKey = "";
let seekFeedbackTimer,
  lastEdgeTap = { side: "", at: 0 };
function updateUnread() {
  document.querySelectorAll("[data-unread]").forEach((el) => {
    el.textContent = unread > 99 ? "99+" : String(unread);
    el.hidden = !unread;
  });
}
async function setSocial(open, trigger) {
  if (open && document.fullscreenElement)
    await document.exitFullscreen().catch(() => {});
  if (open === socialOpen) return;
  socialOpen = open;
  if (open) {
    savedScroll = window.scrollY;
    lastChatTrigger = trigger || $("chat-fab");
  }
  $("social-panel").inert = !open;
  document.body.classList.toggle("social-open", open);
  document.body.classList.remove("typing");
  document.querySelectorAll("[data-chat-toggle]").forEach((b) => {
    b.setAttribute("aria-expanded", String(open));
    b.setAttribute(
      "aria-label",
      open ? "Закрыть чат и участников" : "Открыть чат и участников",
    );
  });
  if (open) {
    unread = 0;
    updateUnread();
    $("voice-details").open = !matchMedia("(max-width:1000px)").matches;
    $("close-social").focus({ preventScroll: true });
    if (!matchMedia("(max-width:1000px)").matches) {
      window.scrollTo(
        0,
        Math.max(
          0,
          $("player-card").getBoundingClientRect().top + window.scrollY - 20,
        ),
      );
    }
    $("messages").scrollTop = $("messages").scrollHeight;
  } else {
    $("chat-input").blur();
    if (matchMedia("(max-width:1000px)").matches)
      window.scrollTo(0, savedScroll);
    lastChatTrigger?.focus({ preventScroll: true });
  }
}
function viewportHeight() {
  document.documentElement.style.setProperty(
    "--visual-height",
    `${Math.round(window.visualViewport?.height || innerHeight)}px`,
  );
}
viewportHeight();
window.visualViewport?.addEventListener("resize", viewportHeight);
window.addEventListener("resize", viewportHeight);
document
  .querySelectorAll("[data-chat-toggle]")
  .forEach((b) => (b.onclick = () => setSocial(!socialOpen, b)));
$("close-social").onclick = () => setSocial(false);
$("chat-input").addEventListener("focus", () => {
  if (socialOpen) document.body.classList.add("typing");
});
$("chat-input").addEventListener("blur", () => {
  document.body.classList.remove("typing");
});
function updateTransportButtons() {
  const state = player?.ready ? player.read() : null;
  const disabled =
    !connected ||
    !isHost() ||
    source?.kind === "screen" ||
    !state ||
    !Number.isFinite(state.duration) ||
    state.duration <= 0;
  $("seek-back").disabled = disabled;
  $("seek-forward").disabled = disabled;
  $("screen").dataset.gestures = String(
    !disabled && ["direct", "local"].includes(source?.kind),
  );
}
function seekBy(delta) {
  if (!player?.ready || source?.kind === "screen" || !canControl()) return;
  const state = player.read();
  if (!Number.isFinite(state.duration) || state.duration <= 0) return;
  const time = Math.max(0, Math.min(state.duration, state.position + delta));
  suppressUntil = Date.now() + 700;
  player.seek(time);
  sendPlayback("seek", time, state.playing);
  const feedback = $("seek-feedback");
  feedback.dataset.side = delta < 0 ? "left" : "right";
  feedback.textContent = (delta < 0 ? "−" : "+") + Math.abs(delta) + " с";
  feedback.hidden = false;
  clearTimeout(seekFeedbackTimer);
  seekFeedbackTimer = setTimeout(() => (feedback.hidden = true), 700);
}
$("seek-back").onclick = () => seekBy(-10);
$("seek-forward").onclick = () => seekBy(10);
$("screen").addEventListener("pointerup", (e) => {
  if (
    $("screen").dataset.gestures !== "true" ||
    e.button !== 0 ||
    e.target.closest("button,a,input,textarea,iframe")
  )
    return;
  const box = $("screen").getBoundingClientRect(),
    x = (e.clientX - box.left) / box.width;
  const side = x < 0.35 ? "left" : x > 0.65 ? "right" : "";
  const at = Date.now();
  if (side && side === lastEdgeTap.side && at - lastEdgeTap.at < 330) {
    e.preventDefault();
    seekBy(side === "left" ? -10 : 10);
    lastEdgeTap = { side: "", at: 0 };
  } else lastEdgeTap = { side, at };
});
document.addEventListener("keydown", (e) => {
  if (
    document.querySelector("dialog[open]") ||
    e.target.closest("input,textarea,select,[contenteditable=true]")
  )
    return;
  if (e.key === "Escape" && socialOpen) setSocial(false);
  if (
    ["ArrowLeft", "ArrowRight"].includes(e.key) &&
    player?.ready &&
    isHost() &&
    connected
  ) {
    e.preventDefault();
    seekBy(e.key === "ArrowLeft" ? -10 : 10);
  }
});
function catalogKey(selection) {
  return selection
    ? `${selection.provider}:${selection.id}:${selection.id_type || "shikimori"}`
    : "";
}
function selectionKey(selection) {
  return selection
    ? `${catalogKey(selection)}:${selection.translation}:${selection.season}:${selection.episode}:${selection.quality}`
    : "";
}
function adjacentEpisode(direction) {
  const current = source?.selection;
  if (!current || activeCatalog?.key !== catalogKey(current)) return null;
  const translation = activeCatalog.details.translations?.find(
    (t) => String(t.id) === String(current.translation),
  );
  const episodes = (translation?.seasons || [])
    .slice()
    .sort((a, b) => a.number - b.number)
    .flatMap((season) =>
      (season.episodes || [])
        .slice()
        .sort((a, b) => a.number - b.number)
        .map((episode) => ({ ...episode, season: season.number })),
    );
  const index = episodes.findIndex(
    (e) =>
      Number(e.season) === Number(current.season) &&
      Number(e.number) === Number(current.episode),
  );
  const next = index >= 0 ? episodes[index + direction] : null;
  if (!next) return null;
  const qualities = next.qualities || [720];
  return {
    ...current,
    season: Number(next.season),
    episode: Number(next.number),
    quality: qualities.includes(Number(current.quality))
      ? Number(current.quality)
      : Number(qualities[0]),
  };
}
function updateEpisodeNav() {
  const current = source?.selection;
  $("series-navigation").hidden = !current && !demo;
  $("episode-position").textContent = current
    ? `Серия ${current.episode} · сезон ${current.season}`
    : "Выберите аниме из поиска";
  for (const [id, direction] of [
    ["previous-episode", -1],
    ["next-episode", 1],
  ]) {
    const next = adjacentEpisode(direction),
      button = $(id);
    button.disabled = !next || !connected || !isHost() || episodeBusy;
    button.title = next
      ? `Сезон ${next.season}, серия ${next.episode}`
      : "Другой серии нет в списке источника";
  }
}
$("previous-episode").onclick = () => {
  const next = adjacentEpisode(-1);
  if (next) playCatalogSelection(next, source.title);
};
$("next-episode").onclick = () => {
  const next = adjacentEpisode(1);
  if (next) playCatalogSelection(next, source.title);
};

const calls = new Map(),
  remoteStreams = new Map(),
  audios = new Map(),
  localFiles = new Map();
$("name-input").value = name;
updateAvatar();
function icon(button, id) {
  button.querySelector("use")?.setAttribute("href", "#i-" + id);
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}
function show(id) {
  $(id).showModal();
}
function send(data) {
  if (connected && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(data));
}
function isHost() {
  return host === self;
}
function canControl() {
  if (demo) {
    toast("Это демо интерфейса. Полная версия работает после запуска сервера.");
    return false;
  }
  if (!connected) {
    toast("Нет соединения с комнатой.");
    return false;
  }
  if (!isHost()) {
    toast("Сначала возьмите управление в разделе «О просмотре».");
    return false;
  }
  return true;
}
function connection(label, online = false) {
  $("connection").replaceChildren();
  $("connection").append(
    document.createElement("i"),
    document.createTextNode(label),
  );
  $("connection").classList.toggle("offline", !online);
}
function updateAvatar() {
  $("profile-button").textContent = (name[0] || "В").toUpperCase();
}
function fmt(value) {
  const n = Math.max(0, Math.floor(value || 0));
  return (
    (n >= 3600 ? Math.floor(n / 3600) + ":" : "") +
    String(Math.floor(n / 60) % 60).padStart(2, "0") +
    ":" +
    String(n % 60).padStart(2, "0")
  );
}
async function api(path, params) {
  const query = params ? "?" + new URLSearchParams(params) : "";
  const r = await fetch(path + query);
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("Сервер вернул некорректный ответ.");
  }
  if (!r.ok)
    throw Error(
      typeof data.detail === "string"
        ? data.detail
        : "Ошибка запроса: HTTP " + r.status,
    );
  return data;
}
function clearPlayer() {
  sourceGeneration++;
  player?.destroy();
  player = null;
  $("player-mount").replaceChildren();
  $("play").disabled = true;
  $("seek").disabled = true;
  updateTransportButtons();
  $("seek-feedback").hidden = true;
}
function setError(message) {
  $("player-error").textContent = message;
  $("player-error").hidden = false;
  $("sync-state").textContent = "Проверьте источник";
}
function addMessage(m, history = false) {
  if (!history && m.from !== self && !socialOpen) {
    unread++;
    updateUnread();
  }
  $("chat-empty").hidden = true;
  const a = document.createElement("article");
  a.className = "chat-message" + (m.from === self ? " self" : "");
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.textContent = m.name + (m.from === self ? " · вы" : "");
  const time = document.createElement("time");
  time.dateTime = new Date(m.at).toISOString();
  time.textContent = new Date(m.at).toLocaleTimeString("ru", {
    hour: "2-digit",
    minute: "2-digit",
  });
  meta.append(author, time);
  const body = document.createElement("div");
  body.className = "message-bubble";
  body.textContent = m.text;
  a.append(meta, body);
  $("messages").append(a);
  while ($("messages").querySelectorAll("article").length > 100)
    $("messages").querySelector("article").remove();
  $("messages").scrollTop = $("messages").scrollHeight;
}
function floatReaction(emoji) {
  const el = document.createElement("span");
  el.className = "flying-emoji";
  el.textContent = emoji;
  el.style.left = 15 + Math.random() * 65 + "%";
  $("reaction-layer").append(el);
  setTimeout(() => el.remove(), 3000);
}
function drawMembers() {
  $("members").replaceChildren();
  $("member-count").textContent = members.length;
  for (const m of members) {
    const box = document.createElement("div");
    box.className =
      "member" +
      (m.voice && !m.muted ? " voice" : "") +
      (m.speaking ? " speaking" : "");
    box.dataset.member = m.id;
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = (m.name || "З")[0].toUpperCase();
    const stream =
      m.id === self ? cameraStream : remoteStreams.get("camera:" + m.id);
    if (stream && m.camera) {
      const v = document.createElement("video");
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      av.append(v);
      v.play().catch(() => {});
    }
    const dot = document.createElement("span");
    dot.className = "voice-dot";
    dot.title = !m.voice
      ? "Голос выключен"
      : m.muted
        ? "Микрофон выключен"
        : "В голосовом канале";
    const label = document.createElement("div");
    label.className = "member-name";
    label.textContent = m.id === self ? "Вы" : m.name;
    label.title = m.name;
    const role = document.createElement("div");
    role.className = "role";
    role.textContent =
      m.id === host ? "Ведущий" : m.muted ? "Микрофон выкл." : "Зритель";
    box.append(av, dot, label, role);
    $("members").append(box);
  }
  if (members.length < 2) {
    const invite = document.createElement("button");
    invite.className = "member invite-placeholder";
    invite.type = "button";
    invite.setAttribute("aria-label", "Пригласить участника");
    Object.assign(invite.style, {
      border: "none",
      background: "transparent",
      padding: "0",
    });
    const a = document.createElement("div");
    a.className = "avatar";
    a.textContent = "+";
    const label = document.createElement("div");
    label.className = "member-name";
    label.textContent = "Пригласить";
    invite.append(a, label);
    invite.onclick = openInvite;
    $("members").append(invite);
  }
  $("host-label").textContent = isHost()
    ? "Вы — ведущий"
    : "Ведущий: " + (members.find((m) => m.id === host)?.name || "ожидаем");
  $("seek").disabled = !player?.ready || !isHost() || source?.kind === "screen";
  $("take-host").textContent = isHost()
    ? "Вы уже управляете плеером"
    : "Взять управление плеером";
  updateTransportButtons();
  updateEpisodeNav();
  ensureCalls();
}
function mediaState() {
  send({
    type: "media",
    voice: !!voiceStream,
    muted,
    camera: !!cameraStream,
    screen: !!screenStream,
  });
}
async function makeRoom() {
  if (demo)
    return toast("Создание комнаты доступно после запуска полной версии.");
  try {
    const r = await fetch("/api/rooms", { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw Error(data.detail || "Не удалось создать комнату.");
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("room", data.room_id);
    location.assign(u.href);
  } catch (e) {
    toast(e.message);
  }
}
async function boot() {
  if (demo) {
    self = host = "demo";
    members = [{ id: self, name }];
    $("demo-banner").hidden = false;
    $("room-code").textContent = "ДЕМО";
    connection("Демо интерфейса");
    drawMembers();
    return;
  }
  try {
    config = await api("/api/config");
    roomId = new URLSearchParams(location.search).get("room") || "";
    if (!roomId) {
      const r = await fetch("/api/rooms", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw Error(data.detail);
      roomId = data.room_id;
      const u = new URL(location.href);
      u.searchParams.set("room", roomId);
      history.replaceState(null, "", u);
    }
    $("room-code").textContent = roomId.slice(0, 6).toUpperCase();
    connect();
  } catch (e) {
    connection("Сервер недоступен");
    toast(
      e.message ||
        "Запустите проект по инструкции. HTML-файл отдельно не создаёт сервер.",
    );
  }
}
function connect() {
  clearTimeout(retryTimer);
  connection(retry ? "Переподключение…" : "Подключение…");
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${encodeURIComponent(roomId)}/${encodeURIComponent(name.replaceAll("/", " "))}`,
  );
  socket.onmessage = (event) => {
    let m;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    if (m.type === "init") {
      connected = true;
      retry = 0;
      self = m.self;
      host = m.host;
      members = m.members;
      offset = m.server_time - Date.now();
      connection("На связи", true);
      document.querySelectorAll(".chat-message").forEach((x) => x.remove());
      $("chat-empty").hidden = false;
      m.messages.forEach((m) => addMessage(m, true));
      drawMembers();
      receiveSource(m.source, m.playback);
      initPeer();
      clearInterval(pingTimer);
      pingTimer = setInterval(
        () => send({ type: "ping", client_time: Date.now() }),
        5000,
      );
      send({ type: "ping", client_time: Date.now() });
    }
    if (m.type === "members") {
      host = m.host;
      members = m.members;
      drawMembers();
    }
    if (m.type === "chat") addMessage(m.message);
    if (m.type === "reaction") floatReaction(m.emoji);
    if (m.type === "change_source") receiveSource(m.source, m.playback);
    if (["play", "pause", "seek", "state"].includes(m.type) && m.playback) {
      if (
        m.playback.revision < remote.revision ||
        m.playback.source_revision !== remote.source_revision
      )
        return;
      remote = m.playback;
      if (!isHost() || m.from !== self) applyRemote();
    }
    if (m.type === "pong") {
      const rtt = Date.now() - m.client_time;
      if (rtt >= 0 && rtt < 5000)
        offset = m.server_time - (m.client_time + Date.now()) / 2;
    }
    if (m.type === "speaking") {
      const person = members.find((p) => p.id === m.id);
      if (person) person.speaking = m.active;
      document
        .querySelector(`[data-member="${m.id}"]`)
        ?.classList.toggle("speaking", m.active);
    }
    if (m.type === "error") toast(m.message);
    if (m.type === "expired") {
      connected = false;
      connection("Комната закрыта");
      toast(m.message);
      socket.onclose = null;
      socket.close();
      teardownMedia();
    }
  };
  socket.onclose = () => {
    connected = false;
    clearInterval(pingTimer);
    teardownMedia();
    player?.pause();
    updateTransportButtons();
    updateEpisodeNav();
    connection("Связь потеряна");
    $("sync-state").textContent = "Нет соединения";
    retry++;
    retryTimer = setTimeout(
      connect,
      Math.min(15000, 1000 * 2 ** Math.min(4, retry)),
    );
  };
  socket.onerror = () => connection("Нет соединения");
}
function receiveSource(next, playback) {
  remote = playback;
  if (screenStream && next?.kind !== "screen") stopScreen(false);
  const old = JSON.stringify(source),
    incoming = JSON.stringify(next);
  if (old === incoming && player) {
    applyRemote(true);
    return;
  }
  source = next;
  if (activeCatalog?.key !== catalogKey(source?.selection))
    activeCatalog = null;
  if (
    pendingAutoplayKey &&
    pendingAutoplayKey !== selectionKey(source?.selection)
  )
    pendingAutoplayKey = "";
  updateEpisodeNav();
  clearPlayer();
  $("seek").value = "0";
  $("seek").max = "100";
  $("timecode").textContent =
    source?.kind === "screen" ? "LIVE" : "00:00 / 00:00";
  icon($("play"), "play");
  $("player-error").hidden = true;
  $("local-state").hidden = true;
  $("screen-empty").hidden = !!source;
  if (source?.kind === "screen" && mode !== "screen") setMode("screen");
  if (!source) {
    $("provider-label").textContent = "НАЧНИТЕ С ЧЕГО-ТО ХОРОШЕГО";
    $("video-title").textContent = "Что посмотрим сегодня?";
    $("video-subtitle").textContent =
      "Ролик, концерт или любимое шоу — просто вставьте ссылку.";
    $("sync-state").textContent = "Ожидаем видео";
    return;
  }
  $("provider-label").textContent =
    source.kind === "direct"
      ? "ПРЯМОЙ ПОТОК · " + source.format.toUpperCase()
      : source.kind === "local"
        ? "ЛОКАЛЬНЫЙ ФАЙЛ"
        : source.kind === "screen"
          ? "ТРАНСЛЯЦИЯ · LIVE"
          : providers[source.kind] || "ВИДЕО";
  $("video-title").textContent = source.title;
  $("video-subtitle").textContent = source.selection
    ? `${source.selection.translation_name || "Озвучка"} · сезон ${source.selection.season} · серия ${source.selection.episode}`
    : source.kind === "screen"
      ? "Экран ведущего · задержка зависит от соединения"
      : source.kind === "local"
        ? "Файл остаётся на вашем устройстве"
        : source.url;
  if (source.selection) restoreSelection(source.selection);
  else $("episode-picker").hidden = true;
  if (source.kind === "local") {
    const local = localFiles.get(source.fingerprint);
    if (!local) {
      $("local-state").hidden = false;
      $("local-status").textContent =
        `Выберите тот же файл: ${source.name}. Он не загружается на сервер.`;
      $("sync-state").textContent = "Нужен ваш файл";
      return;
    }
    mountPlayer(local.url);
  } else mountPlayer();
}
function mountPlayer(localUrl) {
  const gen = ++sourceGeneration;
  player = createMediaPlayer(
    source,
    $("player-mount"),
    {
      ready() {
        if (gen !== sourceGeneration) return;
        $("play").disabled = source.kind === "screen";
        $("seek").disabled = !isHost() || source.kind === "screen";
        player.volume(Number($("volume").value));
        if (source.kind === "screen") attachScreen();
        else if (
          pendingAutoplayKey &&
          pendingAutoplayKey === selectionKey(source.selection) &&
          isHost() &&
          connected
        ) {
          pendingAutoplayKey = "";
          suppressUntil = Date.now() + 700;
          player.play();
          sendPlayback("play", 0, true);
        } else applyRemote(true);
        updateTransportButtons();
        $("sync-state").textContent =
          source.kind === "screen"
            ? "LIVE"
            : isHost()
              ? "Вы управляете"
              : "Синхронизация";
      },
      change() {
        if (
          gen !== sourceGeneration ||
          isRemoteAction ||
          Date.now() < suppressUntil ||
          !isHost()
        )
          return;
        setTimeout(() => publish("state"), 100);
      },
      blocked() {
        toast(
          "Нажмите Play на этом устройстве, чтобы разрешить воспроизведение со звуком.",
        );
        $("sync-state").textContent = "Нажмите Play";
      },
      error(message) {
        if (gen === sourceGeneration) setError(message);
      },
      notice: toast,
    },
    localUrl,
  );
}
function markRemote() {
  isRemoteAction = true;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => (isRemoteAction = false), 250);
  suppressUntil = Date.now() + 500;
}
function targetTime() {
  return Math.max(
    0,
    remote.time +
      (remote.playing
        ? Math.max(0, Date.now() + offset - remote.at) / 1000
        : 0),
  );
}
function applyRemote(force = false) {
  if (!player?.ready || source?.kind === "screen") return;
  const actual = player.read(),
    target = targetTime();
  markRemote();
  if (force || Math.abs(actual.position - target) > 1.5) player.seek(target);
  if (remote.playing && !actual.playing && !actual.buffering) player.play();
  if (!remote.playing && (actual.playing || actual.buffering)) player.pause();
}
function sendPlayback(type, time, playing) {
  send({ type, time, playing, source_revision: remote.source_revision });
}
function publish(type = "state", force = false) {
  if (
    !connected ||
    !isHost() ||
    !player?.ready ||
    source?.kind === "screen" ||
    isRemoteAction ||
    Date.now() < suppressUntil
  )
    return;
  if (!force && Date.now() - lastPublished < 700) return;
  const s = player.read();
  if (!Number.isFinite(s.position)) return;
  lastPublished = Date.now();
  sendPlayback(type, Math.max(0, s.position), s.playing && !s.buffering);
}
const canvas = document.createElement("canvas");
canvas.width = 8;
canvas.height = 4;
const ctx = canvas.getContext("2d", { willReadFrequently: true });
function ambilight() {
  if (
    !player?.element ||
    $("ambient").getAttribute("aria-pressed") !== "true" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  try {
    ctx.drawImage(player.element, 0, 0, 8, 4);
    const d = ctx.getImageData(0, 0, 8, 4).data;
    let r = 0,
      g = 0,
      b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const count = d.length / 4;
    document
      .querySelector(".player-card")
      .style.setProperty(
        "--ambient-color",
        `rgba(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)},.24)`,
      );
  } catch {
    /* Cross-origin iframe or tainted video: decorative purple glow stays. */
  }
}
setInterval(() => {
  ambilight();
  updateTransportButtons();
  if (!player?.ready || source?.kind === "screen") return;
  const s = player.read();
  $("timecode").replaceChildren(document.createTextNode(fmt(s.position) + " "));
  const e = document.createElement("span");
  e.textContent = "/ " + fmt(s.duration);
  $("timecode").append(e);
  $("seek").max = Math.max(1, s.duration);
  if (document.activeElement !== $("seek")) $("seek").value = s.position;
  icon($("play"), s.playing ? "pause" : "play");
  $("play").setAttribute("aria-label", s.playing ? "Пауза" : "Воспроизвести");
  if (!connected) return;
  if (isHost()) {
    publish();
    $("sync-state").textContent = s.buffering
      ? "Буферизация…"
      : "Вы управляете";
  } else {
    applyRemote();
    $("sync-state").textContent =
      remote.playing && !s.playing ? "Нажмите Play" : "Синхронизация";
  }
}, 1000);
function openVideo() {
  if (!demo && !canControl()) return;
  $("source-error").textContent = "";
  show("video-dialog");
}
$("empty-add").onclick = openVideo;
$("add-video").onclick = openVideo;
$("source-form").onsubmit = (event) => {
  event.preventDefault();
  let parsed;
  try {
    parsed = parseAnySource($("source-input").value);
  } catch (e) {
    $("source-error").textContent = e.message;
    return;
  }
  if (demo) {
    $("video-dialog").close();
    toast(
      "Ссылка распознана. Воспроизведение доступно в полной версии после запуска сервера.",
    );
    return;
  }
  if (!canControl()) return;
  send({ type: "change_source", source: parsed });
  $("video-dialog").close();
};
$("play").onclick = () => {
  if (!player?.ready || !connected || source?.kind === "screen") return;
  if (isHost()) {
    const s = player.read(),
      playing = !s.playing;
    playing ? player.play() : player.pause();
    suppressUntil = Date.now() + 600;
    sendPlayback(playing ? "play" : "pause", s.position, playing);
  } else {
    player.play();
    setTimeout(() => applyRemote(true), 600);
  }
};
$("seek").onchange = () => {
  if (!isHost() || !player?.ready || !connected) return;
  const time = Number($("seek").value),
    playing = player.read().playing;
  player.seek(time);
  suppressUntil = Date.now() + 700;
  sendPlayback("seek", time, playing);
};
$("volume").oninput = () => player?.volume(Number($("volume").value));
$("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("player-card").requestFullscreen();
  } catch {
    toast("Полный экран недоступен. Попробуйте кнопку самого плеера.");
  }
};
$("ambient").onclick = () => {
  const enabled = $("ambient").getAttribute("aria-pressed") !== "true";
  $("ambient").setAttribute("aria-pressed", String(enabled));
  document
    .querySelector(".player-card")
    .classList.toggle("ambient-off", !enabled);
};
$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  if (demo) addMessage({ name, from: self, text, at: Date.now() });
  else if (connected) send({ type: "chat", text });
  else return toast("Сообщение не отправлено: нет соединения.");
  $("chat-input").value = "";
};
document.querySelectorAll("[data-emoji]").forEach(
  (b) =>
    (b.onclick = () => {
      if (demo) floatReaction(b.dataset.emoji);
      else if (connected) send({ type: "reaction", emoji: b.dataset.emoji });
      else toast("Нет соединения с комнатой.");
    }),
);
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  }),
);
$("profile-button").onclick = $("profile-inline").onclick = () =>
  show("profile-dialog");
$("profile-form").onsubmit = (e) => {
  e.preventDefault();
  name = $("name-input").value.trim().slice(0, 24) || "Зритель";
  store.set("veloce-name", name);
  updateAvatar();
  if (demo) {
    members[0].name = name;
    drawMembers();
  } else send({ type: "name", name });
  $("profile-dialog").close();
};
$("help-button").onclick = $("help-footer").onclick = () => show("help-dialog");
$("take-host").onclick = () => {
  if (demo) return toast("В демо вы уже ведущий.");
  if (!connected) return toast("Нет соединения.");
  send({ type: "take_host" });
  $("help-dialog").close();
};
$("new-room").onclick = () => {
  if (demo || confirm("Создать новую комнату? Участники останутся в прежней."))
    makeRoom();
};
$("room-nav").onclick = () =>
  $("screen").scrollIntoView({ behavior: "smooth", block: "center" });
$("members-nav").onclick = () => setSocial(true, $("members-nav"));
function openInvite() {
  if (demo)
    return toast("Ссылка комнаты появится после запуска полной версии.");
  $("invite-url").value = location.href;
  show("invite-dialog");
}
$("invite").onclick = openInvite;
$("copy-link").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("invite-url").value);
    toast("Ссылка скопирована. Отправьте её своему человеку 💜");
    $("invite-dialog").close();
  } catch {
    $("invite-url").focus();
    $("invite-url").select();
    toast("Скопируйте выделенную ссылку вручную.");
  }
};
function setMode(next) {
  mode = next;
  for (const b of document.querySelectorAll("[data-mode]")) {
    const active = b.dataset.mode === mode;
    b.classList.toggle("selected", active);
    b.setAttribute("aria-pressed", String(active));
  }
  const catalog = ["anime", "movies"].includes(mode);
  $("search-input").disabled = !catalog;
  $("search-input").placeholder =
    mode === "anime"
      ? "Найти аниме по названию…"
      : mode === "movies"
        ? "Найти фильм или сериал…"
        : "Поиск доступен в режимах «Аниме» и «Фильмы»";
  $("catalog-panel").hidden = !catalog;
  $("mode-notice").hidden = mode !== "screen";
  if (mode === "screen") {
    $("mode-notice").textContent =
      "Демонстрацию начинает ведущий кнопкой экрана в панели участников. В Chrome / Edge на компьютере выберите вкладку и включите «Поделиться звуком». Захват системного звука зависит от браузера и ОС; DRM-видео может отображаться чёрным.";
  }
  $("catalog-title").textContent =
    mode === "anime" ? "Найдём аниме для вашего вечера" : "Фильмы и сериалы";
  $("catalog-results").replaceChildren();
  $("catalog-status").textContent =
    mode === "movies"
      ? "Поиск метаданных требует серверного KINOPOISK_API_KEY. Видео подключается отдельно."
      : "Введите название. AniLiberty предоставляет свою озвучку; другие студии — через настроенный Kodik.";
  $("more-results").hidden = true;
  if (catalog) $("search-input").focus();
}
document
  .querySelectorAll("[data-mode]")
  .forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("close-catalog").onclick = () => ($("catalog-panel").hidden = true);
async function search(page = 1) {
  if (!["anime", "movies"].includes(mode)) return;
  const q = $("search-input").value.trim();
  if (q.length < 2) return toast("Введите минимум два символа.");
  if (demo) {
    $("catalog-status").textContent =
      "Демо интерфейса: живой поиск доступен после запуска FastAPI.";
    return;
  }
  const generation = ++searchGeneration,
    searchMode = mode;
  searchController?.abort();
  searchController = new AbortController();
  $("catalog-panel").hidden = false;
  $("catalog-status").textContent = "Ищем…";
  $("catalog-results").replaceChildren();
  $("more-results").hidden = true;
  try {
    const u = new URL(
      searchMode === "anime" ? "/api/anime/search" : "/api/movies/search",
      location.origin,
    );
    u.searchParams.set("q", q);
    if (searchMode === "movies") u.searchParams.set("page", page);
    const r = await fetch(u, { signal: searchController.signal });
    const d = await r.json();
    if (generation !== searchGeneration || mode !== searchMode) return;
    if (!r.ok)
      throw Error(
        typeof d.detail === "string" ? d.detail : "Не удалось выполнить поиск.",
      );
    currentPage = page;
    $("catalog-status").textContent =
      (d.items.length ? "Найдено: " + d.items.length : "Ничего не найдено.") +
      (d.warnings?.length ? "\n" + d.warnings.join("\n") : "");
    for (const item of d.items) {
      const card = document.createElement("button");
      card.className = "catalog-card";
      const image = item.poster
        ? document.createElement("img")
        : document.createElement("div");
      if (item.poster) {
        image.src = item.poster;
        image.alt = "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.onerror = () => {
          const fallback = document.createElement("div");
          fallback.className = "poster-fallback";
          fallback.textContent = "V";
          image.replaceWith(fallback);
        };
      } else {
        image.className = "poster-fallback";
        image.textContent = "V";
      }
      const title = document.createElement("strong");
      title.textContent = item.title;
      const meta = document.createElement("small");
      meta.textContent = [item.year, item.studio || "Каталог Кинопоиска"]
        .filter(Boolean)
        .join(" · ");
      card.append(image, title, meta);
      card.onclick = () => loadDetails(item);
      $("catalog-results").append(card);
    }
    $("more-results").hidden = !(searchMode === "movies" && page < d.pages);
  } catch (e) {
    if (e.name !== "AbortError" && generation === searchGeneration)
      $("catalog-status").textContent = e.message;
  }
}
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  search();
};
$("more-results").onclick = () => search(currentPage + 1);
async function loadDetails(item, restore) {
  const generation = ++detailsGeneration;
  $("catalog-status").textContent = "Загружаем озвучки и серии…";
  try {
    const d =
      item.provider === "movies"
        ? await api(`/api/movies/${encodeURIComponent(item.id)}/sources`)
        : await api("/api/anime/details", {
            id: item.id,
            provider: item.provider,
            id_type: item.id_type || "shikimori",
          });
    if (generation !== detailsGeneration) return;
    selected = {
      ...item,
      provider: d.provider,
      id_type: d.id_type || item.id_type || "shikimori",
    };
    details = d;
    if (catalogKey(source?.selection) === catalogKey(selected))
      activeCatalog = { key: catalogKey(selected), details: d };
    updateEpisodeNav();
    fillTranslations(restore);
    $("episode-picker").hidden = false;
    $("episode-notice").textContent = d.notice || "";
    $("catalog-panel").hidden = true;
    if (!restore)
      $("episode-picker").scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    if (!d.translations?.length)
      toast("Источник не предоставил доступных озвучек.");
  } catch (e) {
    $("catalog-status").textContent = e.message;
    toast(e.message);
  }
}
function options(select, items, desired) {
  select.replaceChildren();
  for (const item of items) {
    const o = document.createElement("option");
    o.value = String(item.value);
    o.textContent = item.label;
    select.append(o);
  }
  if (
    desired !== undefined &&
    items.some((x) => String(x.value) === String(desired))
  )
    select.value = String(desired);
  select.disabled = !items.length;
}
function translation() {
  return details?.translations?.find(
    (t) => String(t.id) === $("translation-select").value,
  );
}
function season() {
  return translation()?.seasons?.find(
    (s) => String(s.number) === $("season-select").value,
  );
}
function episode() {
  return season()?.episodes?.find(
    (e) => String(e.number) === $("episode-select").value,
  );
}
function fillTranslations(restore) {
  options(
    $("translation-select"),
    (details?.translations || []).map((t) => ({ value: t.id, label: t.name })),
    restore?.translation,
  );
  fillSeasons(restore);
}
function fillSeasons(restore) {
  options(
    $("season-select"),
    (translation()?.seasons || []).map((s) => ({
      value: s.number,
      label: s.label || "Сезон " + s.number,
    })),
    restore?.season,
  );
  fillEpisodes(restore);
}
function fillEpisodes(restore) {
  options(
    $("episode-select"),
    (season()?.episodes || []).map((e) => ({
      value: e.number,
      label: e.label || "Серия " + e.number,
    })),
    restore?.episode,
  );
  fillQuality(restore);
}
function fillQuality(restore) {
  const list = episode()?.qualities || [720];
  options(
    $("quality-select"),
    list.map((q) => ({ value: q, label: q + "p" })),
    restore?.quality || 720,
  );
  $("watch-episode").disabled = !episode();
}
$("translation-select").onchange = () => fillSeasons();
$("season-select").onchange = () => fillEpisodes();
$("episode-select").onchange = () => fillQuality();
async function restoreSelection(s) {
  const current =
    details &&
    selected &&
    selected.id === s.id &&
    selected.provider === s.provider;
  if (current) {
    activeCatalog = { key: catalogKey(s), details };
    updateEpisodeNav();
    fillTranslations(s);
    $("episode-picker").hidden = false;
    return;
  }
  await loadDetails(
    {
      id: s.id,
      provider: s.provider === "media" ? "movies" : s.provider,
      id_type: s.id_type,
      title: source?.title || "Видео",
    },
    s,
  );
}
$("watch-episode").onclick = () => {
  if (!selected || !episode()) return;
  const selection = {
    provider: selected.provider,
    id: selected.id,
    id_type: selected.id_type,
    translation: $("translation-select").value,
    translation_name: translation().name,
    season: Number($("season-select").value),
    episode: Number($("episode-select").value),
    quality: Number($("quality-select").value),
  };
  playCatalogSelection(selection, selected.title);
};
async function playCatalogSelection(selection, title) {
  if (episodeBusy || !canControl()) return;
  episodeBusy = true;
  $("watch-episode").disabled = true;
  updateEpisodeNav();
  const startingRevision = remote.source_revision;
  try {
    const params = {
      id: selection.id,
      translation: selection.translation,
      season: selection.season,
      episode: selection.episode,
    };
    const d =
      selection.provider === "media"
        ? await api("/api/movies/stream", params)
        : await api("/api/anime/stream", {
            ...params,
            provider: selection.provider,
            id_type: selection.id_type || "shikimori",
            quality: selection.quality,
          });
    if (!canControl() || remote.source_revision !== startingRevision) return;
    if (d.quality) selection.quality = Number(d.quality);
    pendingAutoplayKey = selectionKey(selection);
    send({
      type: "change_source",
      source: {
        kind: "direct",
        url: d.url,
        format: d.url.includes(".m3u8") ? "hls" : "mp4",
        title: d.title || title,
        selection,
      },
    });
    if (d.notice) toast(d.notice);
  } catch (e) {
    pendingAutoplayKey = "";
    toast(e.message);
    $("episode-notice").textContent = e.message;
  } finally {
    episodeBusy = false;
    $("watch-episode").disabled = !episode();
    updateEpisodeNav();
  }
}
$("choose-local").onclick = $("choose-local-room").onclick = () =>
  $("local-file").click();
async function fingerprint(file) {
  const chunk = 1024 * 1024,
    a = new Uint8Array(await file.slice(0, chunk).arrayBuffer()),
    b = new Uint8Array(
      await file.slice(Math.max(0, file.size - chunk)).arrayBuffer(),
    ),
    size = new TextEncoder().encode(String(file.size));
  const input = new Uint8Array(a.length + b.length + size.length);
  input.set(a);
  input.set(b, a.length);
  input.set(size, a.length + b.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
$("local-file").onchange = async () => {
  const file = $("local-file").files?.[0];
  $("local-file").value = "";
  if (!file) return;
  if (demo)
    return toast("Локальный просмотр доступен после запуска полной версии.");
  if (!connected) return toast("Нет соединения.");
  try {
    const hash = await fingerprint(file);
    if (
      source?.kind === "local" &&
      !isHost() &&
      (hash !== source.fingerprint || file.size !== source.size)
    )
      throw Error(
        "Это другой файл: размер или проверяемые фрагменты не совпадают. Выберите тот же файл, что у ведущего.",
      );
    if (!isHost() && source?.kind !== "local")
      return toast("Выбрать новый файл может ведущий.");
    if (!localFiles.has(hash)) {
      for (const [key, value] of localFiles) {
        if (key !== source?.fingerprint) {
          URL.revokeObjectURL(value.url);
          localFiles.delete(key);
        }
      }
      localFiles.set(hash, { url: URL.createObjectURL(file), file });
    }
    if (source?.kind === "local" && hash === source.fingerprint) {
      clearPlayer();
      $("local-state").hidden = true;
      mountPlayer(localFiles.get(hash).url);
    } else
      send({
        type: "change_source",
        source: {
          kind: "local",
          name: file.name,
          size: file.size,
          fingerprint: hash,
          title: file.name,
        },
      });
    $("video-dialog").close();
  } catch (e) {
    toast(e.message);
  }
};
/* PeerJS carries media, the room WebSocket authorizes identities and media state. */
function initPeer() {
  peer?.destroy();
  if (!window.Peer) {
    toast("Не загрузилась библиотека PeerJS. Видео и чат доступны отдельно.");
    return;
  }
  peer = new window.Peer("veloce-" + crypto.randomUUID(), config.peer || {});
  peer.on("open", (id) => {
    send({ type: "peer_id", peer_id: id });
    ensureCalls();
  });
  peer.on("call", (call) => {
    const person = members.find((m) => m.peer_id === call.peer),
      kind = call.metadata?.kind;
    if (
      !person ||
      !["voice", "camera", "screen"].includes(kind) ||
      (kind === "voice" && (!voiceStream || !person.voice)) ||
      (kind === "camera" && !person.camera) ||
      (kind === "screen" && (!person.screen || person.id !== host))
    ) {
      call.close();
      return;
    }
    call.answer(kind === "voice" ? voiceStream : undefined);
    registerCall("in:" + kind + ":" + person.id, call, person.id, kind);
  });
  peer.on("error", () => {
    $("voice-hint").textContent =
      "Медиасвязь недоступна · проверьте PeerJS / TURN";
  });
  peer.on("disconnected", () => {
    if (connected && !peer.destroyed) peer.reconnect();
  });
}
function registerCall(key, call, id, kind) {
  calls.get(key)?.close();
  calls.set(key, call);
  call.on("stream", (stream) => {
    remoteStreams.set(kind + ":" + id, stream);
    if (kind === "voice") {
      let audio = audios.get(id);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        document.body.append(audio);
        audios.set(id, audio);
      }
      audio.srcObject = stream;
      audio
        .play()
        .catch(() =>
          toast("Нажмите на страницу, чтобы разрешить звук голосового канала."),
        );
    } else if (kind === "camera") drawMembers();
    else attachScreen();
  });
  call.on("close", () => {
    if (calls.get(key) !== call) return;
    calls.delete(key);
    if (key.startsWith("in:") || kind === "voice") {
      remoteStreams.delete(kind + ":" + id);
      if (kind === "voice") {
        audios.get(id)?.remove();
        audios.delete(id);
      }
      if (kind === "camera") drawMembers();
    }
  });
  call.on("error", () => {
    $("voice-hint").textContent =
      "Не удалось соединиться · может потребоваться TURN";
  });
  setTimeout(() => {
    if (
      calls.get(key) === call &&
      call.peerConnection &&
      ["new", "connecting", "failed"].includes(
        call.peerConnection.connectionState,
      )
    )
      $("voice-hint").textContent =
        "Медиа не соединяется · проверьте TURN и сеть";
  }, 12000);
}
function ensureCalls() {
  if (!peer?.open) return;
  for (const [key, call] of [...calls]) {
    const parts = key.split(":"),
      kind = parts[1],
      id = parts.slice(2).join(":"),
      m = members.find((m) => m.id === id);
    if (
      !m ||
      !m.peer_id ||
      (kind === "voice" && (!voiceStream || !m.voice)) ||
      (kind === "camera" && (parts[0] === "out" ? !cameraStream : !m.camera)) ||
      (kind === "screen" && (parts[0] === "out" ? !screenStream : !m.screen))
    ) {
      calls.delete(key);
      call.close();
      remoteStreams.delete(kind + ":" + id);
      if (kind === "voice") {
        audios.get(id)?.remove();
        audios.delete(id);
      }
    }
  }
  for (const m of members) {
    if (m.id === self || !m.peer_id) continue;
    const outgoing = [
      ["voice", voiceStream && m.voice && self < m.id ? voiceStream : null],
      ["camera", cameraStream],
      ["screen", screenStream],
    ];
    for (const [kind, stream] of outgoing) {
      if (!stream) continue;
      const key = "out:" + kind + ":" + m.id;
      if (kind === "voice" && calls.has("in:voice:" + m.id)) continue;
      if (calls.has(key)) continue;
      const call = peer.call(m.peer_id, stream, { metadata: { kind } });
      if (call) registerCall(key, call, m.id, kind);
    }
  }
}
function stopTracks(stream) {
  stream?.getTracks().forEach((t) => {
    t.onended = null;
    t.stop();
  });
}
function stopVoice() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  stopTracks(voiceStream);
  voiceStream = null;
  muted = false;
  audioContext?.close().catch(() => {});
  audioContext = null;
  $("voice-button").classList.remove("connected");
  $("voice-button").querySelector("span").textContent = "Подключить голос";
  icon($("voice-button"), "mic");
  $("mute-button").disabled = true;
  icon($("mute-button"), "mic");
  $("voice-hint").textContent = "Говорите так, будто вы рядом";
  mediaState();
  ensureCalls();
}
async function startVoice() {
  if (demo) return toast("Голос работает в полной версии по HTTPS.");
  if (!connected) return toast("Нет соединения.");
  if (!navigator.mediaDevices?.getUserMedia)
    return toast("Для микрофона нужен HTTPS или localhost.");
  const button = $("voice-button");
  button.disabled = true;
  try {
    const generation = mediaGeneration,
      acquired = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    if (generation !== mediaGeneration || !connected) {
      stopTracks(acquired);
      return;
    }
    voiceStream = acquired;
    muted = false;
    voiceStream.getAudioTracks().forEach((t) => (t.onended = stopVoice));
    button.classList.add("connected");
    button.querySelector("span").textContent = "Отключить голос";
    $("mute-button").disabled = false;
    $("voice-hint").textContent = "Микрофон включён · звук не записывается";
    mediaState();
    try {
      audioContext = new AudioContext();
      await audioContext.resume();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(voiceStream).connect(analyser);
      const values = new Uint8Array(analyser.fftSize);
      let last = 0,
        speaking = false;
      function meter(t) {
        if (!voiceStream) return;
        if (t - last > 120) {
          last = t;
          analyser.getByteTimeDomainData(values);
          let sum = 0;
          for (const v of values) sum += (v - 128) ** 2;
          const active = !muted && Math.sqrt(sum / values.length) > 7;
          if (active !== speaking) {
            speaking = active;
            send({ type: "speaking", active });
          }
        }
        meterFrame = requestAnimationFrame(meter);
      }
      meterFrame = requestAnimationFrame(meter);
    } catch {}
    ensureCalls();
  } catch (e) {
    stopVoice();
    toast(
      e.name === "NotAllowedError"
        ? "Разрешите доступ к микрофону в настройках сайта."
        : "Не удалось подключить микрофон: " + e.message,
    );
  } finally {
    button.disabled = false;
  }
}
$("voice-button").onclick = () => (voiceStream ? stopVoice() : startVoice());
$("mute-button").onclick = () => {
  if (!voiceStream) return;
  muted = !muted;
  voiceStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  icon($("mute-button"), muted ? "micoff" : "mic");
  $("mute-button").setAttribute(
    "aria-label",
    muted ? "Включить микрофон" : "Выключить микрофон",
  );
  mediaState();
};
async function toggleCamera() {
  if (demo) return toast("Камера работает в полной версии по HTTPS.");
  if (!connected) return toast("Нет соединения.");
  if (cameraStream) {
    stopTracks(cameraStream);
    cameraStream = null;
    mediaState();
    $("camera-button").classList.remove("enabled");
    $("camera-button").setAttribute("aria-label", "Включить камеру");
    ensureCalls();
    drawMembers();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia)
    return toast("Для камеры нужен HTTPS.");
  $("camera-button").disabled = true;
  try {
    const generation = mediaGeneration,
      acquired = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
    if (generation !== mediaGeneration || !connected) {
      stopTracks(acquired);
      return;
    }
    cameraStream = acquired;
    cameraStream.getTracks().forEach((t) => (t.onended = () => toggleCamera()));
    $("camera-button").classList.add("enabled");
    $("camera-button").setAttribute("aria-label", "Выключить камеру");
    mediaState();
    drawMembers();
  } catch (e) {
    toast("Камера недоступна: " + e.message);
  } finally {
    $("camera-button").disabled = false;
  }
}
$("camera-button").onclick = toggleCamera;
function attachScreen() {
  if (source?.kind !== "screen" || !player?.attach) return;
  const stream =
    source.owner === self
      ? screenStream
      : remoteStreams.get("screen:" + source.owner);
  if (stream) player.attach(stream, source.owner === self);
  else $("sync-state").textContent = "Ждём трансляцию…";
}
function stopScreen(publish = true) {
  stopTracks(screenStream);
  screenStream = null;
  $("share-button").classList.remove("enabled");
  $("share-button").setAttribute("aria-label", "Транслировать экран");
  mediaState();
  ensureCalls();
  if (publish && connected && isHost() && source?.kind === "screen")
    send({ type: "change_source", source: null });
}
async function toggleScreen() {
  if (screenStream) return stopScreen();
  if (!canControl()) return;
  if (!navigator.mediaDevices?.getDisplayMedia)
    return toast(
      "Этот браузер не умеет начинать трансляцию. Попробуйте Chrome / Edge на компьютере по HTTPS.",
    );
  $("share-button").disabled = true;
  try {
    const generation = mediaGeneration,
      acquired = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 24, max: 30 } },
        audio: true,
        selfBrowserSurface: "exclude",
      });
    if (generation !== mediaGeneration || !connected || !isHost()) {
      stopTracks(acquired);
      return;
    }
    screenStream = acquired;
    screenStream.getVideoTracks()[0].onended = () => stopScreen();
    $("share-button").classList.add("enabled");
    $("share-button").setAttribute("aria-label", "Завершить трансляцию");
    mediaState();
    send({
      type: "change_source",
      source: { kind: "screen", title: "Экран " + name },
    });
    ensureCalls();
    if (!screenStream.getAudioTracks().length)
      toast(
        "Источник не передал звук. Для звука обычно нужно выбрать вкладку и включить «Поделиться звуком».",
      );
  } catch (e) {
    if (e.name !== "NotAllowedError")
      toast("Не удалось начать трансляцию: " + e.message);
  } finally {
    $("share-button").disabled = false;
  }
}
$("share-button").onclick = toggleScreen;
function teardownMedia() {
  mediaGeneration++;
  stopScreen(false);
  stopVoice();
  stopTracks(cameraStream);
  cameraStream = null;
  for (const call of calls.values()) call.close();
  calls.clear();
  remoteStreams.clear();
  for (const a of audios.values()) a.remove();
  audios.clear();
  peer?.destroy();
  peer = null;
  $("camera-button").classList.remove("enabled");
}
document.addEventListener("pointerdown", () => {
  for (const audio of audios.values())
    if (audio.paused) audio.play().catch(() => {});
});
window.addEventListener("pagehide", () => {
  connected = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  teardownMedia();
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  for (const f of localFiles.values()) URL.revokeObjectURL(f.url);
});
boot();
