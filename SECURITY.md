# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Security Model

`@yedoma-labs/ilyn-pages` iterates over paginated HTTP APIs. The security model assumes:

- **Start URL and options** are written by trusted developers.
- **Server responses** are untrusted. Any `nextCursor`, `Link` header or body value can be
  malicious, broken or repeat forever.
- **Credentials** may be attached by the injected `fetch` implementation, so the client must never
  send them to a host the developer did not choose.

## Security Features

1. **Origin pinning for next URLs**
   - `createFetchPager` follows a next URL only if its origin equals the origin of the start URL.
   - Other origins, including `http` for an `https` start URL, are rejected with `INVALID_LINK`.
   - The check can be disabled with `allowCrossOriginNext: true`. The default is `false`.
   - This prevents a compromised server from redirecting the client to a foreign host and leaking
     tokens.

2. **Query values are masked in error messages**
   - URLs in errors keep their query keys but replace all values with `***`.
   - Credentials and fragments are removed.
   - Cursor values are never copied into error messages.

3. **Loop and resource limits**
   - Repeated cursors are detected (`CURSOR_LOOP`).
   - Endless empty pages are detected (`EMPTY_PAGES_LOOP`).
   - The number of pages is limited (`maxPages`, default 100) and so is the number of items
     (`maxItems`).
   - Per-page and total timeouts (`timeoutMs`, `totalTimeoutMs`) stop hanging requests.

4. **Rate limits**
   - `Retry-After` is capped at 60 seconds.
   - A rate-limited page is retried at most 3 times.

5. **Malformed Link headers**
   - A broken `Link` header that mentions `rel="next"` raises `INVALID_LINK` instead of silently
     ending the iteration.

6. **Cancellation**
   - Aborting the signal or calling `return()` (for example `break` in `for await`) aborts the
     request signal.

## Known Limitations

1. **Redirects** are handled by the injected `fetch`. A redirect to another origin is followed
   unless the `fetch` implementation prevents it. Configure `redirect` in the injected `fetch` if
   this matters for your credentials.
2. **Synchronous work** in `extract`, `nextFromResponse` or `fetchPage` cannot be interrupted. Only
   awaited work is covered by timeouts.
3. **Errors from the injected `fetch`** are passed through unchanged. Their messages are not
   masked by this library.
4. **Retry-After waits** count towards the page timeout. A `Retry-After` longer than `timeoutMs`
   ends with `TIMEOUT`.

## Reporting Vulnerabilities

If you discover a security vulnerability in `@yedoma-labs/ilyn-pages`, please open a GitHub issue.

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Security Best Practices

1. **Keep `allowCrossOriginNext` at its default** unless you know the API hands out URLs on another
   host by design.
2. **Use the `fetch` implementation to attach credentials** rather than putting them into the URL.
   Tokens in query strings end up in logs and proxies.
3. **Set `maxItems` and `maxPages`** to the largest result you expect, so a misbehaving server
   cannot make the client read indefinitely.

## Dependency Security

This library has **zero runtime dependencies**. Run `npm audit` or `pnpm audit` regularly for the
development dependencies.

## License

MIT. See [LICENSE](LICENSE) for details.
