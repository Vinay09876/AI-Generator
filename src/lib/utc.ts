/** UTC calendar-day helpers. Cloudflare Workers AI limits reset at 00:00 UTC. */

export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function utcDayRange(at: Date) {
  const start = utcDayStart(at);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  /** "YYYY-MM-DD", used for DATE columns so the database never re-interprets a timezone. */
  const key = start.toISOString().slice(0, 10);
  return { start, end, key };
}
