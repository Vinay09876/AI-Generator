// Generates local video fixtures for the isolated browser E2E (no network).
//   node make-fixtures.mjs <ffmpegBinDir> <outDir>
// portrait 1080x1920, landscape 1920x1080, square 1080x1080: 24 s, four scene cuts, two silent gaps.
// Plus: an oversize file (> 50 MB) and an unsupported file for rejection paths.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [bin, out] = process.argv.slice(2);
if (!bin || !out) {
  console.error("usage: make-fixtures.mjs <ffmpegBinDir> <outDir>");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const ffmpeg = path.join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

function make(name, w, h) {
  const seg = `s=${w}x${h}:r=30:d=6`;
  const filter =
    `color=c=red:${seg}[a];testsrc2=${seg}[b];color=c=blue:${seg}[c];smptebars=${seg}[d];` +
    "[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p[v];" +
    "sine=frequency=440:duration=24,volume=enable='between(t,6,8)+between(t,15,17)':volume=0[au]";
  const file = path.join(out, name);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", filter, "-map", "[v]", "-map", "[au]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-shortest", file]);
  console.log(`${name} ${fs.statSync(file).size} bytes`);
}
make("portrait-1080x1920.mp4", 1080, 1920);
make("landscape-1920x1080.mp4", 1920, 1080);
make("square-1080x1080.mp4", 1080, 1080);

// Oversize (51 MB) "mp4": random bytes are enough — it must be rejected before upload.
const big = path.join(out, "oversize-51mb.mp4");
const fd = fs.openSync(big, "w");
const chunk = crypto.randomBytes(1024 * 1024);
for (let i = 0; i < 51; i++) fs.writeSync(fd, chunk);
fs.closeSync(fd);
fs.writeFileSync(path.join(out, "notes.txt"), "not a video");
console.log("oversize + unsupported fixtures written");
