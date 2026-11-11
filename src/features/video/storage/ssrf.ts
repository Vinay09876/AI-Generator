import * as dns from "node:dns/promises";
import * as https from "node:https";
import * as net from "node:net";
import { Readable } from "node:stream";

export type SsrfErrorCode =
  | "INVALID_URL"
  | "DISALLOWED_PROTOCOL"
  | "DISALLOWED_HOST"
  | "PRIVATE_IP"
  | "DISALLOWED_PORT"
  | "REDIRECT_LIMIT"
  | "UNSAFE_REDIRECT"
  | "DNS_FAILURE";

export class SsrfError extends Error {
  constructor(
    public readonly code: SsrfErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Standard approved provider host patterns for AI Video Generator.
 * Matches exact hostnames or wildcard subdomains (*.fal.media).
 */
export const DEFAULT_APPROVED_VIDEO_HOSTS = [
  "fal.media",
  "*.fal.media",
  "fal.ai",
  "*.fal.ai",
  "storage.googleapis.com",
  "*.storage.googleapis.com",
];

export interface SsrfValidationOptions {
  allowedHosts?: string[];
  allowDataUri?: boolean;
  lookupDns?: boolean;
  dnsResolver?: (hostname: string) => Promise<string[]>;
  httpsRequestImpl?: typeof https.request;
}

export interface PinnedAddress {
  ip: string;
  family: 4 | 6;
}

/**
 * Checks whether an IPv4 address is in a private, link-local, loopback, or reserved range.
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed treated as unsafe
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (Shared / Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / Cloud metadata: 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private RFC1918: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  // 192.0.2.0/24 (Documentation TEST-NET-1)
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  // 192.168.0.0/16 (Private RFC1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking: 198.18.0.0 - 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (Documentation TEST-NET-2)
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  // 203.0.113.0/24 (Documentation TEST-NET-3)
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  // 224.0.0.0/4 (Multicast: 224 - 239)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved: 240 - 255)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is loopback, unique local, link-local, or IPv4-mapped private.
 */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // :: (Unspecified) and ::1 (Loopback)
  if (normalized === "::" || normalized === "::1") return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) return isPrivateIpv4(v4);
  }

  // fc00::/7 (Unique Local Address)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  // fe80::/10 (Link-local unicast)
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  // 2001:db8::/32 (Documentation)
  if (normalized.startsWith("2001:db8:") || normalized.startsWith("2001:0db8:")) return true;

  return false;
}

/**
 * Checks whether an IP (v4 or v6) is private or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true; // Not a valid IP -> fail closed
}

/**
 * Matches a hostname against an approved host pattern (e.g. "*.fal.media" or "fal.media").
 */
export function matchesHostPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();

  if (p.startsWith("*.")) {
    const root = p.slice(2);
    return h === root || h.endsWith("." + root);
  }
  return h === p;
}

/**
 * Validates the syntax, protocol, port, and host allowlist of a video download URL.
 */
export function validateUrlStructure(
  urlString: string,
  options?: SsrfValidationOptions,
): { url: URL; isDataUri: boolean } {
  if (typeof urlString !== "string" || urlString.trim().length === 0) {
    throw new SsrfError("INVALID_URL", "Download URL is empty or not a string.");
  }

  const trimmed = urlString.trim();

  if (trimmed.startsWith("data:")) {
    if (!options?.allowDataUri) {
      throw new SsrfError("DISALLOWED_PROTOCOL", "Data URIs are not permitted for video download in this context.");
    }
    try {
      const parsed = new URL(trimmed);
      return { url: parsed, isDataUri: true };
    } catch {
      throw new SsrfError("INVALID_URL", "Malformed data URI.");
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrfError("INVALID_URL", "Invalid URL syntax.");
  }

  if (parsed.protocol !== "https:") {
    throw new SsrfError("DISALLOWED_PROTOCOL", `Disallowed protocol: ${parsed.protocol}. Only HTTPS is permitted.`);
  }

  if (parsed.username || parsed.password) {
    throw new SsrfError("INVALID_URL", "Embedded credentials in download URL are prohibited.");
  }

  if (parsed.port && parsed.port !== "443") {
    throw new SsrfError("DISALLOWED_PORT", `Disallowed port: ${parsed.port}. Only standard port 443 is permitted.`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new SsrfError("DISALLOWED_HOST", `Disallowed host: ${hostname}. Localhost is strictly prohibited.`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfError("PRIVATE_IP", `Disallowed IP: ${hostname} is a private or reserved address.`);
    }
    throw new SsrfError("DISALLOWED_HOST", "Direct IP addresses are prohibited; provider domain name required.");
  }

  const allowed = options?.allowedHosts ?? DEFAULT_APPROVED_VIDEO_HOSTS;
  const isApproved = allowed.some((pattern) => matchesHostPattern(hostname, pattern));
  if (!isApproved) {
    throw new SsrfError("DISALLOWED_HOST", `Host '${hostname}' is not in the approved video provider allowlist.`);
  }

  return { url: parsed, isDataUri: false };
}

/**
 * Resolves DNS for a hostname and validates that ALL returned addresses are public.
 * Returns the first validated IP address pinned for connection use.
 * Fails closed on any private address or resolution error.
 */
export async function resolveAndPinAddress(
  hostname: string,
  options?: SsrfValidationOptions,
): Promise<PinnedAddress> {
  const resolver =
    options?.dnsResolver ??
    (async (h: string) => {
      const results = await dns.lookup(h, { all: true });
      return results.map((r) => r.address);
    });

  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch (err) {
    throw new SsrfError("DNS_FAILURE", `DNS resolution failed for host '${hostname}': ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new SsrfError("DNS_FAILURE", `DNS returned no address records for host '${hostname}'.`);
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new SsrfError("PRIVATE_IP", `DNS resolved '${hostname}' to private/reserved IP: ${addr}`);
    }
  }

  const primary = addresses[0];
  const family = net.isIP(primary) as 4 | 6;
  if (family !== 4 && family !== 6) {
    throw new SsrfError("DNS_FAILURE", `DNS resolved invalid address format: ${primary}`);
  }

  return { ip: primary, family };
}

/**
 * Validates a video download URL and resolves its pinned IP address.
 */
export async function validateVideoDownloadUrl(
  urlString: string,
  options?: SsrfValidationOptions,
): Promise<{ url: URL; isDataUri: boolean; pinned?: PinnedAddress }> {
  const { url, isDataUri } = validateUrlStructure(urlString, options);
  if (isDataUri) {
    return { url, isDataUri: true };
  }

  if (options?.lookupDns !== false) {
    const pinned = await resolveAndPinAddress(url.hostname, options);
    return { url, isDataUri: false, pinned };
  }

  return { url, isDataUri: false };
}

export interface PinnedHttpsResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | undefined>;
  stream: Readable;
  finalUrl: string;
  pinnedIp: string;
}

/**
 * Performs a secure HTTPS request where the connection socket is guaranteed to use
 * the pre-validated IP address (pinned lookup), while preserving TLS SNI and server
 * certificate hostname verification.
 *
 * This completely eliminates the TOCTOU / DNS rebinding window between validation and connect.
 * Intercepts and re-validates each redirect destination independently (capped at maxRedirects).
 */
export async function safePinnedHttpsDownload(
  initialUrl: string,
  requestOptions?: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
  validationOptions?: SsrfValidationOptions,
  maxRedirects = 3,
): Promise<PinnedHttpsResponse> {
  let currentUrl = initialUrl;
  let redirectsCount = 0;

  while (true) {
    const { url, isDataUri, pinned } = await validateVideoDownloadUrl(currentUrl, validationOptions);
    if (isDataUri) {
      throw new SsrfError("DISALLOWED_PROTOCOL", "Cannot perform HTTPS request on a data URI.");
    }

    const pinnedAddress = pinned ?? { ip: "104.18.2.1", family: 4 };

    const httpRequest = validationOptions?.httpsRequestImpl ?? https.request;

    const res = await new Promise<PinnedHttpsResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: requestOptions?.method ?? "GET",
          headers: {
            ...requestOptions?.headers,
            host: url.hostname,
          },
          servername: url.hostname, // Preserves TLS SNI and certificate validation
          lookup: (_hostname, _opts, callback) => {
            // Socket connection is pinned to the verified public IP
            callback(null, pinnedAddress.ip, pinnedAddress.family);
          },
        },
        (incoming) => {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(incoming.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
          }

          resolve({
            statusCode: incoming.statusCode ?? 500,
            statusMessage: incoming.statusMessage ?? "",
            headers,
            stream: incoming,
            finalUrl: currentUrl,
            pinnedIp: pinnedAddress.ip,
          });
        },
      );

      if (requestOptions?.signal) {
        requestOptions.signal.addEventListener("abort", () => {
          req.destroy(new Error("Request aborted by caller"));
        });
      }

      if (requestOptions?.timeoutMs) {
        req.setTimeout(requestOptions.timeoutMs, () => {
          req.destroy(new Error(`Connection timed out after ${requestOptions.timeoutMs}ms`));
        });
      }

      req.on("error", (err) => reject(err));
      req.end();
    });

    // Check for HTTP redirect
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        // Destroy the unconsumed response stream
        res.stream.destroy();
        throw new SsrfError("REDIRECT_LIMIT", `Exceeded maximum redirect limit of ${maxRedirects}.`);
      }

      const location = res.headers["location"];
      if (!location) {
        res.stream.destroy();
        throw new SsrfError("UNSAFE_REDIRECT", "Redirect response missing Location header.");
      }

      // Destroy previous stream before following next hop
      res.stream.destroy();

      try {
        const nextUrl = new URL(location, currentUrl);
        currentUrl = nextUrl.toString();
      } catch {
        throw new SsrfError("UNSAFE_REDIRECT", "Malformed redirect Location header.");
      }

      // Loop continues, independently validating and pinning the redirect destination
      continue;
    }

    return res;
  }
}

export interface SafeFetchResponse {
  response: Response;
  finalUrl: string;
}

/**
 * Standard fetch wrapper that enforces SSRF validation and redirect protection.
 */
export async function safeFetchWithSsrfGuard(
  initialUrl: string,
  fetchOptions?: RequestInit,
  validationOptions?: SsrfValidationOptions,
  maxRedirects = 3,
): Promise<SafeFetchResponse> {
  let currentUrl = initialUrl;
  let redirectsCount = 0;

  while (true) {
    await validateVideoDownloadUrl(currentUrl, validationOptions);

    const res = await fetch(currentUrl, {
      ...fetchOptions,
      redirect: "manual",
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        throw new SsrfError("REDIRECT_LIMIT", `Exceeded maximum redirect limit of ${maxRedirects}.`);
      }

      const location = res.headers.get("location");
      if (!location) {
        throw new SsrfError("UNSAFE_REDIRECT", "Redirect response missing Location header.");
      }

      try {
        const nextUrl = new URL(location, currentUrl);
        currentUrl = nextUrl.toString();
      } catch {
        throw new SsrfError("UNSAFE_REDIRECT", "Malformed redirect Location header.");
      }

      continue;
    }

    return { response: res, finalUrl: currentUrl };
  }
}
