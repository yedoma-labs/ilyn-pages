import { describe, expect, it, vi } from "vitest";
import { type FetchPage, type Page, PaginationError, paginate } from "../src/index.js";

/** Serves pages by cursor "p<index>". The first page is requested with `undefined`. */
function serve<T>(pages: Page<T>[]): { fetchPage: FetchPage<T>; calls: (string | undefined)[] } {
	const calls: (string | undefined)[] = [];
	const fetchPage: FetchPage<T> = async (cursor) => {
		calls.push(cursor);
		const index = cursor === undefined ? 0 : Number(cursor.slice(1));
		const page = pages[index];
		if (page === undefined) {
			throw new Error(`no page for cursor ${String(cursor)}`);
		}
		return page;
	};
	return { fetchPage, calls };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) {
		items.push(item);
	}
	return items;
}

async function errorFrom(promise: Promise<unknown>): Promise<PaginationError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(PaginationError);
	return error as PaginationError;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("paginate iteration", () => {
	it("iterates all cursor pages in order", async () => {
		const { fetchPage, calls } = serve<number>([
			{ items: [1, 2], nextCursor: "p1" },
			{ items: [3], nextCursor: "p2" },
			{ items: [4, 5], nextCursor: null },
		]);
		await expect(collect(paginate({ fetchPage }))).resolves.toEqual([1, 2, 3, 4, 5]);
		expect(calls).toEqual([undefined, "p1", "p2"]);
	});

	it("treats an undefined nextCursor as the last page", async () => {
		const { fetchPage, calls } = serve<number>([{ items: [1] }, { items: [2] }]);
		await expect(collect(paginate({ fetchPage }))).resolves.toEqual([1]);
		expect(calls).toEqual([undefined]);
	});

	it("requests nothing before iteration starts", () => {
		const { fetchPage, calls } = serve<number>([{ items: [1] }]);
		paginate({ fetchPage });
		expect(calls).toEqual([]);
	});

	it("propagates errors thrown by fetchPage unchanged", async () => {
		const boom = new Error("network down");
		const fetchPage: FetchPage<number> = async () => {
			throw boom;
		};
		await expect(collect(paginate({ fetchPage }))).rejects.toBe(boom);
	});
});

describe("paginate guards", () => {
	it("throws CURSOR_LOOP when a cursor repeats across pages", async () => {
		const { fetchPage } = serve<number>([
			{ items: [1], nextCursor: "p1" },
			{ items: [2], nextCursor: "p1" },
		]);
		const error = await errorFrom(collect(paginate({ fetchPage })));
		expect(error.code).toBe("CURSOR_LOOP");
		expect(error.page).toBe(2);
	});

	it("throws CURSOR_LOOP when a page returns its own cursor", async () => {
		const { fetchPage } = serve<number>([{ items: [1], nextCursor: "p0" }]);
		const error = await errorFrom(collect(paginate({ fetchPage })));
		expect(error.code).toBe("CURSOR_LOOP");
		expect(error.page).toBe(2);
	});

	it("does not include cursor values in the error message", async () => {
		const { fetchPage } = serve<number>([{ items: [1], nextCursor: "p0" }]);
		const error = await errorFrom(collect(paginate({ fetchPage })));
		expect(error.message).not.toContain("p0");
	});

	it("throws PAGE_LIMIT when more pages exist after maxPages", async () => {
		const { fetchPage, calls } = serve<number>([
			{ items: [1], nextCursor: "p1" },
			{ items: [2], nextCursor: "p2" },
			{ items: [3], nextCursor: null },
		]);
		const received: number[] = [];
		const error = await errorFrom(
			(async () => {
				for await (const item of paginate({ fetchPage, maxPages: 2 })) {
					received.push(item);
				}
			})(),
		);
		expect(error.code).toBe("PAGE_LIMIT");
		expect(error.page).toBe(2);
		expect(received).toEqual([1, 2]);
		expect(calls).toHaveLength(2);
	});

	it("completes without error when the last allowed page has no next cursor", async () => {
		const { fetchPage } = serve<number>([
			{ items: [1], nextCursor: "p1" },
			{ items: [2], nextCursor: null },
		]);
		await expect(collect(paginate({ fetchPage, maxPages: 2 }))).resolves.toEqual([1, 2]);
	});

	it("stops without error after maxItems and does not request further pages", async () => {
		const { fetchPage, calls } = serve<number>([
			{ items: [1, 2], nextCursor: "p1" },
			{ items: [3, 4], nextCursor: "p2" },
			{ items: [5], nextCursor: null },
		]);
		await expect(collect(paginate({ fetchPage, maxItems: 3 }))).resolves.toEqual([1, 2, 3]);
		expect(calls).toEqual([undefined, "p1"]);
	});

	it("stops after maxItems at the end of a page even if a next cursor exists", async () => {
		const { fetchPage, calls } = serve<number>([
			{ items: [1, 2], nextCursor: "p1" },
			{ items: [3], nextCursor: null },
		]);
		await expect(collect(paginate({ fetchPage, maxItems: 2 }))).resolves.toEqual([1, 2]);
		expect(calls).toEqual([undefined]);
	});

	it("requests nothing when maxItems is 0", async () => {
		const { fetchPage, calls } = serve<number>([{ items: [1] }]);
		await expect(collect(paginate({ fetchPage, maxItems: 0 }))).resolves.toEqual([]);
		expect(calls).toEqual([]);
	});

	it("throws EMPTY_PAGES_LOOP after three consecutive empty pages with a cursor", async () => {
		const { fetchPage } = serve<number>([
			{ items: [], nextCursor: "p1" },
			{ items: [], nextCursor: "p2" },
			{ items: [], nextCursor: "p3" },
			{ items: [], nextCursor: "p4" },
		]);
		const error = await errorFrom(collect(paginate({ fetchPage })));
		expect(error.code).toBe("EMPTY_PAGES_LOOP");
		expect(error.page).toBe(3);
	});

	it("resets the empty page counter after a page with items", async () => {
		const { fetchPage } = serve<number>([
			{ items: [], nextCursor: "p1" },
			{ items: [7], nextCursor: "p2" },
			{ items: [], nextCursor: "p3" },
			{ items: [], nextCursor: "p4" },
			{ items: [8], nextCursor: null },
		]);
		await expect(collect(paginate({ fetchPage }))).resolves.toEqual([7, 8]);
	});

	it("ends normally on an empty last page without a cursor", async () => {
		const { fetchPage } = serve<number>([
			{ items: [1], nextCursor: "p1" },
			{ items: [], nextCursor: null },
		]);
		await expect(collect(paginate({ fetchPage }))).resolves.toEqual([1]);
	});
});

describe("paginate timeouts", () => {
	it("throws TIMEOUT when a single page exceeds timeoutMs, even if fetchPage ignores the signal", async () => {
		const fetchPage: FetchPage<number> = () => new Promise<Page<number>>(() => {});
		const error = await errorFrom(collect(paginate({ fetchPage, timeoutMs: 20 })));
		expect(error.code).toBe("TIMEOUT");
		expect(error.page).toBe(1);
	});

	it("passes an aborted signal to fetchPage when the page times out", async () => {
		let seen: AbortSignal | undefined;
		const fetchPage: FetchPage<number> = (_cursor, signal) => {
			seen = signal;
			return new Promise<Page<number>>(() => {});
		};
		await errorFrom(collect(paginate({ fetchPage, timeoutMs: 10 })));
		expect(seen?.aborted).toBe(true);
	});

	it("throws TIMEOUT when the total timeout is exceeded across pages", async () => {
		const { fetchPage: inner } = serve<number>([
			{ items: [1], nextCursor: "p1" },
			{ items: [2], nextCursor: "p2" },
			{ items: [3], nextCursor: "p3" },
			{ items: [4], nextCursor: "p4" },
			{ items: [5], nextCursor: null },
		]);
		const slow: FetchPage<number> = async (cursor, signal) => {
			await delay(15);
			return inner(cursor, signal);
		};
		const error = await errorFrom(collect(paginate({ fetchPage: slow, totalTimeoutMs: 30 })));
		expect(error.code).toBe("TIMEOUT");
	});
});

describe("paginate abort and early exit", () => {
	it("rejects with ABORTED when the signal aborts while a request is pending", async () => {
		const controller = new AbortController();
		const fetchPage: FetchPage<number> = () => new Promise<Page<number>>(() => {});
		const pending = collect(paginate({ fetchPage, signal: controller.signal }));
		controller.abort();
		const error = await errorFrom(pending);
		expect(error.code).toBe("ABORTED");
	});

	it("rejects with ABORTED on the next call when the signal aborts between items", async () => {
		const controller = new AbortController();
		const { fetchPage } = serve<number>([{ items: [1, 2, 3], nextCursor: null }]);
		const iterator = paginate({ fetchPage, signal: controller.signal });
		await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
		controller.abort();
		const error = await errorFrom(iterator.next());
		expect(error.code).toBe("ABORTED");
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const { fetchPage, calls } = serve<number>([{ items: [1] }]);
		const error = await errorFrom(collect(paginate({ fetchPage, signal: AbortSignal.abort() })));
		expect(error.code).toBe("ABORTED");
		expect(calls).toEqual([]);
	});

	it("aborts the signal handed to fetchPage when a for-await loop breaks", async () => {
		let captured: AbortSignal | undefined;
		const fetchPage: FetchPage<number> = async (_cursor, signal) => {
			captured = signal;
			return { items: [1, 2], nextCursor: "p1" };
		};
		for await (const item of paginate({ fetchPage })) {
			expect(item).toBe(1);
			break;
		}
		expect(captured?.aborted).toBe(true);
	});

	it("removes its listeners from the user signal after completion", async () => {
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, "addEventListener");
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const { fetchPage } = serve<number>([{ items: [1] }]);
		await collect(paginate({ fetchPage, signal: controller.signal }));
		expect(add).toHaveBeenCalledWith("abort", expect.any(Function), expect.anything());
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});
});

describe("paginate option validation", () => {
	const fetchPage: FetchPage<number> = async () => ({ items: [] });

	it("rejects invalid maxPages", () => {
		expect(() => paginate({ fetchPage, maxPages: 0 })).toThrow(RangeError);
		expect(() => paginate({ fetchPage, maxPages: 1.5 })).toThrow(RangeError);
	});

	it("rejects invalid maxItems", () => {
		expect(() => paginate({ fetchPage, maxItems: -1 })).toThrow(RangeError);
		expect(() => paginate({ fetchPage, maxItems: Number.NaN })).toThrow(RangeError);
	});

	it("rejects non-positive timeouts", () => {
		expect(() => paginate({ fetchPage, timeoutMs: 0 })).toThrow(RangeError);
		expect(() => paginate({ fetchPage, totalTimeoutMs: -5 })).toThrow(RangeError);
	});

	it("rejects a fetchPage that is not a function", () => {
		expect(() => paginate({ fetchPage: undefined as unknown as FetchPage<number> })).toThrow(
			TypeError,
		);
	});
});
