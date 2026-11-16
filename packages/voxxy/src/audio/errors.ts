/** Why the microphone could not be used. Carried by `MicrophoneError.code`, so a host can show a message for each case. */
export type MicrophoneErrorCode =
  /** The user (or a policy) refused access. In an installed iOS PWA this can also mean the prompt keeps coming back. */
  | "permission-denied"
  /** No microphone, or none matching the constraints. */
  | "no-device"
  /** The device exists but cannot be opened: another app holds it, or the OS blocked it. */
  | "in-use"
  /** No `getUserMedia`: an insecure context (not https or localhost), or an old browser. */
  | "unsupported"
  /** Another recording, or another engine such as a platform recogniser, already owns the microphone. */
  | "busy"
  /** The recording was shorter than `minDurationMs`; nothing is returned, so no empty buffer reaches a model. */
  | "too-short"
  /** Anything else; `message` and `cause` carry what the browser reported. */
  | "failed";

/** Everything that can go wrong with the microphone, as one type the host can switch on by `code`. */
export class MicrophoneError extends Error {
  readonly code: MicrophoneErrorCode;
  constructor(code: MicrophoneErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MicrophoneError";
    this.code = code;
  }
}

/** Maps what `getUserMedia` throws to a `MicrophoneError`. */
export function mapMediaError(error: unknown): MicrophoneError {
  if (error instanceof MicrophoneError) return error;
  const name = error instanceof Error ? error.name : "";
  const cause = { cause: error };
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return new MicrophoneError("permission-denied", "Microphone access was denied", cause);
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return new MicrophoneError("no-device", "No microphone was found", cause);
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new MicrophoneError("in-use", "The microphone could not be opened; another app may be using it", cause);
    case "TypeError":
      return new MicrophoneError("unsupported", "Microphone capture is not available here (is the page served over https?)", cause);
    default:
      return new MicrophoneError("failed", error instanceof Error ? error.message : "Microphone capture failed", cause);
  }
}

let owner: string | null = null;

/**
 * One owner of the microphone at a time. Our recorder claims it for the length of a recording;
 * the platform STT provider must claim it too, so the two never listen at once.
 * Returns a function that releases the claim. Throws `MicrophoneError("busy")` if it is taken.
 */
export function claimMicrophone(who: string): () => void {
  if (owner !== null) throw new MicrophoneError("busy", `The microphone is already in use by ${owner}`);
  owner = who;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owner = null;
  };
}

/** Who holds the microphone now, or null. For state display and tests. */
export const microphoneOwner = (): string | null => owner;
