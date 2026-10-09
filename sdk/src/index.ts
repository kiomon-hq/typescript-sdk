/**
 * Kiomon SDK — persistent memory for AI agents and apps.
 *
 * @example
 * ```ts
 * import { Kiomon } from "@kiomon/kiomon";
 *
 * const kiomon = new Kiomon({ apiKey: process.env.KIOMON_API_KEY! });
 *
 * const packet = await kiomon.retrieveMemory({
 *   intent: "execute",
 *   query: "how do we deploy the worker?",
 * });
 *
 * await kiomon.recordOutcome({
 *   outcome: "success",
 *   items: packet.retrieved_ids.map((memory_id) => ({ memory_id, assessment: "helped" })),
 * });
 * ```
 *
 * @packageDocumentation
 */
export { Kiomon } from "./client.js";
export type { KiomonOptions } from "./client.js";
export { KiomonError, isKiomonError, codeForStatus } from "./errors.js";
export type { KiomonErrorCode, KiomonErrorOptions } from "./errors.js";
export type {
	BatchDraftResult,
	CallOptions,
	ConflictNote,
	ContextPacket,
	EvidenceRef,
	GraphExploreArgs,
	GraphResult,
	JsonObject,
	ManageAction,
	ManageMemoryArgs,
	MemoryDocument,
	MemoryKind,
	PacketItem,
	RecordOutcomeArgs,
	ReflectLearning,
	ReflectSessionArgs,
	RetrievalArgs,
	RetrievalIntent,
	RiskLevel,
	SearchArgs,
	SearchHit,
	SearchResponse,
	Workspace,
	WorkspaceContext,
} from "./types.js";
