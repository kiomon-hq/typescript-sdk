/**
 * Kiomon SDK — version
 *
 * Kept in source rather than read from `package.json`: a runtime `require` of
 * package.json would resolve against `dist/` once published, where it is not,
 * and importing it at build time would inline the whole manifest.
 *
 * Keep in step with `package.json` — `test/version.test.ts` asserts they match.
 */
export const SDK_VERSION = "0.1.0";

/**
 * Sent on every request as `User-Agent`.
 *
 * Not cosmetic: Cloudflare's edge in front of `api.kiomon.com` bans the default
 * signature of some runtimes, so identifying the SDK explicitly is what keeps a
 * request from being refused at the edge. Callers can override it through the
 * `headers` option.
 *
 * In a browser this is a no-op — `User-Agent` is a forbidden header name, so
 * `fetch` drops it silently rather than throwing.
 */
export const USER_AGENT = `kiomon-typescript-sdk/${SDK_VERSION}`;
