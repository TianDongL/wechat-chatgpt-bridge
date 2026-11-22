import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NativeProvider,
  recentContext,
  resolveCodex,
} from "../src/native-provider.js";
import web from "../src/native/web_chat_transport.cjs";
import dot from "../src/native/dot.cjs";
import { digest } from "../src/bridge.js";

const target = "11111111-1111-4111-8111-111111111111",
  origin = "22222222-2222-4222-8222-222222222222";
const user = "33333333-3333-4333-8333-333333333333",
  answer = "44444444-4444-4444-8444-444444444444";
const input = {
  operation: "post",
  target,
  origin_thread: origin,
  request_id: origin,
  text: "exact prompt",
};
const response = (data) => ({
  success: true,
  contentItems: [{ type: "inputText", text: JSON.stringify(data) }],
});
const chat = () => ({
  conversation_id: target,
  current_node: "root",
  mapping: { root: { id: "root", parent: null } },
});
const message = (id, role, text, parent, time = 1800000000, extra = {}) => ({
  id,
  parent,
  message: {
    author: { role },
    create_time: time,
    content: { content_type: "text", parts: [text] },
    status: "finished_successfully",
    end_turn: true,
    ...extra,
  },
});
function webFixture({
  busy = false,
  ackLost = false,
  readbackLost = false,
} = {}) {
  const before = chat(),
    after = chat();
  after.mapping[user] = message(user, "user", input.text, "root");
  after.current_node = user;
  let reads = 0,
    writes = 0;
  return {
    counts: () => ({ reads, writes }),
    deps: {
      now: () => 1800000000000,
      connect: async () => async () => {
        reads++;
        if (readbackLost && reads > 1) throw new Error("network");
        return {
          ok: true,
          json: async () => structuredClone(reads === 1 ? before : after),
        };
      },
      callTool: async (name) => {
        if (name === "read_thread")
          return response({
            thread: {
              id: target,
              kind: "chatgpt",
              status: { type: busy ? "running" : "idle" },
            },
          });
        assert.equal(name, "send_message_to_thread");
        writes++;
        if (ackLost) throw new Error("timeout");
        return response({ threadId: target });
      },
    },
  };
}
test("native lost acknowledgement reconciles read-only with one write", async () => {
  const f = webFixture({ ackLost: true });
  const r = await web.run(input, "unused", f.deps);
  assert.deepEqual(r, { status: "accepted", message_id: user });
  assert.deepEqual(f.counts(), { reads: 2, writes: 1 });
});
test("native unreadable post result carries a bounded receipt without re-sending", async () => {
  const f = webFixture({ readbackLost: true });
  const r = await web.run(input, "unused", f.deps);
  assert.equal(r.status, "confirming");
  assert.ok(web.validReceipt(r.receipt));
  assert.equal(f.counts().writes, 1);
  assert.equal(JSON.stringify(r).includes(input.text), false);
});
test("native busy, wrong-kind and preflight throttle never attempt a write", async () => {
  const busy = webFixture({ busy: true });
  assert.equal(
    (await web.run(input, "unused", busy.deps)).status,
    "not_dispatched",
  );
  assert.equal(busy.counts().writes, 0);
  const wrong = webFixture();
  wrong.deps.callTool = async () =>
    response({
      thread: { id: target, kind: "codex", status: { type: "idle" } },
    });
  assert.equal(
    (await web.run(input, "unused", wrong.deps)).status,
    "not_dispatched",
  );
  const rate = webFixture();
  rate.deps.connect = async () => async () => ({
    ok: false,
    status: 429,
    headers: new Headers({ "retry-after": "72" }),
  });
  const limited = await web.run(input, "unused", rate.deps);
  assert.equal(limited.status, "not_dispatched");
  assert.equal(limited.retry_after, 72);
  assert.equal(rate.counts().writes, 0);
});
test("receipt disambiguates old same-text prompts, and refuses two fresh matches", () => {
  const c = chat();
  c.mapping[user] = message(user, "user", input.text, "root", 1700000000);
  const receipt = web.makeReceipt(c, input.text, 1800000000000);
  assert.equal(web.confirmReceipt(c, receipt).status, "pending");
  c.mapping[answer] = message(answer, "user", input.text, user);
  assert.equal(web.confirmReceipt(c, receipt).message_id, answer);
  c.mapping[origin] = message(origin, "user", input.text, answer);
  assert.equal(web.confirmReceipt(c, receipt).status, "ambiguous");
});
test("native outbox excludes old history, reasoning, tool-directed and hidden responses", () => {
  const c = chat();
  let parent = "root";
  const add = (id, role, text, extra = {}) => {
    c.mapping[id] = message(id, role, text, parent, 1800000000, extra);
    parent = id;
  };
  add(user, "user", "prompt");
  add("analysis", "assistant", "secret reasoning", { channel: "analysis" });
  add("tool", "assistant", "tool result", { recipient: "tool" });
  add("hidden", "assistant", "hidden", {
    metadata: { is_visually_hidden_from_conversation: true },
  });
  add(answer, "assistant", "exact\r\n\n<div>HTML</div>  ", {
    channel: "final",
  });
  c.current_node = answer;
  const r = web.outgoingPage(c, "root", 1799999999000);
  assert.deepEqual(
    r.entries.filter((e) => e.text).map((e) => e.text),
    ["exact\r\n\n<div>HTML</div>  "],
  );
  assert.equal(r.entries.at(-1).user_id, user);
  assert.equal(
    web.outgoingPage(c, "root", 1800000001000).entries.filter((e) => e.text)
      .length,
    0,
  );
  c.mapping[answer].message.status = "in_progress";
  assert.equal(
    web.outgoingPage(c, "root", 0).entries.some((e) => e.id === answer),
    false,
  );
});
test("native account changes are refused before any API request", async () => {
  const request = async () => {
    throw new Error("must not request");
  };
  request.accountId = "different";
  const provider = new NativeProvider({
    settings: {
      accountHash: digest("original"),
      defaultUrl: "https://chatgpt.com/c/" + target,
    },
    connect: async () => request,
    resolve: () => "/unused",
  });
  await assert.rejects(provider.connection("/unused"), /account_changed/);
});
const identity = {
  dot: "synthetic-dot",
  room: "synthetic-room",
  owner: "synthetic-owner",
  member: "synthetic-bot",
  root: origin,
};
function dotFixture(patch = {}) {
  let writes = 0;
  const request = async (route, options = {}) => {
    if (route === "/tbo/primary")
      return new Response(
        JSON.stringify({
          profile: {
            id: identity.dot,
            messaging_room_id: identity.room,
            active_root_thread_id: origin,
            status: "active",
            aeon_kind: "orbit",
            scope: "personal",
            ...patch.profile,
          },
        }),
      );
    if (route === "/messaging/rooms/" + identity.room)
      return new Response(
        JSON.stringify({
          id: identity.room,
          aeon_id: identity.dot,
          type: "DM",
          app_source: "chatgpt:messaging",
          members: [
            { aeon_id: identity.dot, account_user_id: identity.member },
            { account_user_id: identity.owner },
          ],
          ...patch.room,
        }),
      );
    if (options.body) {
      writes++;
      throw new Error("wire response lost");
    }
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "confirmed",
            request_id: origin,
            account_user_id: identity.owner,
            content: { text: "hello" },
          },
        ],
      }),
    );
  };
  request.userId = identity.owner;
  return { request, writes: () => writes };
}
test("Dot binds a personal DM with exactly the verified owner and bot, refusing shared/foreign rooms", async () => {
  const f = dotFixture();
  assert.deepEqual((await dot.inspectIdentity(f.request)).identity, identity);
  for (const patch of [
    { profile: { scope: "shared" } },
    { room: { type: "GROUP" } },
    {
      room: {
        members: [
          { aeon_id: identity.dot, account_user_id: identity.member },
          { account_user_id: "foreign" },
        ],
      },
    },
  ]) {
    await assert.rejects(dot.inspectIdentity(dotFixture(patch).request));
  }
  assert.equal(dot.sameIdentity({ ...identity, root: target }, identity), true);
  assert.equal(
    dot.sameIdentity({ ...identity, room: "other" }, identity),
    false,
  );
});
test("Dot reconciliation uses owner, request ID and exact text, never a second write", async () => {
  const f = dotFixture();
  const r = await dot.run(f.request, identity, "post", {
    text: "hello",
    requestId: origin,
  });
  assert.equal(r.status, "accepted");
  assert.equal(f.writes(), 1);
  await assert.rejects(
    dot.run(f.request, { ...identity, member: "different" }, "post", {
      text: "hello",
      requestId: origin,
    }),
    /binding_changed/,
  );
  assert.equal(f.writes(), 1);
});
test("Dot outbox includes autonomous final text, but stops at an unfinished generation", () => {
  const entry = (id, who, text, generation) => ({
    id,
    account_user_id: who,
    content: { text },
    created_at: new Date(1800000000000).toISOString(),
    generation,
  });
  const result = dot.outgoingPage(
    [
      entry("owner", identity.owner, "prompt"),
      entry("notice", identity.member, "reminder"),
      entry("stream", identity.member, "partial", { status: "in_progress" }),
      entry("after", identity.member, "skip"),
    ],
    identity.member,
    1799999999000,
  );
  assert.deepEqual(result.entries, [
    { id: "owner", text: null },
    { id: "notice", text: "reminder" },
  ]);
});
test("native setup reads only metadata and resolves installed or uniquely running versions", () => {
  // macOS exposes its temporary directory through /var -> /private/var.
  // Use the real fixture path without relaxing the installer's symlink checks.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-resolution-test-")),
  );
  try {
    const first = path.join(root, "a".repeat(16), "codex.exe"),
      second = path.join(root, "b".repeat(16), "codex.exe");
    for (const file of [first, second]) {
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "synthetic executable, never run");
    }
    assert.equal(resolveCodex(first, { root, platform: "win32" }), first);
    assert.equal(
      resolveCodex(null, { root, platform: "win32", activePaths: [second] }),
      second,
    );
    assert.throws(
      () =>
        resolveCodex(null, {
          root,
          platform: "win32",
          activePaths: [first, second],
        }),
      /ambiguous/,
    );
    assert.throws(
      () => resolveCodex(null, { root, platform: "linux" }),
      /requires_windows/,
    );
    const file = path.join(root, "index.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ id: origin, updated_at: "2026-01-01" }) +
        "\n" +
        JSON.stringify({ id: target, updated_at: "2026-11-22" }) +
        "\n",
    );
    assert.equal(recentContext(file), target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
