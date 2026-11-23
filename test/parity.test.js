import test from "node:test";
import assert from "node:assert/strict";
import { Bridge, initialState, digest } from "../src/bridge.js";
import { runBridge } from "../src/runtime.js";
import { setTimeout as delay } from "node:timers/promises";

const URL = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const OTHER = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const credentials = {
  botId: "test-bot",
  ownerId: "test-owner",
  token: "SYNTHETIC-TEST-TOKEN",
};
function harness({ selected = URL, state } = {}) {
  let time = 1800000000000;
  const disk = {
    state: structuredClone(
      state || { ...initialState(), selected, defaultSelected: URL },
    ),
    replies: new Map(),
  };
  const store = {
    read: () => structuredClone(disk.state),
    write: (_, v) => {
      disk.state = structuredClone(v);
    },
    saveReply: (id, text) => disk.replies.set(id, text),
  };
  const sends = [],
    posts = [],
    dotPosts = [],
    selectedUrls = [];
  let entries = [],
    dotEntries = [];
  const provider = {
    dotEnabled: true,
    baseline: async () => ({
      status: "ready",
      cursor: "baseline",
      title: "默认标题",
    }),
    select: async (url) => {
      selectedUrls.push(url);
      return { cursor: "baseline", title: "切换标题" };
    },
    list: async () => [{ url: URL, title: "默认标题" }],
    submit: async (text) => {
      posts.push(text);
      return { status: "accepted", message_id: "user-" + posts.length };
    },
    poll: async () => ({ status: "page", entries }),
    dotCall: async (op, input) => {
      if (op === "baseline") return { status: "ready", cursor: "dot-baseline" };
      if (op === "post") {
        dotPosts.push(input.text);
        return { status: "accepted", message_id: "dot-user" };
      }
      return { status: "page", entries: dotEntries };
    },
    close: async () => {},
  };
  const wechat = {
    sendText: async (item) => {
      sends.push(item);
    },
  };
  const make = () =>
    new Bridge({
      store,
      provider,
      wechat,
      credentials,
      since: time - 1000,
      now: () => time,
    });
  const bridge = make();
  const ingest = async (text, id = String(time)) =>
    bridge.ingest({
      get_updates_buf: "cursor",
      msgs: [
        {
          message_id: id,
          from_user_id: credentials.ownerId,
          to_user_id: credentials.botId,
          message_type: 1,
          message_state: 2,
          create_time_ms: time,
          context_token: "SYNTHETIC-CONTEXT",
          item_list: [{ type: 1, text_item: { text } }],
        },
      ],
    });
  return {
    bridge,
    provider,
    wechat,
    disk,
    store,
    sends,
    posts,
    dotPosts,
    selectedUrls,
    make,
    ingest,
    advance: (n) => {
      time += n;
    },
    entries: (e) => {
      entries = e;
    },
    dotEntries: (e) => {
      dotEntries = e;
    },
  };
}
test("default GPT shortcut persists; same-target cd preserves baseline; optional Dot input routes only when selected", async () => {
  const f = harness();
  await f.bridge.initialize();
  const watch = structuredClone(f.bridge.state.watch);
  assert.match(
    await f.bridge.command({ name: "switch", argument: "gpt" }),
    /已在/,
  );
  assert.deepEqual(f.bridge.state.watch, watch);
  assert.deepEqual(f.selectedUrls, []);
  await f.bridge.command({ name: "switch", argument: "dot" });
  await f.ingest("给 Dot", "1");
  await f.bridge.drain();
  assert.deepEqual(f.dotPosts, ["给 Dot"]);
  assert.deepEqual(f.posts, []);
  await f.bridge.command({ name: "switch", argument: "gpt" });
  await f.ingest("给 GPT", "2");
  await f.bridge.drain();
  assert.deepEqual(f.posts, ["给 GPT"]);
  assert.equal(f.dotPosts.length, 1);
  assert.equal(f.make().state.defaultSelected, URL);
  assert.match(await f.bridge.command({ name: "where" }), /切换标题/);
  assert.match(await f.bridge.command({ name: "help" }), /\/cd dot/);
});
test("Dot alias without a binding refuses without rerouting or submitting text", async () => {
  const f = harness();
  f.provider.dotEnabled = false;
  assert.match(
    await f.bridge.command({ name: "switch", argument: "dot" }),
    /尚未配置/,
  );
  assert.equal(f.bridge.state.selected, URL);
  assert.equal(f.posts.length, 0);
});
test("busy GPT queues FIFO, sends one waiting notice and expires unsubmitted messages after ten minutes", async () => {
  const f = harness();
  let attempts = 0;
  f.provider.submit = async () => {
    attempts++;
    return { status: "not_dispatched", reason: "busy", retry_after: 60 };
  };
  await f.ingest("first", "1");
  await f.ingest("second", "2");
  await f.bridge.drain();
  assert.equal(attempts, 1);
  assert.equal(f.sends.length, 1);
  f.advance(59000);
  await f.bridge.drain();
  assert.equal(attempts, 1);
  f.advance(2000);
  await f.bridge.drain();
  assert.equal(attempts, 2);
  assert.equal(f.sends.length, 1);
  f.advance(600000);
  await f.bridge.drain();
  assert.equal(attempts, 2);
  assert.equal(f.sends.length, 3);
  assert.ok(f.sends.slice(1).every((s) => s.text.includes("未提交")));
});
test("known unsent messages cannot migrate silently to a newly selected conversation", async () => {
  const f = harness();
  f.provider.submit = async () => ({ status: "not_dispatched" });
  await f.ingest("stay in old target", "1");
  await f.bridge.drain();
  await f.bridge.command({ name: "switch", argument: OTHER });
  f.advance(13000);
  await f.bridge.drain();
  assert.match(f.sends.at(-1).text, /没有转发到新入口/);
  assert.equal(f.posts.length, 0);
});
test("cached cd waits out a shared 429, then submits the first text only to the selected URL", async () => {
  const f = harness();
  await f.bridge.initialize();
  let listCalls = 0;
  f.provider.list = async () => {
    listCalls++;
    return [{ url: OTHER, title: "Cached title" }];
  };
  await f.bridge.command({ name: "list" });
  f.bridge.noteWebLimit({ http_status: 429, retry_after: 75 });
  assert.match(await f.bridge.command({ name: "list" }), /上次列表/);
  assert.match(
    await f.bridge.command({ name: "switch", argument: "1" }),
    /Cached title/,
  );
  assert.equal(listCalls, 1);
  assert.deepEqual(f.selectedUrls, []);
  const posts = [];
  f.provider.submit = async (text, { expectedUrl }) => {
    posts.push([text, expectedUrl]);
    return { status: "accepted", message_id: "user-1" };
  };
  await f.ingest("first", "1");
  await f.bridge.drain();
  await f.bridge.pollWeb();
  assert.deepEqual(posts, []);
  assert.deepEqual(f.selectedUrls, []);
  const restarted = f.make();
  await restarted.initialize();
  f.advance(75001);
  await restarted.drain();
  await restarted.drain();
  assert.deepEqual(posts, [["first", OTHER]]);
  assert.equal(restarted.state.listed[0].title, "Cached title");
});

test("a restarted rate-limited watcher resumes its saved cursor after cooldown", async () => {
  const f = harness();
  await f.bridge.initialize();
  f.bridge.state.watch.cursor = "last-delivered";
  f.bridge.noteWebLimit({ http_status: 429, retry_after: 70 });
  const resumed = f.make();
  await resumed.initialize();
  assert.equal(resumed.state.watch.deferred, true);
  await resumed.pollWeb();
  assert.deepEqual(f.selectedUrls, []);
  f.advance(70001);
  await resumed.pollWeb();
  assert.deepEqual(f.selectedUrls, [URL]);
  assert.equal(resumed.state.watch.cursor, "last-delivered");
});

test("confirmed final delivery starts a durable ten-minute return with a single WeChat notice", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("question", "1");
  await f.bridge.drain();
  f.entries([
    {
      id: "final",
      user_id: "user-1",
      text: "complete reply",
      finished_turn: true,
    },
  ]);
  await f.bridge.pollWeb();
  assert.equal(f.bridge.status().autoDotInSeconds, null);
  await f.bridge.flushOutgoing();
  assert.equal(f.bridge.status().autoDotInSeconds, 600);
  f.dotEntries([{ id: "independent", text: "Dot reminder" }]);
  await f.bridge.pollDot();
  await f.bridge.flushOutgoing();
  const resumed = f.make();
  await resumed.initialize();
  const poll = async () =>
    resumed.ingest({ msgs: [], get_updates_buf: "cursor" });
  f.advance(599999);
  await poll();
  assert.equal(resumed.state.selected, URL);
  f.advance(1);
  await poll();
  await resumed.flushOutgoing();
  assert.equal(resumed.state.selected, "dot");
  await poll();
  await resumed.flushOutgoing();
  assert.equal(f.sends.filter((m) => m.text.includes("已自动切回")).length, 1);
  assert.equal(
    f.sends.filter((m) => m.text === "【Dot】\nDot reminder").length,
    1,
  );
});

test("owner input at the deadline takes priority, and a failed WeChat send cannot arm a timer", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("first", "1");
  await f.bridge.drain();
  f.entries([
    { id: "final", user_id: "user-1", text: "reply", finished_turn: true },
  ]);
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  f.advance(600000);
  await f.ingest("/where", "2");
  await f.bridge.drain();
  assert.equal(f.bridge.status().autoDotInSeconds, 600);
  await f.ingest("next", "3");
  await f.bridge.drain();
  assert.equal(f.bridge.status().autoDotInSeconds, null);
  f.entries([
    {
      id: "second",
      user_id: "user-2",
      text: "other reply",
      finished_turn: true,
    },
  ]);
  await f.bridge.pollWeb();
  f.wechat.sendText = async () => {
    throw new Error("indeterminate");
  };
  await f.bridge.flushOutgoing();
  f.advance(601000);
  await f.bridge.ingest({ msgs: [], get_updates_buf: "same" });
  assert.equal(f.bridge.status().autoDotInSeconds, null);
  assert.equal(f.bridge.state.selected, URL);
});

test("pending GPT prevents switching while Dot reminders continue independently and exactly once", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("waiting", "1");
  await f.bridge.drain();
  assert.match(
    await f.bridge.command({ name: "switch", argument: "dot" }),
    /暂不能切换/,
  );
  f.dotEntries([{ id: "reminder-1", text: "主动提醒\n\n原文  " }]);
  await f.bridge.pollDot();
  await f.bridge.flushOutgoing();
  assert.equal(f.sends.at(-1).text, "【Dot】\n主动提醒\n\n原文  ");
  f.advance(7000);
  await f.bridge.pollDot();
  await f.bridge.flushOutgoing();
  assert.equal(f.sends.length, 1);
  f.entries([
    { id: "answer-1", user_id: "user-1", text: "完成", finished_turn: true },
  ]);
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  assert.equal(f.sends.at(-1).text, "完成");
  assert.equal(f.bridge.webPending(), undefined);
  assert.match(
    await f.bridge.command({ name: "switch", argument: "dot" }),
    /已切换/,
  );
});
test("confirmation retries only reads, correlates the exact user receipt, and sends the eventual answer", async () => {
  const f = harness();
  await f.bridge.initialize();
  let writes = 0,
    reads = 0;
  f.provider.submit = async () => {
    writes++;
    return { status: "confirming", receipt: { hash: "synthetic" } };
  };
  f.provider.poll = async ({ receipt }) => {
    reads++;
    assert.ok(receipt);
    return reads === 1
      ? { status: "unavailable", retry_after: 60 }
      : {
          status: "page",
          confirmation: { status: "accepted", message_id: "confirmed-user" },
          entries: [
            {
              id: "late-final",
              user_id: "confirmed-user",
              text: "晚到但完整",
              finished_turn: true,
            },
          ],
        };
  };
  await f.ingest("one write", "1");
  await f.bridge.drain();
  await f.bridge.pollWeb();
  f.advance(61000);
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(f.sends[0].text, "晚到但完整");
  assert.equal(f.bridge.webPending(), undefined);
});
test("confirmation deadline expires even during network backoff; old writes never repeat", async () => {
  const f = harness();
  await f.bridge.initialize();
  let writes = 0;
  f.provider.submit = async () => {
    writes++;
    return { status: "confirming", receipt: { hash: "synthetic" } };
  };
  f.provider.poll = async () => ({ status: "unavailable", retry_after: 180 });
  await f.ingest("uncertain", "1");
  await f.bridge.drain();
  await f.bridge.pollWeb();
  f.advance(91000);
  await f.bridge.drain();
  assert.equal(f.bridge.webPending(), undefined);
  assert.equal(writes, 1);
  assert.match(f.sends[0].text, /暂未确认/);
  await f.make().drain();
  assert.equal(writes, 1);
});
test("restart resumes accepted native outbox reads without posting or resetting its cursor", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("one", "1");
  await f.bridge.drain();
  f.provider.baseline = async () => {
    throw new Error("must retain the pending cursor");
  };
  const next = f.make();
  await next.initialize();
  assert.equal(next.state.watch.cursor, "baseline");
  f.entries([
    {
      id: "answer",
      user_id: "user-1",
      text: "重启后收到",
      finished_turn: true,
    },
  ]);
  await next.pollWeb();
  await next.flushOutgoing();
  await next.drain();
  assert.equal(f.posts.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, "重启后收到");
});
test("restart preserves a confirming receipt and reads a reply completed before restart", async () => {
  const f = harness();
  await f.bridge.initialize();
  let writes = 0;
  f.provider.submit = async () => {
    writes++;
    return { status: "confirming", receipt: { hash: "synthetic" } };
  };
  await f.ingest("acknowledgement lost", "1");
  await f.bridge.drain();
  const watch = structuredClone(f.bridge.state.watch);
  f.advance(10000);
  f.provider.baseline = async () => {
    throw new Error("must retain the confirmation cursor");
  };
  f.provider.poll = async ({ cursor, openedAt, receipt }) => {
    assert.equal(cursor, watch.cursor);
    assert.equal(openedAt, watch.openedAt);
    assert.deepEqual(receipt, { hash: "synthetic" });
    return {
      status: "page",
      confirmation: { status: "accepted", message_id: "confirmed-user" },
      entries: [
        {
          id: "completed-before-restart",
          user_id: "confirmed-user",
          text: "重启前已经完成的回复",
          finished_turn: true,
        },
      ],
    };
  };
  const next = f.make();
  await next.initialize();
  await next.pollWeb();
  await next.flushOutgoing();
  await next.drain();
  assert.equal(writes, 1);
  assert.equal(next.webPending(), undefined);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, "重启前已经完成的回复");
});
test("outbox WeChat uncertainty survives restart and duplicate pages without re-sending", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("/where", "1");
  await f.bridge.drain();
  let attempts = 0;
  f.wechat.sendText = async () => {
    attempts++;
    throw new Error("timeout");
  };
  f.dotEntries([{ id: "same", text: "do not repeat" }]);
  await f.bridge.pollDot();
  await f.bridge.flushOutgoing();
  const next = f.make();
  await next.initialize();
  await next.pollDot();
  await next.flushOutgoing();
  assert.equal(attempts, 1);
  assert.ok([...f.disk.replies.values()].includes("【Dot】\ndo not repeat"));
});
test("an old web poll completing after cd cannot forward another conversation or move its cursor", async () => {
  const f = harness();
  await f.bridge.initialize();
  let release;
  f.provider.poll = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const old = f.bridge.pollWeb();
  await f.bridge.command({ name: "switch", argument: OTHER });
  release({
    status: "page",
    entries: [{ id: "old-answer", text: "wrong target", finished_turn: true }],
  });
  await old;
  await f.bridge.flushOutgoing();
  assert.equal(f.bridge.state.watch.url, OTHER);
  assert.equal(f.bridge.state.watch.cursor, "baseline");
  assert.equal(f.sends.length, 0);
});
test("long browser send does not block help, and switch is refused during submission", async () => {
  const f = harness();
  delete f.provider.submit;
  let finish;
  f.provider.send = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await f.ingest("slow", "1");
  await f.bridge.drain({ wait: false });
  await f.ingest("/help", "2");
  await f.ingest("/cd " + OTHER, "3");
  await f.bridge.drain({ wait: false });
  assert.match(f.sends[0].text, /\/cd gpt/);
  assert.match(f.sends[1].text, /暂不能切换/);
  finish({ text: "answer", url: URL });
  await f.bridge.settle();
  assert.equal(f.sends.at(-1).text, "answer");
});
test("local reminders are owner-only, deduplicated, HTML-aware and available while GPT is pending", async () => {
  const f = harness();
  await f.ingest("wait", "1");
  await f.bridge.drain();
  f.bridge.preview = {
    transform: (_, text) => text.replace("<div>x</div>", "LINK"),
  };
  const input = {
    request_id: "local-1",
    purpose: "reminder",
    text: "keep\n<div>x</div>\nend",
  };
  assert.equal((await f.bridge.notify(input)).status, "sent");
  assert.equal(f.sends[0].text, "keep\nLINK\nend");
  assert.ok([...f.disk.replies.values()].includes(input.text));
  assert.equal((await f.bridge.notify(input)).status, "duplicate_sent");
  assert.equal(f.sends.length, 1);
  assert.equal(
    (await f.bridge.notify({ ...input, to: "someone" })).status,
    "rejected",
  );
  assert.equal(
    (
      await f.bridge.notify({
        ...input,
        request_id: "local-2",
        text: credentials.token,
      })
    ).status,
    "rejected",
  );
});
test("owner context is login-bound without inventing a Tencent TTL; expired login blocks notifications", async () => {
  const f = harness();
  assert.equal(
    (await f.bridge.notify({ request_id: "1", purpose: "test", text: "test" }))
      .status,
    "not_ready",
  );
  await f.ingest("/help", "1");
  f.advance(86400001);
  assert.equal(
    (await f.bridge.notify({ request_id: "2", purpose: "test", text: "test" }))
      .status,
    "sent",
  );
  f.bridge.state.ownerContext.blocked = true;
  assert.equal(
    (await f.bridge.notify({ request_id: "3", purpose: "test", text: "test" }))
      .status,
    "not_ready",
  );
  f.bridge.state.ownerContext.blocked = false;
  f.bridge.sessionBinding = "changed-login";
  assert.equal(
    (await f.bridge.notify({ request_id: "4", purpose: "test", text: "test" }))
      .status,
    "not_ready",
  );
  assert.equal(f.sends.length, 1);
});
test("Dot uncertain write pauses further Dot input but does not disable reminders or web switching", async () => {
  const f = harness({ selected: "dot" });
  await f.bridge.initialize();
  let writes = 0;
  const original = f.provider.dotCall;
  f.provider.dotCall = async (op, input) =>
    op === "post" ? (writes++, { status: "uncertain" }) : original(op, input);
  await f.ingest("first", "1");
  await f.bridge.drain();
  await f.ingest("second", "2");
  await f.bridge.drain();
  assert.equal(writes, 1);
  f.dotEntries([{ id: "still-notify", text: "仍然提醒" }]);
  await f.bridge.pollDot();
  await f.bridge.flushOutgoing();
  assert.match(f.sends.at(-1).text, /仍然提醒/);
  assert.match(
    await f.bridge.command({ name: "switch", argument: "gpt" }),
    /已切换/,
  );
});
test("long WeChat receive cannot block outbox lanes; stop waits for all lanes", async () => {
  const f = harness();
  const abort = new AbortController();
  f.bridge.signal = abort.signal;
  let web = 0,
    dot = 0;
  f.bridge.pollWeb = async () => {
    web++;
  };
  f.bridge.pollDot = async () => {
    dot++;
  };
  const client = {
    getUpdates: async (_, { signal }) => {
      await delay(60000, undefined, { signal });
      return { msgs: [], get_updates_buf: "" };
    },
  };
  const running = runBridge({ bridge: f.bridge, client, abort, interval: 5 });
  await delay(40);
  assert.ok(web >= 2);
  assert.ok(dot >= 2);
  abort.abort();
  await running;
});
test("storage failure stops an outbox before advancing its checkpoint", async () => {
  const f = harness();
  await f.bridge.initialize();
  f.dotEntries([{ id: "new", text: "retain" }]);
  f.store.write = () => {
    throw new Error("disk full");
  };
  await assert.rejects(f.bridge.pollDot(), /disk full/);
  assert.equal(f.bridge.dotWatch.cursor, "dot-baseline");
  assert.equal(f.sends.length, 0);
});
test("full ledger rejects new input before side effects and keeps prior deduplication records", async () => {
  const f = harness();
  for (let i = 0; i < 10000; i++)
    f.bridge.state.records[digest(String(i))] = { status: "done" };
  await assert.rejects(f.ingest("new", "new"), /ledger_capacity_reached/);
  assert.equal(f.posts.length, 0);
  assert.equal(Object.keys(f.bridge.state.records).length, 10000);
});

test("a completed web turn without text ends pending state and sends one clear notice", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("image only", "1");
  await f.bridge.drain();
  f.entries([
    { id: "empty-final", user_id: "user-1", text: null, finished_turn: true },
  ]);
  await f.bridge.pollWeb();
  assert.equal(f.bridge.webPending(), undefined);
  assert.match(f.sends[0].text, /没有可回传的文字/);
  f.advance(31000);
  await f.bridge.pollWeb();
  assert.equal(f.sends.length, 1);
});
test("a completed pending turn behind the cursor is delivered once and unblocks cd without rewinding", async () => {
  const f = harness();
  await f.bridge.initialize();
  await f.ingest("prompt", "1");
  await f.bridge.drain();
  f.bridge.state.watch.cursor = "later-hidden-node";
  const completed = {
    id: "final",
    user_id: "user-1",
    text: "complete",
    finished_turn: true,
  };
  f.provider.poll = async ({ pendingUserId }) => ({
    status: "page",
    entries: [],
    ...(pendingUserId ? { completed } : {}),
  });
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  assert.equal(f.bridge.webPending(), undefined);
  assert.equal(f.bridge.state.watch.cursor, "later-hidden-node");
  assert.equal(f.sends.length, 1);
  f.advance(31000);
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  assert.equal(f.sends.length, 1);
  assert.match(
    await f.bridge.command({ name: "switch", argument: OTHER }),
    /已切换/,
  );
  assert.equal(f.posts.length, 1);
});
test("a final read before send acknowledgement clears later pending state without a second WeChat send", async () => {
  const f = harness();
  await f.bridge.initialize();
  let acknowledge;
  f.provider.submit = () =>
    new Promise((resolve) => {
      acknowledge = resolve;
    });
  const completed = {
    id: "fast-final",
    user_id: "fast-user",
    text: "already received",
    finished_turn: true,
  };
  f.provider.poll = async ({ pendingUserId }) =>
    pendingUserId
      ? { status: "page", entries: [], completed }
      : { status: "page", entries: [completed] };
  await f.ingest("fast reply", "1");
  await f.bridge.drain({ wait: false });
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  assert.equal(f.sends.length, 1);
  acknowledge({ status: "accepted", message_id: "fast-user" });
  await f.bridge.settle();
  assert.ok(f.bridge.webPending());
  await f.bridge.pollWeb();
  await f.bridge.flushOutgoing();
  assert.equal(f.bridge.webPending(), undefined);
  assert.equal(f.sends.length, 1);
  assert.match(
    await f.bridge.command({ name: "switch", argument: "dot" }),
    /已切换/,
  );
});
