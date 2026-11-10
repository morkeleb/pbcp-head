/**
 * How long a re-identification counts for a `confirm` decision (RFC 0.9 §4.1: "within a short window the head chooses").
 * The one place the window is set: the decide route checks it (lib/protocol.ts), its 403 names it (lib/http.ts), the
 * step-up reports it (app/api/auth/passkey/step-up).
 */
export const REAUTH_WINDOW_SECONDS = 5 * 60;
