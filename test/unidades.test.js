import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLatestYml, compareVersions, download } from '../lib/releases.js';
import { parseRegistry, findInstalled, folderOf } from '../lib/windows.js';

test('latest.yml do electron-builder', () => {
  const yml = [
    'version: 0.4.0',
    'files:',
    '  - url: Prosa-Setup-0.4.0.exe',
    '    sha512: AAAfiles==',
    '    size: 121705106',
    'path: Prosa-Setup-0.4.0.exe',
    'sha512: BBBtopo==',
    "releaseDate: '2026-10-25T12:00:00.000Z'",
    '',
  ].join('\r\n');
  assert.deepEqual(parseLatestYml(yml), {
    version: '0.4.0', file: 'Prosa-Setup-0.4.0.exe', sha512: 'BBBtopo==', size: 121705106, releaseDate: '2026-10-25T12:00:00.000Z',
  });
  assert.throws(() => parseLatestYml('version: 1.0.0'), /incompleto/);
});

test('comparação de versões', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
});

test('registro do Windows: apps instalados', () => {
  const out = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\5f1c-guid',
    '    DisplayName    REG_SZ    Prosa 0.3.0',
    '    DisplayVersion    REG_SZ    0.3.0',
    '    InstallLocation    REG_SZ    C:\\Users\\x\\AppData\\Local\\Programs\\Prosa',
    '    QuietUninstallString    REG_SZ    "C:\\Users\\x\\AppData\\Local\\Programs\\Prosa\\Uninstall Prosa.exe" /currentuser /S',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SemNome',
    '    NoModify    REG_DWORD    0x1',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Outro',
    '    DisplayName    REG_SZ    Prosador Pro',
  ].join('\r\n');
  const entries = parseRegistry(out);
  assert.equal(entries.length, 2);
  const programs = entries.map((e) => ({ displayName: e.values.DisplayName, version: e.values.DisplayVersion }));
  assert.equal(findInstalled(programs, 'Prosa')?.version, '0.3.0');
  assert.equal(findInstalled(programs, 'Prosa Beta'), null);
  assert.match(entries[0].values.QuietUninstallString, /Uninstall Prosa\.exe" \/currentuser \/S$/);
  assert.equal(folderOf('"C:\\Users\\x\\Programs\\Prosa\\Uninstall Prosa.exe" /currentuser'), 'C:\\Users\\x\\Programs\\Prosa');
  assert.equal(folderOf(''), null);
});

test('download confere o SHA-512 e apaga arquivo adulterado', async () => {
  const body = Buffer.from('instalador de teste');
  const sha512 = crypto.createHash('sha512').update(body).digest('base64');
  const fakeFetch = async () => new Response(body, { headers: { 'content-length': String(body.length) } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-teste-'));
  try {
    const ok = path.join(dir, 'ok.exe');
    let last = null;
    await download(fakeFetch, { url: 'x', sha512 }, ok, (got, total) => { last = [got, total]; });
    assert.deepEqual(fs.readFileSync(ok), body);
    assert.deepEqual(last, [body.length, body.length]);
    const bad = path.join(dir, 'ruim.exe');
    await assert.rejects(download(fakeFetch, { url: 'x', sha512: 'outro' }, bad), /SHA-512/);
    assert.equal(fs.existsSync(bad), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
