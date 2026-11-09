import type { ActiveJobInput } from "./generation-controller";

type Recoverable = { attach(): void; detach(): void; recover(activeJob: ActiveJobInput): void };
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Mount-effect body for the generator: attach, then run recovery on the next task.
 * The deferral makes React Strict Mode's mount → unmount → remount cycle harmless: the first
 * timer is cancelled before it fires, so recovery (and any replay POST) runs exactly once.
 * Returns the effect cleanup (cancel + detach; the server-side generation is never cancelled).
 */
export function startRecoveryOnMount(controller: Recoverable, getActiveJob: () => ActiveJobInput, timers: Timers = defaultTimers) {
  controller.attach();
  const handle = timers.set(() => controller.recover(getActiveJob()), 0);
  return () => {
    timers.clear(handle);
    controller.detach();
  };
}
