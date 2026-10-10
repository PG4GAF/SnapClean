/* Web Worker: runs the two-backgrounds pipeline off the main thread. */
importScripts('core.js', 'twobg.js');

self.onmessage = function (e) {
  var env = {
    makeCanvas: function (w, h) { return new OffscreenCanvas(w, h); },
    encode: function (canvas) { return canvas.convertToBlob({ type: 'image/png' }); },
  };
  self.SnapCleanTwoBg.run(e.data, env, function (message) {
    self.postMessage({ type: 'progress', message: message });
  }).then(function (result) {
    self.postMessage({ type: 'done', result: result });
  }).catch(function (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  });
};
