import { describe, expect, it, vi } from "vitest";
import { Kiomon } from "../client.js";
import { KiomonError, codeForStatus, isKiomonError } from "../errors.js";

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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function headerOf(call: RecordedCall, name: string): string | undefined {
	const headers = call.init.headers as Record<string, string> | undefined;
	return headers?.[name];
}

function client(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
	return new Kiomon({
		apiKey: "sk_kiomon_test",
		baseUrl: "https://api.example.test",
		fetch: fetchImpl,
		...options,
	});
}

describe("construction", () => {
	it("requires credentials", () => {
		expect(() => new Kiomon({})).toThrow(KiomonError);
	});

	it("rejects both credential types at once", () => {
		expect(() => new Kiomon({ apiKey: "a", token: "b" })).toThrow(/not both/);
	});

	it("sends an API key as X-API-Key", async () => {
		const { fetch, calls } = mockFetch(() => json({ results: [] }));
		await client(fetch).searchMemory({ query: "x" });
		expect(headerOf(calls[0]!, "X-API-Key")).toBe("sk_kiomon_test");
		expect(headerOf(calls[0]!, "Authorization")).toBeUndefined();
	});

	it("sends a delegated token as a bearer header, resolving it per request", async () => {
		const { fetch, calls } = mockFetch(() => json({ workspaces: [] }));
		const token = vi.fn(async () => "koa_fresh");
		const kiomon = new Kiomon({ token, baseUrl: "https://api.example.test", fetch });

		await kiomon.listWorkspaces();
		await kiomon.listWorkspaces();

		expect(headerOf(calls[0]!, "Authorization")).toBe("Bearer koa_fresh");
		expect(token).toHaveBeenCalledTimes(2);
	});

	it("identifies itself in telemetry", async () => {
		const { fetch, calls } = mockFetch(() => json({ results: [] }));
		await client(fetch).searchMemory({ query: "x" });
		expect(headerOf(calls[0]!, "X-Agent-Id")).toBe("sdk");
	});
});

describe("verbs map to the documented REST surface", () => {
	it("searchMemory builds a query string and omits an unset workspace", async () => {
		const { fetch, calls } = mockFetch(() => json({ results: [] }));
		await client(fetch).searchMemory({ query: "vector db", kind: "reference", limit: 3 });

		const url = new URL(calls[0]!.url);
		expect(url.pathname).toBe("/api/search");
		expect(url.searchParams.get("q")).toBe("vector db");
		expect(url.searchParams.get("kind")).toBe("reference");
		expect(url.searchParams.get("limit")).toBe("3");
		expect(url.searchParams.has("workspace_id")).toBe(false);
	});

	it("getMemory targets the document route", async () => {
		const { fetch, calls } = mockFetch(() => json({ id: "doc_1" }));
		await client(fetch).getMemory("doc_1");
		expect(new URL(calls[0]!.url).pathname).toBe("/api/documents/doc_1");
	});

	it("reflectSession posts learnings to the batch-draft route", async () => {
		const { fetch, calls } = mockFetch(() =>
			json({ drafted: 1, promoted: [], pending: [], memories: [] }),
		);
		await client(fetch, { workspaceId: "ws_1" }).reflectSession({
			learnings: [{ kind: "semantic", title: "T", body: "B" }],
		});

		expect(new URL(calls[0]!.url).pathname).toBe("/api/memories/batch-draft");
		expect(calls[0]!.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
			workspace_id: "ws_1",
			learnings: [{ kind: "semantic", title: "T", body: "B" }],
		});
	});

	it("retrieveMemory posts the intent packet request", async () => {
		const { fetch, calls } = mockFetch(() => json({ summary: "", facts: [], episodes: [] }));
		await client(fetch, { workspaceId: "ws_1" }).retrieveMemory({ intent: "execute", query: "deploy" });

		expect(new URL(calls[0]!.url).pathname).toBe("/api/retrieve");
		expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
			intent: "execute",
			query: "deploy",
			workspace_id: "ws_1",
		});
	});

	it("manageMemory dispatches each action to its endpoint", async () => {
		const cases: [Parameters<Kiomon["manageMemory"]>[0], string, string][] = [
			[{ id: "m1", action: "pin" }, "PATCH", "/api/documents/m1"],
			[{ id: "m1", action: "archive" }, "POST", "/api/documents/m1/archive"],
			[{ id: "m1", action: "rate", value: 1 }, "POST", "/api/documents/m1/rate"],
			[{ id: "m1", action: "revert" }, "POST", "/api/memories/m1/revert"],
		];
		for (const [args, method, path] of cases) {
			const { fetch, calls } = mockFetch(() => json({ ok: true }));
			await client(fetch).manageMemory(args);
			expect(calls[0]!.init.method).toBe(method);
			expect(new URL(calls[0]!.url).pathname).toBe(path);
		}
	});

	it("request() reaches any route", async () => {
		const { fetch, calls } = mockFetch(() => json({ anything: true }));
		const result = await client(fetch).request<{ anything: boolean }>("/api/user/stats");
		expect(result).toEqual({ anything: true });
		expect(new URL(calls[0]!.url).pathname).toBe("/api/user/stats");
	});
});

describe("workspace resolution", () => {
	it("resolves a single workspace silently, then caches it", async () => {
		const { fetch, calls } = mockFetch((url) =>
			url.includes("/api/workspaces/ws_only/context")
				? json({ summary: "context" })
				: json({ workspaces: [{ id: "ws_only", slug: "solo" }] }),
		);
		const kiomon = client(fetch);

		await kiomon.getWorkspaceContext();
		await kiomon.getWorkspaceContext();

		expect(kiomon.workspaceId).toBe("ws_only");
		// One lookup total: the resolved workspace is cached across calls.
		expect(calls.filter((c) => new URL(c.url).pathname === "/api/workspaces")).toHaveLength(1);
	});

	it("refuses to guess when several workspaces exist", async () => {
		const { fetch } = mockFetch(() =>
			json({
				workspaces: [
					{ id: "ws_a", slug: "alpha" },
					{ id: "ws_b", slug: "beta" },
				],
			}),
		);
		const error = await client(fetch)
			.getLatestBriefing()
			.catch((e: unknown) => e);

		expect(isKiomonError(error)).toBe(true);
		expect((error as KiomonError).code).toBe("invalid_request");
		expect((error as KiomonError).message).toContain("ws_a");
		expect((error as KiomonError).message).toContain("beta");
	});

	it("selectWorkspace binds the client and chains", async () => {
		const { fetch, calls } = mockFetch(() => json({ summary: "" }));
		const kiomon = client(fetch).selectWorkspace("ws_chosen");
		await kiomon.getWorkspaceContext();

		expect(new URL(calls[0]!.url).pathname).toBe("/api/workspaces/ws_chosen/context");
	});
});

describe("errors", () => {
	it("maps statuses to codes, matching the worker's own fallback table", () => {
		expect(codeForStatus(400)).toBe("bad_request");
		expect(codeForStatus(401)).toBe("unauthorized");
		expect(codeForStatus(402)).toBe("quota_exceeded");
		expect(codeForStatus(403)).toBe("forbidden");
		expect(codeForStatus(404)).toBe("not_found");
		expect(codeForStatus(409)).toBe("conflict");
		expect(codeForStatus(413)).toBe("payload_too_large");
		expect(codeForStatus(429)).toBe("rate_limited");
		expect(codeForStatus(500)).toBe("internal_error");
	});

	it("treats an unmapped 5xx as unavailable and an unmapped 4xx as a bad request", () => {
		// A 504 from the edge is not this SDK's own timeout, which it raises separately.
		expect(codeForStatus(502)).toBe("service_unavailable");
		expect(codeForStatus(503)).toBe("service_unavailable");
		expect(codeForStatus(504)).toBe("service_unavailable");
		expect(codeForStatus(418)).toBe("bad_request");
	});

	it("surfaces the API message and marks Free-plan quota rejections as upgradeable", async () => {
		const { fetch } = mockFetch(() => json({ error: "Free plan limit reached", needsUpgrade: true }, 402));
		const error = (await client(fetch)
			.searchMemory({ query: "x" })
			.catch((e: unknown) => e)) as KiomonError;

		expect(error.code).toBe("quota_exceeded");
		expect(error.needsUpgrade).toBe(true);
		expect(error.message).toBe("Free plan limit reached");
		expect(error.retryable).toBe(false);
	});

	it("passes a server-supplied code through, including one this version has never heard of", async () => {
		const { fetch } = mockFetch(() => json({ error: "nope", code: "insufficient_role" }, 403));
		const error = (await client(fetch)
			.searchMemory({ query: "x" })
			.catch((e: unknown) => e)) as KiomonError;
		expect(error.code).toBe("insufficient_role");

		const { fetch: unknownCode } = mockFetch(() => json({ error: "nope", code: "brand_new" }, 400));
		const passthrough = (await client(unknownCode)
			.searchMemory({ query: "x" })
			.catch((e: unknown) => e)) as KiomonError;
		expect(passthrough.code).toBe("brand_new");
	});

	it("treats an upgrade prompt as terminal, not retryable", async () => {
		for (const [status, code] of [
			[402, "quota_exceeded"],
			[402, "pro_required"],
		] as const) {
			const { fetch } = mockFetch(() => json({ error: "upgrade", code }, status));
			const error = (await client(fetch)
				.searchMemory({ query: "x" })
				.catch((e: unknown) => e)) as KiomonError;
			expect(error.needsUpgrade).toBe(true);
			expect(error.retryable).toBe(false);
		}
	});

	it("keeps a 404 meaningful, since denial also returns 404", async () => {
		const { fetch } = mockFetch(() => json({ error: "Not found" }, 404));
		const error = (await client(fetch)
			.getMemory("m_missing")
			.catch((e: unknown) => e)) as KiomonError;
		expect(error.code).toBe("not_found");
		expect(error.status).toBe(404);
	});

	it("wraps a transport failure as network_error", async () => {
		const { fetch } = mockFetch(() => {
			throw new TypeError("fetch failed");
		});
		const error = (await client(fetch)
			.searchMemory({ query: "x" })
			.catch((e: unknown) => e)) as KiomonError;
		expect(error.code).toBe("network_error");
		expect(error.retryable).toBe(true);
	});

	it("reports a timeout distinctly from a caller abort", async () => {
		const { fetch } = mockFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						const abort = new Error("aborted");
						abort.name = "AbortError";
						reject(abort);
					});
				}),
		);
		const error = (await client(fetch, { timeoutMs: 5 })
			.searchMemory({ query: "x" })
			.catch((e: unknown) => e)) as KiomonError;
		expect(error.code).toBe("timeout");
	});

	it("does not retry an auth failure", async () => {
		const { fetch, calls } = mockFetch(() => json({ error: "bad key" }, 401));
		await client(fetch)
			.searchMemory({ query: "x" })
			.catch(() => undefined);
		expect(calls).toHaveLength(1);
	});
});

describe("retries and idempotency", () => {
	it("retries a rate-limited read and succeeds", async () => {
		let attempt = 0;
		const { fetch, calls } = mockFetch(() =>
			++attempt === 1 ? json({ error: "slow down" }, 429) : json({ results: [] }),
		);
		await client(fetch).searchMemory({ query: "x" });
		expect(calls).toHaveLength(2);
	});

	it("omits Idempotency-Key on reads and sends a stable one on writes", async () => {
		const { fetch, calls } = mockFetch(() => json({ results: [] }));
		await client(fetch).searchMemory({ query: "x" });
		expect(headerOf(calls[0]!, "Idempotency-Key")).toBeUndefined();

		// retrieveMemory is a POST that only reads. Keying it would have the server
		// store one row per retrieval that no retry could ever reuse.
		const posting = mockFetch(() => json({ summary: "", facts: [], episodes: [] }));
		await client(posting.fetch, { workspaceId: "ws_1" }).retrieveMemory({
			intent: "plan",
			query: "q",
		});
		expect(posting.calls[0]!.init.method).toBe("POST");
		expect(headerOf(posting.calls[0]!, "Idempotency-Key")).toBeUndefined();

		let writes = 0;
		const retrying = mockFetch(() =>
			++writes === 1 ? json({ error: "later" }, 503) : json({ drafted: 0, promoted: [], pending: [], memories: [] }),
		);
		await client(retrying.fetch, { workspaceId: "ws_1" }).reflectSession({
			learnings: [{ kind: "semantic", title: "T", body: "B" }],
		});

		expect(retrying.calls).toHaveLength(2);
		const first = headerOf(retrying.calls[0]!, "Idempotency-Key");
		expect(first).toBeTruthy();
		// The same key on the retry is what makes the replay safe server-side.
		expect(headerOf(retrying.calls[1]!, "Idempotency-Key")).toBe(first);
	});

	it("treats request() as a write only when it is declared as one", async () => {
		const { fetch, calls } = mockFetch(() => json({ ok: true }));
		await client(fetch).request("/api/documents", { method: "POST", body: { a: 1 } });
		expect(headerOf(calls[0]!, "Idempotency-Key")).toBeUndefined();

		const declared = mockFetch(() => json({ ok: true }));
		await client(declared.fetch).request("/api/documents", {
			method: "POST",
			body: { a: 1 },
			write: true,
		});
		expect(headerOf(declared.calls[0]!, "Idempotency-Key")).toBeTruthy();
	});

	it("honours a caller-supplied idempotency key", async () => {
		const { fetch, calls } = mockFetch(() => json({ ok: true }));
		await client(fetch).recordOutcome(
			{ outcome: "success", items: [{ memory_id: "m1", assessment: "helped" }] },
			{ idempotencyKey: "caller-key-1" },
		);
		expect(headerOf(calls[0]!, "Idempotency-Key")).toBe("caller-key-1");
	});
});

describe("input validation happens locally", () => {
	it("rejects an empty search query without a request", () => {
		const { fetch, calls } = mockFetch(() => json({}));
		expect(() => client(fetch).searchMemory({ query: "  " })).toThrow(/non-empty/);
		expect(calls).toHaveLength(0);
	});

	it("rejects rate without a value of 1 or -1", async () => {
		const { fetch, calls } = mockFetch(() => json({}));
		expect(() => client(fetch).manageMemory({ id: "m1", action: "rate" })).toThrow(/1 or -1/);
		expect(calls).toHaveLength(0);
	});

	it("rejects an unknown manage action", () => {
		const { fetch } = mockFetch(() => json({}));
		expect(() =>
			client(fetch).manageMemory({ id: "m1", action: "explode" as never }),
		).toThrow(/must be one of/);
	});

	it("enforces the 25-learning ceiling", () => {
		const { fetch } = mockFetch(() => json({}));
		const learnings = Array.from({ length: 26 }, (_, i) => ({
			kind: "semantic" as const,
			title: `t${i}`,
			body: "b",
		}));
		expect(() => client(fetch, { workspaceId: "ws_1" }).reflectSession({ learnings })).toThrow(/25/);
	});

	it("enforces the retrieval limit ceiling", () => {
		const { fetch } = mockFetch(() => json({}));
		expect(() =>
			client(fetch, { workspaceId: "ws_1" }).retrieveMemory({ intent: "plan", query: "q", limit: 50 }),
		).toThrow(/between 1 and 20/);
	});

	it("rejects an invalid learning kind", () => {
		const { fetch } = mockFetch(() => json({}));
		expect(() =>
			client(fetch, { workspaceId: "ws_1" }).draftMemory({
				kind: "opinion" as never,
				title: "t",
				body: "b",
			}),
		).toThrow(/kind must be one of/);
	});
});
