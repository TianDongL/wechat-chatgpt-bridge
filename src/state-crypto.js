import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { execFileSync } from "node:child_process";

function dpapi(bytes, operation) {
  const method = operation === "protect" ? "Protect" : "Unprotect";
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security
$bridgeInput=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$bridgeOutput=[System.Security.Cryptography.ProtectedData]::${method}($bridgeInput,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($bridgeOutput))`;
  return Buffer.from(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        input: bytes.toString("base64"),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 65536,
      },
    ).trim(),
    "base64",
  );
}
export function loadStateKey(
  directory,
  write,
  { platform = process.platform, protect = dpapi } = {},
) {
  if (platform !== "win32") return null; // Unix uses owner-only file permissions.
  const file = path.join(directory, "state-key.dpapi");
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16384)
      throw new Error("state_key_invalid");
    const key = protect(fs.readFileSync(file), "unprotect");
    if (key.length !== 32) throw new Error("state_key_invalid");
    return key;
  }
  const key = randomBytes(32);
  write(file, protect(key, "protect"));
  return key;
}
export function encodeState(value, key) {
  if (!key) return value;
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    encrypted: "aes-256-gcm-v1",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
export function decodeState(value, key) {
  if (value?.encrypted !== "aes-256-gcm-v1") return value;
  if (!key) throw new Error("state_key_required");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.data, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  );
}
