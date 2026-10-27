import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLatestYml, compareVersions, download, latestRelease } from '../lib/releases.js';
import { parseRegistry, findInstalled, folderOf } from '../lib/windows.js';
import { validateCatalog } from '../lib/catalog.js';
import { createLog } from '../lib/log.js';

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
  // outro programa que só começa com o mesmo nome não é confundido com o app
  const outros = [{ displayName: 'Prosa Editor 2.0', version: '2.0' }, { displayName: 'Prosa', version: '1.0.0' }];
  assert.equal(findInstalled(outros, 'Prosa')?.version, '1.0.0');
  assert.equal(findInstalled([{ displayName: 'Prosa Editor 2.0' }], 'Prosa'), null);
  assert.equal(findInstalled([{ displayName: 'Prosa 1.2.0-beta.1', version: '1.2.0-beta.1' }], 'Prosa')?.version, '1.2.0-beta.1');
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

/** fetch que manda um pedaço e depois trava, como uma conexão que caiu; respeita o signal como o fetch real. */
const fetchTravado = async (_url, { signal } = {}) => new Response(new ReadableStream({
  start(c) {
    c.enqueue(new Uint8Array([1, 2, 3]));
    signal?.addEventListener('abort', () => c.error(signal.reason));
  },
}));

test('download travado desiste em vez de prender a Central', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-teste-'));
  try {
    const dest = path.join(dir, 'travado.exe');
    await assert.rejects(download(fetchTravado, { url: 'x', sha512: 'y' }, dest, null, { stallMs: 50 }), /parou de receber dados/);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('erro ao gravar o download vira rejeição, sem derrubar o processo', async () => {
  const body = Buffer.from('instalador');
  const fakeFetch = async () => new Response(body);
  const dest = path.join(os.tmpdir(), 'central-pasta-que-nao-existe', 'x.exe');
  await assert.rejects(download(fakeFetch, { url: 'x', sha512: 'y' }, dest), /ENOENT/);
});

test('latest.yml sem resposta desiste no prazo', async () => {
  // como uma conexão aberta, o intervalo mantém o processo vivo (o timer do AbortSignal.timeout sozinho não mantém)
  const fetchMudo = (_url, { signal }) => new Promise((_r, reject) => {
    const aberta = setInterval(() => {}, 1000);
    signal.addEventListener('abort', () => { clearInterval(aberta); reject(signal.reason); });
  });
  await assert.rejects(latestRelease(fetchMudo, 'dono/repo', { timeoutMs: 50 }), /não respondeu a tempo/);
});

test('catálogo: entradas inválidas são descartadas sem derrubar as outras', () => {
  const ok = { id: 'prosa', nome: 'Prosa', repo: 'contatomeigre/prosa-releases', executavel: 'Prosa.exe', icone: 'https://x/p.png' };
  const { apps, problemas } = validateCatalog({
    apps: [
      ok,
      { ...ok, id: 'prosa' }, // id repetido
      { ...ok, id: 'fora', executavel: '..\\..\\Windows\\explorer.exe' }, // pastas no executável
      { ...ok, id: 'fora2', executavel: '../x/Prosa.exe' },
      { ...ok, id: 'sem-repo', repo: 'https://github.com/x/y' },
      { ...ok, id: 'Maiusculo' },
      { ...ok, id: 'icone', icone: 'javascript:alert(1)' },
      { ...ok, id: 'meu-app', nome: 'Meu App', executavel: 'Meu App (x64).exe', nomeWindows: 'Meu App' },
      null,
    ],
  });
  assert.deepEqual(apps.map((a) => a.id), ['prosa', 'meu-app']);
  assert.equal(problemas.length, 7);
  assert.match(problemas[0], /entrada 2 \(prosa\): id repetido/);
  assert.match(problemas[1], /executavel/);
  assert.match(problemas[2], /executavel/);
  assert.throws(() => validateCatalog({ aplicativos: [] }), /lista "apps"/);
});

test('registro em arquivo vira .old ao passar do limite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-log-'));
  try {
    const log = createLog(dir, { maxBytes: 200 });
    for (let i = 0; i < 10; i++) log.info(`linha ${i} ${'x'.repeat(40)}`);
    log.error('último');
    const atual = fs.readFileSync(path.join(dir, 'central.log'), 'utf8');
    assert.ok(fs.existsSync(path.join(dir, 'central.old.log')));
    assert.ok(atual.length < 400);
    assert.match(atual, /ERRO  último\n$/);
    createLog(path.join(dir, 'arquivo.txt', 'sub')); // pasta impossível: não lança
    fs.writeFileSync(path.join(dir, 'arquivo.txt'), '');
    createLog(path.join(dir, 'arquivo.txt', 'sub')).error('não derruba');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
