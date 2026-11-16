export { createVoxxy } from "./client.js";
export type {
  ActiveProvider,
  CallOptions,
  KindState,
  LoadOptions,
  LoadStatus,
  PlatformFallbackPolicy,
  SelectOptions,
  Voxxy,
  VoxxyOptions,
  VoxxyState,
} from "./client.js";

export type {
  Engine,
  ListenOptions,
  Locality,
  Provider,
  ProviderInfo,
  ProviderLoadContext,
  SpeakOptions,
  SttProvider,
  SttSession,
  TtsProvider,
} from "./provider.js";

export { SentenceSplitter, speechWeight } from "./sentences.js";
export type { SplitterOptions } from "./sentences.js";
export { createSpeakStream, stripMarkdown } from "./speak-stream.js";
export type { SpeakStream, SpeakStreamOptions, Speaker } from "./speak-stream.js";
export { pcmListener, pcmSpeaker } from "./pcm.js";
export type { ChunkInfo, Player, Recorder, RecordingHandle } from "./pcm.js";
export { createMicRecorder } from "./audio/recorder.js";
export type { MicRecorder, MicRecorderOptions } from "./audio/recorder.js";
export { MicrophoneError, claimMicrophone, microphoneOwner } from "./audio/errors.js";
export type { MicrophoneErrorCode } from "./audio/errors.js";
export { Resampler, resample, STT_SAMPLE_RATE } from "./audio/resample.js";
export { AudioPlaybackError, createWebAudioPlayer } from "./audio/player.js";
export type { ChunkTiming, PlayerEvents, SilentSwitchMode, WebAudioPlayer, WebAudioPlayerOptions } from "./audio/player.js";
export { workerStt, workerTts } from "./worker-providers.js";
export type { WorkerSttOptions, WorkerTtsOptions } from "./worker-providers.js";

export { createModelManager } from "./models/manager.js";
export { createCacheApiFileCache } from "./models/cache.js";
export { createLocalStorageConsentStore, createMemoryConsentStore } from "./models/consent.js";
export { ModelNotReadyError, ModelUnavailableError } from "./models/types.js";
export type {
  Acquirable,
  CheckResult,
  CheckStatus,
  ConsentRecord,
  ConsentStore,
  DownloadProgress,
  FileCache,
  InstallAcquisition,
  ModelFile,
  ModelFileReader,
  ModelManager,
  ModelManagerOptions,
  ModelPhase,
  ModelsState,
  ModelState,
} from "./models/types.js";

export type { AdapterLoadContext, Kind, SpeechResult, SttAdapter, TtsAdapter } from "./types.js";
