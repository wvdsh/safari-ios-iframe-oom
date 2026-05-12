# safari-ios-iframe-oom

Minimal reproducer: a cross-origin iframe that exhausts memory in Web Workers crashes the entire parent page on iOS Safari, not just the iframe.

## Files

- `index.html` + `main.js` — the offending page. Spawns Web Workers, each allocating ~120 MB and busy-looping to keep pages committed. Default config is ~60 workers (≈7 GB target) to ensure OOM within ~1 s of load.
- `parent.html` — a harness that embeds `index.html` in an iframe and listens for `postMessage` heartbeats from the iframe's main thread so you can tell when the iframe (vs. the parent) has died.

## Live URLs

- Offending page (standalone): `https://wvdsh.github.io/safari-ios-iframe-oom/`
- Parent harness, same-origin iframe: `https://wvdsh.github.io/safari-ios-iframe-oom/parent.html`
- Parent harness, cross-origin iframe: open `parent.html` hosted on a second origin with `?src=https://wvdsh.github.io/safari-ios-iframe-oom/`

The authentic production scenario is the page uploaded to itch.io as an HTML5 game; itch serves it from `*.itch.zone`, which makes it cross-origin from `itch.io`.

## Observed behavior

**iOS Safari (iPhone, iOS 17.x and 18.x):**
- Standalone: the tab dies. After a few `sessionStorage`-driven reloads, Safari shows the *"A problem repeatedly occurred"* panel.
- Cross-origin iframe (itch.io hosting): Safari shows *"www.itch.io is not responsive"* — the **parent** origin is blamed, even though the OOM happens in the iframe's workers. From the user's perspective, the host site appears broken.

**macOS Safari (16.4+ with site isolation):**
- The iframe's WebContent process dies; the parent stays responsive. This is the expected behavior.

## Why this matters

iOS Safari uses a single WebContent process per tab; cross-origin iframes share that process. When the OOM killer (jetsam) terminates the process, every frame in the tab dies and the user sees the parent origin take the blame in Safari's UI. Any site that embeds third-party content (game portals, ad networks, embedded sandboxes) is therefore one bad iframe away from looking broken on iOS.

macOS Safari has resolved the same scenario via per-site WebContent processes. iOS Safari has not.

## Repro steps

1. Open `https://wvdsh.github.io/safari-ios-iframe-oom/` on an iOS device in Safari → tab dies within ~1 s.
2. Upload the same files to itch.io as an HTML5 game and open the itch project page on iOS → *"www.itch.io is not responsive"* panel appears.

## URL parameters

- `?workers=N` — number of Web Workers (default 60, max 400)
- `?mb=N` — MB allocated per worker (default 120, max 512)
- `?delay=N` — ms between worker spawns when started manually (default 50)
- `?auto=0` — disable auto-start; require a button tap

## License

Public domain — this is a bug repro, do whatever.
