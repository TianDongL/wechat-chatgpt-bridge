// Same-account ordinary ChatGPT conversations. One client write, followed only
// by read-only confirmation. No credential or message text in diagnostics.
const { connect, selectedBranch } = require("./managed_chatgpt_session.cjs");
const { callTool } = require("./native_app_tools_client.cjs");
const { randomUUID, createHash } = require("node:crypto");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textOf = (n) =>
  (n.message?.content?.parts ?? [])
    .filter((x) => typeof x === "string")
    .join("\n");
const hash = (text) => createHash("sha256").update(text).digest("hex");

function failure(reason, fields = {}) {
  return Object.assign(new Error(reason), { reason, ...fields });
}
function diagnostic(error) {
  return {
    reason: error?.reason ?? "transport_unavailable",
    ...(Number.isInteger(error?.http_status)
      ? { http_status: error.http_status }
      : {}),
    ...(Number.isFinite(error?.retry_after)
      ? { retry_after: error.retry_after }
      : {}),
  };
}
function decode(result) {
  const text = result.contentItems?.find((x) => x.type === "inputText")?.text;
  if (!result.success || !text) {
    if (text?.includes("Too many requests"))
      throw failure("web_chat_http_error", {
        http_status: 429,
        retry_after: 60,
      });
    throw failure("native_tool_unavailable");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw failure("native_tool_invalid_response");
  }
  if (data?.detail === "Too many requests")
    throw failure("web_chat_http_error", { http_status: 429, retry_after: 60 });
  return data;
}
function makeReceipt(before, text, now = Date.now()) {
  return {
    content_hash: hash(text),
    not_before_ms: now - 30000,
    excluded_ids: Object.values(before.mapping)
      .filter((n) => n.message?.author?.role === "user" && textOf(n) === text)
      .map((n) => n.id),
  };
}
function validReceipt(r) {
  return (
    r &&
    /^[0-9a-f]{64}$/.test(r.content_hash ?? "") &&
    Number.isSafeInteger(r.not_before_ms) &&
    Array.isArray(r.excluded_ids) &&
    r.excluded_ids.length <= 100 &&
    r.excluded_ids.every((id) => uuid.test(id))
  );
}
function confirmReceipt(chat, receipt) {
  const excluded = new Set(receipt.excluded_ids);
  // Search this conversation's entire mapping: a branch change must not cause
  // an already submitted message to be sent again. Multiple matches stay ambiguous.
  const matches = Object.values(chat.mapping).filter(
    (n) =>
      !excluded.has(n.id) &&
      n.message?.author?.role === "user" &&
      n.message.create_time * 1000 >= receipt.not_before_ms &&
      hash(textOf(n)) === receipt.content_hash,
  );
  if (matches.length === 1 && uuid.test(matches[0].id))
    return { status: "accepted", message_id: matches[0].id };
  return { status: matches.length > 1 ? "ambiguous" : "pending" };
}
function turnEntry(node, userId, openedAt) {
  const m = node.message;
  const complete =
    m &&
    ["finished_successfully", "finished_error", "cancelled"].includes(
      m.status,
    ) &&
    !(
      m.status === "finished_successfully" && m.metadata?.is_complete === false
    );
  const visible =
    m?.author?.role === "assistant" &&
    (m.channel === "final" || m.channel == null) &&
    (!m.recipient || m.recipient === "all") &&
    m.metadata?.is_visually_hidden_from_conversation !== true &&
    m.create_time * 1000 >= openedAt;
  const final =
    complete &&
    visible &&
    m.status === "finished_successfully" &&
    m.end_turn === true &&
    m.content?.content_type === "text";
  const text = final ? textOf(node) : null;
  return {
    id: node.id,
    user_id: userId,
    text: text?.trim() ? text : null,
    finished_turn: !!(
      complete &&
      visible &&
      (m.end_turn === true ||
        ["finished_error", "cancelled"].includes(m.status)) &&
      !["thoughts", "reasoning_recap"].includes(m.content?.content_type)
    ),
  };
}
function baselineCursor(chat, openedAt) {
  if (openedAt == null) return chat.current_node;
  const branch = selectedBranch(chat);
  const first = branch.findIndex((node) => node.message?.create_time * 1000 >= openedAt);
  return first < 0 ? chat.current_node : (branch[first - 1]?.id ?? "");
}
function outgoingPage(chat, after, openedAt, receipt, pendingUserId) {
  const branch = selectedBranch(chat),
    index = branch.findIndex((n) => n.id === after);
  const entries = [];
  const confirmation = receipt ? confirmReceipt(chat, receipt) : null;
  pendingUserId ??=
    confirmation?.status === "accepted" ? confirmation.message_id : null;
  let pageClosed = false,
    userId = null,
    completed = null;
  for (let i = 0; i < branch.length; i++) {
    const node = branch[i],
      m = node.message;
    if (m?.author?.role === "user") userId = node.id;
    const onPage = i > index && !pageClosed;
    const matches = pendingUserId != null && userId === pendingUserId;
    if (!onPage && !matches) continue;
    const entry = turnEntry(node, userId, openedAt);
    // The requested turn may be behind the cursor or beyond a full or stalled
    // page. Match it on this branch in the same snapshot, without moving the cursor.
    if (matches && entry.finished_turn) completed = entry;
    if (!onPage) continue;
    // An old interrupted stream can remain marked in progress indefinitely.
    // Its creation time already excludes it from this selection's replies.
    const predatesSelection = Number.isFinite(m?.create_time) && m.create_time * 1000 < openedAt;
    if (!predatesSelection && m?.author?.role === "assistant" &&
        (!["finished_successfully", "finished_error", "cancelled"].includes(m.status) ||
         (m.status === "finished_successfully" && m.metadata?.is_complete === false))) {
      pageClosed = true;
      continue;
    }
    // A run of nodes with nothing to deliver needs only its last cursor.
    const previous = entries.at(-1);
    if (previous && !previous.finished_turn && !entry.finished_turn) {
      entries[entries.length - 1] = entry;
    } else {
      entries.push(entry);
    }
    if (entries.length >= 10) pageClosed = true;
  }
  return {
    status: "page",
    entries,
    ...(confirmation ? { confirmation } : {}),
    ...(completed && !entries.some((entry) => entry.id === completed.id) ? { completed } : {}),
  };
}
async function run(input, executable, dependencies = {}) {
  if (
    !["baseline", "ready", "post", "outbox", "list"].includes(
      input.operation,
    ) ||
    !uuid.test(input.origin_thread ?? "") ||
    (input.operation !== "list" && !uuid.test(input.target ?? ""))
  )
    return { status: "rejected" };
  if (
    input.operation === "post" &&
    (typeof input.text !== "string" ||
      !input.text.trim() ||
      Buffer.byteLength(input.text) > 4096 ||
      !uuid.test(input.request_id ?? ""))
  )
    return { status: "rejected" };
  if (
    input.operation === "baseline" && input.opened_at != null &&
    (!Number.isSafeInteger(input.opened_at) || input.opened_at < 0)
  ) return { status: "rejected" };
  if (
    input.operation === "outbox" &&
    (typeof input.after !== "string" ||
      !Number.isSafeInteger(input.opened_at) ||
      (input.receipt != null && !validReceipt(input.receipt)) ||
      (input.pending_user_id != null && !uuid.test(input.pending_user_id)))
  )
    return { status: "rejected" };
  const native = dependencies.callTool ?? callTool,
    getConnection = dependencies.connect ?? connect;
  const now = dependencies.now ?? Date.now;
  const maxBudget = input.operation === "post" ? 36000 : 24000;
  const budget = Number.isFinite(input.budget_ms) ? Math.min(input.budget_ms, maxBudget) : maxBudget;
  const deadline = Date.now() + budget - 1200;
  function remaining(cap) {
    const ms = Math.min(cap, deadline - Date.now());
    if (ms < 100) throw failure("web_chat_read_timeout");
    return ms;
  }
  const context = {
    threadId: input.origin_thread,
    turnId: "mcp-turn-wechat-" + randomUUID(),
  };
  let attempted = false,
    acknowledged = false,
    receipt;
  try {
    const request = await getConnection(executable);
    async function get(path, cap = 5000) {
      try {
        const r = await request(path, { timeout: remaining(cap) });
        if (!r.ok) {
          const header = r.headers?.get("retry-after");
          const seconds =
            header == null
              ? NaN
              : /^\d+$/.test(header)
                ? Number(header)
                : (Date.parse(header) - now()) / 1000;
          throw failure("web_chat_http_error", {
            http_status: r.status,
            ...(r.status === 429
              ? {
                  retry_after: Number.isFinite(seconds)
                    ? Math.max(1, Math.ceil(seconds))
                    : 60,
                }
              : {}),
          });
        }
        return await r.json();
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError")
          throw failure("web_chat_read_timeout");
        throw error;
      }
    }
    async function read() {
      const data = await get("/conversation/" + input.target, 18000);
      if (
        data?.conversation_id !== input.target ||
        !data.mapping?.[data.current_node]
      )
        throw failure("web_chat_target_required");
      return data;
    }
    if (input.operation === "list") {
      const data = await get("/conversations?offset=0&limit=12&order=updated");
      if (!Array.isArray(data?.items)) throw failure("web_chat_invalid_list");
      return {
        status: "list",
        items: data.items
          .filter((x) => uuid.test(x.id ?? "") && typeof x.title === "string")
          .map((x) => ({ id: x.id, title: x.title.slice(0, 160) })),
      };
    }
    if (input.operation === "outbox")
      return outgoingPage(
        await read(),
        input.after,
        input.opened_at,
        input.receipt,
        input.pending_user_id,
      );
    const metadata = decode(
      await native(
        "read_thread",
        { threadId: input.target, includeTurns: false },
        context,
        { timeout: remaining(6000) },
      ),
    );
    const meta = metadata.thread;
    if (meta?.id !== input.target || meta.kind !== "chatgpt")
      throw failure("web_chat_target_required");
    if (input.operation === "ready")
      return { status: meta.status?.type === "idle" ? "ready" : "busy" };
    if (input.operation === "post" && meta.status?.type !== "idle")
      return { status: "not_dispatched", reason: "busy" };
    const before = await read();
    if (input.operation === "baseline")
      return {
        status: "ready",
        cursor: baselineCursor(before, input.opened_at),
        title: String(meta.title ?? before.title ?? "").slice(0, 160),
        busy: meta.status?.type !== "idle",
      };
    receipt = makeReceipt(before, input.text, now());
    if (!validReceipt(receipt))
      return {
        status: "not_dispatched",
        reason: "confirmation_baseline_too_large",
      };
    // Mark before invoking the RPC. Even a transport timeout can follow a successful write.
    const writeTimeout = remaining(8000);
    attempted = true;
    try {
      const result = decode(
        await native(
          "send_message_to_thread",
          { threadId: input.target, prompt: input.text },
          context,
          { timeout: writeTimeout },
        ),
      );
      acknowledged = result.threadId === input.target;
    } catch (_) {
      /* only read back; never retry this write */
    }
    const confirmed = confirmReceipt(await read(), receipt);
    if (confirmed.status === "accepted") return confirmed;
    return {
      status: "confirming",
      receipt,
      acknowledged,
      reason:
        confirmed.status === "ambiguous"
          ? "multiple_matches"
          : "awaiting_readback",
    };
  } catch (error) {
    if (input.operation !== "post")
      return { status: "unavailable", ...diagnostic(error) };
    if (!attempted) return { status: "not_dispatched", ...diagnostic(error) };
    return {
      status: "confirming",
      receipt,
      acknowledged,
      ...diagnostic(error),
    };
  }
}
if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > 16000) process.exit(2);
  });
  process.stdin.on("end", async () => {
    let operation;
    try {
      const data = JSON.parse(input);
      operation = data.operation;
      console.log(JSON.stringify(await run(data, process.argv[2])));
    } catch (_) {
      console.log(
        JSON.stringify({
          status: operation === "post" ? "uncertain" : "unavailable",
          reason: "invalid_transport_response",
        }),
      );
    }
  });
}
module.exports = {
  baselineCursor,
  outgoingPage,
  makeReceipt,
  confirmReceipt,
  validReceipt,
  run,
};
