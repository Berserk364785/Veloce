"""Veloce. Single-worker ephemeral watch-party server. See README_RU.md."""
import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from providers.content import anime_search, anime_details, anime_stream, movie_search, movie_details, movie_stream

ROOT = Path(__file__).resolve().parent
EMOJI = {"💜", "😂", "😍", "🔥", "👏", "🥹"}
MAX_ROOMS = int(os.getenv("MAX_ROOMS", "500"))
MAX_MEMBERS = 6
ROOM_TTL = 6 * 3600
ROOM_ID = re.compile(r"^[A-Za-z0-9_-]{24}$")
rooms = {}
limits = defaultdict(deque)

def now():
    return time.time() * 1000

def text(value, maximum=1000):
    return re.sub(r"[\x00-\x1f\x7f]", " ", value).strip()[:maximum] if isinstance(value, str) else ""

def finite(value, minimum=0, maximum=604800):
    return not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value) and minimum <= value <= maximum

def https_url(value):
    if not isinstance(value, str) or len(value) > 8192:
        raise ValueError("Некорректная ссылка.")
    p = urlsplit(value)
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.port not in (None, 443):
        raise ValueError("Нужна публичная HTTPS-ссылка без логина и пароля.")
    host = p.hostname.lower()
    if host in ("localhost", "localhost.localdomain") or host.endswith((".local", ".localhost")):
        raise ValueError("Локальные сетевые адреса не поддерживаются.")
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError("Частные сетевые адреса не поддерживаются.")
    except ValueError as exc:
        if "адреса" in str(exc):
            raise
    return value

def canonical_source(raw, member_id):
    if not isinstance(raw, dict):
        raise ValueError("Ожидается описание источника.")
    kind = raw.get("kind")
    result = {"kind": kind, "title": text(raw.get("title"), 180) or "Видео в комнате"}
    selection = raw.get("selection")
    if isinstance(selection, dict):
        result["selection"] = {k: v for k, v in selection.items() if k in {"provider", "id", "id_type", "translation", "translation_name", "season", "episode", "quality"} and isinstance(v, (str, int, float)) and len(str(v)) < 180 and (not isinstance(v, float) or math.isfinite(v))}
    if kind == "screen":
        return {**result, "owner": member_id}
    if kind == "local":
        if not re.fullmatch(r"[a-f0-9]{64}", str(raw.get("fingerprint", ""))) or not finite(raw.get("size"), 1, 1024**5):
            raise ValueError("Не удалось проверить локальный файл.")
        return {**result, "fingerprint": raw["fingerprint"], "size": raw["size"], "name": text(raw.get("name"), 180)}
    url = https_url(raw.get("url"))
    p = urlsplit(url)
    host = p.hostname.lower().removeprefix("www.")
    q = parse_qs(p.query)
    if kind == "youtube":
        if host not in {"youtube.com", "m.youtube.com", "youtube-nocookie.com", "youtu.be"}:
            raise ValueError("Неверный домен YouTube.")
        ident = p.path.strip("/") if host == "youtu.be" else q.get("v", [""])[0]
        if not ident:
            m = re.match(r"^/(?:embed|shorts|live)/([\w-]{11})(?:/|$)", p.path)
            ident = m[1] if m else ""
        if not re.fullmatch(r"[\w-]{11}", ident):
            raise ValueError("Не распознано видео YouTube.")
        return {**result, "provider": "youtube", "id": ident, "url": "https://www.youtube.com/watch?v=" + ident}
    if kind == "vk":
        if host not in {"vk.com", "vk.ru", "m.vk.com", "m.vk.ru", "vkvideo.ru", "m.vkvideo.ru"}:
            raise ValueError("Неверный домен VK.")
        match = re.search(r"video(-?\d+)_(\d+)", p.path + " " + q.get("z", [""])[0])
        oid = match[1] if match else q.get("oid", [""])[0]
        ident = match[2] if match else q.get("id", [""])[0]
        access_hash = q.get("hash", [""])[0]
        if not re.fullmatch(r"-?\d+", oid) or not re.fullmatch(r"\d+", ident) or (access_hash and not re.fullmatch(r"[\w-]{1,128}", access_hash)):
            raise ValueError("Не распознано видео VK.")
        return {**result, "provider": "vk", "id": oid + "_" + ident, "oid": oid, "videoId": ident, "hash": access_hash, "url": url}
    if kind == "rutube":
        if host not in {"rutube.ru", "m.rutube.ru"}:
            raise ValueError("Неверный домен Rutube.")
        m = re.match(r"^/(?:video|play/embed)/([a-f0-9]{32})(?:/|$)", p.path, re.I)
        if not m:
            raise ValueError("Не распознано видео Rutube.")
        key = q.get("p", [""])[0]
        if key and not re.fullmatch(r"[\w-]{1,128}", key):
            raise ValueError("Некорректный ключ Rutube.")
        return {**result, "provider": "rutube", "id": m[1].lower(), "key": key, "url": url}
    if kind == "direct":
        fmt = raw.get("format")
        if fmt not in {"hls", "mp4", "webm"}:
            fmt = "hls" if ".m3u8" in p.path.lower() else "webm" if p.path.lower().endswith(".webm") else "mp4" if p.path.lower().endswith(".mp4") else None
        if not fmt:
            raise ValueError("Нужна прямая ссылка .m3u8, .mp4 или .webm.")
        return {**result, "url": url, "format": fmt}
    raise ValueError("Источник не поддерживается.")

@dataclass
class Member:
    id: str
    name: str
    ws: WebSocket
    peer_id: str = ""
    voice: bool = False
    muted: bool = False
    camera: bool = False
    screen: bool = False
    speaking: bool = False
    def public(self):
        return {"id": self.id, "name": self.name, "peer_id": self.peer_id, "voice": self.voice, "muted": self.muted, "camera": self.camera, "screen": self.screen, "speaking": self.speaking}

@dataclass
class RoomState:
    id: str
    members: dict = field(default_factory=dict)
    host: str | None = None
    source: dict | None = None
    current_time: float = 0
    is_playing: bool = False
    at: float = field(default_factory=now)
    revision: int = 0
    source_revision: int = 0
    messages: list = field(default_factory=list)
    touched: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    def position(self):
        return self.current_time + max(0, (now() - self.at) / 1000) * self.is_playing
    def playback(self):
        return {"time": self.position(), "playing": self.is_playing, "at": now(), "revision": self.revision, "source_revision": self.source_revision}
    def roster(self):
        return {"type": "members", "members": [m.public() for m in self.members.values()], "host": self.host}
    def set_playback(self, position, playing):
        self.current_time, self.is_playing, self.at = float(position), bool(playing), now()
        self.revision += 1

async def emit(ws, data):
    try:
        await asyncio.wait_for(ws.send_json(data), 2)
    except (Exception, asyncio.CancelledError) as exc:
        if isinstance(exc, asyncio.CancelledError):
            raise

async def broadcast(room, data):
    await asyncio.gather(*(emit(m.ws, data) for m in list(room.members.values())))

async def cleanup():
    while True:
        await asyncio.sleep(60)
        for ident, room in list(rooms.items()):
            if not room.members and time.monotonic() - room.touched > ROOM_TTL:
                rooms.pop(ident, None)
        for key, queue in list(limits.items()):
            if not queue or time.monotonic() - queue[-1] > 60:
                limits.pop(key, None)

@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(cleanup())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task

app = FastAPI(title="Veloce", version="0.2.0", lifespan=lifespan)

def origin_allowed(origin, host):
    if not origin:
        return False
    expected = os.getenv("APP_ORIGIN", "").rstrip("/")
    return origin.rstrip("/") == expected if expected else urlsplit(origin).scheme in {"http", "https"} and urlsplit(origin).netloc == host

@app.middleware("http")
async def guard(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        if request.method == "POST" and request.headers.get("origin") and not origin_allowed(request.headers["origin"], request.headers.get("host", "")):
            return JSONResponse({"detail": "Недопустимый Origin"}, status_code=403)
        bucket = "rooms" if request.url.path == "/api/rooms" else "api"
        key = (request.client.host if request.client else "unknown", bucket)
        queue, current = limits[key], time.monotonic()
        while queue and current - queue[0] > 60:
            queue.popleft()
        if len(queue) >= (15 if bucket == "rooms" else 90):
            return JSONResponse({"detail": "Слишком много запросов. Подождите минуту."}, status_code=429)
        queue.append(current)
    response = await call_next(request)
    response.headers.update({"X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)", "Content-Security-Policy": "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https: wss: ws:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://vk.ru https://vk.com https://rutube.ru; worker-src 'self' blob:; media-src 'self' blob: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"})
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response

@app.get("/")
async def index():
    return FileResponse(ROOT / "static/index.html")

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/api/rooms", status_code=201)
async def create_room():
    if len(rooms) >= MAX_ROOMS:
        raise HTTPException(503, "Слишком много комнат. Повторите позже.")
    ident = secrets.token_urlsafe(18)
    rooms[ident] = RoomState(ident)
    return {"room_id": ident}

@app.get("/api/config")
async def config():
    try:
        ice = json.loads(os.getenv("ICE_SERVERS", '[{"urls":"stun:stun.l.google.com:19302"}]'))
    except ValueError:
        ice = []
    peer = {"debug": 0, "config": {"iceServers": ice}}
    if os.getenv("PEER_HOST"):
        peer.update({"host": os.environ["PEER_HOST"], "port": int(os.getenv("PEER_PORT", "443")), "path": os.getenv("PEER_PATH", "/"), "secure": os.getenv("PEER_SECURE", "true").lower() == "true"})
    return {"peer": peer, "capabilities": {"anilibria": True, "kodik": bool(os.getenv("KODIK_TOKEN")), "kodik_streams": os.getenv("ENABLE_KODIK_STREAMS", "false").lower() == "true", "movies": bool(os.getenv("KINOPOISK_API_KEY"))}, "max_members": MAX_MEMBERS}

Q = Query(min_length=2, max_length=120)
IDENT = Query(pattern=r"^[A-Za-z0-9_-]{1,100}$")
PROVIDER = Query(pattern=r"^(anilibria|kodik)$")
IDTYPE = Query(pattern=r"^(shikimori|kinopoisk)$")
@app.get("/api/anime/search")
async def search_anime(q: str = Q, provider: str = Query("all", pattern=r"^(all|anilibria|kodik)$")):
    return await anime_search(q.strip(), provider)

@app.get("/api/anime/details")
async def details_anime(id: str = IDENT, provider: str = PROVIDER, id_type: str = Query("shikimori", pattern=r"^(shikimori|kinopoisk)$")):
    return await anime_details(provider, id, id_type)

@app.get("/api/anime/stream")
async def stream_anime(id: str = IDENT, provider: str = PROVIDER, episode: float = Query(1, ge=0, le=3000), translation: str = Query("anilibria", min_length=1, max_length=64), quality: int = Query(720, ge=360, le=1080), season: int = Query(1, ge=1, le=100), id_type: str = Query("shikimori", pattern=r"^(shikimori|kinopoisk)$")):
    result = await anime_stream(provider, id, episode, translation, quality, season, id_type)
    try:
        https_url(result["url"])
    except ValueError as exc:
        raise HTTPException(502, str(exc)) from None
    return result

@app.get("/api/movies/search")
async def search_movies(q: str = Q, page: int = Query(1, ge=1, le=100)):
    return await movie_search(q.strip(), page)

@app.get("/api/movies/{id}/sources")
async def sources_movies(id: int):
    if id < 1:
        raise HTTPException(422, "Некорректный ID")
    return await movie_details(str(id))

@app.get("/api/movies/stream")
async def stream_movies(id: str = Query(pattern=r"^\d{1,12}$"), episode: float = Query(1, ge=0, le=3000), translation: str = Query(min_length=1, max_length=64), season: int = Query(1, ge=1, le=100)):
    result = await movie_stream(id, translation, season, episode)
    try:
        https_url(result["url"])
    except ValueError as exc:
        raise HTTPException(502, str(exc)) from None
    return result

@app.websocket("/ws/{room_id}/{username}")
async def watch(ws: WebSocket, room_id: str, username: str):
    if not origin_allowed(ws.headers.get("origin", ""), ws.headers.get("host", "")):
        await ws.close(1008)
        return
    await ws.accept()
    room = rooms.get(room_id) if ROOM_ID.fullmatch(room_id) else None
    if not room:
        await emit(ws, {"type": "expired", "message": "Комната закрыта или сервер перезапущен. Создайте новую."})
        await ws.close(1008)
        return
    member = Member(str(uuid4()), text(username, 24) or "Зритель", ws)
    async with room.lock:
        if len(room.members) >= MAX_MEMBERS:
            await emit(ws, {"type": "expired", "message": "В комнате уже 6 участников."})
            await ws.close(1008)
            return
        room.members[member.id] = member
        room.host = room.host or member.id
        await emit(ws, {"type": "init", "self": member.id, "host": room.host, "members": [m.public() for m in room.members.values()], "source": room.source, "playback": room.playback(), "messages": room.messages, "server_time": now()})
        await broadcast(room, room.roster())
    recent, chat_at, reaction_at = deque(), 0, 0
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 32000:
                await ws.close(1009)
                break
            tick = time.monotonic()
            while recent and tick - recent[0] > 1:
                recent.popleft()
            recent.append(tick)
            if len(recent) > 35:
                await ws.close(1008)
                break
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get("type")
            if not isinstance(kind, str):
                continue
            async with room.lock:
                room.touched = tick
                if kind == "ping":
                    if finite(data.get("client_time"), 0, 1e16):
                        await emit(ws, {"type": "pong", "client_time": data["client_time"], "server_time": now()})
                elif kind == "name":
                    member.name = text(data.get("name"), 24) or "Зритель"
                    await broadcast(room, room.roster())
                elif kind == "take_host":
                    if room.source and room.source["kind"] == "screen":
                        await emit(ws, {"type": "error", "message": "Сначала завершите демонстрацию экрана."})
                        continue
                    room.set_playback(room.position(), room.is_playing)
                    room.host = member.id
                    await broadcast(room, room.roster())
                    await broadcast(room, {"type": "state", "playback": room.playback()})
                elif kind == "change_source":
                    if room.host != member.id:
                        await emit(ws, {"type": "error", "message": "Источник меняет ведущий. Можно взять управление."})
                        continue
                    try:
                        new = canonical_source(data.get("source"), member.id) if data.get("source") is not None else None
                    except (ValueError, TypeError) as exc:
                        await emit(ws, {"type": "error", "message": str(exc)})
                        continue
                    room.source = new
                    room.source_revision += 1
                    room.set_playback(0, False)
                    await broadcast(room, {"type": "change_source", "source": new, "playback": room.playback()})
                elif kind in {"play", "pause", "seek", "state"}:
                    if member.id != room.host or not room.source or room.source["kind"] == "screen" or data.get("source_revision") != room.source_revision:
                        continue
                    position = data.get("time")
                    if not finite(position) or type(data.get("playing")) is not bool:
                        continue
                    room.set_playback(position, data["playing"])
                    await broadcast(room, {"type": kind, "playback": room.playback(), "from": member.id})
                elif kind == "chat":
                    body = text(data.get("text"))
                    if not body or tick - chat_at < .5:
                        continue
                    chat_at = tick
                    message = {"id": str(uuid4()), "from": member.id, "name": member.name, "text": body, "at": now()}
                    room.messages.append(message)
                    room.messages = room.messages[-100:]
                    await broadcast(room, {"type": "chat", "message": message})
                elif kind == "reaction":
                    emoji = data.get("emoji")
                    if not isinstance(emoji, str) or emoji not in EMOJI or tick - reaction_at < .4:
                        continue
                    reaction_at = tick
                    await broadcast(room, {"type": "reaction", "emoji": emoji, "from": member.id})
                elif kind == "peer_id":
                    peer_id = data.get("peer_id")
                    if isinstance(peer_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,100}", peer_id) and not any(m.id != member.id and m.peer_id == peer_id for m in room.members.values()):
                        member.peer_id = peer_id
                        await broadcast(room, room.roster())
                elif kind == "media":
                    for key in ("voice", "muted", "camera", "screen"):
                        if key in data:
                            setattr(member, key, data[key] is True)
                    if not member.voice or member.muted:
                        member.speaking = False
                    await broadcast(room, room.roster())
                elif kind == "speaking" and member.voice and not member.muted:
                    member.speaking = data.get("active") is True
                    await broadcast(room, {"type": "speaking", "id": member.id, "active": member.speaking})
                elif kind == "webrtc_signal":
                    # Optional signaling extension, scoped to the same room.
                    target = room.members.get(data.get("to")) if isinstance(data.get("to"), str) else None
                    if target and isinstance(data.get("data"), dict):
                        await emit(target.ws, {"type": "webrtc_signal", "from": member.id, "data": data["data"]})
    except (WebSocketDisconnect, RuntimeError, KeyError):
        pass
    finally:
        async with room.lock:
            room.members.pop(member.id, None)
            if room.host == member.id:
                room.set_playback(room.position(), False)
                room.host = next(iter(room.members), None)
                if room.source and room.source["kind"] == "screen":
                    room.source = None
                    room.source_revision += 1
                    await broadcast(room, {"type": "change_source", "source": None, "playback": room.playback()})
                await broadcast(room, {"type": "state", "playback": room.playback()})
            room.touched = time.monotonic()
            await broadcast(room, room.roster())

app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
