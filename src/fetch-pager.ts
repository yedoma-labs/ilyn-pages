import { PaginationError } from "./errors.js";
import { nextFromLinkHeader } from "./link-header.js";
import { maskUrl } from "./mask-url.js";
import type { FetchPage } from "./types.js";

const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

export interface FetchPagerOptions<T> {
	/** Fetch implementation to use. Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** URL of the first page. The cursor of every later page is a full URL. */
	url: string | URL;
	/** Maps the parsed JSON body to the items of the page. */
	extract: (body: unknown) => T[];
	/**
	 * Returns the URL of the next page, or `null` when there is none. Relative URLs are resolved
	 * against the request URL. Defaults to the `rel="next"` link of the `Link` header.
	 */
	nextFromResponse?: (res: Response, body: unknown) => string | null | undefined;
	/**
	 * Follow next URLs on a different origin than `url`. Defaults to `false`. Keep it `false`:
	 * a compromised server could otherwise redirect the client to a foreign host and receive
	 * credentials that the injected `fetch` attaches.
	 */
	allowCrossOriginNext?: boolean;
}

/**
 * Parses the `Retry-After` value (delay in seconds or HTTP date) into milliseconds, capped at
 * 60 seconds. A missing or unparsable value falls back to one second.
 */
function retryAfterMs(header: string | null, now: number): number {
	if (header === null) {
		return DEFAULT_RETRY_AFTER_MS;
	}
	const value = header.trim();
	let ms: number;
	if (/^\d+$/.test(value)) {
		ms = Number(value) * 1000;
	} else {
		const date = Date.parse(value);
		if (Number.isNaN(date)) {
			return DEFAULT_RETRY_AFTER_MS;
		}
		ms = Math.max(0, date - now);
	}
	return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Waits for `ms`, rejecting with the signal's reason if the signal aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Creates a `fetchPage` function for `paginate()` that follows URL-based cursors.
 *
 * - Next URLs come from the `Link` header (RFC 8288) or from `nextFromResponse`.
 * - Next URLs on a different origin than `url` are rejected with `INVALID_LINK`, unless
 *   `allowCrossOriginNext` is set.
 * - A next URL that equals the start URL throws `CURSOR_LOOP` before page 1 is fetched again.
 * - HTTP 429 waits for `Retry-After` (seconds or HTTP date, capped at 60 s) and retries the same
 *   page up to 3 times, then throws `RATE_LIMITED`. The wait counts towards the page timeout.
 * - Other non-2xx responses throw a plain `Error` that contains only the status code.
 *
 * Errors thrown here have `page: 0`; `paginate()` sets the real page number.
 */
export function createFetchPager<T>(options: FetchPagerOptions<T>): FetchPage<T> {
	const doFetch = options.fetch ?? globalThis.fetch;
	if (typeof doFetch !== "function") {
		throw new TypeError("No fetch implementation available; pass options.fetch");
	}
	const startUrl = new URL(options.url);
	const startOrigin = startUrl.origin;
	const allowCrossOrigin = options.allowCrossOriginNext === true;
	const extract = options.extract;
	const nextFromResponse = options.nextFromResponse;

	const resolveNext = (raw: string | null | undefined, base: string): string | null => {
		if (raw === null || raw === undefined || raw === "") {
			return null;
		}
		let next: URL;
		try {
			next = new URL(raw, base);
		} catch {
			throw new PaginationError("INVALID_LINK", 0, "Next link is not a valid URL");
		}
		if (!allowCrossOrigin && next.origin !== startOrigin) {
			throw new PaginationError(
				"INVALID_LINK",
				0,
				`Next link points to another origin (${next.origin}) and was not followed. ` +
					`Set allowCrossOriginNext to allow it. Link: ${maskUrl(next.href)}`,
			);
		}
		if (next.href === startUrl.href) {
			// paginate() only knows cursors from page 2 on, so a link back to the start URL would
			// re-fetch page 1 and yield its rows twice before the loop is noticed.
			throw new PaginationError(
				"CURSOR_LOOP",
				0,
				"Server linked back to the start URL; stopping to avoid duplicated rows",
			);
		}
		return next.href;
	};

	return async (cursor, signal) => {
		const target = cursor === undefined ? startUrl.href : cursor;
		let retries = 0;

		for (;;) {
			const res = await doFetch(target, { signal });

			if (res.status === 429) {
				await res.body?.cancel().catch(() => undefined);
				if (retries >= MAX_RETRIES) {
					throw new PaginationError(
						"RATE_LIMITED",
						0,
						`Still rate limited (HTTP 429) after ${MAX_RETRIES} retries`,
					);
				}
				retries += 1;
				await sleep(retryAfterMs(res.headers.get("retry-after"), Date.now()), signal);
				continue;
			}

			if (!res.ok) {
				throw new Error(`Request failed with HTTP ${res.status}`);
			}

			let body: unknown;
			try {
				body = await res.json();
			} catch (error) {
				if (error instanceof SyntaxError) {
					// Name the response without echoing its body, which may contain secrets.
					throw new Error(`Response of HTTP ${res.status} is not valid JSON`, { cause: error });
				}
				throw error;
			}
			const items = extract(body);
			if (!Array.isArray(items)) {
				throw new TypeError("extract() must return an array of items");
			}
			const raw = nextFromResponse ? nextFromResponse(res, body) : nextFromLinkHeader(res.headers);
			return { items, nextCursor: resolveNext(raw, target) };
		}
	};
}
