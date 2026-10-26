// The scanner, off the page's main thread: card detector, identifier and language model
// (ONNX Runtime Web) and the fingerprint index. Mirrors the desktop's scan.py /
// card_detector.py / embed_identifier.py; card names, languages and prices are the page's
// job (shim.js), this only says where cards are and which index rows they match.
//
// Messages: {id, cmd, args} -> {id, result} | {id, error}; progress while loading:
// {type: "progress", file, loaded, total}.
import {
  CARD_W, CARD_H, HIRES_W, HIRES_H, resize, half, crop, warp, contourArea, pointIn, centre,
  orderCorners, sameQuad, signature,
} from "./imgops.mjs";
import { fetchCached } from "./store.mjs";

let ort = null;
const M = { det: null, detCpu: null, id: null, lang: null, langMeta: null, provider: "wasm" };
const IX = { keys: [], row: new Map(), nameId: null, scale: null, Q: null, dim: 512, n: 0 };
let ready = null;

const GOOD_ENOUGH = 0.95;       // scan.GOOD_ENOUGH
const WHOLE_CARD = 0.28;        // scan.WHOLE_CARD
const NAME_MARGIN = 0.267;      // identifier.MODEL_NAME_MARGIN
const PRINT_MARGIN = 0.03;      // identifier.MODEL_PRINT_MARGIN
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

// ---------------------------------------------------------------- loading
async function init({ version, ortVersion, sizes = {}, gpu }) {
  const progress = (file) => (loaded, total) => postMessage({ type: "progress", file, loaded, total });
  // the runtime is kept per ONNX Runtime version, so a card update doesn't download it again
  const get = (path, kind = "arrayBuffer") =>
    fetchCached(path, path.startsWith("ort/") ? ortVersion : version, progress(path), sizes[path]).then((r) => r[kind]());
  // WebGPU (much faster on phones that have it) needs ONNX Runtime's bigger JSEP build;
  // everything else gets the plain WebAssembly one
  const useGpu = gpu && "gpu" in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null));
  const flavour = useGpu ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs";
  const wasm = useGpu ? "ort-wasm-simd-threaded.jsep.wasm" : "ort-wasm-simd-threaded.wasm";
  ort = await import(`./ort/${flavour}`);
  ort.env.wasm.wasmBinary = await get(`ort/${wasm}`);
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.wasmPaths = new URL("./ort/", self.location.href).href;
  ort.env.logLevel = "error";
  const [det, id, lang, langMeta, embedMeta, Q] = await Promise.all([
    get("models/card_detector.onnx"), get("models/card_identifier.onnx"), get("models/card_language.onnx"),
    get("models/card_language.json", "json"), get("data/embed.json", "json"), get("data/embed.i8"),
  ]);
  const session = (b, ep) => ort.InferenceSession.create(new Uint8Array(b), { executionProviders: [ep], graphOptimizationLevel: "all" });
  // The identifier always runs on the CPU: on WebGPU its embeddings drift (cos 0.94 against the
  // CPU's on the same input, ORT 1.22), which would change answers. The detector and the
  // language model match the CPU there, and are checked again on this device before use.
  M.id = await session(id, "wasm");
  M.provider = "wasm";
  if (useGpu) {
    try {
      [M.det, M.lang] = await Promise.all([session(det, "webgpu"), session(lang, "webgpu")]);
      await gpuCheck(det, lang);
      M.provider = "webgpu";
    } catch (e) {
      M.gpuError = String(e && e.message || e);
      M.det = M.lang = null;
    }
  }
  if (!M.det) [M.det, M.lang] = await Promise.all([session(det, "wasm"), session(lang, "wasm")]);
  // the CPU detector for scan reads (see detect): the same session when there's no GPU
  M.detCpu = M.provider === "webgpu" ? await session(det, "wasm") : M.det;
  if (M.provider === "webgpu") M.langBytes = lang;   // kept to fall back to the CPU (languageProbs)
  M.langMeta = langMeta;
  IX.keys = embedMeta.keys;
  IX.row = new Map(IX.keys.map((k, i) => [k, i]));
  IX.nameId = Int32Array.from(embedMeta.name_id);
  IX.scale = Float32Array.from(embedMeta.scale);
  IX.dim = embedMeta.dim;
  IX.n = IX.keys.length;
  IX.Q = new Int8Array(Q);
  IX.s = new Float32Array(IX.n);
  return { cards: IX.n, provider: M.provider, gpuError: M.gpuError || null, threads: ort.env.wasm.numThreads,
           labels: langMeta.labels, built: embedMeta.built };
}

// The GPU sessions must give the CPU's answers on this device (a driver can get them wrong):
// the same made-up picture through both, at the input sizes scanning uses most, which also
// compiles the GPU's shaders now instead of on the first scan.
async function gpuCheck(det, lang) {
  const cpuDet = await ort.InferenceSession.create(new Uint8Array(det), { executionProviders: ["wasm"] });
  const cpuLang = await ort.InferenceSession.create(new Uint8Array(lang), { executionProviders: ["wasm"] });
  const pattern = (n, k) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (Math.sin(i * k) + 1) / 2; return x; };
  const worst = async (gpu, cpu, dims, k) => {
    const t = new ort.Tensor("float32", pattern(dims.reduce((a, b) => a * b), k), dims);
    const a = (await cpu.run({ [cpu.inputNames[0]]: t }))[cpu.outputNames[0]].data;
    const b = (await gpu.run({ [gpu.inputNames[0]]: t }))[gpu.outputNames[0]].data;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  const d1 = await worst(M.det, cpuDet, [1, 3, 640, 480], 0.0007);      // card area (portrait)
  const d2 = await worst(M.det, cpuDet, [1, 3, 480, 640], 0.0011);      // whole landscape frame
  const l = await worst(M.lang, cpuLang, [1, 3, 352, 252], 0.0013);
  cpuDet.release?.(); cpuLang.release?.();
  if (!(d1 < 0.02 && d2 < 0.02 && l < 0.02)) throw new Error(`GPU results differ from the CPU's (${d1.toFixed(4)}, ${d2.toFixed(4)}, ${l.toFixed(4)})`);
}

// One run at a time across ALL models: the live outline and a scan overlap, and ONNX Runtime's
// WebGPU build (loaded whenever WebGPU exists, even for its CPU sessions) keeps a single
// "running" slot for the whole module, so a second run of ANY session while one is busy fails
// with "Session already started" - a scan's identifier read during a live outline check never logged.
let queue = Promise.resolve();
function run(session, feeds) {
  const p = queue.then(() => session.run(feeds));
  queue = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- frames
async function decode(blob) {
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = g.getImageData(0, 0, cv.width, cv.height);
  return { w: d.width, h: d.height, c: 4, data: d.data };
}

async function jpeg(img, quality = 0.85) {
  const rgba = new Uint8ClampedArray(img.w * img.h * 4);
  for (let i = 0, j = 0; i < img.w * img.h; i++, j += img.c) {
    rgba[4 * i] = img.data[j]; rgba[4 * i + 1] = img.data[j + 1]; rgba[4 * i + 2] = img.data[j + 2]; rgba[4 * i + 3] = 255;
  }
  const cv = new OffscreenCanvas(img.w, img.h);
  cv.getContext("2d").putImageData(new ImageData(rgba, img.w, img.h), 0, 0);
  return cv.convertToBlob({ type: "image/jpeg", quality });
}

// ---------------------------------------------------------------- detector
const imgszFor = (img) => (Math.max(img.w, img.h) <= 960 ? 640 : 1280);   // scan.model_imgsz

function nms(boxes, scores, iou) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]), keep = [];
  const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
  for (const i of order) {
    const a = boxes[i];
    let ok = true;
    for (const j of keep) {
      const b = boxes[j];
      const iw = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
      const ih = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
      const inter = iw > 0 && ih > 0 ? iw * ih : 0;
      if (inter / (area(a) + area(b) - inter + 1e-9) > iou) { ok = false; break; }
    }
    if (ok) keep.push(i);
  }
  return keep;
}

// every card in `img`, best first: [{quad (card order tl,tr,br,bl), score, box}]
async function detect(img, imgsz = 640, conf = 0.35, maxDet = 60, iou = 0.6) {
  const s = imgsz / Math.max(img.w, img.h);
  const nw = Math.max(32, Math.round(img.w * s)), nh = Math.max(32, Math.round(img.h * s));
  const small = resize(img, nw, nh, s < 1 ? "a" : "l");
  const pw = Math.ceil(nw / 32) * 32, ph = Math.ceil(nh / 32) * 32;   // model stride
  const x = new Float32Array(3 * ph * pw).fill(114 / 255);
  for (let y = 0; y < nh; y++) {
    for (let xx = 0; xx < nw; xx++) {
      const p = (y * nw + xx) * 3, o = y * pw + xx;
      x[o] = small.data[p] / 255; x[ph * pw + o] = small.data[p + 1] / 255; x[2 * ph * pw + o] = small.data[p + 2] / 255;
    }
  }
  // The GPU only finds cards at the live outline's size (640), the size gpuCheck verified. A
  // scan read's 1280 run goes to the CPU: phone GPUs have far smaller buffer limits than a
  // PC's, and there the big run failed or found nothing while the live outline kept working -
  // "Card found", then every read of the scan failed and nothing was logged.
  const det = imgsz <= 640 ? M.det : M.detCpu;
  const feeds = { [det.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, ph, pw]) };
  let out;
  try {
    out = await run(det, feeds);
  } catch (e) {
    if (det === M.detCpu) throw e;
    M.det = M.detCpu;              // the GPU failed on this device: the CPU from now on
    M.gpuError = String(e && e.message || e);
    out = await run(M.det, feeds);
  }
  const t = out[det.outputNames[0]], A = t.dims[2], o = t.data;
  const boxes = [], scores = [], idx = [];
  for (let a = 0; a < A; a++) {
    const sc = o[4 * A + a];
    if (sc <= conf) continue;
    const cx = o[a], cy = o[A + a], bw = o[2 * A + a], bh = o[3 * A + a];
    boxes.push([cx - bw / 2, cy - bh / 2, bw, bh]); scores.push(sc); idx.push(a);
  }
  const found = nms(boxes, scores, iou).slice(0, maxDet).map((i) => {
    const a = idx[i], quad = [];
    for (let k = 0; k < 4; k++) quad.push([o[(5 + 3 * k) * A + a] / s, o[(6 + 3 * k) * A + a] / s]);
    const [x0, y0, w, h] = boxes[i].map((v) => v / s);
    return { quad, score: scores[i], box: [x0, y0, x0 + w, y0 + h] };
  });
  found.sort((a, b) => b.score - a.score);
  return found;
}

const modelCards = async (img, maxCards = 40, imgsz = null, conf = 0.35) =>
  (await detect(img, imgsz || imgszFor(img), conf, maxCards)).map((d) => [d.quad, d.score]);

// the card auto-scan should read: the biggest confident one
function mainCard(cards) {
  if (!cards.length) return null;
  return cards.reduce((b, c) => (contourArea(c[0]) * Math.min(1, c[1] / 0.5) > contourArea(b[0]) * Math.min(1, b[1] / 0.5) ? c : b));
}

const boxQuad = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// whole-card outlines inside the card area (scan.card_in_box)
async function cardInBox(img, box, limit = 2, free = false) {
  const bq = boxQuad(box), area = (box[2] - box[0]) * (box[3] - box[1]);
  const frac = free ? 0.04 : WHOLE_CARD;
  const hits = (await modelCards(img, 8, 640)).map(([q]) => q)
    .filter((q) => pointIn(bq, centre(q)) && contourArea(q) > frac * area);
  hits.sort((a, b) => contourArea(b) - contourArea(a));
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------- identifier
function chw(img, out, offset) {
  // RGB uint8 -> (x / 255 - mean) / std, one plane per channel
  const n = img.w * img.h;
  for (let ch = 0; ch < 3; ch++) {
    const sc = 1 / (255 * STD[ch]), bias = -MEAN[ch] / STD[ch], base = offset + ch * n;
    for (let i = 0; i < n; i++) out[base + i] = img.data[3 * i + ch] * sc + bias;
  }
}

// nearest index rows to the card, upright and turned 180 degrees (embed_identifier.search)
const ID_W = 224, ID_H = 312;   // card_identifier.onnx input
async function search(hires, top = 8) {
  return rank(await embed(hires), top);
}
// embeddings of the card upright and turned 180 degrees (2 x 512)
async function embed(hires) {
  const w = ID_W, h = ID_H;
  const small = resize(hires, w, h, "a");
  const n = 3 * w * h, x = new Float32Array(2 * n);
  chw(small, x, 0);
  for (let ch = 0; ch < 3; ch++) {               // the turned copy: the tensor reversed in both axes
    const a = ch * w * h, b = n + a;
    for (let i = 0; i < w * h; i++) x[b + i] = x[a + w * h - 1 - i];
  }
  const out = await run(M.id, { [M.id.inputNames[0]]: new ort.Tensor("float32", x, [2, 3, h, w]) });
  return out[M.id.outputNames[0]].data;
}
function rank(e, top = 8) {
  const D = IX.dim;
  const q0 = e.subarray(0, D), q1 = e.subarray(D, 2 * D);
  const { Q, scale, nameId, s } = IX, N = IX.n;
  let max0 = -Infinity, max1 = -Infinity, arg1 = -1, best = -1;
  for (let i = 0, r = 0; i < N; i++, r += D) {
    let a = 0, b = 0;
    for (let k = 0; k < D; k += 4) {
      const v0 = Q[r + k], v1 = Q[r + k + 1], v2 = Q[r + k + 2], v3 = Q[r + k + 3];
      a += v0 * q0[k] + v1 * q0[k + 1] + v2 * q0[k + 2] + v3 * q0[k + 3];
      b += v0 * q1[k] + v1 * q1[k + 1] + v2 * q1[k + 2] + v3 * q1[k + 3];
    }
    a *= scale[i]; b *= scale[i];
    if (a > max0) max0 = a;
    if (b > max1) { max1 = b; arg1 = i; }
    s[i] = a > b ? a : b;
    if (best < 0 || s[i] > s[best]) best = i;
  }
  const flip = arg1 === best && max1 > max0;
  // top rows by score
  const order = [];
  for (let i = 0; i < N; i++) {
    if (order.length < top || s[i] > s[order[order.length - 1]]) {
      let j = order.length < top ? order.length : top - 1;
      order[j] = i;
      while (j > 0 && s[order[j]] > s[order[j - 1]]) { [order[j], order[j - 1]] = [order[j - 1], order[j]]; j--; }
    }
  }
  const nb = nameId[best];
  let otherName = -Infinity, otherPrint = -1, sameCount = 0;
  for (let i = 0; i < N; i++) {
    if (nameId[i] !== nb) { if (s[i] > otherName) otherName = s[i]; }
    else { sameCount++; if (i !== best && s[i] > otherPrint) otherPrint = s[i]; }
  }
  if (sameCount <= 1) otherPrint = -1;
  return { order, sims: order.map((i) => s[i]), keys: order.map((i) => IX.keys[i]),
           same: order.map((i) => nameId[i] === nb), flip,
           nameMargin: s[best] - otherName, printMargin: s[best] - otherPrint };
}

// identifier._identify_model: the art match and how sure it is
function confidenceOf(r) {
  let conf = Math.max(0, Math.min(1, r.nameMargin / NAME_MARGIN));
  const printAmbiguous = r.printMargin < PRINT_MARGIN;
  if (printAmbiguous) conf *= Math.max(0.5, Math.min(1, 0.5 + r.printMargin / PRINT_MARGIN / 2));
  return { conf, printAmbiguous, verified: r.nameMargin >= NAME_MARGIN / 2 };
}

async function identifyQuad(img, quad) {
  const t0 = performance.now();
  const hires = warp(img, quad, HIRES_W, HIRES_H);
  const r = await search(hires);
  const c = confidenceOf(r);
  return { quad, hires, res: { ...r, confidence: Math.round(c.conf * 1000) / 1000, printAmbiguous: c.printAmbiguous,
                                verified: c.verified, ms: Math.round(performance.now() - t0) } };
}

// scan._best_art: each outline in turn, the most confident kept; stop once one reaches the
// threshold (GOOD_ENOUGH without one)
async function bestArt(img, quads, threshold) {
  let best = null;
  const tried = [];
  for (const q of quads) {
    if (sameQuad(q, tried)) continue;
    tried.push(q);
    const r = await identifyQuad(img, q);
    if (!best || r.res.confidence > best.res.confidence) best = r;
    if (r.res.confidence >= (threshold ?? GOOD_ENOUGH)) break;
  }
  return best;
}

// identifier.LanguageModel.probs on the winner's high-resolution warp
async function languageProbs(hires) {
  const { w, h } = { w: M.langMeta.size[0], h: M.langMeta.size[1] };
  const small = hires.w === 2 * w && hires.h === 2 * h ? half(hires) : resize(hires, w, h, "a");
  const x = new Float32Array(3 * w * h);
  chw(small, x, 0);
  const feeds = { [M.lang.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, h, w]) };
  let out;
  try {
    out = await run(M.lang, feeds);
  } catch (e) {
    if (M.provider !== "webgpu" || M.lang.__cpu) throw e;
    M.lang = await ort.InferenceSession.create(new Uint8Array(M.langBytes), { executionProviders: ["wasm"] });   // GPU failed: CPU from now on
    M.lang.__cpu = true;
    M.gpuError = String(e && e.message || e);
    out = await run(M.lang, feeds);
  }
  const z = Array.from(out[M.lang.outputNames[0]].data), mx = Math.max(...z);
  const p = z.map((v) => Math.exp(v - mx)), sum = p.reduce((a, b) => a + b, 0);
  return Object.fromEntries(M.langMeta.labels.map((l, i) => [l, p[i] / sum]));
}

// what every identify-type command returns for its winning outline (normalised to `norm`)
async function finish(img, won, { lang, crop: wantCrop = true, sig = false } = {}) {
  if (!won) return null;
  const out = { quad: won.quad, res: won.res };
  if (lang) out.langProbs = await languageProbs(won.hires);
  if (wantCrop) out.crop = await jpeg(warp(img, won.quad), 0.85);
  if (sig) out.sig = signature(warp(img, won.quad, 64, 88));
  return out;
}

// scan.identify_at: the card under `point` (image pixels), or the main card in view
async function identifyAt(img, point, threshold, cards = null) {
  cards = cards || await modelCards(img);
  let first = [];
  if (!point) { const m = mainCard(cards); first = m ? [m[0]] : []; }
  else first = cards.filter(([q]) => pointIn(q, point)).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([q]) => q);
  return bestArt(img, first, threshold);
}

// ---------------------------------------------------------------- commands (shim.js /api)
const norm = (q, w, h) => q.map(([x, y]) => [Math.round((x / w) * 1e4) / 1e4, Math.round((y / h) * 1e4) / 1e4]);

const commands = {
  init,

  // /api/detect: the live outline (card area crop, or the whole frame)
  async detect({ blob, box, free }) {
    const img = await decode(blob);
    if (box) {
      const b = [box[0] * img.w, box[1] * img.h, box[2] * img.w, box[3] * img.h];
      const [quad] = await cardInBox(img, b, 1, free);
      const sig = signature(warp(img, quad || boxQuad(b), 64, 88));
      return { quad: quad ? norm(orderCorners(quad), img.w, img.h) : null, sig };
    }
    const cards = await modelCards(img, 12);
    if (!cards.length) return { quad: null, quads: [] };
    const [quad, score] = mainCard(cards);
    return { quad: norm(orderCorners(quad), img.w, img.h), quads: cards.map(([q]) => norm(orderCorners(q), img.w, img.h)),
             score: Math.round(score * 1000) / 1000, sig: signature(warp(img, quad, 64, 88)) };
  },

  // /api/identify: Scan / auto-scan (card area, the preview's outline, or the main card)
  async identify({ blob, opts, threshold, lang }) {
    const img = await decode(blob);
    let won = null;
    if (opts.box) {
      // scan.identify_in_box: detected whole-card outlines in the box, else the box itself
      const b = [opts.box[0] * img.w, opts.box[1] * img.h, opts.box[2] * img.w, opts.box[3] * img.h];
      const quads = await cardInBox(img, b, 2, !!opts.free);
      if (!opts.free) quads.push(orderCorners(boxQuad(b)));
      won = await bestArt(img, quads, threshold);
    } else if (opts.quad) {
      // scan.identify_near: the region around the preview's outline at 640 px
      const hint = opts.quad.map(([x, y]) => [x * img.w, y * img.h]);
      const xs = hint.map((p) => p[0]), ys = hint.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const mx = 0.3 * (x1 - x0), my = 0.3 * (y1 - y0);
      const rx0 = Math.max(0, Math.floor(x0 - mx)), ry0 = Math.max(0, Math.floor(y0 - my));
      const rx1 = Math.min(img.w, Math.floor(x1 + mx)), ry1 = Math.min(img.h, Math.floor(y1 + my));
      if (rx1 - rx0 >= 32 && ry1 - ry0 >= 32) {
        const roi = crop(img, rx0, ry0, rx1, ry1);
        const cards = await modelCards(roi, 8, 640);
        if (cards.length) {
          const c = centre(hint);
          const w = await identifyAt(roi, [c[0] - rx0, c[1] - ry0], threshold, cards);
          if (w) won = { ...w, quad: w.quad.map(([x, y]) => [x + rx0, y + ry0]) };
        }
      }
      if (!won) won = (await identifyAt(img, centre(hint), threshold)) || (await identifyAt(img, null, threshold));
    } else won = await identifyAt(img, null, threshold);
    if (!won) return { found: false };
    return { found: true, w: img.w, h: img.h, ...(await finish(img, won, { lang, sig: true })) };
  },

  // /api/locate: the Sensor - the card under the pointer
  async locate({ blob, x, y, threshold, lang }) {
    const img = await decode(blob);
    const won = await identifyAt(img, [x * img.w, y * img.h], threshold);
    if (!won) return { found: false };
    return { found: true, w: img.w, h: img.h, ...(await finish(img, won, { lang })) };
  },

  // /api/frame: every card in the frame (Scan frame)
  async frame({ blob, maxCards, conf, lang }) {
    const img = await decode(blob);
    const cards = await modelCards(img, maxCards, null, conf);
    const found = [];
    for (const [q] of cards) {
      const won = await identifyQuad(img, q);
      const r = await finish(img, won, { lang, crop: false });
      found.push(r);
    }
    return { w: img.w, h: img.h, found };
  },

  // cosine similarity of index rows (identifier._same_art_printings)
  sims({ key, others }) {
    const i = IX.row.get(key);
    if (i == null) return {};
    const D = IX.dim, out = {};
    for (const k of others) {
      const j = IX.row.get(k);
      if (j == null) continue;
      let s = 0;
      for (let d = 0; d < D; d++) s += IX.Q[i * D + d] * IX.Q[j * D + d];
      out[k] = s * IX.scale[i] * IX.scale[j];
    }
    return out;
  },

  // parity tests (web/tests): the identifier on an already-warped high-resolution card
  async testSearch({ blob }) {
    const img = await decode(blob);
    const hires = img.w === HIRES_W && img.h === HIRES_H ? img : resize(img, HIRES_W, HIRES_H);
    const r = await search(hires);
    return { ...r, ...confidenceOf(r), langProbs: await languageProbs(hires) };
  },
  async testWarp({ blob, quad, size }) {
    const img = await decode(blob);
    const t0 = performance.now();
    const w = warp(img, quad, size[0], size[1]);
    return { ms: performance.now() - t0, png: await jpeg(w, 1) , data: w.data };
  },
  async testDetect({ blob, imgsz, conf }) {
    const img = await decode(blob);
    const t0 = performance.now();
    const d = await detect(img, imgsz || imgszFor(img), conf ?? 0.35);
    return { ms: performance.now() - t0, found: d, w: img.w, h: img.h };
  },
  async testTiming({ blob }) {
    const img = await decode(blob);
    const t = {};
    let t0 = performance.now();
    const cards = await modelCards(img, 8, 640); t.detect640 = performance.now() - t0;
    if (!cards.length) return t;
    t0 = performance.now(); const hires = warp(img, cards[0][0], HIRES_W, HIRES_H); t.warp = performance.now() - t0;
    t0 = performance.now(); const e = await embed(hires); t.embed = performance.now() - t0;
    t0 = performance.now(); rank(e); t.rank = performance.now() - t0;
    t0 = performance.now(); await languageProbs(hires); t.lang = performance.now() - t0;
    return t;
  },
};

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    if (cmd !== "init") await ready;
    const p = commands[cmd](args || {});
    if (cmd === "init") ready = p;
    const result = await p;
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });
  }
};
