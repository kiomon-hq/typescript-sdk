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

/** The intent a retrieval is serving. Sharper intents return sharper context packets. */
export type RetrievalIntent = "execute" | "plan" | "answer" | "verify" | "debug";

export type RiskLevel = "low" | "medium" | "high";

/** Any object shape the SDK does not yet model precisely. */
export type JsonObject = Record<string, unknown>;

export interface Workspace {
	id: string;
	user_id: string;
	name: string;
	slug: string;
	org_id?: string | null;
	created_at: string;
}

/**
 * A stored memory/document. Mirrors the worker's `Document` contract.
 * `tags` and `headings` arrive as JSON strings, not arrays.
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
}

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
}

export interface SearchResponse {
	results: SearchHit[];
	/** Present on some responses; kept optional rather than asserted. */
	total?: number;
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
	review_inbox_url?: string;
}

export interface GraphResult {
	nodes: JsonObject[];
	edges: JsonObject[];
	/** Collapsed `memory -> entity -> memory` links — the structure retrieval walks. */
	entityLinks?: JsonObject[];
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
