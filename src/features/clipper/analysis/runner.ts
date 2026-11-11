/**
 * Safe Subprocess Execution Framework for FFmpeg & FFprobe.
 *
 * Implements strict security boundaries:
 * - Direct execFile argument array execution (strictly no shell interpolation).
 * - URL and network protocol blocking (prevents SSRF, remote media fetch, and protocol smuggling).
 * - Hard process timeouts and bounded output buffers (DoS defense).
 * - Pluggable mock execution runner for offline test suites and zero-cost environments.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------
export class ProcessExecutionError extends Error {
  readonly code: string;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(message: string, code: string, options?: { exitCode?: number; stderr?: string }) {
    super(message);
    this.name = "ProcessExecutionError";
    this.code = code;
    this.exitCode = options?.exitCode;
    this.stderr = options?.stderr;
  }
}

export class UnsafeArgumentError extends ProcessExecutionError {
  constructor(message: string) {
    super(message, "UNSAFE_SUBPROCESS_ARGUMENT");
    this.name = "UnsafeArgumentError";
  }
}

// ---------------------------------------------------------------------------
// Types & Options
// ---------------------------------------------------------------------------
export interface RunnerOptions {
  /** Execution timeout in milliseconds. Default: 15,000ms for ffprobe, 60,000ms for ffmpeg. */
  timeoutMs?: number;
  /** Maximum bytes collected from stdout or stderr before termination. Default: 5 MB. */
  maxBufferBytes?: number;
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Optional custom environment variables. */
  env?: NodeJS.ProcessEnv;
  /** Aborts (kills) the subprocess when signalled, e.g. when the worker lease is lost. */
  signal?: AbortSignal;
}

export interface RunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ProcessRunner {
  readonly name: string;
  execute(binary: "ffmpeg" | "ffprobe", args: string[], options?: RunnerOptions): Promise<RunnerResult>;
  isAvailable(binary: "ffmpeg" | "ffprobe"): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Security Invariants & Argument Sanitation
// ---------------------------------------------------------------------------
/** Prohibited protocol schemes that FFmpeg could resolve over the network. */
const BLOCKED_SCHEMES = [
  "http://",
  "https://",
  "ftp://",
  "ftps://",
  "smb://",
  "sftp://",
  "rtmp://",
  "rtmps://",
  "rtsp://",
  "gopher://",
  "tcp://",
  "udp://",
  "tls://",
  "unix://",
  "pipe:",
  // FFmpeg pseudo-protocols that can read other files, inline payloads or chain protocols.
  "concat:",
  "concatf:",
  "subfile:",
  "data:",
  "crypto:",
  "cache:",
  "async:",
  "tee:",
  "fd:",
];

/**
 * Validates that an argument array does not contain dangerous protocols,
 * URLs, or unescaped control characters.
 */
export function assertSafeSubprocessArgs(args: string[]): void {
  for (const arg of args) {
    const lower = arg.toLowerCase().trim();
    for (const scheme of BLOCKED_SCHEMES) {
      if (lower.startsWith(scheme)) {
        throw new UnsafeArgumentError(
          `Subprocess argument "${arg}" begins with prohibited remote protocol "${scheme}". Only local filesystem paths are allowed.`,
        );
      }
    }

    // Disallow null bytes which can truncate arguments in C runtime
    if (arg.includes("\0")) {
      throw new UnsafeArgumentError("Subprocess argument contains forbidden null byte.");
    }
  }
}

// ---------------------------------------------------------------------------
// System Process Runner (Real FFmpeg / FFprobe)
// ---------------------------------------------------------------------------
export class SystemProcessRunner implements ProcessRunner {
  readonly name = "system-runner";
  private availabilityCache = new Map<string, boolean>();

  async isAvailable(binary: "ffmpeg" | "ffprobe"): Promise<boolean> {
    if (this.availabilityCache.has(binary)) {
      return this.availabilityCache.get(binary)!;
    }

    try {
      await execFileAsync(binary, ["-version"], { timeout: 3000 });
      this.availabilityCache.set(binary, true);
      return true;
    } catch {
      this.availabilityCache.set(binary, false);
      return false;
    }
  }

  async execute(binary: "ffmpeg" | "ffprobe", args: string[], options?: RunnerOptions): Promise<RunnerResult> {
    assertSafeSubprocessArgs(args);

    const defaultTimeout = binary === "ffprobe" ? 15_000 : 60_000;
    const timeout = options?.timeoutMs ?? defaultTimeout;
    const maxBuffer = options?.maxBufferBytes ?? 5 * 1024 * 1024; // 5 MB

    const startTime = Date.now();

    if (options?.signal?.aborted) {
      throw new ProcessExecutionError(`${binary} subprocess aborted before start.`, "PROCESS_ABORTED");
    }

    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        timeout,
        maxBuffer,
        cwd: options?.cwd,
        signal: options?.signal,
        windowsHide: true,
        env: {
          ...process.env,
          ...options?.env,
        },
      });

      return {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      if (options?.signal?.aborted || err?.name === "AbortError") {
        throw new ProcessExecutionError(`${binary} subprocess was aborted.`, "PROCESS_ABORTED", {
          stderr: err?.stderr?.toString(),
        });
      }

      if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new ProcessExecutionError(`${binary} output exceeded ${maxBuffer} bytes.`, "PROCESS_OUTPUT_LIMIT");
      }

      const isTimeout = err.killed && err.signal === "SIGTERM";

      if (isTimeout) {
        throw new ProcessExecutionError(
          `${binary} subprocess timed out after ${timeout}ms.`,
          "PROCESS_TIMEOUT",
          { exitCode: err.code, stderr: err.stderr?.toString() },
        );
      }

      throw new ProcessExecutionError(
        `${binary} failed with exit code ${err.code ?? 1}: ${err.message}`,
        "PROCESS_EXIT_ERROR",
        { exitCode: err.code ?? 1, stderr: err.stderr?.toString() },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mock Process Runner (Offline & Deterministic Testing)
// ---------------------------------------------------------------------------
export type MockCommandHandler = (
  binary: "ffmpeg" | "ffprobe",
  args: string[],
  options?: RunnerOptions,
) => Promise<RunnerResult> | RunnerResult;

export class MockProcessRunner implements ProcessRunner {
  readonly name = "mock-runner";
  private customHandlers: MockCommandHandler[] = [];
  public callHistory: Array<{ binary: string; args: string[]; options?: RunnerOptions }> = [];

  registerHandler(handler: MockCommandHandler): void {
    this.customHandlers.unshift(handler);
  }

  clearHistory(): void {
    this.callHistory = [];
    this.customHandlers = [];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(binary: "ffmpeg" | "ffprobe", args: string[], options?: RunnerOptions): Promise<RunnerResult> {
    assertSafeSubprocessArgs(args);
    this.callHistory.push({ binary, args, options });
    if (options?.signal?.aborted) {
      throw new ProcessExecutionError(`${binary} subprocess aborted before start.`, "PROCESS_ABORTED");
    }

    for (const handler of this.customHandlers) {
      try {
        const result = await handler(binary, args, options);
        if (result) return result;
      } catch (err) {
        throw err;
      }
    }

    // Default mock response based on binary
    if (binary === "ffprobe") {
      return {
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1920,
              height: 1080,
              r_frame_rate: "30/1",
              avg_frame_rate: "30/1",
              duration: "60.000000",
              bit_rate: "4500000",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              sample_rate: "48000",
              channels: 2,
              duration: "60.000000",
              bit_rate: "128000",
            },
          ],
          format: {
            duration: "60.000000",
            size: "35000000",
            bit_rate: "4628000",
          },
        }),
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      };
    }

    // Default ffmpeg response
    return {
      stdout: "",
      stderr: "ffmpeg version 6.0-mock",
      exitCode: 0,
      durationMs: 10,
    };
  }
}

// ---------------------------------------------------------------------------
// Runner Factory / Resolver
// ---------------------------------------------------------------------------
/** True for the offline mock runner. Real engines refuse it unless explicitly allowed (tests). */
export function isMockProcessRunner(runner: ProcessRunner): boolean {
  return runner instanceof MockProcessRunner || runner.name === "mock-runner";
}

// NOTE: the global default is the mock runner (Batch 3 behaviour, relied on by offline tests).
// FfmpegClipperEngine never uses this global: it requires an explicitly injected runner.
let globalRunner: ProcessRunner = new MockProcessRunner();

export function setGlobalProcessRunner(runner: ProcessRunner): void {
  globalRunner = runner;
}

export function getProcessRunner(): ProcessRunner {
  return globalRunner;
}
