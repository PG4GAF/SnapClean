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
    swatches: $('swatches'),
    undoBtn: $('undoBtn'),
    redoBtn: $('redoBtn'),
    resetBtn: $('resetBtn'),
    zoomInBtn: $('zoomInBtn'),
    zoomOutBtn: $('zoomOutBtn'),
    zoomFitBtn: $('zoomFitBtn'),
    selection: $('selection'),
    brushRow: $('brushRow'),
    brushSize: $('brushSize'),
    brushSizeOut: $('brushSizeOut'),
    brushCursor: $('brushCursor'),
    areaBar: $('areaBar'),
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
    seeds: [],        // [{x, y, color, scope}] tap picks
    pickScope: 'connected', // what the next tap clears: 'connected' | 'all'
    areas: [],        // [{type, x0, y0, x1, y1, colors?}] box edits
    history: [],      // snapshots of the edit state, for undo/redo
    historyIndex: -1,
    tool: 'tap',      // 'tap' | 'area' | 'erase'
    stroke: null,     // eraser stroke in progress {type: 'brush', size, points}
    zoom: 1,          // multiple of fit-to-screen size
    drag: null,       // in-progress area selection {x0, y0, x1, y1}
    selected: null,   // finished selection awaiting an action
    comparing: false,
    pending: false,
  };

  var ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];

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
    state.areas = [];
    state.history = [];
    state.historyIndex = -1;
    clearSelection();
    commit();

    els.dropZone.hidden = true;
    els.editor.hidden = false;
    els.newImageBtn.hidden = false;
    document.body.classList.add('is-editing');
    els.sizeInfo.textContent = w + ' × ' + h + ' px · full resolution, no watermark';
    setZoom(1);
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
    state.areas = [];
    state.history = [];
    state.historyIndex = -1;
    clearSelection();
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
      areas: state.areas,
    };
  }

  function hasEdits() {
    return state.seeds.length > 0 || state.areas.length > 0;
  }

  // ---------- Undo / redo ----------
  //
  // Every edit (pick, area, slider, checkbox) is recorded as a snapshot of
  // the whole edit state. Snapshots are tiny (no pixels), so undo is instant
  // and simply re-runs processing from the original image.

  var HISTORY_LIMIT = 200;

  function snapshot() {
    return JSON.stringify({
      seeds: state.seeds,
      areas: state.areas,
      tolerance: els.tolerance.value,
      softness: els.softness.value,
    });
  }

  function commit() {
    var snap = snapshot();
    if (state.history[state.historyIndex] === snap) return;
    state.history.length = state.historyIndex + 1; // drop the redo branch
    state.history.push(snap);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.historyIndex = state.history.length - 1;
    refreshHistoryButtons();
  }

  function restore(snap) {
    var s = JSON.parse(snap);
    state.seeds = s.seeds;
    state.areas = s.areas;
    els.tolerance.value = s.tolerance;
    els.toleranceOut.textContent = s.tolerance;
    els.softness.value = s.softness;
    els.softnessOut.textContent = s.softness;
    clearSelection();
    refreshControls();
    scheduleUpdate();
  }

  function undo() {
    if (!state.src || state.historyIndex <= 0) return;
    state.historyIndex--;
    restore(state.history[state.historyIndex]);
  }

  function redo() {
    if (!state.src || state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    restore(state.history[state.historyIndex]);
  }

  function refreshHistoryButtons() {
    els.undoBtn.disabled = state.historyIndex <= 0;
    els.redoBtn.disabled = state.historyIndex >= state.history.length - 1;
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
    if (hasEdits()) {
      result = Core.process(state.src.data, state.out.data, state.width, state.height, state.seeds, options());
    } else {
      state.out.data.set(state.src.data);
      result = { removed: 0, total: state.width * state.height };
    }
    if (!state.comparing) ctx.putImageData(state.out, 0, 0);
    var ms = Math.round(performance.now() - t0);
    if (hasEdits()) {
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

  // ---------- Tools ----------

  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('.tool[data-tool]').forEach(function (b) {
      var on = b.dataset.tool === tool;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    els.editor.classList.toggle('tool-area', tool === 'area');
    els.editor.classList.toggle('tool-erase', tool === 'erase');
    els.canvas.setAttribute('aria-label', tool === 'area'
      ? 'Image preview. Drag to select an area.'
      : tool === 'erase'
        ? 'Image preview. Hold and drag to erase.'
        : 'Image preview. Tap to pick the background colour.');
    if (tool !== 'area') clearSelection();
    if (tool !== 'erase') els.brushCursor.hidden = true;
    refreshHint();
  }

  function refreshHint() {
    if (state.tool === 'erase') {
      els.hint.textContent = 'Hold the mouse button (or your finger) and drag to erase' +
        (state.zoom > 1 ? '. Switch to Tap to scroll.' : '. Zoom in for single-pixel detail.');
    } else if (state.tool === 'area') {
      els.hint.textContent = state.selected
        ? 'Choose what to do with the selected area.'
        : 'Drag a box over a small area' + (state.zoom > 1 ? ' (switch to Tap to scroll).' : '. Zoom in for precision.');
    } else if (state.pickScope === 'all') {
      els.hint.textContent = 'Tap a colour to clear every matching pixel in the image, including small pockets.';
    } else if (hasEdits()) {
      els.hint.textContent = 'Tap other background areas to remove them too. Leftover specks? Switch to "All matching".';
    } else {
      els.hint.textContent = 'Tap the background colour you want to remove.';
    }
  }

  function setPickScope(scope) {
    state.pickScope = scope;
    document.querySelectorAll('.seg[data-scope]').forEach(function (b) {
      var on = b.dataset.scope === scope;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    refreshHint();
  }

  // ---------- Area selection ----------

  function normRect(r) {
    return {
      x0: Math.min(r.x0, r.x1),
      y0: Math.min(r.y0, r.y1),
      x1: Math.max(r.x0, r.x1) + 1, // inclusive end pixel -> exclusive bound
      y1: Math.max(r.y0, r.y1) + 1,
    };
  }

  function drawSelection(r) {
    if (!r) { els.selection.hidden = true; return; }
    var n = normRect(r);
    els.selection.hidden = false;
    els.selection.style.left = (n.x0 / state.width * 100) + '%';
    els.selection.style.top = (n.y0 / state.height * 100) + '%';
    els.selection.style.width = ((n.x1 - n.x0) / state.width * 100) + '%';
    els.selection.style.height = ((n.y1 - n.y0) / state.height * 100) + '%';
  }

  function clearSelection() {
    state.drag = state.selected = null;
    els.selection.hidden = true;
    els.areaBar.hidden = true;
    if (state.src) refreshHint();
  }

  function applyArea(type) {
    var sel = state.selected;
    if (!sel) return;
    var area = normRect(sel);
    area.type = type;
    if (type === 'remove') {
      // Remove the picked background colours inside the box; with no picks
      // yet, use the colour where the drag started (usually background).
      area.colors = state.seeds.length
        ? state.seeds.map(function (s) { return s.color; })
        : [Core.colorAt(state.src.data, state.width, sel.x0, sel.y0)];
    }
    state.areas.push(area);
    clearSelection();
    commit();
    refreshControls();
    scheduleUpdate();
  }

  // ---------- Eraser ----------
  //
  // While the button is held, each dab is cleared straight on the canvas for
  // instant feedback; on release the stroke is stored as one edit (undoable)
  // and the image is re-processed so edge smoothing etc. stay consistent.

  function brushSize() {
    return +els.brushSize.value;
  }

  function setBrushSize(n) {
    n = Math.max(1, Math.min(50, n | 0));
    els.brushSize.value = n;
    els.brushSizeOut.textContent = n + ' × ' + n + ' px';
    els.brushSizeOut.title = (n * n) + ' pixels';
  }

  function showBrushCursor(x, y) {
    var size = brushSize();
    var o = Core.brushOrigin(x, y, size);
    var c = els.brushCursor;
    c.hidden = false;
    c.style.left = (o[0] / state.width * 100) + '%';
    c.style.top = (o[1] / state.height * 100) + '%';
    c.style.width = (size / state.width * 100) + '%';
    c.style.height = (size / state.height * 100) + '%';
  }

  function dab(x, y) {
    var size = state.stroke.size;
    var o = Core.brushOrigin(x, y, size);
    state.stroke.points.push([x, y]);
    if (!state.comparing) ctx.clearRect(o[0], o[1], size, size);
  }

  function startStroke(p) {
    state.stroke = { type: 'brush', size: brushSize(), points: [] };
    dab(p.x, p.y);
  }

  // Fill the gap between pointer events so fast drags leave no holes.
  function continueStroke(p) {
    var pts = state.stroke.points;
    var last = pts[pts.length - 1];
    var dx = p.x - last[0], dy = p.y - last[1];
    var dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist === 0) return;
    var step = Math.max(1, Math.floor(state.stroke.size / 2));
    var n = Math.ceil(dist / step);
    for (var i = 1; i <= n; i++) {
      dab(Math.round(last[0] + dx * i / n), Math.round(last[1] + dy * i / n));
    }
  }

  function endStroke() {
    if (!state.stroke) return;
    state.areas.push(state.stroke);
    state.stroke = null;
    commit();
    refreshControls();
    scheduleUpdate();
  }

  // ---------- Zoom ----------

  // Size the canvas element to fit the stage, times the zoom level. The
  // canvas keeps its full-resolution pixels; only its displayed size changes.
  function layout() {
    if (!state.src) return;
    var cs = getComputedStyle(els.stage);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var availW = Math.max(50, els.stage.clientWidth - padX);
    var availH = Math.max(50, parseFloat(cs.maxHeight) - padY - 2);
    var fit = Math.min(availW / state.width, availH / state.height);
    var scale = fit * state.zoom;
    els.canvas.style.width = Math.round(state.width * scale) + 'px';
    els.canvas.style.height = Math.round(state.height * scale) + 'px';
    // Show crisp pixels when magnified, for precise picking.
    els.canvas.classList.toggle('is-pixelated', scale >= 2);
    // Markers shrink to a thin box around the exact pixel once a pixel is
    // big enough on screen to see, so they never hide what's being targeted.
    els.markers.style.setProperty('--px', scale + 'px');
    els.markers.classList.toggle('is-pixel', scale >= 4);
  }

  function setZoom(z) {
    var stage = els.stage;
    // Keep the point at the centre of the view in place while zooming.
    var cx = (stage.scrollLeft + stage.clientWidth / 2) / (stage.scrollWidth || 1);
    var cy = (stage.scrollTop + stage.clientHeight / 2) / (stage.scrollHeight || 1);
    state.zoom = z;
    layout();
    stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
    els.zoomFitBtn.textContent = Math.round(z * 100) + '%';
    els.zoomOutBtn.disabled = z <= ZOOM_STEPS[0];
    els.zoomInBtn.disabled = z >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
    refreshHint();
  }

  function zoomBy(dir) {
    var i = ZOOM_STEPS.indexOf(state.zoom);
    var next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
    if (next !== state.zoom) setZoom(next);
  }

  function addSeed(x, y) {
    if (state.seeds.length >= Core.MAX_SEEDS) {
      els.status.textContent = 'Maximum number of picks reached.';
      return;
    }
    var color = Core.colorAt(state.src.data, state.width, x, y);
    state.seeds.push({ x: x, y: y, color: color, scope: state.pickScope });
    commit();
    refreshControls();
    scheduleUpdate();
  }

  function removeSeed(index) {
    state.seeds.splice(index, 1);
    commit();
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
    var edited = hasEdits();
    els.resetBtn.disabled = !edited;
    els.downloadBtn.disabled = !edited;
    els.shareBtn.disabled = !edited;
    refreshHistoryButtons();
    refreshHint();

    els.markers.innerHTML = '';
    els.swatches.innerHTML = '';
    if (!state.seeds.length) {
      els.swatches.innerHTML = '<span class="muted">None yet</span>';
      return;
    }
    state.seeds.forEach(function (s, i) {
      var m = document.createElement('div');
      m.className = 'marker' + (s.scope === 'all' ? ' is-all' : '');
      m.style.left = ((s.x + 0.5) / state.width * 100) + '%';
      m.style.top = ((s.y + 0.5) / state.height * 100) + '%';
      els.markers.appendChild(m);

      var b = document.createElement('button');
      b.type = 'button';
      var scopeText = s.scope === 'all' ? 'all matching' : 'connected area';
      b.className = 'swatch' + (s.scope === 'all' ? ' is-all' : '');
      b.style.background = rgbCss(s.color);
      b.title = hex(s.color) + ' (' + scopeText + ') – tap to remove this pick';
      b.setAttribute('aria-label', 'Remove picked colour ' + hex(s.color) + ', ' + scopeText);
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
  // The other mode (Black + white) handles its own drops and keys.
  function inKeyMode() {
    return document.body.dataset.mode !== 'twobg';
  }

  window.addEventListener('drop', function (e) {
    if (!inKeyMode()) return;
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // Paste from clipboard.
  window.addEventListener('paste', function (e) {
    if (!inKeyMode()) return;
    var items = (e.clipboardData && e.clipboardData.files) || [];
    for (var i = 0; i < items.length; i++) {
      if (isSupported(items[i])) { loadFile(items[i]); return; }
    }
  });

  // Eraser tool: press and hold, then drag.
  els.canvas.addEventListener('pointerdown', function (e) {
    if (!state.src || state.comparing || state.tool !== 'erase' || e.button > 0) return;
    e.preventDefault();
    els.canvas.setPointerCapture(e.pointerId);
    var p = eventToPixel(e);
    showBrushCursor(p.x, p.y);
    startStroke(p);
  });
  els.canvas.addEventListener('pointermove', function (e) {
    if (!state.src || state.tool !== 'erase') return;
    var p = eventToPixel(e);
    showBrushCursor(p.x, p.y);
    if (state.stroke) continueStroke(p);
  });
  els.canvas.addEventListener('pointerup', endStroke);
  els.canvas.addEventListener('pointercancel', endStroke);
  els.canvas.addEventListener('pointerleave', function () {
    if (!state.stroke) els.brushCursor.hidden = true;
  });
  els.brushSize.addEventListener('input', function () { setBrushSize(els.brushSize.value); });

  els.canvas.addEventListener('click', function (e) {
    if (!state.src || state.comparing || state.tool !== 'tap') return;
    var p = eventToPixel(e);
    addSeed(p.x, p.y);
  });

  // Area tool: drag a box (mouse, pen or finger).
  els.canvas.addEventListener('pointerdown', function (e) {
    if (!state.src || state.comparing || state.tool !== 'area' || e.button > 0) return;
    e.preventDefault();
    els.canvas.setPointerCapture(e.pointerId);
    var p = eventToPixel(e);
    state.selected = null;
    els.areaBar.hidden = true;
    state.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    drawSelection(state.drag);
  });
  els.canvas.addEventListener('pointermove', function (e) {
    if (!state.drag) return;
    var p = eventToPixel(e);
    state.drag.x1 = p.x;
    state.drag.y1 = p.y;
    drawSelection(state.drag);
  });
  function endDrag() {
    var d = state.drag;
    if (!d) return;
    state.drag = null;
    // Ignore accidental taps: require a box at least ~6 screen px across.
    var rect = els.canvas.getBoundingClientRect();
    var pxPerImg = rect.width / state.width;
    if (Math.abs(d.x1 - d.x0) * pxPerImg < 6 && Math.abs(d.y1 - d.y0) * pxPerImg < 6) {
      clearSelection();
      return;
    }
    state.selected = d;
    els.areaBar.hidden = false;
    refreshHint();
  }
  els.canvas.addEventListener('pointerup', endDrag);
  els.canvas.addEventListener('pointercancel', function () { clearSelection(); });

  els.areaBar.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-area]');
    if (!btn) return;
    if (btn.dataset.area === 'cancel') clearSelection();
    else applyArea(btn.dataset.area);
  });

  document.querySelectorAll('.tool[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.dataset.tool); });
  });

  els.zoomInBtn.addEventListener('click', function () { zoomBy(1); });
  els.zoomOutBtn.addEventListener('click', function () { zoomBy(-1); });
  els.zoomFitBtn.addEventListener('click', function () { setZoom(1); });
  window.addEventListener('resize', layout);
  // Ctrl/⌘ + mouse wheel (and trackpad pinch) zooms the image.
  els.stage.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Sliders update the preview live and record one history step on release.
  els.tolerance.addEventListener('input', function () {
    els.toleranceOut.textContent = els.tolerance.value;
    scheduleUpdate();
  });
  els.softness.addEventListener('input', function () {
    els.softnessOut.textContent = els.softness.value;
    scheduleUpdate();
  });
  els.tolerance.addEventListener('change', commit);
  els.softness.addEventListener('change', commit);
  document.querySelectorAll('.seg[data-scope]').forEach(function (b) {
    b.addEventListener('click', function () { setPickScope(b.dataset.scope); });
  });

  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.resetBtn.addEventListener('click', function () {
    state.seeds = [];
    state.areas = [];
    clearSelection();
    commit(); // undoable
    refreshControls();
    scheduleUpdate();
  });

  // Keyboard: Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo, +/−/0 zoom,
  // Esc cancels a selection.
  document.addEventListener('keydown', function (e) {
    if (!state.src || els.editor.hidden || !inKeyMode()) return;
    var mod = e.ctrlKey || e.metaKey;
    var k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod) return;
    else if (k === 'escape') clearSelection();
    else if (k === '+' || k === '=') zoomBy(1);
    else if (k === '-') zoomBy(-1);
    else if (k === '0') setZoom(1);
    else if (k === '[') setBrushSize(brushSize() - 1);
    else if (k === ']') setBrushSize(brushSize() + 1);
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

  document.querySelectorAll('#editor .bg-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#editor .bg-opt').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
      });
      els.stage.classList.remove('bg-checker', 'bg-white', 'bg-black', 'bg-magenta');
      els.stage.classList.add('bg-' + btn.dataset.bg);
    });
  });

  els.downloadBtn.addEventListener('click', download);

  // Small API for the Black + white mode ("Edit further").
  window.SnapCleanApp = { loadFile: loadFile };
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
