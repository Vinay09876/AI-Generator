"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createClipperController,
  createWebUploadLock,
  describeClipperState,
  isActivePhase,
  readPending,
  type CancelQueuedResult,
  type ReleasePendingResult,
  type ClipJobOptions,
  type ClipperClientState,
  type StatusView,
  type StorageLike,
} from "@/features/clipper/client";

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export interface UseClipperResult {
  state: ClipperClientState;
  status: StatusView;
  active: boolean;
  startUpload: (input: {
    file: Blob & { type: string; size: number };
    hints: { durationSeconds: number; width?: number; height?: number };
    options: ClipJobOptions;
  }) => void;
  cancelUpload: () => void;
  cancelQueued: () => Promise<CancelQueuedResult>;
  releasePending: () => Promise<ReleasePendingResult>;
  reset: () => void;
}

/**
 * Binds the framework-agnostic clipper controller to React. On mount it recovers a local pending
 * request (same idempotency key) and releases interrupted upload reservations; if there is no local
 * record it follows the active job the server reported (created on another device) with resume().
 */
export function useClipper(params: { userId: string; activeJobId: string | null; queueTimeoutMinutes: number }): UseClipperResult {
  const { userId, activeJobId, queueTimeoutMinutes } = params;
  const controller = useMemo(
    () => createClipperController({ userId, storage: browserStorage(), uploadLock: createWebUploadLock(userId) }),
    [userId],
  );
  const [state, setState] = useState<ClipperClientState>(() => controller.getState());
  const [now, setNow] = useState(() => Date.now());
  const recovered = useRef(false);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    setState(controller.getState());
    if (!recovered.current) {
      recovered.current = true;
      const hasLocal = readPending(browserStorage(), userId) !== null;
      void controller.recover().then(() => {
        if (!hasLocal && activeJobId && controller.getState().phase === "idle") void controller.resume(activeJobId);
      });
    }
    return () => {
      unsubscribe();
      // Unmount: stop local work (upload / polling); the server job is unaffected. Allow the next
      // mount (including React StrictMode's dev re-mount) to recover again.
      controller.cancel();
      recovered.current = false;
    };
  }, [controller, userId, activeJobId]);

  const active = isActivePhase(state);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const status = useMemo(() => describeClipperState(state, now, { queueTimeoutMinutes }), [state, now, queueTimeoutMinutes]);

  return {
    state,
    status,
    active,
    startUpload: useCallback((input) => void controller.startUpload(input), [controller]),
    cancelUpload: useCallback(() => controller.cancel(), [controller]),
    cancelQueued: useCallback(() => controller.cancelQueued(), [controller]),
    releasePending: useCallback(() => controller.releasePending(), [controller]),
    reset: useCallback(() => controller.reset(), [controller]),
  };
}
