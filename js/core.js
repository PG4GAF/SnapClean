/*
 * SnapClean core: background removal on raw RGBA pixel buffers.
 *
 * Pure functions with no DOM access, so the same code runs in the browser
 * and in Node tests. Works on the full-resolution buffer; nothing is scaled.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SnapCleanCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Maximum number of picked colours; colour ids are stored in a Uint8Array.
  var MAX_SEEDS = 254;
  // Mask id for pixels erased by an area (no background colour to unmix).
  var ERASED = 255;

  // Reused between calls: re-running on every slider move would otherwise
  // allocate a pixel-count-sized buffer each time.
  var stackCache = null;
  function scratchStack(n) {
    if (!stackCache || stackCache.length < n) stackCache = new Int32Array(n);
    return stackCache;
  }

  // Colour distance on a 0..255 scale (RGB + alpha, Euclidean, normalised).
  function distance(data, i, c) {
    var dr = data[i] - c[0];
    var dg = data[i + 1] - c[1];
    var db = data[i + 2] - c[2];
    var da = data[i + 3] - c[3];
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2;
  }

  // Slider value 0..100 -> distance threshold 0..255.
  function toleranceToDistance(t) {
    return (Math.max(0, Math.min(100, t)) / 100) * 255;
  }

  function colorAt(data, width, x, y) {
    var i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  }

  /*
   * Build a mask of pixels to remove.
   *
   * src      Uint8ClampedArray RGBA, length width*height*4
   * seeds    [{x, y, scope?}] picked pixel coordinates (image space).
   *          scope 'connected' clears the region touching the pick;
   *          scope 'all' clears every matching pixel in the image, including
   *          small disconnected pockets. Without scope, options.contiguous
   *          decides (default connected).
   * options  {tolerance: 0..100, contiguous: bool}
   *
   * Returns Uint8Array of length width*height where 0 = keep and
   * k > 0 = removed because it matched seeds[k-1].
   */
  function buildMask(src, width, height, seeds, options) {
    var n = width * height;
    var mask = new Uint8Array(n);
    var maxDist = toleranceToDistance(options.tolerance);
    var defaultContiguous = options.contiguous !== false;
    var stack = null;

    for (var s = 0; s < seeds.length && s < MAX_SEEDS; s++) {
      var sx = seeds[s].x;
      var sy = seeds[s].y;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      var id = s + 1;
      var color = colorAt(src, width, sx, sy);
      var contiguous = seeds[s].scope ? seeds[s].scope !== 'all' : defaultContiguous;

      if (!contiguous) {
        for (var p = 0; p < n; p++) {
          if (mask[p] === 0 && distance(src, p * 4, color) <= maxDist) mask[p] = id;
        }
        continue;
      }

      var start = sy * width + sx;
      if (mask[start] !== 0) continue; // already removed by an earlier pick
      if (!stack) stack = scratchStack(n);
      // Scanline flood fill (4-connected), iterative to avoid deep recursion.
      var sp = 0;
      stack[sp++] = start;
      mask[start] = id;
      while (sp > 0) {
        var q = stack[--sp];
        var y = (q / width) | 0;
        var rowStart = y * width;
        var rowEnd = rowStart + width - 1;

        // Walk left and right from q along the row.
        var left = q;
        while (left > rowStart && mask[left - 1] === 0 && distance(src, (left - 1) * 4, color) <= maxDist) {
          left--;
          mask[left] = id;
        }
        var right = q;
        while (right < rowEnd && mask[right + 1] === 0 && distance(src, (right + 1) * 4, color) <= maxDist) {
          right++;
          mask[right] = id;
        }

        // Queue matching pixels in the rows above and below the span.
        for (var dy = -1; dy <= 1; dy += 2) {
          var ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          var off = dy * width;
          var inRun = false;
          for (var x = left; x <= right; x++) {
            var nq = x + off;
            if (mask[nq] === 0 && distance(src, nq * 4, color) <= maxDist) {
              if (!inRun) {
                mask[nq] = id;
                stack[sp++] = nq;
                inRun = true;
              }
            } else {
              inRun = false;
            }
          }
        }
      }
    }
    return mask;
  }

  /*
   * Write the result into dst (RGBA, same size as src).
   *
   * Removed pixels become fully transparent. When options.edgeSoftness > 0,
   * pixels just outside the removed region whose colour is close to the
   * background (anti-aliased edges) get partial alpha, and the background
   * colour is "unmixed" from them so no coloured halo remains.
   */
  function render(src, dst, width, height, colors, mask, protect, options) {
    dst.set(src);
    var n = width * height;
    var p;
    for (p = 0; p < n; p++) {
      if (mask[p] !== 0) {
        var i = p * 4;
        dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
      }
    }

    var softness = Math.max(0, Math.min(100, options.edgeSoftness || 0));
    if (softness === 0 || colors.length === 0) return dst;

    var tol = toleranceToDistance(options.tolerance);
    // Pixels within [tol, tol + band] of the background colour fade out.
    var band = Math.max(1, (softness / 100) * 160);
    var rings = 2; // anti-aliasing rarely spans more than a couple of pixels
    // ringOwner[p] = seed id that the edge pixel blends with.
    var ringOwner = new Uint8Array(n);
    var frontier = [];
    var x, y, k;
    for (p = 0; p < n; p++) {
      if (mask[p] === 0 || mask[p] === ERASED) continue;
      x = p % width;
      y = (p / width) | 0;
      // Only kept neighbours matter; this keeps the frontier to the outline.
      if (x > 0 && mask[p - 1] === 0) frontier.push(p - 1, mask[p]);
      if (x < width - 1 && mask[p + 1] === 0) frontier.push(p + 1, mask[p]);
      if (y > 0 && mask[p - width] === 0) frontier.push(p - width, mask[p]);
      if (y < height - 1 && mask[p + width] === 0) frontier.push(p + width, mask[p]);
    }

    for (var r = 0; r < rings && frontier.length; r++) {
      var next = [];
      for (k = 0; k < frontier.length; k += 2) {
        p = frontier[k];
        var id = frontier[k + 1];
        if (mask[p] !== 0 || ringOwner[p] !== 0 || (protect && protect[p])) continue;
        var c = colors[id - 1];
        var i4 = p * 4;
        var d = distance(src, i4, c);
        if (d > tol + band) continue;
        ringOwner[p] = id;

        // alpha: 0 at the tolerance boundary, 1 at tol + band.
        var a = Math.max(0, Math.min(1, (d - tol) / band));
        // Never fade more aggressively than the ring position implies.
        a = Math.max(a, r / (rings + 1));
        var srcA = src[i4 + 3] / 255;
        if (a <= 0.004) {
          dst[i4] = dst[i4 + 1] = dst[i4 + 2] = dst[i4 + 3] = 0;
        } else {
          // C = a*F + (1-a)*B  =>  F = (C - (1-a)*B) / a
          for (var ch = 0; ch < 3; ch++) {
            var f = (src[i4 + ch] - (1 - a) * c[ch]) / a;
            dst[i4 + ch] = f < 0 ? 0 : f > 255 ? 255 : f;
          }
          dst[i4 + 3] = Math.round(a * srcA * 255);
        }

        x = p % width;
        y = (p / width) | 0;
        if (x > 0 && mask[p - 1] === 0) next.push(p - 1, id);
        if (x < width - 1 && mask[p + 1] === 0) next.push(p + 1, id);
        if (y > 0 && mask[p - width] === 0) next.push(p - width, id);
        if (y < height - 1 && mask[p + width] === 0) next.push(p + width, id);
      }
      frontier = next;
    }
    return dst;
  }

  function clipRect(r, width, height) {
    var x0 = Math.max(0, Math.min(width, Math.floor(Math.min(r.x0, r.x1))));
    var x1 = Math.max(0, Math.min(width, Math.ceil(Math.max(r.x0, r.x1))));
    var y0 = Math.max(0, Math.min(height, Math.floor(Math.min(r.y0, r.y1))));
    var y1 = Math.max(0, Math.min(height, Math.ceil(Math.max(r.y0, r.y1))));
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /*
   * Apply rectangular area edits, in order, on top of the tap-based mask.
   *
   * areas   [{type: 'remove'|'erase'|'keep', x0, y0, x1, y1, colors?}
   *          | {type: 'brush', size, points: [[x, y], ...]}]
   *   remove: pixels inside the box matching any of `colors` (within the
   *           tolerance) become transparent, connected or not.
   *   erase:  everything inside the box becomes transparent.
   *   keep:   everything inside the box is kept, overriding earlier removal.
   *   brush:  an eraser stroke; a size×size square of pixels centred on each
   *           point becomes transparent.
   * colors  colour table, extended in place with each remove area's colours
   *         so render() can unmix their edges.
   *
   * Returns a Uint8Array marking kept ("protected") pixels, or null.
   */
  function applyAreas(src, width, height, mask, areas, colors, options) {
    if (!areas || !areas.length) return null;
    var protect = new Uint8Array(width * height);
    var maxDist = toleranceToDistance(options.tolerance);
    for (var a = 0; a < areas.length; a++) {
      var area = areas[a];
      if (area.type === 'brush') {
        eraseStroke(mask, protect, width, height, area);
        continue;
      }
      var r = clipRect(area, width, height);
      var ids = [];
      if (area.type === 'remove') {
        var cs = area.colors || [];
        for (var c = 0; c < cs.length && colors.length < MAX_SEEDS; c++) {
          colors.push(cs[c]);
          ids.push(colors.length);
        }
      }
      for (var y = r.y0; y < r.y1; y++) {
        for (var p = y * width + r.x0, end = y * width + r.x1; p < end; p++) {
          if (area.type === 'erase') {
            mask[p] = ERASED;
            protect[p] = 0;
          } else if (area.type === 'keep') {
            mask[p] = 0;
            protect[p] = 1;
          } else if (mask[p] === 0) {
            for (var k = 0; k < ids.length; k++) {
              if (distance(src, p * 4, colors[ids[k] - 1]) <= maxDist) {
                mask[p] = ids[k];
                protect[p] = 0;
                break;
              }
            }
          }
        }
      }
    }
    return protect;
  }

  // Top-left corner of a size×size brush square centred on pixel (x, y).
  function brushOrigin(x, y, size) {
    var half = Math.floor(size / 2);
    return [x - half, y - half];
  }

  function eraseStroke(mask, protect, width, height, stroke) {
    var size = Math.max(1, stroke.size | 0);
    var pts = stroke.points || [];
    for (var i = 0; i < pts.length; i++) {
      var o = brushOrigin(pts[i][0], pts[i][1], size);
      var x0 = Math.max(0, o[0]), y0 = Math.max(0, o[1]);
      var x1 = Math.min(width, o[0] + size), y1 = Math.min(height, o[1] + size);
      for (var y = y0; y < y1; y++) {
        for (var p = y * width + x0, end = y * width + x1; p < end; p++) {
          mask[p] = ERASED;
          protect[p] = 0;
        }
      }
    }
  }

  /*
   * Full pipeline: tap picks (seeds), then area edits (options.areas), then
   * render into dst. Returns pixel counts for the status line.
   */
  function process(src, dst, width, height, seeds, options) {
    var mask = buildMask(src, width, height, seeds, options);
    var colors = seeds.slice(0, MAX_SEEDS).map(function (s) {
      return colorAt(src, width, s.x, s.y);
    });
    var protect = applyAreas(src, width, height, mask, options.areas, colors, options);
    render(src, dst, width, height, colors, mask, protect, options);
    var removed = 0;
    for (var p = 0; p < mask.length; p++) if (mask[p]) removed++;
    return { removed: removed, total: mask.length };
  }

  /*
   * Recover a transparent image from two renders of the same design, one on
   * pure black and one on pure white ("difference matting").
   *
   * With channel values in 0..1, a pixel of colour F and opacity a renders as
   *   on black: B = a*F          on white: W = a*F + (1 - a)
   * so  a = 1 - (W - B)  and  F = B / a.
   *
   * black, white  {data, width, height} RGBA (e.g. ImageData). Their alpha
   *               channels are ignored.
   * out           Uint8ClampedArray (or {data}) of the same length; receives
   *               the RGBA result at full resolution.
   * options       {alpha: 'average' (default, mean of R,G,B differences)
   *                       | 'max' (largest channel difference)}
   *
   * Throws if the two images differ in size. Returns pixel counts, including
   * `inverted`: pixels clearly darker on white than on black, which means
   * the two files were probably swapped.
   */
  function checkSameSize(black, white) {
    if (black.width !== white.width || black.height !== white.height) {
      throw new Error('The two images must be the same size: "On black" is ' +
        black.width + ' × ' + black.height + ' px but "On white" is ' +
        white.width + ' × ' + white.height + ' px. Export both from the same design without resizing.');
    }
  }

  function combineBlackWhite(black, white, out, options) {
    checkSameSize(black, white);
    var useMax = options && options.alpha === 'max';
    var b = black.data, w = white.data, o = out.data || out;
    var n = black.width * black.height * 4;
    var transparent = 0, opaque = 0, inverted = 0;
    for (var i = 0; i < n; i += 4) {
      var dr = w[i] - b[i], dg = w[i + 1] - b[i + 1], db = w[i + 2] - b[i + 2];
      var d = useMax
        ? (dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db))
        : (dr + dg + db) / 3;
      var a = 255 - d; // alpha on a 0..255 scale
      if (d < -16) inverted++;
      if (a < 0.5) {
        // Fully transparent (or noise where white < black): no colour.
        o[i] = o[i + 1] = o[i + 2] = o[i + 3] = 0;
        transparent++;
        continue;
      }
      var A = a >= 255 ? 255 : Math.round(a);
      // Un-premultiply with the stored (rounded) alpha so that compositing the
      // result reproduces the inputs as closely as 8 bits allow. The clamped
      // array clamps colour to 0..255.
      var k = 255 / A;
      o[i] = b[i] * k;
      o[i + 1] = b[i + 1] * k;
      o[i + 2] = b[i + 2] * k;
      o[i + 3] = A;
      if (A === 255) opaque++;
    }
    var total = n / 4;
    return {
      transparent: transparent,
      opaque: opaque,
      partial: total - transparent - opaque,
      inverted: inverted,
      total: total,
    };
  }

  return {
    MAX_SEEDS: MAX_SEEDS,
    colorAt: colorAt,
    distance: distance,
    toleranceToDistance: toleranceToDistance,
    buildMask: buildMask,
    applyAreas: applyAreas,
    brushOrigin: brushOrigin,
    checkSameSize: checkSameSize,
    combineBlackWhite: combineBlackWhite,
    render: render,
    process: process,
  };
});
