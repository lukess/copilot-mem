import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  autoCompressLimit,
  describeSettings,
  loadSettings,
  saveSettingsFile,
  SETTING_DEFAULTS,
} from '../src/config.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-config-'));
  path = join(dir, 'settings.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
  test('environment wins over the file, which wins over the default; empty means default', () => {
    writeFileSync(path, JSON.stringify({ COPILOT_MEM_MODEL: 'file-model', COPILOT_MEM_AUTO_COMPRESS: 2, COPILOT_MEM_EMBED_MODEL: '', other: 'x' }));
    const fromFile = loadSettings({}, path);
    assert.equal(fromFile('COPILOT_MEM_MODEL'), 'file-model');
    assert.equal(autoCompressLimit(fromFile), 2);
    assert.equal(fromFile('COPILOT_MEM_EMBED_MODEL'), '');
    assert.equal(fromFile('COPILOT_MEM_EMBED_PROVIDER'), 'local');
    const env = loadSettings({ COPILOT_MEM_MODEL: 'env-model', COPILOT_MEM_AUTO_COMPRESS: '' }, path);
    assert.equal(env('COPILOT_MEM_MODEL'), 'env-model');
    assert.equal(autoCompressLimit(env), 2, 'an empty variable does not hide the file');
    assert.equal(autoCompressLimit(loadSettings({}, join(dir, 'missing.json'))), 5);
  });

  test('the old COPILOT_MEM_OLLAMA_URL variable still sets the endpoint', () => {
    assert.equal(loadSettings({ COPILOT_MEM_OLLAMA_URL: 'http://gpu:11434' }, path)('COPILOT_MEM_EMBED_URL'), 'http://gpu:11434');
  });

  test('a malformed file is reported with its path', () => {
    writeFileSync(path, '{ nope');
    assert.throws(() => loadSettings({}, path), new RegExp(`${path} is not valid JSON`));
    writeFileSync(path, '[1]');
    assert.throws(() => loadSettings({}, path), /must hold a JSON object/);
  });

  test('install creates an owner-only file with every key, keeping edits and saving exported values', () => {
    const first = saveSettingsFile(path, { COPILOT_MEM_AUTO_COMPRESS: '3' }, { COPILOT_MEM_COPILOT_BIN: '/bin/copilot' });
    assert.deepEqual(first, { created: true, fromEnv: ['COPILOT_MEM_AUTO_COMPRESS'] });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(saved), Object.keys(SETTING_DEFAULTS));
    assert.equal(saved.COPILOT_MEM_AUTO_COMPRESS, '3');
    assert.equal(saved.COPILOT_MEM_COPILOT_BIN, '/bin/copilot');

    writeFileSync(path, JSON.stringify({ ...saved, COPILOT_MEM_EMBED_PROVIDER: 'voyage', mine: true }));
    assert.deepEqual(saveSettingsFile(path, { COPILOT_MEM_AUTO_COMPRESS: '3' }), { created: false, fromEnv: [] });
    const again = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(again.COPILOT_MEM_EMBED_PROVIDER, 'voyage');
    assert.equal(again.mine, true);
  });

  test('describeSettings shows sources and masks the API key', () => {
    writeFileSync(path, JSON.stringify({ COPILOT_MEM_EMBED_API_KEY: 'pa-1234567890', COPILOT_MEM_MODEL: 'm' }));
    const { settings } = describeSettings({ COPILOT_MEM_AUTO_COMPRESS: '0' }, path);
    assert.deepEqual(settings.COPILOT_MEM_EMBED_API_KEY, { value: 'pa-1...(13 chars)', source: 'file' });
    assert.deepEqual(settings.COPILOT_MEM_MODEL, { value: 'm', source: 'file' });
    assert.deepEqual(settings.COPILOT_MEM_AUTO_COMPRESS, { value: '0', source: 'env' });
    assert.deepEqual(settings.COPILOT_MEM_EMBED_PROVIDER, { value: 'local', source: 'default' });
  });
});
