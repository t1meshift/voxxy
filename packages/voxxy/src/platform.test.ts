import { afterEach, describe, expect, it, vi } from "vitest";
import { claimMicrophone, microphoneOwner } from "./audio/errors.js";
import { createVoxxy } from "./client.js";
import { createMemoryConsentStore } from "./models/consent.js";
import type { TtsProvider } from "./provider.js";
import { detectPlatformStt, platformStt } from "./stt/platform.js";
import { detectPlatformTts, platformTts } from "./tts/platform.js";

afterEach(() => vi.unstubAllGlobals());

class Recognition extends EventTarget {
  static available = vi.fn<() => Promise<string>>();
  static install = vi.fn<() => Promise<boolean>>();
  static last: Recognition;
  get processLocally() { return this.local; }
  set processLocally(value: boolean) { this.local = value; }
  private local = false;
  start() { Recognition.last = this; }
  abort() { this.dispatchEvent(new Event("end")); }
  stop() {
    const result = Object.assign(new Event("result"), {
      resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Hello browser" } }],
    });
    this.dispatchEvent(result);
    this.dispatchEvent(new Event("end"));
  }
}

function recognition() {
  Recognition.available.mockReset().mockResolvedValue("downloadable");
  Recognition.install.mockReset().mockImplementation(async () => {
    Recognition.available.mockResolvedValue("available");
    return true;
  });
  vi.stubGlobal("webkitSpeechRecognition", Recognition);
}

function synthesis(initial: SpeechSynthesisVoice[] = []) {
  class Utterance {
    constructor(readonly text: string) {}
  }
  let voices = initial;
  let playing: SpeechSynthesisUtterance | undefined;
  const synth = Object.assign(new EventTarget(), {
    getVoices: () => voices,
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => { playing = utterance; }),
    cancel: vi.fn(() => { playing = undefined; }),
  });
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", synth);
  return {
    synth,
    setVoices(next: SpeechSynthesisVoice[]) {
      voices = next;
      synth.dispatchEvent(new Event("voiceschanged"));
    },
    finish: () => playing?.onend?.(new Event("end") as SpeechSynthesisEvent),
  };
}

const english = (localService: boolean): SpeechSynthesisVoice => ({
  localService, lang: "en-US", name: "English", voiceURI: "english", default: true,
});

describe("browser detection and fallback policy", () => {
  it("reports missing APIs without trying to use them", async () => {
    expect(detectPlatformStt()).toEqual({ local: false, cloud: false });
    expect(detectPlatformTts()).toBe(false);
    const voice = createVoxxy();
    await expect(voice.load("stt")).rejects.toThrow();
    await expect(voice.load("tts")).rejects.toThrow();
    expect(voice.getState().stt).toMatchObject({ active: null, fallbackError: "On-device browser recognition is unavailable" });
    expect(voice.getState().tts).toMatchObject({ active: null, fallbackError: "Browser speech synthesis is unavailable" });
  });

  it("detects recognition without language-pack methods", async () => {
    vi.stubGlobal("SpeechRecognition", class extends EventTarget {
      start() {}
      stop() {}
      abort() {}
    });
    expect(detectPlatformStt()).toEqual({ local: false, cloud: true });
    const voice = createVoxxy();
    await voice.load("stt");
    expect(voice.getState().stt.active).toMatchObject({ engine: "platform", locality: "cloud" });
  });

  it("reports a load failure, keeps the model selected and uses the browser voice", async () => {
    synthesis([english(false)]);
    const voice = createVoxxy();
    const model: TtsProvider = {
      kind: "tts", id: "model", engine: "worker", locality: "local",
      load: async () => { throw new Error("Out of memory"); },
      unload: vi.fn(async () => {}), speak: async () => {}, stop() {},
    };
    voice.select(model);
    await voice.load("tts");
    expect(model.unload).toHaveBeenCalled();
    expect(voice.getState().tts).toMatchObject({
      selected: { id: "model" }, active: { engine: "platform", locality: "cloud", reason: "Out of memory" },
    });
    expect(voice.models.getState().tts.provider).toBe(model);
  });

  it("rejects a network voice under local-only and skips detection under off", async () => {
    const { synth } = synthesis([english(false)]);
    const voices = vi.spyOn(synth, "getVoices");
    const off = createVoxxy({ platformFallback: { tts: "off" } });
    await expect(off.load("tts")).rejects.toThrow();
    expect(voices).not.toHaveBeenCalled();
    const local = createVoxxy({ platformFallback: { tts: "local-only" } });
    await expect(local.load("tts")).rejects.toThrow();
    expect(local.getState().tts).toMatchObject({ active: null, fallbackError: "No local browser voice for en-US" });
  });

  it("uses cloud before opt-in, prefers the installed pack and exposes the active engine", async () => {
    recognition();
    const voice = createVoxxy({ models: { consent: createMemoryConsentStore() } });
    await voice.load("stt");
    expect(Recognition.install).not.toHaveBeenCalled();
    expect(voice.getState().stt.active?.locality).toBe("cloud");
    expect(voice.platformModels.getState().stt.phase).toBe("not-opted-in");
    await voice.platformModels.optIn("stt");
    await voice.load("stt");
    expect(Recognition.install).toHaveBeenCalledWith({ langs: ["en-US"], processLocally: true });
    expect(voice.getState().stt.active?.locality).toBe("local");
    const session = voice.listen();
    expect(Recognition.last.processLocally).toBe(true);
    expect(await session.stop()).toBe("Hello browser");
    Recognition.available.mockResolvedValue("downloadable");
    await voice.load("stt");
    expect(Recognition.install).toHaveBeenCalledTimes(2);
    expect(voice.getState().stt.active?.locality).toBe("local");
  });

  it("exposes the missing language pack under local-only", async () => {
    recognition();
    const voice = createVoxxy({ platformFallback: { stt: "local-only" }, models: { consent: createMemoryConsentStore() } });
    await expect(voice.load("stt")).rejects.toThrow();
    expect(voice.getState().stt).toMatchObject({ active: null, fallbackError: "Browser recognition needs a language pack for en-US" });
    expect(Recognition.install).not.toHaveBeenCalled();
  });
});

describe("browser provider sessions", () => {
  it("shares the microphone lock and releases it on cancellation without waiting for end", async () => {
    recognition();
    const provider = platformStt({ locality: "cloud" });
    await provider.load();
    const release = claimMicrophone("worker recorder");
    try {
      expect(() => provider.listen()).toThrow("already in use");
    } finally {
      release();
    }
    const session = provider.listen();
    expect(microphoneOwner()).toBe(provider.id);
    session.cancel();
    await expect(session.stop()).rejects.toMatchObject({ name: "AbortError" });
    expect(microphoneOwner()).toBeNull();
  });

  it("waits for voices and plays queued calls in order after cancelling one", async () => {
    const browser = synthesis();
    const provider = platformTts();
    const loading = provider.load();
    browser.setVoices([english(true)]);
    await loading;
    const abort = new AbortController();
    const first = provider.speak("First.", { signal: abort.signal });
    const second = provider.speak("Second.");
    const pending = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(browser.synth.speak).toHaveBeenCalledTimes(1));
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(browser.synth.speak).toHaveBeenCalledTimes(2));
    expect(browser.synth.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual(["First.", "Second."]);
    expect(browser.synth.cancel).toHaveBeenCalledTimes(1);
    browser.finish();
    await expect(second).resolves.toBeUndefined();
  });
});
