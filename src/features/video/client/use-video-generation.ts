"use client";

import { useEffect, useMemo, useState } from "react";
import { VideoGenerationController, type VideoControllerDeps } from "./controller";
import type { SubmitVideoInput, VideoGenerationState } from "./types";

export interface UseVideoGenerationResult {
  state: VideoGenerationState;
  phase: VideoGenerationState["phase"];
  isSubmitting: boolean;
  isPolling: boolean;
  isCompleted: boolean;
  isFailed: boolean;
  activeJob: any | null;
  completedAsset: any | null;
  error: any | null;
  submit: (input: SubmitVideoInput) => Promise<VideoGenerationState>;
  poll: (jobId: string, context?: { prompt?: string; startedAt?: number }) => void;
  stop: () => void;
  reset: () => void;
}

export function useVideoGeneration(deps: VideoControllerDeps = {}): UseVideoGenerationResult {
  const controller = useMemo(() => new VideoGenerationController(deps), []);
  const [state, setState] = useState<VideoGenerationState>(() => controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe((next) => {
      setState(next);
    });

    return () => {
      unsubscribe();
      controller.destroy();
    };
  }, [controller]);

  return {
    state,
    phase: state.phase,
    isSubmitting: state.phase === "submitting",
    isPolling: state.phase === "polling",
    isCompleted: state.phase === "completed",
    isFailed: state.phase === "failed",
    activeJob:
      state.phase === "polling"
        ? state.lastJob ?? null
        : state.phase === "completed"
        ? state.job
        : state.phase === "failed"
        ? state.job
        : null,
    completedAsset: state.phase === "completed" ? state.asset : null,
    error: state.phase === "failed" ? state.error : null,
    submit: (input: SubmitVideoInput) => controller.submit(input),
    poll: (jobId: string, context) => controller.poll(jobId, context),
    stop: () => controller.stop(),
    reset: () => controller.reset(),
  };
}

