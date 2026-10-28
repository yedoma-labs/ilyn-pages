import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchPager, PaginationError, paginate } from "../src/index.js";

const START = "https://api.example.com/items";

interface FakeFetch {
	fetch: typeof fetch;
	calls: string[];
}

/** Injected fetch that never touches the network. Records every requested URL. */
function fakeFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FakeFetch {
	const calls: string[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		return handler(url, init ?? {});
	};
	return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

function status(code: number, headers: Record<string, string> = {}): Response {
	return new Response("", { status: code, headers });
}

const extractItems = (body: unknown): number[] => (body as { items: number[] }).items;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) {
		items.push(item);
	}
	return items;
}

async function errorFrom(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("createFetchPager with Link headers", () => {
	it("follows rel=next links and resolves relative URIs against the request URL", async () => {
		const f = fakeFetch((url) =>
			url === START
				? json({ items: [1, 2] }, { link: '<?page=2>; rel="next"' })
				: json({ items: [3] }),
		);
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		await expect(collect(paginate({ fetchPage: pager }))).resolves.toEqual([1, 2, 3]);
		expect(f.calls).toEqual([START, `${START}?page=2`]);
	});

	it("uses the cursor-from-body adapter when nextFromResponse is given", async () => {
		const f = fakeFetch((url) =>
			url === START
				? json({ items: [1], next: "/items?cursor=abc" })
				: json({ items: [2], next: null }),
		);
		const pager = createFetchPager({
			url: START,
			fetch: f.fetch,
			extract: extractItems,
			nextFromResponse: (_res, body) => (body as { next: string | null }).next,
		});
		await expect(collect(paginate({ fetchPage: pager }))).resolves.toEqual([1, 2]);
		expect(f.calls).toEqual([START, "https://api.example.com/items?cursor=abc"]);
	});

	it("rejects a next URL on another host with INVALID_LINK and does not request it", async () => {
		const f = fakeFetch(() =>
			json({ items: [1] }, { link: '<https://evil.example/steal?token=SECRET>; rel="next"' }),
		);
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = await errorFrom(collect(paginate({ fetchPage: pager })));
		expect(error).toBeInstanceOf(PaginationError);
		expect((error as PaginationError).code).toBe("INVALID_LINK");
		expect((error as PaginationError).page).toBe(1);
		expect(f.calls).toEqual([START]);
	});

	it("masks query values in the INVALID_LINK message", async () => {
		const f = fakeFetch(() =>
			json({ items: [1] }, { link: '<https://evil.example/steal?token=SECRET&x=1>; rel="next"' }),
		);
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = (await errorFrom(collect(paginate({ fetchPage: pager })))) as PaginationError;
		expect(error.message).toContain("token=***");
		expect(error.message).not.toContain("SECRET");
	});

	it("rejects a downgrade from https to http as a different origin", async () => {
		const f = fakeFetch(() =>
			json({ items: [1] }, { link: '<http://api.example.com/items?page=2>; rel="next"' }),
		);
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = (await errorFrom(collect(paginate({ fetchPage: pager })))) as PaginationError;
		expect(error.code).toBe("INVALID_LINK");
		expect(f.calls).toEqual([START]);
	});

	it("follows a cross-origin next URL when allowCrossOriginNext is set", async () => {
		const f = fakeFetch((url) =>
			url === START
				? json({ items: [1] }, { link: '<https://cdn.example.org/page2>; rel="next"' })
				: json({ items: [9] }),
		);
		const pager = createFetchPager({
			url: START,
			fetch: f.fetch,
			extract: extractItems,
			allowCrossOriginNext: true,
		});
		await expect(collect(paginate({ fetchPage: pager }))).resolves.toEqual([1, 9]);
		expect(f.calls).toContain("https://cdn.example.org/page2");
	});

	it("throws INVALID_LINK for a malformed Link header that mentions rel=next", async () => {
		const f = fakeFetch(() =>
			json({ items: [1] }, { link: '<https://api.example.com/items?page=2; rel="next"' }),
		);
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = (await errorFrom(collect(paginate({ fetchPage: pager })))) as PaginationError;
		expect(error.code).toBe("INVALID_LINK");
		expect(error.page).toBe(1);
	});

	it("throws a plain error without the URL for non-2xx responses", async () => {
		const f = fakeFetch(() => status(500));
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = await errorFrom(collect(paginate({ fetchPage: pager })));
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PaginationError);
		expect((error as Error).message).toBe("Request failed with HTTP 500");
	});

	it("names the response for a non-JSON body without echoing the body", async () => {
		const f = fakeFetch(
			() =>
				new Response("<html>session-token-123</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		);
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = await errorFrom(collect(paginate({ fetchPage: pager })));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Response of HTTP 200 is not valid JSON");
		expect((error as Error).message).not.toContain("session-token-123");
	});

	it("passes an error from the injected fetch through unchanged", async () => {
		const boom = new Error("socket hang up");
		const pager = createFetchPager({
			url: START,
			fetch: (async () => {
				throw boom;
			}) as unknown as typeof fetch,
			extract: extractItems,
		});
		await expect(collect(paginate({ fetchPage: pager }))).rejects.toBe(boom);
	});
});

describe("createFetchPager rate limiting", () => {
	it("waits for Retry-After in seconds and then retries the same page", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let attempts = 0;
		const f = fakeFetch(() => {
			attempts += 1;
			return attempts === 1 ? status(429, { "retry-after": "2" }) : json({ items: [1] });
		});
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const done = collect(paginate({ fetchPage: pager }));

		await vi.advanceTimersByTimeAsync(1_999);
		expect(f.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(done).resolves.toEqual([1]);
		expect(f.calls).toEqual([START, START]);
	});

	it("waits until an HTTP date in Retry-After", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let attempts = 0;
		const retryAt = new Date(Date.now() + 5_000).toUTCString();
		const f = fakeFetch(() => {
			attempts += 1;
			return attempts === 1 ? status(429, { "retry-after": retryAt }) : json({ items: [1] });
		});
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const done = collect(paginate({ fetchPage: pager }));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(4_000);
		await expect(done).resolves.toEqual([1]);
	});

	it("caps Retry-After at 60 seconds", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let attempts = 0;
		const f = fakeFetch(() => {
			attempts += 1;
			return attempts === 1 ? status(429, { "retry-after": "3600" }) : json({ items: [1] });
		});
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const done = collect(paginate({ fetchPage: pager, timeoutMs: 120_000 }));

		await vi.advanceTimersByTimeAsync(59_999);
		expect(f.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(done).resolves.toEqual([1]);
	});

	it("waits one second when Retry-After is missing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		let attempts = 0;
		const f = fakeFetch(() => {
			attempts += 1;
			return attempts === 1 ? status(429) : json({ items: [1] });
		});
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const done = collect(paginate({ fetchPage: pager }));

		await vi.advanceTimersByTimeAsync(999);
		expect(f.calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(done).resolves.toEqual([1]);
	});

	it("counts Retry-After waits toward the page timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const f = fakeFetch(() => status(429, { "retry-after": "60" }));
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const pending = errorFrom(collect(paginate({ fetchPage: pager, timeoutMs: 30_000 })));
		await vi.advanceTimersByTimeAsync(30_000);
		const error = (await pending) as PaginationError;
		expect(error.code).toBe("TIMEOUT");
	});

	it("throws RATE_LIMITED after three retries (four requests in total)", async () => {
		const f = fakeFetch(() => status(429, { "retry-after": "0" }));
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const error = (await errorFrom(collect(paginate({ fetchPage: pager })))) as PaginationError;
		expect(error.code).toBe("RATE_LIMITED");
		expect(error.page).toBe(1);
		expect(f.calls).toHaveLength(4);
	});

	it("stops waiting for Retry-After when the iteration is aborted", async () => {
		const f = fakeFetch(() => status(429, { "retry-after": "60" }));
		const pager = createFetchPager({ url: START, fetch: f.fetch, extract: extractItems });
		const controller = new AbortController();
		const pending = errorFrom(collect(paginate({ fetchPage: pager, signal: controller.signal })));
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		const error = (await pending) as PaginationError;
		expect(error.code).toBe("ABORTED");
	});
});

describe("createFetchPager timeouts", () => {
	it("aborts a hanging request with the signal and reports TIMEOUT", async () => {
		const pager = createFetchPager({
			url: START,
			fetch: ((_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				})) as unknown as typeof fetch,
			extract: extractItems,
		});
		const error = (await errorFrom(
			collect(paginate({ fetchPage: pager, timeoutMs: 20 })),
		)) as PaginationError;
		expect(error.code).toBe("TIMEOUT");
		expect(error.page).toBe(1);
	});
});

describe("createFetchPager construction", () => {
	it("rejects an invalid start URL immediately", () => {
		expect(() =>
			createFetchPager({
				url: "not a url",
				fetch: fakeFetch(() => json({})).fetch,
				extract: extractItems,
			}),
		).toThrow(TypeError);
	});
});
