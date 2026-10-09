/**
 * Kiomon SDK — unscoped alias.
 *
 * The implementation lives in `@kiomon/kiomon`. This package exists so
 * `npm install kiomon` works and so the unscoped name is claimed by Kiomon
 * rather than by someone else, matching the PyPI package name (`kiomon`) that
 * the Python SDK will use.
 *
 * It re-exports the implementation wholesale, so there is nothing to maintain
 * here beyond keeping the dependency range in step with the release.
 */
export * from "@kiomon/kiomon";
