import { PauseCircle, ServerCog } from "lucide-react";

/**
 * Operator submission switch. Wording deliberately does NOT claim that a worker is online:
 * "open" only means new jobs are accepted; whether a worker picks them up is shown per job.
 */
export function WorkerNotice({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return (
      <div role="note" className="flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm">
        <PauseCircle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
        <div>
          <p className="font-medium text-foreground">New clipping jobs are switched off</p>
          <p className="mt-1 text-muted">
            The operator has paused new submissions. Nothing can be uploaded, reserved or charged right now. Clips you made earlier are
            still available below.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm">
      <ServerCog className="mt-0.5 size-4 shrink-0 text-violet-300" aria-hidden="true" />
      <div>
        <p className="font-medium text-foreground">Submissions are open</p>
        <p className="mt-1 text-muted">
          This only means new jobs are accepted. Clips are rendered by a separate worker, and this page can't tell whether it is running.
          Your job shows <span className="text-foreground">Processing</span> only after a worker actually picks it up. Until then you can
          cancel it for a full refund.
        </p>
      </div>
    </div>
  );
}
