// Optional existing Dot DM only. Identity comes from the signed-in account at
// setup and is pinned locally. Never ship a developer's room/member/root IDs.
const { randomUUID } = require("node:crypto");
const validId = (value) =>
  typeof value === "string" && /^[\w~:-]{1,256}$/.test(value);

async function inspectIdentity(request) {
  if (!validId(request.userId)) throw new Error("dot_owner_unverifiable");
  const response = await request("/tbo/primary", { timeout: 5000 });
  const profile = response.ok ? (await response.json()).profile : null;
  if (
    !profile ||
    profile.scope === "shared" ||
    profile.status !== "active" ||
    profile.aeon_kind !== "orbit" ||
    ![
      profile.id,
      profile.messaging_room_id,
      profile.active_root_thread_id,
    ].every(validId)
  )
    throw new Error("dot_unavailable");
  const roomPath =
    "/messaging/rooms/" + encodeURIComponent(profile.messaging_room_id);
  const read = await request(roomPath, { timeout: 5000 });
  const room = read.ok ? await read.json() : null;
  if (
    room?.id !== profile.messaging_room_id ||
    room.aeon_id !== profile.id ||
    room.type !== "DM" ||
    room.app_source !== "chatgpt:messaging" ||
    !Array.isArray(room.members) ||
    room.members.length !== 2
  )
    throw new Error("dot_room_invalid");
  const bots = room.members.filter((member) => member.aeon_id === profile.id);
  const owners = room.members.filter((member) => member.aeon_id !== profile.id);
  if (
    bots.length !== 1 ||
    owners.length !== 1 ||
    owners[0].account_user_id !== request.userId ||
    !validId(bots[0].account_user_id)
  )
    throw new Error("dot_owner_mismatch");
  return {
    identity: {
      dot: profile.id,
      room: room.id,
      owner: request.userId,
      member: bots[0].account_user_id,
      root: profile.active_root_thread_id,
    },
    roomPath,
    route: read.headers.get("x-openai-thread-route"),
  };
}

function sameIdentity(actual, expected) {
  // Dot can rotate its active root. Pin the actual DM and both participants.
  return (
    expected &&
    ["dot", "room", "owner", "member"].every(
      (key) => validId(expected[key]) && actual[key] === expected[key],
    )
  );
}

function outgoingPage(items, member, openedAt) {
  const entries = [];
  for (const item of items) {
    const created = Date.parse(item.created_at);
    if (!validId(item.id) || !Number.isFinite(created))
      throw new Error("dot_page_invalid");
    if (
      item.account_user_id === member &&
      !item.deleted_at &&
      item.generation &&
      !["completed", "failed", "cancelled"].includes(item.generation.status)
    )
      break;
    const fromDot =
      item.account_user_id === member &&
      !item.deleted_at &&
      (!item.generation || item.generation.status === "completed") &&
      created >= openedAt;
    const value = item.content?.text;
    entries.push({
      id: item.id,
      text: fromDot && typeof value === "string" && value.trim() ? value : null,
    });
  }
  return { status: "page", entries };
}

async function run(request, expected, operation, input = {}) {
  if (!["baseline", "outbox", "post"].includes(operation))
    return { status: "rejected" };
  const { identity, roomPath, route } = await inspectIdentity(request);
  if (!sameIdentity(identity, expected)) throw new Error("dot_binding_changed");
  const extraHeaders = route ? { "x-openai-thread-route": route } : {};
  const read = async (suffix) => {
    const response = await request(roomPath + suffix, {
      extraHeaders,
      timeout: 5000,
    });
    const data = response.ok ? await response.json() : null;
    if (!Array.isArray(data?.items)) throw new Error("dot_read_unavailable");
    return data.items;
  };
  if (operation === "baseline") {
    const items = await read("/messages?limit=1");
    if (items.length > 1 || (items.length && !validId(items[0].id)))
      throw new Error("dot_page_invalid");
    return { status: "ready", cursor: items[0]?.id ?? null };
  }
  if (operation === "outbox") {
    if (
      (input.after !== null && !validId(input.after)) ||
      !Number.isSafeInteger(input.openedAt)
    )
      return { status: "rejected" };
    const after =
      input.after === null ? "" : "&after=" + encodeURIComponent(input.after);
    return outgoingPage(
      await read("/messages?limit=10" + after),
      identity.member,
      input.openedAt,
    );
  }
  if (
    typeof input.text !== "string" ||
    !input.text.trim() ||
    Buffer.byteLength(input.text) > 4096
  )
    return { status: "not_dispatched", reason: "invalid_text" };
  const requestId = input.requestId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(requestId))
    return { status: "not_dispatched", reason: "invalid_request_id" };
  // From this point a missing acknowledgement is uncertain. Never repeat POST.
  try {
    const response = await request(roomPath + "/messages", {
      extraHeaders,
      timeout: 10000,
      body: {
        content: { text: input.text },
        message_metadata: {},
        request_id: requestId,
        idempotency_token: requestId,
        timezone_offset_min: new Date().getTimezoneOffset(),
      },
    });
    const data = response.ok ? await response.json() : null;
    if (validId(data?.id) && data.content?.text === input.text)
      return { status: "accepted", message_id: data.id };
  } catch {
    /* Reconcile once, read-only. */
  }
  try {
    const matches = (await read("/messages?limit=20")).filter(
      (item) =>
        item.account_user_id === identity.owner &&
        !item.deleted_at &&
        item.request_id === requestId &&
        item.content?.text === input.text &&
        validId(item.id),
    );
    if (matches.length === 1)
      return { status: "accepted", message_id: matches[0].id };
  } catch {
    /* No new write, including when read-back fails. */
  }
  return { status: "uncertain" };
}
module.exports = { inspectIdentity, sameIdentity, outgoingPage, run };
