# WeChat ChatGPT Bridge

Maintained by [TianDongL](https://github.com/TianDongL). MIT licensed. See the [candidate validation record](docs/validation.md) for the exact tested scope.

Continue your **ChatGPT web conversations from WeChat**. A visible browser on your computer opens ChatGPT; the bridge carries text between that page and your paired WeChat account.

[中文](README.md) · [Feature parity](docs/feature-parity.md) · [Architecture](docs/architecture.md) · [Acceptance checklist](docs/acceptance.md) · [Security](SECURITY.md)

**Status: `0.1.0-alpha.5` release candidate.** Intended for early adopters. A clean-machine, new-account WeChat ↔ ChatGPT conversation has not yet been accepted end to end. Automated tests do not establish real account compatibility; see the [verification boundary](docs/acceptance.md).

## Scope

- Text messages from the owner who paired the WeChat bot, with completed text replies sent back to that owner.
- ChatGPT web conversations, including switching by a normal conversation URL.
- A dedicated, visible Chromium profile. Sign in yourself; no cookie copying, OpenAI API key, or Codex installation is required.
- Ordinary reply text is unchanged. Complete HTML components become webpage links while surrounding text and the complete original reply are preserved.
- Strict standalone commands and persistent delivery state. Uncertain sends are not automatically retried.

V1 supports owner-bound local notifications and optional Dot reminders in Windows native mode. It does not support groups, other contacts, image/audio messages, or files, and does not create schedules itself. HTML previews require extractable source; components that depend on ChatGPT's own environment may not fully render. Keep your computer, terminal, and bridge browser running.

This community project is not affiliated with OpenAI or Tencent. The WeChat adapter follows Tencent's [iLink Bot protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md). The ChatGPT adapter automates the visible webpage with Playwright; it is **not an official ChatGPT API**. Page changes, login challenges, and account restrictions can break compatibility.

## Quick start

Download the [source ZIP](https://github.com/TianDongL/wechat-chatgpt-bridge/archive/refs/heads/main.zip), or clone the repository:

```sh
git clone https://github.com/TianDongL/wechat-chatgpt-bridge.git
cd wechat-chatgpt-bridge
```

You need Node.js **22.13+**, an account that can use ChatGPT in a browser on this computer, and a WeChat account able to pair through iLink Bot. Windows is the first target; macOS and Linux have not been verified with real accounts.

Download and extract this repository's source ZIP, or clone it, then open a terminal in the project directory:

```sh
npm ci
npm run browser:install
npm run setup
```

Follow the terminal prompts:

Setup automatically downloads a pinned official cloudflared release and verifies its SHA-256 for temporary HTML pages. No Cloudflare account, domain, server, or browser debugging setting is required. If the download fails, text chat can still be configured; rerun setup after restoring connectivity. Preview downloads support Windows x64, Linux x64/arm64, and macOS x64/arm64.

1. Sign in to ChatGPT in the dedicated browser opened by setup. Complete any login verification yourself.
2. Open an existing ordinary ChatGPT conversation. If your account has none, send a message manually on the webpage first and wait for a `https://chatgpt.com/c/…` URL. Once the page is loaded and idle with an empty composer, press Enter in the terminal. The bridge only connects to existing conversations.
3. Scan the displayed QR code with WeChat and confirm pairing. Enter a verification code if prompted. Do not run two bridges against the same bot.
4. Start the bridge:

```sh
npm start
```

Wait for the terminal to report that the bridge is running, then send `/help` to the paired bot in WeChat. Send a simple test such as `Reply with only: connected`.

The first connection is successful when all three are observed: WeChat receives the help text; the test message appears in the ChatGPT page; and its completed reply arrives in WeChat. A successful startup message alone does not verify this path.

Press **Ctrl+C** in the bridge terminal to stop. Use `npm start` to run again. Historical incoming messages not received before startup are skipped; pending messages already saved by the bridge are recovered according to their state. Windows npm start and start.cmd use a locally compiled .NET Job Object host to clean up the worker and its browser/tunnel descendants when the host or terminal closes. No background service, automatic restart, or startup-at-login is installed. While bridging, do not manually send messages, navigate, or leave an unsent draft in the dedicated tab.

Unsent busy/unavailable requests wait in FIFO order for at most ten minutes. Native uncertain submissions get up to 90 seconds of read-only reconciliation; writes are never repeated. Independent outbox listeners recover late final answers. A pending web answer prevents switching, while help and Dot notifications remain responsive.

Native final text is preserved directly; the current web UI first uses its visible Copy action to capture original Markdown/HTML in memory without reading or changing the system clipboard. When unavailable, the browser falls back to rendered Markdown and exact source formatting cannot be promised.

## Upgrading from an earlier candidate

Stop the old bridge, update the source, and run `npm ci` while preserving your data directory. If you used existing-Chrome attachment, run `npm run browser:install` and `npm run setup`, then sign in to the dedicated browser and select an existing conversation. You can reuse the WeChat pairing. Manual remote-debugging setup is no longer needed. A saved homepage selection requires setup again; old uncertain records are retained without replay.

When upgrading from `alpha.2`, run setup once to prepare the preview program; the existing browser login and WeChat pairing can be reused.

## Optional Windows native / Dot mode

Run `npm run setup:native` instead of ordinary setup, then `npm start`. Keep the installed Codex desktop app running and signed in to the intended ChatGPT account, with an existing local Codex work conversation available for caller context. Enter an existing web conversation URL and optionally enable the personal Dot discovered for your own account. Pair your own WeChat bot. This mode needs no bridge browser, copied cookies, API key or browser debugging switch. Ordinary setup switches back to browser mode.

Native mode uses the installed app sign-in in memory, reads a bounded metadata tail from the local conversation index, and validates the personal Dot room and both participants. It ships no maintainer identities. These are non-public interfaces and may change; Dot is optional and not available to every account. Native prompts are limited to 4096 UTF-8 bytes. `/cd gpt` selects your setup default; `/cd dot` selects your bound Dot. Dot reminders continue independently while GPT is selected.

`npm run status` inspects a running bridge; `npm run stop` stops it. Local programs can pass `{"request_id":"unique-id","purpose":"reminder","text":"message"}` on stdin to `node src/cli.js notify --stdin`. Supported purposes are reminder, progress, todo and test. Notifications go only to the paired owner, require a verified owner reply context for the current WeChat login and deduplicate request IDs. No recipient override or assumed Tencent context TTL is exposed. The authenticated local control port is never tunneled.

## Commands

Commands must occupy a single message on one line. `/` and `\` prefixes are accepted. Commands embedded in prose or multi-line text remain ordinary chat text. `/cd gpt` returns to the setup default. `/cd dot` is available after optional native Dot binding. Native lists show the 12 most recently updated account conversations; browser lists remain limited to visible sidebar links.

Use `/cd` to switch conversations; `/switch` remains a compatible alias. List, current-conversation and selection replies include a `/help` hint.

| Command | Action |
| --- | --- |
| `/help` | Show help |
| `/where` | Show the current ChatGPT web conversation |
| `/list` | Number up to 12 conversations currently visible in the page sidebar |
| `/cd 1` | Select an entry from the latest list |
| `/cd https://chatgpt.com/c/<uuid>` | Select an ordinary ChatGPT conversation URL |
| `/cd <uuid>` | Select a conversation by its web ID |

Numbers refer to the last successful `/list` and survive a restart. `/cd 1` selects that entry locally. If ChatGPT reports a rate limit, the next message waits for the selected conversation for up to ten minutes. Run `/list` once to populate the list. Conversation IDs come from ChatGPT web URLs.

With a personal Dot bound, the bridge starts a ten-minute timer after WeChat confirms delivery of a complete web reply. After ten minutes without another owner message, it selects Dot and sends a single WeChat notice. A command restarts the timer. A new prompt waits for its own delivered reply to start a fresh timer. Dot reminders continue independently.

After an uncertain webpage submission or response, inspect both ChatGPT and WeChat. The original delivery record is retained and never automatically retried; no extra command is needed to unlock later messages. Each new message still requires the selected conversation, a signed-in idle page, and an empty composer. If delivery back to WeChat fails or is uncertain, the complete reply is saved in the data directory's `replies` folder and is not automatically sent again. A timeout may happen after the remote service accepted a message. The bridge does not promise exactly-once delivery across network failures.

## HTML previews

Plain text, blank lines, Markdown, inline code, and non-HTML code blocks remain unchanged. Only complete HTML component ranges are replaced by links. The preview page contains the surrounding text, interactive frames, the complete original reply, and a source download. The untouched reply is also kept in the local `replies` folder.

Pages live in local memory and are reachable through a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). **Anyone holding a page link can read that complete reply; its contents pass through Cloudflare.** Text chat needs no tunnel. Links expire when the computer goes offline, the bridge stops/restarts, or capacity eviction occurs (128 pages, 32 MiB total). Quick Tunnels offer no uptime guarantee and are not permanent hosting.

Original CSS and JavaScript run in sandboxed frames. Parent-page access, API requests, form submissions, and nested frames are restricted. ChatGPT-specific components may require the original conversation. Unavailable previews, incomplete components, or conversion errors fall back to the original text without requesting another GPT answer.

## Troubleshooting

Stop the running bridge with Ctrl+C before running `npm run doctor`. It inspects the installation, local pairing files, and pending state, then opens the dedicated browser to inspect the page. It sends no messages and does not establish that the WeChat credentials are still valid on the server. It does not replace a real round-trip test.

| Problem | Next step |
| --- | --- |
| Chromium is missing | Run `npm run browser:install` |
| Login, verification, or missing composer | Complete the normal flow in the dedicated browser, then restart |
| An unsent draft is present | Handle the draft yourself; the bridge will not overwrite it |
| A conversation is missing from `/list` | Use `/cd` with its ordinary ChatGPT URL |
| QR code expires | Run `npm run setup` again and use a new code |
| WeChat rejects a reply | Send the bot a fresh WeChat message to refresh reply context; report the sanitized error if it persists |
| Submission or reply is uncertain | Inspect the webpage and avoid repeating the original message. Send fresh messages once the page is idle and its composer is empty |
| Another instance owns the data directory | Stop that instance first. If its process has exited but the lock remains, run `npm run unlock`; it only clears locks whose recorded process no longer exists |
| HTML arrives as source | Check the terminal preview status. Run setup if the program is missing; an unavailable tunnel or incomplete component falls back to the original |
| An old preview link is unavailable | Keep the computer and bridge running. Restart/eviction invalidates old pages; retrieve the original from ChatGPT or the local `replies` folder |

There is no captcha bypass or workaround for platform access restrictions. If your normal browser cannot reach ChatGPT, resolve that first.

## Local data and privacy

Data lives in `~/.wechat-chatgpt-bridge`, outside this repository by default. It includes WeChat credentials, the dedicated browser profile, delivery state, and local reply files in `replies`. Pending state can also contain message text. **Do not upload this directory.** It contains private conversations, and browser login state can impersonate an account; see [Playwright's authentication guidance](https://playwright.dev/docs/auth) and [SECURITY.md](SECURITY.md).

To use a custom directory, choose a new or empty dedicated directory. Do not use your home or existing project directory. Pass the same argument to every command:

```sh
npm run setup -- --data-dir ../wechat-chatgpt-data
npm start -- --data-dir ../wechat-chatgpt-data
npm run doctor -- --data-dir ../wechat-chatgpt-data
```

`unlock` accepts the same `--data-dir` argument. Prefer a directory outside the repository. Arbitrary custom directories are not automatically covered by `.gitignore`. Do not delete runtime data to clear uncertain delivery: doing so also removes deduplication records.

## Development

```sh
npm test
npm run test:browser
```

Tests use synthetic data and browser fixtures. They do not need real accounts. See [CONTRIBUTING.md](CONTRIBUTING.md), [acceptance criteria](docs/acceptance.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
