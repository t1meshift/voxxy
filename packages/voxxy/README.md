# voxxy

In-browser speech-to-text and text-to-speech. All inference runs in the browser, no server involved. Version 0.x: the API is not stable yet.

## Shape of the API

```ts
import { createVoxxy } from "voxxy";
import { dummyStt } from "voxxy/stt/dummy";   // a stand-in provider; real ones are in voxxy/stt/moonshine and voxxy/tts/paradee
import { dummyTts } from "voxxy/tts/dummy";

const voxxy = createVoxxy();
voxxy.subscribe((state) => render(state));    // per kind: selected, active, status, progress, error
voxxy.select(dummyStt());                     // pick a provider instance; downloads and loads nothing
voxxy.select(dummyTts());
button.onclick = () => void voxxy.unlock();   // once, from a tap: audio output starts only after a gesture (iOS, Chrome)
await voxxy.load("stt");                      // consent and download first if the provider needs files, then load

const session = voxxy.listen();               // push-to-talk: on button down
const text = await session.stop();            // on button up: final text. session.cancel() drops it.

await voxxy.speak("Hello");                   // resolves when this utterance has finished playing
voxxy.speak("Next one");                      // queues behind the first, in order
voxxy.stopSpeaking();                         // clears the queue, pending calls reject with AbortError
```

There is no UI. The host owns the consent popup and every text; the library reports state and exposes methods.

## Providers

A provider is a main-thread object the host creates and passes to `select()`. The core calls it through two small interfaces and never looks inside (`src/provider.ts`).

Every provider says what it is:

| Field | Meaning |
|---|---|
| `kind` | `"stt"` or `"tts"` |
| `id` | name of the engine, for logs and consent |
| `engine` | `"worker"` (our models in a worker), `"platform"` (the browser's own engine), `"custom"` (the host's) |
| `locality` | `"local"`, `"cloud"` or `"unknown"`: whether audio or text may leave the device. Fixed per instance |
| `files` or `install` | what must be on the device first (see below), or neither |
| `load(ctx)`, `unload()` | get ready, release everything |

`SttProvider.listen({ signal })` returns a session with `stop(): Promise<string>` and `cancel()`. Push-to-talk only: no streaming partial results. `TtsProvider.speak(text, { signal })` resolves when that utterance has finished; calls queue in order; `stop()` clears the queue and the sound.

A provider owns whatever it needs: microphone, playback, worker. The host owns the provider's lifetime through `createVoxxy` (it loads and unloads it). **A provider instance belongs to one Voxxy: sharing it between two is not supported.**

`voxxy.getState()[kind].active` says which engine is in use right now (`id`, `engine`, `locality`, and `reason` when a fallback policy chose it), so a host can show a notice when audio may leave the device. The facade has no `transcribe(pcm)` or `synthesize(text)`: browser-native engines never see PCM, so keeping them would mean two paths. PCM is a layer inside worker-backed providers.

### Worker-backed providers

`workerStt({ id, spawn, recorder, files?, ... })` and `workerTts({ id, spawn, player, files?, ... })` build a provider on top of an adapter (`SttAdapter`: mono 16 kHz PCM in, text out; `TtsAdapter`: text in, PCM and sample rate out; phonemisation stays inside the adapter).

- **One worker per provider.** It starts lazily in `load()` and `terminate()` ends it in `unload()`. WASM linear memory never shrinks inside a live worker, so unloading a model without ending the worker would not return memory. A load that fails also ends the worker.
- **A shared single worker is deliberately not built.** Whether the fixed cost of a second runtime matters is not measured yet.
- Jobs inside one worker run one at a time; a cancel message bypasses the queue, so a queued job is dropped before it starts and a running one gets its `AbortSignal` aborted.
- `pcmListener` and `pcmSpeaker` (`src/pcm.ts`) are the glue: a PCM adapter plus a `Recorder` or `Player` becomes `listen` / `speak`. `speak` synthesises the next queued text while the current one plays, at most `maxAhead` (default 1) texts ahead, which also bounds the memory they hold, and hands each buffer to the player as soon as it is ready so the player can start it exactly when the previous one ends. `createMicRecorder` and `createWebAudioPlayer` are the real `Recorder` and `Player` (below); `voxxy/testing` has fakes.

## Browser speech fallback

By default, if the selected model is unavailable, the user skips its download, or `load()` fails, voxxy tries the browser's speech engine. Browser recognition may send microphone audio to the browser vendor, and network voices may send text to a speech service. Set a policy separately for each kind at creation time.

```ts
const voxxy = createVoxxy({
  platformFallback: { stt: "local-only", tts: "off", lang: "en-US" },
});
```

- `any` (default) prefers the browser's installed on-device recognizer or a local voice. It can use cloud recognition and network voices, or voices of unknown locality.
- `local-only` requires `processLocally` for recognition and `localService === true` for synthesis. `off` disables the automatic fallback.
- A successful fallback appears in `getState()[kind].active` as `engine: "platform"`, with `locality` and `reason`. Use this state to label the microphone and playback controls. If both engines fail, `fallbackError` describes the browser side. The selected model and its download remain visible in `state.selected` and `voxxy.models`, so another `load()` can retry it. A host can skip loading the model explicitly with `load(kind, { fallbackReason: "…" })`.
- Subscribe to `voxxy.platformModels` and call `optIn("stt")` from the language-pack install button. Download progress is indeterminate. Call `load("stt")` again to use the installed pack. A browser may require a fresh gesture when reinstalling a pack. The install button can retry a failed attempt. The browser owns pack storage and may finish a download after the library stops waiting for it.
- `voxxy/stt/platform` and `voxxy/tts/platform` expose the standalone factories and side-effect-free capability detection. The presence of the API is separate from pack or voice availability. Start recognition and speech from user gestures and handle browser errors even after `load()` succeeds.

The browser fallback controls in the stand's `real.html` let you change each demo session's policy and see which engine is active. The browser's actual recognition and audio output, offline recognition, and gesture behavior on mobile need a device run.

## Microphone (push-to-talk)

`createMicRecorder(options)` is the `Recorder` for `workerStt({ recorder })`. The host never calls it directly: it calls `voxxy.listen()`.

- **Mono 16 kHz out, whatever the device runs at.** The `AudioContext` keeps the device's rate (44.1 or 48 kHz on iOS) and `Resampler` converts: a windowed-sinc low-pass at the lower Nyquist, so downsampling does not fold high frequencies into the speech band. Unit-tested with synthetic tones (accuracy, alias rejection, chunking-independence).
- **Capture:** an `AudioWorklet` (loaded from a Blob URL) where available; otherwise a `ScriptProcessor`, which is deprecated but present everywhere the worklet is not, runs on the main thread, and loses up to one 4096-frame block (~90 ms) at the end of a recording. A page whose CSP forbids `blob:` scripts silently uses the fallback; `preferWorklet: false` forces it.
- **Release:** the stream is stopped when recording ends, so the OS indicator goes away. `idleReleaseMs` keeps it open longer so the next press starts at once, at the price of the indicator staying on. The audio context is suspended between recordings and reused.
- **Call `start()` from a gesture** (the button press): the audio context needs one to run on iOS. Installed iOS PWAs have historically re-prompted for microphone permission more often than browser tabs; unverified here.
- **Typed errors:** `MicrophoneError` with `code`: `permission-denied`, `no-device`, `in-use`, `unsupported` (insecure context), `busy`, `too-short`, `failed`. They reject `session.stop()`.
- **Short taps and length:** a recording under `minDurationMs` (250) rejects with `too-short` instead of returning an empty buffer; audio past `maxDurationMs` (60 s) is dropped and `onLimitReached` fires once, so the host can end push-to-talk.
- **One owner of the microphone.** A second capture while one is active fails with `busy`. The PCM recorder and browser recognizer share the `claimMicrophone(who)` lock.

## Playback

`createWebAudioPlayer(options)` is the `Player` for `workerTts({ player })`. The host calls `voxxy.speak()`, `voxxy.stopSpeaking()` and `voxxy.unlock()`.

- **Gapless.** PCM at any sample rate (24 kHz for many models; the browser resamples) is scheduled on the audio clock: a buffer handed over while another plays starts at exactly its end time. Stopping rejects pending `speak` calls with `AbortError`, silences the sound, and the next one starts fresh.
- **`voxxy.unlock()`** must be called from a user gesture, synchronously, before any `await`. It resumes the audio context, plays a silent one-sample buffer, and applies the silent-switch workaround. Without a gesture, `play()` rejects with `AudioPlaybackError("blocked")` after a second instead of hanging.
- **Silent switch (iOS mutes WebAudio when the hardware switch is on).** `silentSwitch: "auto"` (default) uses `navigator.audioSession.type = "playback"` where it exists (Safari 16.4+); otherwise, on iOS only, it starts a looping silent `<audio>` element inside the gesture. `"audio-session"`, `"audio-element"` and `"off"` force a choice. `player.silentSwitchUsed` says which ran. The silent element keeps playing until `dispose()`; its effect on battery and the lock-screen "now playing" card is not verified.
- **Events:** `player.on("started" | "chunk-finished" | "drained", handler)`. `chunk-finished` carries `{ startTime, endTime }` on the audio clock.
- Platform TTS has its own gesture rules; `voxxy.unlock()` calls every selected provider's optional `unlock()`, so it will cover both.

### Not verified on real hardware

- iOS: whether the microphone permission prompt repeats in an installed PWA; the real `AudioContext` rate; that `audioSession` or the silent `<audio>` element makes WebAudio audible with the silent switch on; behaviour when the tab is backgrounded mid-recording or mid-speech; lock-screen and battery effects of the silent element.
- Android: nothing beyond Chromium on desktop was run. Pixel 5 and Pixel 7 Pro are still to be tested.
- What was run: Chromium (fake microphone fixture, real `AudioContext`) and Firefox (player only). Safari and WebKit: not run.

## Asset strategy

Each adapter has its own entry point and its own worker script: `voxxy/stt/<name>` exports the provider factory, and the worker script is `dist/stt/<name>.worker.js`. The factory reaches it with the literal form

```ts
new Worker(new URL("./dummy.worker.js", import.meta.url), { type: "module" });
```

which is what bundlers recognise and turn into an emitted asset. A host that imports one adapter bundles only that adapter and its worker. There is no shared registry.

Overrides, per provider, for hosts that serve assets themselves:

- `dummyStt({ workerUrl })` uses your worker script instead.
- `wasmBaseUrl` is passed to the adapter's `load()` as `context.wasmBaseUrl`, to locate its WASM runtime files. (No adapter reads it yet.)
- To write your own worker: `serveStt(createAdapter, self)` or `serveTts(createAdapter, self)` from `voxxy/serve`.

### Verified and known limits

- **Verified:** build with Vite 8 (`apps/stand`), production preview in Chromium and Firefox. Each provider's worker is emitted as its own asset.
- **Not verified:** webpack, Rspack, Parcel, esbuild-only setups, Next.js, Safari, any real phone.
- **Known to break in general, not tested here:**
  - Bundlers that do not recognise `new Worker(new URL(...))` leave a URL that points at a file nobody served. Use `workerUrl`.
  - Module workers (`type: "module"`) need Safari 15+ and Firefox 114+.
  - The Vite dev server pre-bundles dependencies from `node_modules`; if the package is installed from npm (not linked), exclude it with `optimizeDeps.exclude: ["voxxy"]` or the worker URL may be rewritten wrongly. Not tested here, since the stand uses a workspace link.
  - COOP/COEP and WASM threads are the host's responsibility and are not touched by this layer.

## Long text and replies that are still being written

**`voxxy.speak(text)` streams by itself.** A text of any length is cut into sentences, queued one behind the other, and synthesised as the pipeline has room, so sound starts after the *first* sentence and only about two sentences of audio are ever held in memory. Measured on a 4,999-character page of *The Great Gatsby* (36 sentences, 308 s of speech) with Paradee in Node: first sound after 0.9 s; the whole text takes 16.5 s to synthesise at 19x real time, with never more than two buffers at the player. Handing the same text to the adapter in one piece would have been silent for 16 s and held 29 MB of audio. The promise resolves when the last sentence has finished playing; a failure, `stopSpeaking()` or the call's signal drops all the sentences of that call. The cutting is tunable with `splitter` on `workerTts` / `paradeeTts` (the same options as below). This is for PCM providers; platform engines queue natively.

**Chunk size is a trade-off, and the knobs are `firstMinChars`, `minChars` and `maxChars`.** Every chunk is one model run and, with Paradee, starts with about 0.3 s of quiet. Kokoro's authors say their voices are best on 100–200 tokens and weak on very short utterances, and Paradee is distilled from Kokoro. So the splitter can pack sentences: `{ firstMinChars: 30, minChars: 120 }` sends a short first chunk (sound starts early) and packs the rest into chunks of about 120 characters or more, never past `maxChars`. Fewer chunks means fewer quiet moments and a smoother flow, and it makes a wrong cut at an abbreviation ("Dr." / "Smith") harmless unless it lands exactly on a chunk edge. **Two things keep that packing honest.** (1) *Lengths are counted in speech, not characters* (`speechWeight`): a digit counts as 5 and a symbol like `%` as 6, because a digit is read as a word ("7" is "seven") — 80 digits are 115 characters on the page and 28 seconds of speech, and used to hold the first sound back for 1.5 s; now the first chunk is "The constant is" and sound starts after 0.09 s. (2) *No silence from a big chunk after a small one*: a chunk takes time to synthesise, and if the one before it is short, the listener hears a hole. `pcmSpeaker` times each synthesis, works out how many times faster than speech the device is, and lets each chunk be at most what the previous chunk's playing time can cover (with a 20% margin): on a fast device chunks go straight to their full size, on a slow one they grow step by step (a test on a modelled device 3× faster than speech: the second chunk is 79 characters, not 300, and the total silence is zero). A sentence too long for that is cut at a comma or a space, never into pieces under 40. On a device slower than speech nothing helps, so it keeps the configured sizes. Chunks are made one at a time for this reason: the next size is decided from how fast the last one was.

The default is still `minChars: 10` (only tiny fragments are mended), because whether packed chunks sound better *to the ear* for Paradee is not measured: word error rate and speed cannot tell. The stand's "Chunking" control lets you compare. Chunk counts, from the splitter alone: a page of *Gatsby* (long sentences, 36 of them) gives 36 chunks one sentence at a time, 30 packed to about 120 characters, 17 packed to about 300; a six-sentence instruction text gives 6 against 2.

`voxxy.speakStream(options?)` is the same idea for text that is not all there yet: it takes text deltas as they arrive and speaks them sentence by sentence, so the first sentence sounds before the reply is complete.

```ts
const stream = voxxy.speakStream();
for await (const token of reply) await stream.push(token); // awaiting it lets the speech set the pace
await stream.end();                                        // resolves when the last sentence has finished playing
// or, if the user interrupts or a new reply starts:
stream.cancel();                                           // drops what is waiting, stops the sound, end() rejects with AbortError
```

It only calls the active provider's `speak()` once per sentence and relies on those calls queueing (the 01b guarantee), so it works with every provider: a PCM model synthesises the next sentence while the current one plays, a platform engine queues natively. No player or adapter is touched.

- **Back-pressure.** At most `maxInFlight` sentences (default 2: the one playing and one behind it) are with the provider, which bounds the audio held in memory. Up to `maxPending` (8) finished sentences wait in the stream; past that `push()` waits, so awaiting it in a loop over a token stream keeps a fast model from running far ahead of the voice.
- **Splitting** (`SentenceSplitter`, usable alone). A sentence ends at `. ! ? …` followed by a space, but not inside decimals, versions or URLs ("3.5", "v1.2.3", "example.com"), after an initial ("J. K. Rowling"), after a title or abbreviation ("Dr.", "e.g."), or when the next word starts with a lower-case letter or a digit. **Line breaks** (`newlines`, default `"smart"`): a break ends a sentence after a line that ends with `. ! ? … : ;`, before a blank line, before a list marker (`- `, `1. `, `#`, `>`), and between short lines (headings, verse, under 40 characters). A line that stops without punctuation and is long, or is followed by a lower-case word, was cut at the margin of hard-wrapped text (an e-mail, a PDF), so the sentence goes on. `"break"` ends a sentence at every line break, `"space"` treats a break as a space. A run with no end is cut after `maxChars` (220), at a pause if it has one. **A sentence only a little over a limit (up to 25%) is kept whole** rather than cut into an orphan: "…turning over in my mind ever" / "since." was exactly that. **The very first chunk is held to `firstMaxChars` (120)**, cut at a comma or dash if it must, because the wait before the first sound is the time to synthesise that chunk: a 336-character first sentence took 1.1 s to start (about 0.3 s once cut), and several seconds more on a slower device. A sentence shorter than `minChars` (10) is joined to the next, since speech models do poorly on tiny utterances. A sentence end is recognised only once the character after it has arrived, so the last sentence waits for `end()`. The result does not depend on how the text was cut into deltas (tested down to one character at a time, and on 2,400 random texts).
- **The abbreviation lists are mine, not from a library or a corpus.** `src/sentences.ts` has two short lists written from general knowledge of English: ones that never end a sentence (titles, `e.g.`, `vs.`) and ones that do only before a capital letter (`etc.`, `Inc.`, `a.m.`). They are covered by a handful of tests, not measured on real text. Some entries are ambiguous by nature ("St." is a saint or a street; "Jr." can end a sentence), and the rules are English only.
- **Markdown.** Each sentence goes through `stripMarkdown` first (emphasis marks, code ticks, heading and list markers, link targets), so the voice does not read "asterisk asterisk". Pass `normalize` to replace it.
- **Measured with a simulated stream** (about 40 tokens a second, Moonshine and Paradee in Chrome on the development machine): sound starts 0.26 s after the first token, while the reply is still arriving (complete at 1.38 s). Speaking the finished reply in one call would start sound at about 2.3 s: 1.4 s waiting for the reply plus 0.9 s to synthesise it whole. The gap grows with the length of the reply.

## Speech engines

Both run on `onnxruntime-web` (MIT) in the provider's own worker, **one thread**: no `SharedArrayBuffer`, so no COOP/COEP. Each is a separate entry point, so a host that imports one does not bundle the other.

```ts
import { createMicRecorder, createVoxxy, createWebAudioPlayer } from "voxxy";
import { moonshineStt } from "voxxy/stt/moonshine";
import { paradeeTts } from "voxxy/tts/paradee";

const voxxy = createVoxxy();
voxxy.select(moonshineStt({ recorder: createMicRecorder() }));
voxxy.select(paradeeTts({ player: createWebAudioPlayer() }));
voxxy.models.getState().stt.downloadSize;  // show it, then on "yes": voxxy.models.optIn("stt"), optIn("tts")
await voxxy.load("stt"); await voxxy.load("tts");
```

Why `onnxruntime-web` directly instead of `browser-whisper` or transformers.js: the planning notes suggested `browser-whisper`, but it is a thin layer over transformers.js (and pulls `mediabunny`, an audio decoder we do not need), and transformers.js brings every architecture, `sharp` and `onnxruntime-node` with it. Both models here are one or two ONNX graphs plus a small decode loop, so running them on the runtime directly keeps one MIT dependency, lets weights come from our Cache API storage (consent, verified sizes, eviction recovery) as plain bytes, and lets the two engines share one runtime binary. The cost is that the Moonshine decode loop and the Paradee phonemiser are ours to maintain.

The runtime's wasm (`ort-wasm-simd-threaded.wasm`, 14.8 MB, 3.2 MB brotli on the wire) is declared as one of each provider's files, so it goes through the same consent and caching instead of being fetched behind the host's back. It is the same URL for both, so it is stored once, but each provider's `downloadSize` includes it: the two sizes add up to more than the real total. By default it comes from jsDelivr, pinned to the version; `wasmBaseUrl` points it at your own copy.

### Moonshine tiny (speech to text)

English only, MIT. `moonshineStt({ recorder, variant?, baseUrl?, wasmBaseUrl? })`. The encoder turns the waveform into features once; the merged decoder runs token by token with a key/value cache, greedy, at most 6.5 tokens per second of audio. Tokenizer decoding (SentencePiece-style BPE with byte fallback) is ours; it needs only the vocabulary.

| File (Hugging Face commit `a6da124`) | Bytes |
|---|---:|
| `onnx/encoder_model_q4.onnx` | 10,732,274 |
| `onnx/decoder_model_merged_uint8.onnx` | 20,189,543 |
| `tokenizer.json` | 3,761,754 |
| runtime wasm | 14,848,852 |
| **Total declared** | **49,532,423** |

**Quantisation: the all-8-bit files are broken for this model, so the default is a mix.** Tried on the JFK clip in Node:

| Encoder + decoder | Model files | Result |
|---|---:|---|
| `int8` + `int8`, or `uint8` + `uint8` | 28 MB | stops after a few words: "And so my fellow American" |
| `uint8` + `q4` | 52 MB | garbage ("And so my dad and not like your country...") |
| `q4` + `q4` | 55 MB | "And so my fellow-american asked not what your country can do for you, ask what you can do for your country." |
| **`q4` + `uint8` (variant `compact`, default)** | **31 MB** | "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country." |

An 8-bit encoder is what breaks it. `variant: "q4"` is available for the all-4-bit pair.

### Paradee 8M v1.3 (text to speech)

American English voices `af_heart` (default) and `am_puck`, Apache-2.0, 24 kHz. `paradeeTts({ player, voice?, speed?, baseUrl?, lexiconBaseUrl?, g2pBaseUrl?, wasmBaseUrl?, maxAhead? })`. Text is split into sentences, each is phonemised, and the phoneme ids go through one ONNX graph (`input_ids`, `speed`, `voice` in; `waveform` out).

**The phonemiser is the real work, and it is ours.** Paradee only understands misaki's phoneme spelling, and the browser demo in its repository phonemises with eSpeak NG, which is GPL-3.0 and cannot ship here. So `src/tts/paradee/` is a JavaScript port of the dictionary half of misaki's English G2P (`misaki/en.py`, Apache-2.0): the gold and silver lexicons, suffix stemming, stress rules and number reading (including a small English `num2words`), plus Paradee's own 0.76M-parameter G2P model (`g2p.onnx`, which Paradee's author trained on eSpeak's output) for words the dictionaries lack. No eSpeak at any point.

**Text is made sayable first** (`tts/paradee/speakable.ts`). The model has never heard a URL: "https://example.com/path/to/…?query=1&other=2" came out as seven seconds of babble ("CH tips, Xample, Combat Towson…"), "foo.bar.baz()" as "Few Bar Baths", and file names lost their dots. Now links become "a link to example dot com" (the path and query are not read; a bare "example.com" is "example dot com"), addresses "first dot last at example dot co dot uk", files "report final v2 dot pdf", code "foo dot bar dot baz", flags and snake_case lose their dashes and underscores, and a dot with a letter on both sides and no space after it ("hello.How are you", "Mr.Smith") is a missing space. After the change the same text is heard as "See a link to example dot com or write to first dot last at example dot co dot uk or run foo dot bar dot baz…". These are plain pattern matches on common cases: they do not know every domain ending or file type, and ambiguous short endings ("it", "in", "me", "us") are left alone because "end.in" is more likely a typo.

**Quiet around an utterance.** Measured on the model's output: every utterance begins with 0.27–0.36 s of silence and ends with 0.40–0.47 s, so two utterances are about 0.75 s apart. That is why a chunk goes through the model whole (`splitSentences: false`): inside one run the pauses between sentences are 0.15–0.35 s, and the padding appears once per chunk. Trimming the leading quiet was tried and removed: with whole chunks it saved about 0.09 s of a first sound at ~400 ms, which nobody heard.

What the port leaves out: misaki uses spaCy to tag each word with its part of speech and picks between pronunciations of one spelling with it ("read", "lead", "live"); here those get their default pronunciation, and a handful of function words ("a", "the", "to", "in", "used", "I") and numbers are tagged by rule. Letters outside A–Z (accents, other scripts) are not in the dictionaries and go to the G2P model, which is not trained for them: "Ünïcödé" came out as "Unique her day". Other languages and the British voices need other data (Spanish for es-MX is the next step).

| File | Bytes |
|---|---:|
| Paradee `onnx/paradee_int8.onnx` (HF commit `b569f5e`) | 8,462,503 |
| Paradee `config.json` (vocabulary) | 2,103 |
| misaki `us_gold.json` (commit `fba1236`) | 3,000,469 |
| misaki `us_silver.json` | 3,099,517 |
| Paradee `g2p.onnx` (GitHub commit `2de547e`) | 919,774 |
| Paradee `g2p.json.gz` | 1,176,866 |
| runtime wasm | 14,848,852 |
| **Total declared** | **31,510,084** |

#### Measured

On the development machine (desktop Linux, Chrome 157, one thread, fast network). Not representative of phones.

| | Moonshine | Paradee |
|---|---|---|
| Transferred on first run, real wire bytes (both together, wasm once) | 47.1 MB (Hugging Face 40.0, GitHub 3.5, jsDelivr 3.2, the stand's own page and clip 0.4) | |
| Download and verify, both | 7.6 s | |
| Load into the runtime | 0.49 s | 0.63 s |
| Work | 11 s clip in 0.39 s (about 28x real time) in the browser; 0.44 s in Node | one 16-word sentence: sound scheduled 0.35 s after `speak()`; 18-19x real time in Node |
| Accuracy check | JFK clip transcribed correctly | 8 sentences synthesised, then transcribed by Moonshine: word error rate 2.9%, all of it number and abbreviation formatting ("9:00", "third", "Doctor") |

Peak memory was not measured; iPhone and Android timings are not measured yet.

#### Licences

| What | Licence |
|---|---|
| `onnxruntime-web` and its runtime dependencies | MIT, Apache-2.0, BSD-3-Clause, ISC |
| Moonshine tiny weights (`onnx-community/moonshine-tiny-ONNX`) | MIT |
| Paradee model and code | Apache-2.0 (model card, `LICENSE` file, GitHub licence API) |
| Kokoro-82M, Paradee's teacher | Apache-2.0. Its card says it was trained only on permissive or non-copyrighted audio; the CC BY items it lists (SIWIS for French, Koniwa for Japanese) are not the `af_heart` or `am_puck` voices |
| misaki code | Apache-2.0 |
| misaki English dictionaries (`us_gold.json`, `us_silver.json`) | **Provenance not documented.** The repository is Apache-2.0 as a whole, but nothing says where the word lists came from. Used as they are; revisit if the origin turns out to carry other terms |
| Paradee's G2P data | Apache-2.0 per the repository; "learned from eSpeak NG's output" (output, not code, but worth knowing). Its training sentences are CC BY-SA 3.0, and are not shipped here |

### Not verified

- Phones: iOS and Android speed, memory, the Cache API behaviour for a 31–50 MB download (see below), and whether 8-bit-vs-4-bit choices change anything on ARM.
- Threaded WASM: never tried; the runtime file supports it, `numThreads` is pinned to 1.
- WebKit and Safari: nothing ran there.
- Other bundlers than Vite 8 for the runtime's wasm (Vite emits it as an asset on its own).
- Speech with background noise or accents (only clean test clips and Paradee's own voice were heard by Moonshine).

## Acquisition: consent, download, storage

"The user must get something onto the device first" is one concept, whoever does the downloading. A provider declares at most one acquisition:

- **`files`**: we download, verify and cache them. Size is known, progress is determinate.
- **`install`**: the platform does it (for example the browser's on-device recognition language pack). `check()` is side-effect free and returns `{ status: "ready" | "installable" | "unavailable", reason? }`; `install(signal)` does it. Size and progress are usually unknown (`total` is `null`). We cannot verify or evict it, but `check()` answering `installable` for something that was `ready` is noticed as an eviction. If the platform offers no install (voices for `speechSynthesis`), the provider has only `check()`, and `installable` counts as `unavailable`.
- **Neither**: no consent step; `load()` runs at once.

`voxxy.models` handles all of them with the same consent record, the same phases and the same events:

```ts
voxxy.models.getState().stt.downloadSize;       // number, or null when unknown; show it, then on "yes":
await voxxy.models.optIn("stt");                // consent stored, background download or install starts
voxxy.models.subscribe((s) => draw(s.stt.phase, s.stt.progress)); // collapsed indicator; re-expand any time
await voxxy.load("stt");                        // throws ModelNotReadyError without consent; downloads first if consent exists but files are gone
```

Phases: `not-opted-in`, `opted-in-not-downloaded`, `downloading`, `ready`, `evicted-redownloading`, `unavailable` (a final answer from `check()`, with `reason`; `ensure()` throws `ModelUnavailableError`), `error` (something that should have worked failed). STT and TTS are separate. Consent is per kind **and** provider id, since a different model has a different size. Nothing is ever installed or downloaded before the user's opt-in.

- **`check()` is the source of truth for `install` providers.** It runs when the provider is registered and again inside `ensure()`; a cached `ready` is never trusted. An install call that returns is checked again before it counts.
- **One acquisition per instance, fixed for its lifetime.** Where one engine can run in two modes with different needs (platform STT on-device versus cloud), a module offers two instances from one factory, so `locality` is static per instance too. Which one becomes active is the host's choice or the fallback policy (task 15), never `ensure()`.
- **Consent is stored apart from the weights** (localStorage by default, pluggable via `models.consent`; memory fallback where it is missing). `hasBeenReady` tells an eviction from a download that never finished. On start-up, consent without files restarts the download with progress; the user is not asked again.
- **Weights live in the Cache API, not OPFS.** It works the same in a window and a worker (adapters read the files by the provider's URL through `context.models`), and `cache.put()` of a streamed response is all-or-nothing, so a partial file never looks finished. OPFS needs `createWritable` (Safari only from 26) or worker-only sync handles. Both are evicted together by the browser.
- **Resume is per file.** Finished files are skipped; the partial one restarts. Every file is checked against its declared size while streaming (a short or long file fails the write and nothing is stored), and the stored size is re-checked at start-up, which is cheap because it reads a header, not the body. An optional `sha256` is checked after download; it reads the whole file into memory, so use it on small files.
- **`navigator.storage.persist()` is called at opt-in for `files` and never awaited before the download.** Firefox shows a prompt and answers only when the user does. `state.persisted` is `true`, `false` (denied) or `null` (unavailable, or no answer yet). It is not asked for platform installs: their storage is not ours.
- **Self-hosting:** `models.rewriteUrl` maps a provider's file URL to your CDN. The cache key stays the original URL, so adapters are unaffected.

### Not verified without a real Safari / iOS device

- Whether `persist()` is granted, and how much it protects, in Safari and an installed iOS PWA. Safari's ~7-day eviction of storage for sites not visited is described by Apple but was not observed here.
- Whether the Cache API streams a 50 MB `put()` to disk or buffers it in memory in iOS Safari (this decides peak memory during download).
- Cache API quota on iOS for a ~60 MB download, and what an out-of-quota failure looks like (it should surface as phase `error`).
- Behaviour when the tab is suspended or killed mid-download (expected: resumes per file on the next visit; not observed).
- Playwright's WebKit does not launch on the development machine (see `TESTING.md`), so nothing was run in WebKit at all.
- `install` acquisitions have been exercised against fakes. The real `SpeechRecognition.install()` and offline recognition still need a device run.

Checked: Chromium and Firefox through the stand (opt-in, reload, eviction, independent kinds, load gating; interruption in Chromium only).

The dummy providers take `{ files: true }` to declare fake downloadable files for tests. The stand serves them at `/dummy-models/`.
