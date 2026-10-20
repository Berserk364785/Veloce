export const providers = {
  youtube: "YouTube",
  vk: "VK Видео",
  rutube: "Rutube",
};
export function parseSource(raw) {
  if (typeof raw !== "string" || raw.length > 3000)
    throw new Error("Слишком длинная ссылка.");
  let value = raw.trim();
  if (value.startsWith("<iframe")) {
    const match = value.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!match) throw new Error("В коде плеера не найдена ссылка src.");
    value = match[1].replaceAll("&amp;", "&");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Вставьте полную ссылку, начинающуюся с https://.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Нужна обычная HTTPS-ссылка на видео.");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    [
      "youtube.com",
      "m.youtube.com",
      "youtube-nocookie.com",
      "youtu.be",
    ].includes(host)
  ) {
    let id =
      host === "youtu.be"
        ? url.pathname.split("/")[1]
        : url.searchParams.get("v");
    if (!id)
      id = url.pathname.match(
        /^\/(?:embed|shorts|live)\/([\w-]{11})(?:\/|$)/,
      )?.[1];
    if (!/^[\w-]{11}$/.test(id || ""))
      throw new Error(
        "Не удалось распознать видео YouTube. Нужна ссылка на отдельный ролик.",
      );
    return {
      provider: "youtube",
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }
  if (
    [
      "vk.com",
      "vk.ru",
      "m.vk.com",
      "m.vk.ru",
      "vkvideo.ru",
      "m.vkvideo.ru",
    ].includes(host)
  ) {
    const pattern = /video(-?\d+)_(\d+)/;
    const match =
      url.pathname.match(pattern) || url.searchParams.get("z")?.match(pattern);
    const oid = match?.[1] || url.searchParams.get("oid");
    const id = match?.[2] || url.searchParams.get("id");
    if (!/^-?\d+$/.test(oid || "") || !/^\d+$/.test(id || ""))
      throw new Error(
        "Нужна ссылка вида vkvideo.ru/video-123_456 или код «Поделиться → Экспортировать».",
      );
    const hash = url.searchParams.get("hash") || "";
    if (hash && !/^[\w-]{1,128}$/.test(hash))
      throw new Error("Некорректный параметр ссылки VK.");
    return {
      provider: "vk",
      id: `${oid}_${id}`,
      oid,
      videoId: id,
      hash,
      url: `https://vkvideo.ru/video${oid}_${id}`,
    };
  }
  if (["rutube.ru", "m.rutube.ru"].includes(host)) {
    const id = url.pathname.match(
      /^\/(?:video|play\/embed)\/([a-f\d]{32})(?:\/|$)/i,
    )?.[1];
    if (!id)
      throw new Error(
        "Нужна полная ссылка rutube.ru/video/… на отдельное видео.",
      );
    const key = url.searchParams.get("p") || "";
    if (key && !/^[\w-]{1,128}$/.test(key))
      throw new Error("Некорректный параметр ссылки Rutube.");
    return {
      provider: "rutube",
      id: id.toLowerCase(),
      key,
      url: `https://rutube.ru/video/${id.toLowerCase()}/${key ? "?p=" + key : ""}`,
    };
  }
  throw new Error(
    "Пока поддерживаются YouTube, VK Видео и Rutube. Ссылки на другие сайты не открываются.",
  );
}
export function sourceKey(s) {
  return s ? `${s.provider}:${s.id}:${s.hash || s.key || ""}` : "";
}
export function parseAnySource(raw) {
  const v = raw.trim();
  let candidate = v;
  if (v.startsWith("<iframe"))
    candidate =
      v.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]?.replaceAll("&amp;", "&") ||
      v;
  try {
    const u = new URL(candidate);
    const p = u.pathname.toLowerCase();
    if (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (/\.m3u8(?:$|\/)/.test(p) || /\.(mp4|webm)$/.test(p))
    ) {
      return {
        kind: "direct",
        url: candidate,
        format: p.includes(".m3u8")
          ? "hls"
          : p.endsWith(".webm")
            ? "webm"
            : "mp4",
        title: "Видео по вашей ссылке",
      };
    }
  } catch {}
  const s = parseSource(v);
  return {
    ...s,
    kind: s.provider,
    title: providers[s.provider] + " · видео в комнате",
    url: s.provider === "vk" ? candidate : s.url,
  };
}
