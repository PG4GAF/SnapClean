/* SnapClean "Black + white" mode: two upload slots -> transparent PNG. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    tabs: document.querySelectorAll('.mode-tab'),
    section: $('twoBg'),
    swapBtn: $('swapBtn'),
    alphaMethod: $('alphaMethod'),
    combineBtn: $('combineBtn'),
    msg: $('twoBgMsg'),
    note: $('twoBgNote'),
    status: $('twoBgStatus'),
    result: $('twoBgResult'),
    stage: $('twoBgStage'),
    img: $('twoBgImg'),
    info: $('twoBgInfo'),
    download: $('twoBgDownload'),
    share: $('twoBgShare'),
    edit: $('twoBgEdit'),
  };

  // Printify's recommended print-file size for sweatshirts.
  var TARGET = { width: 4500, height: 5400 };

  var slots = {};      // name -> {el, img, info, file, width, height, url}
  var result = null;   // {blob, url, width, height, name}
  var busy = false;
  var runError = '';   // error from the last combine; cleared when inputs change

  // ---------- Mode switching ----------

  function setMode(mode) {
    document.body.dataset.mode = mode;
    els.tabs.forEach(function (t) {
      var on = t.dataset.mode === mode;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    try { localStorage.setItem('snapclean-mode', mode); } catch (e) { /* storage unavailable */ }
  }

  els.tabs.forEach(function (t) {
    t.addEventListener('click', function () { setMode(t.dataset.mode); });
  });
  try {
    if (localStorage.getItem('snapclean-mode') === 'twobg' && !/[?&]shared=1/.test(location.search)) setMode('twobg');
  } catch (e) { /* storage unavailable */ }

  // ---------- Messages ----------

  function showError(text) {
    els.msg.textContent = text;
    els.msg.hidden = !text;
  }

  function showNote(text) {
    els.note.textContent = text;
    els.note.hidden = !text;
  }

  // ---------- Slots ----------

  function isPngSignature(buf) {
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    var b = new Uint8Array(buf);
    for (var i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
    return true;
  }

  // Only lossless PNG works: JPG compression changes pixel values slightly
  // and differently in each file, which breaks the black/white maths.
  function validateFile(file) {
    return file.slice(0, 8).arrayBuffer().then(function (buf) {
      if (isPngSignature(buf)) return null;
      if (/jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)) {
        return '"' + file.name + '" is a JPG. JPG compression breaks the black/white maths – ' +
          'please download both versions from Canva as PNG.';
      }
      return '"' + file.name + '" is not a PNG. Please download both versions from Canva as PNG.';
    });
  }

  function setSlot(name, file) {
    var slot = slots[name];
    return validateFile(file).then(function (error) {
      if (error) {
        runError = error;
        showError(error);
        return;
      }
      var url = URL.createObjectURL(file);
      var probe = new Image();
      probe.onload = function () {
        if (slot.url) URL.revokeObjectURL(slot.url);
        slot.file = file;
        slot.url = url;
        slot.width = probe.naturalWidth;
        slot.height = probe.naturalHeight;
        slot.img.src = url;
        slot.img.hidden = false;
        slot.empty.hidden = true;
        slot.el.classList.add('is-filled');
        clearResult();
        refresh();
      };
      probe.onerror = function () {
        URL.revokeObjectURL(url);
        runError = 'Could not read "' + file.name + '". Is it a valid PNG?';
        showError(runError);
      };
      probe.src = url;
    });
  }

  function slotLabel(name) {
    return name === 'black' ? '"On black"' : '"On white"';
  }

  function refresh() {
    var b = slots.black, w = slots.white;
    ['black', 'white'].forEach(function (name) {
      var s = slots[name];
      s.info.textContent = s.file ? s.file.name + ' · ' + s.width + ' × ' + s.height + ' px' : '';
    });
    els.swapBtn.disabled = !(b.file || w.file) || busy;

    var error = '';
    var note = '';
    if (b.file && w.file) {
      if (b.width !== w.width || b.height !== w.height) {
        error = 'The two images must be the same size: ' + slotLabel('black') + ' is ' + b.width + ' × ' + b.height +
          ' px but ' + slotLabel('white') + ' is ' + w.width + ' × ' + w.height +
          ' px. Export both from the same Canva design without resizing.';
      } else if (b.width !== TARGET.width || b.height !== TARGET.height) {
        note = 'Size is ' + b.width + ' × ' + b.height + ' px. Printify recommends ' + TARGET.width + ' × ' +
          TARGET.height + ' px for sweatshirts – fine to continue, the output keeps your exact size.';
      }
    }
    showError(error || runError);
    showNote(note);
    els.combineBtn.disabled = busy || !b.file || !w.file || !!error;
  }

  document.querySelectorAll('.slot').forEach(function (el) {
    var name = el.dataset.slot;
    var slot = slots[name] = {
      el: el,
      img: el.querySelector('.slot-img'),
      empty: el.querySelector('.slot-empty'),
      info: el.querySelector('.slot-info'),
      input: el.querySelector('input[type=file]'),
      file: null,
    };
    slot.input.addEventListener('change', function () {
      if (slot.input.files[0]) setSlot(name, slot.input.files[0]);
      slot.input.value = '';
    });
    var drop = el.querySelector('.slot-drop');
    ['dragenter', 'dragover'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault();
        drop.classList.add('is-dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      drop.addEventListener(type, function () { drop.classList.remove('is-dragging'); });
    });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) setSlot(name, f);
    });
  });

  // Dropping two files anywhere in this mode fills both slots: the darker
  // one is assumed to be "On black" (checked again when combining).
  window.addEventListener('drop', function (e) {
    if (document.body.dataset.mode !== 'twobg') return;
    var files = e.dataTransfer ? Array.prototype.slice.call(e.dataTransfer.files, 0, 2) : [];
    if (files.length === 1) setSlot(slots.black.file && !slots.white.file ? 'white' : 'black', files[0]);
    else if (files.length === 2) {
      setSlot('black', files[0]).then(function () { return setSlot('white', files[1]); });
    }
  });

  els.swapBtn.addEventListener('click', function () {
    var b = slots.black, w = slots.white;
    ['file', 'url', 'width', 'height'].forEach(function (k) {
      var t = b[k]; b[k] = w[k]; w[k] = t;
    });
    [b, w].forEach(function (s) {
      s.img.hidden = !s.file;
      s.empty.hidden = !!s.file;
      s.el.classList.toggle('is-filled', !!s.file);
      if (s.file) s.img.src = s.url; else s.img.removeAttribute('src');
    });
    clearResult();
    refresh();
  });

  // ---------- Combining ----------

  function canUseWorker() {
    return typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
      typeof createImageBitmap === 'function' && 'convertToBlob' in OffscreenCanvas.prototype;
  }

  function runInWorker(job, onProgress) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker('js/twobg-worker.js');
      worker.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'progress') { onProgress(m.message); return; }
        worker.terminate(); // frees the worker's full-resolution buffers
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      };
      worker.onerror = function (e) {
        e.preventDefault();
        worker.terminate();
        reject(Object.assign(new Error(e.message || 'Worker failed'), { workerFailed: true }));
      };
      worker.postMessage(job);
    });
  }

  // Fallback for browsers without OffscreenCanvas: same code on the page.
  function runOnPage(job, onProgress) {
    var env = {
      makeCanvas: function (w, h) {
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      },
      encode: function (c) {
        return new Promise(function (resolve) { c.toBlob(resolve, 'image/png'); });
      },
    };
    return window.SnapCleanTwoBg.run(job, env, function (message) {
      onProgress(message);
    });
  }

  function clearResult() {
    runError = '';
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    els.result.hidden = true;
    els.img.removeAttribute('src');
    els.status.textContent = '';
  }

  function baseName() {
    var n = slots.black.file ? slots.black.file.name : 'design';
    n = n.replace(/\.[^.]+$/, '').replace(/[-_ ]*(on[-_ ]?)?(black|blk|dark)$/i, '');
    return (n || 'design') + '-transparent.png';
  }

  function combine() {
    if (busy || els.combineBtn.disabled) return;
    busy = true;
    clearResult();
    showError('');
    refresh();
    var label = els.combineBtn.textContent;
    els.combineBtn.textContent = 'Working…';
    var t0 = performance.now();
    var job = { black: slots.black.file, white: slots.white.file, alpha: els.alphaMethod.value };
    var progress = function (m) { els.status.textContent = m; };

    var p = canUseWorker()
      ? runInWorker(job, progress).catch(function (err) {
        if (!err.workerFailed) throw err;
        return runOnPage(job, progress);
      })
      : runOnPage(job, progress);

    p.then(function (r) {
      var s = r.stats;
      if (s.inverted > s.total * 0.02) {
        throw new Error('These look swapped: the "On black" image is brighter than the "On white" one in many places. ' +
          'Tap ⇄ Swap and try again.');
      }
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      result = { blob: r.blob, url: URL.createObjectURL(r.blob), width: r.width, height: r.height, name: baseName() };
      els.img.src = result.url;
      els.result.hidden = false;
      var pct = function (v) { return (100 * v / s.total).toFixed(1) + '%'; };
      els.info.textContent = r.width + ' × ' + r.height + ' px · ' + (r.blob.size / 1048576).toFixed(1) + ' MB PNG · ' +
        pct(s.opaque) + ' solid, ' + pct(s.partial) + ' soft/semi-transparent, ' + pct(s.transparent) + ' transparent';
      els.status.textContent = 'Done in ' + secs + ' s.';
      els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (err) {
      console.error(err);
      els.status.textContent = '';
      runError = err.message || 'Something went wrong while combining the images.';
    }).then(function () {
      busy = false;
      els.combineBtn.textContent = label;
      refresh();
    });
  }

  els.combineBtn.addEventListener('click', combine);

  // ---------- Result: preview, download, share, edit ----------

  document.querySelectorAll('#twoBgResult .bg-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#twoBgResult .bg-opt').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
      });
      els.stage.classList.remove('bg-checker', 'bg-white', 'bg-black', 'bg-heather');
      els.stage.classList.add('bg-' + btn.dataset.bg);
    });
  });

  // The PNG is downloaded exactly as encoded: no resizing or recompression.
  els.download.addEventListener('click', function () {
    if (!result) return;
    var a = document.createElement('a');
    a.href = result.url;
    a.download = result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  var canShareFiles = (function () {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] }));
    } catch (e) {
      return false;
    }
  })();
  if (canShareFiles) {
    els.share.hidden = false;
    els.share.addEventListener('click', function () {
      if (!result) return;
      var file = new File([result.blob], result.name, { type: 'image/png' });
      navigator.share({ files: [file], title: result.name }).catch(function (err) {
        if (err && err.name !== 'AbortError') els.download.click();
      });
    });
  }

  // Open the result in the Solid colour editor (eraser, area tools, …).
  els.edit.addEventListener('click', function () {
    if (!result || !window.SnapCleanApp) return;
    setMode('key');
    window.SnapCleanApp.loadFile(new File([result.blob], result.name, { type: 'image/png' }));
  });

  refresh();
})();
