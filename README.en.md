# WeChat ChatGPT Bridge

Maintained by [TianDongL](https://github.com/TianDongL). MIT licensed. See the [candidate validation record](docs/validation.md) for the exact tested scope.

Continue your **ChatGPT web conversations from WeChat**. A visible browser on your computer opens ChatGPT; the bridge carries text between that page and your paired WeChat account.

[中文](README.md) · [Architecture](docs/architecture.md) · [Acceptance checklist](docs/acceptance.md) · [Security](SECURITY.md)

**Status: `0.1.0-alpha.1` release candidate.** Intended for early adopters. A clean-machine, new-account WeChat ↔ ChatGPT conversation has not yet been accepted end to end. Automated tests do not establish real account compatibility; see the [verification boundary](docs/acceptance.md).

## Scope

- Text messages from the owner who paired the WeChat bot, with completed text replies sent back to that owner.
- ChatGPT web conversations, including switching by a normal conversation URL.
- A dedicated, visible Chromium profile. Sign in yourself; no cookie copying, OpenAI API key, Codex installation, or public tunnel is required.
- Strict standalone commands and persistent delivery state. Uncertain sends are not automatically retried.

V1 does not support groups, other contacts, images, audio, files, scheduled proactive messages, or HTML component previews. Rich components may produce only their extractable page text. Keep your computer, terminal, and bridge browser running.

This community project is not affiliated with OpenAI or Tencent. The WeChat adapter follows Tencent's [iLink Bot protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md). The ChatGPT adapter automates the visible webpage with Playwright; it is **not an official ChatGPT API**. Page changes, login challenges, and account restrictions can break compatibility.

## Quick start

Download the [source ZIP](https://github.com/TianDongL/wechat-chatgpt-bridge/archive/refs/heads/main.zip), or clone the repository:

```sh
git clone https://github.com/TianDongL/wechat-chatgpt-bridge.git
cd wechat-chatgpt-bridge
```

Optional existing-Chrome mode: on Chrome 144+, enable instance remote debugging at `chrome://inspect/#remote-debugging`, then run `npm run setup -- --browser chrome` and approve Chrome's connection prompt. Debugging can access signed-in browser sessions; allow only trusted local software. The bridge creates and owns a new ChatGPT tab, closes only that tab on exit, and disconnects without closing your existing tabs. Disable remote debugging after testing. This lifecycle is mock-tested; live account acceptance is still pending.

You need Node.js **22.13+**, an account that can use ChatGPT in a browser on this computer, and a WeChat account able to pair through iLink Bot. Windows is the first target; macOS and Linux have not been verified with real accounts.

Download and extract this repository's source ZIP, or clone it, then open a terminal in the project directory:

```sh
npm ci
npm run browser:install
npm run setup
```

Follow the terminal prompts:

1. Sign in to ChatGPT in the dedicated browser opened by setup. Complete any login verification yourself.
2. You may open an existing ordinary ChatGPT conversation or keep the new-chat page. Wait until it is loaded and idle with an empty composer, then press Enter in the terminal.
3. Scan the displayed QR code with WeChat and confirm pairing. Enter a verification code if prompted. Do not run two bridges against the same bot.
4. Start the bridge:

```sh
npm start
```

Wait for the terminal to report that the bridge is running, then send `/help` to the paired bot in WeChat. Send a simple test such as `Reply with only: connected`.

The first connection is successful when all three are observed: WeChat receives the help text; the test message appears in the ChatGPT page; and its completed reply arrives in WeChat. A successful startup message alone does not verify this path.

Press **Ctrl+C** in the bridge terminal to stop. Use `npm start` to run again. Historical incoming messages not received before startup are skipped; pending messages already saved by the bridge are recovered according to their state. V1 does not install a background service or configure startup at login. While bridging, do not manually send messages, navigate, or leave an unsent draft in the dedicated tab.

## Commands

Commands must occupy a single message on one line. `/` and `\` prefixes are accepted. Commands embedded in prose or multi-line text remain ordinary chat text.

Use `/cd` to switch conversations; `/switch` remains a compatible alias. List, current-conversation and selection replies include a `/help` hint.

| Command | Action |
| --- | --- |
| `/help` | Show help |
| `/where` | Show the current ChatGPT web conversation |
| `/list` | Number conversations currently visible in the page sidebar |
| `/cd 1` | Select an entry from the latest list |
| `/cd https://chatgpt.com/c/<uuid>` | Select an ordinary ChatGPT conversation URL |
| `/cd <uuid>` | Select a conversation by its web ID |
| `/new` | Start a new web conversation |
| `/ack` | Clear a local uncertain-delivery pause after you check the page; never resend the original message |

Sidebar results are not your full history. List numbers are temporary; run `/list` again after restarting. Conversation IDs here belong to ChatGPT web URLs, not the API.

After an uncertain webpage submission or response, inspect both ChatGPT and WeChat before using `/ack` to clear the local pause. If delivery back to WeChat fails or is uncertain, the complete reply is saved in the data directory's `replies` folder; `/ack` does not resend it. A timeout may happen after the remote service accepted a message. The bridge does not promise exactly-once delivery across network failures.

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
| Submission or reply is uncertain | Inspect the webpage; do not blindly resend. Use `/ack` after resolving the uncertainty |
| Another instance owns the data directory | Stop that instance first. If its process has exited but the lock remains, run `npm run unlock`; it only clears locks whose recorded process no longer exists |

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
