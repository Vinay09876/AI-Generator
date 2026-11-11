/**
 * AI Video Clipper Feature Root.
 *
 * Central export boundary for the video clipper subsystem.
 */

export * from "./config";
export * from "./source";
export * from "./types";
export * from "./storage/keys";
export * from "./validation";
export * from "./engine/mock-engine";
export * from "./lifecycle";
export * from "./analysis/runner";
export * from "./analysis/metadata";
export * from "./analysis/audio";
export * from "./analysis/scene";
export * from "./analysis/transcription";
export * from "./analysis/highlight";
export * from "./subtitles/ass-generator";
export * from "./render/filter-graph";
export * from "./render/args";
export * from "./render/validate-output";
export * from "./render/thumbnail";
export * from "./engine/ffmpeg-engine";
export * from "./worker/lease";
export * from "./worker/process-job";
export * from "./storage/adapter";
export * from "./uploads/uploads";
export * from "./jobs";
export * from "./job-view";
export * from "./http";
export * from "./maintenance";
export * from "./worker/plan-clips";
export * from "./worker/loop";
// ./worker/wiring, ./service, ./queries and ./storage/supabase-clipper are intentionally NOT
// re-exported (server-only live adapters). Client code lives in ./client (browser-safe).
