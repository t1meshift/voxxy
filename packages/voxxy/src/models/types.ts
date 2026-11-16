import type { Kind } from "../types.js";

/** One weight (or runtime) file an adapter needs. */
export interface ModelFile {
  /**
   * Where the file comes from by default. Also the key it is stored under, so
   * adapters read it back by this same string even when the host serves it
   * from another place (see `rewriteUrl`).
   */
  url: string;
  /** Exact size in bytes. A download of any other size is rejected. */
  size: number;
  /**
   * Optional SHA-256, lowercase hex. Checked once, after the download. WebCrypto
   * cannot hash a stream, so this reads the whole file into memory: use it for
   * small files, or when integrity matters more than peak memory.
   */
  sha256?: string;
}

/**
 * The answer of `InstallAcquisition.check()`: `ready` (already on the device), `installable` (the user can opt in
 * and the platform will install it) or `unavailable` (cannot be used here).
 */
export type CheckStatus = "ready" | "installable" | "unavailable";

/** What `InstallAcquisition.check()` resolves to. */
export interface CheckResult {
  /** Whether the thing is present, can be installed, or is out of reach. */
  status: CheckStatus;
  /** Why it is unavailable (or cannot be installed), in words the host can show. */
  reason?: string;
}

/**
 * Something the platform installs for us, such as the browser's on-device
 * recognition language pack. We cannot verify or evict it; the browser or OS owns it.
 */
export interface InstallAcquisition {
  /** Side-effect free: no prompts, no downloads. The source of truth, asked again whenever the state matters. */
  check(): Promise<CheckResult>;
  /**
   * Starts the installation and resolves when it is done. Called only after the
   * user's opt-in. Absent where the platform offers no way to install (voices
   * for `speechSynthesis`): then `"installable"` is treated as `"unavailable"`
   * and there is no consent step. Progress is usually unknown (`total` null).
   */
  install?(signal: AbortSignal, onProgress?: (loaded: number, total: number | null) => void): Promise<void>;
}

/**
 * What the model manager needs from a provider: what must be on the device first.
 * At most one of `files` (we download, verify and cache) and `install` (the platform does it).
 */
export interface Acquirable {
  readonly kind: Kind;
  readonly id: string;
  /** Approximate size for the consent text. For `files` the sum of their sizes is used when this is absent. */
  readonly downloadSize?: number | null;
  readonly files?: readonly ModelFile[];
  readonly install?: InstallAcquisition;
}

/** Where weights live. The default implementation uses the Cache API. */
export interface FileCache {
  /** Size recorded when the file was stored, or null if it is absent. Cheap: does not read the body. */
  stat(url: string): Promise<number | null>;
  /**
   * Stores the stream under `url`. All or nothing: if the stream errors, nothing
   * is left behind, so a partly written file never looks finished.
   */
  write(url: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>;
  read(url: string): Promise<Response | null>;
  delete(url: string): Promise<void>;
}

/** What the host or adapter may read; a subset of `FileCache`. */
export type ModelFileReader = Pick<FileCache, "read">;

/** What was agreed. Kept apart from the weights so it survives their eviction. */
export interface ConsentRecord {
  optedInAt: number;
  /** True once all files were verified at least once. Tells "never finished" from "evicted". */
  hasBeenReady: boolean;
}

/**
 * Where the user's choices are remembered, per kind and per adapter. The default keeps them in `localStorage`
 * (with an in-memory fallback), and `createMemoryConsentStore()` suits tests. Provide your own to keep them
 * elsewhere, for example on a server.
 */
export interface ConsentStore {
  /** The stored record, or null if the user has not opted in. */
  get(kind: Kind, adapterId: string): Promise<ConsentRecord | null>;
  /** Stores or replaces the record. */
  set(kind: Kind, adapterId: string, record: ConsentRecord): Promise<void>;
  /** Forgets the choice, so the user is asked again. */
  clear(kind: Kind, adapterId: string): Promise<void>;
}

/** Where one kind's model is: what the host should show, and whether to ask for consent. */
export type ModelPhase =
  /** The user has not agreed to the download yet. Show the consent text and `downloadSize`. */
  | "not-opted-in"
  /** Consent is stored but the files are not here and no download is running. */
  | "opted-in-not-downloaded"
  /** A download is running. See `progress`. */
  | "downloading"
  /** Everything is on the device. */
  | "ready"
  /** Files that were complete are gone (the browser cleared storage), and are being fetched again without asking. */
  | "evicted-redownloading"
  /** A final answer from `check()`: nothing the user can opt into. See `reason`. */
  | "unavailable"
  /** Something that was supposed to work failed. See `error`. */
  | "error";

/** How far a download has got, for a progress indicator. */
export interface DownloadProgress {
  /** Bytes present so far, counting files that were already cached. */
  loaded: number;
  /** Null when unknown, as for most platform installs. */
  total: number | null;
  /** Index (0-based) of the file being fetched, and how many files there are. */
  fileIndex: number;
  fileCount: number;
}

/** Everything the host can show about one kind's model: phase, size, progress and errors. */
export interface ModelState {
  /** The provider registered for this kind, or null. */
  provider: Acquirable | null;
  /** Where the model is, for choosing what to show. */
  phase: ModelPhase;
  /** For the host's consent text. Null when unknown or nothing is selected. */
  downloadSize: number | null;
  /** Set while downloading. */
  progress: DownloadProgress | null;
  /** The message of the failure, in phase `error`. */
  error: string | null;
  /** Set in phase `unavailable`. */
  reason: string | null;
  /** True when files that were once complete are now missing. */
  evicted: boolean;
  /** Result of `navigator.storage.persist()` at opt-in: true granted, false denied, null unavailable or not asked yet. */
  persisted: boolean | null;
}

/** What `voxxy.models.getState()` returns: the model state of recognition and of synthesis. */
export interface ModelsState {
  /** Speech to text. */
  stt: ModelState;
  /** Text to speech. */
  tts: ModelState;
}

/** Options for `createModelManager` and for `createVoxxy({ models })`. All of them are optional. */
export interface ModelManagerOptions {
  /** Where consent is remembered. Default: `localStorage`. */
  consent?: ConsentStore;
  /** Where downloaded files are kept. Default: the Cache API. */
  cache?: FileCache;
  /** Used for every download. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Serve weights from your own CDN: map a descriptor URL to the URL to fetch. The cache key stays the original. */
  rewriteUrl?: (url: string) => string;
  /** Start downloading as soon as consent exists (including after a reload or eviction). Default true. */
  autoDownload?: boolean;
  /** Asks the browser for persistent storage. Default: `navigator.storage.persist()`. */
  persist?: () => Promise<boolean | null>;
  /** Minimum gap between progress notifications, in ms. Default 100. */
  progressIntervalMs?: number;
}

/** Thrown by `ensure()` when the model is not downloaded and the user has not opted in. */
export class ModelNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotReadyError";
  }
}

/** Thrown by `ensure()` when `check()` says the provider cannot run here. `message` is the reason. */
export class ModelUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ModelUnavailableError";
  }
}

/**
 * Owns consent, download and storage of the model files, per kind. It is independent of which provider runs
 * the model. Drive the host's consent popup and its background-download indicator from `getState()`.
 */
export interface ModelManager {
  /** The current state of both kinds. */
  getState(): ModelsState;
  /** Calls `listener` after every change. Returns an unsubscribe function. */
  subscribe(listener: (state: ModelsState) => void): () => void;
  /**
   * Sets the provider for its kind and works out its phase from stored consent and what
   * is present (cached files, or `check()` for an install). Replaces any earlier selection
   * of that kind and stops its download. A provider with neither `files` nor `install`
   * needs nothing and is `ready` at once, with no consent step.
   */
  register(provider: Acquirable): Promise<void>;
  /** Records consent, asks for persistent storage, and starts the download in the background. Resolves once started. */
  optIn(kind: Kind): Promise<void>;
  /** Stops any download, deletes the files and forgets the consent. */
  optOut(kind: Kind): Promise<void>;
  /** Restarts after an error. */
  retry(kind: Kind): Promise<void>;
  /** Re-checks the files. Notices eviction and, with consent, starts re-downloading. */
  refresh(kind: Kind): Promise<void>;
  /** Resolves when the model is ready, downloading it first if consent exists. Rejects with `ModelNotReadyError` without consent. */
  ensure(kind: Kind, options?: { signal?: AbortSignal }): Promise<void>;
}
