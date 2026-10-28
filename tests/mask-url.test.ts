import { describe, expect, it } from "vitest";
import { maskUrl } from "../src/mask-url.js";

describe("maskUrl", () => {
	it("masks query values but keeps the keys", () => {
		expect(maskUrl("https://api.example.com/items?token=SECRET&page=2")).toBe(
			"https://api.example.com/items?token=***&page=***",
		);
	});

	it("removes credentials and fragments", () => {
		expect(maskUrl("https://user:pw@api.example.com/items#frag")).toBe(
			"https://api.example.com/items",
		);
	});

	it("returns a placeholder for an invalid URL", () => {
		expect(maskUrl("not a url")).toBe("<invalid URL>");
	});
});
