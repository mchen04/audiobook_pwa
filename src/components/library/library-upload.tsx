"use client";

import { WarningCircle, X } from "@phosphor-icons/react";
import { ChangeEvent, useCallback, useRef, useState } from "react";

import { importLocalMp3 } from "@/lib/local-import";

export type UploadState = {
  filename: string;
  percent: number;
  stage: string;
};

/**
 * The MP3 import flow: the hidden file input's plumbing and the progress
 * state. Failures are reported through the caller's `reportError`, so the
 * page's one alert region stays owned by the page, not by this hook.
 */
export function useMp3Import(
  userId: string | null,
  onImported: () => Promise<void>,
  reportError: (message: string | null) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);

  const chooseFile = useCallback(() => {
    reportError(null);
    inputRef.current?.click();
  }, [reportError]);

  const handleFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".mp3")) {
        reportError("Choose an MP3 file. Other audiobook formats are not supported.");
        return;
      }
      if (!userId) return;

      reportError(null);
      setUpload({ filename: file.name, percent: 0, stage: "Starting" });
      try {
        await importLocalMp3(userId, file, (percent, stage) =>
          setUpload({ filename: file.name, percent, stage }),
        );
        await onImported();
      } catch (caught) {
        reportError(caught instanceof Error ? caught.message : "The MP3 could not be imported.");
      } finally {
        setUpload(null);
      }
    },
    [userId, onImported, reportError],
  );

  // Rendered by the caller wherever the hidden input belongs in its tree; the
  // ref and change handler never leave this module.
  const fileInput = (
    <input
      ref={inputRef}
      className="visually-hidden"
      type="file"
      accept=".mp3,audio/mpeg,audio/mp3"
      onChange={handleFile}
      tabIndex={-1}
      aria-label="Choose an MP3 file to import"
    />
  );

  return { fileInput, upload, chooseFile };
}

/** The progress banner and the error banner, rendered after the library body. */
export function UploadBanners({
  upload,
  error,
  onDismissError,
}: {
  upload: UploadState | null;
  error: string | null;
  onDismissError: () => void;
}) {
  return (
    <>
      {upload && (
        <div className="upload-status" role="status" aria-live="polite">
          <div>
            <span>
              {upload.stage} · {upload.filename}
            </span>
            <strong>{upload.percent}%</strong>
          </div>
          <progress value={upload.percent} max={100} aria-label={`Importing ${upload.filename}`} />
        </div>
      )}

      {error && (
        <div className="upload-error" role="alert">
          <WarningCircle size={21} weight="fill" aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss error">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
