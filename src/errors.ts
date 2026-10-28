export type PaginationErrorCode =
	| "CURSOR_LOOP"
	| "PAGE_LIMIT"
	| "RATE_LIMITED"
	| "TIMEOUT"
	| "ABORTED"
	| "EMPTY_PAGES_LOOP"
	| "INVALID_LINK";

/**
 * Error raised by the pagination guards.
 *
 * `page` is the 1-based number of the page whose request or response caused the error.
 * Adapters such as `createFetchPager` do not know the page number and use `0`; `paginate()`
 * replaces it with the real number before the error reaches the caller.
 */
export class PaginationError extends Error {
	readonly code: PaginationErrorCode;
	readonly page: number;

	constructor(
		code: PaginationErrorCode,
		page: number,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "PaginationError";
		this.code = code;
		this.page = page;
	}
}
