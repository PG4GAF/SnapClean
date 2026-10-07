// Unit tests for js/core.js. Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const Core = require('../js/core.js');

// Build a W×H RGBA image filled with `bg`, with `fg` drawn in a rectangle.
function makeImage(w, h, bg, fg, rect) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rect && x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
      data.set(inside ? fg : bg, (y * w + x) * 4);
    }
  }
  return data;
}

const alphaAt = (d, w, x, y) => d[(y * w + x) * 4 + 3];

test('removes connected background and keeps the subject', () => {
  const w = 20, h = 10;
  const src = makeImage(w, h, [0, 255, 0, 255], [200, 30, 30, 255], { x0: 5, x1: 15, y0: 2, y1: 8 });
  const dst = new Uint8ClampedArray(src.length);
  const r = Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 10, edgeSoftness: 0 });
  assert.strictEqual(r.removed, w * h - 10 * 6);
  assert.strictEqual(alphaAt(dst, w, 0, 0), 0);
  assert.strictEqual(alphaAt(dst, w, 19, 9), 0);
  assert.strictEqual(alphaAt(dst, w, 10, 5), 255);
  assert.deepStrictEqual([...dst.slice((5 * w + 10) * 4, (5 * w + 10) * 4 + 4)], [200, 30, 30, 255]);
});

test('tolerance catches slight colour variation', () => {
  const w = 4, h = 1;
  const src = new Uint8ClampedArray([
    255, 255, 255, 255,
    250, 252, 249, 255, // near-white
    0, 0, 0, 255,
    255, 255, 255, 255,
  ]);
  const dst = new Uint8ClampedArray(src.length);
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 0, edgeSoftness: 0 });
  assert.strictEqual(alphaAt(dst, w, 1, 0), 255, 'tolerance 0 keeps near-white');
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 5, edgeSoftness: 0 });
  assert.strictEqual(alphaAt(dst, w, 1, 0), 0, 'tolerance 5 removes near-white');
  assert.strictEqual(alphaAt(dst, w, 2, 0), 255, 'black stays');
  assert.strictEqual(alphaAt(dst, w, 3, 0), 255, 'disconnected white stays when contiguous');
});

test('non-contiguous mode removes enclosed regions too', () => {
  const w = 4, h = 1;
  const src = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const dst = new Uint8ClampedArray(src.length);
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 5, edgeSoftness: 0, contiguous: false });
  assert.strictEqual(alphaAt(dst, w, 2, 0), 0);
  assert.strictEqual(alphaAt(dst, w, 1, 0), 255);
});

test('multiple seeds remove separate regions', () => {
  // White frame, black ring, white hole in the middle.
  const w = 9, h = 9;
  const src = makeImage(w, h, [255, 255, 255, 255], [0, 0, 0, 255], { x0: 2, x1: 7, y0: 2, y1: 7 });
  src.set([255, 255, 255, 255], (4 * w + 4) * 4);
  const dst = new Uint8ClampedArray(src.length);
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 5, edgeSoftness: 0 });
  assert.strictEqual(alphaAt(dst, w, 4, 4), 255);
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }, { x: 4, y: 4 }], { tolerance: 5, edgeSoftness: 0 });
  assert.strictEqual(alphaAt(dst, w, 4, 4), 0);
  assert.strictEqual(alphaAt(dst, w, 3, 3), 255);
});

test('edge smoothing gives anti-aliased pixels partial alpha and unmixes the background', () => {
  // white bg | 50% grey AA pixel | black subject
  const w = 5, h = 1;
  const src = new Uint8ClampedArray([
    255, 255, 255, 255,
    255, 255, 255, 255,
    128, 128, 128, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
  ]);
  const dst = new Uint8ClampedArray(src.length);
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 10, edgeSoftness: 100 });
  const a = alphaAt(dst, w, 2, 0);
  assert.ok(a > 0 && a < 255, 'edge alpha is partial, got ' + a);
  // Unmixed colour should be close to the black subject, not grey.
  assert.ok(dst[2 * 4] < 40, 'edge colour unmixed toward black, got ' + dst[2 * 4]);
  assert.strictEqual(alphaAt(dst, w, 3, 0), 255, 'solid subject untouched');
  // Without smoothing the edge pixel is untouched.
  Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 10, edgeSoftness: 0 });
  assert.strictEqual(alphaAt(dst, w, 2, 0), 255);
});

test('handles a large image without stack overflow', () => {
  const w = 3000, h = 2000;
  const src = makeImage(w, h, [10, 20, 30, 255], [250, 250, 250, 255], { x0: 1000, x1: 2000, y0: 500, y1: 1500 });
  const dst = new Uint8ClampedArray(src.length);
  const t = Date.now();
  const r = Core.process(src, dst, w, h, [{ x: 0, y: 0 }], { tolerance: 10, edgeSoftness: 30 });
  assert.strictEqual(r.removed, w * h - 1000 * 1000);
  assert.ok(Date.now() - t < 5000);
});
