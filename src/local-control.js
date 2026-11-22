import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWrite } from "./state.js";

const LIMIT = 16384;
function equal(a, b) {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export class LocalControl {
  async start({ directory, bridge, onStop }) {
    this.file = path.join(directory, "control.json");
    const token = randomBytes(32).toString("base64url");
    this.server = http.createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (
        req.method !== "POST" ||
        req.url !== "/control" ||
        !equal(req.headers.authorization, "Bearer " + token) ||
        req.headers.origin
      ) {
        res.writeHead(403);
        res.end("{}");
        return;
      }
      try {
        let size = 0;
        const parts = [];
        for await (const part of req) {
          size += part.length;
          if (size > LIMIT) {
            res.writeHead(413);
            res.end("{}");
            return;
          }
          parts.push(part);
        }
        const input = JSON.parse(Buffer.concat(parts).toString());
        if (
          !input ||
          Object.keys(input).sort().join(",") !== "arguments,command"
        )
          throw new Error("invalid");
        let result;
        if (input.command === "status") result = bridge.status();
        else if (input.command === "notify") {
          try {
            result = await bridge.notify(input.arguments);
          } catch (error) {
            bridge.fatalError = error;
            throw error;
          }
        } else if (input.command === "stop") {
          result = { stopping: true };
          res.once("finish", onStop);
        } else throw new Error("invalid");
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400);
        res.end('{"status":"uncertain","retry_allowed":false}');
      }
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    this.server.maxConnections = 8;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.metadata = {
      port: this.server.address().port,
      token,
      pid: process.pid,
    };
    atomicWrite(this.file, JSON.stringify(this.metadata));
  }
  async close() {
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    if (this.file && fs.existsSync(this.file)) {
      const current = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (current.token === this.metadata?.token) fs.unlinkSync(this.file);
    }
  }
}
export async function controlRequest(directory, command, args = {}) {
  const file = path.join(directory, "control.json");
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 2048)
    throw new Error("control_unavailable");
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !Number.isInteger(metadata.port) ||
    metadata.port < 1 ||
    metadata.port > 65535 ||
    !/^[A-Za-z0-9_-]{43}$/.test(metadata.token)
  )
    throw new Error("control_unavailable");
  // Do not accept a host/recipient/URL from the file or stdin. Never retry POST.
  const response = await fetch(`http://127.0.0.1:${metadata.port}/control`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: "Bearer " + metadata.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command, arguments: args }),
  });
  if (!response.ok) throw new Error("control_result_uncertain");
  return response.json();
}
export async function readNotification(stream = process.stdin) {
  let size = 0;
  const parts = [];
  for await (const part of stream) {
    size += Buffer.byteLength(part);
    if (size > LIMIT) throw new Error("invalid_notification");
    parts.push(Buffer.from(part));
  }
  return JSON.parse(Buffer.concat(parts).toString());
}
