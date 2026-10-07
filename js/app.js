/* SnapClean UI: loading, picking, preview and export. All work is local. */
(function () {
  'use strict';

  var Core = window.SnapCleanCore;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    editor: $('editor'),
    newImageBtn: $('newImageBtn'),
    stage: $('stage'),
    canvas: $('canvas'),
    markers: $('markers'),
    hint: $('hint'),
    status: $('status'),
    tolerance: $('tolerance'),
    toleranceOut: $('toleranceOut'),
    softness: $('softness'),
    softnessOut: $('softnessOut'),
    contiguous: $('contiguous'),
    swatches: $('swatches'),
    undoBtn: $('undoBtn'),
    resetBtn: $('resetBtn'),
    compareBtn: $('compareBtn'),
    downloadBtn: $('downloadBtn'),
    sizeInfo: $('sizeInfo'),
    shareBtn: $('shareBtn'),
    installBtn: $('installBtn'),
  };

  var ctx = els.canvas.getContext('2d', { willReadFrequently: true });

  var state = {
    fileName: 'image',
    width: 0,
    height: 0,
    src: null,        // ImageData of the untouched original
    out: null,        // ImageData of the current result
    seeds: [],        // [{x, y, color}]
    comparing: false,
    pending: false,
  };

  // ---------- Loading ----------

  // Some Android file pickers and share sources omit the MIME type, so fall
  // back to the file extension.
  function fileKind(file) {
    if (!file) return null;
    if (file.type === 'image/png') return 'png';
    if (file.type === 'image/jpeg') return 'jpeg';
    if (!file.type || file.type === 'application/octet-stream') {
      if (/\.png$/i.test(file.name)) return 'png';
      if (/\.jpe?g$/i.test(file.name)) return 'jpeg';
    }
    return null;
  }

  function isSupported(file) {
    return fileKind(file) !== null;
  }

  function loadFile(file) {
    if (!file) return;
    if (!isSupported(file)) {
      alert('Please choose a PNG or JPG image.');
      return;
    }
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        setupImage(img, fileKind(file) === 'jpeg');
      } catch (err) {
        console.error(err);
        alert('This image is too large for your browser to process (' +
          img.naturalWidth + ' × ' + img.naturalHeight + ' px). Try a desktop browser.');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      alert('Could not read that image. Is it a valid PNG or JPG?');
    };
    img.src = url;
  }

  function setupImage(img, opaque) {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    els.canvas.width = w;
    els.canvas.height = h;
    // Canvas silently refuses sizes beyond the browser's limit.
    if (els.canvas.width !== w || els.canvas.height !== h) throw new Error('canvas size rejected');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    state.src = ctx.getImageData(0, 0, w, h);
    // Some mobile browsers (iOS Safari) silently draw nothing when over their
    // canvas memory limit; a JPEG can never be fully transparent.
    if (opaque && state.src.data[3] === 0 && state.src.data[state.src.data.length - 1] === 0) {
      throw new Error('canvas draw failed');
    }
    state.out = new ImageData(new Uint8ClampedArray(state.src.data), w, h);
    state.width = w;
    state.height = h;
    state.seeds = [];

    els.dropZone.hidden = true;
    els.editor.hidden = false;
    els.newImageBtn.hidden = false;
    document.body.classList.add('is-editing');
    els.sizeInfo.textContent = w + ' × ' + h + ' px · full resolution, no watermark';
    refreshControls();
    els.status.textContent = '';
    window.scrollTo(0, 0);
    // Give the editor its own history entry so Android's back button returns
    // to the start screen instead of leaving the app.
    if (!history.state || !history.state.editor) history.pushState({ editor: true }, '');
  }

  // "New image" button: go back through history when we pushed an entry, so
  // the back stack stays in sync; popstate then does the reset.
  function leaveEditor() {
    if (history.state && history.state.editor) history.back();
    else resetToStart();
  }

  function resetToStart() {
    state.src = state.out = null;
    state.seeds = [];
    els.canvas.width = els.canvas.height = 0;
    els.markers.innerHTML = '';
    els.editor.hidden = true;
    els.dropZone.hidden = false;
    els.newImageBtn.hidden = true;
    document.body.classList.remove('is-editing');
    els.fileInput.value = '';
  }

  // ---------- Processing ----------

  function options() {
    return {
      tolerance: +els.tolerance.value,
      edgeSoftness: +els.softness.value,
      contiguous: els.contiguous.checked,
    };
  }

  // Coalesce rapid slider/tap events into one run, after the browser paints
  // the "Working…" message.
  function scheduleUpdate() {
    if (!state.src || state.pending) return;
    state.pending = true;
    document.body.classList.add('is-busy');
    if (state.width * state.height > 2e6) els.status.textContent = 'Working…';
    requestAnimationFrame(function () {
      setTimeout(runUpdate, 0);
    });
  }

  function runUpdate() {
    state.pending = false;
    document.body.classList.remove('is-busy');
    if (!state.src) return;
    var t0 = performance.now();
    var result;
    if (state.seeds.length) {
      result = Core.process(state.src.data, state.out.data, state.width, state.height, state.seeds, options());
    } else {
      state.out.data.set(state.src.data);
      result = { removed: 0, total: state.width * state.height };
    }
    if (!state.comparing) ctx.putImageData(state.out, 0, 0);
    var ms = Math.round(performance.now() - t0);
    if (state.seeds.length) {
      var pct = (100 * result.removed / result.total);
      els.status.textContent = 'Removed ' + (pct < 0.1 && pct > 0 ? '<0.1' : pct.toFixed(1)) +
        '% of pixels' + (ms > 150 ? ' · ' + ms + ' ms' : '');
    } else {
      els.status.textContent = '';
    }
  }

  // ---------- Picking ----------

  function eventToPixel(e) {
    var rect = els.canvas.getBoundingClientRect();
    var x = Math.floor((e.clientX - rect.left) * (state.width / rect.width));
    var y = Math.floor((e.clientY - rect.top) * (state.height / rect.height));
    return {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y)),
    };
  }

  function addSeed(x, y) {
    if (state.seeds.length >= Core.MAX_SEEDS) {
      els.status.textContent = 'Maximum number of picks reached.';
      return;
    }
    var color = Core.colorAt(state.src.data, state.width, x, y);
    state.seeds.push({ x: x, y: y, color: color });
    refreshControls();
    scheduleUpdate();
  }

  function removeSeed(index) {
    state.seeds.splice(index, 1);
    refreshControls();
    scheduleUpdate();
  }

  function rgbCss(c) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(3) + ')';
  }

  function hex(c) {
    return '#' + [c[0], c[1], c[2]].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function refreshControls() {
    var has = state.seeds.length > 0;
    els.undoBtn.disabled = !has;
    els.resetBtn.disabled = !has;
    els.downloadBtn.disabled = !has;
    els.shareBtn.disabled = !has;
    els.hint.textContent = has
      ? 'Tap other background areas to remove them too. Raise tolerance if edges remain.'
      : 'Tap the background colour you want to remove.';

    els.markers.innerHTML = '';
    els.swatches.innerHTML = '';
    if (!has) {
      els.swatches.innerHTML = '<span class="muted">None yet</span>';
      return;
    }
    state.seeds.forEach(function (s, i) {
      var m = document.createElement('div');
      m.className = 'marker';
      m.style.left = ((s.x + 0.5) / state.width * 100) + '%';
      m.style.top = ((s.y + 0.5) / state.height * 100) + '%';
      m.style.background = rgbCss(s.color);
      els.markers.appendChild(m);

      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = rgbCss(s.color);
      b.title = hex(s.color) + ' – tap to remove this pick';
      b.setAttribute('aria-label', 'Remove picked colour ' + hex(s.color));
      b.addEventListener('click', function () { removeSeed(i); });
      els.swatches.appendChild(b);
    });
  }

  // ---------- Compare ----------

  function setComparing(on) {
    if (!state.src || state.comparing === on) return;
    state.comparing = on;
    ctx.putImageData(on ? state.src : state.out, 0, 0);
    els.markers.style.visibility = on ? 'hidden' : '';
  }

  // ---------- Export ----------

  function outputName() {
    return state.fileName + '-transparent.png';
  }

  // Encode the current result as a full-resolution PNG blob.
  function makePng(button, done) {
    if (!state.out) return;
    if (state.pending) runUpdate();
    // The preview canvas holds the full-resolution result (CSS only scales it
    // for display), so export straight from it; no second canvas in memory.
    setComparing(false);
    ctx.putImageData(state.out, 0, 0);
    var label = button.textContent;
    els.downloadBtn.disabled = els.shareBtn.disabled = true;
    button.textContent = 'Preparing…';
    els.canvas.toBlob(function (blob) {
      els.downloadBtn.disabled = els.shareBtn.disabled = false;
      button.textContent = label;
      if (!blob) {
        alert('Sorry, your browser could not create the PNG.');
        return;
      }
      done(blob);
    }, 'image/png');
  }

  function download() {
    makePng(els.downloadBtn, function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = outputName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });
  }

  // Android/iOS share sheet: lets people save straight to Photos/Gallery or
  // send the PNG to another app.
  var canShareFiles = (function () {
    try {
      return !!(navigator.canShare && typeof File === 'function' &&
        navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] }));
    } catch (e) {
      return false;
    }
  })();

  function share() {
    makePng(els.shareBtn, function (blob) {
      var file = new File([blob], outputName(), { type: 'image/png' });
      navigator.share({ files: [file], title: outputName() }).catch(function (err) {
        // AbortError = the person closed the share sheet.
        if (err && err.name !== 'AbortError') download();
      });
    });
  }

  // ---------- Wiring ----------

  els.fileInput.addEventListener('change', function () {
    loadFile(els.fileInput.files[0]);
  });
  els.newImageBtn.addEventListener('click', leaveEditor);
  window.addEventListener('popstate', function () {
    if (state.src && !(history.state && history.state.editor)) resetToStart();
  });

  // Drag & drop anywhere on the page.
  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      e.preventDefault();
      els.dropZone.classList.add('is-dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      e.preventDefault();
      els.dropZone.classList.remove('is-dragging');
    });
  });
  window.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // Paste from clipboard.
  window.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.files) || [];
    for (var i = 0; i < items.length; i++) {
      if (isSupported(items[i])) { loadFile(items[i]); return; }
    }
  });

  els.canvas.addEventListener('click', function (e) {
    if (!state.src || state.comparing) return;
    var p = eventToPixel(e);
    addSeed(p.x, p.y);
  });

  els.tolerance.addEventListener('input', function () {
    els.toleranceOut.textContent = els.tolerance.value;
    scheduleUpdate();
  });
  els.softness.addEventListener('input', function () {
    els.softnessOut.textContent = els.softness.value;
    scheduleUpdate();
  });
  els.contiguous.addEventListener('change', scheduleUpdate);

  els.undoBtn.addEventListener('click', function () {
    if (state.seeds.length) removeSeed(state.seeds.length - 1);
  });
  els.resetBtn.addEventListener('click', function () {
    state.seeds = [];
    refreshControls();
    scheduleUpdate();
  });

  // Press-and-hold compare (mouse, touch and keyboard).
  els.compareBtn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    setComparing(true);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (type) {
    els.compareBtn.addEventListener(type, function () { setComparing(false); });
  });
  els.compareBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  els.compareBtn.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true); }
  });
  els.compareBtn.addEventListener('keyup', function () { setComparing(false); });

  document.querySelectorAll('.bg-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.bg-opt').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
      });
      els.stage.classList.remove('bg-checker', 'bg-white', 'bg-black', 'bg-magenta');
      els.stage.classList.add('bg-' + btn.dataset.bg);
    });
  });

  els.downloadBtn.addEventListener('click', download);
  if (canShareFiles) {
    els.shareBtn.hidden = false;
    els.shareBtn.addEventListener('click', share);
  }

  // ---------- Installable app (PWA) ----------

  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvent = e;
    els.installBtn.hidden = false;
  });
  els.installBtn.addEventListener('click', function () {
    if (!installEvent) return;
    installEvent.prompt();
    installEvent.userChoice.finally(function () {
      installEvent = null;
      els.installBtn.hidden = true;
    });
  });
  window.addEventListener('appinstalled', function () {
    els.installBtn.hidden = true;
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('Service worker registration failed', err);
    });
  }

  // An image shared from another app (Android share sheet) arrives via the
  // service worker, which parks it in a cache and redirects here.
  if (/[?&]shared=1/.test(location.search) && 'caches' in window) {
    history.replaceState(null, '', location.pathname);
    caches.open('snapclean-share').then(function (cache) {
      return cache.match('shared-image').then(function (res) {
        if (!res) return;
        var name = decodeURIComponent(res.headers.get('X-File-Name') || 'image');
        return res.blob().then(function (blob) {
          cache.delete('shared-image');
          loadFile(new File([blob], name, { type: blob.type }));
        });
      });
    });
  }
})();
