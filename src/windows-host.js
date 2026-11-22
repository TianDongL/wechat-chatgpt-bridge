import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const source = fileURLToPath(
  new URL("./windows/BridgeHost.cs", import.meta.url),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function buildWindowsHost(directory) {
  const tools = path.join(directory, "tools");
  fs.mkdirSync(tools, { recursive: true });
  if (fs.lstatSync(tools).isSymbolicLink())
    throw new Error("host_directory_invalid");
  const sourceHash = hash(fs.readFileSync(source)),
    file = path.join(tools, "bridge-host-" + sourceHash.slice(0, 16) + ".exe"),
    receipt = file + ".json";
  if (fs.existsSync(file) && fs.existsSync(receipt)) {
    if (
      fs.lstatSync(file).isSymbolicLink() ||
      fs.lstatSync(receipt).isSymbolicLink()
    )
      throw new Error("host_binary_invalid");
    const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (
      value.sourceHash !== sourceHash ||
      value.binaryHash !== hash(fs.readFileSync(file))
    )
      throw new Error("host_binary_invalid");
    return file;
  }
  if (fs.existsSync(file) || fs.existsSync(receipt))
    throw new Error("host_binary_invalid");
  const compiler = ["Framework64", "Framework"]
    .map((arch) =>
      path.join(
        process.env.SystemRoot,
        "Microsoft.NET",
        arch,
        "v4.0.30319/csc.exe",
      ),
    )
    .find((file) => fs.existsSync(file));
  if (!compiler) throw new Error("windows_compiler_missing");
  const temporary = path.join(tools, "build-" + randomUUID() + ".exe");
  try {
    execFileSync(
      compiler,
      ["/nologo", "/target:exe", "/optimize+", "/out:" + temporary, source],
      { stdio: "pipe", windowsHide: true, timeout: 30000 },
    );
    fs.renameSync(temporary, file);
    fs.writeFileSync(
      receipt,
      JSON.stringify({ sourceHash, binaryHash: hash(fs.readFileSync(file)) }),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return file;
}
