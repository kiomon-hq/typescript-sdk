/**
 * Kiomon SDK — client
 *
 * The public vocabulary is the 12 memory-native verbs, mirroring the hosted MCP
 * toolset method-for-method so a developer can move between the two without
 * relearning anything. Every verb maps onto an existing
 * REST endpoint; the SDK adds typing, retries, idempotency and error codes.
 *
 * Failure contract: an invalid *argument* throws synchronously, so a programming
 * error never gets buried in a promise chain. Everything that can fail for
 * *remote* reasons — auth, quota, transport, a 5xx — rejects with a
 * {@link KiomonError}. See {@link Kiomon.request} for the one exception.
 */
import { KiomonError, errorFromResponse, isKiomonError } from "./errors.js";
import type {
	BatchDraftResult,
	CallOptions,
	ContextPacket,
	GraphExploreArgs,
	GraphResult,
	JsonObject,
	ManageAction,
	ManageMemoryArgs,
	MemoryDocument,
	MemoryKind,
	RecordOutcomeArgs,
	ReflectLearning,
	ReflectSessionArgs,
	RetrievalArgs,
	SearchArgs,
	SearchResponse,
	Workspace,
	WorkspaceContext,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.kiomon.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_LEARNINGS_PER_CALL = 25;
const MAX_RETRIEVAL_LIMIT = 20;

const LEARNINGS_KINDS: readonly ReflectLearning["kind"][] = ["semantic", "procedural", "episodic"];
const MANAGE_ACTIONS: readonly ManageAction[] = [
	"pin",
	"unpin",
	"archive",
	"restore",
	"forget",
	"rate",
	"approve",
	"reject",
	"revert",
];

export interface KiomonOptions {
	/** A Kiomon API key (`sk_kiomon_…`), sent as `X-API-Key`. Server-side integrations. */
	apiKey?: string;
	/**
	 * A delegated OAuth token (`koa_…`), sent as `Authorization: Bearer`. Pass a
	 * function to refresh tokens without rebuilding the client. Note that a
	 * connector token is confined to the memory routes by the worker's default-deny
	 * allowlist, so `request()` is not a general escape hatch in this mode.
	 */
	token?: string | (() => string | Promise<string>);
	/** Default workspace. Resolved automatically when the account has exactly one. */
	workspaceId?: string;
	/** Defaults to `https://api.kiomon.com`. */
	baseUrl?: string;
	timeoutMs?: number;
	/** Retries for retryable failures. Defaults to 2. */
	maxRetries?: number;
	/** Injectable for tests and non-standard runtimes. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Extra headers on every request. */
	headers?: Record<string, string>;
	/** Attributed in Kiomon's telemetry as `X-Agent-Id`. */
	agentId?: string;
}

interface RequestSpec {
	method?: string;
	query?: Record<string, unknown>;
	body?: unknown;
	/** Writes get an idempotency key and are retried only with one attached. */
	write?: boolean;
}

export class Kiomon {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly fetchImpl: typeof fetch;
	private readonly extraHeaders: Record<string, string>;
	private readonly agentId: string;
	private readonly apiKey?: string;
	private readonly token?: string | (() => string | Promise<string>);
	private workspace?: string;
	/** Cached result of the implicit `listWorkspaces()` used for workspace defaulting. */
	private resolvedWorkspace?: string;

	constructor(options: KiomonOptions = {}) {
		if (!options.apiKey && !options.token) {
			throw new KiomonError(
				"Kiomon was constructed without credentials. Pass `apiKey` (server-side) or `token` (delegated OAuth).",
				{ code: "invalid_request" },
			);
		}
		if (options.apiKey && options.token) {
			throw new KiomonError(
				"Pass either `apiKey` or `token`, not both — the wire format differs and only one can be sent.",
				{ code: "invalid_request" },
			);
		}

		this.apiKey = options.apiKey;
		this.token = options.token;
		this.workspace = options.workspaceId;
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.extraHeaders = options.headers ?? {};
		this.agentId = options.agentId ?? "sdk";

		if (!this.fetchImpl) {
			throw new KiomonError(
				"No global `fetch` available. Node 18+, a browser, or a Worker runtime is required — or pass `fetch` explicitly.",
				{ code: "invalid_request" },
			);
		}
	}

	/** The workspace calls default to, if one has been selected or resolved. */
	get workspaceId(): string | undefined {
		return this.workspace ?? this.resolvedWorkspace;
	}

	/**
	 * Bind this client to a workspace, mirroring the MCP `select_workspace` tool.
	 * Returns the client so it can be chained.
	 */
	selectWorkspace(workspaceId: string): this {
		if (!workspaceId || typeof workspaceId !== "string") {
			throw new KiomonError("selectWorkspace requires a non-empty workspace id.", { code: "invalid_request" });
		}
		this.workspace = workspaceId;
		return this;
	}

	// ── The 12 memory verbs ────────────────────────────────────────────────────

	/** Hybrid keyword + semantic search over the library. */
	searchMemory(args: SearchArgs, options?: CallOptions): Promise<SearchResponse> {
		if (!args?.query?.trim()) {
			throw new KiomonError("searchMemory requires a non-empty `query`.", { code: "invalid_request" });
		}
		return this.request<SearchResponse>("/api/search", {
			query: {
				q: args.query,
				limit: args.limit ?? 10,
				workspace_id: this.workspaceFor(args.workspace_id),
				kind: args.kind,
			},
		}, options);
	}

	/** Fetch one memory by id. */
	getMemory(id: string, options?: CallOptions): Promise<MemoryDocument> {
		requireId(id, "getMemory");
		return this.request<MemoryDocument>(`/api/documents/${encodeURIComponent(id)}`, {}, options);
	}

	/** Orientation context for a workspace — the "where was I" pack. */
	getWorkspaceContext(
		args: { workspace_id?: string; topic?: string } = {},
		options?: CallOptions,
	): Promise<WorkspaceContext> {
		return this.contextFor(args, options);
	}

	private async contextFor(
		args: { workspace_id?: string; topic?: string },
		options?: CallOptions,
	): Promise<WorkspaceContext> {
		const workspaceId = await this.resolveWorkspace(args.workspace_id);
		return this.request<WorkspaceContext>(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/context`,
			{ query: { topic: args.topic } },
			options,
		);
	}

	/** Multi-hop traversal of the memory graph from a centre node. */
	exploreMemoryGraph(args: GraphExploreArgs, options?: CallOptions): Promise<GraphResult> {
		requireId(args?.id, "exploreMemoryGraph");
		return this.request<GraphResult>("/api/graph", {
			query: { center_id: args.id, depth: args.depth ?? 1, relation: args.relation },
		}, options);
	}

	/**
	 * Save durable learnings from a session through the autonomous write gate.
	 * High-confidence learnings may activate immediately; the rest land in the
	 * Review Inbox. Maximum 25 learnings per call.
	 */
	reflectSession(args: ReflectSessionArgs, options?: CallOptions): Promise<BatchDraftResult> {
		const learnings = validateLearnings(args?.learnings);
		return this.draftLearnings(args?.workspace_id, learnings, options);
	}

	/** Save a single learning. Sugar over `reflectSession`, using the same write gate. */
	draftMemory(
		learning: ReflectLearning,
		args: { workspace_id?: string } = {},
		options?: CallOptions,
	): Promise<BatchDraftResult> {
		const learnings = validateLearnings([learning]);
		return this.draftLearnings(args.workspace_id, learnings, options);
	}

	private async draftLearnings(
		workspaceId: string | undefined,
		learnings: ReflectLearning[],
		options?: CallOptions,
	): Promise<BatchDraftResult> {
		const resolved = await this.resolveWorkspace(workspaceId);
		return this.request<BatchDraftResult>(
			"/api/memories/batch-draft",
			{ method: "POST", body: { workspace_id: resolved, learnings }, write: true },
			options,
		);
	}

	/**
	 * Lifecycle, feedback and review. One method rather than nine, mirroring the
	 * MCP `manage_memory` tool.
	 */
	manageMemory(args: ManageMemoryArgs, options?: CallOptions): Promise<JsonObject> {
		requireId(args?.id, "manageMemory");
		const { id, action, value } = args;
		if (!MANAGE_ACTIONS.includes(action)) {
			throw new KiomonError(
				`manageMemory: \`action\` must be one of ${MANAGE_ACTIONS.join(", ")}.`,
				{ code: "invalid_request" },
			);
		}
		if (action === "rate" && value !== 1 && value !== -1) {
			throw new KiomonError('manageMemory: action "rate" requires `value` of 1 or -1.', {
				code: "invalid_request",
			});
		}

		const encoded = encodeURIComponent(id);
		const spec: RequestSpec = { write: true };
		switch (action) {
			case "pin":
			case "unpin":
				spec.method = "PATCH";
				spec.body = { pinned: action === "pin" ? 1 : 0 };
				return this.request<JsonObject>(`/api/documents/${encoded}`, spec, options);
			case "rate":
				spec.method = "POST";
				spec.body = { rating: value };
				return this.request<JsonObject>(`/api/documents/${encoded}/rate`, spec, options);
			case "revert":
				spec.method = "POST";
				return this.request<JsonObject>(`/api/memories/${encoded}/revert`, spec, options);
			default:
				spec.method = "POST";
				return this.request<JsonObject>(`/api/documents/${encoded}/${action}`, spec, options);
		}
	}

	/** Every workspace this credential can reach. */
	listWorkspaces(options?: CallOptions): Promise<{ workspaces: Workspace[] }> {
		return this.request<{ workspaces: Workspace[] }>("/api/workspaces", {}, options);
	}

	/** The most recent proactive briefing for a workspace. */
	getLatestBriefing(
		args: { workspace_id?: string } = {},
		options?: CallOptions,
	): Promise<JsonObject> {
		return this.briefingFor(args.workspace_id, options);
	}

	private async briefingFor(
		workspaceId: string | undefined,
		options?: CallOptions,
	): Promise<JsonObject> {
		const resolved = await this.resolveWorkspace(workspaceId);
		return this.request<JsonObject>(
			`/api/workspaces/${encodeURIComponent(resolved)}/briefings/latest`,
			{},
			options,
		);
	}

	/**
	 * Intent-aware retrieval. Prefer this over `searchMemory` when feeding a model:
	 * the packet carries provenance, confidence and explicit conflict warnings.
	 */
	retrieveMemory(args: RetrievalArgs, options?: CallOptions): Promise<ContextPacket> {
		if (!args?.query?.trim()) {
			throw new KiomonError("retrieveMemory requires a non-empty `query`.", { code: "invalid_request" });
		}
		if (args.limit !== undefined && (args.limit < 1 || args.limit > MAX_RETRIEVAL_LIMIT)) {
			throw new KiomonError(`retrieveMemory: \`limit\` must be between 1 and ${MAX_RETRIEVAL_LIMIT}.`, {
				code: "invalid_request",
			});
		}
		return this.request(
			"/api/retrieve",
			{
				method: "POST",
				body: { ...args, workspace_id: this.workspaceFor(args.workspace_id) },
			},
			options,
		);
	}

	/**
	 * Report whether retrieved memories actually helped. This is what lets the
	 * brain re-rank and decay honestly, so call it after acting on a packet.
	 */
	recordOutcome(args: RecordOutcomeArgs, options?: CallOptions): Promise<JsonObject> {
		if (!Array.isArray(args?.items) || args.items.length === 0) {
			throw new KiomonError("recordOutcome requires a non-empty `items` array.", {
				code: "invalid_request",
			});
		}
		return this.request<JsonObject>(
			"/api/memories/record-outcome",
			{
				method: "POST",
				body: {
					outcome: args.outcome,
					items: args.items,
					workspace_id: this.workspaceFor(args.workspace_id),
				},
				write: true,
			},
			options,
		);
	}

	// ── Escape hatch ───────────────────────────────────────────────────────────

	/**
	 * Call any Kiomon REST route. Exists so the SDK never becomes a blocker for a
	 * new endpoint. Unavailable in delegated-token mode for routes outside the
	 * memory surface — the worker's allowlist rejects them.
	 */
	request<T = unknown>(path: string, spec: RequestSpec = {}, options?: CallOptions): Promise<T> {
		return this.send<T>(path, spec, options);
	}

	// ── Internals ──────────────────────────────────────────────────────────────

	/** Synchronous workspace for query params, tolerant of an unresolved default. */
	private workspaceFor(explicit?: string): string | undefined {
		return explicit ?? this.workspace ?? this.resolvedWorkspace;
	}

	/**
	 * Workspace for the routes that need one in the path. If none is configured,
	 * ask the API: exactly one workspace resolves silently (matching the MCP
	 * behaviour), more than one is an error the caller must fix, because guessing
	 * which brain to write to would be worse than failing.
	 */
	private async resolveWorkspace(explicit?: string): Promise<string> {
		const known = explicit ?? this.workspace ?? this.resolvedWorkspace;
		if (known) return known;

		const { workspaces } = await this.listWorkspaces();
		if (workspaces.length === 0) {
			throw new KiomonError("This account has no workspaces yet. Create one in the Kiomon dashboard.", {
				code: "not_found",
			});
		}
		if (workspaces.length > 1) {
			const names = workspaces.map((w) => `${w.slug} (${w.id})`).join(", ");
			throw new KiomonError(
				`This account has ${workspaces.length} workspaces, so there is no safe default. Pass \`workspaceId\` to the constructor, or call selectWorkspace(). Available: ${names}`,
				{ code: "invalid_request" },
			);
		}
		const only = workspaces[0]!;
		this.resolvedWorkspace = only.id;
		return only.id;
	}

	private async authHeader(): Promise<Record<string, string>> {
		if (this.apiKey) return { "X-API-Key": this.apiKey };
		const token = typeof this.token === "function" ? await this.token() : this.token;
		if (!token) {
			throw new KiomonError("The token provider returned nothing.", { code: "unauthorized" });
		}
		return { Authorization: `Bearer ${token}` };
	}

	private async send<T>(path: string, spec: RequestSpec, options?: CallOptions): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(spec.query ?? {})) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}

		const method = spec.method ?? "GET";
		// Only a *declared* write gets an idempotency key. Inferring it from a non-GET
		// method looked safer but was wrong: `retrieveMemory` is a POST that reads, so
		// every retrieval minted a fresh key the server would store a row for and no
		// retry would ever reuse. Every writing verb passes `write: true`, and
		// `request()` documents that callers must do the same.
		const isWrite = spec.write === true;
		// A write is only safely retryable with a stable key, so one is always
		// attached — generated if the caller did not supply one.
		const idempotencyKey = isWrite ? (options?.idempotencyKey ?? generateKey()) : undefined;
		const maxRetries = options?.maxRetries ?? this.maxRetries;

		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-Agent-Id": this.agentId,
			...this.extraHeaders,
			...(await this.authHeader()),
		};
		if (spec.body !== undefined) headers["Content-Type"] = "application/json";
		if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
		if (options?.requestId) headers["X-Request-Id"] = options.requestId;

		let lastError: unknown;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await this.attempt<T>(url, method, spec.body, headers, options);
			} catch (error) {
				lastError = error;
				const retryable = isKiomonError(error) && error.retryable;
				// A retry is only safe for a write that can be replayed; every declared write
				// carries a key, so this guards a future path that forgets to.
				const safe = !isWrite || Boolean(idempotencyKey);
				if (!retryable || !safe || attempt === maxRetries) throw error;
				await sleep(backoffMs(attempt, error));
			}
		}
		throw lastError;
	}

	private async attempt<T>(
		url: URL,
		method: string,
		body: unknown,
		headers: Record<string, string>,
		options?: CallOptions,
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onExternalAbort = () => controller.abort();
		options?.signal?.addEventListener("abort", onExternalAbort);

		try {
			const response = await this.fetchImpl(url.toString(), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) throw await errorFromResponse(response);
			if (response.status === 204) return undefined as T;

			const text = await response.text();
			if (!text) return undefined as T;
			return JSON.parse(text) as T;
		} catch (error) {
			if (isKiomonError(error)) throw error;
			const aborted = (error as { name?: string } | undefined)?.name === "AbortError";
			if (aborted && !options?.signal?.aborted) {
				throw new KiomonError(`Kiomon timed out after ${this.timeoutMs}ms.`, {
					code: "timeout",
					status: 504,
					cause: error,
				});
			}
			if (aborted) {
				// The caller cancelled; surface it as such rather than as a timeout.
				throw new KiomonError("Request aborted by the caller.", { code: "network_error", cause: error });
			}
			throw new KiomonError(`Could not reach ${url.origin}: ${(error as Error)?.message ?? "unknown error"}`, {
				code: "network_error",
				cause: error,
			});
		} finally {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onExternalAbort);
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireId(id: unknown, method: string): void {
	if (typeof id !== "string" || !id.trim()) {
		throw new KiomonError(`${method} requires a non-empty memory id.`, { code: "invalid_request" });
	}
}

/** Mirrors the worker-side validation the MCP tools perform, so failures are local and cheap. */
function validateLearnings(input: unknown): ReflectLearning[] {
	if (!Array.isArray(input) || input.length === 0) {
		throw new KiomonError("`learnings` must be a non-empty array.", { code: "invalid_request" });
	}
	if (input.length > MAX_LEARNINGS_PER_CALL) {
		throw new KiomonError(`\`learnings\` cannot exceed ${MAX_LEARNINGS_PER_CALL} items per call.`, {
			code: "invalid_request",
		});
	}
	return input.map((learning, index) => {
		const item = learning as Partial<ReflectLearning> | null;
		if (!item || typeof item !== "object") {
			throw new KiomonError(`learnings[${index}] must be an object.`, { code: "invalid_request" });
		}
		if (!LEARNINGS_KINDS.includes(item.kind as ReflectLearning["kind"])) {
			throw new KiomonError(
				`learnings[${index}].kind must be one of: ${LEARNINGS_KINDS.join(", ")}.`,
				{ code: "invalid_request" },
			);
		}
		if (typeof item.title !== "string" || !item.title.trim()) {
			throw new KiomonError(`learnings[${index}].title is required.`, { code: "invalid_request" });
		}
		if (typeof item.body !== "string" || !item.body.trim()) {
			throw new KiomonError(`learnings[${index}].body is required.`, { code: "invalid_request" });
		}
		if (item.confidence !== undefined && (item.confidence < 0 || item.confidence > 1)) {
			throw new KiomonError(`learnings[${index}].confidence must be between 0 and 1.`, {
				code: "invalid_request",
			});
		}
		return item as ReflectLearning;
	});
}

function generateKey(): string {
	const cryptoRef = globalThis.crypto;
	if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
	// Older runtimes: a random-enough fallback. The key only needs to be unique per
	// logical write, not cryptographically strong.
	return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Exponential backoff with jitter, honouring `Retry-After` when the server sent one. */
function backoffMs(attempt: number, error: unknown): number {
	if (isKiomonError(error) && error.body && typeof error.body === "object") {
		const retryAfter = (error.body as Record<string, unknown>).retry_after;
		if (typeof retryAfter === "number" && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
	}
	const base = Math.min(250 * 2 ** attempt, 4_000);
	return base + Math.floor(Math.random() * 100);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
