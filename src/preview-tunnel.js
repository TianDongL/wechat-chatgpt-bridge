import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Official release assets and SHA-256 digests, pinned together. No private
// binary, account, token, or named tunnel configuration is distributed.
export const TUNNEL_VERSION = '2026.11.1';
const ASSETS = {
  'win32-x64': ['cloudflared-windows-amd64.exe', '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35'],
  'linux-x64': ['cloudflared-linux-amd64', '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7'],
  'linux-arm64': ['cloudflared-linux-arm64', 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a'],
  'darwin-x64': ['cloudflared-darwin-amd64.tgz', '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f'],
  'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462'],
};
export function tunnelAsset(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error('preview_platform_unsupported');
  return {name: asset[0], sha256: asset[1], url: `https://github.com/cloudflare/cloudflared/releases/download/${TUNNEL_VERSION}/${asset[0]}`};
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function regular(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('preview_file_invalid');
}
function paths(dataDir) {
  const directory = path.join(path.resolve(dataDir), 'tools', `cloudflared-${TUNNEL_VERSION}`);
  return {directory, executable: path.join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    configPath: path.join(directory, 'preview.yml'), receipt: path.join(directory, 'receipt.json')};
}
export async function installedTunnel(dataDir) {
  const files = paths(dataDir), asset = tunnelAsset();
  for (const directory of [path.dirname(files.directory), files.directory]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('preview_file_invalid');
  }
  await regular(files.executable); await regular(files.receipt); await regular(files.configPath);
  const receipt = JSON.parse(await readFile(files.receipt, 'utf8'));
  if (receipt.assetSha256 !== asset.sha256 || !/^[a-f0-9]{64}$/.test(receipt.binarySha256) ||
      await sha256(files.executable) !== receipt.binarySha256 ||
      (!asset.name.endsWith('.tgz') && receipt.binarySha256 !== asset.sha256) ||
      await readFile(files.configPath, 'utf8') !== '{}\n') throw new Error('preview_file_invalid');
  return files;
}
export async function installTunnel(dataDir, {signal, fetchImpl = fetch, log = () => {}} = {}) {
  try { return await installedTunnel(dataDir); } catch { /* Install into this version's isolated directory. */ }
  const asset = tunnelAsset(), files = paths(dataDir);
  const parent = path.dirname(files.directory);
  await mkdir(parent, {recursive: true, mode: 0o700});
  if ((await lstat(parent)).isSymbolicLink()) throw new Error('preview_file_invalid');
  // A versioned install with invalid contents is not silently overwritten.
  try { await access(files.directory); throw new Error('preview_install_conflict'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await mkdtemp(path.join(parent, '.preview-download-'));
  try {
    log('正在下载并校验 HTML 预览所需的 cloudflared……');
    const response = await fetchImpl(asset.url, {signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])])});
    if (!response.ok || !response.body) throw new Error('preview_download_failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 80 * 1024 * 1024) throw new Error('preview_download_too_large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('preview_checksum_failed');
    const binary = path.join(temporary, path.basename(files.executable));
    if (asset.name.endsWith('.tgz')) {
      const archive = path.join(temporary, 'asset.tgz');
      await writeFile(archive, bytes, {mode: 0o600});
      await promisify(execFile)('tar', ['-xzf', archive, '-C', temporary, 'cloudflared'], {windowsHide: true, timeout: 30000, signal});
      await rm(archive);
    } else await writeFile(binary, bytes, {mode: 0o700});
    await regular(binary); await chmod(binary, 0o700);
    await writeFile(path.join(temporary, 'receipt.json'), JSON.stringify({assetSha256: asset.sha256, binarySha256: await sha256(binary)}), {mode: 0o600});
    await writeFile(path.join(temporary, 'preview.yml'), '{}\n', {mode: 0o600});
    if (signal?.aborted) throw new Error('preview_install_cancelled');
    await rename(temporary, files.directory);
    return await installedTunnel(dataDir);
  } finally {
    // mkdtemp created this exact directory beneath the dedicated tools folder.
    if (path.dirname(temporary) !== parent) throw new Error('preview_cleanup_path_invalid');
    await rm(temporary, {recursive: true, force: true});
  }
}
