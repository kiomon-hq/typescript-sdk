# Kiomon TypeScript SDK

[![CI](https://github.com/kiomon-hq/typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/kiomon-hq/typescript-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The Kiomon SDK for JavaScript and TypeScript — persistent memory for AI agents and apps.
Capture what your users read and decide, retrieve it with provenance, and govern its
lifecycle, from your own product.

Two packages are published from this repository:

| Directory | npm name | Role |
|---|---|---|
| [`sdk/`](sdk) | [`@kiomon/kiomon`](https://www.npmjs.com/package/@kiomon/kiomon) | the implementation |
| [`kiomon/`](kiomon) | [`kiomon`](https://www.npmjs.com/package/kiomon) | unscoped alias that re-exports it |

They are the same SDK, so `npm install @kiomon/kiomon` and `npm install kiomon` behave
identically. Use whichever import you prefer:

```ts
import { Kiomon } from "@kiomon/kiomon";
// or
import { Kiomon } from "kiomon";
```

```ts
const kiomon = new Kiomon({ apiKey: process.env.KIOMON_API_KEY! });

const packet = await kiomon.retrieveMemory({
  intent: "execute",
  query: "how does our deploy pipeline work?",
});
```

Zero runtime dependencies. Node 18+, browsers, Bun, Deno and Workers — anything with a
global `fetch`. The full surface, every option and every error code are documented in
[`sdk/README.md`](sdk/README.md).

## Repository layout

```
sdk/       @kiomon/kiomon — the implementation (TypeScript source, tests, tsconfig)
kiomon/    kiomon — unscoped alias package (a re-export, plus its package metadata)
```

The root `package.json` is an npm workspace named `kiomon-monorepo` and marked
`private: true`. That matters: were the root named `kiomon`, it would collide with the
`kiomon` workspace inside the same install.

## Development

```bash
npm install          # links both workspaces
npm run check        # typecheck + tests + build
npm test             # vitest
npm run build        # tsc into sdk/dist
```

## Status

`0.1.0`. Complete against the shipped API. Neither package is published yet; see
[`RELEASING.md`](sdk/RELEASING.md) for the release process.

## License

MIT © Kiomon
