# Testing

Two layers, one setup each. New tests go into these; do not add another runner.

| Layer | Tool | Where | Run |
|---|---|---|---|
| Unit | Vitest | `packages/voxxy/src/**/*.test.ts`, next to the code | `pnpm test` |
| End to end | Playwright | `e2e/`, drives the built stand | `pnpm test:e2e` |

`pnpm typecheck` covers the tests of both layers.

## Unit tests

Run in Node. Anything that needs a browser API (`AudioContext`, `Worker`, Cache Storage) is not a unit test: either put a fake behind an interface, or write it as an e2e test. If a unit test really needs a DOM, say so in the file and set the environment for that file only (`// @vitest-environment happy-dom` after installing and licence-checking it); the default stays Node.

`serve.test.ts` shows the pattern: the worker loop is driven through a fake worker scope, with no real `Worker`.

### Tests on real weights

`stt/moonshine.test.ts` and `tts/paradee.test.ts` also run the real models in Node (onnxruntime-web, wasm, one thread), but only when `VOXXY_MODELS_DIR` points at a folder with the weights; without it they are skipped, so CI stays offline. The folder holds `moonshine/` (a copy of `onnx-community/moonshine-tiny-ONNX`), `paradee/` (`sahilmahendrakar/Paradee-8M-v1.3`), `misaki-data/` (`us_gold.json`, `us_silver.json`), `paradee-gh/` (`g2p.onnx`, `g2p.json.gz`), `jfk.wav` and `gatsby5k.md` (the long text for the streaming check; a page of *The Great Gatsby*, 1925, public domain, taken from the Kokoro-TTS Space). The Paradee test speaks sentences and has Moonshine transcribe them, which checks the phonemiser end to end: word error rate is the number to watch.

```bash
VOXXY_MODELS_DIR=/path/to/models pnpm exec vitest run packages/voxxy/src/stt packages/voxxy/src/tts --reporter=verbose --silent=false
```

## End-to-end tests

`pnpm test:e2e` builds the production site and runs the `@fast` set in Chromium:

- `http://localhost:4173` plain
- `http://localhost:4174` with COOP/COEP (`crossOriginIsolated` is true)
- `http://localhost:4175/voxxy/` for the standalone landing under a Pages-style subpath

Playwright starts all three previews. To serve them by hand, run `pnpm --filter @voxxy/stand serve`. Set `STAND_SKIP_BUILD=1` to reuse a previous `pnpm build:site` build.

| Command | Runs |
|---|---|
| `pnpm test:e2e` | `@fast`, Chromium |
| `pnpm test:e2e:models` | `@models`, Chromium |
| `pnpm test:e2e:chat` | `@live-chat`, real voice models, mlvoca and Pollinations Classic, Chromium |
| `pnpm test:e2e:all-browsers` | `@fast`, Chromium + Firefox + WebKit |

### Silence

A test run should not make a sound. The tests that run the real WebAudio player open the stand with `?volume=0`: the audio clock and scheduling are real, only the master gain is zero, so it works in every browser. On top of that, Chromium gets `--mute-audio` (Playwright already mutes it when headless, so this matters for `--headed`) and Firefox gets `media.volume_scale=0` (Playwright does not mute Firefox, and the 220 Hz tone of the dummy voice was audible there before this). Set `PW_UNMUTE=1` to hear what a run plays. The `real.html` and `index.html?audio=real` pages take `?volume=0` to 1 too, for your own testing.

### By hand

`pnpm --filter @voxxy/stand serve` (it builds first), then open `http://localhost:4173/real.html` through the server, not as a file. Press "Download models" (about 47 MB the first time), then "Load". Under "Speak your own text" pick a text from "Try a tricky text" (a very long first sentence, 80 digits, a hard-wrapped e-mail, a link, one-word sentences…), choose how to chunk it, and press "Speak the text". "How it was cut" lists every chunk: its size, how long it took to make, how long it plays, and the size limit the measured speed gives the next chunk. Under "Speak to it" you can hold a button and talk to Moonshine with your microphone, or let it hear a recorded clip. To see a slow device, use the browser's CPU throttling (DevTools, Performance, CPU 4× or 6× slowdown) or a real phone, and watch the chunks grow step by step instead of starting big.

### Tags

Put the tag in the `describe` or test title.

- `@fast`: dummy adapters, no model downloads. Runs on every change; keep the set under about a minute.
- `@models`: real weights, slow, on demand only. Download size and time to ready should be printed in the test output.
- `@live-chat`: the browser records the JFK fixture, transcribes it locally, streams a reply from mlvoca and plays it through Web Audio. A second test loads the built assets under a Pages origin and streams an anonymous reply from Pollinations Classic. Both require internet access and use public API quotas.

A test without a tag does not run by default.

### Installing browsers

Browser downloads are large. Install only what you need:

```bash
pnpm exec playwright install chromium            # the default
pnpm exec playwright install firefox webkit      # only for all-browsers runs
```

If you already have Google Chrome, skip the download: `PW_CHROMIUM_CHANNEL=chrome pnpm test:e2e`. Playwright's Firefox and WebKit builds are patched; a system Firefox or Safari cannot stand in for them. WebKit is not available on every Linux distribution: on Arch-based systems (checked on CachyOS) Playwright's WebKit reports missing `libicu74` (an Ubuntu package version) and does not launch. Firefox does launch there, even though `playwright install` ends with a host-requirements warning.

### Helpers (`e2e/helpers/stand.ts`)

- `openStand(page, url?)` opens the stand and waits for its start-up round trip. `PLAIN` and `ISOLATED` are the two URLs.
- `readStand(page)` returns library state, the stand's log lines and `crossOriginIsolated`, read from the `window.__stand` hook in `apps/stand/src/main.ts`. Extend that hook when the stand gains a metrics panel instead of scraping the DOM.
- `readStorage(page)` returns Cache Storage names, `persisted`, usage and IndexedDB names.
- `clearBrowserStorage(page)` empties Cache Storage, OPFS and IndexedDB: simulated eviction.
- `interruptRequest(page, urlPattern, { afterBytes })` cuts the first matching request off partway (full `content-length`, partial body, socket closed). It works through a test-only `/__interrupt` route in `apps/stand/serve.mjs`, so it applies to same-origin requests to the stand. A model fetched from Hugging Face needs the weights served from the stand's origin in that test.
- `e2e/helpers/helpers.spec.ts` tests these helpers.

### Fake microphone

Chromium only. The project passes `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture=<wav>`. Firefox and WebKit have no equivalent; microphone tests skip there with `test.skip(browserName !== "chromium", reason)`.

Fixture format for Chromium: WAV, PCM 16-bit, mono, 16 kHz works (the file loops). Keep fixtures small, redistributable, and record where each came from.

| File | Source |
|---|---|
| `e2e/fixtures/tone-440hz-16k-mono.wav` | Generated by `e2e/fixtures/make-tone.mjs` (2 s, 440 Hz sine). No third-party licence. |
| `apps/stand/public/jfk-16k-mono.wav` | The stand’s existing speech sample, also used by `@live-chat`. |

To add one: put the WAV in `e2e/fixtures/`, add a row above, and either change the default in `playwright.config.ts` or override `launchOptions` for the test file with `test.use`. Chromium takes one capture file per browser launch, so a test needing a different clip uses its own project or `test.use({ launchOptions })`.

## What these tests cannot cover

Left to real devices:

- iOS silent switch, `audioSession` behaviour and the audio-unlock gesture.
- Real memory ceilings and tab kills on 3–4 GB phones.
- Real-device speed (DevTools throttling approximates CPU only).
- Installed-PWA microphone permission re-prompts and Safari's 7-day storage eviction.
- Anything that depends on the Safari version, until WebKit runs here.

Playwright's WebKit is not Safari on iOS. A green WebKit run is a signal, not a guarantee.

## GitHub Pages chat

`pnpm build:site` assembles the relative-path build in `_site/`. The Pages workflow publishes that folder. The stand is served separately on ports 4173 and 4174. Each chat turn starts with a random entry from the provider list in `apps/landing/src/chat.ts` and tries the remaining entries in order. Pollinations Classic [requires Turnstile on localhost](https://github.com/pollinations/pollinations/blob/master/shared/turnstile.js#L62-L70). mlvoca responds on localhost, while we observed CORS errors from a Pages origin. The live Pages test sends a unique prompt so a cached completion cannot hide a service failure. To use a mlvoca-compatible endpoint for the hosted build, set the repository Actions variable `VITE_CHAT_ENDPOINT` to a URL that permits the site’s origin. This public build variable must contain no credentials.
