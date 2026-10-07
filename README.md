# SnapClean

Remove a flat, solid-colour background from a PNG or JPG and download a
full-resolution transparent PNG. Everything runs in the browser with
canvas + JavaScript: no server, no uploads, no account, no watermark.

## How it works

1. Choose (or drag/drop/paste) a PNG or JPG.
2. **Tap tool:** tap the background. All connected pixels within the
   **tolerance** of that colour become transparent. Tap more spots to remove
   other regions; tap a swatch to drop a pick.
3. **Area tool:** drag a box over a small area, then choose:
   - **Remove colour** – removes the picked background colour(s) inside the
     box only, even where it isn't connected (e.g. the hole inside an "O").
     With no picks yet, it uses the colour where the drag started.
   - **Erase** – makes the whole box transparent (stray specks, shadows).
   - **Keep** – protects the box, restoring anything removed there.
4. **Undo / Redo** in the toolbar cover every edit, including slider changes
   (keyboard: Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y). **Start over** clears all
   edits and can itself be undone.
5. **Zoom** (−, 100%, +; up to 16×, or Ctrl/⌘+wheel / pinch on trackpads)
   for precise taps and boxes on small details; pixels render crisp when
   magnified. Use the Tap tool to scroll around while zoomed.
6. Adjust **Tolerance**, **Edge smoothing** (fades anti-aliased edges and
   subtracts the background colour so no halo is left) and **Only connected
   areas**; preview on checkerboard/white/black/magenta; hold
   **Hold: original** to compare.
7. **Download PNG** exports at the image's original pixel dimensions.

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
| `manifest.webmanifest` | PWA manifest (install, icons, Android share target) |
| `sw.js` | Service worker: offline cache + receiving shared images |
| `icons/` | App icons (regular + Android maskable) |
| `test/core.test.js` | Tests for `core.js` |

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
