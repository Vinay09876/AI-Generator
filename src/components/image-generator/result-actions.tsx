"use client";

import { useState } from "react";
import { Copy, Download, ExternalLink, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadAsset } from "@/features/generations/client/download";
import { cn } from "@/lib/utils";

const linkButton =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap " +
  "bg-white/[0.04] text-foreground ring-1 ring-inset ring-white/10 backdrop-blur transition-[background-color,box-shadow] duration-300 " +
  "hover:bg-white/[0.08] hover:ring-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet";

/** Download · Open full size · Copy prompt · Use this prompt. Results are announced politely. */
export function ResultActions({
  jobId,
  assetUrl,
  prompt,
  onUsePrompt,
}: {
  jobId: string;
  assetUrl: string;
  prompt: string;
  /** Omitted when the composer is locked (a generation is running): the button is hidden. */
  onUsePrompt?: (prompt: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [note, setNote] = useState("");

  async function onDownload() {
    setDownloading(true);
    const outcome = await downloadAsset({ url: assetUrl, jobId });
    setDownloading(false);
    setNote(
      outcome === "downloaded"
        ? "Download started."
        : outcome === "opened"
          ? "Opened the image in a new tab — save it from there."
          : "The download couldn't start. Use “Open full size” instead.",
    );
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setNote("Prompt copied.");
    } catch {
      setNote("Couldn't copy automatically — select the prompt text instead.");
    }
  }

  return (
    <div>
      {/* Even two-column grid at every width (no ragged wrapping); a lone last action spans the row. */}
      <div className="grid grid-cols-2 gap-2 [&>:last-child:nth-child(odd)]:col-span-2">
        <Button size="md" onClick={onDownload} loading={downloading} loadingLabel="Downloading…" className="w-full px-4">
          {!downloading && <Download className="size-4" aria-hidden />}
          Download
        </Button>
        {/* Plain anchor (not next/link): API routes must never be prefetched. */}
        <a href={assetUrl} target="_blank" rel="noopener noreferrer" className={linkButton}>
          <ExternalLink className="size-4" aria-hidden />
          Open full size
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <Button variant="secondary" onClick={onCopy} disabled={!prompt} className="w-full px-4">
          <Copy className="size-4" aria-hidden /> Copy prompt
        </Button>
        {onUsePrompt && (
          <Button variant="ghost" onClick={() => onUsePrompt(prompt)} disabled={!prompt} className={cn("w-full px-4 ring-1 ring-inset ring-white/[0.06]")}>
            <PencilLine className="size-4" aria-hidden /> Use this prompt
          </Button>
        )}
      </div>
      <p role="status" className="mt-2 min-h-5 px-1 text-xs text-muted">
        {note}
      </p>
    </div>
  );
}
