import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export function defaultDataDir() { return path.join(os.homedir(), '.wechat-chatgpt-bridge'); }
export function atomicWrite(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  if (absolute === path.parse(absolute).root || absolute === path.resolve(os.homedir()) ||
      (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) ||
      (fs.existsSync(absolute) && fs.readdirSync(absolute).length && !fs.existsSync(path.join(absolute, '.bridge-data'))))
    throw new Error('state_directory_not_dedicated');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (process.platform === 'win32') {
    // Replace the DACL of this narrowly validated dedicated directory. Merely
    // disabling inheritance would leave existing explicit Everyone/Users ACEs.
    const literal = absolute.replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'
$bridgeAcl = [System.Security.AccessControl.DirectorySecurity]::new()
$bridgeAcl.SetAccessRuleProtection($true,$false)
$bridgeOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$bridgeSystem = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
foreach ($bridgeSid in @($bridgeOwner,$bridgeSystem)) {
  $bridgeRule = [System.Security.AccessControl.FileSystemAccessRule]::new($bridgeSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $bridgeAcl.AddAccessRule($bridgeRule)
}
[System.IO.Directory]::SetAccessControl('${literal}', $bridgeAcl)`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {stdio: 'pipe', windowsHide: true});
  } else fs.chmodSync(directory, 0o700);
  if (!fs.existsSync(path.join(directory, '.bridge-data'))) atomicWrite(path.join(directory, '.bridge-data'), 'WeChat ChatGPT Bridge data v1\n');
}
export class StateStore {
  constructor(directory) { this.directory = path.resolve(directory); this.locked = false; }
  acquire() {
    privateDirectory(this.directory);
    this.lockPath = path.join(this.directory, 'running.lock');
    try {
      this.lockFd = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeFileSync(this.lockFd, JSON.stringify({pid: process.pid}));
      this.locked = true;
    } catch (error) {
      if (this.lockFd !== undefined && !this.locked) {
        fs.closeSync(this.lockFd); fs.unlinkSync(this.lockPath); this.lockFd = undefined;
      }
      if (error.code === 'EEXIST') throw new Error('bridge_already_running_or_stale_lock');
      throw new Error('state_lock_unavailable');
    }
  }
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('state_file_invalid'); }
  }
  write(name, data) {
    if (!this.locked) throw new Error('state_lock_required');
    if (!/^[a-z-]+\.json$/.test(name)) throw new Error('invalid_state_file');
    atomicWrite(path.join(this.directory, name), JSON.stringify(data, null, 2) + '\n');
  }
  saveReply(id, text) {
    if (!this.locked || !/^[0-9a-f]{64}$/.test(id)) throw new Error('invalid_reply_path');
    const directory = path.join(this.directory, 'replies');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    atomicWrite(path.join(directory, `${id}.md`), text);
  }
  release() {
    if (!this.locked) return;
    fs.closeSync(this.lockFd); fs.unlinkSync(this.lockPath); this.locked = false;
  }
}
