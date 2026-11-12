"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Scissors, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  checkLocalFile,
  checkLocalMetadata,
  clipCost,
  getClipJob,
  getSubmitBlocker,
  type ClipperLimitsView,
  type LocalVideoMetadata,
} from "@/features/clipper/client";
import { DEFAULT_CLIPPER_ASPECT_RATIO, DEFAULT_CLIPPER_FRAMING_MODE } from "@/features/clipper/config";
import type { ClipJobView } from "@/features/clipper/job-view";
import { AnalysisNotice } from "./analysis-notice";
import { ClipResults } from "./clip-results";
import { ClipSettings, type ClipSettingsValue } from "./clip-settings";
import { ClipperCostSummary } from "./clipper-cost-summary";
import { ClipperStatus } from "./clipper-status";
import { readVideoMetadata } from "./read-metadata";
import { RecentClips } from "./recent-clips";
import { SourcePreview } from "./source-preview";
import { UploadDropzone } from "./upload-dropzone";
import { useClipper } from "./use-clipper";
import { WorkerNotice } from "./worker-notice";

export interface VideoClipperProps {
  userId: string;
  submissionsEnabled: boolean;
  limits: ClipperLimitsView;
  analysis: ClipJobView["analysis"];
  balance: number;
  dailyUsed: number;
  dailyLimit: number;
  activeJobId: string | null;
  recentJobs: ClipJobView[];
}

/** Minimum gap between two signed-URL refreshes of the same job (avoids error loops). */
const REFRESH_THROTTLE_MS = 20_000;

export function VideoClipper(props: VideoClipperProps) {
  const { userId, submissionsEnabled, limits, analysis, balance, dailyUsed, dailyLimit, activeJobId } = props;
  const router = useRouter();
  const clipper = useClipper({ userId, activeJobId, queueTimeoutMinutes: limits.queueTimeoutMinutes });
  const { state, status, active } = clipper;

  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<LocalVideoMetadata | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [settings, setSettings] = useState<ClipSettingsValue>({
    aspectRatio: DEFAULT_CLIPPER_ASPECT_RATIO,
    framing: DEFAULT_CLIPPER_FRAMING_MODE,
    clipCount: Math.min(limits.maxClips, 3),
  });
  const [recentJobs, setRecentJobs] = useState<ClipJobView[]>(props.recentJobs);
  const [currentJob, setCurrentJob] = useState<ClipJobView | null>(null);
  const lastRefresh = useRef(new Map<string, number>());
  const fileToken = useRef(0);

  useEffect(() => setRecentJobs(props.recentJobs), [props.recentJobs]);

  // Keep the completed job locally so fresh signed links can replace expired ones.
  useEffect(() => {
    if (state.phase === "completed") setCurrentJob(state.job);
  }, [state]);

  // Terminal outcomes change balance, daily usage and recent clips: re-read server data.
  const phase = state.phase;
  useEffect(() => {
    if (phase === "completed" || phase === "failed" || phase === "cancelled") router.refresh();
  }, [phase, router]);

  useEffect(
    () => () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );

  const clearFile = useCallback(() => {
    fileToken.current++;
    setFile(null);
    setObjectUrl(null);
    setMetadata(null);
    setFileError(null);
    setMimeType(null);
    setReading(false);
  }, []);

  const chooseFile = useCallback(
    async (next: File) => {
      const token = ++fileToken.current;
      setFile(next);
      setObjectUrl(URL.createObjectURL(next));
      setMetadata(null);
      setMimeType(null);
      const check = checkLocalFile(next, limits);
      if (!check.ok) {
        setFileError(check.message);
        setReading(false);
        return;
      }
      setFileError(null);
      setMimeType(check.mimeType);
      setReading(true);
      const meta = await readVideoMetadata(next);
      if (token !== fileToken.current) return; // a newer file was chosen meanwhile
      setReading(false);
      setMetadata(meta);
      const metaCheck = checkLocalMetadata(meta, limits);
      setFileError(metaCheck.ok ? null : metaCheck.message);
    },
    [limits],
  );

  const cost = clipCost(settings.clipCount, limits.creditsPerClip);
  const blocker = getSubmitBlocker({
    submissionsEnabled,
    balance,
    cost,
    dailyUsed,
    dailyLimit,
    hasFile: Boolean(file),
    fileError: reading ? "Reading the video's details…" : fileError,
  });

  const submit = useCallback(() => {
    if (!file || !metadata || !mimeType || blocker || active) return;
    // Some browsers report no MIME type (e.g. .mov on Windows); label the Blob without copying it.
    const blob = file.type ? file : file.slice(0, file.size, mimeType);
    setCurrentJob(null);
    clipper.startUpload({
      file: blob,
      hints: { durationSeconds: metadata.durationSeconds, width: metadata.width || undefined, height: metadata.height || undefined },
      options: settings,
    });
  }, [file, metadata, mimeType, blocker, active, clipper, settings]);

  const startOver = useCallback(() => {
    clipper.reset();
    setCurrentJob(null);
    clearFile();
  }, [clipper, clearFile]);

  /** Fetches fresh short-lived links for a job whose previews failed to load. */
  const refreshJob = useCallback(async (jobId: string) => {
    const now = Date.now();
    if (now - (lastRefresh.current.get(jobId) ?? 0) < REFRESH_THROTTLE_MS) return;
    lastRefresh.current.set(jobId, now);
    const res = await getClipJob(jobId);
    if (!res.ok || res.data.job.status !== "COMPLETED") return;
    const fresh = res.data.job;
    setCurrentJob((j) => (j?.id === jobId ? fresh : j));
    setRecentJobs((jobs) => jobs.map((j) => (j.id === jobId ? fresh : j)));
  }, []);

  const shownJob = phase === "completed" ? (currentJob?.id === state.job.id ? currentJob : state.job) : null;
  const visibleRecent = useMemo(() => recentJobs.filter((j) => j.id !== shownJob?.id), [recentJobs, shownJob?.id]);
  const showSetup = !active && phase !== "completed";
  const accept = [...limits.extensions, ...limits.mimeTypes].join(",");

  return (
    <div className="space-y-10">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start">
        {/* Main column: source, status, results */}
        <div className="min-w-0 space-y-6">
          {phase !== "idle" && (
            <ClipperStatus
              status={status}
              onCancelUpload={clipper.cancelUpload}
              onCancelQueued={clipper.cancelQueued}
              onRetry={file && !fileError ? submit : undefined}
              onChooseFile={startOver}
              onRefresh={() => window.location.reload()}
              onReleasePending={clipper.releasePending}
            />
          )}

          {shownJob && (
            <div className="space-y-4">
              <ClipResults job={shownJob} onExpired={refreshJob} />
              <Button type="button" variant="secondary" onClick={startOver}>
                <Scissors className="size-4" aria-hidden="true" />
                Clip another video
              </Button>
            </div>
          )}

          {showSetup &&
            (file && objectUrl ? (
              <SourcePreview
                file={file}
                objectUrl={objectUrl}
                metadata={metadata}
                reading={reading}
                error={fileError}
                onRemove={clearFile}
                removable
              />
            ) : (
              <UploadDropzone
                onFile={(f) => void chooseFile(f)}
                disabled={!submissionsEnabled}
                maxUploadBytes={limits.maxUploadBytes}
                minSourceSeconds={limits.minSourceSeconds}
                maxSourceSeconds={limits.maxSourceSeconds}
                maxLongEdge={limits.maxLongEdge}
                maxShortEdge={limits.maxShortEdge}
                accept={accept}
              />
            ))}
        </div>

        {/* Side column: switch notice, settings, cost, generate */}
        <aside className="space-y-4 lg:sticky lg:top-6" aria-label="Clip settings">
          <WorkerNotice enabled={submissionsEnabled} />
          <form
            className="space-y-5 rounded-3xl border border-white/[0.08] bg-surface p-5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <ClipSettings value={settings} onChange={setSettings} maxClips={limits.maxClips} clipDuration={limits.clipDuration} disabled={active} />
            <ClipperCostSummary cost={cost} balance={balance} dailyUsed={dailyUsed} dailyLimit={dailyLimit} />
            <div>
              <Button type="submit" size="lg" className="w-full" disabled={Boolean(blocker) || active} aria-describedby="clipper-submit-hint">
                <Sparkles className="size-4" aria-hidden="true" />
                Generate {settings.clipCount} clip{settings.clipCount === 1 ? "" : "s"}
              </Button>
              <p id="clipper-submit-hint" className="mt-2 min-h-5 text-center text-xs text-muted">
                {active ? "A job is in progress." : blocker ? blocker.message : "Your video is uploaded only when you press Generate."}
              </p>
            </div>
          </form>
          <AnalysisNotice analysis={analysis} />
        </aside>
      </div>

      <RecentClips jobs={visibleRecent} onExpired={refreshJob} />
    </div>
  );
}
