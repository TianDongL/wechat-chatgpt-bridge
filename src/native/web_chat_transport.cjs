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
function outgoingPage(chat, after, openedAt, receipt, pendingUserId) {
  const branch = selectedBranch(chat),
    index = branch.findIndex((n) => n.id === after);
  const entries = [];
  const confirmation = receipt ? confirmReceipt(chat, receipt) : null;
  pendingUserId ??=
    confirmation?.status === "accepted" ? confirmation.message_id : null;
  let userId = null,
    completed = null;
  for (let i = 0; i < branch.length; i++) {
    const node = branch[i],
      m = node.message;
    if (m?.author?.role === "user") userId = node.id;
    if (i <= index) {
      // A final node may be completed in place after its ID was consumed, or
      // the send acknowledgement may arrive after the outbox read. Reconcile
      // only the exact pending user turn, without rewinding the cursor.
      if (pendingUserId && userId === pendingUserId) {
        const entry = turnEntry(node, userId, openedAt);
        if (entry.finished_turn) completed = entry;
      }
      continue;
    }
    if (!m) {
      entries.push({ id: node.id, text: null, finished_turn: false });
    } else {
      const assistant = m.author?.role === "assistant";
      if (
        assistant &&
        (!["finished_successfully", "finished_error", "cancelled"].includes(
          m.status,
        ) ||
          (m.status === "finished_successfully" &&
            m.metadata?.is_complete === false))
      )
        break;
      entries.push(turnEntry(node, userId, openedAt));
    }
    if (entries.length >= 10) break;
  }
  return {
    status: "page",
    entries,
    ...(confirmation ? { confirmation } : {}),
    ...(completed ? { completed } : {}),
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
  const context = {
    threadId: input.origin_thread,
    turnId: "mcp-turn-wechat-" + randomUUID(),
  };
  let attempted = false,
    acknowledged = false,
    receipt;
  try {
    const request = await getConnection(executable);
    async function get(path) {
      const r = await request(path, { timeout: 5000 });
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
      return r.json();
    }
    async function read() {
      const data = await get("/conversation/" + input.target);
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
        { timeout: 6000 },
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
        cursor: before.current_node,
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
    attempted = true;
    try {
      const result = decode(
        await native(
          "send_message_to_thread",
          { threadId: input.target, prompt: input.text },
          context,
          { timeout: 8000 },
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
  outgoingPage,
  makeReceipt,
  confirmReceipt,
  validReceipt,
  run,
};
