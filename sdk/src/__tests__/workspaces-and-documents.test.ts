/**
 * The SDK-only verbs that make the memory verbs usable from a cold start.
 *
 * `createWorkspace`, `ingestDocument`, `listDocuments` and `deleteDocument` have
 * no MCP equivalent — they exist because without them a caller cannot make the
 * workspace `selectWorkspace` needs, nor put anything in it for `searchMemory`
 * to find.
 *
 * The `User-Agent` assertions live here too: the header is part of the same
 * "can this SDK be used at all" contract, since an unidentified request is what
 * an edge can refuse.
 */
import { describe, expect, it } from "vitest";
import { Kiomon } from "../client.js";
import { KiomonError } from "../errors.js";
import { SDK_VERSION, USER_AGENT } from "../version.js";

interface RecordedCall {
	url: string;
	init: RequestInit;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: RecordedCall[] = [];
	const fn = (async (input: unknown, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init });
		return handler(url, init);
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function headerOf(call: RecordedCall, name: string): string | undefined {
	const headers = call.init.headers as Record<string, string> | undefined;
	return headers?.[name];
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function queryOf(call: RecordedCall): URLSearchParams {
	return new URL(call.url).searchParams;
}

function client(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
	return new Kiomon({
		apiKey: "sk_kiomon_test",
		baseUrl: "https://api.example.test",
		fetch: fetchImpl,
		...options,
	});
}

const WORKSPACE = {
	id: "ws_new",
	user_id: "u_1",
	name: "W",
	slug: "w-abc123",
	org_id: "org_1",
	created_at: "t",
};
const DOCUMENT_LIST = { documents: [], limit: 20, offset: 0, total: 0, counts: {} };

describe("User-Agent", () => {
	it("identifies the SDK on every request", async () => {
		const { fetch, calls } = mockFetch(() => json({ workspaces: [] }));
		await client(fetch).listWorkspaces();
		expect(headerOf(calls[0]!, "User-Agent")).toBe(USER_AGENT);
	});

	it("carries the package version", () => {
		expect(USER_AGENT).toBe(`kiomon-typescript-sdk/${SDK_VERSION}`);
		expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("can be overridden by the caller", async () => {
		const { fetch, calls } = mockFetch(() => json({ workspaces: [] }));
		await client(fetch, { headers: { "User-Agent": "my-app/2.0" } }).listWorkspaces();
		expect(headerOf(calls[0]!, "User-Agent")).toBe("my-app/2.0");
	});
});

describe("createWorkspace", () => {
	it("posts to the workspace route with an idempotency key", async () => {
		const { fetch, calls } = mockFetch(() => json(WORKSPACE, 201));
		const result = await client(fetch).createWorkspace({ name: "Research" });

		expect(calls[0]!.init.method).toBe("POST");
		expect(new URL(calls[0]!.url).pathname).toBe("/api/workspaces");
		expect(bodyOf(calls[0]!)).toEqual({ name: "Research" });
		expect(headerOf(calls[0]!, "Idempotency-Key")).toBeTruthy();
		expect(result.id).toBe("ws_new");
	});

	it("places the workspace in an org when asked", async () => {
		const { fetch, calls } = mockFetch(() => json(WORKSPACE, 201));
		await client(fetch).createWorkspace({ name: "Research", org_id: "org_1" });
		expect(bodyOf(calls[0]!)).toEqual({ name: "Research", org_id: "org_1" });
	});

	it("omits org_id rather than sending null", async () => {
		const { fetch, calls } = mockFetch(() => json(WORKSPACE, 201));
		await client(fetch).createWorkspace({ name: "Research" });
		expect(bodyOf(calls[0]!)).not.toHaveProperty("org_id");
	});

	it("rejects an empty name without a request", () => {
		const { fetch, calls } = mockFetch(() => json({}));
		expect(() => client(fetch).createWorkspace({ name: "   " })).toThrow(KiomonError);
		expect(calls).toHaveLength(0);
	});

	it("rejects an empty org_id", () => {
		const { fetch } = mockFetch(() => json({}));
		expect(() => client(fetch).createWorkspace({ name: "W", org_id: "" })).toThrow(/org_id/);
	});

	it("surfaces a free-plan ceiling as quota_exceeded", async () => {
		const { fetch } = mockFetch(() =>
			json({ error: "Workspace limit reached.", code: "quota_exceeded" }, 402),
		);
		await expect(client(fetch).createWorkspace({ name: "W" })).rejects.toMatchObject({
			code: "quota_exceeded",
		});
	});
});

describe("ingestDocument", () => {
	it("posts the body to the document route", async () => {
		const { fetch, calls } = mockFetch(() => json({ id: "doc_1", tags: ["a"] }, 201));
		const result = await client(fetch).ingestDocument({ body: "# Title\n\nText." });

		expect(calls[0]!.init.method).toBe("POST");
		expect(new URL(calls[0]!.url).pathname).toBe("/api/documents");
		expect(bodyOf(calls[0]!)).toEqual({ body: "# Title\n\nText." });
		expect(result.id).toBe("doc_1");
	});

	it("carries the optional metadata", async () => {
		const { fetch, calls } = mockFetch(() => json({ id: "doc_1" }, 201));
		await client(fetch).ingestDocument({
			body: "b",
			title: "T",
			source_url: "https://example.test/a",
			tags: ["runbook", "deploy"],
			kind: "procedural",
		});
		expect(bodyOf(calls[0]!)).toEqual({
			body: "b",
			title: "T",
			source_url: "https://example.test/a",
			tags: ["runbook", "deploy"],
			kind: "procedural",
		});
	});

	it("attaches the bound workspace, and lets an explicit one win", async () => {
		const { fetch, calls } = mockFetch(() => json({ id: "doc_1" }, 201));
		await client(fetch, { workspaceId: "ws_bound" }).ingestDocument({ body: "b" });
		expect(bodyOf(calls[0]!).workspace_id).toBe("ws_bound");

		await client(fetch, { workspaceId: "ws_bound" }).ingestDocument({
			body: "b",
			workspace_id: "ws_explicit",
		});
		expect(bodyOf(calls[1]!).workspace_id).toBe("ws_explicit");
	});

	it("passes source_url through — it is what makes a second save a no-op", async () => {
		const { fetch, calls } = mockFetch(() => json({ id: "doc_1" }, 201));
		await client(fetch).ingestDocument({ body: "b", source_url: "https://example.test/a" });
		expect(bodyOf(calls[0]!).source_url).toBe("https://example.test/a");
	});

	it("reports a duplicate rather than hiding it", async () => {
		const { fetch } = mockFetch(() => json({ duplicate: true, id: "doc_old", created_at: "t" }));
		const result = await client(fetch).ingestDocument({ body: "b" });
		expect(result.duplicate).toBe(true);
		expect(result.id).toBe("doc_old");
	});

	it("rejects an empty body without a request", () => {
		const { fetch, calls } = mockFetch(() => json({}));
		expect(() => client(fetch).ingestDocument({ body: "" })).toThrow(KiomonError);
		expect(calls).toHaveLength(0);
	});

	it("rejects an unknown kind", () => {
		const { fetch } = mockFetch(() => json({}));
		expect(() => client(fetch).ingestDocument({ body: "b", kind: "note" as never })).toThrow(/kind/);
	});

	it("rejects non-string tags", () => {
		const { fetch } = mockFetch(() => json({}));
		expect(() => client(fetch).ingestDocument({ body: "b", tags: ["ok", 3 as never] })).toThrow(/tags/);
	});
});

describe("listDocuments", () => {
	it("reads the document route with no filters", async () => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		await client(fetch).listDocuments();

		expect(calls[0]!.init.method ?? "GET").toBe("GET");
		expect(new URL(calls[0]!.url).pathname).toBe("/api/documents");
		expect([...queryOf(calls[0]!).keys()]).toEqual([]);
	});

	it("maps every filter onto the query string", async () => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		await client(fetch).listDocuments({
			query: "deploy",
			kind: "procedural",
			tag: "runbook",
			status: "active",
			source: "user_saved",
			sort: "oldest",
			since: "2026-01-01",
			index_status: "all",
			limit: 5,
			offset: 10,
		});

		const params = queryOf(calls[0]!);
		expect(params.get("q")).toBe("deploy");
		expect(params.get("kind")).toBe("procedural");
		expect(params.get("tag")).toBe("runbook");
		expect(params.get("status")).toBe("active");
		expect(params.get("source")).toBe("user_saved");
		expect(params.get("sort")).toBe("oldest");
		expect(params.get("since")).toBe("2026-01-01");
		expect(params.get("index_status")).toBe("all");
		expect(params.get("limit")).toBe("5");
		expect(params.get("offset")).toBe("10");
	});

	it("attaches the bound workspace", async () => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		await client(fetch, { workspaceId: "ws_bound" }).listDocuments();
		expect(queryOf(calls[0]!).get("workspace_id")).toBe("ws_bound");
	});

	it("returns the page and the counts", async () => {
		const { fetch } = mockFetch(() =>
			json({
				documents: [{ id: "doc_1", title: "T", kind: "semantic", rank: 0.4 }],
				limit: 20,
				offset: 0,
				total: 12,
				counts: { total: 12, semantic: 9, episodic: 1, procedural: 2, reference: 0, pinned: 0 },
			}),
		);
		const result = await client(fetch).listDocuments();
		expect(result.total).toBe(12);
		expect(result.counts.semantic).toBe(9);
		expect(result.documents[0]!.rank).toBe(0.4);
	});

	it.each([0, 201, -1])("enforces the page ceiling locally (%i)", (limit) => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		expect(() => client(fetch).listDocuments({ limit })).toThrow(/between 1 and 200/);
		expect(calls).toHaveLength(0);
	});

	it("rejects a negative offset", () => {
		const { fetch } = mockFetch(() => json(DOCUMENT_LIST));
		expect(() => client(fetch).listDocuments({ offset: -1 })).toThrow(/offset/);
	});

	it.each(["deleted", "ACTIVE", ""])("rejects an unknown status (%s)", (status) => {
		const { fetch } = mockFetch(() => json(DOCUMENT_LIST));
		expect(() => client(fetch).listDocuments({ status: status as never })).toThrow(/status/);
	});

	it("rejects an unknown sort", () => {
		const { fetch } = mockFetch(() => json(DOCUMENT_LIST));
		expect(() => client(fetch).listDocuments({ sort: "newest" as never })).toThrow(/sort/);
	});

	it("rejects an unknown kind", () => {
		const { fetch } = mockFetch(() => json(DOCUMENT_LIST));
		expect(() => client(fetch).listDocuments({ kind: "note" as never })).toThrow(/kind/);
	});

	it("omits index_status by default, so the server's findable-only filter applies", async () => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		await client(fetch).listDocuments();
		expect(queryOf(calls[0]!).has("index_status")).toBe(false);
	});

	it("passes index_status=all through, to see unindexed and failed rows", async () => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		await client(fetch).listDocuments({ index_status: "all" });
		expect(queryOf(calls[0]!).get("index_status")).toBe("all");
	});

	it.each(["pending", "READY", "indexing"])("rejects an unknown index_status (%s)", (index_status) => {
		const { fetch, calls } = mockFetch(() => json(DOCUMENT_LIST));
		expect(() => client(fetch).listDocuments({ index_status: index_status as never })).toThrow(
			/index_status/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("deleteDocument", () => {
	it("deletes the document route", async () => {
		const { fetch, calls } = mockFetch(() => json({ deleted: true }));
		const result = await client(fetch).deleteDocument("doc_1");

		expect(calls[0]!.init.method).toBe("DELETE");
		expect(new URL(calls[0]!.url).pathname).toBe("/api/documents/doc_1");
		expect(result.deleted).toBe(true);
	});

	it("escapes an id that needs it", async () => {
		const { fetch, calls } = mockFetch(() => json({ deleted: true }));
		await client(fetch).deleteDocument("doc/../1");
		expect(new URL(calls[0]!.url).pathname).toBe("/api/documents/doc%2F..%2F1");
	});

	it("rejects an empty id without a request", () => {
		const { fetch, calls } = mockFetch(() => json({ deleted: true }));
		expect(() => client(fetch).deleteDocument("")).toThrow(KiomonError);
		expect(calls).toHaveLength(0);
	});
});

describe("the dead end these verbs remove", () => {
	it("points at createWorkspace, not the dashboard", async () => {
		const { fetch } = mockFetch(() => json({ workspaces: [] }));
		await expect(client(fetch).getWorkspaceContext()).rejects.toThrow(/createWorkspace\(\)/);
	});
});
