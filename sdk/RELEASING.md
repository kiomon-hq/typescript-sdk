# Releasing the SDK

Two packages are published from this repo:

| Directory | npm name | Role |
|---|---|---|
| `sdk/` | `@kiomon/kiomon` | the implementation |
| `kiomon/` | `kiomon` | unscoped alias that re-exports it |

`kiomon` exists so `npm install kiomon` works, so the unscoped name belongs to Kiomon, and so npm
matches the PyPI name the Python SDK will use. It re-exports the implementation, so the two cannot
differ in behaviour — only the dependency range has to be kept in step.

The root `package.json` is named `kiomon-monorepo` (`private: true`) **specifically so the unscoped
name is free inside the workspace**. A private root named `kiomon` would collide with the `kiomon`
workspace.

## Preconditions

- Membership of the `@kiomon` npm org, with 2FA satisfied (npm requires it to publish).
- The version bumped in **both** `sdk/package.json` and `kiomon/package.json`, and the
  `@kiomon/kiomon` range inside `kiomon/package.json` updated to match.
- Publishing is permanent. A version can be unpublished only within 72 hours and leaves the name
  burned for reuse.

Name availability, re-checked 2026-10-09: `@kiomon/kiomon` and unscoped `kiomon` both return 404, and
PyPI `kiomon` is likewise unclaimed. `@kiomon/mcp-server` resolves, confirming the `@kiomon` scope
exists and is ours.

## Publish

Order matters — the alias depends on the implementation, so publish the implementation first.

```bash
# 1. The implementation (prepublishOnly runs `npm run build`, so dist/ is fresh)
cd sdk
npm publish --access public

# 2. The unscoped alias, which depends on the version just published
cd ../kiomon
npm publish --access public
```

`--access public` is required for the scoped package; the unscoped one is public by default but the
flag is harmless and keeps the two commands identical.

## Verify

```bash
npm view @kiomon/kiomon version
npm view kiomon version

# Both names must resolve to the same implementation
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install kiomon
node -e "import('kiomon').then(m => console.log(Object.keys(m)))"
# -> [ 'Kiomon', 'KiomonError', 'codeForStatus', 'isKiomonError' ]
```

## Automation

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, tests and build on Node
20, 22 and 24, plus a packaging job that inspects both tarballs. There is no release workflow yet.
Adding one — tag-triggered, publishing both packages in the order above with `--provenance` so
consumers get a signed supply-chain attestation — is the next step, and is what would make the
manual ordering above impossible to get wrong.

## Files that must stay in step

`LICENSE` is duplicated at the repository root and inside each package, because npm auto-includes a
licence only from the package directory itself. The three copies are byte-identical; if the licence
ever changes, change all three.
