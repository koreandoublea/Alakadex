// Alakadex front end: webcam capture, live card outline, auto-scan, results, pull log.
const $ = (id) => document.getElementById(id);
// settings saved before the rename to Alakadex lived under "pokescan.*": carry them over once
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("pokescan.")) continue;
    const nk = "alakadex." + k.slice(9);
    if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch {}
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d");
const grab = document.createElement("canvas"), gctx = grab.getContext("2d");

const state = {
  stream: null,
  quad: null,            // normalised corners from /api/detect
  history: [],           // [{t, quad}] for stability check
  sig: null,
  lastScanSig: null,
  lastScanAt: null,
  lastSeenAt: null,      // last scan, or last time the scanned card came back as the same copy
  sameCard: false,       // the card in view is the one just scanned (same-card memory)
  scanning: false,
  detecting: false,
  status: null,
  current: null,         // {pullId, match, ...}
  pulls: [],             // this session's pull log, newest first (saved to data/sessions/)
  paused: false,         // Pause: nothing is scanned or logged until Resume
  quads: [],             // every card outline in view (normalised)
  sourceKind: null,      // "camera" | "screen"
  sensor: false,         // hover-to-identify mode
  pointer: null,         // {x, y} normalised video coords while hovering
  hit: null,             // last Sensor result {quad, res, t}
  sensorSeq: 0,
  sensorBusy: false,
  frozen: false,         // Sensor is looking at a still frame (#frozen) instead of the live video
  frozenScanned: false,  // card outlines for the frozen frame have been found
  tally: null,           // Scan frame result {cards: [...], total, ms}, quads in video coords
  pinned: false,         // popup stays put until unpinned
  autoFroze: false,      // frozen by pinning (unfreeze on unpin)
};
// the Pokédex shell: a short lens flash after a log / hit, the source to start with the ON/OFF
// button, the picked card while a low-confidence read waits, what the Wrong card window fixes
const dex = { flash: null, flashTimer: null, prefSrc: "camera", pendSel: 0, wrongMode: null, focusPaid: null };
const frozen = $("frozen");
// the frame the Sensor works on: the frozen still if there is one, else the live video
const frameSource = () => (state.frozen ? frozen : video);

// ---------------------------------------------------------------- helpers
const money = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) j.error = `HTTP ${r.status}`;
  return j;
}
function hamming(a, b) {
  if (!a || !b) return 64;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
function rarityTier(r) {
  r = (r || "").toLowerCase();
  if (/special illustration|hyper|secret|gold|rainbow|crown|mega hyper|black white/.test(r)) return "t4";
  if (/illustration|ultra|double|ace spec|shiny|holo rare v|rare holo|full art|amazing|radiant|ex|gx|vmax|vstar|\bv\b/.test(r)) return "t3";
  if (/rare|holo/.test(r)) return "t2";
  return "t1";
}

// ---------------------------------------------------------------- status & settings
async function refreshStatus(force = false) {
  const s = await api("/api/status" + (force ? "?refresh=1" : ""));
  state.status = s;
  showCardLang(s.settings?.card_language || "auto");
  const pi = $("pill-index");
  if (s.index_ready) {
    pi.textContent = `${s.cards.toLocaleString()} cards · ${s.sets} sets`;
    pi.className = "pill ok";
    $("db-built").textContent = s.built ? `Index built ${s.built}` : "";
  } else {
    pi.textContent = "Card data not ready yet";
    pi.className = "pill warn";
    $("db-built").textContent = s.index_error || "";
  }
  showSettingsDot();
}
// the ⚙ button gets a dot when new cards can be downloaded or the index is missing
function showSettingsDot() {
  const missing = state.status && !state.status.index_ready;
  $("settings-dot").classList.toggle("hidden", !(upd.check?.available || missing));
  $("btn-settings").title = upd.check?.available ? "Settings: new cards available" : missing ? "Settings: card index missing" : "Settings and card database";
}

// Settings save as soon as they change (no Save button); only values changed from the
// defaults are written to settings.json
function showSettings(s) {
  $("s-detector").value = s.detector === "classic" ? "classic" : "auto";
  $("s-rate").value = scanRate(); showRate();
  $("s-memory").value = sameCardMemory(); showMemory();
  $("s-confirm").value = confirmScans(); showConfirm();
  $("s-minconf").value = minConfidence(); showMinConf();
  $("s-newbanner").checked = s.new_card_banner !== false;
  $("s-hit").value = sensorOpts.hit;
  $("s-hitrarity").checked = s.hit_rarity !== false;
  showCelebrationMode(s.celebration === "banner" ? "banner" : "full");
  $("s-sound").checked = s.alert_sound !== false;
  $("s-refreshopen").checked = !!s.refresh_prices_on_open;
}
const showCelebrationMode = (mode) =>
  document.querySelectorAll("#s-celebration button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
// a setting from settings.json (the default until the status has loaded)
const setting = (k, def) => (state.status?.settings?.[k] ?? def);
function openSettings() {
  showSettings(state.status?.settings || {});
  const d = state.status?.detector;
  $("s-detector-status").textContent = !d ? "" : d.model_ready ? "Model loaded (data/models/card_detector.onnx)."
    : `${d.model_error || "Model not available"} Using the classic finder.`;
  $("s-saved").textContent = "Changes are saved automatically.";
  if (!$("settings").open) $("settings").showModal();
}
$("btn-settings").onclick = openSettings;
$("s-close").onclick = () => $("settings").close();
// ALERTS key: Settings, with the Pull alerts box brought into view
$("btn-alerts").onclick = () => {
  openSettings();
  const b = $("alert-box");
  b.scrollIntoView({ block: "nearest" });
  b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash");
};
let settingsTimer = null, settingsSaving = null;
function saveSettingsSoon() { clearTimeout(settingsTimer); settingsTimer = setTimeout(saveSettingsNow, 300); }
function saveSettingsNow(values) {
  clearTimeout(settingsTimer); settingsTimer = null;
  const body = values || {
    detector: $("s-detector").value,
    scan_rate: Number($("s-rate").value),
    same_card_memory: Number($("s-memory").value),
    confirm_scans: Number($("s-confirm").value),
    min_confidence: Number($("s-minconf").value),
    new_card_banner: $("s-newbanner").checked,
    hit_rarity: $("s-hitrarity").checked,
    celebration: document.querySelector("#s-celebration button.on")?.dataset.mode || "full",
    alert_sound: $("s-sound").checked,
    refresh_prices_on_open: $("s-refreshopen").checked,
  };
  return (settingsSaving = (async () => {
    const s = await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .catch((e) => ({ error: String(e) }));
    if (s.error) { $("s-saved").textContent = "Couldn't save: " + s.error; return; }
    if (state.status) state.status.settings = s;   // takes effect at once
    $("s-saved").textContent = "Saved ✓";
  })());
}
for (const id of ["s-rate", "s-memory", "s-confirm", "s-minconf"]) $(id).addEventListener("input", saveSettingsSoon);
for (const id of ["s-newbanner", "s-hitrarity", "s-sound", "s-refreshopen"]) $(id).addEventListener("change", () => saveSettingsNow());
$("s-celebration").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  showCelebrationMode(b.dataset.mode);
  saveSettingsNow();
});
// card language: Auto lets the language model read each card; a fixed language is the
// fallback when Auto gets a stack of cards wrong (outlined while it's set)
function showCardLang(v) {
  $("card-lang").value = v;
  $("card-lang").closest(".lang-select").classList.toggle("manual", v !== "auto");
}
$("card-lang").addEventListener("change", () => {
  showCardLang($("card-lang").value);
  saveSettingsNow({ card_language: $("card-lang").value });
});
// the hit price is the Sensor's "Hit alert at $" (one value for both)
$("s-hit").addEventListener("input", () => { setHitAlert($("s-hit").value); $("s-saved").textContent = "Saved ✓"; });
$("s-detector").addEventListener("change", async () => { await saveSettingsNow(); refreshStatus(true); });
$("s-reset").onclick = async () => {
  const def = state.status?.defaults;
  if (!def) return;
  const keys = ["detector", "scan_rate", "same_card_memory", "confirm_scans", "min_confidence",
                "new_card_banner", "hit_rarity", "celebration", "alert_sound", "refresh_prices_on_open"];
  setHitAlert(SENSOR_DEFAULTS.hit);
  await saveSettingsNow(Object.fromEntries(keys.map((k) => [k, def[k]])));
  showSettings(state.status.settings);
  $("s-saved").textContent = "Back to defaults ✓";
  refreshStatus(true);
};
$("settings").addEventListener("close", async () => {
  if (settingsTimer) saveSettingsNow();   // a slider change still waiting to be saved
  await settingsSaving;
  refreshStatus(true);
});
// ---------------------------------------------------------------- update cards
const upd = { poll: null, check: null };
function updateSummary(c) {
  if (!c) return "Checking for new sets…";
  if (c.error) return c.error;
  const bits = [];
  if (c.new_sets.length) bits.push(`${c.new_sets.length} new set${c.new_sets.length > 1 ? "s" : ""}: ${c.new_sets.map((s) => s.name).join(", ")}`);
  const added = c.changed_sets.reduce((n, s) => n + Math.max(0, s.added), 0);
  if (added) bits.push(`${added} new card${added > 1 ? "s" : ""} in ${c.changed_sets.length} existing set${c.changed_sets.length > 1 ? "s" : ""}`);
  if (c.tcgplayer_new) bits.push(`${c.tcgplayer_new} new card${c.tcgplayer_new > 1 ? "s" : ""} on TCGplayer`);
  return bits.length ? "New: " + bits.join("; ") + "." : "Your card database is up to date. You can still run an update to catch anything just released.";
}
async function checkUpdates(force = false) {
  const c = await api("/api/update/check" + (force ? "?refresh=1" : ""));
  upd.check = c;
  $("update-dot").classList.toggle("hidden", !c.available);
  $("key-update-dot").classList.toggle("hidden", !c.available);
  $("btn-key-update").title = c.available ? "New cards available: click to update" : "Update cards: get new sets";
  $("btn-update").title = c.available ? "New cards available: click to update" : "Update cards: get new sets";
  showSettingsDot();
  return c;
}
function showUpdateJob(j) {
  const running = j.state === "running";
  $("u-progress").classList.toggle("hidden", j.state === "idle");
  $("u-options").classList.toggle("hidden", running);
  $("u-start").hidden = running;
  $("u-cancel").hidden = !running;
  $("u-bar").style.width = (j.state === "done" ? 100 : j.steps ? Math.round(((j.step - 1) / j.steps) * 100) : 0) + "%";
  $("u-label").textContent = j.state === "done" ? "Done." : j.state === "error" ? "Failed: " + j.error
    : j.state === "cancelled" ? "Cancelled." : `Step ${j.step} of ${j.steps}: ${j.label}`;
  const log = $("u-log");
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.textContent = j.log.join("\n");
  if (stick) log.scrollTop = log.scrollHeight;
  if (j.state === "done" && j.summary) {
    const s = j.summary;
    $("u-summary").textContent = `Added ${s.new_cards} card${s.new_cards === 1 ? "" : "s"}`
      + (s.new_sets.length ? ` in ${s.new_sets.length} new set${s.new_sets.length > 1 ? "s" : ""} (${s.new_sets.map((x) => x.name).join(", ")})` : "")
      + `. ${s.recognisable.toLocaleString()} cards are now recognised.`
      + (s.failed_downloads ? ` ${s.failed_downloads} scans couldn't be downloaded; run again to retry.` : "");
  }
}
async function pollUpdate() {
  const j = await api("/api/update/status");
  showUpdateJob(j);
  if (j.state === "running") { upd.poll = setTimeout(pollUpdate, 1500); return; }
  upd.poll = null;
  if (j.state === "done") { refreshStatus(true); checkUpdates(true); coll.sets = null; for (const k in setCache) delete setCache[k]; loadSets(); }
}
async function openUpdate() {
  $("update").showModal();
  $("u-summary").textContent = updateSummary(null);
  const j = await api("/api/update/status");
  showUpdateJob(j);
  if (j.state === "running") { if (!upd.poll) pollUpdate(); return; }
  const c = await checkUpdates(j.state === "done");
  if (j.state !== "done") $("u-summary").textContent = updateSummary(c);
  $("u-retrain").disabled = !c.can_retrain;
  if (!c.can_retrain) $("u-retrain").checked = false;
  $("u-retrain-note").textContent = c.can_retrain
    ? "New sets are recognised without retraining. Retraining (about an hour, uses the GPU) can help after several new sets; your current model is backed up first."
    : `Retraining ${c.retrain_note}. New sets are still recognised without it.`;
}
$("btn-update").onclick = openUpdate;
$("btn-key-update").onclick = openUpdate;
$("u-close").onclick = () => $("update").close();
$("u-start").onclick = async () => {
  const j = await api("/api/update/start", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retrain: $("u-retrain").checked, full: $("u-full").checked }),
  });
  showUpdateJob(j);
  pollUpdate();
};
$("u-cancel").onclick = async () => { $("u-cancel").disabled = true; await api("/api/update/cancel", { method: "POST" }); $("u-cancel").disabled = false; };
// look for new sets a few seconds after start (one cheap request, silent when offline)
setTimeout(() => checkUpdates().catch(() => {}), 4000);

// auto-scan speed: camera checks per second, also the cap on auto identifications
function scanRate() {
  const r = Number(state.status?.settings?.scan_rate);
  return Number.isFinite(r) && r > 0 ? Math.min(10, Math.max(1, Math.round(r))) : 5;
}
function showRate() { $("s-rate-out").textContent = `${$("s-rate").value} scan${$("s-rate").value === "1" ? "" : "s"}/s`; }
$("s-rate").addEventListener("input", showRate);
// same-card memory: seconds within which the card just scanned can come back as the same copy (0 = off)
function sameCardMemory() {
  const v = Number(state.status?.settings?.same_card_memory);
  return Number.isFinite(v) && v >= 0 ? Math.min(60, Math.round(v)) : 10;
}
function showMemory() { $("s-memory-out").textContent = $("s-memory").value === "0" ? "Off" : `${$("s-memory").value} sec`; }
$("s-memory").addEventListener("input", showMemory);
// confirm scans: reads in a row that must agree before a card is logged
function confirmScans() {
  const v = Number(state.status?.settings?.confirm_scans);
  return Number.isFinite(v) && v >= 1 ? Math.min(10, Math.round(v)) : 2;
}
function showConfirm() { $("s-confirm-out").textContent = $("s-confirm").value === "1" ? "first read" : `${$("s-confirm").value} in a row`; }
$("s-confirm").addEventListener("input", showConfirm);
// minimum confidence (percent) a read needs to be logged; below it the user picks the card
function minConfidence() {
  const v = Number(state.status?.settings?.min_confidence);
  return Number.isFinite(v) && v >= 0 ? Math.min(100, Math.round(v)) : 50;
}
function showMinConf() { $("s-minconf-out").textContent = `${$("s-minconf").value}%`; }
$("s-minconf").addEventListener("input", showMinConf);

// ---------------------------------------------------------------- camera
async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const sel = $("camera-select"), cur = sel.value;
  // screen sharing has its own CAMERA | SCREEN switch, so the list is cameras only
  sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || "Camera " + (i + 1))}</option>`).join("");
  if (cur) sel.value = cur;
}
async function startCamera(deviceId) {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }), width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    $("hud").textContent = "Camera error: " + e.message;
    return;
  }
  await attachStream("camera");
  await listCameras();
  const id = state.stream.getVideoTracks()[0].getSettings().deviceId;
  if (id) $("camera-select").value = id;
  try { localStorage.setItem("alakadex.camera", id || ""); } catch {}
}

// Share a screen, window or browser tab (YouTube pack openings, Twitch, tournament
// streams...) and hover the cards in it with the Sensor.
async function startShare() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch (e) {
    $("hud").textContent = "Screen share cancelled";
    return;
  }
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = stream;
  stream.getVideoTracks()[0].addEventListener("ended", () => {
    if (state.stream !== stream) return;
    stopSource();
    $("hud").textContent = "Screen share stopped";
  });
  await attachStream("screen");
  setSensor(true);   // shared videos are for hovering (LOOK UP); auto-scan stays off
}
// the ON/OFF button: stop the camera or screen share (the window keeps everything else)
function stopSource() {
  if (!state.stream) return;
  dex.prefSrc = state.sourceKind || "camera";
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null; video.srcObject = null;
  setPinned(false); setFrozen(false); hidePop(true, true);
  state.quad = null; state.quads = []; state.history = [];
  $("video-empty").classList.remove("hidden");
  $("sensor-bar").classList.add("hidden");
  updateHud();
}

async function attachStream(kind) {
  state.sourceKind = kind;
  dex.prefSrc = kind;
  video.srcObject = state.stream;
  $("video-empty").classList.add("hidden");
  $("sensor-bar").classList.remove("hidden");
  setFrozen(false);
  await video.play();
  state.box = null;   // re-fit to this source's aspect ratio so the box stays card-shaped
  ensureBox();
}
$("btn-start").onclick = () => startCamera(localStorageGet("alakadex.camera"));
$("btn-share").onclick = startShare;
$("btn-reshare").onclick = startShare;
$("camera-select").onchange = (e) => startCamera(e.target.value);
$("btn-power").onclick = () => (state.stream ? stopSource()
  : dex.prefSrc === "screen" ? startShare() : startCamera(localStorageGet("alakadex.camera")));
// CAMERA | SCREEN: what the scanner looks at
$("source").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-src]");
  if (!b) return;
  if (b.dataset.src === "screen") { startShare(); return; }
  if (state.stream && state.sourceKind === "camera") return;
  setSensor(false);   // back on the camera: log pulls again
  startCamera(localStorageGet("alakadex.camera"));
});
function localStorageGet(k) { try { return localStorage.getItem(k) || undefined; } catch { return undefined; } }

// geometry of the displayed (object-fit: contain) video inside the overlay
function videoRect() {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const s = Math.min(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  if (overlay.width !== overlay.clientWidth * dpr) { overlay.width = overlay.clientWidth * dpr; overlay.height = overlay.clientHeight * dpr; }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  if (!state.stream) return requestAnimationFrame(drawOverlay);
  const r = videoRect();
  const path = (quad) => {
    octx.beginPath();
    quad.forEach(([x, y], i) => { const px = r.x + x * r.w, py = r.y + y * r.h; i ? octx.lineTo(px, py) : octx.moveTo(px, py); });
    octx.closePath();
  };
  if (state.sensor) {
    if (state.tally) drawTally(path, r);
    else if (sensorOpts.outlines) {
      octx.lineWidth = 1.5; octx.strokeStyle = "rgba(255,255,255,.55)";
      for (const q of state.quads) { path(q); octx.stroke(); }
    }
    if (sensorOpts.highlight && state.hit && !$("sensor-pop").classList.contains("hidden")) {
      octx.lineWidth = 3; octx.strokeStyle = "#ffcb05"; octx.shadowColor = "#ffcb05"; octx.shadowBlur = 10;
      path(state.hit.quad); octx.stroke(); octx.shadowBlur = 0;
    }
    if (state.sensorBusy && state.pointer) {
      const px = r.x + state.pointer.x * r.w, py = r.y + state.pointer.y * r.h, a = performance.now() / 150;
      octx.lineWidth = 2.5; octx.strokeStyle = "#ffcb05";
      octx.beginPath(); octx.arc(px, py, 11, a, a + 4.2); octx.stroke();
    }
    return requestAnimationFrame(drawOverlay);
  }
  if (useBox() && ensureBox()) {
    const b = state.box, L = r.x + b.x * r.w, T = r.y + b.y * r.h, W = b.w * r.w, H = b.h * r.h;
    // dim everything outside the card area
    octx.fillStyle = "rgba(0,0,0,.55)";
    octx.beginPath(); octx.rect(r.x, r.y, r.w, r.h); octx.rect(L, T, W, H); octx.fill("evenodd");
    const locked = !!state.quad;
    const col = state.scanning ? "#d97757" : locked ? "#3ccf7a" : "#ffcb05";
    octx.strokeStyle = col;
    octx.lineWidth = 3; octx.setLineDash(state.quad ? [] : [10, 7]);
    octx.strokeRect(L, T, W, H); octx.setLineDash([]);
    octx.fillStyle = col;
    for (const [cx, cy] of [[L, T], [L + W, T], [L + W, T + H], [L, T + H]]) octx.fillRect(cx - 6, cy - 6, 12, 12);
    if (state.quad && $("show-outline").checked) { octx.lineWidth = 2; octx.strokeStyle = "rgba(255,255,255,.85)"; path(state.quad); octx.stroke(); }
    // label chip on the box so it is obvious where scanning happens
    const label = (state.scanning ? "SCANNING" : locked ? "CARD FOUND" : "SCAN AREA") + (b.free ? " · custom" : "");
    octx.font = "700 11px system-ui, sans-serif";
    const tw = octx.measureText(label).width + 14, ty = T - 22 >= r.y ? T - 22 : T + 4;
    octx.fillStyle = col; octx.beginPath(); octx.roundRect(L, ty, tw, 18, 4); octx.fill();
    octx.fillStyle = "#111"; octx.fillText(label, L + 7, ty + 13);
    octx.font = "12px system-ui, sans-serif"; octx.fillStyle = "rgba(255,255,255,.85)";
    octx.font = "11px system-ui, sans-serif"; octx.fillStyle = "rgba(255,255,255,.9)";
    const hint = "drag outside to draw your own area";
    if (L + tw + 8 + octx.measureText(hint).width < r.x + r.w) octx.fillText(hint, L + tw + 8, ty + 13);
  } else if (state.quad && $("show-outline").checked) {
    const stable = isStable();
    octx.strokeStyle = state.scanning ? "#d97757" : stable ? "#3ccf7a" : "#ffcb05";
    octx.lineWidth = 3;
    octx.beginPath();
    state.quad.forEach(([x, y], i) => { const px = r.x + x * r.w, py = r.y + y * r.h; i ? octx.lineTo(px, py) : octx.moveTo(px, py); });
    octx.closePath(); octx.stroke();
  }
  requestAnimationFrame(drawOverlay);
}

// Scan frame: outline each identified card and label it with its price
function drawTally(path, r) {
  for (const c of state.tally.cards) {
    const hit = c.hit, unsure = c.low_confidence;
    octx.lineWidth = hit ? 2.5 : 1.5;
    octx.strokeStyle = hit ? "#ffcb05" : unsure ? "rgba(245,165,36,.9)" : "rgba(255,255,255,.7)";
    path(c.quad); octx.stroke();
    // price chip centred on the card's top edge (whichever way up the card is)
    const pts = c.quad.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]);
    const top = pts.slice().sort((a, b) => a[1] - b[1]).slice(0, 2);
    const cx = (top[0][0] + top[1][0]) / 2, cy = (top[0][1] + top[1][1]) / 2;
    const label = (hit ? "★ " : "") + (c.price == null ? "?" : money(c.price)) + (unsure ? " ?" : "");
    octx.font = "600 12px system-ui, sans-serif";
    const tw = octx.measureText(label).width + 12, th = 18;
    const lx = Math.max(r.x + 2, Math.min(r.x + r.w - tw - 2, cx - tw / 2)), ly = Math.max(r.y + 2, cy - th - 3);
    octx.fillStyle = hit ? "#ffcb05" : "rgba(0,0,0,.75)";
    octx.beginPath(); octx.roundRect(lx, ly, tw, th, 9); octx.fill();
    octx.fillStyle = hit ? "#1a1400" : unsure ? "#f5a524" : "#fff";
    octx.fillText(label, lx + 6, ly + 13);
  }
}

// ---------------------------------------------------------------- card area (guide box)
// Only the pixels inside this adjustable box are sent for identification.
// Stored normalised to the video frame: {x, y, w, h}.
const CARD_AREA_KEY = "alakadex.cardArea";
const PAD = 0.06;   // margin sent around the box so card edges have background to be seen against

// The card area is always a card-sized rectangle (63:88): scans read the whole card
// inside it, or the box itself as the card. Box width per unit of height, in the
// frame's normalised coordinates:
const cardAspect = () => (63 / 88) * ((video.videoHeight || 9) / (video.videoWidth || 16));
function defaultBox() {
  const h = Math.min(0.8, 0.86 / cardAspect()), w = h * cardAspect();
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}
function loadBox() {
  try {
    const b = JSON.parse(localStorage.getItem(CARD_AREA_KEY));
    if (b && b.w > 0.05 && b.h > 0.05) {
      if (b.free) return { x: Math.max(0, Math.min(1 - b.w, b.x)), y: Math.max(0, Math.min(1 - b.h, b.y)), w: b.w, h: b.h, free: true };
      // boxes saved before the area was locked to card shape: same centre and height
      const h = Math.min(b.h, 1, 1 / cardAspect()), w = h * cardAspect();
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return { x: Math.max(0, Math.min(1 - w, cx - w / 2)), y: Math.max(0, Math.min(1 - h, cy - h / 2)), w, h };
    }
  } catch {}
  return null;
}
function saveBox() { try { localStorage.setItem(CARD_AREA_KEY, JSON.stringify(state.box)); } catch {} }
function useBox() { return $("guide-mode").checked && !state.sensor; }
function ensureBox() { if (!state.box && video.videoWidth) state.box = loadBox() || defaultBox(); return state.box; }

// Crop the card area (+ margin) out of the current video frame.
// Returns {canvas, box: [x0,y0,x1,y1] of the card area inside the crop (0-1), src: video-pixel rect}.
function cropBox(maxSide) {
  const vw = video.videoWidth, vh = video.videoHeight, b = state.box;
  const px = b.w * PAD, py = b.h * PAD;
  const x0 = Math.max(0, b.x - px), y0 = Math.max(0, b.y - py);
  const x1 = Math.min(1, b.x + b.w + px), y1 = Math.min(1, b.y + b.h + py);
  const src = { sx: x0 * vw, sy: y0 * vh, sw: (x1 - x0) * vw, sh: (y1 - y0) * vh };
  const s = Math.min(1, maxSide / Math.max(src.sw, src.sh));
  const c = document.createElement("canvas");
  c.width = Math.round(src.sw * s); c.height = Math.round(src.sh * s);
  c.getContext("2d").drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, c.width, c.height);
  const box = [(b.x - x0) / (x1 - x0), (b.y - y0) / (y1 - y0), (b.x + b.w - x0) / (x1 - x0), (b.y + b.h - y0) / (y1 - y0)];
  return { canvas: c, box, src };
}
// crop-normalised quad -> video-normalised quad
function cropToVideo(quad, src) {
  return quad.map(([x, y]) => [(src.sx + x * src.sw) / video.videoWidth, (src.sy + y * src.sh) / video.videoHeight]);
}

// drag to move, drag a corner to resize
let boxDrag = null;
function boxHandleAt(e) {
  const r = videoRect(), b = overlay.getBoundingClientRect(), bx = state.box;
  const mx = e.clientX - b.left, my = e.clientY - b.top;
  const L = r.x + bx.x * r.w, T = r.y + bx.y * r.h, R = L + bx.w * r.w, B = T + bx.h * r.h;
  const near = (x, y) => Math.hypot(mx - x, my - y) < 16;
  if (near(L, T)) return "nw"; if (near(R, T)) return "ne"; if (near(R, B)) return "se"; if (near(L, B)) return "sw";
  if (mx > L && mx < R && my > T && my < B) return "move";
  return null;
}
overlay.addEventListener("pointerdown", (e) => {
  if (!useBox() || !state.stream) return;
  const h = boxHandleAt(e) || "draw";
  const r = videoRect();
  boxDrag = { h, x: e.clientX, y: e.clientY, start: { ...state.box }, r };
  if (h === "draw") {
    const bb = overlay.getBoundingClientRect();
    boxDrag.sx = Math.max(0, Math.min(1, (e.clientX - bb.left - r.x) / r.w));
    boxDrag.sy = Math.max(0, Math.min(1, (e.clientY - bb.top - r.y) / r.h));
  }
  overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});
overlay.addEventListener("pointermove", (e) => {
  if (!useBox() || !state.stream) return;
  if (!boxDrag) {
    const h = boxHandleAt(e);
    overlay.style.cursor = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", move: "move" }[h] || "crosshair";
    return;
  }
  if (boxDrag.h === "draw") {
    const bb = overlay.getBoundingClientRect(), r = boxDrag.r;
    const cx = Math.max(0, Math.min(1, (e.clientX - bb.left - r.x) / r.w)), cy = Math.max(0, Math.min(1, (e.clientY - bb.top - r.y) / r.h));
    state.box = { x: Math.min(boxDrag.sx, cx), y: Math.min(boxDrag.sy, cy), w: Math.abs(cx - boxDrag.sx), h: Math.abs(cy - boxDrag.sy), free: true };
    state.quad = null; state.history = [];
    return;
  }
  const dx = (e.clientX - boxDrag.x) / boxDrag.r.w, dy = (e.clientY - boxDrag.y) / boxDrag.r.h, s = boxDrag.start;
  let { x, y, w, h } = s;
  const hd = boxDrag.h, MIN = 0.08;
  if (hd === "move") { x = s.x + dx; y = s.y + dy; }
  else if (s.free) {
    // custom area: corners resize freely
    const west = hd.includes("w"), north = hd.includes("n");
    const ax = west ? s.x + s.w : s.x, ay = north ? s.y + s.h : s.y;
    const px = Math.max(0, Math.min(1, (west ? s.x : s.x + s.w) + dx)), py = Math.max(0, Math.min(1, (north ? s.y : s.y + s.h) + dy));
    w = Math.max(0.05, Math.abs(px - ax)); h = Math.max(0.05, Math.abs(py - ay));
    x = west ? ax - w : ax; y = north ? ay - h : ay;
  } else {
    // resize from a corner, keeping the box card-shaped; the opposite corner stays put
    const ar = cardAspect(), west = hd.includes("w"), north = hd.includes("n");
    const ax = west ? s.x + s.w : s.x, ay = north ? s.y + s.h : s.y;
    const px = (west ? s.x : s.x + s.w) + dx, py = (north ? s.y : s.y + s.h) + dy;
    const maxH = Math.min(north ? ay : 1 - ay, (west ? ax : 1 - ax) / ar);
    h = Math.min(maxH, Math.max(MIN, Math.abs(py - ay), Math.abs(px - ax) / ar));
    w = h * ar;
    x = west ? ax - w : ax; y = north ? ay - h : ay;
  }
  x = Math.max(0, Math.min(1 - w, x)); y = Math.max(0, Math.min(1 - h, y));
  state.box = { x, y, w, h, ...(s.free ? { free: true } : {}) };
  state.quad = null; state.history = [];
});
overlay.addEventListener("pointerup", () => {
  if (!boxDrag) return;
  // a drawn area too small to be deliberate (a stray click) is thrown away
  if (boxDrag.h === "draw" && (state.box.w < 0.05 || state.box.h < 0.05)) state.box = boxDrag.start;
  boxDrag = null; saveBox();
});

function isStable() {
  const now = performance.now();
  // held still: 2+ outlines over at least 350 ms that barely moved
  const recent = state.history.filter((h) => now - h.t < 1200);
  if (recent.length < 2 || recent.at(-1).t - recent[0].t < 350) return false;
  let maxMove = 0;
  for (const h of recent) for (let i = 0; i < 4; i++) {
    maxMove = Math.max(maxMove, Math.hypot(h.quad[i][0] - state.quad[i][0], h.quad[i][1] - state.quad[i][1]));
  }
  return maxMove < 0.012;
}

// ---------------------------------------------------------------- live detection loop
async function detectLoop() {
  // auto-scan runs at the chosen speed; Sensor and manual scanning keep the quick 140 ms outline refresh
  setTimeout(detectLoop, !state.sensor && $("auto-scan").checked ? (useBox() ? 50 : 1000 / scanRate()) : 140);
  if (!state.stream || state.detecting || video.readyState < 2 || boxDrag) return;
  if (state.paused && !state.sensor) return;   // paused: no outline, nothing scanned
  state.detecting = true;
  try {
    if (useBox() && ensureBox()) {
      // card-area mode: only the box (+ margin) is checked, at low resolution - fast
      const { canvas, box, src } = cropBox(360);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
      const d = await api("/api/detect?box=" + box.map((v) => v.toFixed(4)).join(",") + (state.box.free ? "&free=1" : ""),
        { method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" } });
      const now = performance.now();
      state.quads = [];
      state.sig = d.sig;
      if (d.quad) {
        state.quad = cropToVideo(d.quad, src);
        state.history.push({ t: now, quad: state.quad });
        state.history = state.history.filter((x) => now - x.t < 1500);
      } else {
        state.quad = null; state.history = [];
      }
      updateHud();
      maybeAutoScan();
      state.detecting = false;
      return;
    }
    if (state.frozen && state.frozenScanned) { state.detecting = false; return; }   // a still frame needs one pass
    const gen = freezeGen;
    const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth);
    grab.width = w; grab.height = h;
    gctx.drawImage(frameSource(), 0, 0, w, h);
    const blob = await new Promise((res) => grab.toBlob(res, "image/jpeg", 0.75));
    const d = await api("/api/detect", { method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" } });
    if (gen !== freezeGen) { state.detecting = false; return; }   // froze / unfroze mid-request
    if (state.frozen) state.frozenScanned = true;
    const now = performance.now();
    state.quads = d.quads || [];
    if (d.quad) {
      state.quad = d.quad; state.sig = d.sig;
      state.history.push({ t: now, quad: d.quad });
      state.history = state.history.filter((x) => now - x.t < 1500);
    } else {
      state.quad = null; state.history = [];
    }
    updateHud();
    maybeAutoScan();
  } catch (e) { /* server restarting etc. */ }
  state.detecting = false;
}

// The card has left only after it's been out of view this long; a shorter gap is the
// outline flickering (a frame or two without a detection) while the card stays put.
const AWAY_MS = 600;
let gapStart = null;                           // first frame of the current gap (null: card in view)
let awayFrom = -Infinity, awayTo = -Infinity;  // the last time the card really left: first / last frame away
function updateHud() {
  const now = performance.now();
  if (state.quad) gapStart = null;
  else {
    if (gapStart == null) gapStart = now;
    if (now - gapStart >= AWAY_MS) {
      awayFrom = gapStart; awayTo = now;
      state.sameCard = false; state.runFailed = false;
    }
  }
  const hud = $("hud");
  if (!state.stream) hud.textContent = "No camera";
  else if (state.sensor) hud.textContent = state.sensorBusy ? "Sensor: identifying…" :
    state.tally ? `Frame scanned — ${state.tally.cards.length} card${state.tally.cards.length === 1 ? "" : "s"} · hover for details · Esc to resume` :
    `Sensor${state.frozen ? " (frozen)" : ""} — hover a card${state.quads.length ? ` (${state.quads.length} in view)` : ""}` +
    ` · F ${state.frozen ? "resume" : "freeze"} · K scan frame`;
  else if (state.paused) hud.textContent = "Paused — nothing is scanned or logged (P or Resume to continue)";
  else if (state.pending) hud.textContent = "Low confidence — pick the card on the right, then LOG IT (or SKIP)";
  else if (state.progress) hud.textContent = `Confirming ${state.progress} — hold still`;
  else if (state.scanning) hud.textContent = "Scanning…";
  else if (state.runFailed) hud.textContent = "Reads didn't agree — hold the card still (Space tries again)";
  else if (state.sameCard) hud.textContent = "Same card — already counted (+1 COPY or Space counts another copy)";
  else if (useBox()) hud.textContent = !state.quad ? (state.box?.free ? "Put a card inside your scan area" : "Place a card in the scan area (Space scans the box as-is)")
    : "Card found";
  else if (!state.quad) hud.textContent = "Looking for a card…";
  else if (!isStable()) hud.textContent = "Card found — hold still";
  else hud.textContent = "Card locked";
  updateDex();
}

// the card has stopped moving: its last two outlines are nearly the same (~100 ms in the card area)
function isSettled() {
  const h = state.history;
  if (h.length < 2) return false;
  let mv = 0;
  for (let i = 0; i < 4; i++) mv = Math.max(mv, Math.hypot(h.at(-1).quad[i][0] - h.at(-2).quad[i][0], h.at(-1).quad[i][1] - h.at(-2).quad[i][1]));
  return mv < 0.02;
}
// A different card slid in: its fingerprint must differ from the last read's for this many
// checks in a row. On the same card held still one check in ~15 differs anyway (glare,
// tremor), which used to start a new scan and log the card again.
const DIFF_CHECKS = 3;
function maybeAutoScan() {
  state.diffRun = state.quad && hamming(state.sig, state.lastScanSig) > 14 ? (state.diffRun || 0) + 1 : 0;
  if (state.sensor || !$("auto-scan").checked || state.scanning || state.confirming || state.pending || !state.quad) return;
  if (state.lastScanAt != null && performance.now() - state.lastScanAt < 1000 / scanRate()) return;
  // new card if the card left the view since the last scan, or a different card slid in
  const different = state.diffRun >= DIFF_CHECKS;
  const leftView = state.lastScanAt == null || awayTo > state.lastSeenAt;
  // same-card memory: the card just scanned came back within the set time - same copy, not counted again
  const memory = sameCardMemory() * 1000;
  if (leftView && !different && memory > 0 && awayTo - awayFrom <= memory && isSettled()) {
    state.lastSeenAt = performance.now();
    state.sameCard = true;
    updateHud();
    return;
  }
  if ((different || leftView) && isSettled()) { state.retries = 0; scan(); }
  // same card, its reads didn't agree: look again once it is held still
  else if (state.unsure && state.retries < 3 && isStable()) { state.retries++; scan(); }
}

// ---------------------------------------------------------------- scanning
// One scan = a confirm run: read the card until `confirm_scans` reads in a row agree, then log
// it. A read below `min_confidence` stops the run and asks the user to pick the card from its
// look-alikes; nothing more is scanned until they do.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the card just logged is the same copy unless it really left the view - for longer than the
// same-card memory, when that's on. `manual` (Space / Scan button) always counts a new copy.
function sameAsLastLog(key, manual) {
  const last = state.lastLog;
  if (manual || !last || last.key !== key) return false;
  const memory = sameCardMemory() * 1000;
  return !(awayTo > last.at && (memory === 0 || awayTo - awayFrom > memory));
}
function logPull(res) {
  dexClick();
  const pull = addPull(res.match, res.method, res.confidence);
  state.lastLog = { key: res.match.key, at: performance.now(), pull };
  flashLens("logged", 1400);
  alertFor(pull, pull.price, pull.rarity);   // catalog price for now; checked again with the live one
  return pull;
}
async function scan(manual = false) {
  if (!state.stream || state.scanning || state.confirming || video.readyState < 2) return;
  if (state.pending || state.paused) { updateHud(); return; }
  const need = confirmScans(), min = minConfidence() / 100;
  const withCard = !!state.quad;   // started on a detected card (not "scan the box as-is")
  state.confirming = true; state.runFailed = false; state.sameCard = false;
  let streak = null, outcome = "failed";
  // the language a read of this card was sure of: later reads of the run reuse it. An
  // unsure read isn't reused (a glare frame would pin a Korean holo to English); a
  // language one read nearly settled (lang_near) is settled by a second such read
  let langHint = null, langNear = null;
  try {
    for (let attempt = 0; attempt < need + 3; attempt++) {
      if (attempt) {
        await sleep(Math.max(120, 1000 / scanRate()));   // a fresh frame for every read
        if (state.paused) { outcome = "paused"; break; }
        if (withCard && !state.quad) { outcome = "gone"; break; }
      }
      const res = await readCard(langHint, langNear);
      if (!res) break;
      if (!res.ok) { streak = null; continue; }
      if (res.lang_source === "model") {
        if (res.lang_sure) langHint = res.lang;
        else if (res.lang_near) langNear = res.lang_near;
      }
      if ((res.confidence ?? 0) < min) { askToConfirm(res); outcome = "pending"; break; }
      streak = streak?.key === res.match.key ? { key: streak.key, n: streak.n + 1 } : { key: res.match.key, n: 1 };
      if (streak.n >= need) {
        if (sameAsLastLog(streak.key, manual)) {
          showResult(res, state.lastLog.pull);
          $("r-method").textContent = "Same card — already counted";
          state.sameCard = true;
          outcome = "same";
        } else {
          showResult(res, logPull(res));
          outcome = "logged";
        }
        break;
      }
      state.progress = `${streak.n}/${need}`;
      showResult(res, null);
      updateHud();
    }
  } finally {
    state.confirming = false; state.progress = null;
  }
  state.unsure = outcome === "failed";
  state.runFailed = outcome === "failed";
  if (outcome === "failed" || outcome === "gone") $("r-method").textContent = "Not logged";
  if (outcome === "paused") $("r-method").textContent = "Paused — not logged";
  updateHud();
}

async function readCard(lang = null, langNear = null) {
  if (!state.stream || video.readyState < 2) return null;
  state.scanning = true;
  state.lastScanAt = state.lastSeenAt = performance.now();
  state.lastScanSig = state.sig;
  state.sameCard = false;
  flash();
  // the frame goes up as a binary JPEG (encoded off the main thread by toBlob) with the
  // options in the query string: no base64 (+33% size) and no JSON-wrapped image
  let src, opts;
  if (useBox() && ensureBox()) {
    // only the card area (+ small margin) is sent - nothing outside the box is used
    const { canvas, box } = cropBox(1600);
    src = canvas; opts = { box, free: !!state.box.free };
  } else {
    grab.width = video.videoWidth; grab.height = video.videoHeight;
    gctx.drawImage(video, 0, 0);
    src = grab; opts = { quad: state.quad };
  }
  if (lang) opts.lang = lang;
  else if (langNear) opts.lang_near = langNear;
  const blob = await new Promise((r) => src.toBlob(r, "image/jpeg", 0.92));
  const res = await api("/api/identify?opts=" + encodeURIComponent(JSON.stringify(opts)), {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob,
  });
  state.scanning = false;
  // lastScanSig stays the preview's fingerprint from when this read started: the scan's own
  // (res.sig, from a bigger image) differs from the preview's 5% of the time on the same card
  if (res.crop) $("crop").src = res.crop;
  if (!res.ok) showError(res.error || "Scan failed");
  return res;
}

// low-confidence read: show the best guess and its look-alikes; scanning waits for a pick
function askToConfirm(res) {
  state.pending = res;
  showResult(res, null);
  const m = res.match;
  const opts = [m, ...(res.candidates || []).filter((c) => c.key !== m.key)].slice(0, 6);
  $("confirm-title").textContent = "WHICH CARD IS THIS?";
  $("confirm-pct").textContent = `${Math.round((res.confidence ?? 0) * 100)}%`;
  $("confirm-cands").innerHTML = opts.map(candHtml).join("");
  selectPending(0);
  $("confirm-box").classList.remove("hidden");
  $("r-notice").classList.add("hidden");
  $("r-method").textContent = "Waiting for you to confirm";
  updateHud();
}
async function confirmPick(key) {
  const res = state.pending;
  const m = res.match.key === key ? res.match : await api("/api/card?key=" + encodeURIComponent(key));
  if (m.error || state.pending !== res) return;
  endPending();
  showResult({ ...res, match: m }, logPull({ match: m, method: "confirmed", confidence: res.confidence }));
  $("r-method").textContent = "Confirmed by you";
}
function endPending() {
  state.pending = null;
  $("confirm-box").classList.add("hidden");
  // the card in view is dealt with: it isn't scanned again until it leaves or changes
  state.lastSeenAt = performance.now();
  state.unsure = false;
  updateHud();
}
$("confirm-none").onclick = () => { if (!state.pending) return; endPending(); $("r-method").textContent = "Skipped — not logged"; };

function flash() { const f = $("scan-flash"); f.classList.add("on"); setTimeout(() => f.classList.remove("on"), 60); }

function showError(msg) {
  $("hud").textContent = msg;
}

// ---------------------------------------------------------------- result panel
// pull is null while a read isn't logged (confirming, or waiting for the user to pick)
function showResult(res, pull) {
  state.current = { pull, res };
  if (!state.pending) $("confirm-box").classList.add("hidden");
  const m = res.match;
  // the same card's details are already showing while a confirm run reads it again
  const fresh = state.detailsFor !== m.key || !!pull;
  $("result-empty").classList.add("hidden");
  $("result-body").classList.remove("hidden");
  $("r-img").src = m.img || "";
  $("r-name").textContent = m.name || m.key;
  const foreign = m.lang && m.lang !== "en";
  $("r-lang").textContent = foreign ? m.lang_label || m.lang : "";
  $("r-lang").classList.toggle("hidden", !foreign);
  $("r-lang").title = foreign && res.lang_conf != null && res.lang === m.lang
    ? `Read as ${m.lang_label} (${Math.round(res.lang_conf * 100)}% sure)` : "";
  $("r-local").textContent = foreign && m.name_local && m.name_local !== m.name ? m.name_local : "";
  $("r-local").classList.toggle("hidden", !$("r-local").textContent);
  $("r-set").textContent = `${m.set_name || m.set} (${m.set})`;
  $("r-date").textContent = m.set_date ? "Released " + fmtDay(m.set_date) : "";
  showSetProgress(m, pull);
  if (fresh) renderStrip(pull, pull?.price, pull?.rarity ?? m.rarity);
  $("r-set-icon").src = m.set_icon || "";
  $("r-number").textContent = "#" + m.number;
  $("r-era").textContent = m.era || "—";
  if (fresh) { $("r-reg").textContent = "…"; setRarity(m.rarity || "…"); }
  const meth = $("r-method");
  meth.textContent = (pull ? "Logged" : state.progress ? `Confirming ${state.progress}` : "Identified locally")
    + (res.ms != null ? ` · ${res.ms} ms` : "");
  meth.className = "r-method";
  const conf = res.confidence == null ? null : Math.max(0, Math.min(1, res.confidence));
  $("r-conf-fill").style.width = conf == null ? "0" : (conf * 100).toFixed(0) + "%";
  $("r-conf-fill").style.background = conf == null ? "" : conf >= minConfidence() / 100 ? "var(--good)" : conf > 0.1 ? "var(--warn)" : "var(--bad)";
  $("r-conf-text").textContent = conf == null ? "" : `confidence ${(conf * 100).toFixed(0)}%`;
  const n = $("r-notice");
  n.className = "notice hidden";
  if (res.low_confidence) { n.className = "notice"; n.textContent = "Low confidence — check the candidates below the camera."; }
  else if (res.lang_missing) { n.className = "notice"; n.textContent = `Looks like a ${res.lang_label || "non-English"} card that isn't in the catalog — showing the same artwork's card instead.`; }
  else if (res.print_ambiguous) { n.className = "notice"; n.textContent = "Same artwork exists in other sets — check the set symbol and number."; }
  if (fresh) loadPrintings(m.key);
  if (res.upside_down) $("hud").textContent = "Card was upside down — that's fine";
  // candidates tray under the camera
  const cands = (res.candidates || []).filter((c) => c.key !== m.key).slice(0, 7);
  $("cands").innerHTML = cands.map(candHtml).join("");
  if (fresh) loadDetails(m.key, pull?.id ?? null);
  updateDex();
}
// one card in a candidate strip (tray, low-confidence pick, Wrong card window): Enter or a click picks it
const candHtml = (c) => `<div class="cand" tabindex="0" role="button" data-key="${esc(c.key)}" title="${esc(c.name)} — ${esc(c.set_name)} #${esc(c.number)}">
      <img src="${esc(c.img)}" loading="lazy" alt=""><span>${esc(c.name)}</span><span>${esc(c.set)} ${esc(c.number)}</span></div>`;

// the same artwork in other languages: one click switches the read to that printing
async function loadPrintings(key) {
  const box = $("r-langs");
  box.classList.add("hidden");
  const list = await api("/api/printings?key=" + encodeURIComponent(key)).catch(() => []);
  if (!state.current || state.current.res.match.key !== key || !Array.isArray(list)) return;
  const langs = new Set(list.map((c) => c.lang));
  if (langs.size < 2) return;
  // one button per language: the card shown, else that language's main printing
  const cur = list.find((c) => c.key === key)?.lang, seen = new Set([cur]);
  box.innerHTML = "Other languages: " + list.filter((c) => c.key === key || !seen.has(c.lang) && seen.add(c.lang))
    .map((c) => `<button type="button" data-key="${esc(c.key)}" class="${c.key === key ? "on" : ""}"
      title="${esc(c.name_local || c.name)} — ${esc(c.set_name || c.set)} #${esc(c.number)}">${esc(c.lang_label)}</button>`).join("");
  box.classList.remove("hidden");
}
$("r-langs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-key]");
  if (!b || b.classList.contains("on")) return;
  if (state.pending) confirmPick(b.dataset.key);
  else if (state.current?.pull) correctTo(b.dataset.key);
  else switchShown(b.dataset.key);
});
async function switchShown(key) {   // nothing logged (e.g. a Sensor read): just show the other printing
  const m = await api("/api/card?key=" + encodeURIComponent(key));
  if (m.error || !state.current) return;
  showResult({ ...state.current.res, match: m }, null);
}

function setRarity(r) {
  const el = $("r-rarity");
  el.textContent = r; el.className = "rarity " + rarityTier(r);
}

async function loadDetails(key, pullId) {
  state.detailsFor = key;
  $("r-price").textContent = "…"; $("r-printings").textContent = ""; $("r-tourney").textContent = "Loading…"; $("r-legal").innerHTML = "";
  const d = await api("/api/details?key=" + encodeURIComponent(key));
  if (!state.current || state.current.res.match.key !== key) return;
  if (pullId == null) pullId = state.current.pull?.id ?? null;   // logged while the details were loading
  setRarity(d.rarity);
  const lim = d.limitless || {}, tp = d.tcgplayer || {};
  $("r-reg").textContent = lim.regulation_mark || "—";
  $("r-price").textContent = money(d.market_price);
  if (d.lang) {
    // Japanese / Korean / Chinese: say whose price this is (own printing, or the English card's)
    const src = d.price_source || "", own = src.startsWith("TCGplayer");
    const langName = state.current.res.match.lang_label || "this language";
    $("r-price-label").textContent = own ? `TCGplayer market price · ${src.replace(/^TCGplayer /, "")}`
      : d.market_price == null ? "No price found"
      : src.startsWith("Japanese card") ? `Price of the Japanese card (no ${langName} or English price)`
      : `Price of the English card (no ${langName} price)`;
    $("r-printings").innerHTML = own ? (tp.printings || []).map((p) => `${esc(p.printing)}: <b>${money(p.market)}</b>`).join(" · ")
      + (tp.fetched ? ` · live ${esc(tp.fetched)}` : "")
      : d.english ? `English card: ${esc(d.english.name || "")} · ${esc(d.english.key)}` : "";
  } else {
    $("r-price-label").textContent = "TCGplayer market price";
    $("r-printings").innerHTML = (tp.printings || []).map((p) => `${esc(p.printing)}: <b>${money(p.market)}</b>`).join(" · ")
      + (tp.fetched ? ` <span title="${esc(d.price_source)}">· live ${esc(tp.fetched)}</span>` : (d.market_price != null ? " · " + esc(d.price_source) : ""));
  }
  const a = $("r-tcgp");
  a.href = tp.url || (lim.tcgplayer_id ? `https://www.tcgplayer.com/product/${lim.tcgplayer_id}` : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(state.current.res.match.name)}`);
  const t = lim.tournaments;
  if (!t) $("r-tourney").textContent = (d.errors || []).join("; ") || "No data";
  else {
    const used = t.count > 0;
    let html = `<div class="big">${used ? `Yes — in ${t.count.toLocaleString()} tournament decklist${t.count === 1 ? "" : "s"}` : "Not in any tournament decklist in Limitless's main database"}</div>`;
    if (t.city_league) html += `<div>${t.city_league.toLocaleString()} Japanese City League decklists · <a class="link" target="_blank" rel="noopener" href="${esc(t.city_league_url)}">view</a></div>`;
    if (t.recent.length) html += "<ul>" + t.recent.slice(0, 5).map((r) =>
      `<li><a target="_blank" rel="noopener" href="${esc(r.deck_url)}">${esc(r.deck)}</a><span class="muted">${esc(r.place)} · <a target="_blank" rel="noopener" href="${esc(r.tournament_url)}">${esc(r.tournament)}</a></span></li>`).join("") + "</ul>";
    html += `<a class="link" target="_blank" rel="noopener" href="${esc(t.decklists_url || lim.url)}">Open on Limitless ↗</a>`;
    $("r-tourney").innerHTML = html;
    $("r-tourney").classList.remove("muted");
  }
  $("r-legal").innerHTML = Object.entries(lim.legality || {}).map(([f, ok]) => `<span class="${ok ? "yes" : ""}">${esc(f)}: ${ok ? "legal" : "not legal"}</span>`).join("");
  updatePull(pullId, null, null, null, { price: d.market_price, rarity: d.rarity, decklists: t ? t.count : null });
  const pull = state.pulls.find((x) => x.id === pullId);
  renderStrip(pull, d.market_price, d.rarity);
  alertFor(pull, d.market_price, d.rarity);
}

// manual correction: click a candidate or search result
async function correctTo(key) {
  if (!state.current?.pull) return;   // nothing logged yet to correct
  const m = await api("/api/card?key=" + encodeURIComponent(key));
  if (m.error) return;
  updatePull(state.current.pull.id, m, "manual", 1);
  showResult({ ok: true, match: m, method: "manual", confidence: null, candidates: state.current.res.candidates, crop: state.current.res.crop }, state.current.pull);
  $("r-method").textContent = "Corrected manually";
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".cand");
  if (!c || c.closest("#wrong")) return;   // the Wrong card window handles its own
  // a low-confidence read: a click picks the card, LOG IT (or a double click) logs it
  if (c.closest("#confirm-cands")) { selectPending([...c.parentNode.children].indexOf(c)); return; }
  if (state.pending) confirmPick(c.dataset.key);
  else correctTo(c.dataset.key);
});
$("confirm-cands").addEventListener("dblclick", (e) => {
  const c = e.target.closest(".cand");
  if (c && state.pending) confirmPick(c.dataset.key);
});
let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = e.target.value.trim();
    const hits = q ? await api("/api/search?q=" + encodeURIComponent(q)) : [];
    if ($("search").value.trim() !== q) return;   // typed on meanwhile
    $("search-results").innerHTML = (Array.isArray(hits) ? hits : []).map(candHtml).join("")
      || (q ? `<span class="w-meta">No cards found for "${esc(q)}".</span>` : "");
  }, 250);
});

// ---------------------------------------------------------------- pulls log
// Every launch starts a new session with its own log. The server keeps each session in
// data/sessions/ (the whole log is saved after every change); History lists earlier ones.
const pad2 = (n) => String(n).padStart(2, "0");
function newSessionId(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
    + "-" + Math.random().toString(36).slice(2, 6);
}
// What the user paid (optional): one total for the session (cost_mode "total", cost) or a price
// per set (cost_mode "set", set_costs {code: price}); both are kept when switching. cost_label:
// what they bought. A new session starts in the mode used last.
const COST_MODE_KEY = "alakadex.costMode";
const session = { id: newSessionId(), started: new Date().toISOString(), cost: null, cost_label: "",
                  cost_mode: localStorageGet(COST_MODE_KEY) === "set" ? "set" : "total", set_costs: {} };
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtStamp = (iso) => (iso ? new Date(iso).toLocaleString() : "");
// a set's release day ("2026-09-16"): read as a local date, not UTC midnight
const fmtDay = (ymd) => { const [y, m, d] = String(ymd).split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); };
const toCost = (v) => (Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null);
// pulled value per set: {code: {name, n, v}}
function valueBySet(pulls) {
  const by = {};
  for (const p of pulls) {
    const code = p.set || String(p.key || "").split("/")[0];
    const s = by[code] || (by[code] = { name: p.set_name || code, n: 0, v: 0 });
    s.n++; s.v += Number(p.price) || 0;
  }
  return by;
}
// the same from a History summary's by_set {code: value}
const bySetFromSummary = (s) => Object.fromEntries(Object.entries(s.by_set || {}).map(([c, v]) => [c, { name: c, n: 0, v }]));
// Pulled value against what was paid, or null without a price. Per set, only the priced sets
// are compared (an unpriced one can't skew the result): {mode, cost, value (compared), total
// (all value), diff, pct, sets: [{code, p, v, pct}], unpriced: [codes]}.
function priceStats(s, by) {
  const total = Object.values(by).reduce((t, x) => t + x.v, 0);
  if (s.cost_mode === "set") {
    const costs = s.set_costs || {};
    const sets = Object.entries(costs).filter(([, p]) => p > 0)
      .map(([code, p]) => ({ code, p, v: by[code]?.v || 0 })).map((x) => ({ ...x, pct: ((x.v - x.p) / x.p) * 100 }));
    if (!sets.length) return null;
    const cost = sets.reduce((t, x) => t + x.p, 0), value = sets.reduce((t, x) => t + x.v, 0);
    return { mode: "set", cost, value, total, diff: value - cost, pct: ((value - cost) / cost) * 100,
             sets, unpriced: Object.keys(by).filter((c) => !(costs[c] > 0)) };
  }
  if (!(s.cost > 0)) return null;
  return { mode: "total", cost: s.cost, value: total, total, diff: total - s.cost, pct: ((total - s.cost) / s.cost) * 100, sets: [], unpriced: [] };
}
const signed = (v) => (v >= 0 ? "+" : "−") + money(Math.abs(v));
const pctText = (p) => (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0) + "%";
const fmtRange = (a, b) => (b && fmtTime(b) !== fmtTime(a) ? `${fmtTime(a)} – ${fmtTime(b)}` : fmtTime(a));
function fmtSpan(a, b) {
  const min = Math.round((new Date(b) - new Date(a)) / 60000);
  return !(min >= 1) ? "" : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
const pullsTotal = (pulls) => pulls.reduce((s, p) => s + (Number(p.price) || 0), 0);
const byTime = (pulls, newest = true) => [...pulls].sort((a, b) => (newest ? -1 : 1) * String(a.at || "").localeCompare(String(b.at || "")));

// saves go one at a time, the latest log last (a save asked for mid-flight runs once it lands)
let saving = null, saveAgain = false;
function savePulls() {
  if (saving) { saveAgain = true; return saving; }
  saving = (async () => {
    do {
      saveAgain = false;
      const r = await api(`/api/sessions/${session.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ started: session.started, cost: session.cost, cost_label: session.cost_label,
                               cost_mode: session.cost_mode, set_costs: session.set_costs, pulls: state.pulls }) })
        .catch((e) => ({ error: String(e) }));
      if (r.error) toast("Couldn't save the pull log: " + r.error);
    } while (saveAgain);
    saving = null;
  })();
  return saving;
}
const flushSaves = () => saving || Promise.resolve();

// pulls used to live in the window's localStorage: move them into a session of their own, once
async function migrateOldPulls() {
  let old = [];
  try { old = JSON.parse(localStorage.getItem("alakadex.pulls") || "[]"); } catch {}
  if (old.length) {
    const first = new Date(old.map((p) => p.at).filter(Boolean).sort()[0] || Date.now());
    const r = await api(`/api/sessions/${newSessionId(first)}`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ started: first.toISOString(), pulls: old }) });
    if (r.error) return;
  }
  try { localStorage.removeItem("alakadex.pulls"); } catch {}
}

// first: the first copy of this card in any session (the "New" chip and the new-card banner)
const isFirstCopy = (key) => owned("all")[key]?.n === 1;
function addPull(m, method, conf) {
  const p = { id: Date.now() + Math.random(), at: new Date().toISOString(), key: m.key, name: m.name, set: m.set, set_name: m.set_name,
              number: m.number, rarity: m.rarity, img: m.img, price: m.usd ?? null, decklists: null, method, conf };
  state.pulls.unshift(p);
  if (isFirstCopy(p.key)) p.first = true;
  savePulls(); renderPulls();
  return p;
}
function updatePull(id, m, method, conf, extra) {
  const p = state.pulls.find((x) => x.id === id);
  if (!p) return;
  if (m) {
    Object.assign(p, { key: m.key, name: m.name, set: m.set, set_name: m.set_name, number: m.number, rarity: m.rarity, img: m.img, price: m.usd ?? p.price, decklists: null });
    delete p.price_was; delete p.price_at;
    if (isFirstCopy(p.key)) p.first = true; else delete p.first;
  }
  if (method) { p.method = method; p.conf = conf; p.pending = false; }
  if (extra) Object.assign(p, Object.fromEntries(Object.entries(extra).filter(([, v]) => v != null)));
  savePulls(); renderPulls();
}
// Dex log numbers: No.001 is the session's first pull (state.pulls is newest first)
const pullNo = (p) => String(state.pulls.length - state.pulls.indexOf(p)).padStart(3, "0");
const TRASH = `<svg aria-hidden="true"><use href="#i-trash"/></svg>`;
function renderPulls() {
  const tb = $("pulls").querySelector("tbody"), n = state.pulls.length;
  tb.innerHTML = state.pulls.map((p, i) => {
    const no = String(n - i).padStart(3, "0");
    return `<tr class="${p.pending ? "pending" : ""}${i ? "" : " newest"}">
    <td class="cur">${i ? "" : "▶"}</td><td class="no">No.${no}</td>
    <td><img src="${esc(p.img)}" alt=""></td><td class="t" title="${esc(fmtStamp(p.at))}">${esc(fmtTime(p.at))}</td>
    <td>${esc(p.name)}${pullChips(p)}</td><td title="${esc(p.set_name)}">${esc(p.set)}</td><td>${esc(p.number)}</td>
    <td><span class="rarity ${rarityTier(p.rarity)}">${esc(p.rarity || "—")}</span></td><td>${p.decklists == null ? "—" : p.decklists.toLocaleString()}</td>
    <td class="num">${priceCell(p)}</td><td class="num chg-col">${chgCell(p)}</td>
    <td><button class="row-x" data-id="${p.id}" title="Remove from the log" aria-label="Remove No.${no} ${esc(p.name)} from this session">${TRASH}</button></td></tr>`;
  }).join("");
  $("pulls-total").textContent = money(pullsTotal(state.pulls));
  // the two black screens under the keypad
  $("bs-total").textContent = money(pullsTotal(state.pulls));
  $("bs-count").textContent = n;
  const fresh = state.pulls.filter((p) => p.first).length;
  $("bs-new").textContent = fresh ? `${fresh} NEW` : "";
  const changed = state.pulls.filter((p) => p.price_was != null);
  $("pulls").classList.toggle("has-change", changed.length > 0);
  const delta = changed.reduce((s, p) => s + (Number(p.price) || 0) - p.price_was, 0);
  $("pulls-delta").textContent = changed.length ? chgText(delta) : "";
  $("pulls-delta").className = "chg " + chgClass(delta);
  $("pulls-delta").title = changed.length ? "Change in total since the last price refresh" : "";
  renderPriceNote();
  $("pulls-count").textContent = state.pulls.length ? `(${state.pulls.length})` : "";
  $("session-when").textContent = `started ${fmtTime(session.started)}`;
  $("session-when").title = fmtStamp(session.started);
  renderValue();
  if ($("sets").open) renderSets();
  renderWhite();
}
// The price strip: mode switch and price boxes, pulled value against the price (a bar that
// passes the break-even mark), and a row per set (value; share or price and change).
function renderValue() {
  const by = valueBySet(state.pulls), st = priceStats(session, by), perSet = session.cost_mode === "set";
  document.querySelectorAll("#cost-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === session.cost_mode));
  $("total-cost-wrap").classList.toggle("hidden", perSet);
  $("pb-hint").textContent = st ? (st.unpriced.length ? `${st.unpriced.join(", ")} ${st.unpriced.length === 1 ? "has" : "have"} no price, not counted` : "")
    : perSet ? (Object.keys(by).length ? "Optional: enter a price on any set below" : "Optional: price boxes appear as sets are logged")
    : "Optional: enter what you paid to compare";
  renderSetRows(by, st);
  $("value-row").classList.toggle("hidden", !st);
  if (!st) return;
  const top = Math.max(st.cost, st.value) || 1, ahead = st.diff >= 0;
  $("vr-value-label").textContent = st.unpriced.length ? "Pulled value (priced sets)" : "Pulled value";
  $("vr-value").textContent = money(st.value);
  $("vr-diff").textContent = `${signed(st.diff)} · ${pctText(st.pct)}`;
  $("vr-diff").className = ahead ? "up" : "down";
  $("vr-fill").style.width = (st.value / top) * 100 + "%";
  $("vr-fill").className = ahead ? "up" : "down";
  const mark = (st.cost / top) * 100;
  $("vr-mark").style.left = mark + "%";
  $("vr-break").textContent = `break-even ${money(st.cost)}`;
  $("vr-break").style.left = mark + "%";
  $("vr-break").style.transform = `translateX(${mark > 75 ? -100 : mark < 25 ? 0 : -50}%)`;   // stays inside the bar
  $("vr-max").textContent = ahead ? money(st.value) : "";
}
// one row per set, most valuable first. Rows are updated in place while the set list stays
// the same, so typing in a price box isn't interrupted.
function renderSetRows(by, st) {
  const box = $("set-rows"), perSet = session.cost_mode === "set", costs = session.set_costs;
  const codes = [...new Set([...Object.keys(by), ...(perSet ? Object.keys(costs).filter((c) => costs[c] > 0) : [])])]
    .sort((a, b) => (by[b]?.v || 0) - (by[a]?.v || 0) || a.localeCompare(b));
  box.classList.toggle("hidden", !codes.length);
  const total = Object.values(by).reduce((t, x) => t + x.v, 0);
  const sig = session.cost_mode + "|" + codes.join(",");
  if (box.dataset.sig !== sig) {
    const focused = document.activeElement?.closest?.("#set-rows .sr")?.dataset.code;
    box.innerHTML = `<div class="sr sr-head"><span>Set</span><span>Cards</span><span class="num">Value</span>`
      + (perSet ? `<span>Spent</span><span>Value vs spent</span><span class="num">Change</span>` : `<span>Share</span><span></span><span></span>`) + `</div>`
      + codes.map((c) => `<div class="sr" data-code="${esc(c)}">
        <span class="sr-set" title="${esc(by[c]?.name || coll.sets?.[c]?.name || c)}"><span class="set-code">${esc(c)}</span>${esc(by[c]?.name || coll.sets?.[c]?.name || c)}</span>
        <span class="sr-n"></span><span class="sr-v num"></span>
        ${perSet ? `<span class="money-in">$<input type="number" min="0" step="0.01" placeholder="—" data-set-cost="${esc(c)}"></span>` : `<span class="sr-share"></span>`}
        <span class="sr-bar"><span class="vr-bar"><span class="sr-fill"></span><span class="sr-mark"></span></span></span>
        <span class="sr-pct num"></span></div>`).join("");
    box.dataset.sig = sig;
    if (focused) box.querySelector(`.sr[data-code="${CSS.escape(focused)}"] input`)?.focus();
  }
  for (const row of box.querySelectorAll(".sr[data-code]")) {
    const c = row.dataset.code, x = by[c] || { n: 0, v: 0 };
    row.querySelector(".sr-n").textContent = x.n;
    row.querySelector(".sr-v").textContent = money(x.v);
    const fill = row.querySelector(".sr-fill"), mark = row.querySelector(".sr-mark"), pct = row.querySelector(".sr-pct");
    if (!perSet) {
      const share = total ? (x.v / total) * 100 : 0;
      row.querySelector(".sr-share").textContent = `${Math.round(share)}% of value`;
      fill.style.width = share + "%"; fill.className = "sr-fill share"; mark.style.display = "none"; pct.textContent = "";
      continue;
    }
    const inp = row.querySelector("input");
    if (document.activeElement !== inp) inp.value = costs[c] ?? "";
    const p = costs[c];
    if (p > 0) {
      const t = Math.max(p, x.v) || 1, up = x.v >= p;
      fill.style.width = (x.v / t) * 100 + "%"; fill.className = "sr-fill " + (up ? "up" : "down");
      mark.style.display = ""; mark.style.left = (p / t) * 100 + "%";
      pct.textContent = pctText(((x.v - p) / p) * 100); pct.className = "sr-pct num " + (up ? "up" : "down");
    } else {
      fill.style.width = "0"; mark.style.display = "none";
      pct.textContent = "no price"; pct.className = "sr-pct num muted";
    }
  }
}
$("set-rows").addEventListener("input", (e) => {
  const code = e.target.dataset?.setCost;
  if (!code) return;
  const v = toCost(e.target.value);
  if (v) session.set_costs[code] = v; else delete session.set_costs[code];
  renderValue();
  savePulls();
});
$("cost-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b || b.dataset.mode === session.cost_mode) return;
  session.cost_mode = b.dataset.mode;
  try { localStorage.setItem(COST_MODE_KEY, session.cost_mode); } catch {}
  renderValue();
  savePulls();
});
function setSessionCost(cost, label) {
  session.cost = toCost(cost);
  session.cost_label = label ?? session.cost_label;
  renderValue();
  savePulls();
}
$("session-cost").addEventListener("input", (e) => setSessionCost(e.target.value));
$("session-cost-label").addEventListener("input", (e) => setSessionCost(session.cost, e.target.value));
function showSessionCost() {
  $("session-cost").value = session.cost ?? "";
  $("session-cost-label").value = session.cost_label || "";
  renderValue();
}
const hasPrice = (s) => s.cost > 0 || Object.values(s.set_costs || {}).some((p) => p > 0);
$("pulls").addEventListener("click", (e) => {
  const b = e.target.closest(".row-x");
  if (!b) return;
  state.pulls = state.pulls.filter((p) => String(p.id) !== b.dataset.id);
  savePulls(); renderPulls();
});
function clearSession() {
  state.pulls = []; session.cost = null; session.cost_label = ""; session.set_costs = {};
  showSessionCost(); renderPulls();
  return savePulls();
}
$("btn-clear").onclick = () => {
  if (!state.pulls.length && !hasPrice(session)) return toast("Nothing logged this session yet");
  if (!confirm(`Delete this session's pull log (${state.pulls.length} card${state.pulls.length === 1 ? "" : "s"}) and its prices? This can't be undone.`)) return;
  clearSession();
};

// ---- Refresh prices: a pull keeps the price from when it was scanned until it is refreshed.
// price_was = its price before the last refresh, price_at = when the new one was fetched.
const chgClass = (d) => (Math.abs(d) < 0.005 ? "same" : d > 0 ? "up" : "down");
const chgText = (d) => (Math.abs(d) < 0.005 ? "—" : (d > 0 ? "▲ " : "▼ ") + money(Math.abs(d)));
function priceCell(p) {
  const moved = p.price_was != null && Math.abs(p.price_was - (Number(p.price) || 0)) >= 0.005;
  return (moved ? `<span class="was">${money(p.price_was)}</span>` : "")
    + `<span title="${esc(p.price_at ? "TCGplayer price from " + fmtStamp(p.price_at) : "TCGplayer price when scanned")}">${money(p.price)}</span>`;
}
function chgCell(p) {
  if (p.price_was == null) return "";
  const d = (Number(p.price) || 0) - p.price_was;
  return `<span class="chg ${chgClass(d)}">${chgText(d)}</span>`;
}
const pullChips = (p) => (isHit(p.price, p.rarity) ? `<span class="chip-hit">★ Hit</span>` : "")
  + (p.first ? `<span class="chip-new" title="First copy in any of your sessions">New</span>` : "");

const PRICE_BATCH = 8;   // cards per /api/prices call (the server looks up 8 at once), for progress
async function fetchPrices(pulls, onProgress) {
  const keys = [...new Set(pulls.map((p) => p.key).filter(Boolean))], out = {};
  for (let i = 0; i < keys.length; i += PRICE_BATCH) {
    onProgress?.(i, keys.length);
    const batch = keys.slice(i, i + PRICE_BATCH);
    const r = await api("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: batch }) })
      .catch((e) => ({ error: String(e) }));
    for (const k of batch) out[k] = r.error ? { error: r.error } : r[k] || { error: "no answer" };
  }
  return out;
}
// put fetched prices on the pulls; counted per pull: {up, down, same, priced (had none), failed, at}
function applyPrices(pulls, prices, at) {
  const c = { up: 0, down: 0, same: 0, priced: 0, failed: 0, at };
  for (const p of pulls) {
    const r = prices[p.key];
    if (!r) continue;                          // logged while the refresh was running
    if (r.price == null) { c.failed++; continue; }
    const old = p.price == null ? null : Number(p.price);
    if (old == null) { delete p.price_was; c.priced++; } else { p.price_was = old; c[chgClass(r.price - old)]++; }
    p.price = r.price; p.price_at = at;
  }
  return c;
}
const refreshedAny = (c) => c.up + c.down + c.same + c.priced > 0;
function priceSummary(c) {
  return [c.up && `${c.up} went up`, c.down && `${c.down} went down`, c.same && `${c.same} didn't change`,
          c.priced && `${c.priced} got a price`].filter(Boolean).join(", ")
    + (c.failed ? `. ${c.failed} couldn't be reached and kept the old price` : "");
}
function renderPriceNote() {
  const n = state.priceNote, el = $("price-note");
  el.classList.toggle("hidden", !n);
  if (!n) return;
  el.className = "price-note" + (n.busy ? " busy" : n.warn ? " warn" : "");
  el.innerHTML = n.html;
}
async function refreshSessionPrices() {
  const b = $("btn-refresh-prices");
  if (b.disabled) return;
  if (!state.pulls.length) return toast("Nothing logged this session yet");
  b.disabled = true;
  try {
    const prices = await fetchPrices(state.pulls, (i, n) => {
      b.textContent = `${i}/${n}`;
      state.priceNote = { busy: true, html: `Getting today's TCGplayer prices… ${i} of ${n} card${n === 1 ? "" : "s"}` };
      renderPriceNote();
    });
    const c = applyPrices(state.pulls, prices, new Date().toISOString());
    state.priceNote = refreshedAny(c)
      ? { warn: c.failed > 0, html: `<span>Prices updated from TCGplayer at <strong>${esc(fmtTime(c.at))}</strong>. ${esc(priceSummary(c))}.</span>`
          + `<span class="muted">Change is since each card's previous price</span>` }
      : { warn: true, html: "Couldn't reach TCGplayer, so no prices were changed. Check your internet connection and try again." };
    if (refreshedAny(c)) savePulls();
    renderPulls();
  } finally { b.disabled = false; b.textContent = "PRICES"; }
}
$("btn-refresh-prices").onclick = refreshSessionPrices;
// a saved session (History, or Refresh prices when Alakadex opens): {counts, before, after} or null
async function refreshSavedSession(s, onProgress) {
  const before = pullsTotal(s.pulls);
  const c = applyPrices(s.pulls, await fetchPrices(s.pulls, onProgress), new Date().toISOString());
  if (!refreshedAny(c)) return { c };
  const r = await api(`/api/sessions/${s.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ started: s.started, ...Object.fromEntries(PRICE_KEYS.map((k) => [k, s[k]])), pulls: s.pulls }) });
  if (r.error) { toast("Couldn't save the new prices: " + r.error); return null; }
  return { c, before, after: pullsTotal(s.pulls) };
}
async function refreshPricesOnOpen() {
  if (!setting("refresh_prices_on_open", false)) return;
  const list = await api("/api/sessions").catch(() => null);
  const last = Array.isArray(list) && list.find((s) => s.id !== session.id && s.count);
  if (!last) return;
  const s = await api(`/api/sessions/${last.id}`);
  if (!s?.pulls?.length) return;
  const r = await refreshSavedSession(s);
  if (r?.after == null) return;   // offline or not saved: nothing to say
  delete histCache[s.id];
  toast(`Updated prices for your last session (${fmtDate(s.started)}): total ${money(r.after)} (${chgText(r.after - r.before)})`);
}

// ---- Pull alerts: a banner over the camera for a card that's new to your dex (first copy in any
// session), a celebration for a hit. The live price arrives a moment after a card is logged, so
// the pull is checked again then; only cards logged in the last minute get either.
const alerted = new Map();   // pull id -> "new" | "hit": what was shown for it
const ALERT_WINDOW = 60000;
function alertFor(pull, price, rarity) {
  if (!pull || pull.id === -1 || Date.now() - new Date(pull.at).getTime() > ALERT_WINDOW) return;
  const was = alerted.get(pull.id);
  if (was === "hit") return;
  if (isHit(price, rarity)) { alerted.set(pull.id, "hit"); celebrate(pull, price, rarity); }
  else if (!was && pull.first && setting("new_card_banner", true)) { alerted.set(pull.id, "new"); newCardBanner(pull); }
}
let bannerTimer = null;
function showBanner(kind, badge, title, sub, ms) {
  const el = $("pull-banner");
  clearTimeout(bannerTimer);
  el.classList.remove("hidden", "out");
  el.classList.toggle("hit", kind === "hit");
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";   // slide in again
  $("nb-badge").textContent = badge; $("nb-title").textContent = title; $("nb-sub").textContent = sub;
  bannerTimer = setTimeout(hideBanner, ms);
}
function hideBanner() {
  const el = $("pull-banner");
  if (el.classList.contains("hidden") || el.classList.contains("out")) return false;
  clearTimeout(bannerTimer);
  el.classList.add("out");
  bannerTimer = setTimeout(() => el.classList.add("hidden"), 300);
  return true;
}
$("nb-x").onclick = hideBanner;
function newCardBanner(pull) {
  const info = coll.sets?.[pull.set];
  const have = info?.total ? Math.min((progressBySet(owned("all"))[pull.set] || { have: 0 }).have, info.total) : 0;
  showBanner("new", "NEW!", `First ${pull.name} in your dex`,
    (pull.set_name || pull.set) + (info?.total ? ` · ${have} of ${info.total} collected` : ` · #${pull.number}`), 3500);
  chime("new");
}
const CONFETTI = ["#ffcb05", "#3aa7f0", "#f05252", "#ffffff", "#3ccf7a", "#f0abfc"];
// bigger hits get a bigger headline: 4x and 10x the alert price
function hitHeadline(price) {
  const base = sensorOpts.hit > 0 ? sensorOpts.hit : 20;
  return price >= base * 10 ? "CHASE CARD!" : price >= base * 4 ? "BIG HIT!" : "NICE HIT!";
}
let cbTimer = null;
function celebrate(pull, price, rarity) {
  const why = priceHit(price) ? `over your ${money(sensorOpts.hit)} alert` : "top rarity";
  chime("hit");
  flashLens("hit", 3200);
  if (setting("celebration", "full") === "banner") {
    showBanner("hit", "HIT!", `${pull.name} · ${money(price)}`, `${rarity || pull.set_name || pull.set} · ${why}`, 4500);
    return;
  }
  hideBanner();
  const img = $("cb-img");
  img.onerror = () => { img.onerror = null; img.src = pull.img || ""; };
  img.src = cardImg(pull);
  $("cb-head").textContent = hitHeadline(Number(price) || 0);
  $("cb-new").classList.toggle("hidden", !pull.first);
  $("cb-price").textContent = money(price);
  $("cb-sub").textContent = `${pull.name} · ${rarity || "—"} · ${why}`;
  const fall = $("video-wrap").clientHeight + 40;
  $("cb-confetti").innerHTML = Array.from({ length: 40 }, (_, i) => `<i style="left:${(Math.random() * 100).toFixed(1)}%;`
    + `background:${CONFETTI[i % CONFETTI.length]};--fall:${fall}px;--spin:${Math.round((360 + Math.random() * 540) * (Math.random() < 0.5 ? -1 : 1))}deg;`
    + `animation-duration:${(1.6 + Math.random() * 1.4).toFixed(2)}s;animation-delay:${(Math.random() * 0.6).toFixed(2)}s"></i>`).join("");
  $("celebrate").classList.remove("hidden", "out");
  clearTimeout(cbTimer);
  cbTimer = setTimeout(endCelebration, 3200);
}
function endCelebration() {
  const el = $("celebrate");
  if (el.classList.contains("hidden") || el.classList.contains("out")) return false;
  clearTimeout(cbTimer);
  el.classList.add("out");
  cbTimer = setTimeout(() => { el.classList.add("hidden"); $("cb-confetti").innerHTML = ""; }, 350);
  return true;
}
$("celebrate").onclick = endCelebration;
function dismissAlerts() {
  const a = endCelebration(), b = hideBanner();
  return a || b;
}
// a short chiptune blip (new card) or arpeggio (hit); no sound files needed
let audio = null, clickBuf = null, clickEnd = 0;
function chime(kind) {
  if (!setting("alert_sound", true)) return;
  try {
    audio = audio || new AudioContext();
    if (audio.state === "suspended") audio.resume();
    const notes = kind === "hit" ? [523.25, 659.25, 783.99, 1046.5] : [987.77, 1318.51];
    const start = Math.max(audio.currentTime, clickEnd);   // after the scan click, not over it
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t = start + i * 0.09;
      o.type = "square"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i === notes.length - 1 ? 0.35 : 0.14));
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + 0.4);
    });
  } catch {}
}
// the Pokédex click (Gen 1 anime) when a scan completes; fetched now, decoded on first use
const clickData = fetch("sounds/pokedex_click.ogg").then((r) => r.arrayBuffer()).catch(() => null);
async function dexClick() {
  if (!setting("alert_sound", true)) return;
  try {
    audio = audio || new AudioContext();
    if (audio.state === "suspended") audio.resume();
    if (!clickBuf) {
      const data = await clickData;
      if (!data) return;
      clickBuf = await audio.decodeAudioData(data.slice(0));
    }
    const src = audio.createBufferSource(), g = audio.createGain();
    src.buffer = clickBuf; g.gain.value = 0.6;
    src.connect(g).connect(audio.destination);
    src.start();
    clickEnd = audio.currentTime + clickBuf.duration;
  } catch {}
}
// result panel: "NEW TO YOUR DEX" or "★ HIT $142.50" above the card
function renderStrip(pull, price, rarity) {
  const el = $("r-strip"), real = pull && pull.id !== -1, hit = real && isHit(price, rarity);
  $("hit-light").classList.toggle("on", !!hit);   // the yellow light on the dex's right half
  if (!real || !(hit || pull.first)) { el.classList.add("hidden"); return; }
  el.className = "r-strip" + (hit ? " hit" : "");
  if (hit) {
    const best = state.pulls.length > 1 && state.pulls.every((p) => p === pull || (Number(p.price) || 0) <= (Number(price) || 0));
    el.innerHTML = `<span class="rs-label">★ HIT ${esc(money(price))}</span>${pull.first ? `<span class="rs-new">NEW</span>` : ""}`
      + `<span class="rs-note">${best ? "Biggest pull this session" : priceHit(price) ? `Over your ${esc(money(sensorOpts.hit))} alert` : "Top rarity"}</span>`;
  } else el.innerHTML = `<span class="rs-label">NEW TO YOUR DEX</span><span class="rs-note">1st copy across all sessions</span>`;
}

// ---- saving files: the desktop window has a native Save dialog (it doesn't do browser
// downloads); in a browser the file is downloaded
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add("hidden"), 5000);
}
const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob);
});
async function saveFile(filename, data, label) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
  if (window.pywebview?.api?.save_file) {
    try {
      const path = await window.pywebview.api.save_file(filename, await blobToBase64(blob), label);
      if (path) toast("Saved to " + path);
    } catch (e) { toast("Couldn't save: " + e); }
    return;
  }
  if (await window.alakadexWeb.share(filename, blob)) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stampForFile = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
function exportCsv(s, pulls) {
  const cols = ["at", "name", "set", "set_name", "number", "rarity", "price", "decklists", "method", "key"];
  const csv = [cols.join(",")].concat(byTime(pulls, false).map((p) => cols.map((c) => `"${String(p[c] ?? "").replace(/"/g, '""')}"`).join(","))).join("\r\n");
  return saveFile(`alakadex-pulls-${stampForFile(s.started)}.csv`, new Blob(["﻿" + csv], { type: "text/csv" }), "CSV file");
}
$("btn-export").onclick = () => (state.pulls.length ? exportCsv(session, state.pulls) : toast("Nothing logged this session yet"));

// ---- History: earlier sessions, by date and time
const HIST_SORT_KEY = "alakadex.historySort";
$("h-sort").value = localStorageGet(HIST_SORT_KEY) === "old" ? "old" : "new";
$("h-sort").onchange = () => { try { localStorage.setItem(HIST_SORT_KEY, $("h-sort").value); } catch {} renderHistory(); };
$("btn-history").onclick = async () => { $("history").showModal(); await flushSaves(); renderHistory(); };
$("h-close").onclick = () => $("history").close();
const histCache = {};   // session id -> full session (pulls), fetched when opened
async function loadSession(id) {
  if (id === session.id) return { ...session, pulls: state.pulls };
  return histCache[id] || (histCache[id] = await api(`/api/sessions/${id}`));
}
async function renderHistory() {
  const newest = $("h-sort").value !== "old";
  const list = await api("/api/sessions");
  if (!Array.isArray(list)) { $("h-list").innerHTML = `<p class="muted">Couldn't load the history: ${esc(list.error)}</p>`; return; }
  if (!list.length) { $("h-list").innerHTML = `<p class="muted">No pulls saved yet.</p>`; return; }
  list.sort((a, b) => (newest ? -1 : 1) * String(a.started || "").localeCompare(String(b.started || "")));
  let day = null, html = "";
  for (const s of list) {
    const d = fmtDate(s.started);
    if (d !== day) { html += `<div class="h-day">${esc(d)}</div>`; day = d; }
    const span = fmtSpan(s.started, s.ended);
    html += `<details class="h-sess" data-id="${esc(s.id)}">
      <summary>
        <span class="h-when">${esc(fmtRange(s.started, s.ended))}${span ? ` <span class="muted">(${span})</span>` : ""}</span>
        ${s.id === session.id ? `<span class="h-badge">this session</span>` : ""}
        <span class="h-top muted">${s.top ? "Top: " + esc(s.top.name) + " " + money(s.top.price) : ""}</span>
        <span class="h-count">${s.count} card${s.count === 1 ? "" : "s"}</span>
        ${histCostTag(s)}
        <span class="h-total">${money(s.total)}</span>
      </summary>
      <div class="h-body"><p class="muted">Loading…</p></div>
    </details>`;
  }
  $("h-list").innerHTML = html;
}
// "spent $54 · +32%" on a History row; per set, the tooltip lists each set's change
function histCostTag(s) {
  const st = priceStats(s, bySetFromSummary(s));
  if (!st) return `<span class="h-addpaid" title="Open this session to enter what you paid">+ Add what you paid</span>`;
  const tip = `Spent ${money(st.cost)}${s.cost_label ? " on " + s.cost_label : ""}`
    + (st.mode === "set" ? " — " + st.sets.map((x) => `${x.code} ${money(x.p)} → ${pctText(x.pct)}`).join(", ") : "");
  return `<span class="h-cost ${st.diff >= 0 ? "up" : "down"}" title="${esc(tip)}">spent ${money(st.cost)}${st.mode === "set" ? ` (${st.sets.length} set${st.sets.length === 1 ? "" : "s"})` : ""} · ${pctText(st.pct)}</span>`;
}
// the price editor in an opened History session: mode switch, then one total or a box per set
function histPriceEditor(s) {
  const perSet = s.cost_mode === "set", by = valueBySet(s.pulls || []);
  const codes = [...new Set([...Object.keys(by), ...Object.keys(s.set_costs || {})])].sort();
  return `<div class="h-price">
      <div class="seg" data-h-mode><button type="button" data-mode="total" class="${perSet ? "" : "on"}">One total</button><button type="button" data-mode="set" class="${perSet ? "on" : ""}">Per set</button></div>
      ${perSet ? codes.map((c) => `<label class="spent">${esc(c)} <span class="money-in">$<input type="number" min="0" step="0.01" placeholder="—" data-cost-set="${esc(c)}" value="${s.set_costs?.[c] ?? ""}"></span></label>`).join("")
        : `<label class="spent">Spent <span class="money-in">$<input type="number" min="0" step="0.01" placeholder="0.00" data-cost="price" value="${s.cost ?? ""}"></span></label>`}
      <input type="text" class="cost-label" maxlength="80" placeholder="Booster bundle" data-cost="label" value="${esc(s.cost_label || "")}">
    </div>`;
}
$("h-list").addEventListener("toggle", async (e) => {
  const el = e.target;
  if (!el.matches?.(".h-sess") || !el.open) return;
  const s = await loadSession(el.dataset.id);
  const body = el.querySelector(".h-body");
  if (!s || s.error) { body.innerHTML = `<p class="muted">Couldn't load this session.</p>`; return; }
  const rows = byTime(s.pulls || [], $("h-sort").value !== "old");
  body.innerHTML = `${histPriceEditor(s)}<div class="h-actions">
      <button class="btn small" data-act="prices" title="Get today's TCGplayer prices for this session's pulls">⟳ Refresh prices</button>
      <button class="btn small" data-act="csv">Export CSV</button>
      <button class="btn small" data-act="recap">Recap</button>
      <span class="spacer"></span>
      <button class="btn small ghost" data-act="delete">Delete session</button>
    </div>
    <div class="table-scroll"><table><thead><tr><th></th><th>Time</th><th>Card</th><th>Set</th><th>No.</th><th>Rarity</th><th class="num">Market</th><th></th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><img src="${esc(p.img)}" loading="lazy" alt=""></td><td class="t" title="${esc(fmtStamp(p.at))}">${esc(fmtTime(p.at))}</td>
      <td>${esc(p.name)}${pullChips(p)}</td><td title="${esc(p.set_name)}">${esc(p.set)}</td><td>${esc(p.number)}</td>
      <td><span class="rarity ${rarityTier(p.rarity)}">${esc(p.rarity || "—")}</span></td><td class="num">${priceCell(p)} ${chgCell(p)}</td>
      <td>${p.id == null ? "" : `<button class="row-x" data-act="rmpull" data-pid="${esc(p.id)}" title="Remove from this session's log" aria-label="Remove ${esc(p.name)} from this session">${TRASH}</button>`}</td></tr>`).join("")}
    </tbody></table></div>`;
  // opened with "+ Add what you paid": straight to the price box
  if (dex.focusPaid === el.dataset.id) { dex.focusPaid = null; body.querySelector('[data-cost="price"], [data-cost-set]')?.focus(); }
}, true);
$("h-list").addEventListener("click", (e) => {
  const a = e.target.closest(".h-addpaid");
  if (!a) return;
  const el = a.closest(".h-sess");
  dex.focusPaid = el.dataset.id;
  if (el.open) { e.preventDefault(); dex.focusPaid = null; el.querySelector('[data-cost="price"], [data-cost-set]')?.focus(); }
});
$("h-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = b.closest(".h-sess").dataset.id;
  const s = await loadSession(id);
  if (!s || s.error) return;
  if (b.dataset.act === "prices") {
    if (!s.pulls?.length || b.disabled) return;
    b.disabled = true;
    let r;
    try {
      if (id === session.id) { await refreshSessionPrices(); r = null; }
      else r = await refreshSavedSession(s, (i, n) => (b.textContent = `⟳ Refreshing ${i}/${n}…`));
    } finally { b.disabled = false; b.textContent = "⟳ Refresh prices"; }
    if (r) toast(refreshedAny(r.c) ? `Prices updated: ${priceSummary(r.c)}. Total ${money(r.after)} (${chgText(r.after - r.before)}).`
      : "Couldn't reach TCGplayer, so no prices were changed.");
    await renderHistory();   // new totals; reopen this session
    const el = $("h-list").querySelector(`.h-sess[data-id="${CSS.escape(id)}"]`);
    if (el) el.open = true;
  }
  else if (b.dataset.act === "rmpull") {
    // one card out of a session's log (this session's live log, or a saved one)
    const pid = b.dataset.pid;
    if (id === session.id) {
      state.pulls = state.pulls.filter((p) => String(p.id) !== pid);
      renderPulls(); await savePulls();
    } else {
      s.pulls = s.pulls.filter((p) => String(p.id) !== pid);
      const r = await api(`/api/sessions/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ started: s.started, ...Object.fromEntries(PRICE_KEYS.map((k) => [k, s[k]])), pulls: s.pulls }) });
      if (r.error) { toast("Couldn't save the change: " + r.error); delete histCache[id]; return; }
    }
    await loadCollection();
    await renderHistory();
    const el = $("h-list").querySelector(`.h-sess[data-id="${CSS.escape(id)}"]`);
    if (el) el.open = true;
  }
  else if (b.dataset.act === "csv") exportCsv(s, s.pulls);
  else if (b.dataset.act === "recap") { $("history").close(); showRecap(s, s.pulls, false); }
  else if (b.dataset.act === "delete") {
    if (!confirm(`Delete the pull log from ${fmtDate(s.started)} ${fmtTime(s.started)} (${s.pulls.length} card${s.pulls.length === 1 ? "" : "s"})? This can't be undone.`)) return;
    if (id === session.id) await clearSession();
    else await api(`/api/sessions/${id}`, { method: "DELETE" });
    delete histCache[id];
    await loadCollection();
    renderHistory();
  }
});
// a session's prices can be entered or changed later, from History
const PRICE_KEYS = ["cost", "cost_label", "cost_mode", "set_costs"];
let histCostTimer = null;
async function saveHistPrice(id, s, now = false) {
  if (id === session.id) {   // the current session: same as editing it in the pulls panel
    Object.assign(session, Object.fromEntries(PRICE_KEYS.map((k) => [k, s[k]])));
    showSessionCost(); savePulls();
    return;
  }
  clearTimeout(histCostTimer);
  histCostTimer = setTimeout(async () => {
    const r = await api(`/api/sessions/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ started: s.started, ...Object.fromEntries(PRICE_KEYS.map((k) => [k, s[k]])), pulls: s.pulls }) });
    if (r.error) toast("Couldn't save the price: " + r.error);
  }, now ? 0 : 400);
}
$("h-list").addEventListener("input", async (e) => {
  const inp = e.target.closest("input[data-cost], input[data-cost-set]");
  if (!inp) return;
  const el = inp.closest(".h-sess"), id = el.dataset.id, s = await loadSession(id);
  if (!s || s.error) return;
  s.cost_label = el.querySelector('[data-cost="label"]').value;
  if (inp.dataset.costSet) {
    s.set_costs = { ...(s.set_costs || {}) };
    const v = toCost(inp.value);
    if (v) s.set_costs[inp.dataset.costSet] = v; else delete s.set_costs[inp.dataset.costSet];
  } else if (inp.dataset.cost === "price") s.cost = toCost(inp.value);
  saveHistPrice(id, s);
});
$("h-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-h-mode] button[data-mode]");
  if (!b) return;
  const el = b.closest(".h-sess"), id = el.dataset.id, s = await loadSession(id);
  if (!s || s.error || s.cost_mode === b.dataset.mode) return;
  s.cost_mode = b.dataset.mode;
  el.querySelector(".h-price").outerHTML = histPriceEditor(s);
  saveHistPrice(id, s, true);
});

// ---- Recap: the session's highest-value pulls (also shown when the desktop window is closed)
const RECAP_TOP = 5;
const topPulls = (pulls) => [...pulls].sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0)).slice(0, RECAP_TOP);
const cardImg = (p) => window.alakadexWeb.cardImg(p);
let recap = null;   // {s, pulls, closing, wasPaused}
// "spent $54 on X (+$17.40, +32%)", per set "spent $104: 30C +32% · POR −6% · overall +14%"; "" without a price
function costLine(s, pulls, sep = "") {
  const st = priceStats(s, valueBySet(pulls));
  if (!st) return "";
  const on = s.cost_label ? ` on ${s.cost_label}` : "";
  if (st.mode === "total") return `${sep}spent ${money(st.cost)}${on} (${signed(st.diff)}, ${pctText(st.pct)})`;
  return `${sep}spent ${money(st.cost)}${on}: ` + st.sets.map((x) => `${x.code} ${pctText(x.pct)}`).join(" · ")
    + (st.sets.length > 1 ? ` · overall ${pctText(st.pct)}` : "") + ` (${signed(st.diff)})`
    + (st.unpriced.length ? `; ${st.unpriced.join(", ")} not priced` : "");
}
function showRecap(s, pulls, closing) {
  const wasPaused = recap ? recap.wasPaused : state.paused;
  recap = { s, pulls, closing, wasPaused };
  setPaused(true);   // nothing new is logged while the recap is up
  const top = topPulls(pulls), end = byTime(pulls)[0]?.at || s.ended;
  const span = fmtSpan(s.started, end);
  $("rc-title").textContent = closing ? "BEFORE YOU GO" : "SESSION RECAP";
  $("rc-meta").textContent = `${fmtDate(s.started)} · ${fmtRange(s.started, end)}${span ? ` (${span})` : ""}`
    + (s.cost_label ? ` · on ${s.cost_label}` : "");
  // the black stat screens: cards, new to your dex, hits, pulled value, and what was paid if known
  const total = pullsTotal(pulls), st = priceStats(s, valueBySet(pulls));
  const news = pulls.filter((p) => p.first).length, hits = pulls.filter((p) => isHit(p.price, p.rarity)).length;
  const tile = (k, v, cls = "") => `<div class="rc-stat"><span>${k}</span><b class="${cls}">${esc(v)}</b></div>`;
  $("rc-stats").innerHTML = tile("CARDS", pulls.length) + tile("NEW TO DEX", news) + tile("HITS", hits, hits ? "gold" : "")
    + tile("PULLED", money(total), "gold")
    + (st ? tile("SPENT", money(st.cost)) + tile("VS SPENT", `${signed(st.diff)}  ${pctText(st.pct)}`, st.diff >= 0 ? "up" : "down") : "");
  const perSet = st && st.mode === "set";
  $("rc-sets").classList.toggle("hidden", !perSet);
  $("rc-sets").innerHTML = !perSet ? "" : `<span class="px">BY SET</span>`
    + st.sets.map((x) => `<span class="chip ${x.pct >= 0 ? "up" : "down"}">${esc(x.code)} ${esc(pctText(x.pct))}</span>`).join("")
    + (st.unpriced.length ? `<span class="dlg-sub">${esc(st.unpriced.join(", "))} not priced</span>` : "");
  // Hall of Fame: highest on the left, every card the same size
  $("rc-top").innerHTML = top.length ? top.map((p, i) => `<div class="rc-card${i ? "" : " best"}">
      <span class="rc-rank">#${i + 1}</span>
      <img src="${esc(cardImg(p))}" alt="" onerror="this.onerror=null;this.src='${esc(p.img || "")}'">
      ${p.first ? `<span class="rc-new">NEW</span>` : ""}
      <div class="rc-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="rc-set" title="${esc(p.set_name)}">${esc(p.set)} ${esc(p.number)}</div>
      <span class="rarity ${rarityTier(p.rarity)}">${esc(p.rarity || "—")}</span>
      <div class="rc-price">${money(p.price)}</div>
    </div>`).join("") : `<p class="dlg-sub" style="color:#9fbf95">Nothing was logged this session.</p>`;
  $("rc-save-img").disabled = $("rc-save-txt").disabled = !top.length;
  $("rc-quit").classList.toggle("hidden", !closing);
  if (!$("recap").open) $("recap").showModal();
}
// called by the desktop window when it's closed: true = recap shown (the window waits for
// "Close Alakadex"), false = nothing to recap, close now
window.alakadexRecap = (closing) => {
  if (!state.pulls.length) return false;
  showRecap(session, state.pulls, !!closing);
  return true;
};
$("btn-recap").onclick = () => showRecap(session, state.pulls, false);
$("rc-back").onclick = () => $("recap").close();
$("recap").addEventListener("close", () => {
  if (!recap) return;
  if (recap.closing && !recap.quitting) window.pywebview?.api?.keep_open?.();
  if (!recap.quitting) setPaused(recap.wasPaused);
  recap = null;
});
$("rc-quit").onclick = async () => {
  recap.quitting = true;
  $("rc-quit").disabled = true; $("rc-quit").textContent = "Closing…";
  await flushSaves();
  window.pywebview?.api?.close_app?.();
};
$("rc-save-txt").onclick = () => {
  const { s, pulls } = recap, end = byTime(pulls)[0]?.at || s.ended, span = fmtSpan(s.started, end);
  const line = (p) => `${p.name} — ${p.set_name || p.set} #${p.number} · ${p.rarity || "?"} · ${money(p.price)}`;
  const txt = [
    "Alakadex session recap",
    `${fmtDate(s.started)} · ${fmtRange(s.started, end)}${span ? ` (${span})` : ""}`,
    `${pulls.length} card${pulls.length === 1 ? "" : "s"} · total ${money(pullsTotal(pulls))}` + costLine(s, pulls, " · "),
    "", "Highest-value pulls",
    ...topPulls(pulls).map((p, i) => ` ${i + 1}. ${line(p)}`),
    "", "All pulls",
    ...byTime(pulls, false).map((p) => ` ${fmtTime(p.at).padStart(8)}  ${line(p)}`),
    "",
  ].join("\r\n");
  saveFile(`alakadex-recap-${stampForFile(s.started)}.txt`, txt, "Text file");
};
$("rc-save-img").onclick = async () => {
  const b = $("rc-save-img");
  b.disabled = true;
  try {
    const blob = await recapImage(recap.s, recap.pulls);
    await saveFile(`alakadex-recap-${stampForFile(recap.s.started)}.png`, blob, "PNG image");
  } finally { b.disabled = false; }
};
const loadImage = (src) => new Promise((res) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
function fitText(ctx, text, maxW) {
  text = String(text ?? "");
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
  return text + "…";
}
// a picture of the top pulls (card scans come from the local index, so the canvas can be saved)
async function recapImage(s, pulls) {
  const top = topPulls(pulls), end = byTime(pulls)[0]?.at || s.ended;
  const W = 1200, PAD = 48, CW = 196, CH = 274, GAP = 24, H = 660;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  try { await document.fonts.load('20px "Press Start 2P"'); } catch {}
  const imgs = await Promise.all(top.map((p) => window.alakadexWeb.recapPicture(p, loadImage, cardImg)));
  g.fillStyle = "#1b1b1d"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#c8102e"; g.fillRect(0, 0, W, 112);
  g.fillStyle = "#8e0b20"; g.fillRect(0, 112, W, 6);
  g.fillStyle = "#ffcb05"; g.font = '26px "Press Start 2P", monospace'; g.textBaseline = "alphabetic";
  g.fillText("ALAKADEX", PAD, 58);
  g.fillStyle = "#fff"; g.font = '13px "Press Start 2P", monospace';
  g.fillText("SESSION RECAP", PAD, 90);
  g.textAlign = "right"; g.font = "600 18px system-ui, sans-serif";
  g.fillText(`${fmtDate(s.started)} · ${fmtRange(s.started, end)}`, W - PAD, 56);
  g.font = "16px system-ui, sans-serif";
  g.fillText(`${pulls.length} card${pulls.length === 1 ? "" : "s"} pulled · total ${money(pullsTotal(pulls))}`, W - PAD, 86);
  g.textAlign = "left";
  const st = priceStats(s, valueBySet(pulls));
  if (st) {   // spent vs pulled, top right under the header (per set: each priced set's change)
    g.textAlign = "right"; g.font = "600 16px system-ui, sans-serif";
    g.fillStyle = st.diff >= 0 ? "#3ccf7a" : "#f05252";
    const line = st.mode === "total"
      ? `Spent ${money(st.cost)}${s.cost_label ? ` (${fitText(g, s.cost_label, 260)})` : ""} → ${signed(st.diff)} · ${pctText(st.pct)}`
      : `Spent ${money(st.cost)}: ` + st.sets.map((x) => `${x.code} ${pctText(x.pct)}`).join(" · ") + (st.sets.length > 1 ? ` · overall ${pctText(st.pct)}` : "");
    g.fillText(fitText(g, line, 720), W - PAD, 160);
    g.textAlign = "left";
  }
  g.fillStyle = "#9d9ca3"; g.font = '11px "Press Start 2P", monospace';
  g.fillText("HIGHEST-VALUE PULLS", PAD, 160);
  const x0 = (W - (top.length * CW + (top.length - 1) * GAP)) / 2, y0 = 184;
  top.forEach((p, i) => {
    const x = x0 + i * (CW + GAP);
    g.save();
    g.beginPath(); g.roundRect(x, y0, CW, CH, 10); g.clip();
    if (imgs[i]) g.drawImage(imgs[i], x, y0, CW, CH); else { g.fillStyle = "#26262a"; g.fillRect(x, y0, CW, CH); }
    g.restore();
    g.strokeStyle = i ? "#3d3d44" : "#ffcb05"; g.lineWidth = i ? 2 : 4;
    g.beginPath(); g.roundRect(x, y0, CW, CH, 10); g.stroke();
    g.fillStyle = i ? "#3d3d44" : "#ffcb05";
    g.beginPath(); g.roundRect(x - 8, y0 - 12, 50, 30, 8); g.fill();
    g.fillStyle = i ? "#ecebe6" : "#1b1b1d"; g.font = '12px "Press Start 2P", monospace';
    g.fillText(`#${i + 1}`, x + 1, y0 + 9);
    let y = y0 + CH + 30;
    g.fillStyle = "#ecebe6"; g.font = "600 17px system-ui, sans-serif";
    g.fillText(fitText(g, p.name, CW), x, y);
    g.fillStyle = "#9d9ca3"; g.font = "14px system-ui, sans-serif";
    g.fillText(fitText(g, `${p.set_name || p.set} #${p.number}`, CW), x, y += 22);
    g.fillText(fitText(g, p.rarity || "", CW), x, y += 20);
    g.fillStyle = "#ffcb05"; g.font = '16px "Press Start 2P", monospace';
    g.fillText(money(p.price), x, y += 34);
  });
  g.fillStyle = "#9d9ca3"; g.font = "13px system-ui, sans-serif";
  g.fillText(`Prices: TCGplayer market ${pulls.some((p) => p.price_at) ? "at last refresh" : "at time of scan"} · made with Alakadex`, PAD, H - 24);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

// ---- Set progress: how much of each set you've collected, counting every saved session
// (default) or only this one. Counted per card, not per printing.
const SETS_MODE_KEY = "alakadex.setsMode", SETS_SORT_KEY = "alakadex.setsSort";
const coll = { saved: {}, sets: null, mode: localStorageGet(SETS_MODE_KEY) === "session" ? "session" : "all", open: null, missingOnly: false };
$("sets-sort").value = ["recent", "release"].includes(localStorageGet(SETS_SORT_KEY)) ? localStorageGet(SETS_SORT_KEY) : "complete";
async function loadCollection() {   // the other sessions' cards; this session's come live from state.pulls
  const c = await api(`/api/collection?exclude=${session.id}`).catch(() => null);
  if (c && !c.error) coll.saved = c;
}
async function loadSets() {          // {code: {name, date, icon, total}}
  if (!coll.sets || !Object.keys(coll.sets).length) {
    const s = await api("/api/sets").catch(() => null);
    if (s && !s.error) coll.sets = s;
  }
  return coll.sets || {};
}
// {key: {n, last}} for the chosen mode, this session's live log included
function owned(mode = coll.mode) {
  const out = {};
  if (mode === "all") for (const [k, v] of Object.entries(coll.saved)) out[k] = { ...v };
  for (const p of state.pulls) {
    if (!p.key) continue;
    const c = out[p.key] || (out[p.key] = { n: 0, last: "" });
    c.n++;
    if ((p.at || "") > c.last) c.last = p.at;
  }
  return out;
}
const setOf = (key) => String(key).split("/")[0];
function progressBySet(own = owned()) {   // {set: {have: distinct cards, copies, last}}
  const by = {};
  for (const [k, v] of Object.entries(own)) {
    const s = by[setOf(k)] || (by[setOf(k)] = { have: 0, copies: 0, last: "" });
    s.have++; s.copies += v.n;
    if (v.last > s.last) s.last = v.last;
  }
  return by;
}
const pctOf = (have, total) => (total ? Math.round((have / total) * 100) : 0);

// result panel: "37 / 191 collected", and "New for this set" on a logged card's first copy
function showSetProgress(m, pull) {
  const el = $("r-progress"), info = coll.sets?.[m.set];
  if (!info?.total) { el.classList.add("hidden"); if (!coll.sets) loadSets(); return; }
  const own = owned(), have = Math.min((progressBySet(own)[m.set] || { have: 0 }).have, info.total);
  el.classList.remove("hidden"); el.dataset.set = m.set;
  $("r-prog-fill").style.width = (have / info.total) * 100 + "%";
  $("r-prog-text").textContent = `${have} / ${info.total} collected${coll.mode === "session" ? " this session" : ""}`;
  $("r-new").classList.toggle("hidden", !(pull && pull.id !== -1 && own[m.key]?.n === 1));
}
$("r-progress").onclick = () => openSets($("r-progress").dataset.set);

async function openSets(code) {
  if (code) coll.open = code;
  if (!$("sets").open) $("sets").showModal();
  await Promise.all([loadSets(), loadCollection(), flushSaves()]);
  renderSets();
}
$("btn-sets").onclick = () => openSets();
$("sets-close").onclick = () => $("sets").close();
$("sets-sort").onchange = () => { try { localStorage.setItem(SETS_SORT_KEY, $("sets-sort").value); } catch {} renderSets(); };
$("sets-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  coll.mode = b.dataset.mode;
  try { localStorage.setItem(SETS_MODE_KEY, coll.mode); } catch {}
  renderSets();
  if (state.current?.res?.match) showSetProgress(state.current.res.match, state.current.pull);
});
$("sets-list").addEventListener("click", (e) => {
  const r = e.target.closest(".set-row");
  if (r) { coll.open = r.dataset.code; renderSets(); }
});
function renderSets() {
  const sets = coll.sets || {}, by = progressBySet(), sort = $("sets-sort").value;
  document.querySelectorAll("#sets-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === coll.mode));
  const rows = Object.entries(by).filter(([c]) => sets[c]?.total)
    .map(([c, p]) => ({ code: c, ...sets[c], last: p.last, have: Math.min(p.have, sets[c].total) }));
  rows.sort(sort === "recent" ? (a, b) => b.last.localeCompare(a.last)
    : sort === "release" ? (a, b) => String(b.date || "").localeCompare(String(a.date || ""))
    : (a, b) => b.have / b.total - a.have / a.total || b.have - a.have);
  if (!sets[coll.open]) coll.open = rows[0]?.code || null;
  $("sets-list").innerHTML = rows.length ? rows.map((r) => `<button type="button" class="set-row${r.code === coll.open ? " on" : ""}" data-code="${esc(r.code)}">
      <span class="sr-top"><span class="sr-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="sr-count">${r.have}/${r.total}</span></span>
      <span class="mini-bar"><span style="width:${(r.have / r.total) * 100}%"></span></span>
      <span class="sr-meta">${LANG_SHORT[r.lang] ? `<span class="lang-pill">${LANG_SHORT[r.lang]}</span> ` : ""}${esc(r.code)}${r.date ? " · " + esc(fmtDay(r.date)) : ""} · ${pctOf(r.have, r.total)}%</span>
    </button>`).join("")
    : `<p class="muted">${coll.mode === "session" ? "Nothing logged this session yet." : "Cards you log show up here, set by set."}</p>`;
  renderSetDetail();
}
const LANG_SHORT = { ja: "JP", ko: "KR", "zh-tw": "繁中", "zh-cn": "简中" };   // non-English sets
const setCache = {};   // code -> checklist from /api/set
async function renderSetDetail() {
  const code = coll.open, box = $("set-detail");
  if (!code) { box.innerHTML = ""; return; }
  const set = setCache[code] || (setCache[code] = await api("/api/set?code=" + encodeURIComponent(code)));
  if (coll.open !== code) return;
  if (set.error || !set.cards) { delete setCache[code]; box.innerHTML = `<p class="muted">Couldn't load this set.</p>`; return; }
  const own = owned(), total = set.cards.length, have = set.cards.filter((c) => own[c.key]).length;
  const cards = coll.missingOnly ? set.cards.filter((c) => !own[c.key]) : set.cards;
  const scroll = box.querySelector(".sd-grid")?.scrollTop || 0;
  box.innerHTML = `<div class="sd-head">
      <div><div class="sd-name">${esc(set.name)}</div>
        <div class="muted sd-sub">${esc(code)} · ${set.date ? "Released " + esc(fmtDay(set.date)) : "Release date unknown"}</div></div>
      <label class="toggle"><input type="checkbox" id="sd-missing"${coll.missingOnly ? " checked" : ""}><span>Missing only</span></label>
    </div>
    <div class="sd-prog"><span class="mini-bar"><span style="width:${total ? (have / total) * 100 : 0}%"></span></span>
      <span>${have} / ${total} · ${pctOf(have, total)}%${have < total ? ` · ${total - have} missing` : " · complete"}</span></div>
    <div class="sd-grid">${cards.map((c) => {
      const o = own[c.key];
      return `<div class="sd-card${o ? " have" : ""}" title="${esc(c.name)}${c.name_local && c.name_local !== c.name ? " (" + esc(c.name_local) + ")" : ""} · #${esc(c.number)}${c.rarity ? " · " + esc(c.rarity) : ""} · ${money(c.usd)}${o ? ` · pulled ${o.n}×` : " · missing"}">
        <img loading="lazy" src="${esc(cardImg(c))}" alt="" onerror="this.onerror=null;this.src='${esc(c.img || "")}'">
        <span class="sd-num">${esc(c.number)}</span>${o && o.n > 1 ? `<span class="sd-dup">×${o.n}</span>` : ""}</div>`;
    }).join("") || `<p class="muted">You have every card in this set.</p>`}</div>`;
  box.querySelector(".sd-grid").scrollTop = scroll;
  $("sd-missing").onchange = (e) => { coll.missingOnly = e.target.checked; renderSetDetail(); };
}

// ---- Pause / resume scanning
function setPaused(on) {
  state.paused = on;
  $("btn-pause").textContent = on ? "RESUME  P" : "PAUSE  P";
  $("btn-pause").classList.toggle("on", on);
  $("btn-pause").title = on ? "Resume scanning (P)" : "Pause scanning: nothing is scanned or logged until you resume (P)";
  $("btn-scan").disabled = on;
  $("video-wrap").classList.toggle("paused", on);
  if (on) { state.quad = null; state.history = []; }
  updateHud();
}
$("btn-pause").onclick = () => setPaused(!state.paused);

// ---------------------------------------------------------------- Sensor (hover to identify)
// Like a "card sensor" for video: turn it on, rest the pointer on any card and it is
// outlined with its details shown beside it. Works on webcam and shared screens /
// tabs, with any number of cards in view, sideways or upside down.
//   F          freeze / resume the frame (fast pack openings, streams)
//   K          Scan frame: identify every card in view, price-tag each one, total them
//   click      pin the popup;  Esc unpins, then resumes
const HOVER_MS = 280;
let hoverTimer = null, hideTimer = null, freezeGen = 0;

// ---- options (the ⚙ menu next to the Sensor button)
const SENSOR_OPTS_KEY = "alakadex.sensorOpts";
const SENSOR_DEFAULTS = { outlines: true, highlight: true, tourney: true, pause: true, size: "m", hit: 20 };
const sensorOpts = Object.assign({ ...SENSOR_DEFAULTS },
  (() => { try { return JSON.parse(localStorage.getItem(SENSOR_OPTS_KEY)) || {}; } catch { return {}; } })());
// "Hit alert at $": shared by the Sensor options and Settings > Pull alerts
function setHitAlert(v) {
  sensorOpts.hit = Math.max(0, Number(v) || 0);
  try { localStorage.setItem(SENSOR_OPTS_KEY, JSON.stringify(sensorOpts)); } catch {}
  renderSensorOpts();
  if (document.activeElement !== $("s-hit")) $("s-hit").value = sensorOpts.hit;
}

function renderSensorOpts() {
  $("so-outlines").checked = sensorOpts.outlines;
  $("so-highlight").checked = sensorOpts.highlight;
  $("so-tourney").checked = sensorOpts.tourney;
  $("so-pause").checked = sensorOpts.pause;
  $("so-size").value = sensorOpts.size;
  $("so-hit").value = sensorOpts.hit;
  const pop = $("sensor-pop");
  pop.classList.remove("size-s", "size-m", "size-l");
  pop.classList.add("size-" + sensorOpts.size);
  // the LOOK UP switches under the camera show the same options
  document.querySelectorAll(".rocker[data-so]").forEach((b) => b.setAttribute("aria-pressed", String(!!sensorOpts[b.dataset.so])));
}
document.querySelectorAll(".rocker[data-so]").forEach((b) => (b.onclick = () => {
  const cb = $("so-" + b.dataset.so);
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
}));
$("sensor-opts").addEventListener("change", () => {
  Object.assign(sensorOpts, {
    outlines: $("so-outlines").checked, highlight: $("so-highlight").checked, tourney: $("so-tourney").checked,
    pause: $("so-pause").checked, size: $("so-size").value, hit: Math.max(0, Number($("so-hit").value) || 0),
  });
  try { localStorage.setItem(SENSOR_OPTS_KEY, JSON.stringify(sensorOpts)); } catch {}
  renderSensorOpts();
  if (state.tally) { for (const c of state.tally.cards) c.hit = isHit(c.price, c.rarity); renderTally(); }
  if (state.hit && !$("sensor-pop").classList.contains("hidden")) { $("sensor-pop").dataset.key = ""; showPop(state.hit); }
});
$("btn-sensor-opts").onclick = (e) => { e.stopPropagation(); $("sensor-opts").classList.toggle("hidden"); };
document.addEventListener("click", (e) => {
  if (!e.target.closest("#sensor-opts, #btn-sensor-opts")) $("sensor-opts").classList.add("hidden");
});

// a "hit": worth at least the alert price, or a top-tier rarity (SIR, hyper / gold, ...) unless
// Settings > Pull alerts turns rarity hits off
const priceOf = (m, d) => (d && d.market_price != null ? d.market_price : m.usd ?? null);
const priceHit = (price) => price != null && sensorOpts.hit > 0 && price >= sensorOpts.hit;
const isHit = (price, rarity) => priceHit(price) || (setting("hit_rarity", true) && rarityTier(rarity) === "t4");

// ---- on / off, freeze, pin
function setSensor(on) {
  state.sensor = on;
  $("btn-sensor").classList.toggle("on", on);
  $("sensor-bar").classList.toggle("sensing", on);
  $("video-wrap").classList.toggle("sensing", on);
  if (!on) { setPinned(false); setFrozen(false); hidePop(true, true); }
  updateHud();
}
$("btn-sensor").onclick = () => setSensor(!state.sensor);

function setFrozen(on) {
  if (on && (!state.stream || video.readyState < 2)) return;
  if (on === state.frozen && !on) return;
  freezeGen++;
  state.frozen = on; state.frozenScanned = false; state.autoFroze = false;
  state.known = [];               // identified cards on this still frame (hovering back is instant)
  if (on) {
    frozen.width = video.videoWidth; frozen.height = video.videoHeight;
    frozen.getContext("2d").drawImage(video, 0, 0);
    if (state.hit) state.known.push(state.hit);   // what was just under the pointer is on the still too
  } else {
    state.tally = null; renderTally();
    if (state.pinned) setPinned(false);
    hidePop(true, true);
  }
  frozen.classList.toggle("hidden", !on);
  $("btn-freeze").classList.toggle("on", on);
  $("btn-freeze").textContent = on ? "▶ Resume" : "❚❚ Freeze";
  updateHud();
}
$("btn-freeze").onclick = () => setFrozen(!state.frozen);

function setPinned(on) {
  if (on === state.pinned) return;
  state.pinned = on;
  $("sensor-pop").classList.toggle("pinned", on);
  $("sp-pin").textContent = on ? "Pinned · click elsewhere or Esc to unpin" : "Click the card to pin";
  if (on && sensorOpts.pause && !state.frozen) { setFrozen(true); state.autoFroze = true; }
  else if (!on && state.autoFroze) setFrozen(false);
}

// ---- pointer
function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointerToVideo(e) {
  const r = videoRect(), b = overlay.getBoundingClientRect();
  const x = (e.clientX - b.left - r.x) / r.w, y = (e.clientY - b.top - r.y) / r.h;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

const knownAt = (p) => (state.frozen ? (state.known || []).find((h) => pointInQuad(p, h.quad)) : null);

overlay.addEventListener("mousemove", (e) => {
  if (!state.sensor || !state.stream || state.pinned) return;
  const p = pointerToVideo(e);
  const moved = !state.pointer || !p || Math.hypot(p.x - state.pointer.x, p.y - state.pointer.y) > 0.006;
  state.pointer = p;
  if (!p) return;
  const known = knownAt(p);
  if (known) { clearTimeout(hideTimer); clearTimeout(hoverTimer); state.hit = known; showPop(known); return; }
  if (state.hit && pointInQuad(p, state.hit.quad)) { clearTimeout(hideTimer); showPop(state.hit); }
  else if (state.hit) { clearTimeout(hideTimer); hideTimer = setTimeout(() => hidePop(), 350); }
  if (moved) { clearTimeout(hoverTimer); hoverTimer = setTimeout(sensorLookup, HOVER_MS); }
});
overlay.addEventListener("mouseleave", (e) => {
  if (state.pinned) return;
  if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#sensor-pop, #tally")) return;
  clearTimeout(hoverTimer); state.pointer = null;
  hideTimer = setTimeout(() => hidePop(), 350);
});
overlay.addEventListener("click", (e) => {
  if (!state.sensor || !state.stream) return;
  const p = pointerToVideo(e);
  const onCard = p && state.hit && pointInQuad(p, state.hit.quad) && !$("sensor-pop").classList.contains("hidden");
  if (state.pinned) { setPinned(false); if (!onCard) hidePop(); }
  else if (onCard) setPinned(true);
});
$("sensor-pop").addEventListener("mouseenter", () => clearTimeout(hideTimer));
$("sensor-pop").addEventListener("mouseleave", () => { if (!state.pinned) hideTimer = setTimeout(() => hidePop(), 350); });

async function sensorLookup() {
  const p = state.pointer;
  if (!state.sensor || !p || video.readyState < 2 || state.pinned) return;
  if (knownAt(p)) return;
  // still on the card we just identified? keep showing it (cards in a live feed move,
  // so a cached hit is only trusted for a moment)
  if (state.hit && pointInQuad(p, state.hit.quad) && performance.now() - state.hit.t < 2500) return showPop(state.hit);
  const seq = ++state.sensorSeq, gen = freezeGen;
  state.sensorBusy = true; updateHud();
  grab.width = video.videoWidth; grab.height = video.videoHeight;
  gctx.drawImage(frameSource(), 0, 0);
  const res = await api("/api/locate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: grab.toDataURL("image/jpeg", 0.92), x: p.x, y: p.y, details: true }),
  });
  if (seq !== state.sensorSeq) return;          // pointer moved on; a newer lookup owns the UI
  state.sensorBusy = false; updateHud();
  if (gen !== freezeGen || state.pinned) return; // froze / resumed / pinned meanwhile
  if (!res.ok) {
    if (res.quad == null) $("hud").textContent = "Sensor: no card under the pointer";
    return;
  }
  state.hit = { quad: res.quad, res, t: performance.now() };
  if (state.frozen) state.known.push(state.hit);
  if (state.pointer && pointInQuad(state.pointer, res.quad)) showPop(state.hit);
}

// ---- popup
function showPop(hit) {
  const { res } = hit, m = res.match, d = res.details || {};
  const pop = $("sensor-pop");
  const price = priceOf(m, d), rar = d.rarity || m.rarity || "—", hitCard = isHit(price, rar);
  if (pop.dataset.key !== m.key || pop.classList.contains("hidden")) {
    pop.dataset.key = m.key;
    $("sp-img").src = m.img_large || m.img || "";
    $("sp-name").textContent = m.name;
    $("sp-set").textContent = `${m.set_name || m.set} (${m.set}) · #${m.number}`;
    $("sp-set-icon").src = m.set_icon || "";
    $("sp-date").textContent = m.set_date ? "Released " + fmtDay(m.set_date) : "";
    $("sp-rarity").textContent = rar; $("sp-rarity").className = "rarity " + rarityTier(rar);
    $("sp-price").textContent = money(price);
    $("sp-hit").classList.toggle("hidden", !hitCard);
    pop.classList.toggle("hit", hitCard);
    // per printing: a Reverse Holo of a common can be worth far more than the Normal
    const tp = d.tcgplayer || {}, lim = d.limitless || {};
    const pr = (tp.printings || []).filter((x) => x.market != null);
    $("sp-printings").innerHTML = pr.length > 1 ? pr.map((x) => `${esc(x.printing)} <b>${money(x.market)}</b>`).join(" · ") : "";
    const legal = Object.entries(lim.legality || {}).filter(([f]) => /^(standard|expanded)$/i.test(f.trim()));
    $("sp-legal").innerHTML = (lim.regulation_mark ? `<span>Reg. ${esc(lim.regulation_mark)}</span>` : "") +
      legal.map(([f, ok]) => `<span class="${ok ? "yes" : ""}">${esc(f)} ${ok ? "✓" : "✗"}</span>`).join("");
    const t = lim.tournaments;
    $("sp-tourney").textContent = !sensorOpts.tourney || !t ? "" :
      t.count ? `In ${t.count.toLocaleString()} tournament decklist${t.count === 1 ? "" : "s"}` : "No tournament decklists";
    $("sp-tcgp").href = tp.url || (lim.tcgplayer_id ? `https://www.tcgplayer.com/product/${lim.tcgplayer_id}`
      : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(m.name)}`);
    const note = $("sp-note");
    const alt = (res.candidates || []).filter((c) => c.key !== m.key).slice(0, 2).map((c) => `${c.name} ${c.set} ${c.number}`).join(", ");
    if (res.low_confidence) { note.className = "sp-note warn"; note.textContent = "Unsure — best guess." + (alt ? ` Also possible: ${alt}` : ""); }
    else if (res.print_ambiguous) { note.className = "sp-note warn"; note.textContent = "Same art exists in other sets — check the set symbol."; }
    else { note.className = "sp-note"; note.textContent = res.upside_down ? "Read upside down" : ""; }
  }
  // place beside the card: right of it if there's room, otherwise left
  const wrap = $("video-wrap").getBoundingClientRect(), r = videoRect();
  const xs = hit.quad.map(([x]) => r.x + x * r.w), ys = hit.quad.map(([, y]) => r.y + y * r.h);
  pop.classList.remove("hidden");
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.max(...xs) + 12;
  if (left + pw > wrap.width - 6) left = Math.min(...xs) - pw - 12;
  if (left < 6) left = Math.max(6, Math.min(wrap.width - pw - 6, (Math.min(...xs) + Math.max(...xs)) / 2 - pw / 2));
  const top = Math.max(6, Math.min(wrap.height - ph - 6, (Math.min(...ys) + Math.max(...ys)) / 2 - ph / 2));
  pop.style.left = left + "px"; pop.style.top = top + "px";
  document.querySelectorAll(".tally-row").forEach((row) => row.classList.toggle("active", row.dataset.key === m.key));
}

function hidePop(forget, force) {
  if (state.pinned && !force) return;
  $("sensor-pop").classList.add("hidden");
  document.querySelectorAll(".tally-row.active").forEach((row) => row.classList.remove("active"));
  if (forget) state.hit = null;
}

function addHitToPulls(hit) {
  const { res } = hit, d = res.details || {}, t = d.limitless && d.limitless.tournaments;
  const pull = addPull(res.match, "sensor", res.confidence, false);
  updatePull(pull.id, null, null, null, { price: priceOf(res.match, d), rarity: d.rarity, decklists: t ? t.count : null });
}
$("sp-add").onclick = () => {
  if (!state.hit) return;
  addHitToPulls(state.hit);
  $("sp-add").textContent = "Added ✓";
  setTimeout(() => ($("sp-add").textContent = "+ Add to pulls"), 1200);
};
$("sp-more").onclick = () => {
  if (!state.hit) return;
  const { res } = state.hit;
  if (res.crop) $("crop").src = res.crop;
  showResult({ ...res, method: "local" }, { id: -1 });   // id -1: shown, not added to pulls
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
};

// ---- Scan frame: every card in view at once (a pack spread out, a binder page, a deck list)
async function scanFrame() {
  if (!state.stream || video.readyState < 2 || state.tallyBusy) return;
  if (!state.sensor) setSensor(true);
  if (state.pinned) setPinned(false);
  if (!state.frozen) setFrozen(true);       // freeze so the price tags stay on their cards
  state.tally = null; renderTally(); hidePop(true);
  const gen = freezeGen, btn = $("btn-scanframe");
  state.tallyBusy = true; btn.classList.add("busy"); btn.textContent = "▦ Scanning…";
  $("hud").textContent = "Identifying every card in the frame…";
  updateDex();
  grab.width = frozen.width; grab.height = frozen.height;
  gctx.drawImage(frozen, 0, 0);
  const res = await api("/api/frame", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: grab.toDataURL("image/jpeg", 0.92), details: true }),
  });
  state.tallyBusy = false; btn.classList.remove("busy"); btn.textContent = "▦ Scan frame";
  updateDex();
  if (gen !== freezeGen) return;            // resumed while scanning
  if (!res.ok) { $("hud").textContent = "Scan frame: " + (res.error || "failed"); return; }
  if (!res.cards.length) { $("hud").textContent = "Scan frame: no cards found — try a sharper or larger view"; return; }
  dexClick();
  const cards = res.cards.map((c) => {
    const price = priceOf(c.match, c.details), rarity = (c.details && c.details.rarity) || c.match.rarity;
    return { ...c, price, rarity, hit: isHit(price, rarity) };
  });
  state.tally = { cards, ms: res.ms };
  state.known = cards.map((c) => ({ quad: c.quad, t: performance.now(),
    res: { ok: true, match: c.match, details: c.details, confidence: c.confidence, low_confidence: c.low_confidence,
           print_ambiguous: c.print_ambiguous, candidates: c.candidates } }));
  renderTally(); updateHud();
}
$("btn-scanframe").onclick = scanFrame;

function renderTally() {
  const t = state.tally, box = $("tally");
  box.classList.toggle("hidden", !t);
  if (!t) return;
  const rows = t.cards.map((c, i) => ({ c, i })).sort((a, b) => (b.c.price ?? -1) - (a.c.price ?? -1));
  const total = t.cards.reduce((s, c) => s + (Number(c.price) || 0), 0), hits = t.cards.filter((c) => c.hit).length;
  $("tally-total").textContent = money(total);
  $("tally-meta").textContent = `${t.cards.length} card${t.cards.length === 1 ? "" : "s"}` + (hits ? ` · ${hits} hit${hits === 1 ? "" : "s"}` : "");
  $("tally-list").innerHTML = rows.map(({ c, i }) => `<div class="tally-row${c.hit ? " hit" : ""}${c.low_confidence ? " unsure" : ""}" data-i="${i}" data-key="${esc(c.match.key)}">
      <img src="${esc(c.match.img)}" alt=""><div><div class="nm">${esc(c.match.name)}</div>
      <div class="sub">${esc(c.match.set)} ${esc(c.match.number)} · <span class="rarity ${rarityTier(c.rarity)}">${esc(c.rarity || "—")}</span></div></div>
      <span class="pr">${money(c.price)}</span></div>`).join("");
}
$("tally-list").addEventListener("mouseover", (e) => {
  const row = e.target.closest(".tally-row");
  if (!row || state.pinned) return;
  clearTimeout(hideTimer);
  state.hit = state.known[Number(row.dataset.i)];
  showPop(state.hit);
});
$("tally-list").addEventListener("click", (e) => {
  const row = e.target.closest(".tally-row");
  if (!row) return;
  setPinned(false);
  state.hit = state.known[Number(row.dataset.i)];
  showPop(state.hit); setPinned(true);
});
$("tally").addEventListener("mouseleave", () => { if (!state.pinned) hideTimer = setTimeout(() => hidePop(), 350); });
$("tally-add").onclick = () => {
  if (!state.tally) return;
  state.known.slice(0, state.tally.cards.length).forEach(addHitToPulls);
  $("tally-add").textContent = "Added ✓";
  setTimeout(() => ($("tally-add").textContent = "+ Add all"), 1200);
};
$("tally-close").onclick = () => setFrozen(false);
$("tally").querySelector(".tally-head > div").onclick = () => $("tally").classList.toggle("collapsed");
renderSensorOpts();

// ---------------------------------------------------------------- the Pokédex shell
// The lens is a status light (off / live / reading / logged / hit / paused / frozen), the three
// lights are camera, reading and logged, the little green screen says what the scanner is doing.
// The buttons follow the mode: PULLS logs cards, LOOK UP is the Sensor (hover, freeze, scan frame).
function flashLens(kind, ms) {
  dex.flash = { kind, until: performance.now() + ms };
  clearTimeout(dex.flashTimer);
  dex.flashTimer = setTimeout(() => { dex.flash = null; updateDex(); }, ms + 20);
  updateDex();
}
const setCls = (el, cls) => { if (el.className !== cls) el.className = cls; };
const setTxt = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
const LENS_SAYS = { off: "camera off", live: "live", reading: "reading a card", logged: "card logged", hit: "hit!", paused: "paused", frozen: "frame frozen" };
const LANG_SHORT_LCD = { auto: "AUTO", en: "EN", ja: "JP", ko: "KR", "zh-tw": "TW" };
function updateDex() {
  const live = !!state.stream, look = state.sensor, screen = state.sourceKind === "screen";
  const reading = state.scanning || state.confirming || state.sensorBusy || state.tallyBusy;
  const flash = dex.flash && dex.flash.until > performance.now() ? dex.flash.kind : null;
  const lens = !live ? "off" : flash === "hit" ? "hit" : flash === "logged" ? "logged"
    : state.paused && !look ? "paused" : state.frozen ? "frozen" : reading ? "reading" : "live";
  setCls($("lens"), "lens s-" + lens);
  setAttr($("lens"), "aria-label", "Scanner status: " + LENS_SAYS[lens]);
  setCls($("led-cam"), "led led-r" + (live ? " on" : "") + (live && state.paused && !look ? " blink" : ""));
  setCls($("led-read"), "led led-y" + (live && (reading || flash === "hit") ? " on" : ""));
  setCls($("led-log"), "led led-g" + (flash ? " on" : ""));
  // little green screen
  let l1, l2, l3;
  if (!live) { l1 = "NO " + (dex.prefSrc === "screen" ? "SCREEN" : "CAMERA"); l2 = "PRESS ON/OFF"; l3 = look ? "MODE  LOOK UP" : "MODE  PULLS"; }
  else if (look) {
    l1 = "MODE   LOOK UP"; l2 = "SOURCE " + (screen ? "SCREEN" : "CAMERA");
    l3 = state.frozen ? "FRAME  FROZEN" : screen ? "AUTO-SCAN  OFF" : "AUTO-SCAN PAUSED";
  } else {
    l1 = "MODE     PULLS";
    l2 = state.paused ? "PAUSED" : state.pending ? "PICK THE CARD" : $("auto-scan").checked ? `AUTO-SCAN ${scanRate()}/S` : "AUTO-SCAN  OFF";
    l3 = "LANG " + (LANG_SHORT_LCD[$("card-lang").value] || "AUTO");
  }
  setTxt($("lcd-1"), l1); setTxt($("lcd-2"), l2); setTxt($("lcd-3"), l3);
  // mode and source switches, ON/OFF
  document.body.classList.toggle("lookup", look);
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", (b.dataset.mode === "lookup") === look));
  const src = live ? state.sourceKind : dex.prefSrc;
  document.querySelectorAll("#source button").forEach((b) => { b.classList.toggle("on", b.dataset.src === src); setAttr(b, "aria-pressed", String(b.dataset.src === src)); });
  $("camera-select").hidden = (live && screen) || !$("camera-select").options.length;
  $("btn-reshare").hidden = !(live && screen);
  $("btn-power").classList.toggle("on", live);
  setAttr($("btn-power"), "aria-label", live ? (screen ? "Stop sharing the screen" : "Stop the camera") : dex.prefSrc === "screen" ? "Share a screen" : "Start the camera");
  // the hardware buttons: PULLS = SCAN / PAUSE / SENSOR, LOOK UP = SCAN FRAME / FREEZE / SENSOR ON
  setTxt($("scan-label"), look ? "SCAN\nFRAME" : "SCAN");
  $("scan-label").style.whiteSpace = "pre";
  setTxt($("scan-key"), look ? "K" : "SPACE");
  $("btn-scan").title = look ? "Identify every card in view and total their value (K)" : "Scan now (Space)";
  $("btn-scan").disabled = !look && state.paused;
  $("btn-pause").hidden = look;
  $("btn-hw-freeze").hidden = !look;
  setTxt($("btn-hw-freeze"), state.frozen ? "FROZEN  F" : "FREEZE  F");
  setCls($("btn-hw-freeze"), "pill-btn " + (state.frozen ? "ice" : "red"));
  setTxt($("btn-hw-sensor"), look ? "SENSOR ON" : "SENSOR");
  setCls($("btn-hw-sensor"), "pill-btn " + (look ? "on" : "blue"));
  $("btn-hw-sensor").title = look ? "Back to logging pulls (Alt+Shift+L)" : "Look up cards without logging them (Alt+Shift+L)";
  $("frozen-tag").classList.toggle("hidden", !state.frozen);
  $("video-wrap").classList.toggle("frozen-view", state.frozen);
  renderWhite();
}
// the two white buttons: +1 COPY / UNDO for the card just logged, LOG IT / SKIP while a
// low-confidence read waits for a pick
const currentPull = () => { const p = state.current?.pull; return p && p.id !== -1 && state.pulls.includes(p) ? p : null; };
function renderWhite() {
  const w1 = $("btn-w1"), w2 = $("btn-w2");
  if (state.pending) {
    setTxt(w1, "LOG IT"); setCls(w1, "wbtn gold"); w1.disabled = false; w1.title = "Log the card you picked (Enter)";
    setTxt(w2, "SKIP"); w2.disabled = false; w2.title = "Log nothing for this card";
    return;
  }
  const p = currentPull();
  setTxt(w1, "+1 COPY"); setCls(w1, "wbtn"); w1.disabled = !p;
  w1.title = p ? `Count another ${p.name} (same as Space)` : "Count another copy of the card you just logged";
  setTxt(w2, "UNDO"); w2.disabled = !p;
  w2.title = p ? `Take No.${pullNo(p)} ${p.name} back out of the log` : "Take the card you just logged back out of the log";
}
function selectPending(i) {
  const items = [...$("confirm-cands").querySelectorAll(".cand")];
  if (!items.length) return;
  dex.pendSel = (i + items.length) % items.length;
  items.forEach((el, j) => el.classList.toggle("sel", j === dex.pendSel));
  scrollIntoStrip(items[dex.pendSel]);
}
// bring a card into view inside its sideways-scrolling strip (without moving the page)
function scrollIntoStrip(el) {
  const box = el.parentNode, r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.left < b.left) box.scrollLeft -= b.left - r.left + 4;
  else if (r.right > b.right) box.scrollLeft += r.right - b.right + 4;
}
function logPending() {
  const el = $("confirm-cands").querySelectorAll(".cand")[dex.pendSel];
  if (state.pending && el) confirmPick(el.dataset.key);
}
// take a pull back out of the log (UNDO, or "Not a card" in the Wrong card window)
function removeCurrentPull() {
  const p = currentPull();
  if (!p) return;
  const no = pullNo(p);
  state.pulls = state.pulls.filter((x) => x !== p);
  savePulls(); renderPulls();
  state.current.pull = null;
  if (state.lastLog?.pull === p) state.lastLog = null;
  $("r-method").textContent = `No.${no} taken out of the log`;
  renderStrip(null);
  toast(`Took No.${no} ${p.name} out of the log`);
  updateDex();
}
$("btn-w1").onclick = () => {
  if (state.pending) return logPending();
  const p = currentPull();
  if (!p) return;
  dexClick();
  const copy = addPull(state.current.res.match, "manual", null);
  updatePull(copy.id, null, null, null, { price: p.price, rarity: p.rarity, decklists: p.decklists });
  state.current.pull = copy;
  state.lastLog = { key: copy.key, at: performance.now(), pull: copy };
  flashLens("logged", 1400);
  $("r-method").textContent = `Another copy counted · No.${pullNo(copy)}`;
  renderStrip(copy, copy.price, copy.rarity);
  alertFor(copy, copy.price, copy.rarity);
  updateDex();
};
$("btn-w2").onclick = () => (state.pending ? $("confirm-none").click() : removeCurrentPull());

// PULLS | LOOK UP
$("mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (b) setSensor(b.dataset.mode === "lookup");
});
$("btn-hw-sensor").onclick = () => setSensor(!state.sensor);
$("btn-hw-freeze").onclick = () => setFrozen(!state.frozen);
$("auto-scan").addEventListener("change", updateDex);
$("card-lang").addEventListener("change", updateDex);

// D-pad: ◀ ▶ flip through the candidates (or the cards to pick from), ▲ ▼ scroll the dex entry
function dpad(dir) {
  if (dir === "up" || dir === "down") { $("result").scrollBy({ top: dir === "up" ? -160 : 160, behavior: "smooth" }); return; }
  const step = dir === "left" ? -1 : 1;
  if (state.pending) { selectPending(dex.pendSel + step); return; }
  const items = [...$("cands").querySelectorAll(".cand")];
  if (!items.length) return;
  const at = items.findIndex((el) => el.classList.contains("cursor"));
  const i = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items.forEach((el, j) => el.classList.toggle("cursor", j === i));
  items[i].focus({ preventScroll: true });
  scrollIntoStrip(items[i]);
}
for (const d of ["up", "down", "left", "right"]) $("dp-" + d).onclick = () => dpad(d);

// ---- WRONG CARD: put the right card in a logged pull's place, or take it out
function openWrong() {
  const p = currentPull(), res = state.current?.res;
  const mode = state.pending ? "pending" : p ? "fix" : "none";
  dex.wrongMode = mode;
  $("w-empty").classList.toggle("hidden", mode !== "none");
  $("w-main").classList.toggle("hidden", mode === "none");
  $("w-remove").classList.toggle("hidden", mode === "none");
  $("search").value = ""; $("search-results").innerHTML = "";
  if (mode === "none") $("w-strip").textContent = "FIX THE LAST SCAN";
  else {
    const m = res.match, no = p ? pullNo(p) : "";
    $("w-img").src = m.img || p?.img || "";
    $("w-k").textContent = mode === "pending" ? "Best guess · not logged yet" : `Logged as No.${no}`;
    $("w-name").textContent = m.name || m.key;
    $("w-name").classList.toggle("struck", mode === "fix");
    $("w-meta").textContent = [`${m.set_name || m.set} ${m.number}`, p?.rarity || m.rarity,
      res.confidence != null ? `read at ${Math.round(res.confidence * 100)}%` : "", p ? fmtTime(p.at) : ""].filter(Boolean).join(" · ");
    const alike = (res.candidates || []).filter((c) => c.key !== m.key).slice(0, 8);
    $("w-cands").innerHTML = alike.map(candHtml).join("") || `<span class="w-meta">No look-alikes for this read.</span>`;
    $("w-strip").textContent = mode === "pending" ? "WHICH CARD IS THIS?" : `FIX No.${no}`;
    $("w-note").textContent = mode === "pending" ? "▶ Click a card to log it."
      : `▶ Click a card to put it in No.${no}'s place. Price, set progress and the session total update.`;
    $("w-remove").textContent = mode === "pending" ? "NOT A CARD: SKIP" : `NOT A CARD: REMOVE No.${no}`;
  }
  if (!$("wrong").open) $("wrong").showModal();
  if (mode !== "none") setTimeout(() => $("search").focus(), 30);
}
$("btn-wrong").onclick = openWrong;
$("confirm-search").onclick = openWrong;
$("w-close").onclick = () => $("wrong").close();
$("w-remove").onclick = () => {
  if (dex.wrongMode === "pending") $("confirm-none").click();
  else if (dex.wrongMode === "fix") removeCurrentPull();
  $("wrong").close();
};
async function wrongPick(key) {
  if (dex.wrongMode === "pending") { $("wrong").close(); confirmPick(key); return; }
  const p = currentPull();
  if (dex.wrongMode !== "fix" || !p) return;
  const no = pullNo(p);
  await correctTo(key);
  $("wrong").close();
  toast(`No.${no} is now ${state.current.res.match.name} (${state.current.res.match.set} ${state.current.res.match.number})`);
}
$("wrong").addEventListener("click", (e) => { const c = e.target.closest(".cand"); if (c) wrongPick(c.dataset.key); });
$("wrong").addEventListener("keydown", (e) => {
  const c = e.target.closest?.(".cand");
  if (c && (e.code === "Enter" || e.code === "Space")) { e.preventDefault(); wrongPick(c.dataset.key); }
});

// ---------------------------------------------------------------- wiring
$("btn-scan").onclick = () => (state.sensor ? scanFrame() : scan(true));
$("guide-mode").onchange = () => {
  state.quad = null; state.history = [];
  try { localStorage.setItem("alakadex.useCardArea", $("guide-mode").checked ? "1" : "0"); } catch {}
  $("btn-reset-box").disabled = !$("guide-mode").checked;
  updateHud();
};
if (localStorageGet("alakadex.useCardArea") === "0") $("guide-mode").checked = false;   // on unless turned off
$("btn-reset-box").disabled = !$("guide-mode").checked;
if (localStorageGet("alakadex.autoScan") === "0") $("auto-scan").checked = false;   // on unless turned off
$("auto-scan").onchange = () => { try { localStorage.setItem("alakadex.autoScan", $("auto-scan").checked ? "1" : "0"); } catch {} };
try { if (localStorage.getItem("alakadex.showOutline") === "0") $("show-outline").checked = false; } catch {}
$("show-outline").onchange = () => { try { localStorage.setItem("alakadex.showOutline", $("show-outline").checked ? "1" : "0"); } catch {} };
$("btn-reset-box").onclick = () => { state.box = defaultBox(); saveBox(); state.quad = null; state.history = []; };
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (document.querySelector("dialog[open]")) return;   // keys belong to the open dialog
  if (e.altKey && e.shiftKey && e.code === "KeyL") { e.preventDefault(); if (state.stream) setSensor(!state.sensor); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Escape" && dismissAlerts()) return;
  if (e.code === "KeyK" && state.stream) { e.preventDefault(); scanFrame(); return; }
  if (e.code === "KeyF" && state.sensor) { e.preventDefault(); setFrozen(!state.frozen); return; }
  if (e.code === "Escape" && state.sensor) {
    if (state.pinned) { setPinned(false); hidePop(); } else if (state.frozen) setFrozen(false);
    return;
  }
  if (e.code === "KeyP" && !state.sensor) { e.preventDefault(); setPaused(!state.paused); return; }
  // a candidate picked with the D-pad / Tab: Enter chooses it
  const cand = e.target.closest?.(".cand");
  if (cand && e.code === "Enter") { e.preventDefault(); cand.click(); return; }
  if (e.code === "Enter" && state.pending && (e.target === document.body || e.target.closest?.("#result"))) { e.preventDefault(); logPending(); return; }
  if (e.code === "ArrowLeft" || e.code === "ArrowRight") { e.preventDefault(); dpad(e.code === "ArrowLeft" ? "left" : "right"); return; }
  if (e.code === "Space") { e.preventDefault(); scan(true); }
});

renderPulls();
showSessionCost();
updateDex();
Promise.all([migrateOldPulls().then(loadCollection), refreshStatus()]).then(refreshPricesOnOpen).catch(() => {});
loadSets();
setInterval(() => refreshStatus(), 60000);
requestAnimationFrame(drawOverlay);
detectLoop();
// The camera never starts by itself (privacy): only "Start camera" turns it on, and the desktop
// app asks for permission on every launch. A browser that remembered the permission still waits.
