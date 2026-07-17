import { fullSha256, type FingerprintWorkerResponse } from "./media-hash";

// DOM lib types `self` as Window; narrow it to the worker surface used here.
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<File>) => void) | null;
  postMessage: (message: FingerprintWorkerResponse) => void;
};

workerScope.onmessage = (event) => {
  void fullSha256(event.data, (fraction) => workerScope.postMessage({ type: "progress", fraction }))
    .then((digest) => workerScope.postMessage({ type: "done", digest }))
    .catch((error: unknown) =>
      workerScope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "The file could not be fingerprinted.",
      }),
    );
};
