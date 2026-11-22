import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { ChatGPTBrowser } from "../src/chatgpt-browser.js";

const URL = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
let browser;
const fixture = await readFile(
  new globalThis.URL("./fixtures/chatgpt.html", import.meta.url),
  "utf8",
);
const currentFixture = await readFile(
  new globalThis.URL("./fixtures/current-chatgpt.html", import.meta.url),
  "utf8",
);
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function harness(
  t,
  { mode = "normal", url = URL, timeoutMs = 1800, body = fixture } = {},
) {
  // Offline is a second barrier: redirects must never escape the fixture route.
  const context = await browser.newContext({
    offline: true,
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) =>
    route.request().isNavigationRequest() &&
    new globalThis.URL(route.request().url()).origin === "https://chatgpt.com"
      ? route.fulfill({ contentType: "text/html", body })
      : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate((mode) => {
    window.fixtureMode = mode;
  }, mode);
  const provider = new ChatGPTBrowser({
    profileDir: "/unused-fixture-profile",
    timeoutMs,
  });
  provider.context = context;
  provider.page = page;
  t.after(() => provider.close());
  return { provider, page };
}

test("current web markup submits once and preserves Copy source bytes without reading or changing OS clipboard", async (t) => {
  const { provider, page } = await harness(t, { body: currentFixture });
  assert.equal((await provider.inspect()).ready, true);
  assert.equal((await provider.list()).length, 1);
  const result = await provider.send("新版界面正文");
  assert.equal(result.text, await page.evaluate(() => window.originalSource));
  assert.equal(result.messageId, "44444444-4444-4444-8444-444444444444");
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
  assert.equal(await page.evaluate(() => window.osWrites), 0);
  assert.equal(await page.locator("[data-wechat-copy]").count(), 0);
  assert.equal((await provider.inspect()).ready, true); // A rendered login example is not the site login page.
  await page.evaluate(() => navigator.clipboard.writeText("manual after test"));
  assert.equal(await page.evaluate(() => window.osWrites), 1);
  await page.evaluate(() =>
    document
      .querySelector("[data-talvt-turn-state]")
      .setAttribute("data-talvt-turn-state", "streaming"),
  );
  await assert.rejects(
    provider.send("while busy"),
    (error) => error.code === "busy" && !error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test("independent browser outbox forwards a late final after send timeout without another click", async (t) => {
  const { provider, page } = await harness(t, { mode: "slow", timeoutMs: 150 });
  const baseline = await provider.baseline();
  await assert.rejects(provider.send("late"), (e) => e.uncertain);
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="stop-button"]'),
  );
  let result = await provider.poll({ url: URL, cursor: baseline.cursor });
  const cursor = result.entries.at(-1)?.id || baseline.cursor;
  await page.waitForTimeout(550);
  result = await provider.poll({ url: URL, cursor });
  assert.equal(result.entries.filter((e) => e.text).length, 1);
  assert.match(result.entries.at(-1).text, /Final/);
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test("renders only a new completed answer and preserves HTML code fences", async (t) => {
  const { provider, page } = await harness(t);
  const submitted = [];
  const result = await provider.send("Hello\nsecond line", {
    onSubmitted: (receipt) => submitted.push(receipt),
  });
  assert.equal(result.url, URL);
  assert.equal(
    result.text,
    "Final **answer**.\n\n```html\n<div>Original component</div>\n```\n\nAfter code.",
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
  assert.deepEqual(submitted, [{ url: URL, messageId: "new-user-1" }]);
});

test("inspect and list use visible rendered UI only", async (t) => {
  const { provider } = await harness(t);
  assert.deepEqual(await provider.inspect(), {
    url: URL,
    title: "Fixture conversation - ChatGPT",
    ready: true,
    busy: false,
  });
  assert.deepEqual(await provider.list(), [
    { url: URL, title: "Fixture conversation" },
  ]);
});

test("refuses an existing draft without clicking or overwriting it", async (t) => {
  const { provider, page } = await harness(t);
  await page.locator("#prompt-textarea").fill("My unfinished draft");
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "draft_present" && !error.uncertain,
  );
  assert.equal(
    await page.locator("#prompt-textarea").innerText(),
    "My unfinished draft",
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
});

test("single flight refuses concurrent sends and switches", async (t) => {
  const { provider, page } = await harness(t, { mode: "slow" });
  const pending = provider.send("Hello");
  await assert.rejects(
    provider.send("Second"),
    (error) => error.code === "busy" && !error.uncertain,
  );
  await assert.rejects(provider.select(URL), (error) => error.code === "busy");
  await pending;
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test("never returns a streaming partial answer on timeout", async (t) => {
  const { provider, page } = await harness(t, {
    mode: "partial",
    timeoutMs: 350,
  });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "response_timeout" && error.uncertain,
  );
  await assert.rejects(
    provider.send("Next"),
    (error) => error.code === "busy" && !error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test("no exact new user marker is uncertain and never retried", async (t) => {
  const { provider, page } = await harness(t, {
    mode: "no-user",
    timeoutMs: 350,
  });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "submission_uncertain" && error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test("duplicate exact new user turns remain uncertain", async (t) => {
  const { provider, page } = await harness(t, { mode: "duplicate" });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "submission_uncertain" && error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 1);
});

test("navigation during the response cannot return another conversation", async (t) => {
  const { provider } = await harness(t, { mode: "navigate" });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "navigation_changed" && error.uncertain,
  );
});

test("homepage cannot receive a prompt or create a conversation implicitly", async (t) => {
  const { provider, page } = await harness(t, { url: "https://chatgpt.com/" });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "invalid_url" && !error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
  assert.equal(await page.locator("#prompt-textarea").innerText(), "");
});

test("stopped response with copy controls is not a completed answer", async (t) => {
  const { provider } = await harness(t, { mode: "stopped" });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "response_incomplete" && error.uncertain,
  );
});

test("reasoning markup is not returned even when copy controls appear", async (t) => {
  const { provider } = await harness(t, { mode: "reasoning", timeoutMs: 350 });
  await assert.rejects(
    provider.send("Hello"),
    (error) => error.code === "response_timeout" && error.uncertain,
  );
});

test("user stop action fails closed even without a stopped status attribute", async (t) => {
  const { provider, page } = await harness(t, { mode: "partial" });
  const pending = provider.send("Hello");
  const rejection = assert.rejects(
    pending,
    (error) => error.code === "response_incomplete" && error.uncertain,
  );
  await page.locator('[data-testid="stop-button"]').click();
  await rejection;
});

test("external destinations are refused before navigation", async (t) => {
  const { provider } = await harness(t);
  await assert.rejects(
    provider.select(
      "https://example.com/c/11111111-1111-4111-8111-111111111111",
    ),
    (error) => error.code === "invalid_url",
  );
  await assert.rejects(
    provider.select(
      "https://chatgpt.com.evil.example/c/11111111-1111-4111-8111-111111111111",
    ),
    (error) => error.code === "invalid_url",
  );
  await assert.rejects(
    provider.select(URL + "?redirect=elsewhere"),
    (error) => error.code === "invalid_url",
  );
  assert.equal(provider.page.url(), URL);
});

test("conversation selection rejects the new-chat page", async (t) => {
  const { provider } = await harness(t);
  await assert.rejects(
    provider.select("https://chatgpt.com/"),
    (error) => error.code === "invalid_url",
  );
  assert.equal(provider.page.url(), URL);
});

test("manual drafts and active generation block navigation", async (t) => {
  const { provider, page } = await harness(t);
  await page.locator("#prompt-textarea").fill("Draft");
  await assert.rejects(
    provider.select(
      "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    ),
    (error) => error.code === "draft_present",
  );
  await page.locator("#prompt-textarea").fill("");
  await page.evaluate(() => {
    const stop = document.createElement("button");
    stop.dataset.testid = "stop-button";
    stop.textContent = "Stop";
    document.body.append(stop);
  });
  await assert.rejects(
    provider.select(
      "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    ),
    (error) => error.code === "busy",
  );
  assert.equal(page.url(), URL);
});

test("expected URL prevents manual tab switch from rerouting a message", async (t) => {
  const { provider, page } = await harness(t);
  await assert.rejects(
    provider.send("Hello", {
      expectedUrl: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    }),
    (error) => error.code === "navigation_changed" && !error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
  assert.equal(await page.locator("#prompt-textarea").innerText(), "");
});

test("literal repeated and trailing blank lines within code remain intact", async (t) => {
  const { provider } = await harness(t, { mode: "code-whitespace" });
  const result = await provider.send("Hello");
  assert.equal(
    result.text,
    "Final **answer**.\n\n```html\n<div>One</div>\n\n\n<div>Two</div>\n\n```\n\nAfter code.",
  );
});

test("setup keeps the browser open after an authentication redirect", async (t) => {
  const { provider, page } = await harness(t);
  await provider.context.route("https://chatgpt.com/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><script>location.replace("https://auth.openai.com/log-in")</script></html>',
    }),
  );
  await provider.context.route("https://auth.openai.com/log-in", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body><button>Log in</button></body></html>",
    }),
  );
  const state = await provider.open();
  assert.equal(state.ready, false);
  assert.equal(state.reason, "invalid_url");
  assert.equal(page.isClosed(), false);
  assert.equal(page.url(), "https://auth.openai.com/log-in");
  await assert.rejects(
    provider.send("Do not fill login page"),
    (error) => error.code === "invalid_url",
  );
});

test("inspect reports existing draft as not ready", async (t) => {
  const { provider, page } = await harness(t);
  await page.locator("#prompt-textarea").fill("Draft");
  const state = await provider.inspect();
  assert.equal(state.ready, false);
  assert.equal(state.reason, "draft_present");
});

test("same-URL page reload during a send becomes uncertain", async (t) => {
  const { provider, page } = await harness(t, { mode: "partial" });
  const pending = provider.send("Hello");
  const rejection = assert.rejects(
    pending,
    (error) => error.uncertain && error.code === "navigation_changed",
  );
  await page.locator('[data-testid="stop-button"]').waitFor();
  await page.reload();
  await rejection;
});

test("logged-out composer is not accepted as a signed-in ready page", async (t) => {
  const { provider, page } = await harness(t);
  await page.evaluate(() => {
    const header = document.createElement("header");
    header.innerHTML = "<button>Log in</button>";
    document.body.prepend(header);
  });
  const state = await provider.inspect();
  assert.equal(state.ready, false);
  assert.equal(state.reason, "login_required");
  await assert.rejects(
    provider.send("Do not send as guest"),
    (error) => error.code === "not_ready" && !error.uncertain,
  );
  assert.equal(await page.evaluate(() => window.sendClicks), 0);
});

test("browser requires a dedicated profile", () => {
  assert.throws(
    () => new ChatGPTBrowser(),
    (error) => error.code === "profile_required",
  );
  assert.throws(
    () => new ChatGPTBrowser({ profileDir: " " }),
    (error) => error.code === "profile_required",
  );
});

test("legacy execCommand copy fallback cannot change the OS clipboard", async (t) => {
  const { provider, page } = await harness(t, { body: currentFixture });
  await page.evaluate(() => {
    document.execCommand = () => {
      window.osWrites++;
      return true;
    };
    window.realExec = document.execCommand;
    const original = document.querySelector(
      'button[aria-label="发送"]',
    ).onclick;
    document.querySelector('button[aria-label="发送"]').onclick = () => {
      original();
      document.querySelector('button[aria-label="复制"]').onclick = () =>
        document.execCommand("copy");
    };
  });
  const result = await provider.send("fallback");
  assert.equal(result.text, "Rendered visible fallback");
  assert.equal(await page.evaluate(() => window.osWrites), 0);
  assert.equal(
    await page.evaluate(() => document.execCommand === window.realExec),
    true,
  );
});
