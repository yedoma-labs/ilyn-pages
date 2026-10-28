export interface Page<T> {
	items: T[];
	/**
	 * Cursor for the next page. `undefined`, `null` and `""` all mean that this was the last page.
	 */
	nextCursor?: string | null;
}

/**
 * Loads one page. `cursor` is `undefined` for the first page and the previous `nextCursor`
 * afterwards. Implementations should honour `signal` so that timeouts and aborts can cancel
 * the underlying request.
 */
export type FetchPage<T> = (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>;

export interface PaginateOptions<T> {
	fetchPage: FetchPage<T>;
	/** Maximum number of pages that may be requested. Default: 100. */
	maxPages?: number;
	/** Stop without error after this many items. Default: Infinity. */
	maxItems?: number;
	/** Timeout for a single `fetchPage` call in milliseconds. Default: 30000. */
	timeoutMs?: number;
	/** Timeout for the whole iteration in milliseconds. Default: Infinity (disabled). */
	totalTimeoutMs?: number;
	/** Aborts the iteration. The iterator then throws a `PaginationError` with code `ABORTED`. */
	signal?: AbortSignal;
}
