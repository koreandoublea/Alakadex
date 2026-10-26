// Image operations the scanner needs, in plain JS so the browser computes what the desktop's
// OpenCV calls compute (alakadex/detector.py warp, cv2.resize INTER_AREA / INTER_LINEAR,
// features.card_signature). The identifier was trained on those exact operations, so they're
// reproduced rather than approximated with canvas drawImage.
//
// An image is {w, h, c, data}: c = 4 (RGBA, as decoded) or 3 (RGB), data a Uint8ClampedArray.

export const CARD_W = 252, CARD_H = 352;
export const HIRES_W = 2 * CARD_W, HIRES_H = 2 * CARD_H;

// ---------------------------------------------------------------- resize
// Per destination index along one axis: source indices and weights.
function areaTab(sn, dn) {
  // cv2 INTER_AREA when shrinking: every destination pixel averages the source pixels it
  // covers, partly covered ones by the covered fraction
  const scale = sn / dn, idx = [], wts = [];
  for (let d = 0; d < dn; d++) {
    const a = d * scale, b = Math.min(sn, (d + 1) * scale);
    const i = [], w = [];
    for (let s = Math.floor(a); s < Math.ceil(b - 1e-9); s++) {
      const cover = Math.min(b, s + 1) - Math.max(a, s);
      if (cover > 1e-9) { i.push(s); w.push(cover / scale); }
    }
    idx.push(i); wts.push(w);
  }
  return { idx, wts };
}
function linearTab(sn, dn) {
  // cv2 INTER_LINEAR: pixel centres aligned, edge pixels clamped
  const scale = sn / dn, idx = [], wts = [];
  for (let d = 0; d < dn; d++) {
    let f = (d + 0.5) * scale - 0.5, s = Math.floor(f);
    f -= s;
    if (s < 0) { s = 0; f = 0; }
    if (s >= sn - 1) { s = sn - 1; f = 0; }
    const s1 = Math.min(s + 1, sn - 1);
    idx.push(f ? [s, s1] : [s]); wts.push(f ? [1 - f, f] : [1]);
  }
  return { idx, wts };
}
const tabCache = new Map();
function tab(kind, sn, dn) {
  const k = `${kind}${sn}:${dn}`;
  let t = tabCache.get(k);
  if (!t) {
    t = kind === "a" ? areaTab(sn, dn) : linearTab(sn, dn);
    // flatten for speed: start offsets into flat index / weight arrays
    const start = new Int32Array(dn + 1);
    let n = 0;
    for (let d = 0; d < dn; d++) { start[d] = n; n += t.idx[d].length; }
    start[dn] = n;
    const fi = new Int32Array(n), fw = new Float32Array(n);
    for (let d = 0, j = 0; d < dn; d++) for (let q = 0; q < t.idx[d].length; q++, j++) { fi[j] = t.idx[d][q]; fw[j] = t.wts[d][q]; }
    t = { start, fi, fw };
    if (tabCache.size > 64) tabCache.clear();
    tabCache.set(k, t);
  }
  return t;
}

// Resize to dw x dh RGB. Shrinking averages areas (INTER_AREA), growing interpolates
// (INTER_LINEAR), per axis as cv2 does for a uniform scale.
let row = new Float32Array(0);
export function resize(img, dw, dh, kind) {
  const { w: sw, h: sh, c, data } = img;
  kind = kind || (dw <= sw && dh <= sh ? "a" : "l");
  if (kind === "a" && sw === 2 * dw && sh === 2 * dh) return half(img);
  const tx = tab(kind, sw, dw), ty = tab(kind, sh, dh);
  if (row.length < dw * 3) row = new Float32Array(dw * 3);
  const tmp = new Float32Array(sh * dw * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * c, out = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = tx.start[x]; j < tx.start[x + 1]; j++) {
        const p = row + tx.fi[j] * c, wt = tx.fw[j];
        r += data[p] * wt; g += data[p + 1] * wt; b += data[p + 2] * wt;
      }
      const o = out + x * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  const dst = new Uint8ClampedArray(dw * dh * 3), n = dw * 3;
  for (let y = 0; y < dh; y++) {
    row.fill(0, 0, n);
    for (let j = ty.start[y]; j < ty.start[y + 1]; j++) {
      const src = ty.fi[j] * n, wt = ty.fw[j];
      for (let k = 0; k < n; k++) row[k] += tmp[src + k] * wt;
    }
    dst.set(row.subarray(0, n), y * n);   // Uint8ClampedArray rounds and clamps
  }
  return { w: dw, h: dh, c: 3, data: dst };
}

// exact 2x shrink, as cv2's INTER_AREA fast path: (a + b + c + d + 2) >> 2
export function half(img) {
  const { w, h, c, data } = img, dw = w >> 1, dh = h >> 1;
  const dst = new Uint8ClampedArray(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const r0 = 2 * y * w * c, r1 = r0 + w * c;
    for (let x = 0; x < dw; x++) {
      const a = r0 + 2 * x * c, b = a + c, d = r1 + 2 * x * c, e = d + c, o = (y * dw + x) * 3;
      dst[o] = (data[a] + data[b] + data[d] + data[e] + 2) >> 2;
      dst[o + 1] = (data[a + 1] + data[b + 1] + data[d + 1] + data[e + 1] + 2) >> 2;
      dst[o + 2] = (data[a + 2] + data[b + 2] + data[d + 2] + data[e + 2] + 2) >> 2;
    }
  }
  return { w: dw, h: dh, c: 3, data: dst };
}

// crop a rectangle (integer pixels) - the region a scan looks at
export function crop(img, x0, y0, x1, y1) {
  const { w, c, data } = img, cw = x1 - x0, ch = y1 - y0;
  const dst = new Uint8ClampedArray(cw * ch * c);
  for (let y = 0; y < ch; y++) dst.set(data.subarray(((y0 + y) * w + x0) * c, ((y0 + y) * w + x1) * c), y * cw * c);
  return { w: cw, h: ch, c, data: dst };
}

// ---------------------------------------------------------------- geometry
// 3x3 homography taking the 4 points `from` onto `to` (getPerspectiveTransform)
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {           // Gaussian elimination, partial pivoting
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let k = col; k < n; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  const h = new Array(8);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [...h, 1];
}

// Perspective-warp `quad` (4 corners tl,tr,br,bl in image pixels) to an upright W x H card:
// rendered at 2x with bilinear sampling and edge pixels repeated, then halved - the same as
// detector.warp (warpPerspective INTER_LINEAR, BORDER_REPLICATE, then INTER_AREA).
export function warp(img, quad, W = CARD_W, H = CARD_H) {
  const W2 = 2 * W, H2 = 2 * H;
  const Hm = homography([[0, 0], [W2 - 1, 0], [W2 - 1, H2 - 1], [0, H2 - 1]], quad);
  const { w, h, c, data } = img, dst = new Uint8ClampedArray(W * H * 3);
  const [a, b, cc, d, e, f, g, hh] = Hm;
  const wm = w - 1, hm = h - 1;
  // each 2x sample: bilinear, every channel rounded like cv2's 8-bit output (+0.5 | 0 is
  // Math.round for these non-negative values); each output pixel averages its 4 samples
  for (let oy = 0; oy < H; oy++) {
    let o = oy * W * 3;
    for (let ox = 0; ox < W; ox++, o += 3) {
      let r = 2, gg = 2, bb = 2;
      for (let s = 0; s < 4; s++) {
        const x = 2 * ox + (s & 1), y = 2 * oy + (s >> 1);
        const z = g * x + hh * y + 1;
        const X = (a * x + b * y + cc) / z, Y = (d * x + e * y + f) / z;
        let x0 = Math.floor(X), y0 = Math.floor(Y);
        const fx = X - x0, fy = Y - y0;
        let x1 = x0 + 1, y1 = y0 + 1;
        if (x0 < 0) x0 = 0; else if (x0 > wm) x0 = wm;
        if (x1 < 0) x1 = 0; else if (x1 > wm) x1 = wm;
        if (y0 < 0) y0 = 0; else if (y0 > hm) y0 = hm;
        if (y1 < 0) y1 = 0; else if (y1 > hm) y1 = hm;
        const p00 = (y0 * w + x0) * c, p01 = (y0 * w + x1) * c, p10 = (y1 * w + x0) * c, p11 = (y1 * w + x1) * c;
        const w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy, w00 = 1 - w01 - w10 - w11;
        r += (data[p00] * w00 + data[p01] * w01 + data[p10] * w10 + data[p11] * w11 + 0.5) | 0;
        gg += (data[p00 + 1] * w00 + data[p01 + 1] * w01 + data[p10 + 1] * w10 + data[p11 + 1] * w11 + 0.5) | 0;
        bb += (data[p00 + 2] * w00 + data[p01 + 2] * w01 + data[p10 + 2] * w10 + data[p11 + 2] * w11 + 0.5) | 0;
      }
      dst[o] = r >> 2; dst[o + 1] = gg >> 2; dst[o + 2] = bb >> 2;
    }
  }
  return { w: W, h: H, c: 3, data: dst };
}

export function contourArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % q.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

// pointPolygonTest(...) >= 0: inside or on the edge
export function pointIn(q, [px, py]) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    // on an edge counts as inside
    const cross = (px - xi) * (yj - yi) - (py - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-6 && px >= Math.min(xi, xj) - 1e-6 && px <= Math.max(xi, xj) + 1e-6
        && py >= Math.min(yi, yj) - 1e-6 && py <= Math.max(yi, yj) + 1e-6) return true;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const centre = (q) => [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length];
const norm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// tl, tr, br, bl with the first edge the short (top) side (detector.order_corners)
export function orderCorners(q) {
  const c = centre(q);
  let pts = [...q].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  let start = 0;
  for (let i = 1; i < 4; i++) if (pts[i][0] + pts[i][1] < pts[start][0] + pts[start][1]) start = i;
  pts = [...pts.slice(start), ...pts.slice(0, start)];
  if (norm(pts[1], pts[0]) > norm(pts[3], pts[0])) pts = [...pts.slice(1), pts[0]];
  return pts;
}

// the same outline as one already tried (scan._same): corners within 3% of the diagonal
export function sameQuad(q, tried) {
  const diag = norm(q[2], q[0]);
  return tried.some((t) => {
    for (let s = 0; s < 4; s++) {
      let m = 0;
      for (let i = 0; i < 4; i++) {
        const p = q[(i - s + 4) % 4];      // np.roll(q, s)
        m = Math.max(m, Math.abs(p[0] - t[i][0]), Math.abs(p[1] - t[i][1]));
      }
      if (m < 0.03 * diag) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------- fingerprint
// 64-bit difference hash of a 64 x 88 warp (features.card_signature): tells the app a
// different card is in view. Only compared with itself, never with the desktop's.
export function signature(card64) {
  const dx = Math.floor(card64.w * 0.03), dy = Math.floor(card64.h * 0.03);
  const inner = crop(card64, dx, dy, card64.w - dx, card64.h - dy);
  const s = resize(inner, 9, 8, "a");
  const g = new Float32Array(72);
  for (let i = 0; i < 72; i++) g[i] = Math.round(0.299 * s.data[3 * i] + 0.587 * s.data[3 * i + 1] + 0.114 * s.data[3 * i + 2]);
  let hex = "";
  for (let r = 0; r < 8; r++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g[r * 9 + x + 1] > g[r * 9 + x] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
