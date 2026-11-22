import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { defaultDataDir, privateDirectory } from "../src/state.js";
import { buildWindowsHost } from "../src/windows-host.js";
const args = process.argv.slice(2),
  cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
let directory = defaultDataDir();
if (args.length) {
  if (args.length !== 2 || args[0] !== "--data-dir" || !args[1]) {
    console.error("用法：npm start -- --data-dir 独立数据目录");
    process.exit(2);
  }
  directory = path.resolve(args[1]);
}
try {
  let executable = process.execPath,
    childArgs = [cli, "start", ...args];
  if (process.platform === "win32") {
    privateDirectory(directory);
    executable = buildWindowsHost(directory);
    childArgs = [process.execPath, ...childArgs];
  }
  const child = spawn(executable, childArgs, { stdio: "inherit" });
  // Console Ctrl+C reaches the host and worker. Host allows graceful shutdown
  // before closing its job. No hidden service, autostart or automatic restart.
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (process.platform !== "win32") child.kill(signal);
    });
  child.on("error", () => {
    console.error("无法启动微信桥。");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  console.error(
    "无法准备 Windows 进程保护。需要系统 .NET Framework 编译器及可写的独立数据目录；未启动桥。",
  );
  process.exitCode = 1;
}
