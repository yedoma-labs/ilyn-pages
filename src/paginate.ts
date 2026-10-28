import { PaginationError } from "./errors.js";
import type { FetchPage, Page, PaginateOptions } from "./types.js";

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_EMPTY_PAGES = 3;

interface Limits {
	maxPages: number;
	maxItems: number;
	timeoutMs: number;
	totalTimeoutMs: number;
}

function resolveLimits<T>(options: PaginateOptions<T>): Limits {
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const totalTimeoutMs = options.totalTimeoutMs ?? Number.POSITIVE_INFINITY;

	if (!(maxPages === Number.POSITIVE_INFINITY || (Number.isInteger(maxPages) && maxPages >= 1))) {
		throw new RangeError("maxPages must be a positive integer or Infinity");
	}
	if (!(maxItems === Number.POSITIVE_INFINITY || (Number.isInteger(maxItems) && maxItems >= 0))) {
		throw new RangeError("maxItems must be a non-negative integer or Infinity");
	}
	if (!(timeoutMs > 0)) {
		throw new RangeError("timeoutMs must be greater than 0");
	}
	if (!(totalTimeoutMs > 0)) {
		throw new RangeError("totalTimeoutMs must be greater than 0");
	}
	return { maxPages, maxItems, timeoutMs, totalTimeoutMs };
}

/** `undefined`, `null` and `""` mean "no next page". */
function normalizeCursor(value: string | null | undefined): string | undefined {
	return value === undefined || value === null || value === "" ? undefined : value;
}

/** Adapters without page context throw with page 0; this fills in the real page number. */
function withPage(error: unknown, page: number): unknown {
	if (error instanceof PaginationError && error.page === 0) {
		return new PaginationError(error.code, page, error.message, { cause: error });
	}
	return error;
}

async function* iterate<T>(
	fetchPage: FetchPage<T>,
	limits: Limits,
	userSignal: AbortSignal | undefined,
): AsyncGenerator<T, void, undefined> {
	const run = new AbortController();
	const inflight: { ctl?: AbortController } = {};
	const seen = new Set<string>();
	let pageNo = 1;
	let cursor: string | undefined;
	let emitted = 0;
	let emptyStreak = 0;
	let totalTimer: ReturnType<typeof setTimeout> | undefined;

	const onUserAbort = (): void => {
		run.abort(
			new PaginationError("ABORTED", pageNo, "Pagination was aborted", {
				cause: userSignal?.reason,
			}),
		);
	};

	/**
	 * Requests one page. The page signal is aborted when the run is aborted (user signal, total
	 * timeout or iterator return) and after `timeoutMs`. The promise rejects as soon as the signal
	 * fires, even if `fetchPage` ignores the signal.
	 */
	const request = (pageCursor: string | undefined, page: number): Promise<Page<T>> =>
		new Promise<Page<T>>((resolve, reject) => {
			if (run.signal.aborted) {
				reject(run.signal.reason);
				return;
			}
			const ctl = new AbortController();
			inflight.ctl = ctl;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const onParentAbort = (): void => ctl.abort(run.signal.reason);
			const onPageAbort = (): void => settle(() => reject(ctl.signal.reason));
			const settle = (done: () => void): void => {
				clearTimeout(timer);
				run.signal.removeEventListener("abort", onParentAbort);
				ctl.signal.removeEventListener("abort", onPageAbort);
				done();
			};

			run.signal.addEventListener("abort", onParentAbort, { once: true });
			ctl.signal.addEventListener("abort", onPageAbort, { once: true });
			if (Number.isFinite(limits.timeoutMs)) {
				timer = setTimeout(() => {
					ctl.abort(
						new PaginationError(
							"TIMEOUT",
							page,
							`Page ${page} timed out after ${limits.timeoutMs} ms`,
						),
					);
				}, limits.timeoutMs);
			}

			let work: Promise<Page<T>>;
			try {
				work = Promise.resolve(fetchPage(pageCursor, ctl.signal));
			} catch (error) {
				work = Promise.reject(error);
			}
			work.then(
				(result) => settle(() => resolve(result)),
				(error: unknown) => settle(() => reject(withPage(error, page))),
			);
		});

	if (userSignal?.aborted) {
		onUserAbort();
	} else {
		userSignal?.addEventListener("abort", onUserAbort, { once: true });
	}
	if (Number.isFinite(limits.totalTimeoutMs)) {
		totalTimer = setTimeout(() => {
			run.abort(
				new PaginationError(
					"TIMEOUT",
					pageNo,
					`Total timeout of ${limits.totalTimeoutMs} ms exceeded`,
				),
			);
		}, limits.totalTimeoutMs);
	}

	try {
		while (emitted < limits.maxItems) {
			if (run.signal.aborted) {
				throw run.signal.reason;
			}

			const result = await request(cursor, pageNo);
			if (!Array.isArray(result.items)) {
				throw new TypeError("fetchPage must resolve to an object with an items array");
			}
			const next = normalizeCursor(result.nextCursor);

			if (next !== undefined && seen.has(next)) {
				throw new PaginationError(
					"CURSOR_LOOP",
					pageNo,
					`Server returned a cursor that was already used (page ${pageNo}); stopping`,
				);
			}

			if (result.items.length === 0) {
				if (next !== undefined) {
					emptyStreak += 1;
					if (emptyStreak >= MAX_EMPTY_PAGES) {
						throw new PaginationError(
							"EMPTY_PAGES_LOOP",
							pageNo,
							`${MAX_EMPTY_PAGES} consecutive empty pages with a next cursor (page ${pageNo}); stopping`,
						);
					}
				}
			} else {
				emptyStreak = 0;
			}

			for (const item of result.items) {
				if (run.signal.aborted) {
					throw run.signal.reason;
				}
				yield item;
				emitted += 1;
				if (emitted >= limits.maxItems) {
					return;
				}
			}

			if (next === undefined) {
				return;
			}
			if (pageNo >= limits.maxPages) {
				throw new PaginationError(
					"PAGE_LIMIT",
					pageNo,
					`Page limit of ${limits.maxPages} reached while more pages are available`,
				);
			}
			seen.add(next);
			cursor = next;
			pageNo += 1;
		}
	} finally {
		clearTimeout(totalTimer);
		userSignal?.removeEventListener("abort", onUserAbort);
		// Cancels the open request when the consumer stops early (break, return) or on errors.
		inflight.ctl?.abort();
		run.abort();
	}
}

/**
 * Iterates over all items of a paginated API.
 *
 * Guards: repeated cursors (`CURSOR_LOOP`), a page limit (`PAGE_LIMIT`), endless empty pages
 * (`EMPTY_PAGES_LOOP`), per-page and total timeouts (`TIMEOUT`) and an abort signal (`ABORTED`).
 * Reaching `maxItems` stops without error.
 *
 * Breaking out of a `for await` loop calls `return()`, which aborts the signal of any request
 * that is still open.
 *
 * Options are validated when `paginate()` is called. Iteration starts on the first `next()`.
 */
export function paginate<T>(options: PaginateOptions<T>): AsyncGenerator<T, void, undefined> {
	if (typeof options.fetchPage !== "function") {
		throw new TypeError("fetchPage must be a function");
	}
	return iterate(options.fetchPage, resolveLimits(options), options.signal);
}
