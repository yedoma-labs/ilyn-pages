import { PaginationError } from "./errors.js";

interface LinkScan {
	links: Record<string, string>;
	/** True when a malformed link-value mentions `rel="next"`. */
	malformedNext: boolean;
}

const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
const NEXT_MENTION = /\brel\s*=\s*"?[^";,]*\bnext\b/i;

function isTokenChar(ch: string): boolean {
	return TOKEN_CHAR.test(ch);
}

/**
 * Tokenizer for RFC 8288 Link headers. URI references are read between `<` and `>`, so commas and
 * semicolons inside a URL are not treated as separators. Quoted parameter values support backslash
 * escapes. Malformed link-values are skipped; the scan resumes at the next `<`.
 */
function scanLinkHeader(value: string): LinkScan {
	const links: Record<string, string> = {};
	let malformedNext = false;
	const n = value.length;
	let i = 0;

	const skipSpaces = (): void => {
		while (i < n && (value.charAt(i) === " " || value.charAt(i) === "\t")) {
			i += 1;
		}
	};

	while (i < n) {
		skipSpaces();
		if (i >= n) {
			break;
		}
		if (value.charAt(i) === ",") {
			i += 1;
			continue;
		}

		const linkStart = i;
		let target: string | undefined;
		if (value.charAt(i) === "<") {
			const close = value.indexOf(">", i + 1);
			if (close !== -1) {
				target = value.slice(i + 1, close).trim();
				i = close + 1;
			}
		}

		let ok = target !== undefined;
		const rels: string[] = [];

		while (ok) {
			skipSpaces();
			if (i >= n) {
				break;
			}
			const ch = value.charAt(i);
			if (ch === ",") {
				i += 1;
				break;
			}
			if (ch !== ";") {
				ok = false;
				break;
			}
			i += 1;
			skipSpaces();

			const nameStart = i;
			while (i < n && isTokenChar(value.charAt(i))) {
				i += 1;
			}
			const name = value.slice(nameStart, i).toLowerCase();
			if (name === "") {
				ok = false;
				break;
			}
			skipSpaces();

			let paramValue: string | undefined;
			if (value.charAt(i) === "=") {
				i += 1;
				skipSpaces();
				if (value.charAt(i) === '"') {
					i += 1;
					let quoted = "";
					let closed = false;
					while (i < n) {
						const c = value.charAt(i);
						if (c === "\\" && i + 1 < n) {
							quoted += value.charAt(i + 1);
							i += 2;
							continue;
						}
						i += 1;
						if (c === '"') {
							closed = true;
							break;
						}
						quoted += c;
					}
					if (!closed) {
						ok = false;
						break;
					}
					paramValue = quoted;
				} else {
					const valueStart = i;
					while (i < n && isTokenChar(value.charAt(i))) {
						i += 1;
					}
					if (i === valueStart) {
						ok = false;
						break;
					}
					paramValue = value.slice(valueStart, i);
				}
			}

			if (name === "rel" && paramValue !== undefined) {
				rels.push(...paramValue.split(/\s+/).filter((rel) => rel !== ""));
			}
		}

		if (ok && target !== undefined) {
			for (const rel of rels) {
				const key = rel.toLowerCase();
				if (key !== "__proto__" && !Object.hasOwn(links, key)) {
					links[key] = target;
				}
			}
		} else {
			malformedNext = malformedNext || NEXT_MENTION.test(value.slice(linkStart));
			const nextLink = value.indexOf("<", linkStart + 1);
			i = nextLink === -1 ? n : nextLink;
		}
	}

	return { links, malformedNext };
}

/**
 * Parses an RFC 8288 `Link` header value into a map from relation type to URI reference.
 *
 * Handles quoted and unquoted `rel` values, several relation types in one `rel`, several links
 * separated by commas, additional parameters and URIs that contain commas or semicolons.
 * Relation names are lower-cased. For duplicate relations the first link wins. Malformed
 * link-values are ignored.
 */
export function parseLinkHeader(value: string): Record<string, string> {
	return scanLinkHeader(value).links;
}

/**
 * Returns the URI reference of the `rel="next"` link from a `Link` header, or `undefined`.
 * The URI may be relative; resolve it against the request URL.
 *
 * Throws a `PaginationError` with code `INVALID_LINK` when a malformed link-value mentions
 * `rel="next"` and no valid next link was found. Otherwise a broken header would look like the
 * last page and silently truncate the data.
 */
export function nextFromLinkHeader(headers: {
	get(name: string): string | null;
}): string | undefined {
	const raw = headers.get("link");
	if (raw === null) {
		return undefined;
	}
	const { links, malformedNext } = scanLinkHeader(raw);
	if (Object.hasOwn(links, "next")) {
		return links.next;
	}
	if (malformedNext) {
		throw new PaginationError(
			"INVALID_LINK",
			0,
			'Malformed Link header: rel="next" could not be parsed',
		);
	}
	return undefined;
}
