/*
 * Client-side download of a generated image. The asset route answers with a redirect to a
 * short-lived signed storage URL on another origin, where <a download> is ignored — so the
 * image is fetched as a blob and saved through an object URL instead. If that is not possible
 * (e.g. the storage host does not allow cross-origin reads), the image opens in a new tab.
 *
 * Only same-origin /api/assets/ URLs are accepted; the signed URL the browser is redirected to
 * is never read, stored or logged.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function assetFilename(jobId: string) {
  return `yourai-${SAFE_ID.test(jobId) ? jobId : "image"}.webp`;
}

export const isAssetUrl = (url: string) => /^\/api\/assets\/[A-Za-z0-9_%-]{1,200}$/.test(url);

export type DownloadDeps = {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** Creates and clicks a temporary <a download>. */
  clickDownloadLink?: (href: string, filename: string) => void;
  openWindow?: (url: string) => void;
  schedule?: (fn: () => void, ms: number) => void;
};

export type DownloadOutcome = "downloaded" | "opened" | "failed";

function defaultClick(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function downloadAsset(input: { url: string; jobId: string }, deps: DownloadDeps = {}): Promise<DownloadOutcome> {
  if (!isAssetUrl(input.url)) return "failed";
  const fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const createObjectURL = deps.createObjectURL ?? ((b) => URL.createObjectURL(b));
  const revokeObjectURL = deps.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
  const click = deps.clickDownloadLink ?? defaultClick;
  const openWindow = deps.openWindow ?? ((u) => window.open(u, "_blank", "noopener,noreferrer"));
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));

  try {
    const response = await fetchImpl(input.url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("download failed");
    const blob = await response.blob();
    if (blob.size === 0 || (blob.type && !blob.type.startsWith("image/"))) throw new Error("not an image");
    const objectUrl = createObjectURL(blob);
    click(objectUrl, assetFilename(input.jobId));
    // Give the browser time to start the download before releasing the blob.
    schedule(() => revokeObjectURL(objectUrl), 10_000);
    return "downloaded";
  } catch {
    try {
      openWindow(input.url);
      return "opened";
    } catch {
      return "failed";
    }
  }
}
