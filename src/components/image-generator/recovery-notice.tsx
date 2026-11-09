"use client";

import { History, PencilLine, PlayCircle, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RecoveryNotice } from "@/features/generations/client/generation-controller";

const excerpt = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Explains a saved request that page-load recovery could not resume automatically:
 *  - held: kept, because another generation is active (resume when free, or discard);
 *  - expired: too old to resume safely, removed — the prompt can be restored to the editor.
 */
export function RecoveryNoticeCard({
  notice,
  busy,
  onRestorePrompt,
  onResume,
  onDiscard,
  onDismiss,
}: {
  notice: RecoveryNotice;
  busy: boolean;
  onRestorePrompt: () => void;
  onResume: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
}) {
  const held = notice.kind === "held";
  return (
    <div role="status" className="rounded-xl border border-sky-300/20 bg-sky-400/[0.06] px-4 py-3 text-sm text-sky-50">
      <div className="flex gap-3">
        <History className="mt-0.5 size-4 shrink-0 text-sky-200" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{held ? "An earlier request is on hold" : "Your last request couldn't be resumed"}</p>
          <p className="mt-0.5 text-sky-50/80">
            {held
              ? busy
                ? "Another generation is in progress, so it hasn't been sent again. You can resume it once that finishes."
                : "It hasn't been sent again. Resume it to check on it (no duplicate is created), or discard it."
              : `It was started at ${timeOf(notice.startedAt)} and is too old to resume safely. Nothing new was submitted — if it was generated, it will appear in your history.`}
          </p>
          <p className="mt-2 truncate text-xs text-sky-50/70" title={notice.prompt}>
            “{excerpt(notice.prompt)}”
          </p>
        </div>
        {!held && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss message"
            className="-m-2 grid size-11 shrink-0 place-items-center rounded-full text-sky-100/70 transition-colors hover:bg-white/[0.06] hover:text-sky-50 focus-visible:outline-2 focus-visible:outline-violet"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-7">
        {held && (
          <Button size="sm" variant="secondary" onClick={onResume} disabled={busy} className="h-11">
            <PlayCircle className="size-4" aria-hidden /> Resume it
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRestorePrompt} className="h-11 ring-1 ring-inset ring-white/[0.08]">
          <PencilLine className="size-4" aria-hidden /> Restore prompt
        </Button>
        {held && (
          <Button size="sm" variant="ghost" onClick={onDiscard} className="h-11">
            <Trash2 className="size-4" aria-hidden /> Discard
          </Button>
        )}
      </div>
    </div>
  );
}
