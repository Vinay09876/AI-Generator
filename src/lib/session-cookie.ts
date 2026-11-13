/** Auth.js v5 session cookie names, including the secure prefix and chunked variants (".0", ".1"). */
const SESSION_COOKIE_NAME = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export function hasSessionCookieName(names: readonly string[]): boolean {
  return names.some((name) => SESSION_COOKIE_NAME.test(name));
}
