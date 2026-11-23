# Changelog

## 0.1.0-alpha.5 — 2026-11-23

- Select numbered conversations from the saved list without a web request. Hold the first prompt for the selected conversation during a rate limit.
- Allow longer conversation-detail reads within the operation deadline and retain read-only confirmation after an uncertain write.
- Locate a pending turn's final reply in the current snapshot even when thousands of older nodes or an unfinished turn precede it.
- Skip interrupted streams created before selection when watching for later replies.
- When a personal Dot is configured, return to Dot after a confirmed WeChat reply and ten minutes without owner input. Persist the timer and send one WeChat notice.

## 0.1.0-alpha.4 — 2026-11-22

Audit the enabled production behaviors and publish an explicit feature parity matrix.

- Add `/cd gpt`, optional Windows native GPT/Dot binding, `/cd dot`, account recent lists, titles and capability-aware help. No maintainer IDs or credentials are included.
- Keep Dot reminders active while GPT is selected; independently poll inboxes and outboxes, reconcile uncertain writes read-only, queue known-unsent messages in FIFO order, and retain late replies and restart deduplication.
- Reconcile the exact pending user turn even when its completed response is behind the outbox cursor. This clears stale switch guards without replaying replies or moving the cursor backwards.
- Add owner-only local notifications, authenticated local status/stop, Windows DPAPI-protected state encryption and migration, and a locally compiled Windows Job Object host for process-tree cleanup.
- Support observed current web DOM markers and capture the visible Copy action's original source in memory, without reading or modifying the OS clipboard; keep a rendered-text fallback.
- Retain HTML preview links and exact source storage. Keep `/new`, `/ack`, browser debugging attachment, groups and media out of scope.
- Add regression, browser, native protocol, encryption, local control and real Windows process containment tests. Real-account read-only discovery succeeded; fresh WeChat pairing and full real-account round trips remain pending.

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
