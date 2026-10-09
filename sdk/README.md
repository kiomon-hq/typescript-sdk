# @kiomon/kiomon

The Kiomon SDK — persistent memory for AI agents and apps. Capture what your users
read and decide, retrieve it with provenance, and govern its lifecycle, from your
own product.

Zero runtime dependencies. Node 18+, browsers, Bun, Deno and Workers (anything with
a global `fetch`).

```bash
npm install @kiomon/kiomon
```

The same SDK is published unscoped as [`kiomon`](https://www.npmjs.com/package/kiomon), so
`npm install kiomon` and `import { Kiomon } from "kiomon"` work identically — it is a re-export, and
the two can never differ in behaviour. Use whichever you prefer; see
[`../kiomon/README.md`](../kiomon/README.md).

## Quickstart

```ts
import { Kiomon } from "@kiomon/kiomon";

const kiomon = new Kiomon({ apiKey: process.env.KIOMON_API_KEY! });

// Retrieval first: ask for a context packet, not a list of documents.
const packet = await kiomon.retrieveMemory({
  intent: "execute",
  query: "how does our deploy pipeline work?",
});

// packet.facts / packet.procedure / packet.episodes carry claims, confidence and
// source_ref provenance. packet.conflicts and packet.warnings tell you where the
// brain disagrees with itself — surface those instead of silently picking one.

// Tell the brain whether it helped. This is what makes ranking and decay honest.
await kiomon.recordOutcome({
  outcome: "success",
  items: packet.retrieved_ids.map((memory_id) => ({ memory_id, assessment: "explained the deploy step" })),
});
```

## Authentication

| Mode | Option | Header | Use for |
|---|---|---|---|
| Server-side key | `apiKey` | `X-API-Key` | Your backend, worker, or agent service |
| Delegated OAuth | `token` | `Authorization: Bearer` | Acting on behalf of *your* user, via Kiomon's OAuth server |

```ts
// A function is resolved per request, so token refresh needs no client rebuild.
const kiomon = new Kiomon({ token: async () => await getKiomonTokenFor(user) });
```

> **Delegated tokens are confined.** A `koa_…` connector token is restricted by the
> worker's default-deny allowlist to the memory routes. `request()` is not a
> general escape hatch in that mode.

## The 12 verbs

The SDK mirrors Kiomon's hosted MCP toolset method for method, so a capability you
have in an agent you also have here.

| Method | What it does |
|---|---|
| `retrieveMemory({ intent, query, … })` | Intent-aware context packet with provenance, conflicts and warnings |
| `searchMemory({ query, kind?, limit? })` | Hybrid keyword + semantic search |
| `getMemory(id)` | One memory by id |
| `getWorkspaceContext({ topic? })` | Orientation pack — "where was I" |
| `getLatestBriefing()` | The most recent proactive briefing |
| `reflectSession({ learnings })` | Save up to 25 learnings through the autonomous write gate |
| `draftMemory(learning)` | Save one learning |
| `manageMemory({ id, action, value? })` | `pin` · `unpin` · `archive` · `restore` · `forget` · `rate` · `approve` · `reject` · `revert` |
| `exploreMemoryGraph({ id, relation?, depth? })` | Multi-hop traversal of the memory graph |
| `recordOutcome({ outcome, items })` | Report whether retrieved memories helped |
| `listWorkspaces()` | Every workspace this credential can reach |
| `selectWorkspace(id)` | Bind the client to a workspace (chainable) |

Writes go through the same **write gate** as the dashboard: a high-confidence
learning may activate immediately, anything uncertain lands in the Review Inbox
rather than silently becoming knowledge.

## Workspaces

Pass `workspaceId` to the constructor, or rely on resolution: exactly one workspace
resolves silently, and more than one is an error rather than a guess — writing a
memory into the wrong brain is worse than failing.

```ts
const kiomon = new Kiomon({ apiKey }).selectWorkspace("ws_…");
```

## Errors

```ts
import { KiomonError, isKiomonError } from "@kiomon/kiomon";

try {
  await kiomon.retrieveMemory({ intent: "plan", query: "q" });
} catch (error) {
  if (!isKiomonError(error)) throw error;

  switch (error.code) {
    case "quota_exceeded": // HTTP 402 on Free
      return showUpgrade(error.needsUpgrade);
    case "rate_limited":
    case "server_error":
      return retryLater(); // error.retryable === true
    case "not_found": // may mean "no access" — the API fails closed with 404
      return handleMissing();
  }
}
```

**Failure contract.** An invalid *argument* throws synchronously, so a programming
error is never buried in a promise chain. Anything that fails for *remote* reasons
rejects with a `KiomonError` carrying `status`, `code`, `needsUpgrade`, `requestId`
and `retryable`.

Codes, grouped by what you would actually do about them:

| Group | Codes |
|---|---|
| Bad request | `bad_request`, `validation_failed`, `payload_too_large` |
| Credentials | `unauthorized`, `account_pending_deletion`, `forbidden`, `insufficient_role`, `connector_scope_denied` |
| Absence | `not_found` — deliberately undifferentiated, see below |
| State | `conflict`, `duplicate`, `idempotency_conflict`, `idempotency_in_progress` |
| Limits | `quota_exceeded`, `pro_required`, `rate_limited` |
| Infrastructure | `service_unavailable`, `internal_error` |
| Raised by this SDK | `invalid_request` (bad arguments), `timeout`, `network_error` |

A code supplied by the server wins over the status mapping, and an unrecognised one passes through
unchanged, so a new server code never requires an SDK upgrade.

Two deliberate rough edges: **`not_found` does not distinguish "no access" from "does not
exist"**, because the API fails closed with 404 rather than confirming that a resource exists — so
treat it as "not available to you". And **`needsUpgrade` is present but `false` on a Pro rate
limit**, so the field is always safe to read when the code is a limit.

## Retries and idempotency

Reads retry automatically on `429`, `5xx`, timeouts and network failure, with exponential backoff
and jitter. A `retry_after` value in the error body is respected when present, though the API does
not currently send one — the SDK calculates its own backoff.

Every write carries an `Idempotency-Key` — generated per call, or passed in — and
the same key is reused across retries, so a replayed write cannot double-apply:

```ts
await kiomon.reflectSession({ learnings }, { idempotencyKey: `session-${sessionId}` });
```

Pass your own key when the retry may originate from a *different process*.

## Escape hatch

```ts
const stats = await kiomon.request<{ total: number }>("/api/user/stats");
```

Every REST endpoint is reachable here, so the SDK never blocks you on a new route.

## Status

`0.1.0`. Complete against the shipped API. Server error responses carry a machine-readable `code`
(the SDK prefers it when present and falls back to status mapping when it is absent), and writes
are deduplicated server-side by the `Idempotency-Key` this SDK sends on every write.

The package is **not published yet**; until it is, install it from a checkout.

MIT © Kiomon
