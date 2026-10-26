// Alakadex in the browser: answers the page's /api calls (the desktop's Flask server,
// alakadex/server.py) right here, so app.js runs unchanged. The scanning itself happens in
// worker.mjs; this file keeps the card catalog, languages, prices, settings and pull
// history (saved on the phone in IndexedDB).
(() => {
  "use strict";
  const BASE = new URL(".", location.href);
  const LS = (() => { try { return window.localStorage; } catch { return null; } })();
  const lsGet = (k) => { try { return LS && LS.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { LS && LS.setItem(k, v); } catch {} };

  // ---------------------------------------------------------------- constants (server.py, config.py ...)
  const THRESHOLD = 0.30;        // data/index/calibration.json: the calibrated confidence threshold
  const UNSURE_BELOW = 0.22;     // server.UNSURE_BELOW
  const FRAME_DET_CONF = 0.45;   // server.FRAME_DET_CONF
  const SURE = 0.90, NEAR_SURE = 0.80;   // lang_model
  const SAME_ART = 0.70;         // identifier.SAME_ART
  const LANGS = { en: ["", "English", "EN"], ja: ["JA-", "Japanese", "JP"], ko: ["KO-", "Korean", "KR"],
                  "zh-tw": ["TW-", "Traditional Chinese", "繁中"], "zh-cn": ["CN-", "Simplified Chinese", "简中"] };
  const DEFAULTS = { detector: "auto", identifier: "auto", card_language: "auto", scan_rate: 5, same_card_memory: 10,
                     confirm_scans: 2, min_confidence: 50, collect_scans: false, new_card_banner: true, hit_rarity: true,
                     celebration: "full", alert_sound: true, refresh_prices_on_open: false };
  const langOf = (k) => { const s = String(k || ""); for (const [l, [p]] of Object.entries(LANGS)) if (p && s.startsWith(p)) return l; return "en"; };
  const langLabel = (l) => (LANGS[l] || LANGS.en)[1];
  const normName = (s) => String(s || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/^basic /, "").replace(/[^a-z0-9]+/g, " ").trim();
  const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

  // ---------------------------------------------------------------- settings
  const SETTINGS_KEY = "alakadex.settings";
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(lsGet(SETTINGS_KEY) || "{}") || {}; } catch {}
    return { ...DEFAULTS, ...s };
  }
  function saveSettings(updates) {
    const s = loadSettings();
    for (const [k, v] of Object.entries(updates || {})) if (k in DEFAULTS) s[k] = v;
    const changed = Object.fromEntries(Object.entries(s).filter(([k, v]) => !(k in DEFAULTS) || v !== DEFAULTS[k]));
    lsSet(SETTINGS_KEY, JSON.stringify(changed));
    return s;
  }

  // ---------------------------------------------------------------- downloads (store.mjs, for a classic script)
  const DATA_CACHE = "alakadex-data-";
  async function fetchCached(path, version, onProgress, total) {
    const url = new URL(path, BASE);
    url.searchParams.set("v", version);
    let cache = null;
    try { cache = await caches.open(DATA_CACHE + version); } catch {}
    const hit = cache && (await cache.match(url.href).catch(() => null));
    if (hit) { onProgress && onProgress(1, 1); return hit; }
    const res = await fetch(url.href, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    let blob;
    if (res.body && onProgress) {
      const reader = res.body.getReader(), parts = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); loaded += value.length;
        onProgress(loaded, Math.max(total || 0, loaded));
      }
      blob = new Blob(parts, { type: res.headers.get("content-type") || "application/json" });
    } else blob = await res.blob();
    const out = new Response(blob, { headers: { "content-type": blob.type } });
    if (cache) await cache.put(url.href, out.clone()).catch(() => {});
    return out;
  }

  // ---------------------------------------------------------------- the scanner worker
  let worker = null, seq = 0;
  const calls = new Map();
  const progress = {};               // file -> [loaded, total] while downloading
  function call(cmd, args, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      calls.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, args }, transfer || []);
    });
  }
  function startWorker() {
    if (worker) {
      worker.terminate();
      for (const p of calls.values()) p.reject(new Error("The scanner restarted"));
      calls.clear();
    }
    worker = new Worker(new URL("worker.mjs", BASE), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") { progress[m.file] = [m.loaded, m.total]; boot.show(); return; }
      const p = calls.get(m.id);
      if (!p) return;
      calls.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    };
    worker.onerror = (e) => { boot.fail("The scanner couldn't start: " + (e.message || "worker error")); };
  }

  // ---------------------------------------------------------------- catalog
  const C = { cards: new Map(), sets: new Map(), reprints: new Map(), byArt: new Map(), byName: new Map(),
              bySet: new Map(), hay: null, labels: ["en"], recognised: 0, built: null, ortProvider: null };
  function loadCatalog(cat) {
    const f = cat.fields, dirs = cat.img_dirs;
    const cards = new Map(), sets = new Map(), reprints = new Map(), byArt = new Map(), byName = new Map(), bySet = new Map();
    for (const [code, name, date, icon, era] of cat.sets) sets.set(code, { code, name, date, icon, era });
    for (const row of cat.cards) {
      const c = {};
      for (let i = 0; i < row.length; i++) {
        if (f[i] === "extra") Object.assign(c, row[i]);
        else if (f[i] === "img") c.img = row[i] ? `${dirs[row[i][0]]}/${row[i][1]}` : null;
        else c[f[i]] = row[i];
      }
      const slash = c.key.indexOf("/");
      c.set = c.key.slice(0, slash); c.number = c.key.slice(slash + 1);
      const lang = langOf(c.key);
      if (lang !== "en") c.lang = lang;
      cards.set(c.key, c);
      if (!bySet.has(c.set)) bySet.set(c.set, []);
      bySet.get(c.set).push(c);
      if (c.same_image_as) { if (!reprints.has(c.same_image_as)) reprints.set(c.same_image_as, []); reprints.get(c.same_image_as).push(c.key); }
      if (lang !== "en") {
        if (c.art) {
          if (!byArt.has(c.art)) byArt.set(c.art, {});
          (byArt.get(c.art)[lang] = byArt.get(c.art)[lang] || []).push(c.key);
        }
        if (c.name_en) {
          const k = lang + "|" + normName(c.name_en);
          if (!byName.has(k)) byName.set(k, []);
          byName.get(k).push(c.key);
        }
      }
    }
    Object.assign(C, { cards, sets, reprints, byArt, byName, bySet, hay: null });
  }

  function cardInfo(key) {
    const c = { ...(C.cards.get(key) || { key }) };
    const s = C.sets.get(c.set) || {};
    c.set_name = s.name; c.set_icon = s.icon; c.era = s.era; c.set_date = s.date;
    if (C.reprints.has(key)) {
      c.reprints = C.reprints.get(key).map((k) => { const r = C.cards.get(k); return { key: k, name: r.tcgp_name || r.name, set_name: (C.sets.get(r.set) || {}).name }; });
    }
    c.lang = langOf(key);
    if (c.lang !== "en") {
      c.img_src = c.img;
      c.lang_label = langLabel(c.lang);
      c.name = c.name_en || c.name;
    }
    return c;
  }
  const hiresUrl = (u) => !u ? u : u.includes("_SM.") ? u.replace("_SM.", "_LG.")
    : u.includes("images.pokemontcg.io") && !u.endsWith("_hires.png") ? u.slice(0, -4) + "_hires.png" : u;

  // ---------------------------------------------------------------- identification results
  // identifier._identify_model, from the worker's index rows
  function modelResult(r) {
    const candidates = r.keys.map((k, i) => ({ ...cardInfo(k), similarity: round(r.sims[i], 4) }));
    return {
      ok: true, method: "model", match: candidates[0], confidence: r.confidence, verified: r.verified,
      print_ambiguous: r.printAmbiguous, same_art: r.keys.filter((k, i) => i > 0 && r.same[i]),
      upside_down: r.flip, candidates, margins: { name: round(r.nameMargin, 4), print: round(r.printMargin, 4) }, ms: r.ms,
    };
  }

  // identifier._read_language: does the language model need to run for this read?
  function langPlan(ctx) {
    const forced = loadSettings().card_language;
    if (forced in LANGS && forced !== "auto") return { forced };
    if (ctx && ctx.lang in LANGS && C.labels.includes(ctx.lang)) return { reused: ctx.lang };
    return { model: true };
  }
  function readLanguage(plan, probs, ctx) {
    if (plan.forced) return [plan.forced, 1.0, {}, "setting"];
    if (plan.reused) return [plan.reused, null, {}, "reused"];
    if (!probs) return ["en", 1.0, { en: 1 }, "model"];
    let lang = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
    let conf = probs[lang];
    if (lang !== "en" && conf < SURE) { lang = "en"; conf = probs.en || 0; }
    const top = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
    if (lang === "en" && top !== "en" && top === (ctx || {}).near && probs[top] >= NEAR_SURE) { lang = top; conf = probs[top]; }
    return [lang, conf, probs, "model"];
  }
  const setDate = (k) => ((C.sets.get((C.cards.get(k) || {}).set) || {}).date) || "9";
  function printing(key, lang) {
    if (langOf(key) === lang) return [key];
    const art = (C.cards.get(key) || {}).art || key;
    const keys = ((C.byArt.get(art) || {})[lang] || []).slice();
    return keys.sort((a, b) => (a.includes("~") - b.includes("~")) || setDate(a).localeCompare(setDate(b)) || a.localeCompare(b));
  }
  async function sameArtPrintings(key, lang) {
    const c = C.cards.get(key) || {};
    const keys = C.byName.get(lang + "|" + normName(c.name_en || c.name || "")) || [];
    if (!keys.length) return [];
    const arts = keys.map((k) => (C.cards.get(k) || {}).art || k);
    const sims = await call("sims", { key, others: [...new Set(arts)] });
    return keys.map((k, i) => [sims[arts[i]], k]).filter(([s]) => s != null && s >= SAME_ART)
      .sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).map(([, k]) => k);
  }
  // identifier._apply_language: the art is matched; swap in the printing of the language read
  async function applyLanguage(res, plan, probs, ctx) {
    if (!res.ok) return res;
    const [lang, conf, p, source] = readLanguage(plan, probs, ctx);
    Object.assign(res, { lang, lang_label: langLabel(lang), lang_source: source, lang_conf: conf == null ? null : round(conf, 3),
                         lang_probs: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, round(v, 3)])) });
    if (source === "model") {
      const top = Object.keys(p).reduce((a, b) => (p[b] > p[a] ? b : a));
      res.lang_sure = lang !== "en" || (p.en || 0) >= SURE;
      res.lang_near = top !== "en" && p[top] >= NEAR_SURE ? top : null;
    }
    const m = res.match;
    let options = printing(m.key, lang);
    if (!options.length && lang === "en") return res;
    if (!options.length) {
      const top = m.similarity;
      for (const c of (res.candidates || []).slice(1)) {
        const near = top == null || c.similarity == null || top - c.similarity < 0.08;
        if (near && langOf(c.key) === lang) { options = [c.key]; break; }
      }
    }
    if (!options.length && lang !== langOf(m.key)) options = await sameArtPrintings(m.key, lang);
    if (!options.length) { res.lang_missing = lang !== langOf(m.key); return res; }
    if (options[0] !== m.key) {
      const nw = cardInfo(options[0]);
      nw.similarity = m.similarity; nw.art_of = m.key;
      res.match = nw;
      if (options.length > 1) { res.print_ambiguous = true; res.same_art = options.slice(1); }
    }
    const swapped = [], seen = new Set();
    for (const c of [res.match, ...options.slice(1).map(cardInfo), ...(res.candidates || []).slice(1)]) {
      const k = options.includes(c.key) ? c.key : (printing(c.key, lang)[0] || c.key);
      if (seen.has(k)) continue;
      seen.add(k);
      const info = k === c.key ? c : cardInfo(k);
      if (info.similarity == null) info.similarity = c.similarity;
      swapped.push(info);
    }
    res.candidates = swapped;
    return res;
  }

  // ---------------------------------------------------------------- prices and details
  // data/prices.json (web/prices.py, refreshed nightly by the site's publishing job):
  // {updated, by_tcgp: {TCGplayer product id: market price}}
  const P = { byTcgp: {}, updated: null, fetchedAt: 0 };
  const livePrice = (card) => (card && card.tcgp != null ? P.byTcgp[card.tcgp] : undefined);
  async function loadPrices(force) {
    if (!force && Date.now() - P.fetchedAt < 60000) return;
    P.fetchedAt = Date.now();
    try {
      const r = await fetch(new URL("data/prices.json", BASE), { cache: "no-cache" });
      if (!r.ok) throw new Error();
      const j = await r.json();
      P.byTcgp = j.by_tcgp || {}; P.updated = j.updated || null;
      try { (await caches.open("alakadex-prices")).put(new URL("data/prices.json", BASE).href, new Response(JSON.stringify(j))); } catch {}
    } catch {
      // offline: the last prices this phone saw
      try {
        const hit = await (await caches.open("alakadex-prices")).match(new URL("data/prices.json", BASE).href);
        if (hit) { const j = await hit.json(); P.byTcgp = j.by_tcgp || {}; P.updated = j.updated || null; }
      } catch {}
    }
  }
  const priceDay = () => (P.updated ? String(P.updated).slice(0, 10) : null);
  function englishTwin(card) {
    for (const k of [card.art, ((C.cards.get(card.jp) || {}).art)]) if (k && langOf(k) === "en" && C.cards.has(k)) return C.cards.get(k);
    return null;
  }
  function details(card) {
    const lang = card.lang || langOf(card.key);
    const own = livePrice(card);
    if (lang !== "en") {
      const out = { key: card.key, errors: [], lang, limitless: undefined };
      let price = null, source = null;
      if (own != null) { price = own; source = `TCGplayer ${langLabel(lang)} (${priceDay() || "saved"})`; }
      else if (card.usd != null) { price = card.usd; source = `TCGplayer ${langLabel(lang)} (saved price)`; }
      if (card.tcgp) out.tcgplayer = { url: `https://www.tcgplayer.com/product/${card.tcgp}` };
      out.rarity = card.rarity;
      const en = englishTwin(card);
      if (en) {
        const d = details(en);
        out.english = { key: en.key, name: en.name, price: d.market_price, source: d.price_source };
        out.limitless = d.limitless;
        out.rarity = out.rarity || d.rarity;
        if (price == null && d.market_price != null) { price = d.market_price; source = `English card (${d.price_source})`; }
      }
      const jp = C.cards.get(card.jp);
      if (price == null && jp) {
        const v = livePrice(jp) ?? jp.usd;
        if (v != null) { price = v; source = "Japanese card (TCGplayer Japan)"; }
      }
      out.rarity = out.rarity || "Unknown";
      out.market_price = price;
      out.price_source = source || `No ${langLabel(lang)} or English price found`;
      return out;
    }
    const price = own ?? card.usd ?? null;
    return {
      key: card.key, rarity: card.rarity || null, market_price: price,
      price_source: own != null ? `TCGplayer market (${priceDay() || "daily"})` : "TCGplayer (saved price)",
      errors: ["Tournament use is in the desktop app."],
      limitless: card.source === "tcgplayer" ? undefined
        : { url: `https://limitlesstcg.com/cards/${card.set}/${card.number}`, tcgplayer_id: card.tcgp || null, legality: {} },
      tcgplayer: card.tcgp ? { url: `https://www.tcgplayer.com/product/${card.tcgp}` } : undefined,
    };
  }
  const cardFor = (key) => C.cards.get(key) || (key.includes("/") ? { key, set: key.split("/")[0], number: key.slice(key.indexOf("/") + 1) } : null);

  // ---------------------------------------------------------------- pull history (IndexedDB)
  // stores: sessions (one per app launch, like data/sessions/*.json), crops (the phone's own
  // scan of each card logged, by card key: the Recap picture can use it, the card sites'
  // pictures can't be copied into an image)
  let dbp = null;
  function db() {
    return dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("alakadex", 2);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("sessions")) r.result.createObjectStore("sessions", { keyPath: "id" });
        if (!r.result.objectStoreNames.contains("crops")) r.result.createObjectStore("crops");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }
  async function tx(mode, fn, store = "sessions") {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), st = t.objectStore(store);
      const r = fn(st);
      t.oncomplete = () => res(r && "result" in r ? r.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const allSessions = () => tx("readonly", (st) => st.getAll());
  const SID = /^\d{8}-\d{6}(-[0-9a-z]{1,8})?$/;
  function summary(s) {
    const pulls = s.pulls || [], times = pulls.map((p) => p.at).filter(Boolean).sort();
    const top = pulls.reduce((b, p) => (!b || Number(p.price || 0) > Number(b.price || 0) ? p : b), null);
    const by = {};
    for (const p of pulls) { const code = p.set || String(p.key || "").split("/")[0]; by[code] = round((by[code] || 0) + Number(p.price || 0), 2); }
    return { id: s.id, started: s.started || times[0] || null, ended: s.ended || times[times.length - 1] || null,
             count: pulls.length, total: round(pulls.reduce((t, p) => t + Number(p.price || 0), 0), 2),
             cost: s.cost, cost_label: s.cost_label || "", cost_mode: s.cost_mode || "total", set_costs: s.set_costs || {}, by_set: by,
             top: top ? Object.fromEntries(["key", "name", "set", "number", "price", "img"].map((k) => [k, top[k]])) : null };
  }
  const toCost = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n > 0 ? n : null; };
  async function saveSession(id, b) {
    if (!SID.test(id)) throw new Error(`bad session id: ${id}`);
    const pulls = b.pulls || [], cost = toCost(b.cost), cost_mode = b.cost_mode === "set" ? "set" : "total";
    const set_costs = {};
    for (const [k, v] of Object.entries(b.set_costs || {})) { const c = toCost(v); if (c != null) set_costs[String(k).slice(0, 16)] = c; }
    if (!pulls.length && cost == null && !Object.keys(set_costs).length) { await tx("readwrite", (st) => st.delete(id)); return null; }
    const times = pulls.map((p) => p.at).filter(Boolean).sort();
    const s = { id, started: b.started || times[0] || null, ended: times[times.length - 1] || null, cost,
                cost_label: String(b.cost_label || "").slice(0, 80), cost_mode, set_costs, pulls };
    await tx("readwrite", (st) => st.put(s));
    keepCrops(pulls);
    return summary(s);
  }
  // the scans of this session's logged cards, kept for their Recap picture
  const crops = new Map(), keptCrops = new Set();
  function keepCrops(pulls) {
    const todo = [...new Set(pulls.map((p) => p.key))].filter((k) => crops.has(k) && !keptCrops.has(k));
    if (!todo.length) return;
    todo.forEach((k) => keptCrops.add(k));
    tx("readwrite", (st) => { for (const k of todo) st.put(crops.get(k), k); }, "crops").catch(() => {});
  }
  async function recapPicture(p, loadImage, officialSrc) {
    let blob = crops.get(p.key);
    if (!blob) blob = await tx("readonly", (st) => st.get(p.key), "crops").catch(() => null);
    if (blob) {
      const url = URL.createObjectURL(blob), img = await loadImage(url);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (img) return img;
    }
    return loadImage(officialSrc(p));
  }
  async function collection(exclude) {
    const out = {};
    for (const s of await allSessions()) {
      if (s.id === exclude) continue;
      for (const x of s.pulls || []) {
        if (!x.key) continue;
        const c = out[x.key] || (out[x.key] = { n: 0, last: "" });
        c.n++; if ((x.at || "") > c.last) c.last = x.at;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- sets
  function numberKey(n) {
    const m = /^(\D*)(\d+)(.*)$/.exec(String(n));
    return m ? [m[1], Number(m[2]), m[3]] : [String(n), 0, ""];
  }
  const cmpNum = (a, b) => { const x = numberKey(a), y = numberKey(b); return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]); };

  // ---------------------------------------------------------------- updates (new data on the site)
  const U = { job: { state: "idle", step: 0, steps: 0, label: "", log: [], error: null, summary: null }, latest: null };
  async function latestVersion() {
    const r = await fetch(new URL("version.json", BASE), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return (U.latest = await r.json());
  }
  // app.js shows `error` as the dialog's summary line, so the web version says it there
  async function updateCheck() {
    const base = { new_sets: [], changed_sets: [], tcgplayer_new: 0, can_retrain: false,
                   retrain_note: "happens in the desktop app", running: U.job.state === "running" };
    try {
      const v = await latestVersion();
      const have = installed();
      const available = !!have && v.data !== have.data;
      if (!available) return { ...base, available, error: `Your card data is up to date (${C.recognised.toLocaleString()} cards recognised, built ${(have || v).built}).` };
      const newSets = Object.entries(v.set_names || {}).filter(([c]) => !C.sets.has(c)).map(([, name]) => name);
      const more = Math.max(0, v.cards - (have.cards || v.cards));
      const mb = Object.entries(v.files || {}).filter(([f]) => !f.startsWith("ort/")).reduce((t, [, n]) => t + n, 0) / 1e6;
      return { ...base, available, error: "New card data: "
        + [newSets.length && `${newSets.length} new set${newSets.length > 1 ? "s" : ""} (${newSets.slice(0, 6).join(", ")}${newSets.length > 6 ? "…" : ""})`,
           more && `${more.toLocaleString()} more cards`].filter(Boolean).join(", ")
        + `. UPDATE NOW downloads it (about ${Math.round(mb)} MB).` };
    } catch (e) {
      return { ...base, available: false, error: "Can't reach the Alakadex site to check for new cards (offline?)." };
    }
  }
  async function updateStart() {
    if (U.job.state === "running") return;
    const j = U.job = { state: "running", step: 1, steps: 2, label: "Downloading new card data", log: [], error: null, summary: null };
    const before = C.cards.size, beforeSets = new Set(C.sets.keys());
    try {
      const v = U.latest || (await latestVersion());
      j.log.push(`Card data ${v.data} (built ${v.built}): ${v.cards.toLocaleString()} cards, ${v.recognised.toLocaleString()} recognised.`);
      readyP = start(v, (msg) => j.log.push(msg));
      await readyP;
      j.step = 2; j.label = "Cleaning up";
      const newSets = [...C.sets.keys()].filter((c) => !beforeSets.has(c)).map((c) => ({ code: c, name: C.sets.get(c).name }));
      j.summary = { new_cards: Math.max(0, C.cards.size - before), new_sets: newSets, recognisable: C.recognised, failed_downloads: 0 };
      j.state = "done"; j.label = "Done";
    } catch (e) {
      j.state = "error"; j.error = String(e.message || e);
    }
  }
  // card data and runtimes this version doesn't use any more (an earlier UPDATE's)
  async function dropOldData(...keep) {
    try {
      for (const k of await caches.keys()) if (k.startsWith(DATA_CACHE) && !keep.some((v) => k === DATA_CACHE + v)) await caches.delete(k);
    } catch {}
  }

  // ---------------------------------------------------------------- start-up
  const VERSION_KEY = "alakadex.dataVersion";
  const installed = () => { try { return JSON.parse(lsGet(VERSION_KEY) || "null"); } catch { return null; } };
  let readyP = null, readyErr = null, isReady = false;
  async function start(v, log) {
    isReady = false; readyErr = null;
    for (const k in progress) delete progress[k];
    boot.downloading = !(await hasData(v));
    boot.cards = v.cards;
    boot.show();
    startWorker();
    const sizes = v.files || {};
    const catP = fetchCached("data/cards.json", v.data, (l, t) => { progress["data/cards.json"] = [l, t]; boot.show(); }, sizes["data/cards.json"])
      .then((r) => r.json());
    const workerP = call("init", { version: v.data, ortVersion: "ort-" + v.ort, sizes, gpu: lsGet("alakadex.webgpu") !== "0" });
    const [cat, info] = await Promise.all([catP, workerP, loadPrices(true)]);
    loadCatalog(cat);
    C.labels = info.labels; C.recognised = info.cards; C.built = info.built || v.built;
    C.ortProvider = info.provider; C.gpuError = info.gpuError; C.threads = info.threads;
    await dropOldData(v.data, "ort-" + v.ort);
    lsSet(VERSION_KEY, JSON.stringify({ data: v.data, ort: v.ort, built: v.built, cards: v.cards, files: v.files }));
    isReady = true;
    if (typeof window.refreshStatus === "function") window.refreshStatus(true).catch(() => {});   // app.js: card count, settings dot
    log && log(`Scanner ready (${info.provider}${info.threads > 1 ? `, ${info.threads} threads` : ""}).`);
    boot.done();
  }
  async function hasData(v) {
    try {
      const c = await caches.open(DATA_CACHE + v.data);
      const u = new URL("data/embed.i8", BASE); u.searchParams.set("v", v.data);
      return !!(await c.match(u.href));
    } catch { return false; }
  }
  function boot0() {
    // the installed card data if this phone has it (works offline), else the site's latest
    readyP = (async () => {
      const have = installed();
      let v = null;
      if (have && (await hasData(have))) v = have;
      if (!v) v = await latestVersion();
      if (!v.ort) v.ort = (have && have.ort) || "1.22.0";
      await start(v);
    })().catch((e) => { readyErr = e; boot.fail(String(e.message || e)); throw e; });
    readyP.catch(() => {});
  }
  const whenReady = async () => { if (!isReady) await readyP; if (readyErr) throw readyErr; };

  // ---------------------------------------------------------------- the API
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const lastCrop = { url: null };
  const cropUrl = (blob) => { if (lastCrop.url) URL.revokeObjectURL(lastCrop.url); return (lastCrop.url = blob ? URL.createObjectURL(blob) : ""); };
  const sensorCrops = [];
  const keepUrl = (blob) => { const u = URL.createObjectURL(blob); sensorCrops.push(u); if (sensorCrops.length > 30) URL.revokeObjectURL(sensorCrops.shift()); return u; };
  const normQuad = (q, w, h) => q.map(([x, y]) => [round(x / w, 4), round(y / h, 4)]);
  const dataUrlBlob = (u) => fetch(u).then((r) => r.blob());

  const routes = {
    "GET /api/status": () => {
      const s = loadSettings();
      const counts = {};
      if (isReady) for (const k of C.cards.keys()) { const l = langOf(k); if (l !== "en") counts[l] = (counts[l] || 0) + 1; }
      return {
        index_ready: isReady, index_error: isReady ? null : readyErr ? String(readyErr.message || readyErr) : boot.statusText(),
        cards: isReady ? C.recognised : 0, sets: isReady ? C.sets.size : 0, built: C.built, calibration: { threshold: THRESHOLD },
        threshold: THRESHOLD, settings: s, defaults: DEFAULTS,
        detector: { model_ready: isReady, model_error: null, using_model: true },
        languages: { model_ready: isReady, cards: counts },
      };
    },
    "POST /api/settings": (q, b) => saveSettings(b),
    "POST /api/reload": () => ({ ok: isReady, error: null }),
    "GET /api/update/check": () => updateCheck(),
    "POST /api/update/start": () => { updateStart(); return { started: true, ...U.job }; },
    "GET /api/update/status": () => U.job,
    "POST /api/update/cancel": () => U.job,

    "POST /api/detect": async (q, b, raw) => {
      await whenReady();
      const box = q.get("box") ? q.get("box").split(",").map(Number) : null;
      return call("detect", { blob: raw, box, free: q.get("free") === "1" });
    },
    "POST /api/identify": async (q, b, raw, ctype) => {
      await whenReady();
      let blob = raw, body = JSON.parse(q.get("opts") || "{}");
      if (!ctype.startsWith("image/")) { body = b; blob = await dataUrlBlob(b.image); }
      const ctx = { lang: body.lang, near: body.lang_near };
      const plan = langPlan(ctx);
      const r = await call("identify", { blob, opts: { box: body.box, free: body.free, quad: body.quad }, threshold: THRESHOLD, lang: !!plan.model });
      if (!r.found) return { ok: false, error: body.box ? "No card in the card area. Put one card inside the box." : "No card found. Hold one card in view, or use the card area box." };
      const res = await applyLanguage(modelResult(r.res), plan, r.langProbs, ctx);
      res.crop = cropUrl(r.crop);
      if (r.crop) { crops.delete(res.match.key); crops.set(res.match.key, r.crop); keptCrops.delete(res.match.key); }
      if (crops.size > 300) crops.delete(crops.keys().next().value);
      res.quad = normQuad(r.quad, r.w, r.h);
      res.sig = r.sig;
      res.low_confidence = !res.ok || (res.confidence || 0) < THRESHOLD;
      return res;
    },
    "POST /api/locate": async (q, b) => {
      await whenReady();
      const plan = langPlan({});
      const r = await call("locate", { blob: await dataUrlBlob(b.image), x: b.x, y: b.y, threshold: THRESHOLD, lang: !!plan.model });
      if (!r.found) return { ok: false, error: "no card under the pointer" };
      const res = await applyLanguage(modelResult(r.res), plan, r.langProbs, {});
      res.quad = normQuad(r.quad, r.w, r.h);
      res.crop = keepUrl(r.crop);
      res.low_confidence = !res.ok || (res.confidence || 0) < UNSURE_BELOW;
      res.match.img_large = hiresUrl(res.match.img || "");
      if (b.details) { await loadPrices(); res.details = details(C.cards.get(res.match.key) || res.match); }
      return res;
    },
    "POST /api/frame": async (q, b) => {
      await whenReady();
      const t0 = performance.now();
      const plan = langPlan({});
      const r = await call("frame", { blob: await dataUrlBlob(b.image), maxCards: Number(b.max_cards || 16), conf: FRAME_DET_CONF, lang: !!plan.model });
      const found = [];
      for (const f of r.found) {
        if (!f) continue;
        found.push([f.quad, await applyLanguage(modelResult(f.res), plan, f.langProbs, {})]);
      }
      // an art window or text box can pass as a card outline too: most confident first, drop
      // any outline lying inside (or containing) one already kept
      const ctr = (qq) => [qq.reduce((s, p) => s + p[0], 0) / 4, qq.reduce((s, p) => s + p[1], 0) / 4];
      const inside = (qq, [px, py]) => {
        let c = false;
        for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = qq[i], [xj, yj] = qq[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c; }
        return c;
      };
      const kept = [], cards = [];
      if (b.details !== false) await loadPrices();
      for (const [quad, res] of found.sort((a, b2) => b2[1].confidence - a[1].confidence)) {
        if (kept.some((k) => inside(k, ctr(quad)) || inside(quad, ctr(k)))) continue;
        kept.push(quad);
        const m = res.match;
        m.img_large = hiresUrl(m.img || "");
        cards.push({ quad: normQuad(quad, r.w, r.h), match: m, confidence: res.confidence, low_confidence: res.confidence < UNSURE_BELOW,
                     print_ambiguous: !!res.print_ambiguous, candidates: (res.candidates || []).slice(0, 4),
                     details: b.details === false ? undefined : details(C.cards.get(m.key) || m) });
      }
      const total = cards.reduce((t, c) => t + ((c.details || {}).market_price ?? c.match.usd ?? 0), 0);
      return { ok: true, cards, total: round(total, 2), ms: Math.round(performance.now() - t0) };
    },

    "GET /api/details": async (q) => {
      await whenReady(); await loadPrices();
      const card = cardFor(q.get("key") || "");
      return card ? details(card) : json({ error: "unknown card" }, 404);
    },
    "POST /api/prices": async (q, b) => {
      await whenReady(); await loadPrices(true);
      const out = {};
      for (const key of [...new Set((b.keys || []).map(String))].slice(0, 40)) {
        const card = cardFor(key);
        if (!card) { out[key] = { error: "unknown card" }; continue; }
        const d = details(card);
        out[key] = d.market_price == null ? { error: "no price found" } : { price: d.market_price, source: d.price_source };
      }
      return out;
    },
    "GET /api/card": async (q) => {
      await whenReady();
      const k = q.get("key") || "";
      return C.cards.has(k) ? cardInfo(k) : json({ error: "unknown card" }, 404);
    },
    "GET /api/printings": async (q) => {
      await whenReady();
      const key = q.get("key") || "";
      if (!C.cards.has(key)) return [];
      const art = C.cards.get(key).art || key;
      let keys = langOf(art) === "en" && C.cards.has(art) ? [art] : [];
      for (const lang of ["ja", "ko", "zh-tw", "zh-cn"]) {
        keys = keys.concat(((C.byArt.get(art) || {})[lang] || []).slice()
          .sort((a, b) => (a.includes("~") - b.includes("~")) || setDate(a).localeCompare(setDate(b)) || a.localeCompare(b)));
      }
      if (langOf(art) !== "en" && !keys.includes(art)) keys.unshift(art);
      return [...new Set(keys)].map((k) => {
        const c = cardInfo(k);
        return { key: c.key, lang: c.lang, lang_label: c.lang_label || "English", name: c.name, name_local: c.name_local,
                 set: c.set, set_name: c.set_name, number: c.number, img: c.img };
      });
    },
    "GET /api/search": async (q) => {
      await whenReady();
      const parts = (q.get("q") || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!parts.length) return [];
      if (!C.hay) {
        C.hay = [];
        for (const c of C.cards.values()) {
          C.hay.push([c.key, `${c.name} ${c.name_en || ""} ${c.name_local || ""} ${c.set} ${c.number} ${(C.sets.get(c.set) || {}).name || ""}`.toLowerCase()]);
        }
      }
      const hits = [];
      for (const [k, hay] of C.hay) {
        if (parts.every((p) => hay.includes(p))) { hits.push(cardInfo(k)); if (hits.length >= 40) break; }
      }
      return hits;
    },
    "GET /api/sessions": async () => (await allSessions()).filter((s) => s && s.id).map(summary)
      .sort((a, b) => String(b.started || "").localeCompare(String(a.started || ""))),
    "GET /api/collection": async (q) => collection(q.get("exclude") || ""),
    "GET /api/sets": async () => {
      await whenReady();
      const out = {};
      for (const [code, s] of C.sets) out[code] = { name: s.name, date: s.date, icon: s.icon, era: s.era, lang: langOf(code), total: (C.bySet.get(code) || []).length };
      return out;
    },
    "GET /api/set": async (q) => {
      await whenReady();
      const code = q.get("code") || "", s = C.sets.get(code);
      if (!s) return json({ error: "unknown set" }, 404);
      const lang = langOf(code);
      const cards = (C.bySet.get(code) || []).slice().sort((a, b) => cmpNum(a.number, b.number)).map((c) => {
        const r = { key: c.key, name: c.name, number: c.number, rarity: c.rarity, img: c.img, usd: livePrice(c) ?? c.usd };
        if (lang !== "en") Object.assign(r, { name: c.name_en || c.name, name_local: c.name_local });
        return r;
      });
      return { code, name: s.name, date: s.date, icon: s.icon, lang, cards };
    },
  };
  async function sessionRoute(method, id, body) {
    if (!SID.test(id)) return json({ error: `bad session id: ${id}` }, 400);
    if (method === "GET") { const s = await tx("readonly", (st) => st.get(id)); return s || json({ error: "no such session" }, 404); }
    if (method === "DELETE") { const s = await tx("readonly", (st) => st.get(id)); await tx("readwrite", (st) => st.delete(id)); return { deleted: !!s }; }
    return { summary: await saveSession(id, body || {}) };
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/") && !url.pathname.includes("/api/")) return nativeFetch(input, init);
    const path = url.pathname.slice(url.pathname.indexOf("/api/"));
    const method = (init.method || "GET").toUpperCase();
    const ctype = (init.headers && (init.headers["Content-Type"] || init.headers["content-type"])) || "";
    const raw = init.body instanceof Blob ? init.body : null;
    let body = null;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch {} }
    try {
      let out;
      if (path.startsWith("/api/sessions/")) out = await sessionRoute(method, decodeURIComponent(path.slice(14)), body);
      else {
        const h = routes[`${method} ${path}`];
        if (!h) return json({ error: `no ${method} ${path} in the web version` }, 404);
        out = await h(url.searchParams, body, raw, ctype);
      }
      if (path === "/api/identify") scanNote(out && out.ok === false ? out.error : null);
      return out instanceof Response ? out : json(out);
    } catch (e) {
      if (path === "/api/identify") scanNote(String((e && e.message) || e));
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  };
  // A failed scan read says why for a few seconds. app.js puts it in the hud line, which the
  // card-area outline check rewrites every 50 ms, so on a phone the reason was never seen.
  let noteTimer = null;
  function scanNote(msg) {
    let el = document.getElementById("web-scan-note");
    if (!msg) { if (el) el.remove(); return; }
    const hud = document.getElementById("hud");
    if (!hud || !hud.parentElement) return;
    if (!el) {
      el = document.createElement("div");
      el.id = "web-scan-note";
      el.className = "web-scan-note";
      el.setAttribute("role", "status");
      hud.parentElement.appendChild(el);
    }
    el.textContent = "Scan didn't work: " + msg;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => el.remove(), 4000);
  }

  // ---------------------------------------------------------------- first-run screen
  const boot = {
    el: null, downloading: false, failed: null,
    statusText() {
      const files = Object.values(progress);
      const total = files.reduce((t, [, n]) => t + n, 0), got = files.reduce((t, [l]) => t + l, 0);
      return this.downloading ? `Downloading card data… ${total ? Math.round((got / total) * 100) : 0}%` : "Starting the scanner…";
    },
    show() {
      if (!document.body) return;
      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "web-boot";
        this.el.setAttribute("role", "status");
        document.body.appendChild(this.el);
      }
      const files = Object.entries(progress);
      const total = files.reduce((t, [, [, n]]) => t + n, 0), got = files.reduce((t, [, [l]]) => t + l, 0);
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
      this.el.classList.toggle("first", this.downloading);
      this.el.innerHTML = this.failed
        ? `<div class="wb-card"><div class="wb-title px">SCANNER OFF</div><p>${this.failed.replace(/</g, "&lt;")}</p>
            <button class="wbtn" onclick="location.reload()">TRY AGAIN</button></div>`
        : this.downloading
        ? `<div class="wb-card"><div class="wb-title px">GETTING READY</div>
            <p>Downloading the card scanner and ${Math.round((this.cards || 92000) / 1000)}k cards, once. After this Alakadex works offline.</p>
            <div class="wb-bar"><i style="width:${pct}%"></i></div>
            <div class="wb-sub px">${pct}% · ${(got / 1e6).toFixed(0)} / ${(total / 1e6 || 60).toFixed(0)} MB</div>
            <p class="wb-note">Wi-Fi recommended. You can look around while it loads.</p>
            <button class="wbtn" onclick="this.closest('.web-boot').classList.add('mini')">HIDE</button></div>`
        : `<div class="wb-chip px">STARTING SCANNER…</div>`;
    },
    done() { this.failed = null; if (this.el) { this.el.remove(); this.el = null; } },
    fail(msg) { this.failed = msg; this.show(); },
  };

  // ---------------------------------------------------------------- helpers app.js calls (web patches)
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; renderInstall(); });
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function renderInstall() {
    const box = document.getElementById("web-install");
    if (!box) return;
    const how = standalone() ? "Alakadex is installed on this device."
      : installEvt ? `<button type="button" class="wbtn gold" id="web-install-btn">INSTALL APP</button>`
      : isIOS() ? "In Safari, tap Share, then <b>Add to Home Screen</b>."
      : "Use your browser's menu: <b>Install app</b> or <b>Add to Home screen</b>.";
    box.querySelector(".wi-how").innerHTML = how;
    const b = document.getElementById("web-install-btn");
    if (b) b.onclick = async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderInstall(); };
  }
  async function renderStorage() {
    const el = document.getElementById("web-storage");
    if (!el) return;
    let used = "";
    try { const e = await navigator.storage.estimate(); used = `${Math.round((e.usage || 0) / 1e6)} MB used on this device`; } catch {}
    const v = installed();
    const chip = !isReady ? "" : C.ortProvider === "webgpu" ? "finding cards on the graphics chip"
      : C.gpuError ? "graphics chip not used (" + C.gpuError + ")" : "running on the processor";
    el.textContent = [v && `Card data from ${v.built}`, P.updated && `prices from ${priceDay()}`, chip, used].filter(Boolean).join(" · ");
  }
  function addPhonePanel() {
    // Settings gets a PHONE APP box: install, what's stored, the GPU switch
    const col = document.querySelector("#settings .settings-col");
    if (!col || document.getElementById("web-install")) return;
    const box = document.createElement("div");
    box.className = "dscreen";
    box.id = "web-install";
    box.innerHTML = `<h3>PHONE APP</h3>
      <p class="wi-how"></p>
      <p class="muted wi-note">Everything runs on this device: the camera picture never leaves it, and your pulls are saved here.
        Export CSV keeps a copy.</p>
      <label class="check-row"><input type="checkbox" id="web-gpu"><span><span>Use the graphics chip for finding cards</span>
        <small>Faster on phones that have one; Alakadex checks it gives the same answers first. Takes effect next time Alakadex opens.</small></span></label>
      <small class="muted" id="web-storage"></small>`;
    col.insertBefore(box, col.firstChild);
    const gpu = document.getElementById("web-gpu");
    gpu.checked = lsGet("alakadex.webgpu") !== "0";
    gpu.onchange = () => lsSet("alakadex.webgpu", gpu.checked ? "1" : "0");
    renderInstall();
    document.getElementById("btn-settings").addEventListener("click", renderStorage);
  }

  window.alakadexWeb = {
    cardImg: (p) => (p && p.img) || ((C.cards.get(p && p.key) || {}).img) || "",
    // phones: the share sheet (save the image, send it) instead of a download
    async share(filename, blob) {
      if (!(navigator.canShare && matchMedia("(pointer: coarse)").matches)) return false;
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      if (!navigator.canShare({ files: [file] })) return false;
      try { await navigator.share({ files: [file], title: filename }); } catch (e) { if (e && e.name === "AbortError") return true; return false; }
      return true;
    },
    recapPicture,
    status: () => ({ ready: isReady, provider: C.ortProvider, threads: C.threads, gpuError: C.gpuError, progress: { ...progress } }),
  };

  // ---------------------------------------------------------------- go
  document.documentElement.classList.add("web", matchMedia("(pointer: coarse)").matches ? "touch" : "mouse");
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) document.documentElement.classList.add("no-share");
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  addPhonePanel();
  boot0();
  if ("serviceWorker" in navigator && isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register(new URL("sw.js", BASE)).catch(() => {}));
  }
})();
