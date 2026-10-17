/**
 * The listing and graph verbs, and the workspace scoping both depend on.
 *
 * `listMemories` is the SDK's half of MCP `list_memories`: without it a caller
 * could search but never see what the write gate held back. The graph assertions
 * are here because the walk is workspace-scoped on the server and its default is
 * the *credential's* workspace — not the selected one — so a missing
 * `workspace_id` reads a different brain and says nothing about it.
 */
import { describe, expect, it } from "vitest";
import { Kiomon } from "../client.js";
import { KiomonError } from "../errors.js";

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

function queryOf(call: RecordedCall): URLSearchParams {
	return new URL(call.url).searchParams;
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function client(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
	return new Kiomon({
		apiKey: "sk_kiomon_test",
		baseUrl: "https://api.example.test",
		fetch: fetchImpl,
		...options,
	});
}

const MEMORY_PAGE = {
	memories: [
		{
			id: "mem_1",
			title: "Deploys go through the pipeline",
			excerpt: "Never deploy from a laptop",
			kind: "semantic",
			status: "pending_approval",
			pinned: 0,
			tags: "[\"ops\"]",
			source: "agent_reflection",
			source_url: "manual:eid_1",
			workspace_id: "ws_1",
			created_at: "2026-10-17T00:00:00Z",
			confidence: 0.6,
			memory_metadata: null,
		},
	],
	status: "pending_approval",
	limit: 50,
	offset: 0,
	total: 1,
};

describe("listMemories", () => {
	it("defaults to the Review Inbox and a 50-row page", async () => {
		const mock = mockFetch(() => json(MEMORY_PAGE));
		const page = await client(mock.fetch).listMemories();

		const query = queryOf(mock.calls[0]!);
		expect(mock.calls[0]!.url).toContain("/api/memories");
		expect(query.get("status")).toBe("pending_approval");
		expect(query.get("limit")).toBe("50");
		expect(query.has("workspace_id")).toBe(false);
		expect(page.memories[0]!.id).toBe("mem_1");
		expect(page.memories[0]!.tags).toBe("[\"ops\"]");
		expect(page.total).toBe(1);
	});

	it("passes every filter through, mapping query onto q", async () => {
		const mock = mockFetch(() => json({ ...MEMORY_PAGE, status: "active" }));
		await client(mock.fetch).listMemories({
			status: "active",
			kind: "procedural",
			query: "deploy",
			limit: 10,
			offset: 20,
			workspace_id: "ws_9",
		});

		const query = queryOf(mock.calls[0]!);
		expect(query.get("status")).toBe("active");
		expect(query.get("kind")).toBe("procedural");
		expect(query.get("q")).toBe("deploy");
		expect(query.get("limit")).toBe("10");
		expect(query.get("offset")).toBe("20");
		expect(query.get("workspace_id")).toBe("ws_9");
	});

	it("falls back to the selected workspace", async () => {
		const mock = mockFetch(() => json(MEMORY_PAGE));
		await client(mock.fetch).selectWorkspace("ws_selected").listMemories();

		expect(queryOf(mock.calls[0]!).get("workspace_id")).toBe("ws_selected");
	});

	it("is a read: no idempotency key", async () => {
		const mock = mockFetch(() => json(MEMORY_PAGE));
		await client(mock.fetch).listMemories();

		expect(mock.calls[0]!.init.method ?? "GET").toBe("GET");
		expect((mock.calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
	});

	it("rejects a bad status, kind, limit or offset before any request", async () => {
		const mock = mockFetch(() => json(MEMORY_PAGE));
		const kiomon = client(mock.fetch);

		expect(() => kiomon.listMemories({ status: "pending" as never })).toThrow(KiomonError);
		expect(() => kiomon.listMemories({ kind: "note" as never })).toThrow(KiomonError);
		expect(() => kiomon.listMemories({ limit: 0 })).toThrow(KiomonError);
		expect(() => kiomon.listMemories({ limit: 201 })).toThrow(KiomonError);
		expect(() => kiomon.listMemories({ offset: -1 })).toThrow(KiomonError);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("exploreMemoryGraph", () => {
	it("scopes the walk to the selected workspace", async () => {
		const mock = mockFetch(() => json({ nodes: [], edges: [] }));
		await client(mock.fetch)
			.selectWorkspace("ws_selected")
			.exploreMemoryGraph({ id: "mem_1" });

		const query = queryOf(mock.calls[0]!);
		expect(query.get("center_id")).toBe("mem_1");
		expect(query.get("depth")).toBe("1");
		expect(query.get("workspace_id")).toBe("ws_selected");
	});

	it("lets an explicit workspace override the selection", async () => {
		const mock = mockFetch(() => json({ nodes: [], edges: [] }));
		await client(mock.fetch)
			.selectWorkspace("ws_selected")
			.exploreMemoryGraph({ id: "mem_1", relation: "contradicts", depth: 2, workspace_id: "ws_other" });

		const query = queryOf(mock.calls[0]!);
		expect(query.get("workspace_id")).toBe("ws_other");
		expect(query.get("relation")).toBe("contradicts");
		expect(query.get("depth")).toBe("2");
	});
});

describe("recordOutcome", () => {
	it("sends the assessment vocabulary the server accepts", async () => {
		const mock = mockFetch(() => json({ updated: ["mem_1"], skipped: [] }));
		await client(mock.fetch).recordOutcome({
			outcome: "success",
			items: [
				{ memory_id: "mem_1", assessment: "helpful" },
				{ memory_id: "mem_2", assessment: "outdated" },
			],
		});

		expect(bodyOf(mock.calls[0]!).items).toEqual([
			{ memory_id: "mem_1", assessment: "helpful" },
			{ memory_id: "mem_2", assessment: "outdated" },
		]);
	});
});
