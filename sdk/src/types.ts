/**
 * Kiomon SDK — public types
 *
 * Field names mirror the wire format exactly (`workspace_id`, `memory_id`,
 * `source_refs`). Renaming them in the SDK would break the ability to diff an SDK
 * call against the equivalent MCP tool call, which is the whole point of keeping
 * the two surfaces identical.
 *
 * These are the SDK's canonical public contract. The worker's internal types are
 * deliberately not reused here yet — sharing them is a follow-up, not a
 * prerequisite for shipping this package.
 */

/** Memory kind. "semantic" = a fact, "procedural" = a routine, "episodic" = a moment, "reference" = saved source material. */
export type MemoryKind = "reference" | "episodic" | "semantic" | "procedural";

/** Document lifecycle state, for `listDocuments`. */
export type DocumentStatus = "all" | "active" | "archived" | "pending_approval";

/**
 * Indexing state, for `listDocuments`.
 *
 * `chunked`, `indexed` and `ready` are **findable** — search can see them.
 * `queued` and `failed` are not, and `listDocuments` hides them unless
 * `index_status: "all"` is asked for explicitly. That default is why a document
 * you just ingested is missing from the list until it finishes chunking.
 */
export type IndexStatus = "all" | "queued" | "chunked" | "indexed" | "ready" | "failed";

/** Page ordering, for `listDocuments`. */
export type DocumentSort = "recent" | "oldest" | "recently_read";

/** The intent a retrieval is serving. Sharper intents return sharper context packets. */
export type RetrievalIntent = "execute" | "plan" | "answer" | "verify" | "debug";

export type RiskLevel = "low" | "medium" | "high";

/** Any object shape the SDK does not yet model precisely. */
export type JsonObject = Record<string, unknown>;

/**
 * A workspace.
 *
 * The list route enriches the row; the create route does not. `documents`,
 * `my_role` and `is_default` are the fields a caller needs to choose a
 * workspace, and they are present only on `listWorkspaces` responses —
 * `createWorkspace` returns the bare row.
 */
export interface Workspace {
	id: string;
	user_id: string;
	name: string;
	slug: string;
	org_id?: string | null;
	created_at: string;
	/** `autonomous` or `review` — whether drafts activate or wait in the inbox. */
	review_mode?: string;
	my_role?: string;
	org_name?: string | null;
	org_role?: string | null;
	members?: number;
	documents?: number;
	storage_bytes?: number;
	/** Human-readable size (`"1.68 KB"`), the display twin of `storage_bytes`. */
	storage?: string;
	is_default?: boolean;
}

/**
 * A stored memory/document. Mirrors the worker's `Document` contract.
 *
 * `tags`, `headings` and `memory_metadata` arrive as JSON **strings**, not arrays
 * or objects — `JSON.parse` them to use them.
 *
 * The row is the server's, not the SDK's, so the lifecycle fields below are
 * optional: a given document carries whichever of them its processing has
 * reached. `index_status` / `ingest_status` / `enrich_status` are the processing
 * states, and `index_ready_at` is the one that answers "is this findable yet?".
 */
export interface MemoryDocument {
	id: string;
	source_url: string;
	title: string | null;
	author: string | null;
	excerpt: string | null;
	tags: string | null;
	user_notes: string | null;
	body: string | null;
	pinned: number;
	created_at: string;
	workspace_id: string;
	source: string;
	kind: MemoryKind;
	confidence: number | null;
	corroboration_count: number;
	importance: number;
	strength: number;
	retrieval_count: number;
	last_retrieved_at: string | null;
	feedback_score: number;
	feedback_count: number;
	scope: string;
	status: string;
	expires_at: string | null;
	/** JSON array string, like `tags`. */
	headings?: string | null;
	/** JSON object string. */
	memory_metadata?: string | null;
	user_id?: string;
	updated_at?: string | null;
	lang?: string | null;
	type?: string | null;
	thumbnail_url?: string | null;
	is_large?: number;
	/** Set when the body lives in blob storage rather than the row. */
	r2_key?: string | null;
	byte_size?: number;
	occurred_at?: string | null;
	pending_suggestion_count?: number;
	caller_role?: string;
	/** Indexing: `queued` · `chunked` · `ready` · `failed`. */
	index_status?: string;
	index_error?: string | null;
	index_attempts?: number;
	index_changed_at?: string | null;
	index_ready_at?: string | null;
	/** Ingest (the phase before indexing), same vocabulary. */
	ingest_status?: string;
	ingest_error?: string | null;
	ingest_attempts?: number;
	ingest_changed_at?: string | null;
	ingest_pages?: number | null;
	ingest_parser_name?: string | null;
	ingest_parser_version?: string | null;
	/** Enrichment: extraction of entities, claims and domains. */
	enrich_status?: string;
	enrich_error?: string | null;
	failed_at?: string | null;
	failure_class?: string | null;
	infra_retries?: number;
	first_stranded_at?: string | null;
	last_progress_at?: string | null;
	last_read_at?: string | null;
	/** Recovery-lease bookkeeping, written by the sweep jobs. */
	lease_stage?: string | null;
	lease_until?: string | null;
	chunk_strategy_version?: number;
	embed_model?: string | null;
	attention_reason?: string | null;
	next_attention_at?: string | null;
	/** Auto-linking state and degree. */
	link_status?: string | null;
	link_count?: number;
	last_link_scan_at?: string | null;
	connector_id?: string | null;
	connector_metadata?: string | null;
}

/**
 * One search result.
 *
 * `rank` is the fused reciprocal-rank score: the field to sort, threshold or
 * display when relevance matters. It is **not** comparable across queries — RRF
 * sums `1/(k + rank)` per leg, so it is only meaningful within one response.
 */
export interface SearchHit {
	id: string;
	title: string | null;
	source_url: string;
	excerpt: string | null;
	/** Query-matched fragment from the document body. */
	snippet: string;
	tags: string | null;
	created_at: string;
	source?: string | null;
	type?: string | null;
	kind?: string;
	/** Writer-declared confidence; absent/null for ingested content with no score. */
	confidence?: number | null;
	/** Fused RRF score. Compare within a response, never across responses. */
	rank?: number;
	/** 1 when the body lives in blob storage and `body` is truncated or absent. */
	is_large?: number;
	workspace_id?: string;
	/** The stored body. Present for small documents; absent when `is_large`. */
	body?: string | null;
}

export interface SearchResponse {
	results: SearchHit[];
	/** The query the server actually ran, echoed back. */
	query?: string;
}

/** One retrieved memory inside a context packet, with its provenance and applicability. */
export interface PacketItem {
	memory_id: string;
	kind: string;
	claim: string;
	confidence: number;
	authority: string;
	applicability: "applicable" | "conditional" | "unknown";
	condition?: string;
	source_ref?: string;
}

export interface EvidenceRef {
	memory_id: string;
	source_uri?: string;
	source_span?: string;
}

export interface ConflictNote {
	memory_id_a: string;
	memory_id_b: string;
	note: string;
}

/** Intent-aware context bundle returned by `retrieveMemory`. */
export interface ContextPacket {
	summary: string;
	facts: PacketItem[];
	procedure?: PacketItem;
	episodes: PacketItem[];
	evidence: EvidenceRef[];
	/** Warnings are instructions the caller should honour, not decoration. */
	warnings: string[];
	conflicts: ConflictNote[];
	retrieved_ids: string[];
}

/** A single learning to save through the write gate. */
export interface ReflectLearning {
	kind: "semantic" | "procedural" | "episodic";
	title: string;
	body: string;
	/** Short subheading shown on the memory card. */
	excerpt?: string;
	/** 0–1. At or above 0.75 a write may activate immediately, unless the workspace is in review mode. */
	confidence?: number;
	tags?: string[];
	/** Ids of memories this learning was derived from. */
	source_refs?: string[];
	/** Supplying entities, claims and domain skips a paid extraction pass. */
	entities?: string[];
	claims?: string[];
	domain?: string;
}

export interface ReflectSessionArgs {
	workspace_id?: string;
	/** Maximum 25 per call. */
	learnings: ReflectLearning[];
}

export type ManageAction =
	| "pin"
	| "unpin"
	| "archive"
	| "restore"
	| "forget"
	| "rate"
	| "approve"
	| "reject"
	| "revert";

export interface ManageMemoryArgs {
	id: string;
	action: ManageAction;
	/** Required for `action: "rate"` — 1 (useful) or -1 (not useful). */
	value?: number;
}

export interface BatchDraftResult {
	drafted: number;
	/** Ids of memories the write gate activated immediately. */
	promoted: string[];
	/** Ids still awaiting review in the dashboard Review Inbox. */
	pending: string[];
	memories: { id: string; title: string; kind: string }[];
	/** Titles of learnings the write gate dropped rather than drafted. */
	discarded?: string[];
	/** How many learnings were folded into an existing memory instead of inserted. */
	merged?: number;
	/** Dashboard path to the Review Inbox. Sent only when `pending` is non-empty. */
	review_inbox_url?: string;
}

/**
 * A page of the memory graph.
 *
 * `hasMore` is the pagination signal: without it a truncated walk is
 * indistinguishable from a complete one.
 */
export interface GraphResult {
	nodes: JsonObject[];
	edges: JsonObject[];
	/** Collapsed `memory -> entity -> memory` links — the structure retrieval walks. */
	entityLinks?: JsonObject[];
	/** Nodes reachable from the centre before `depth` was applied. */
	totalNodes?: number;
	hasMore?: boolean;
	depth?: number;
}

export interface GraphExploreArgs {
	/** Centre node id. */
	id: string;
	relation?: string;
	depth?: number;
}

export interface RecordOutcomeArgs {
	outcome: "success" | "failure";
	items: { memory_id: string; assessment: string }[];
	workspace_id?: string;
}

export interface WorkspaceContext {
	[key: string]: unknown;
}

export interface RetrievalArgs {
	intent: RetrievalIntent;
	query: string;
	entities?: string[];
	constraints?: string[];
	kinds?: MemoryKind[];
	workspace_id?: string;
	risk_level?: RiskLevel;
	/** Maximum 20. */
	limit?: number;
}

export interface SearchArgs {
	query: string;
	kind?: MemoryKind;
	workspace_id?: string;
	limit?: number;
}

/** Per-call overrides, mainly for retry and idempotency control. */
export interface CallOptions {
	/** Supply your own key to make a write retryable across processes. Generated when omitted. */
	idempotencyKey?: string;
	/** Override `maxRetries` for this call. */
	maxRetries?: number;
	/** Forwarded as `X-Request-Id`, making a support request traceable. */
	requestId?: string;
	signal?: AbortSignal;
}

/** Arguments for `createWorkspace`. */
export interface CreateWorkspaceArgs {
	name: string;
	/** Omit to file the workspace under the caller's primary organization. */
	org_id?: string;
}

/** Arguments for `ingestDocument`. `body` is required; everything else is optional. */
export interface IngestDocumentArgs {
	body: string;
	title?: string;
	source_url?: string;
	author?: string;
	excerpt?: string;
	lang?: string;
	user_notes?: string;
	tags?: string[];
	kind?: MemoryKind;
	type?: string;
	thumbnail_url?: string;
	workspace_id?: string;
}

/** Arguments for `listDocuments`. */
export interface ListDocumentsArgs {
	query?: string;
	kind?: MemoryKind;
	tag?: string;
	status?: DocumentStatus;
	source?: string;
	sort?: DocumentSort;
	since?: string;
	/** Defaults to the findable states only. Use `"all"` to include `queued` and `failed`. */
	index_status?: IndexStatus;
	limit?: number;
	offset?: number;
	workspace_id?: string;
}

/** Per-kind totals for the current filter, computed over the whole match set. */
export interface DocumentCounts {
	total: number;
	reference: number;
	episodic: number;
	semantic: number;
	procedural: number;
	pinned: number;
}

/**
 * One row of the metadata-only list projection.
 *
 * `body` is deliberately absent — every list surface is metadata-only, and the
 * body lives behind `getMemory`.
 */
export interface DocumentListItem {
	id: string;
	source_url: string;
	title: string | null;
	created_at: string;
	workspace_id: string;
	kind: MemoryKind;
	status: string;
	source: string;
	pinned: number;
	user_id?: string;
	author?: string | null;
	excerpt?: string | null;
	tags?: string | null;
	lang?: string | null;
	user_notes?: string | null;
	is_large?: number;
	updated_at?: string | null;
	pending_suggestion_count?: number;
	type?: string | null;
	thumbnail_url?: string | null;
	connector_metadata?: string | null;
	last_read_at?: string | null;
	confidence?: number | null;
	strength?: number;
	memory_metadata?: string | null;
	index_status?: string;
	index_error?: string | null;
	index_attempts?: number;
	index_changed_at?: string | null;
	ingest_status?: string;
	ingest_error?: string | null;
	ingest_pages?: number | null;
	ingest_changed_at?: string | null;
	enrich_status?: string;
	failed_at?: string | null;
	connector_id?: string | null;
}

/** One page of documents, with the counts for the current filter. */
export interface DocumentList {
	documents: DocumentListItem[];
	limit: number;
	offset: number;
	total: number;
	counts: DocumentCounts;
}

/**
 * The outcome of `ingestDocument`.
 *
 * A save the API already had answers `200` with `duplicate: true` and the
 * **existing** `id` instead of `201` — dedup is by source URL and body hash, so
 * re-ingesting the same page is a no-op rather than an error. Check `duplicate`
 * before treating the id as new.
 */
export interface IngestResult {
	id: string;
	/** Tags the server resolved, including any it added itself. Absent on a dedup hit. */
	tags?: string[];
	/** Present only on a dedup hit, where it is always `true`. */
	duplicate?: boolean;
	/** Present only on a dedup hit: when the original was saved. */
	created_at?: string;
}

/** The outcome of `deleteDocument`. */
export interface DeleteResult {
	deleted: boolean;
}
