# SnapClean

Remove a flat, solid-colour background from a PNG or JPG and download a
full-resolution transparent PNG. Everything runs in the browser with
canvas + JavaScript: no server, no uploads, no account, no watermark.

## How it works

1. Choose (or drag/drop/paste) a PNG or JPG.
2. Tap the background. All connected pixels within the **tolerance** of that
   colour become transparent. Tap more spots to remove other regions (e.g.
   the hole inside an "O"); tap a swatch to drop a pick, or use Undo/Reset.
3. Adjust **Tolerance** (how different a shade can be and still count as
   background) and **Edge smoothing** (fades anti-aliased edge pixels and
   subtracts the background colour from them so no halo is left).
   Untick **Only connected areas** to remove that colour everywhere.
4. Preview against a checkerboard, white, black or magenta; hold
   **Hold to see original** to compare.
5. **Download PNG** exports at the image's original pixel dimensions.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | Single page |
| `css/style.css` | Mobile-first styles (light/dark) |
| `js/core.js` | Pure pixel processing: scanline flood fill, edge smoothing. No DOM, unit-tested in Node |
| `js/app.js` | UI: loading, tap-to-pick, preview, export |
| `test/core.test.js` | Tests for `core.js` |

No build step and no dependencies.

## Run locally

```sh
npm start      # serves on http://localhost:8080 (or open index.html directly)
npm test       # unit tests (Node 18+)
```

## Deploy

It is a static site: publish the repo root to GitHub Pages, Netlify,
Cloudflare Pages, etc. Hosting cost is just static files.

## Limits

There is no app-imposed resolution cap, but browsers cap canvas size.
Desktop browsers handle very large images (hundreds of megapixels); iOS
Safari limits a canvas to about 16.7 MP (e.g. 4096×4096), which covers
standard 12 MP phone photos. Larger images show an error rather than
exporting a downscaled result.
