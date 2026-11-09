"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/constants";
import { getGenerationJob, postImageGeneration } from "@/features/generations/client/api";
import {
  GenerationController,
  type ActiveJobInput,
  type GenerationState,
  type RecoveryNotice,
} from "@/features/generations/client/generation-controller";
import { browserStore } from "@/features/generations/client/pending-request";
import { startRecoveryOnMount } from "@/features/generations/client/recovery-scheduler";

const IDLE: GenerationState = { phase: "idle" };
const NO_NOTICE = (): RecoveryNotice | null => null;

/** Abortable delay. Resolves (never rejects) when the time passes or the signal aborts. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function waitUntilVisible(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || document.visibilityState === "visible") return resolve();
    function done() {
      if (!signal.aborted && document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", done);
      signal.removeEventListener("abort", done);
      resolve();
    }
    document.addEventListener("visibilitychange", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Binds a GenerationController to React and the browser: real API calls, localStorage,
 * page visibility, router.refresh() after a settled job, a sign-in redirect on 401, page-load
 * recovery (once, Strict-Mode safe) and adoption of a server-reported active job.
 */
export function useGeneration(userId: string, activeJob: ActiveJobInput) {
  const router = useRouter();
  const [controller] = useState(
    () =>
      new GenerationController({
        userId,
        store: browserStore(),
        api: { post: postImageGeneration, get: getGenerationJob },
        now: () => Date.now(),
        sleep,
        visibility: { isHidden: () => document.visibilityState === "hidden", waitUntilVisible },
        onSettled: () => router.refresh(),
        onUnauthenticated: () => router.push(`${ROUTES.login}?callbackUrl=${encodeURIComponent(ROUTES.aiImage)}`),
      }),
  );

  const activeRef = useRef(activeJob);
  activeRef.current = activeJob;

  // Attach + one-time recovery (deferred one task so a Strict Mode remount cannot run it twice).
  useEffect(() => startRecoveryOnMount(controller, () => activeRef.current), [controller]);

  // The server reports a (new) active job after a refresh — e.g. after a 409, or a job started
  // in another tab. Follow it by polling; ignored before recovery ran or while already busy.
  const activeId = activeJob?.id ?? null;
  useEffect(() => {
    if (activeId) controller.adoptActiveJob(activeRef.current);
  }, [controller, activeId]);

  // Paused polling resumes by itself; a stalled job is re-checked once when the tab returns.
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") controller.onVisible();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, () => IDLE);
  const notice = useSyncExternalStore(controller.subscribe, controller.getNotice, NO_NOTICE);
  return { state, notice, controller };
}
