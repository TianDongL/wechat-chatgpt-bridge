const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");

function discoverPipe() {
  const pipes = fs
    .readdirSync("\\\\.\\pipe\\")
    .filter((p) => /^codex-app-tools-[0-9a-f-]{36}$/i.test(p));
  if (pipes.length !== 1) throw new Error("app_tools_endpoint_not_unique");
  return "\\\\.\\pipe\\" + pipes[0];
}
function rpc(method, params, { timeout = 30000 } = {}) {
  const endpoint = discoverPipe();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const payload = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    );
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    let buffer = Buffer.alloc(0),
      settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () => done(new Error("app_tools_timeout")),
      timeout,
    );
    socket.on("connect", () => socket.write(frame));
    socket.on("error", (error) => done(error));
    socket.on("close", () => {
      if (!settled) done(new Error("app_tools_closed"));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024)
        return done(new Error("app_tools_frame_limit"));
      if (buffer.length < length + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, 4 + length).toString());
        if (response.error) done(new Error(response.error.message));
        else done(null, response.result);
      } catch (error) {
        done(error);
      }
    });
  });
}
async function callTool(tool, args, context, options) {
  if (!["read_thread", "send_message_to_thread", "list_threads"].includes(tool))
    throw new Error("unsupported_bridge_tool");
  return rpc(
    "tools/call",
    {
      arguments: args,
      callerSource: "codex",
      callId: "wechat-bridge-" + randomUUID(),
      hostId: "local",
      namespace: "codex_app",
      threadId: context.threadId,
      turnId: context.turnId,
      tool,
    },
    options,
  );
}
if (require.main === module) {
  rpc("tools/list", { threadStartKind: "all" })
    .then((result) => {
      console.log(
        JSON.stringify({
          connected: true,
          count: result.tools?.length,
          tools: result.tools
            ?.filter((t) =>
              [
                "read_thread",
                "send_message_to_thread",
                "list_threads",
              ].includes(t.name),
            )
            .map((t) => ({ name: t.name, namespace: t.namespace })),
        }),
      );
    })
    .catch((error) => {
      console.log(JSON.stringify({ connected: false, error: error.message }));
      process.exitCode = 1;
    });
}
module.exports = { rpc, callTool };
