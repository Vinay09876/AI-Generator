const numberFormat = new Intl.NumberFormat("en");
const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const formatNumber = (n: number) => numberFormat.format(n);
export const formatDate = (d: Date) => dateFormat.format(d);
export const formatDateTime = (d: Date) => `${dateTimeFormat.format(d)} UTC`;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** "3 hours ago", "yesterday", "just now". Rendered on the server per request. */
export function formatRelative(date: Date, now = new Date()) {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export const firstName = (name?: string | null) => name?.trim().split(/\s+/)[0] || undefined;
export const initialOf = (value?: string | null) => (value?.trim().charAt(0) || "?").toUpperCase();

/** Formats byte count to B, KB, or MB. */
export function formatFileSize(bytes: number | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const b = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
