/**
 * Returns a URL that is safe to put into an error message: credentials are removed, query values
 * are replaced with `***` (keys are kept) and fragments are dropped.
 */
export function maskUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return "<invalid URL>";
	}
	const origin = url.origin === "null" ? url.protocol : url.origin;
	const keys = [...new Set(url.searchParams.keys())];
	const query =
		keys.length > 0 ? `?${keys.map((key) => `${encodeURIComponent(key)}=***`).join("&")}` : "";
	return `${origin}${url.pathname}${query}`;
}
