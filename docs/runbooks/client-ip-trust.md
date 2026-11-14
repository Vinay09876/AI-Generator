# Client IP trust and sign-in throttling on Render

**`TRUST_PROXY` is NOT set and must stay unset.** No forwarding header is trusted. Per-IP rate limits
are skipped (never collapsed into one shared bucket), and the app relies on per-account, per-user,
per-target and site-wide limits that do not depend on the client IP.

## What Render sends (as of 2026-11)
- Requests to `*.onrender.com` pass Cloudflare, then Render's proxy, then the app.
- `X-Forwarded-For`: Render staff state the first entry is the client IP, but Render **appends to a
  client-supplied value instead of replacing it**, so the first entry can be forged. Never trust it.
- `CF-Connecting-IP` / `True-Client-IP`: set by Cloudflare. Whether Cloudflare overwrites a
  client-supplied value on this path, and whether the Render origin can be reached without
  Cloudflare, are **not documented by Render** and have **not been validated** for Pixora.

## Before anyone considers `TRUST_PROXY=cloudflare`
This requires a separate, reviewed change: temporarily add an admin-only, read-only endpoint that
returns what `extractClientIp(headers, { trustModel: "cloudflare" })` would yield, call it with
forged `CF-Connecting-IP` / `True-Client-IP` headers from two different networks, and confirm the
forged value is never returned. Remove the endpoint afterwards. Even then, Render does not document
that its origin is unreachable except through Cloudflare, so per-IP limits stay defence in depth.

## Limits that apply today (process-local, best effort)
| Area | Limit | Key |
|---|---|---|
| Sign-in | Progressive per-account delay (below); no hard lockout | normalized email |
| Registration | 100 successful accounts per hour, site-wide (failed/duplicate attempts do not count) | global |
| Image generation | 10 requests per minute per user; Postgres enforces the daily quota and 1 active job | user id |
| Abuse reports | Signed-in: 10/hour per user. Anonymous: 3/hour per target, 60/hour site-wide | user / target / global |

### Sign-in throttle and residual brute-force risk
The first 5 failed sign-ins for an account within 15 minutes cost nothing. After that, password
checks for that account are spaced 1 s, 2 s, 4 s ... up to 30 s apart; requests wait for their turn
and a correct password is always evaluated when its turn comes (and then resets the account). A
request is refused (temporarily, "try again in a minute") only if more than 45 s of attempts are
already queued for the account. Honest residual risk:
- **Guess rate**: at most about 1 guess per 30 s per account (~120/hour, ~2,900/day), higher than the
  previous hard lock of 5 per 15 minutes (480/day). Weak or very common passwords can be guessed
  within days by a patient attacker. Credential stuffing (one guess for each of many accounts) is not
  throttled at all without a trusted client IP.
- **Denial of service**: one attacker can no longer block an account with 5 requests, but someone who
  keeps more than 45 s of attempts queued for one account around the clock can still delay or
  temporarily refuse its owner.
- **Process-local**: counters reset on restart or deploy and are not shared between instances.
- Stronger options for later: a free bot challenge (e.g. Cloudflare Turnstile) after repeated
  failures, email-based sign-in links, or a longer minimum password length.
