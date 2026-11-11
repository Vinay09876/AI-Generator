import "server-only";
/**
 * Production wiring for the clipper worker: real lifecycle (Prisma) + private Supabase storage.
 * Not exported from the feature index so offline tests never import live adapters.
 * Nothing in Batch 4 invokes this; job pickup/scheduling arrives in Batch 5.
 */

import { getVideoObjectStorage } from "@/features/video/storage/supabase";
import {
  claimClipperLease,
  completeClipperJobWithAssets,
  failClipperJobFenced,
  getClipperJobCleanupState,
  markClipperJobStarted,
  recordClipperCleanupResults,
  renewClipperLease,
} from "../lifecycle";
import type { ClipperWorkerLifecycle, ClipperWorkerStorage } from "./process-job";

export const prismaClipperWorkerLifecycle: ClipperWorkerLifecycle = {
  markStarted: ({ jobId, engine }) => markClipperJobStarted({ jobId, engine }),
  claimLease: ({ jobId, leaseDurationMs }) => claimClipperLease({ jobId, leaseDurationMs }),
  renewLease: ({ jobId, token, extensionMs }) => renewClipperLease({ jobId, token, extensionMs }),
  complete: (p) => completeClipperJobWithAssets(p),
  failFenced: (p) => failClipperJobFenced(p),
  recordCleanup: (p) => recordClipperCleanupResults(p),
  getCleanupState: (jobId) => getClipperJobCleanupState(jobId),
};

export function getClipperWorkerStorage(): ClipperWorkerStorage {
  const storage = getVideoObjectStorage();
  return {
    putStream: (key, stream, options) => storage.putStream(key, stream, options),
    delete: (key) => storage.delete(key),
  };
}
