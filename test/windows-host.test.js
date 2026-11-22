import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { buildWindowsHost } from "../src/windows-host.js";
test(
  "Windows host termination cleans its contained worker and grandchild",
  { skip: process.platform !== "win32" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-host-test-"));
    let host,
      pids = [];
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const executable = buildWindowsHost(root);
      assert.equal(buildWindowsHost(root), executable);
      const marker = path.join(root, "ready.json"),
        fixture = path.join(root, "fixture with spaces.cjs");
      fs.writeFileSync(
        fixture,
        "const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);",
      );
      host = spawn(executable, [process.execPath, fixture, marker], {
        stdio: "ignore",
        windowsHide: true,
      });
      for (let n = 0; n < 100 && !fs.existsSync(marker); n++) await delay(25);
      assert.ok(fs.existsSync(marker));
      pids = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.ok(pids.every(alive));
      const exited = once(host, "exit");
      host.kill();
      await exited;
      for (let n = 0; n < 100 && pids.some(alive); n++) await delay(25);
      assert.ok(pids.every((pid) => !alive(pid)));
    } finally {
      if (host?.exitCode === null) host.kill();
      for (const pid of pids) if (alive(pid)) process.kill(pid);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
