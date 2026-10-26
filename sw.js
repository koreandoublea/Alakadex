// Offline app shell. The page files are kept per build (the build writes APP and SHELL
// below); card data and models are cached by the page itself (shim.js / store.mjs) and
// only replaced when the user presses UPDATE, so this worker leaves them alone.
const APP = "7ab19c0d35a2";
const SHELL = ["alakadex.ico", "alakadex.svg", "app.js", "fonts/OFL.txt", "fonts/PressStart2P-Regular.ttf", "icon-192.png", "icon-512.png", "imgops.mjs", "index.html", "manifest.webmanifest", "ort/ort-wasm-simd-threaded.jsep.mjs", "ort/ort-wasm-simd-threaded.mjs", "ort/ort.wasm.min.mjs", "ort/ort.webgpu.min.mjs", "shim.js", "sounds/pokedex_click.ogg", "store.mjs", "style.css", "web.css", "worker.mjs"];
const CACHE = "alakadex-shell-" + APP;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("alakadex-shell-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.search) return;     // card data (?v=), other sites: not ours
  const scope = new URL(self.registration.scope);
  let path = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null;
  if (path === null) return;
  if (req.mode === "navigate") path = "index.html";
  if (!SHELL.includes(path)) return;                            // version.json, prices.json: always the network
  // the cached page opens at once, even offline; a newer build arrives with the next sw.js
  e.respondWith(caches.open(CACHE).then(async (c) => isolated((await c.match(path)) || (await fetch(req)))));
});

// Cross-origin isolation lets the identifier use several CPU cores (WebAssembly threads need
// it). Static hosts can't send these headers, so the cached pages carry them. "credentialless"
// keeps the card sites' pictures loading; a browser without it simply stays single-threaded.
function isolated(res) {
  if (!res || res.status !== 200 || res.type === "opaque") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
