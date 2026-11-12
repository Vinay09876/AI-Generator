"use client";

import { FileVideo, X } from "lucide-react";
import { formatBytes, formatClock, type LocalVideoMetadata } from "@/features/clipper/client";

/** Local preview of the chosen file (object URL — nothing is uploaded until Generate). */
export function SourcePreview({
  file,
  objectUrl,
  metadata,
  reading,
  error,
  onRemove,
  removable,
}: {
  file: File;
  objectUrl: string;
  metadata: LocalVideoMetadata | null;
  reading: boolean;
  error: string | null;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-white/[0.08] bg-surface">
      <div className="bg-black">
        <video
          src={objectUrl}
          controls
          playsInline
          muted
          preload="metadata"
          className="mx-auto max-h-[420px] w-full object-contain"
          aria-label={`Preview of ${file.name}`}
        />
      </div>
      <div className="flex items-start gap-3 p-4">
        <FileVideo className="mt-0.5 size-5 shrink-0 text-violet-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={file.name}>
            {file.name}
          </p>
          <p className="mt-0.5 text-xs text-muted tabular-nums">
            {formatBytes(file.size)}
            {metadata ? ` · ${formatClock(metadata.durationSeconds)} · ${metadata.width}×${metadata.height}` : reading ? " · reading details…" : ""}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-rose-300">
              {error}
            </p>
          )}
        </div>
        {removable && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-full p-2 text-muted transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-violet"
            aria-label="Remove this video"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
