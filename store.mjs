// Card data and models are downloaded once per data version and kept in the browser's Cache
// Storage, so the app opens offline and only an UPDATE downloads them again. The same
// function lives in shim.js (a classic script can't import this module).
export const DATA_CACHE = "alakadex-data-";

export async function fetchCached(path, version, onProgress, total) {
  const url = new URL(path, self.location.href);
  url.searchParams.set("v", version);
  const key = url.href;
  let cache = null;
  try { cache = await caches.open(DATA_CACHE + version); } catch {}   // no Cache Storage (http, private mode)
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) { onProgress?.(1, 1); return hit; }
  const res = await fetch(key, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  let blob;
  if (res.body && onProgress) {
    const reader = res.body.getReader(), parts = [];
    let loaded = 0;
    const size = total || Number(res.headers.get("content-length")) || 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); loaded += value.length;
      onProgress(loaded, Math.max(size, loaded));
    }
    blob = new Blob(parts, { type: res.headers.get("content-type") || "application/octet-stream" });
  } else blob = await res.blob();
  const out = new Response(blob, { headers: { "content-type": blob.type } });
  if (cache) await cache.put(key, out.clone()).catch(() => {});   // full storage: still works this time
  return out;
}
