/**
 * YouTube Search — Addon SDK (solo buscador)
 * Port del Cloudstream YoutubeProvider (NewPipe) → JS para tu app.
 *
 * Solo expone búsqueda + meta + streams mínimos para pasar al player.
 * No tiene home/discover/catálogos (no los pediste).
 *
 * IDs:  yt:<videoId>
 * Streams: URL watch de YouTube (el player / extractor de la app la resuelve)
 *          + intento de HLS/MP4 vía Innertube player (ANDROID) si está disponible.
 */
var YT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var YT_CLIENT_VERSION = "2.20250301.00.00";
var YT_HL = "es";
var YT_GL = "US";

function ytContext(extra) {
  var ctx = {
    client: {
      clientName: "WEB",
      clientVersion: YT_CLIENT_VERSION,
      hl: YT_HL,
      gl: YT_GL
    }
  };
  if (extra) {
    for (var k in extra) ctx[k] = extra[k];
  }
  return { context: ctx };
}

async function ytPost(endpoint, body) {
  var url = "https://www.youtube.com/youtubei/v1/" + endpoint + "?prettyPrint=false";
  var res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": YT_UA,
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": YT_CLIENT_VERSION,
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("YouTube HTTP " + res.status);
  return await res.json();
}

function textOf(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs && obj.runs.length) {
    return obj.runs
      .map(function (r) {
        return r.text || "";
      })
      .join("");
  }
  return "";
}

function thumbOf(renderer) {
  var thumbs =
    (renderer.thumbnail && renderer.thumbnail.thumbnails) ||
    (renderer.thumbnails && renderer.thumbnails) ||
    [];
  if (!thumbs.length) return "";
  return thumbs[thumbs.length - 1].url || "";
}

function parseVideoRenderer(v) {
  if (!v || !v.videoId) return null;
  var title = textOf(v.title) || textOf(v.headline) || "Sin título";
  var channel =
    textOf(v.ownerText) ||
    textOf(v.longBylineText) ||
    textOf(v.shortBylineText) ||
    "";
  var views = textOf(v.viewCountText) || textOf(v.shortViewCountText) || "";
  var length = textOf(v.lengthText) || "";
  var published = textOf(v.publishedTimeText) || "";
  var live =
    !!(v.badges &&
      v.badges.some(function (b) {
        var t = textOf((b.metadataBadgeRenderer || {}).label);
        return /en vivo|live/i.test(t);
      })) ||
    !!(v.thumbnailOverlays &&
      v.thumbnailOverlays.some(function (o) {
        return o.thumbnailOverlayTimeStatusRenderer &&
          /LIVE|EN VIVO/i.test(
            textOf(o.thumbnailOverlayTimeStatusRenderer.text)
          );
      }));

  return {
    id: "yt:" + v.videoId,
    title: title,
    poster: thumbOf(v),
    type: live ? "live" : "movie",
    overview: [channel, views, length, published].filter(Boolean).join(" · "),
    channel: channel,
    duration: length,
    videoId: v.videoId,
    url: "https://www.youtube.com/watch?v=" + v.videoId
  };
}

function collectVideoRenderers(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) collectVideoRenderers(node[i], out);
    return;
  }
  if (typeof node !== "object") return;
  if (node.videoRenderer) {
    var item = parseVideoRenderer(node.videoRenderer);
    if (item) out.push(item);
  }
  if (node.videoWithContextRenderer) {
    var item2 = parseVideoRenderer(node.videoWithContextRenderer);
    if (item2) out.push(item2);
  }
  for (var k in node) {
    if (k === "videoRenderer" || k === "videoWithContextRenderer") continue;
    collectVideoRenderers(node[k], out);
  }
}

/**
 * Búsqueda principal (equivalente a search() del Cloudstream provider).
 * Devuelve lista de items listos para UI → al tocar se llama getMeta / getStreams.
 */
async function search(query) {
  var q = String(query || "").trim();
  if (q.length < 1) return [];

  try {
    var data = await ytPost(
      "search",
      Object.assign(ytContext(), { query: q })
    );
    var items = [];
    collectVideoRenderers(data, items);

    // dedupe por videoId
    var seen = {};
    var unique = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (seen[it.videoId]) continue;
      seen[it.videoId] = true;
      unique.push(it);
    }
    return unique.slice(0, 40);
  } catch (_) {
    return [];
  }
}

function parseYtId(id) {
  var raw = String(id || "");
  var m = /^yt:([a-zA-Z0-9_-]{6,})$/.exec(raw);
  if (m) return m[1];
  m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([a-zA-Z0-9_-]{6,})/.exec(raw);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  return null;
}

/** Meta mínima para la ficha antes de reproducir */
async function getMeta(id) {
  var videoId = parseYtId(id);
  if (!videoId) return null;

  try {
    // player endpoint da título, descripción, thumbs
    var data = await ytPost(
      "player",
      Object.assign(ytContext(), { videoId: videoId })
    );
    var vd = data.videoDetails || {};
    var micro = (data.microformat && data.microformat.playerMicroformatRenderer) || {};
    var thumbs =
      (vd.thumbnail && vd.thumbnail.thumbnails) ||
      (micro.thumbnail && micro.thumbnail.thumbnails) ||
      [];
    var poster = thumbs.length ? thumbs[thumbs.length - 1].url : "";
    var isLive = !!(vd.isLive || vd.isLiveContent);

    return {
      id: "yt:" + videoId,
      title: vd.title || "YouTube",
      poster: poster,
      backdrop: poster,
      overview: vd.shortDescription || "",
      type: isLive ? "live" : "movie",
      channel: vd.author || "",
      duration: vd.lengthSeconds ? Number(vd.lengthSeconds) : undefined,
      videoId: videoId,
      url: "https://www.youtube.com/watch?v=" + videoId
    };
  } catch (_) {
    return {
      id: "yt:" + videoId,
      title: "YouTube",
      poster: "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg",
      type: "movie",
      videoId: videoId,
      url: "https://www.youtube.com/watch?v=" + videoId
    };
  }
}

/**
 * Streams para el player.
 * 1) Intenta formatos directos / HLS vía Innertube (cliente ANDROID suele dar URLs más limpias).
 * 2) Siempre añade la URL watch de YouTube por si tu app ya tiene extractor de YT.
 */
async function getStreams(id) {
  var videoId = parseYtId(id);
  if (!videoId) return [];

  var streams = [];
  var watchUrl = "https://www.youtube.com/watch?v=" + videoId;

  // Cliente ANDROID: a menudo devuelve progressive / HLS sin signature compleja
  try {
    var body = {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.29.37",
          androidSdkVersion: 30,
          hl: YT_HL,
          gl: YT_GL
        }
      },
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    };
    var data = await ytPost("player", body);
    var streaming = data.streamingData || {};
    var formats = []
      .concat(streaming.adaptiveFormats || [])
      .concat(streaming.formats || []);

    var hls = streaming.hlsManifestUrl;
    if (hls) {
      streams.push({
        name: "YouTube · HLS",
        url: hls,
        quality: "auto",
        language: "YouTube",
        provider: "youtube",
        isHls: true,
        headers: { "User-Agent": YT_UA, Referer: "https://www.youtube.com/" }
      });
    }

    // progressive (muxed audio+video) primero — más fácil para players simples
    for (var i = 0; i < formats.length; i++) {
      var f = formats[i];
      if (!f || !f.url) continue; // sin url (cipher) lo saltamos
      var mime = String(f.mimeType || "");
      var isVideo = mime.indexOf("video/") === 0;
      var isAudio = mime.indexOf("audio/") === 0;
      if (!isVideo && !isAudio) continue;
      // preferir mp4 muxed
      if (isVideo && f.audioQuality && mime.indexOf("mp4") >= 0) {
        streams.push({
          name: "YouTube · " + (f.qualityLabel || f.quality || "mp4"),
          url: f.url,
          quality: f.qualityLabel || "auto",
          language: "YouTube",
          provider: "youtube",
          isHls: false,
          headers: { "User-Agent": YT_UA, Referer: "https://www.youtube.com/" }
        });
      }
    }

    // si no hubo muxed, al menos un audio+video adaptive de referencia
    if (streams.length <= (hls ? 1 : 0)) {
      for (var j = 0; j < formats.length; j++) {
        var fj = formats[j];
        if (!fj || !fj.url) continue;
        if (String(fj.mimeType || "").indexOf("video/mp4") === 0 && fj.height) {
          streams.push({
            name: "YouTube · " + (fj.qualityLabel || fj.height + "p") + " (video)",
            url: fj.url,
            quality: fj.qualityLabel || String(fj.height),
            language: "YouTube",
            provider: "youtube",
            isHls: false,
            headers: { "User-Agent": YT_UA, Referer: "https://www.youtube.com/" }
          });
          if (streams.length > 4) break;
        }
      }
    }
  } catch (_) {}

  // Fallback siempre: URL canónica para extractores de la app (como loadExtractor de Cloudstream)
  streams.push({
    name: "YouTube · watch",
    url: watchUrl,
    quality: "auto",
    language: "YouTube",
    provider: "youtube",
    isHls: false,
    headers: { "User-Agent": YT_UA, Referer: "https://www.youtube.com/" }
  });

  return streams;
}

/* Stubs vacíos: este plugin es SOLO buscador */
async function getHome() {
  return [];
}
async function getNews() {
  return [];
}
async function getAds() {
  return [];
}
async function getDiscoverFilters() {
  return [];
}
async function getDiscover() {
  return { page: 1, hasMore: false, items: [] };
}
async function getCatalogs() {
  return [];
}
async function getCatalog() {
  return { page: 1, hasMore: false, items: [] };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    search: search,
    getMeta: getMeta,
    getStreams: getStreams,
    getHome: getHome,
    getNews: getNews,
    getAds: getAds,
    getDiscoverFilters: getDiscoverFilters,
    getDiscover: getDiscover,
    getCatalogs: getCatalogs,
    getCatalog: getCatalog
  };
}
if (typeof globalThis !== "undefined") {
  globalThis.search = search;
  globalThis.getMeta = getMeta;
  globalThis.getStreams = getStreams;
  globalThis.getHome = getHome;
  globalThis.getNews = getNews;
  globalThis.getAds = getAds;
  globalThis.getDiscoverFilters = getDiscoverFilters;
  globalThis.getDiscover = getDiscover;
  globalThis.getCatalogs = getCatalogs;
  globalThis.getCatalog = getCatalog;
}
