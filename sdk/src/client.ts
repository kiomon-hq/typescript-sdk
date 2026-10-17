/**
 * Kiomon SDK — client
 *
 * The public vocabulary is the memory-native verbs, mirroring the hosted MCP
 * toolset tool for tool so a developer can move between the two without
 * relearning anything. Every verb maps onto an existing
 * REST endpoint; the SDK adds typing, retries, idempotency and error codes.
 *
 * Three further verbs — {@link Kiomon.createWorkspace},
 * {@link Kiomon.listDocuments} and {@link Kiomon.deleteDocument} — exist because
 * the fourteen above are not self-sufficient: without them a caller cannot make
 * the workspace `selectWorkspace` needs, or read the library with the
 * document-only filters. They have no tool of their own, though
 * `deleteDocument` is the same operation as `manage_memory`'s `forget`.
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
	CreateWorkspaceArgs,
	DeleteResult,
	DocumentList,
	GraphExploreArgs,
	GraphResult,
	IngestDocumentArgs,
	IngestResult,
	JsonObject,
	ListDocumentsArgs,
	ListMemoriesArgs,
	ManageAction,
	ManageMemoryArgs,
	MemoryDocument,
	MemoryKind,
	MemoryList,
	RecordOutcomeArgs,
	ReflectLearning,
	ReflectSessionArgs,
	RetrievalArgs,
	SearchArgs,
	SearchResponse,
	Workspace,
	WorkspaceContext,
} from "./types.js";
import { USER_AGENT } from "./version.js";

const DEFAULT_BASE_URL = "https://api.kiomon.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_LEARNINGS_PER_CALL = 25;
const MAX_RETRIEVAL_LIMIT = 20;
/** The API caps a document page at 200 rows. */
const MAX_DOCUMENT_LIMIT = 200;

const MEMORY_KINDS: readonly MemoryKind[] = ["reference", "episodic", "semantic", "procedural"];
/** The state vocabulary of a listing — shared by documents and memories. */
const LIST_STATUSES = ["all", "active", "archived", "pending_approval"] as const;
const DOCUMENT_SORTS = ["recent", "oldest", "recently_read"] as const;
const INDEX_STATUSES = ["all", "queued", "chunked", "indexed", "ready", "failed"] as const;
/** Page size for `listMemories` when the caller names none — matches MCP `list_memories`. */
const DEFAULT_MEMORY_PAGE_SIZE = 50;

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

	// ── The memory verbs ───────────────────────────────────────────────────────

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
			query: {
				center_id: args.id,
				depth: args.depth ?? 1,
				relation: args.relation,
				// The walk is workspace-scoped on the server, and the default is the
				// credential's own workspace rather than the selected one — without
				// this an agent that called selectWorkspace would traverse a
				// different brain than the one it just read, silently.
				workspace_id: this.workspaceFor(args.workspace_id),
			},
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

	// ── Workspaces and documents ───────────────────────────────────────────────

	/**
	 * Create a workspace, optionally inside an organization.
	 *
	 * Omit `org_id` to file it under the caller's primary organization; pass one
	 * to place it in a specific org, where the caller must be an admin or owner or
	 * the API answers 403. Returns the bare workspace row — the enriched fields
	 * (`documents`, `my_role`, `is_default`) come from `listWorkspaces`, not from
	 * this call.
	 *
	 * The plan's workspace ceiling applies: a Free organization over its limit
	 * gets 402 `quota_exceeded`, not a silent no-op.
	 */
	createWorkspace(args: CreateWorkspaceArgs, options?: CallOptions): Promise<Workspace> {
		if (!args?.name?.trim()) {
			throw new KiomonError("createWorkspace requires a non-empty `name`.", { code: "invalid_request" });
		}
		if (args.org_id !== undefined && !args.org_id?.trim()) {
			throw new KiomonError("createWorkspace: `org_id` must be a non-empty string.", {
				code: "invalid_request",
			});
		}
		return this.request<Workspace>(
			"/api/workspaces",
			{
				method: "POST",
				body: args.org_id === undefined ? { name: args.name } : { name: args.name, org_id: args.org_id },
				write: true,
			},
			options,
		);
	}

	/**
	 * Save a document — the write path for source material.
	 *
	 * Distinct from `draftMemory`: a learning goes through the write gate and may
	 * land in the Review Inbox, while a document is stored and indexed directly.
	 * Documents are what `searchMemory` returns.
	 *
	 * Indexing is asynchronous, so the row is not searchable when this resolves.
	 * Expect a lag — seconds, not instant — before the id shows up in a search.
	 *
	 * Dedup is by `source_url` **only**. Re-saving the same URL resolves with
	 * `duplicate: true` and the **existing** id rather than rejecting — but a
	 * save with no `source_url` is given a synthetic unique one, so it never
	 * dedups and repeats will pile up as separate documents. Pass `source_url` if
	 * you want the second save to be a no-op.
	 */
	ingestDocument(args: IngestDocumentArgs, options?: CallOptions): Promise<IngestResult> {
		if (!args?.body?.trim()) {
			throw new KiomonError("ingestDocument requires a non-empty `body`.", { code: "invalid_request" });
		}
		if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
			throw new KiomonError(`ingestDocument: \`kind\` must be one of: ${MEMORY_KINDS.join(", ")}.`, {
				code: "invalid_request",
			});
		}
		if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some((t) => typeof t !== "string"))) {
			throw new KiomonError("ingestDocument: `tags` must be an array of strings.", {
				code: "invalid_request",
			});
		}
		return this.request<IngestResult>(
			"/api/documents",
			{
				method: "POST",
				body: { ...args, workspace_id: this.workspaceFor(args.workspace_id) },
				write: true,
			},
			options,
		);
	}

	/**
	 * List documents, newest first by default.
	 *
	 * Metadata only — the body is not in the projection, so read it with
	 * `getMemory` when you need it. `counts` reports the per-kind totals for the
	 * current filter over the whole match set, not just the page.
	 *
	 * **Only indexed documents are listed by default.** `queued` and `failed`
	 * rows are hidden, so a document you just saved is absent until it finishes
	 * chunking — pass `index_status: "all"` to see the pipeline rather than just
	 * its output. That is also the way to find a save that failed: it is
	 * invisible to the default filter forever.
	 */
	listDocuments(args: ListDocumentsArgs = {}, options?: CallOptions): Promise<DocumentList> {
		if (args.limit !== undefined && (args.limit < 1 || args.limit > MAX_DOCUMENT_LIMIT)) {
			throw new KiomonError(`listDocuments: \`limit\` must be between 1 and ${MAX_DOCUMENT_LIMIT}.`, {
				code: "invalid_request",
			});
		}
		if (args.offset !== undefined && args.offset < 0) {
			throw new KiomonError("listDocuments: `offset` must be a non-negative integer.", {
				code: "invalid_request",
			});
		}
		if (args.status !== undefined && !LIST_STATUSES.includes(args.status)) {
			throw new KiomonError(`listDocuments: \`status\` must be one of: ${LIST_STATUSES.join(", ")}.`, {
				code: "invalid_request",
			});
		}
		if (args.sort !== undefined && !DOCUMENT_SORTS.includes(args.sort)) {
			throw new KiomonError(`listDocuments: \`sort\` must be one of: ${DOCUMENT_SORTS.join(", ")}.`, {
				code: "invalid_request",
			});
		}
		if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
			throw new KiomonError(`listDocuments: \`kind\` must be one of: ${MEMORY_KINDS.join(", ")}.`, {
				code: "invalid_request",
			});
		}
		if (args.index_status !== undefined && !INDEX_STATUSES.includes(args.index_status)) {
			throw new KiomonError(
				`listDocuments: \`index_status\` must be one of: ${INDEX_STATUSES.join(", ")}.`,
				{ code: "invalid_request" },
			);
		}
		return this.request<DocumentList>(
			"/api/documents",
			{
				query: {
					limit: args.limit,
					offset: args.offset,
					q: args.query,
					kind: args.kind,
					tag: args.tag,
					status: args.status,
					source: args.source,
					sort: args.sort,
					since: args.since,
					index_status: args.index_status,
					workspace_id: this.workspaceFor(args.workspace_id),
				},
			},
			options,
		);
	}

	/**
	 * List memories and files by state — the listing counterpart to
	 * `searchMemory`, for questions a query cannot express: what is waiting for
	 * review, what is live, what was archived, what was saved this week.
	 *
	 * `status` defaults to `"pending_approval"`, the **Review Inbox**: drafts the
	 * write gate held back for a decision. They are not retrievable — nothing is
	 * until it is approved — so a search that returns nothing is not proof the
	 * brain is empty. Use `"active"` for live knowledge, `"archived"` for what was
	 * hidden or quarantined, `"all"` for everything.
	 *
	 * Work the inbox with `manageMemory({ id, action: "approve" | "reject" })`.
	 */
	listMemories(args: ListMemoriesArgs = {}, options?: CallOptions): Promise<MemoryList> {
		if (args.limit !== undefined && (args.limit < 1 || args.limit > MAX_DOCUMENT_LIMIT)) {
			throw new KiomonError(`listMemories: \`limit\` must be between 1 and ${MAX_DOCUMENT_LIMIT}.`, {
				code: "invalid_request",
			});
		}
		if (args.offset !== undefined && args.offset < 0) {
			throw new KiomonError("listMemories: `offset` must be a non-negative integer.", {
				code: "invalid_request",
			});
		}
		if (args.status !== undefined && !LIST_STATUSES.includes(args.status)) {
			throw new KiomonError(`listMemories: \`status\` must be one of: ${LIST_STATUSES.join(", ")}.`, {
				code: "invalid_request",
			});
		}
		if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
			throw new KiomonError(`listMemories: \`kind\` must be one of: ${MEMORY_KINDS.join(", ")}.`, {
				code: "invalid_request",
			});
		}
		return this.request<MemoryList>(
			"/api/memories",
			{
				query: {
					status: args.status ?? "pending_approval",
					kind: args.kind,
					q: args.query,
					limit: args.limit ?? DEFAULT_MEMORY_PAGE_SIZE,
					offset: args.offset,
					workspace_id: this.workspaceFor(args.workspace_id),
				},
			},
			options,
		);
	}

	/**
	 * Delete a document and everything derived from it.
	 *
	 * The row, its blob, its chunks, tags, links and both chunk- and
	 * document-level vectors. Irreversible — prefer `archive` via `manageMemory`
	 * when the intent is to hide rather than remove.
	 */
	deleteDocument(id: string, options?: CallOptions): Promise<DeleteResult> {
		requireId(id, "deleteDocument");
		return this.request<DeleteResult>(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE", write: true }, options);
	}

	// ── Retrieval and the learning loop ────────────────────────────────────────

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
			throw new KiomonError("This account has no workspaces yet. Call createWorkspace() to make one.", {
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
			"User-Agent": USER_AGENT,
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
