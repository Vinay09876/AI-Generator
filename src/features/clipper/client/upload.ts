/**
 * Direct browser → storage upload to a signed URL (XHR for progress + abort). Never throws.
 * The signed URL is single-object and short-lived; the server re-verifies the object afterwards.
 * NOT verified against a live Supabase bucket.
 */

export type UploadOutcome =
  | { ok: true }
  | { ok: false; code: "ABORTED" | "NETWORK_ERROR" | "UPLOAD_REJECTED"; status: number | null };

export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  status: number;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

export function uploadToSignedUrl(params: {
  signedUrl: string;
  file: Blob;
  contentType: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  createXhr?: () => XhrLike;
}): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    if (params.signal?.aborted) return resolve({ ok: false, code: "ABORTED", status: null });
    const xhr = params.createXhr ? params.createXhr() : (new XMLHttpRequest() as unknown as XhrLike);
    let settled = false;
    const done = (o: UploadOutcome) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener("abort", onAbort);
      resolve(o);
    };
    const onAbort = () => {
      xhr.abort();
      done({ ok: false, code: "ABORTED", status: null });
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    xhr.open("PUT", params.signedUrl);
    xhr.setRequestHeader("Content-Type", params.contentType);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) params.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () =>
      done(xhr.status >= 200 && xhr.status < 300 ? { ok: true } : { ok: false, code: "UPLOAD_REJECTED", status: xhr.status });
    xhr.onerror = () => done({ ok: false, code: "NETWORK_ERROR", status: null });
    xhr.onabort = () => done({ ok: false, code: "ABORTED", status: null });
    xhr.send(params.file);
  });
}
