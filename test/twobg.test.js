// Tests for the "transparent PNG from two backgrounds" maths in js/core.js.
// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../js/core.js');

// Ground truth: white "text" bars with a soft pink glow on transparency.
// Returns {w, h, rgba: Float32Array} with straight (unpremultiplied) 0..1 values.
function syntheticDesign(w, h) {
  const bars = [ // three letter-like strokes
    { x0: 40, y0: 30, x1: 52, y1: 90 },
    { x0: 70, y0: 30, x1: 110, y1: 42 },
    { x0: 130, y0: 30, x1: 142, y1: 90 },
  ];
  const pink = [1, 105 / 255, 180 / 255];
  const sigma = 7;
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = Infinity;
      for (const r of bars) {
        const dx = Math.max(r.x0 - x, 0, x - (r.x1 - 1));
        const dy = Math.max(r.y0 - y, 0, y - (r.y1 - 1));
        d = Math.min(d, Math.hypot(dx, dy));
      }
      const i = (y * w + x) * 4;
      if (d === 0) {
        rgba.set([1, 1, 1, 1], i); // solid white text
      } else {
        const a = 0.85 * Math.exp(-(d * d) / (2 * sigma * sigma)); // soft glow
        rgba.set([pink[0], pink[1], pink[2], a < 1 / 512 ? 0 : a], i);
      }
    }
  }
  return { w, h, rgba };
}

// Render the design over a solid background (0 = black, 1 = white), 8-bit.
function renderOn(design, bg) {
  const { w, h, rgba } = design;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = rgba[i + 3];
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(255 * (a * rgba[i + c] + (1 - a) * bg));
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

// Composite an 8-bit RGBA result over a solid background (0..255).
function compositeOver(out, bg) {
  const res = new Uint8ClampedArray(out.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255;
    for (let c = 0; c < 3; c++) res[i + c] = Math.round(out[i + c] * a + bg * (1 - a));
    res[i + 3] = 255;
  }
  return res;
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const at = (out, w, x, y) => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

for (const alpha of ['average', 'max']) {
  test(`white text + pink glow round-trips over black and white (${alpha})`, () => {
    const design = syntheticDesign(180, 120);
    const onBlack = renderOn(design, 0);
    const onWhite = renderOn(design, 1);
    const out = new Uint8ClampedArray(onBlack.data.length);
    const stats = Core.combineBlackWhite(onBlack, onWhite, out, { alpha });

    assert.ok(maxDiff(compositeOver(out, 0), onBlack.data) <= 2, 'matches the black render');
    assert.ok(maxDiff(compositeOver(out, 255), onWhite.data) <= 2, 'matches the white render');
    assert.ok(stats.partial > 1000, 'soft glow kept as semi-transparent pixels, got ' + stats.partial);

    // Solid text is opaque white; glow keeps its pink hue.
    assert.deepStrictEqual(at(out, 180, 45, 60), [255, 255, 255, 255]);
    const glow = at(out, 180, 46, 25); // 5 px above the first bar
    assert.ok(glow[3] > 60 && glow[3] < 200, 'glow is partially transparent, alpha ' + glow[3]);
    assert.ok(Math.abs(glow[0] - 255) <= 3 && Math.abs(glow[1] - 105) <= 6 && Math.abs(glow[2] - 180) <= 6,
      'glow colour recovered as pink, got ' + glow);
  });
}

test('fully transparent regions become alpha 0 with no colour', () => {
  const design = syntheticDesign(180, 120);
  const out = new Uint8ClampedArray(180 * 120 * 4);
  Core.combineBlackWhite(renderOn(design, 0), renderOn(design, 1), out);
  assert.deepStrictEqual(at(out, 180, 2, 2), [0, 0, 0, 0], 'far corner');
  assert.deepStrictEqual(at(out, 180, 179, 119), [0, 0, 0, 0], 'opposite corner');
  // Pure black vs pure white = fully transparent; white darker than black
  // (noise) clamps alpha to opaque instead of going out of range.
  const b = { data: new Uint8ClampedArray([0, 0, 0, 255, 40, 40, 40, 255]), width: 2, height: 1 };
  const w = { data: new Uint8ClampedArray([255, 255, 255, 255, 30, 30, 30, 255]), width: 2, height: 1 };
  const o = new Uint8ClampedArray(8);
  const stats = Core.combineBlackWhite(b, w, o);
  assert.deepStrictEqual(Array.from(o), [0, 0, 0, 0, 40, 40, 40, 255]);
  assert.deepStrictEqual([stats.transparent, stats.opaque], [1, 1]);
});

test('input alpha channels are ignored', () => {
  const b = { data: new Uint8ClampedArray([200, 50, 50, 0]), width: 1, height: 1 };
  const w = { data: new Uint8ClampedArray([200, 50, 50, 17]), width: 1, height: 1 };
  const o = new Uint8ClampedArray(4);
  Core.combineBlackWhite(b, w, o);
  assert.deepStrictEqual(Array.from(o), [200, 50, 50, 255], 'identical renders = opaque');
});

test('mismatched sizes throw a clear error', () => {
  const b = { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 };
  const w = { data: new Uint8ClampedArray(4 * 5 * 4), width: 4, height: 5 };
  assert.throws(() => Core.combineBlackWhite(b, w, new Uint8ClampedArray(64)),
    /same size: "On black" is 4 × 4 px but "On white" is 4 × 5 px/);
});

test('4500×5400 (Printify size) combines in a few seconds', () => {
  const W = 4500, H = 5400, n = W * H * 4;
  const b = { data: new Uint8ClampedArray(n), width: W, height: H };
  const w = { data: new Uint8ClampedArray(n), width: W, height: H };
  for (let i = 0; i < n; i += 4) { // mix of transparent, partial and opaque
    const v = (i >> 2) % 256;
    b.data[i] = b.data[i + 1] = b.data[i + 2] = v >> 1;
    w.data[i] = w.data[i + 1] = w.data[i + 2] = 255 - (v >> 1);
  }
  const out = new Uint8ClampedArray(n);
  const t = performance.now();
  const stats = Core.combineBlackWhite(b, w, out);
  const ms = performance.now() - t;
  assert.strictEqual(stats.total, W * H);
  assert.ok(ms < 5000, 'took ' + Math.round(ms) + ' ms');
  console.log('# 4500×5400 combine: ' + Math.round(ms) + ' ms');
});

test('swapped inputs are flagged via the inverted count', () => {
  const design = syntheticDesign(180, 120);
  const out = new Uint8ClampedArray(180 * 120 * 4);
  const ok = Core.combineBlackWhite(renderOn(design, 0), renderOn(design, 1), out);
  assert.strictEqual(ok.inverted, 0);
  const swapped = Core.combineBlackWhite(renderOn(design, 1), renderOn(design, 0), out);
  assert.ok(swapped.inverted > swapped.total * 0.5, 'most pixels inverted when swapped');
});
