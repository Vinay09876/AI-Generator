/**
 * Cross-tab upload lock (Batch 6, Fix A). Prevents a page load in tab A from releasing the upload
 * reservation that tab B is actively using. Uses the Web Locks API, whose locks are released
 * automatically when the holding tab closes or crashes. Returns null where unsupported; the
 * controller then assumes a single tab (documented limitation).
 */

export interface UploadTabLock {
  /** Runs fn while holding the per-user upload lock when available (never waits for it). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** True when any tab currently holds the lock. */
  isHeld(): Promise<boolean>;
}

type LockManagerLike = {
  request(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
};

export function createWebUploadLock(userId: string, locks?: LockManagerLike | null): UploadTabLock | null {
  const manager = locks ?? ((globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks ?? null);
  if (!manager || typeof manager.request !== "function" || typeof manager.query !== "function") return null;
  const name = `yourai:clipper:upload:${userId}`;
  return {
    run: <T,>(fn: () => Promise<T>) => manager.request(name, { ifAvailable: true }, () => fn()) as Promise<T>,
    async isHeld() {
      try {
        const snapshot = await manager.query();
        return (snapshot.held ?? []).some((l) => l.name === name);
      } catch {
        return true; // unknown → do not release anything
      }
    },
  };
}
