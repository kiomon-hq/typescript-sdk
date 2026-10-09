# kiomon

The **unscoped alias** of [`@kiomon/kiomon`](https://www.npmjs.com/package/@kiomon/kiomon) — the
Kiomon SDK for building persistent memory into your own product.

```bash
npm install kiomon
```

```ts
import { Kiomon } from "kiomon";
```

Everything documented in [`@kiomon/kiomon`](../sdk/README.md) applies unchanged: the same 12
memory-native verbs, typed errors, retries and idempotent writes, zero runtime dependencies.

## Why two packages exist

They are the same SDK. `@kiomon/kiomon` is the canonical, scoped package name; `kiomon` is
published so the unscoped name belongs to Kiomon rather than to a third party, and so npm matches
the PyPI package the Python SDK will use. This package re-exports the implementation, so the two
can never drift in behaviour — only the dependency range is maintained here.

Prefer `@kiomon/kiomon` in shared code if you want the scope to make the origin obvious, and
`kiomon` if you want the shorter import. Both are supported.

MIT © Kiomon
