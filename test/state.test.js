import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StateStore, privateDirectory} from '../src/state.js';

test('private store locks exclusively, writes atomically and preserves state on reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bridge-test-'));
  const directory = path.join(root, 'data');
  const one = new StateStore(directory), two = new StateStore(directory);
  try {
    one.acquire(); assert.throws(() => two.acquire(), /already_running/);
    one.write('state.json', {cursor: 'synthetic'}); assert.deepEqual(one.read('state.json'), {cursor: 'synthetic'});
    assert.throws(() => one.write('../bad.json', {}), /invalid_state_file/);
    one.saveReply('a'.repeat(64), '原文\n\n');
    assert.equal(fs.readFileSync(path.join(directory, 'replies', 'a'.repeat(64) + '.md'), 'utf8'), '原文\n\n');
    one.release(); two.acquire(); assert.deepEqual(two.read('state.json'), {cursor: 'synthetic'});
    assert.equal(fs.readdirSync(directory).some(x => x.endsWith('.tmp')), false);
  } finally { one.release(); two.release(); fs.rmSync(root, {recursive: true, force: true}); }
});
test('store refuses unrelated nonempty directories before altering permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-unrelated-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'important.txt'), 'keep');
    assert.throws(() => privateDirectory(directory), /not_dedicated/);
    assert.equal(fs.readFileSync(path.join(directory, 'important.txt'), 'utf8'), 'keep');
    assert.throws(() => privateDirectory(os.homedir()), /not_dedicated/);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
