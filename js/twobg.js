/*
 * SnapClean "transparent PNG from two backgrounds" pipeline:
 * decode both PNGs at full resolution, combine them with
 * SnapCleanCore.combineBlackWhite, and encode a lossless PNG.
 *
 * Runs inside a Web Worker with OffscreenCanvas (js/twobg-worker.js) so the
 * page never freezes, or on the page as a fallback. The caller supplies the
 * canvas factory and PNG encoder for its environment.
 */
(function (root) {
  'use strict';

  var Core = root.SnapCleanCore;

  // Raw stored pixel values: no colour-profile conversion and no
  // premultiplication, so the black/white maths sees exactly what Canva wrote.
  function decode(file) {
    return createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  }

  function readPixels(ctx, bitmap, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, w, h);
  }

  /*
   * job       {black: Blob, white: Blob, alpha: 'average' | 'max'}
   * env       {makeCanvas(w, h), encode(canvas) -> Promise<Blob>}
   * progress  function (message)
   * Resolves {blob, width, height, stats}; rejects with a readable Error.
   */
  function run(job, env, progress) {
    progress('Reading images…');
    return Promise.all([decode(job.black), decode(job.white)]).then(function (bitmaps) {
      var bb = bitmaps[0], wb = bitmaps[1];
      try {
        Core.checkSameSize(bb, wb);
      } catch (err) {
        bb.close();
        wb.close();
        throw err;
      }
      var w = bb.width, h = bb.height;
      var canvas = env.makeCanvas(w, h);
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || canvas.width !== w || canvas.height !== h) {
        throw new Error('This browser cannot handle an image of ' + w + ' × ' + h + ' px. Try a desktop browser.');
      }
      var black = readPixels(ctx, bb, w, h);
      var white = readPixels(ctx, wb, w, h);

      progress('Combining ' + w + ' × ' + h + ' px…');
      var out = ctx.createImageData(w, h);
      var t0 = Date.now();
      var stats = Core.combineBlackWhite(black, white, out, { alpha: job.alpha });
      stats.combineMs = Date.now() - t0;
      black = white = null; // let the inputs be garbage-collected before encoding

      ctx.putImageData(out, 0, 0);
      out = null;
      progress('Encoding full-resolution PNG…');
      return env.encode(canvas).then(function (blob) {
        if (!blob) throw new Error('Your browser could not create the PNG.');
        return { blob: blob, width: w, height: h, stats: stats };
      });
    });
  }

  root.SnapCleanTwoBg = { run: run };
})(typeof self !== 'undefined' ? self : this);
