import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked release files. Stage the intended source first.');
const findings = [];
const privateNames = /(^|\/)(node_modules|browser-profile|\.env|credentials\.json|state\.json|running\.lock|\.bridge-data)(\/|$)|\.(sqlite|db|log|zip|tgz)$/i;
const patterns = [
  /[A-Z]:\\Users\\(?!Public\b)[^\s\\]+\\/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{24,}/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  /https:\/\/[a-z-]+\.trycloudflare\.com\/p\/[A-Za-z0-9_-]{20,}/,
];
for (const file of files) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024 || privateNames.test(file)) {
    findings.push(file); continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (patterns.some(pattern => pattern.test(text))) findings.push(file);
}
if (findings.length) { console.error('Release scan failed (paths only):\n' + findings.join('\n')); process.exitCode = 1; }
else console.log(`Release scan passed: ${files.length} tracked source files. No private runtime files or recognized secret patterns. Review still required.`);
