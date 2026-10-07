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

  function isSupported(file) {
    return file && /^image\/(png|jpeg)$/.test(file.type);
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
        setupImage(img, file.type === 'image/jpeg');
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

  function download() {
    if (!state.out) return;
    // The preview canvas holds the full-resolution result (CSS only scales it
    // for display), so export straight from it; no second canvas in memory.
    if (state.pending) runUpdate();
    setComparing(false);
    ctx.putImageData(state.out, 0, 0);
    els.downloadBtn.disabled = true;
    var label = els.downloadBtn.textContent;
    els.downloadBtn.textContent = 'Preparing PNG…';
    els.canvas.toBlob(function (blob) {
      els.downloadBtn.disabled = false;
      els.downloadBtn.textContent = label;
      if (!blob) {
        alert('Sorry, your browser could not create the PNG.');
        return;
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = state.fileName + '-transparent.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }, 'image/png');
  }

  // ---------- Wiring ----------

  els.fileInput.addEventListener('change', function () {
    loadFile(els.fileInput.files[0]);
  });
  els.newImageBtn.addEventListener('click', resetToStart);

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
})();
