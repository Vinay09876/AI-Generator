"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Repeat,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { VideoAspectRatio } from "@/features/video/config";
import { cn } from "@/lib/utils";

interface VideoPlayerProps {
  src: string;
  poster?: string | null;
  aspectRatio?: VideoAspectRatio;
  loop?: boolean;
  autoPlay?: boolean;
  filename?: string;
  className?: string;
}

export function VideoPlayer({
  src,
  poster,
  aspectRatio = "16:9",
  loop = true,
  autoPlay = true,
  filename = "generated-video.mp4",
  className,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(5);
  const [isMuted, setIsMuted] = useState(false);
  const [isLooping, setIsLooping] = useState(loop);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Keep duration synchronized
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const time = parseFloat(e.target.value);
    videoRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const handleMuteToggle = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleLoopToggle = () => {
    if (!videoRef.current) return;
    videoRef.current.loop = !isLooping;
    setIsLooping(!isLooping);
  };

  const handleFullscreenToggle = async () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      try {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } catch {}
    } else {
      try {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } catch {}
    }
  };

  // Keyboard navigation & controls
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      handlePlayPause();
    } else if (e.key === "m") {
      e.preventDefault();
      handleMuteToggle();
    } else if (e.key === "f") {
      e.preventDefault();
      handleFullscreenToggle();
    }
  };

  // Autohide controls during active playback
  const scheduleControlsHide = () => {
    setControlsVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    if (isPlaying) {
      hideTimeoutRef.current = setTimeout(() => {
        setControlsVisible(false);
      }, 2500);
    }
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  // Map aspect ratio to container class
  const aspectClass =
    aspectRatio === "9:16"
      ? "aspect-[9/16] max-h-[580px]"
      : aspectRatio === "1:1"
      ? "aspect-square max-h-[500px]"
      : "aspect-video max-h-[500px]";

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      onMouseMove={scheduleControlsHide}
      onMouseLeave={() => isPlaying && setControlsVisible(false)}
      tabIndex={0}
      role="region"
      aria-label="Video player"
      className={cn(
        "group relative mx-auto flex w-full items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet",
        aspectClass,
        className,
      )}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        loop={isLooping}
        autoPlay={autoPlay}
        playsInline
        preload="metadata"
        onClick={handlePlayPause}
        onPlay={() => {
          setIsPlaying(true);
          scheduleControlsHide();
        }}
        onPause={() => {
          setIsPlaying(false);
          setControlsVisible(true);
        }}
        onTimeUpdate={() => {
          if (videoRef.current) {
            setCurrentTime(videoRef.current.currentTime);
          }
        }}
        onLoadedMetadata={() => {
          if (videoRef.current) {
            setDuration(videoRef.current.duration || 5);
            setIsLoading(false);
          }
        }}
        onWaiting={() => setIsLoading(true)}
        onPlaying={() => setIsLoading(false)}
        className="size-full object-contain cursor-pointer"
      />

      {/* Big Center Play Overlay Button */}
      {!isPlaying && (
        <button
          type="button"
          onClick={handlePlayPause}
          aria-label="Play video"
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 backdrop-blur-[2px] transition-all"
        >
          <div className="flex size-16 items-center justify-center rounded-full border border-white/20 bg-white/15 text-white shadow-[0_0_30px_rgba(139,92,246,0.6)] backdrop-blur-md transition-all duration-300 hover:scale-110 hover:bg-white/25 active:scale-95">
            <Play className="ml-1 size-7 fill-white text-white" />
          </div>
        </button>
      )}

      {/* Loading Spinner */}
      {isLoading && isPlaying && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/20">
          <div className="size-10 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
        </div>
      )}

      {/* Custom Bottom Controls Bar */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 transition-opacity duration-300",
          controlsVisible || !isPlaying ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* Scrubber Progress Bar */}
        <div className="relative mb-2 flex items-center">
          <input
            type="range"
            min={0}
            max={duration || 5}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Video seek bar"
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-violet transition-all hover:h-2"
            style={{
              background: `linear-gradient(to right, rgb(139 92 246) ${progressPercent}%, rgba(255, 255, 255, 0.2) ${progressPercent}%)`,
            }}
          />
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-between text-white">
          <div className="flex items-center gap-3">
            {/* Play/Pause */}
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="rounded-lg p-1.5 text-white/90 transition-colors hover:bg-white/15 hover:text-white"
            >
              {isPlaying ? <Pause className="size-5" /> : <Play className="size-5 fill-white" />}
            </button>

            {/* Loop Toggle */}
            <button
              type="button"
              onClick={handleLoopToggle}
              title={isLooping ? "Loop enabled" : "Loop disabled"}
              aria-label="Toggle loop"
              className={cn(
                "rounded-lg p-1.5 transition-colors",
                isLooping
                  ? "bg-violet/30 text-violet-300"
                  : "text-white/60 hover:bg-white/15 hover:text-white",
              )}
            >
              <Repeat className="size-4" />
            </button>

            {/* Mute/Unmute */}
            <button
              type="button"
              onClick={handleMuteToggle}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            >
              {isMuted ? <VolumeX className="size-4 text-rose-400" /> : <Volume2 className="size-4" />}
            </button>

            {/* Timecode */}
            <span className="font-mono text-xs text-white/70 tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Download Button */}
            <a
              href={src}
              download={filename}
              target="_blank"
              rel="noopener noreferrer"
              title="Download video"
              aria-label="Download video"
              className="rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            >
              <Download className="size-4" />
            </a>

            {/* Fullscreen Toggle */}
            <button
              type="button"
              onClick={handleFullscreenToggle}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              className="rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            >
              {isFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

