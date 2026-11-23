// Signed socket URLs and account-wide frames stay in this process. The parent
// receives only a wake-up for its selected conversation, never frame contents.
const { connect } = require("./managed_chatgpt_session.cjs");

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const topics = ["conversations", "alder-conversations"];

function completedConversation(event) {
  const payload = event?.payload;
  if (!UUID.test(payload?.conversation_id ?? "")) return null;
  if (event.type === "conversation-turn-complete") return payload.conversation_id;
  // Some updates carry the final message before the separate turn notice.
  if (event.type !== "conversation-history-update" || payload.update_type !== "add-messages")
    return null;
  const messages = payload.update_content?.messages ?? payload.messages;
  return Array.isArray(messages) && messages.some(m => m?.author?.role === "assistant" &&
    m.end_turn === true && m.status === "finished_successfully" &&
    (!m.channel || m.channel === "final") && (!m.recipient || m.recipient === "all") &&
    m.metadata?.is_visually_hidden_from_conversation !== true &&
    m.metadata?.is_complete !== false) ? payload.conversation_id : null;
}

function retrySeconds(value) {
  if (!value) return 60;
  const n = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60;
}

function listener(executable, emit, { getConnection = connect, Socket = WebSocket } = {}) {
  let selection, socket, opening = false, closed = false, timer;
  const acknowledged = new Set();
  function stop(error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (error) emit(error);
    if (socket && socket.readyState < 2) socket.close();
  }
  function update(event) {
    if (closed || !selection || completedConversation(event) !== selection.target) return;
    emit({ kind: "update", ...selection });
  }
  async function open() {
    opening = true;
    try {
      const request = await getConnection(executable);
      if (closed) return;
      const response = await request("/celsius/ws/user", { timeout: 10000 });
      if (closed) return;
      if (!response.ok) {
        return stop(response.status === 429 ?
          { kind: "limited", seconds: retrySeconds(response.headers.get("retry-after")) } :
          { kind: "offline" });
      }
      const { websocket_url } = await response.json();
      if (closed) return;
      const url = new URL(websocket_url);
      if (url.origin !== "wss://ws.chatgpt.com" || url.username || url.password)
        return stop({ kind: "offline" });
      socket = new Socket(url.href);
      timer = setTimeout(() => stop({ kind: "offline" }), 15000);
      socket.addEventListener("open", () => {
        if (closed) return;
        socket.send(JSON.stringify([
          { id: 1, command: { type: "connect", presence: { type: "presence", state: "background" } } },
          ...topics.map((topic_id, i) => ({ id: i + 2, command: { type: "subscribe", topic_id } })),
        ]));
      });
      socket.addEventListener("message", ({ data }) => {
        if (closed || typeof data !== "string" || data.length > 2_000_000) return;
        let frame;
        try { frame = JSON.parse(data); } catch { return; }
        for (const row of Array.isArray(frame) ? frame : [frame]) {
          if (!row || typeof row !== "object") continue;
          if (row.type === "message") {
            if (topics.includes(row.topic_id)) update(row.payload);
          } else if ([1, 2, 3].includes(row.id)) {
            const ok = row.id === 1 ? row.reply?.type === "connect" :
              row.reply?.type === "subscribe" && row.reply.topic_id === topics[row.id - 2];
            if (!ok) return stop({ kind: "offline" });
            const wasReady = acknowledged.size === 3;
            acknowledged.add(row.id);
            if (!wasReady && acknowledged.size === 3) {
              clearTimeout(timer);
              emit({ kind: "ready" }); // Parent reconciles the subscription gap once.
            }
          } else if (!Array.isArray(frame)) {
            update(row);
          }
        }
      });
      socket.addEventListener("error", () => stop({ kind: "offline" }));
      socket.addEventListener("close", () => stop({ kind: "offline" }));
    } catch {
      stop({ kind: "offline" });
    }
  }
  return {
    select(item) {
      if (!item || !UUID.test(item.target ?? "") || !Number.isSafeInteger(item.generation) || item.generation < 0)
        return false;
      selection = { target: item.target, generation: item.generation };
      if (!opening && !closed) void open();
      return true;
    },
    close: () => stop(),
  };
}

module.exports = { listener, completedConversation, retrySeconds };
