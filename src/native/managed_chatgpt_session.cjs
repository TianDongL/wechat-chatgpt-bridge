// In-memory managed sign-in for the optional ChatGPT and Dot transports.
// Credentials stay in memory and are never printed or written to disk.
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

const BASE = "https://chatgpt.com/backend-api";

async function managedToken(executable) {
  const child = spawn(executable, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill(), 10000);
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "wechat_web_chat_bridge",
          version: "0.1.0",
        },
      },
    });
    for await (const line of lines) {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (response.id === 1 && response.result) {
        send({ method: "initialized" });
        send({
          id: 2,
          method: "getAuthStatus",
          params: {
            includeToken: true,
            refreshToken: false,
          },
        });
      } else if (response.id === 1) {
        break;
      } else if (response.id === 2) {
        if (typeof response.result?.authToken === "string")
          return response.result.authToken;
        break;
      }
    }
    throw new Error("managed_sign_in_unavailable");
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function connect(executable) {
  const token = await managedToken(executable);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof account !== "string")
    throw new Error("managed_account_unavailable");
  const request = async function request(
    path,
    {
      body,
      accept = "application/json",
      extraHeaders = {},
      timeout = 15000,
    } = {},
  ) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//")
    )
      throw new Error("invalid_api_path");
    return fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        Authorization: "Bearer " + token,
        "ChatGPT-Account-Id": account,
        Accept: accept,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  request.accountId = account;
  request.userId = claims["https://api.openai.com/auth"]?.chatgpt_user_id;
  return request;
}

function selectedBranch(chat) {
  const result = [],
    seen = new Set();
  let id = chat.current_node;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = chat.mapping?.[id];
    if (!node) break;
    result.unshift(node);
    id = node.parent;
  }
  return result;
}

module.exports = { connect, selectedBranch };
