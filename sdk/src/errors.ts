/**
 * Kiomon SDK — errors
 *
 * One error type crosses the SDK boundary. The API's own error envelope is a
 * flat `{ error: string }`, optionally with `needsUpgrade`, so the SDK derives
 * a stable `code` from the HTTP status and prefers a server-supplied `code`
 * when the service sends one.
 */

/**
 * Stable, switchable error codes.
 *
 * These mirror the service's API error taxonomy exactly, so a response with a server-supplied
 * `code` and one that had to be inferred from the status map resolve to the same value. Three
 * codes are raised by this SDK rather than the wire — `invalid_request` for
 * bad arguments (thrown synchronously, before any request), `timeout` and `network_error` for
 * transport failures — and `unknown` exists so a future server code never crashes a caller.
 */
export type KiomonErrorCode =
	| "bad_request"
	/** Schema validation failed — the shape was wrong, not just the values. */
	| "validation_failed"
	| "payload_too_large"
	| "unauthorized"
	/** Account is mid-deletion: not a key problem, and not fixable by re-issuing one. */
	| "account_pending_deletion"
	| "forbidden"
	/** The caller's workspace role is too low. Describes the caller, not the resource. */
	| "insufficient_role"
	/** An OAuth connected app reached outside its allowlist. */
	| "connector_scope_denied"
	/** Deliberately undifferentiated: the API fails closed with 404 so it never confirms existence. */
	| "not_found"
	| "conflict"
	| "duplicate"
	/** Same Idempotency-Key, different request body. */
	| "idempotency_conflict"
	/** Same Idempotency-Key, first request still running. */
	| "idempotency_in_progress"
	| "quota_exceeded"
	| "pro_required"
	| "rate_limited"
	| "service_unavailable"
	| "internal_error"
	// ── Raised by the SDK itself, never by the wire ────────────────────────────
	| "invalid_request"
	| "timeout"
	| "network_error"
	// ── Fallback for a code this version does not know ────────────────────────
	| "unknown";

export interface KiomonErrorOptions {
	status?: number;
	code?: KiomonErrorCode;
	/** Raw response body, when there was one. Useful for debugging, not for control flow. */
	body?: unknown;
	/** `true` on a Free-plan quota rejection (HTTP 402) — the caller should upgrade, not retry. */
	needsUpgrade?: boolean;
	requestId?: string;
	cause?: unknown;
}

/**
 * Fallback mapping for a response that carried no `code`.
 *
 * Kept identical to the worker's `DEFAULT_CODE_BY_STATUS` on purpose: the same 400 must resolve to
 * `bad_request` whether the worker labelled it or the SDK had to infer it. A second, subtly
 * different mapping here would mean a caller's `switch` behaved differently depending on which
 * deploy it was talking to. `timeout` is absent deliberately — the SDK raises it for its own
 * aborted requests, while a 504 from the edge is `service_unavailable`.
 */
const CODE_BY_STATUS: Record<number, KiomonErrorCode> = {
	400: "bad_request",
	401: "unauthorized",
	402: "quota_exceeded",
	403: "forbidden",
	404: "not_found",
	409: "conflict",
	413: "payload_too_large",
	429: "rate_limited",
	500: "internal_error",
	502: "service_unavailable",
	503: "service_unavailable",
	504: "service_unavailable",
};

/** Map an HTTP status to a code. Exported so tests and callers can reason about the mapping. */
export function codeForStatus(status: number): KiomonErrorCode {
	const known = CODE_BY_STATUS[status];
	if (known) return known;
	if (status >= 500) return "service_unavailable";
	if (status >= 400) return "bad_request";
	return "unknown";
}

export class KiomonError extends Error {
	override readonly name = "KiomonError";
	/** HTTP status, or 0 when the request never reached the server. */
	readonly status: number;
	readonly code: KiomonErrorCode;
	readonly body?: unknown;
	readonly needsUpgrade: boolean;
	readonly requestId?: string;

	constructor(message: string, options: KiomonErrorOptions = {}) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.status = options.status ?? 0;
		this.code = options.code ?? codeForStatus(this.status);
		this.body = options.body;
		this.needsUpgrade = options.needsUpgrade ?? false;
		this.requestId = options.requestId;
	}

	/**
	 * Whether retrying the *same* request could plausibly succeed. A retry is only
	 * safe for writes when an idempotency key is attached — the SDK does that
	 * automatically, but a hand-rolled retry should pass
	 * one too. `quota_exceeded` and `pro_required` are deliberately absent: those
	 * need an upgrade, not another attempt.
	 */
	get retryable(): boolean {
		return (
			this.code === "rate_limited" ||
			this.code === "internal_error" ||
			this.code === "service_unavailable" ||
			this.code === "timeout" ||
			this.code === "network_error"
		);
	}

	override toString(): string {
		const where = this.status ? `HTTP ${this.status}` : "no response";
		return `${this.name} [${this.code}] (${where}): ${this.message}`;
	}
}

export function isKiomonError(value: unknown): value is KiomonError {
	return value instanceof KiomonError;
}

/**
 * Build a KiomonError from a non-2xx response.
 *
 * The API answers `{ error: "..." }`, and the rate limiter adds
 * `needsUpgrade: true` with HTTP 402 on Free. A 404 is deliberately also what a
 * *denied* workspace returns — the worker fails closed rather than confirming
 * that a workspace exists — so `not_found` can mean "no access" rather than
 * "does not exist".
 */
export async function errorFromResponse(
	response: Response,
): Promise<KiomonError> {
	let body: unknown;
	let message = response.statusText || `Request failed with HTTP ${response.status}`;
	let serverCode: unknown;
	let needsUpgrade = false;

	try {
		body = await response.json();
		if (body && typeof body === "object") {
			const record = body as Record<string, unknown>;
			if (typeof record.error === "string" && record.error) message = record.error;
			if (typeof record.message === "string" && !record.error) message = record.message;
			serverCode = record.code;
			if (record.needsUpgrade === true) needsUpgrade = true;
		}
	} catch {
		// Non-JSON body (an HTML error page from a proxy, an empty 204, …). The
		// status is still authoritative; keep the status text as the message.
	}

	if (response.status === 402) needsUpgrade = true;

	return new KiomonError(message, {
		status: response.status,
		// A server-supplied code wins over the status mapping; unknown strings are
		// passed through so a caller can switch on codes the SDK does not know yet.
		code: typeof serverCode === "string" ? (serverCode as KiomonErrorCode) : codeForStatus(response.status),
		body,
		needsUpgrade,
		requestId: response.headers.get("x-request-id") ?? undefined,
	});
}
