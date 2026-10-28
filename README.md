# @yedoma-labs/ilyn-pages

<picture>
  <source media="(max-width: 640px)" srcset="https://raw.githubusercontent.com/yedoma-labs/assets/main/resized/banner-resized-mobile.png">
  <img src="https://raw.githubusercontent.com/yedoma-labs/assets/main/resized/banner-resized.png" alt="Project Header">
</picture>

[![CI](https://github.com/yedoma-labs/ilyn-pages/actions/workflows/ci.yml/badge.svg)](https://github.com/yedoma-labs/ilyn-pages/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@yedoma-labs/ilyn-pages.svg)](https://www.npmjs.com/package/@yedoma-labs/ilyn-pages)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **илин** (*ilyn*) — Yakutian (Sakha) for "east; front; future"

Zero-dependency async iteration over every page of a paginated HTTP API, with guards against endless
cursor loops, skipped or duplicated rows, rate limits in the middle of a run and hanging requests.

Zero runtime dependencies. Uses only `fetch`, `URL`, `AbortController` and `Headers`, so it runs on
Node.js 20+, Bun and Deno.

## Why

Fetching "all pages" of an API looks trivial and fails in production:

- **Offset pagination** (`?offset=200&limit=100`) skips or repeats rows when data changes between two
  requests. Rows inserted before the current offset shift everything down by one, and rows deleted
  shift everything up.
- **Cursor loops** never end when a server returns the same cursor again.
- **No page limit** means a misbehaving server can keep a client reading forever.
- **HTTP 429** in the middle of a loop aborts the whole run unless you handle it per page.
- **Next links** appear in the body (`{ "next": "..." }`) for some APIs and in the `Link` header
  (RFC 8288) for others. Each needs its own parsing code.
- `@octokit/plugin-paginate-rest` solves this for GitHub only.

`ilyn-pages` is the generic layer for the rest.

## Installation

```sh
pnpm add @yedoma-labs/ilyn-pages
```

## Quick start

### Next link in the `Link` header

```ts
import { createFetchPager, paginate } from "@yedoma-labs/ilyn-pages";

interface Item {
	id: string;
}

const pager = createFetchPager<Item>({
	url: "https://api.example.com/items?per_page=100",
	extract: (body) => (body as { items: Item[] }).items,
	// The next URL comes from `Link: <...>; rel="next"` by default.
});

for await (const item of paginate({ fetchPage: pager, maxItems: 10_000 })) {
	console.log(item.id);
}
```

### Next link in the body

```ts
const pager = createFetchPager<Item>({
	url: "https://api.example.com/items",
	extract: (body) => (body as { data: Item[] }).data,
	nextFromResponse: (_res, body) => (body as { meta: { next: string | null } }).meta.next,
});
```

Relative next URLs are resolved against the URL of the current request.

### Opaque cursors with your own `fetchPage`

```ts
import { paginate, type Page } from "@yedoma-labs/ilyn-pages";

const items = paginate({
	fetchPage: async (cursor, signal): Promise<Page<Item>> => {
		const url = new URL("https://api.example.com/items");
		if (cursor !== undefined) url.searchParams.set("cursor", cursor);
		const res = await fetch(url, { signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as { items: Item[]; nextCursor?: string | null };
		return { items: body.items, nextCursor: body.nextCursor };
	},
});
```

### Handling errors

```ts
import { PaginationError } from "@yedoma-labs/ilyn-pages";

try {
	for await (const item of pages) {
		// ...
	}
} catch (error) {
	if (error instanceof PaginationError) {
		switch (error.code) {
			case "CURSOR_LOOP":
			case "EMPTY_PAGES_LOOP":
				// The server is misbehaving. Report it and stop.
				break;
			case "PAGE_LIMIT":
				// The result is larger than maxPages. Raise the limit or narrow the query.
				break;
			case "RATE_LIMITED":
			case "TIMEOUT":
				// Retry later, the items already yielded are kept by the caller.
				break;
			default:
				throw error;
		}
		console.error(`failed on page ${error.page}: ${error.message}`);
	} else {
		throw error;
	}
}
```

Items that were yielded before an error are not rolled back. Keep what you need as you go.

## Guards

| Guard | Trigger | Result |
| --- | --- | --- |
| Cursor loop | A `nextCursor` was already used in this run | `CURSOR_LOOP` |
| Empty-page loop | 3 consecutive pages without items that still have a cursor | `EMPTY_PAGES_LOOP` |
| Page limit | More pages are available after `maxPages` (default 100) | `PAGE_LIMIT` |
| Item limit | `maxItems` items were yielded | Stops without error |
| Page timeout | One `fetchPage` call (including `Retry-After` waits) exceeds `timeoutMs` (default 30000) | `TIMEOUT` |
| Total timeout | The whole iteration exceeds `totalTimeoutMs` (default: none) | `TIMEOUT` |
| Abort | `signal` is aborted | `ABORTED` |
| Early exit | `break` in `for await`, or `return()` | Open request signal is aborted |
| Rate limit | HTTP 429 | Waits for `Retry-After` (seconds or HTTP date, capped at 60 s), retries the page up to 3 times, then `RATE_LIMITED` |
| Link back to start | Next URL equals the start URL | `CURSOR_LOOP` |
| Foreign next URL | Next URL has another origin than the start URL | `INVALID_LINK` (unless `allowCrossOriginNext: true`) |
| Broken `Link` header | Malformed link that mentions `rel="next"` and no valid next link | `INVALID_LINK` |

Guard errors are `PaginationError` instances with a `code` and a `page` number (the page whose request or
response caused the error). Error messages never contain query values or cursors.

Other errors pass through unchanged: a non-2xx status from `createFetchPager` is a plain `Error`
(`Request failed with HTTP 500`), a body that is not JSON is a plain `Error` that names the status,
and errors from the injected `fetch` are rethrown as they are.

## API

### `paginate<T>(options): AsyncGenerator<T>`

| Option | Default | Description |
| --- | --- | --- |
| `fetchPage(cursor, signal)` | required | Loads one page. `cursor` is `undefined` for the first page. |
| `maxPages` | `100` | Maximum number of pages. A positive integer or `Infinity`. |
| `maxItems` | `Infinity` | Stops without error after this many items. |
| `timeoutMs` | `30000` | Timeout per `fetchPage` call. |
| `totalTimeoutMs` | `Infinity` | Timeout for the whole iteration. |
| `signal` | none | Aborts the iteration with `ABORTED`. |

`fetchPage` returns `{ items: T[]; nextCursor?: string | null }`. `undefined`, `null` and `""` all
mean that there is no next page.

Options are validated when `paginate()` is called and throw a `RangeError` for invalid values.
Iteration starts with the first `next()`.

### `createFetchPager<T>(options): FetchPage<T>`

| Option | Default | Description |
| --- | --- | --- |
| `url` | required | URL of the first page. |
| `extract(body)` | required | Returns the items of the parsed JSON body. |
| `nextFromResponse(res, body)` | `Link` header | Returns the next URL or `null`. |
| `fetch` | `globalThis.fetch` | Injected fetch implementation. |
| `allowCrossOriginNext` | `false` | Allows next URLs on another origin. |

### `parseLinkHeader(value): Record<string, string>`

Parses an RFC 8288 `Link` header. Handles quoted and unquoted `rel`, several relations in one `rel`,
several links, extra parameters, and URIs that contain commas or semicolons. Relation names are
lower-cased. The first link wins for duplicate relations. Malformed link values are skipped.

### `nextFromLinkHeader(headers): string | undefined`

Returns the `rel="next"` URI from a `Headers` object. The URI may be relative.

## Offset pagination

Offset pagination is not consistent under concurrent writes. Between two requests, rows inserted
before the offset shift the window and the same row appears on two pages. Rows deleted before the
offset cause a row to be skipped. The library cannot detect this, because each page is correct for
the data at the moment it was read.

Prefer cursor or keyset pagination. Keyset pagination uses the last sort key, for example
`?after_id=123`, and keeps working when rows change. If the API only offers offsets, sort by a
stable unique key, accept that the result is a snapshot per page, and compare the total count before
and after the run.

## Security

The next URL comes from the server and is untrusted. By default, `createFetchPager` follows a next
URL only when its origin matches the origin of the start URL. A next URL on another host, or on
`http` for an `https` start URL, raises `INVALID_LINK` and is not requested. This stops a compromised
or misconfigured server from sending the client to a foreign host, where your tokens could leak.
Enable `allowCrossOriginNext` only if the API documents cross-origin next links.

Error messages mask query values (`?token=***`). Credentials and fragments are removed from URLs in
errors.

See [SECURITY.md](SECURITY.md) for the full security model and known limitations.

## Runtime support

Node.js 20+, Bun and Deno. The package is ESM with a CommonJS build. Tests use an injected `fetch`
and never touch the network.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT. See [LICENSE](LICENSE).
