# SnapClean

Remove a flat, solid-colour background from a PNG or JPG – or build a
transparent PNG from two exports of a design on black and on white – and
download a full-resolution transparent PNG. Everything runs in the browser with
canvas + JavaScript: no server, no uploads, no account, no watermark.

## How it works

1. Choose (or drag/drop/paste) a PNG or JPG.
2. **Tap tool:** tap the background. Choose what each tap removes with the
   **Tap removes** toggle:
   - **Connected area** – the region touching the tap (within **tolerance**).
   - **All matching** – every pixel of that colour in the whole image,
     including small isolated pockets (inside text, tight gaps).
   The mode is saved per tap, so both can be mixed. Dashed swatches are
   "All matching" picks; tap a swatch to drop that pick. Pick markers are
   thin outlines; when zoomed in they shrink to a box around the exact pixel
   so they never cover what you're targeting.
3. **Area tool:** drag a box over a small area, then choose:
   - **Remove colour** – removes the picked background colour(s) inside the
     box only, even where it isn't connected (e.g. the hole inside an "O").
     With no picks yet, it uses the colour where the drag started.
   - **Erase** – makes the whole box transparent (stray specks, shadows).
   - **Keep** – protects the box, restoring anything removed there.
4. **Erase tool:** hold the mouse button (or finger) and drag to erase.
   The brush is a square measured in real image pixels – default 5×5 = 25
   pixels, adjustable 1×1 to 50×50 with the slider or `[` / `]` – so at high
   zoom you erase exactly the pixels you see. A thin outline shows the brush
   footprint; each stroke is one undo step.
5. **Undo / Redo** in the toolbar cover every edit, including slider changes
   (keyboard: Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y). **Start over** clears all
   edits and can itself be undone.
6. **Zoom** (−, 100%, +; up to 16×, or Ctrl/⌘+wheel / pinch on trackpads)
   for precise taps and boxes on small details; pixels render crisp when
   magnified. Use the Tap tool to scroll around while zoomed.
7. Adjust **Tolerance** and **Edge smoothing** (fades anti-aliased edges and
   subtracts the background colour so no halo is left); preview on checkerboard/white/black/magenta; hold
   **Hold: original** to compare.
8. **Download PNG** exports at the image's original pixel dimensions.

## Black + white mode (Canva → transparent PNG)

Canva's free plan can't export transparent PNGs, and background removers
cap resolution or eat soft glows. Instead, export the same design twice –
once on pure black, once on pure white – and SnapClean recovers the exact
transparency from the difference, keeping glows, shadows and anti-aliasing
as semi-transparent pixels at full resolution.

### Exporting the two files from Canva

1. Create the design at your print size, e.g. **Custom size → 4500 × 5400 px**
   (Printify's sweatshirt size). Don't resize between the two exports.
2. Click an empty part of the page, choose **Background colour** and set it
   to **#000000** (pure black).
3. **Share → Download → File type: PNG**. Leave *Transparent background*
   unticked. Download and name it e.g. `design-black.png`.
4. Change the background colour to **#FFFFFF** (pure white) – change nothing
   else – and download again as **PNG** (`design-white.png`).
5. In SnapClean, open the **Black + white (Canva)** tab, put each file in its
   slot (*On black* / *On white*) and press **Create transparent PNG**.
   Check the preview over the checkerboard, black, white or grey, then
   **Download PNG**. **Edit further** opens the result in the editor (eraser,
   area tools) for touch-ups.

Use PNG for both – JPG compression changes pixels differently in each file
and breaks the maths, so JPGs are rejected. Both files must be exactly the
same size. Any alpha channel in the inputs is ignored.

### How it works

Per pixel, with channels in 0–1: `alpha = 1 − (white − black)` (average of
R, G, B, or optionally the largest channel difference), clamped to 0–1;
`colour = black / alpha` (or 0 where alpha ≈ 0). The result is written at the
original size and encoded as a lossless PNG – no resizing or recompression.
It runs in a Web Worker on typed arrays: a 4500 × 5400 image takes about
1–2 s without freezing the page. Very large images may exceed the canvas
limit of iPhone/iPad Safari (about 16.7 megapixels); use a desktop browser or
Chrome on Android for 4500 × 5400.

## Android

SnapClean is an installable Progressive Web App, so on Android it behaves
like a native app without a separate codebase or Play Store listing:

- **Install:** open the site in Chrome and tap **Install app** (or menu →
  *Install app* / *Add to Home screen*). It gets its own icon and opens
  full-screen.
- **Works offline** once installed (`sw.js` caches the app).
- **Share into SnapClean:** after installing, the app appears in Android's
  share sheet, so you can share a photo from Gallery/Photos straight in.
- **Share / save out:** the **Share** button hands the PNG to Android's
  share sheet (save to Photos, Drive, messaging apps…). **Download PNG**
  saves to *Downloads*.
- The Android **back** button returns from the editor to the start screen.

Install, offline use and sharing need the site served over HTTPS
(GitHub Pages, Netlify, etc.); opening `index.html` as a file still works
for basic use. If you later want a Play Store listing, the PWA can be
wrapped as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
or [PWABuilder](https://www.pwabuilder.com/) without changing the code.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | Single page |
| `css/style.css` | Mobile-first styles (light/dark) |
| `js/core.js` | Pure pixel processing: scanline flood fill, edge smoothing. No DOM, unit-tested in Node |
| `js/app.js` | UI: loading, tap-to-pick, preview, export, share, install |
| `js/twobg.js` | Black + white pipeline: decode both PNGs, combine, encode PNG |
| `js/twobg-worker.js` | Web Worker that runs the pipeline off the main thread |
| `js/twobg-ui.js` | Black + white mode UI: upload slots, validation, preview, download |
| `manifest.webmanifest` | PWA manifest (install, icons, Android share target) |
| `sw.js` | Service worker: offline cache + receiving shared images |
| `icons/` | App icons (regular + Android maskable) |
| `test/core.test.js` | Tests for `core.js` (colour key, areas, eraser) |
| `test/twobg.test.js` | Tests for the black + white combine (glow round-trip, sizes, transparency) |

No build step and no dependencies.

## Run locally

```sh
npm start      # serves on http://localhost:8080 (or open index.html directly)
npm test       # unit tests (Node 18+)
```

## Deploy

It is a static site. Pushes to `main` are deployed to GitHub Pages by
`.github/workflows/pages.yml` (tests run first). One-time setup: in the
repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

The live URL is `https://<owner>.github.io/<repo>/`. Any other static host
(Netlify, Cloudflare Pages, …) works too; there is no build step.

## Limits

There is no app-imposed resolution cap, but browsers cap canvas size.
Desktop browsers handle very large images (hundreds of megapixels); iOS
Safari limits a canvas to about 16.7 MP (e.g. 4096×4096), which covers
standard 12 MP phone photos. Larger images show an error rather than
exporting a downscaled result.
