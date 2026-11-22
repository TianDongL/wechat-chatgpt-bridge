# Changelog

## 0.1.0-alpha.3 — 2026-11-22

Preserve ordinary reply text and turn complete HTML components into temporary webpage links.

- Replace only component ranges; retain surrounding text, exact original replies, and source downloads. Keep inline code, non-HTML fences, citations, and incomplete components unchanged.
- Serve interactive components in sandboxed frames from a bounded in-memory loopback server. Link splitting preserves complete preview URLs. Unavailable previews fall back to original replies through the existing delivery ledger.
- Prepare a pinned, checksum-verified official cloudflared binary during setup, with an isolated configuration and shutdown tied to the bridge. No account, domain, personal binary, or browser debugging setup is required.
- Add parsing, HTTP, lifecycle, mobile rendering, sandbox, installation failure, and bridge integration checks. Synthetic content also passed a real temporary public-tunnel check; fresh real-account WeChat round-trip acceptance remains pending.

## 0.1.0-alpha.2 — 2026-11-22

Narrow the public bridge to continuing existing ChatGPT web conversations.

- Remove `/new` and `/ack` from command handling, help, and quick-start instructions. Keep `/help`, `/where`, `/list`, `/cd`, and the `/switch` alias; list up to 12 visible conversations.
- Remove existing-Chrome attachment and its `--browser` option. Use only the dedicated visible browser, without asking users to enable remote debugging.
- Require an existing conversation during setup; never submit from the new-chat page.
- Keep uncertain submissions as terminal per-message records. Fresh messages still check page readiness, while old messages are never replayed. Migrate earlier pause state without deleting delivery records.
- Update upgrade instructions and regression coverage. Real-account end-to-end acceptance remains pending.

## 0.1.0-alpha.1 — 2026-11-22

Initial source release candidate for an owner-only WeChat ↔ ChatGPT web bridge.

Candidate follow-up: optional existing-Chrome attachment owns only its new tab and preserves existing browser windows; QR status network timeouts now retry read-only polling within the pairing deadline. Live account acceptance remains pending.

- Standalone Tencent iLink QR pairing and long polling, without a public callback server.
- A visible dedicated Playwright browser profile; users sign in themselves.
- Strict standalone `/help`, `/where`, `/list`, `/cd`, `/new` and `/ack` commands; `/switch` remains an alias. Selection and list replies include a `/help` hint.
- Durable message reservations, atomic inbox/cursor storage, and no automatic resend after an uncertain submission.
- Owner binding, exact large message IDs, UTF-8-safe reply splitting, and local full reply files.
- Windows setup/start scripts, Chinese and English guides, diagnostics, contribution and security guidance, and CI definitions.

This is a candidate, not a stable release. Live ChatGPT login, fresh WeChat pairing, and a full real-account round trip remain unverified. HTML previews, media, groups, scheduled reminders, and additional AI providers are outside this first version.
