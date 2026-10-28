import { describe, expect, it } from "vitest";
import { nextFromLinkHeader, PaginationError, parseLinkHeader } from "../src/index.js";

function headersWith(link?: string): Headers {
	return new Headers(link === undefined ? {} : { link });
}

function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected function to throw");
}

describe("parseLinkHeader", () => {
	it("parses next and last links", () => {
		const value =
			'<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=9>; rel="last"';
		expect(parseLinkHeader(value)).toEqual({
			next: "https://api.example.com/items?page=2",
			last: "https://api.example.com/items?page=9",
		});
	});

	it("accepts an unquoted rel value", () => {
		expect(parseLinkHeader("<https://api.example.com/items?page=2>; rel=next")).toEqual({
			next: "https://api.example.com/items?page=2",
		});
	});

	it("splits several relation types in one rel value", () => {
		expect(parseLinkHeader('<https://a.example/x>; rel="next last"')).toEqual({
			next: "https://a.example/x",
			last: "https://a.example/x",
		});
	});

	it("lower-cases relation names", () => {
		expect(parseLinkHeader('<https://a.example/x>; REL="NEXT"')).toEqual({
			next: "https://a.example/x",
		});
	});

	it("keeps commas and semicolons inside the URI", () => {
		expect(parseLinkHeader('<https://a.example/x?ids=1,2,3;4&p=5>; rel="next"')).toEqual({
			next: "https://a.example/x?ids=1,2,3;4&p=5",
		});
	});

	it("ignores extra parameters and optional whitespace", () => {
		const value =
			'<https://a.example/x> ; title="Next, page" ; type="application/json" ; rel = "next"';
		expect(parseLinkHeader(value)).toEqual({ next: "https://a.example/x" });
	});

	it("handles escaped quotes inside quoted parameter values", () => {
		const value = '<https://a.example/x>; title="say \\"hi\\", ok"; rel="next"';
		expect(parseLinkHeader(value)).toEqual({ next: "https://a.example/x" });
	});

	it("keeps the first link for a duplicate relation", () => {
		expect(
			parseLinkHeader('<https://a.example/1>; rel="next", <https://a.example/2>; rel="next"'),
		).toEqual({ next: "https://a.example/1" });
	});

	it("returns an empty record for an empty or separator-only header", () => {
		expect(parseLinkHeader("")).toEqual({});
		expect(parseLinkHeader(" , ,, ")).toEqual({});
	});

	it("skips a broken link-value and keeps the valid links around it", () => {
		expect(parseLinkHeader('garbage, <https://a.example/n>; rel="next"')).toEqual({
			next: "https://a.example/n",
		});
	});

	it("returns nothing for an unclosed URI", () => {
		expect(parseLinkHeader('<https://a.example/x; rel="next"')).toEqual({});
	});
});

describe("nextFromLinkHeader", () => {
	it("returns the next URI", () => {
		expect(nextFromLinkHeader(headersWith('<https://a.example/n>; rel="next"'))).toBe(
			"https://a.example/n",
		);
	});

	it("returns undefined when the header is absent", () => {
		expect(nextFromLinkHeader(headersWith())).toBeUndefined();
	});

	it("returns undefined when there is no next relation", () => {
		expect(nextFromLinkHeader(headersWith('<https://a.example/l>; rel="last"'))).toBeUndefined();
	});

	it("returns a relative URI unchanged", () => {
		expect(nextFromLinkHeader(headersWith('</items?page=2>; rel="next"'))).toBe("/items?page=2");
	});

	it("throws INVALID_LINK when a broken link-value mentions rel=next", () => {
		const error = thrownBy(() =>
			nextFromLinkHeader(headersWith('<https://a.example/x; rel="next"')),
		);
		expect(error).toBeInstanceOf(PaginationError);
		expect((error as PaginationError).code).toBe("INVALID_LINK");
	});

	it("throws INVALID_LINK for an unterminated quoted rel value", () => {
		const error = thrownBy(() =>
			nextFromLinkHeader(headersWith('<https://a.example/x>; rel="next')),
		);
		expect((error as PaginationError).code).toBe("INVALID_LINK");
	});

	it("does not throw for a broken link that does not concern the next page", () => {
		expect(nextFromLinkHeader(headersWith('<https://a.example/x; rel="last"'))).toBeUndefined();
	});
});
