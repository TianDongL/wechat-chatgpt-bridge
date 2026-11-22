import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  LocalControl,
  controlRequest,
  readNotification,
} from "../src/local-control.js";
import { StateStore } from "../src/state.js";
import { randomBytes } from "node:crypto";
import { encodeState, decodeState } from "../src/state-crypto.js";

test("local control rejects unauthenticated, cross-origin and oversized calls; stop cleans its endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-"));
  const control = new LocalControl();
  let calls = 0,
    stopped = false;
  try {
    await control.start({
      directory: root,
      bridge: {
        status: () => ({ running: true }),
        notify: async () => {
          calls++;
          return { status: "sent", retry_allowed: false };
        },
      },
      onStop: () => {
        stopped = true;
      },
    });
    const metadata = JSON.parse(
        fs.readFileSync(path.join(root, "control.json"), "utf8"),
      ),
      url = `http://127.0.0.1:${metadata.port}/control`;
    assert.equal(
      (await fetch(url, { method: "POST", body: "{}" })).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + metadata.token,
            Origin: "https://example.test",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { Authorization: "Bearer " + metadata.token },
          body: "x".repeat(17000),
        })
      ).status,
      413,
    );
    assert.deepEqual(await controlRequest(root, "status"), { running: true });
    assert.equal(calls, 0);
    assert.equal(
      (
        await controlRequest(root, "notify", {
          request_id: "synthetic",
          purpose: "test",
          text: "test",
        })
      ).status,
      "sent",
    );
    assert.equal(calls, 1);
    assert.deepEqual(await controlRequest(root, "stop"), { stopping: true });
    assert.equal(stopped, true);
    await control.close();
    assert.equal(fs.existsSync(path.join(root, "control.json")), false);
  } finally {
    await control.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("notification stdin is bounded and does not accept secrets as CLI arguments", async () => {
  const value = { request_id: "synthetic", purpose: "test", text: "正文" };
  assert.deepEqual(
    await readNotification(Readable.from([JSON.stringify(value)])),
    value,
  );
  await assert.rejects(
    readNotification(Readable.from(["x".repeat(17000)])),
    /invalid_notification/,
  );
});
test("authenticated state encryption detects tampering and wrong keys", () => {
  const key = randomBytes(32),
    value = { token: "synthetic-private-value", cursor: "preserve" };
  const encoded = encodeState(value, key);
  assert.equal(JSON.stringify(encoded).includes(value.token), false);
  assert.deepEqual(decodeState(encoded, key), value);
  assert.throws(() => decodeState(encoded, randomBytes(32)));
  encoded.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() => decodeState(encoded, key));
});
test(
  "Windows migrates existing plaintext state and credentials under a DPAPI protected key",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dpapi-test-")),
      directory = path.join(root, "data"),
      store = new StateStore(directory);
    try {
      store.acquire();
      store.write("credentials.json", { token: "synthetic-private-value" });
      assert.equal(
        fs
          .readFileSync(path.join(directory, "credentials.json"), "utf8")
          .includes("synthetic-private-value"),
        false,
      );
      fs.writeFileSync(
        path.join(directory, "state.json"),
        JSON.stringify({
          records: { one: { status: "uncertain" } },
          cursor: "old-cursor",
        }),
      );
      const old = store.read("state.json");
      assert.equal(old.cursor, "old-cursor");
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"))
          .encrypted,
        "aes-256-gcm-v1",
      );
      store.release();
      store.acquire();
      assert.deepEqual(store.read("state.json"), old);
      assert.equal(
        store.read("credentials.json").token,
        "synthetic-private-value",
      );
    } finally {
      store.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
