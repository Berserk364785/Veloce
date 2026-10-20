import asyncio
from collections import OrderedDict
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urljoin, urlsplit
import httpx
from fastapi import HTTPException

ANI = os.getenv("ANILIBRIA_BASE", "https://aniliberty.top").rstrip("/")
BASE_DIR = Path(__file__).resolve().parent.parent
cache = OrderedDict()
semaphore = asyncio.Semaphore(4)

async def cached(key, loader, ttl=60):
    entry = cache.get(key)
    if entry and entry[0] > time.monotonic():
        cache.move_to_end(key)
        return entry[1]
    value = await loader()
    cache[key] = (time.monotonic() + ttl, value)
    cache.move_to_end(key)
    while len(cache) > 250:
        cache.popitem(last=False)
    return value

async def get_json(url, params=None, headers=None):
    try:
        async with semaphore, httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            r = await client.get(url, params=params, headers=headers)
            r.raise_for_status()
            return r.json()
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        raise HTTPException(502, f"Источник вернул HTTP {code}. Проверьте доступ, ключ и лимиты.") from None
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "Источник не отвечает или изменил формат ответа.") from None

async def kodik(action, **kwargs):
    if not os.getenv("KODIK_TOKEN"):
        raise HTTPException(503, "Kodik не настроен: владельцу сайта нужен собственный KODIK_TOKEN. Автополучение чужих токенов отключено.")
    if os.getenv("ENABLE_KODIK_STREAMS", "false").lower() != "true" and action == "stream":
        raise HTTPException(503, "Извлечение Kodik отключено. Включайте ENABLE_KODIK_STREAMS только с разрешением источника на прямые потоки.")
    async with semaphore:
        proc = await asyncio.create_subprocess_exec(sys.executable, "-m", "providers.kodik_worker", cwd=BASE_DIR, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(json.dumps({"action": action, **kwargs}).encode()), timeout=25)
        except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
            proc.kill()
            await proc.wait()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise HTTPException(504, "Kodik не ответил за 25 секунд.") from None
        try:
            result = json.loads(out)
        except ValueError:
            raise HTTPException(502, "Парсер вернул некорректный ответ.") from None
        if not result.get("ok"):
            if result.get("error") == "NoResults":
                return [] if action == "search" else {}
            raise HTTPException(502, "KodikParser не получил данные. Возможны неверный токен, изменение плеера или ограничение доступа.")
        return result["data"]

def safe_image(url, base=ANI):
    if not isinstance(url, str) or not url:
        return None
    full = urljoin(base + "/", url)
    return full if urlsplit(full).scheme == "https" else None

def ani_item(row):
    poster = row.get("poster") or {}
    image = (poster.get("optimized") or {}).get("preview") or poster.get("preview")
    return {"id": str(row["id"]), "provider": "anilibria", "title": (row.get("name") or {}).get("main") or row.get("alias") or "Без названия", "year": row.get("year"), "poster": safe_image(image), "studio": "AniLibria / AniLiberty"}

async def anime_search(q, provider="all"):
    items, warnings = [], []
    if provider in ("all", "anilibria"):
        try:
            data = await cached(("anime-search", q), lambda: get_json(ANI + "/api/v1/app/search/releases", {"query": q}))
            if not isinstance(data, list):
                raise HTTPException(502, "Изменился формат поиска AniLiberty.")
            items.extend(ani_item(r) for r in data[:24])
        except HTTPException as exc:
            if provider == "anilibria":
                raise
            warnings.append(str(exc.detail))
    if provider in ("all", "kodik"):
        if not os.getenv("KODIK_TOKEN") and provider == "all":
            warnings.append("Другие студии через Kodik появятся после настройки собственного API-токена.")
        else:
            try:
                rows = await cached(("kodik-search", q), lambda: kodik("search", q=q))
                seen = set()
                for row in rows:
                    if row.get("type") not in ("anime", "anime-serial"):
                        continue
                    ident = str(row.get("shikimori_id") or row.get("kinopoisk_id") or "")
                    id_type = "shikimori" if row.get("shikimori_id") else "kinopoisk"
                    key = (id_type, ident)
                    if not ident or key in seen:
                        continue
                    seen.add(key)
                    material = row.get("material_data") or {}
                    items.append({"id": ident, "id_type": id_type, "provider": "kodik", "title": row.get("title") or "Без названия", "year": row.get("year"), "poster": safe_image(material.get("poster_url")), "studio": "Kodik · доступные переводы"})
            except HTTPException as exc:
                if provider == "kodik":
                    raise
                warnings.append(str(exc.detail))
    return {"items": items, "warnings": warnings}

async def ani_release(ident):
    row = await cached(("ani-release", ident), lambda: get_json(ANI + "/api/v1/anime/releases/" + ident), 90)
    if not isinstance(row, dict) or "id" not in row:
        raise HTTPException(502, "Источник изменил формат релиза.")
    if row.get("is_blocked_by_geo") or row.get("is_blocked_by_copyrights"):
        raise HTTPException(403, "Источник ограничил доступ к этому релизу. Ограничение не обходится.")
    return row

async def anime_details(provider, ident, id_type="shikimori"):
    if provider == "anilibria":
        row = await ani_release(ident)
        episodes = [{"number": e.get("ordinal"), "label": f"{e.get('ordinal')}. {e.get('name') or 'Серия'}", "qualities": [q for q in (480, 720, 1080) if e.get(f"hls_{q}")]} for e in row.get("episodes", []) if any(e.get(f"hls_{q}") for q in (480, 720, 1080))]
        episodes.sort(key=lambda x: float(x["number"]))
        return {**ani_item(row), "translations": [{"id": "anilibria", "name": "AniLibria / AniLiberty", "seasons": [{"number": 1, "label": "Этот релиз", "episodes": episodes}]}], "notice": "Другие сезоны в AniLiberty могут быть отдельными релизами. Этот источник предоставляет свою озвучку, а не все студии."}
    info = await cached(("kodik-info", id_type, ident), lambda: kodik("details", id=ident, id_type=id_type), 120)
    translations = []
    for t in info.get("translations", []):
        a, b = (t.get("series_range") or [0, 0])[:2]
        a, b = max(0, int(a)), min(3000, int(b))
        episodes = [{"number": n, "label": "Фильм" if n == 0 else f"Серия {n}", "qualities": [360, 480, 720]} for n in range(a, b + 1)]
        translations.append({"id": str(t["id"]), "name": str(t.get("name") or t["id"]), "seasons": [{"number": 1, "label": "Сезон / релиз 1", "episodes": episodes}]})
    return {"id": ident, "provider": "kodik", "id_type": id_type, "translations": translations, "notice": "Экспериментальный KodikParser: до 720p; документированный метод потока поддерживает сезон 1. Для других сезонов выбирайте отдельный релиз. Фактическая доступность и CORS проверяются при воспроизведении."}

async def anime_stream(provider, ident, episode, translation, quality, season, id_type):
    if provider == "anilibria":
        if translation != "anilibria" or season != 1:
            raise HTTPException(422, "Озвучка или сезон отсутствуют у этого источника.")
        row = await ani_release(ident)
        e = next((e for e in row.get("episodes", []) if float(e.get("ordinal", -1)) == episode), None)
        if not e:
            raise HTTPException(404, "Эпизод отсутствует.")
        options = {q: e.get(f"hls_{q}") for q in (480, 720, 1080) if e.get(f"hls_{q}")}
        if not options:
            raise HTTPException(404, "Источник не предоставил прямой поток.")
        actual = quality if quality in options else max(options)
        return {"url": options[actual], "quality": actual, "qualities": list(options), "title": f"{ani_item(row)['title']} · серия {episode:g}", "studio": "AniLibria / AniLiberty"}
    if season != 1 or episode != int(episode):
        raise HTTPException(422, "Этот адаптер Kodik поддерживает целые номера серий и сезон 1.")
    url = await kodik("stream", id=ident, id_type=id_type, episode=int(episode), translation=translation, quality=quality, season=season)
    if not isinstance(url, str) or not url.startswith("https://"):
        raise HTTPException(502, "Парсер не вернул HTTPS-поток.")
    return {"url": url, "quality": min(quality, 720), "title": f"Видео · серия {episode:g}", "studio": "Kodik", "notice": "Ссылка может истечь или быть привязана к IP. Сервер не проксирует видео."}

async def movie_search(q, page):
    key = os.getenv("KINOPOISK_API_KEY")
    if not key:
        raise HTTPException(503, "Для поиска фильмов задайте KINOPOISK_API_KEY на сервере. Метаданные не дают прав или доступа к фильмам.")
    data = await cached(("movie-search", q, page), lambda: get_json("https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword", {"keyword": q, "page": page}, {"X-API-KEY": key}))
    return {"items": [{"id": str(r["filmId"]), "kinopoisk_id": r["filmId"], "provider": "movies", "title": r.get("nameRu") or r.get("nameEn") or "Без названия", "year": r.get("year"), "poster": safe_image(r.get("posterUrlPreview"))} for r in data.get("films", [])], "page": page, "pages": data.get("pagesCount", 1), "warnings": ["Это каталог метаданных. Для просмотра нужен отдельно настроенный источник видео."]}

def media_catalog():
    path = Path(os.getenv("MEDIA_CATALOG", str(BASE_DIR / "media.json")))
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}

async def movie_details(ident):
    media = media_catalog().get(ident)
    if media:
        return {"id": ident, "provider": "media", "title": media.get("title", "Фильм"), "translations": media.get("translations", []), "notice": "Источники из собственного media.json. Добавляйте только разрешённые к использованию потоки."}
    if os.getenv("KODIK_TOKEN"):
        data = await anime_details("kodik", ident, "kinopoisk")
        data["id_type"] = "kinopoisk"
        return data
    raise HTTPException(404, "Для этого фильма нет настроенного потока. Добавьте разрешённый источник в media.json или настройте Kodik. Каталог Кинопоиска не содержит сами фильмы.")

async def movie_stream(ident, translation, season, episode):
    row = media_catalog().get(ident) or {}
    for t in row.get("translations", []):
        if str(t.get("id")) != translation:
            continue
        for s in t.get("seasons", []):
            if int(s.get("number", -1)) != season:
                continue
            for e in s.get("episodes", []):
                if float(e.get("number", -1)) == episode and e.get("url"):
                    return {"url": e["url"], "title": row.get("title", "Фильм") + " · " + e.get("label", "Серия"), "studio": t.get("name", "Своя озвучка"), "quality": e.get("quality")}
    raise HTTPException(404, "Поток для выбранной серии и озвучки не настроен.")
