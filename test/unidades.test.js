import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLatestYml, compareVersions, download } from '../lib/releases.js';
import { parseRegistry, findInstalled, folderOf } from '../lib/windows.js';
import { entrar, renovar, perfil, sair } from '../lib/conta.js';

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

test('conta HDL: entrar, renovar, perfil e mensagens de erro', async () => {
  const cfg = { url: 'https://exemplo.supabase.co', anonKey: 'anon' };
  const chamadas = [];
  const resposta = (status, corpo) => async (url, init) => {
    chamadas.push({ url, init });
    return new Response(corpo === undefined ? null : JSON.stringify(corpo), { status });
  };

  const ok = { access_token: 'a1', refresh_token: 'r1', expires_at: 2000000000, user: { email: 'ana@hdl.com' } };
  const s = await entrar(resposta(200, ok), cfg, ' ana@hdl.com ', 'segredo');
  assert.deepEqual(s, { accessToken: 'a1', refreshToken: 'r1', expiraEm: 2000000000000, email: 'ana@hdl.com' });
  assert.match(chamadas[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(chamadas[0].init.headers.apikey, 'anon');
  assert.deepEqual(JSON.parse(chamadas[0].init.body), { email: 'ana@hdl.com', password: 'segredo' });

  // os dois formatos de erro do Supabase
  await assert.rejects(entrar(resposta(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }), cfg, 'a@b', 'x'), /E-mail ou senha incorretos/);
  await assert.rejects(entrar(resposta(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), cfg, 'a@b', 'x'), /E-mail ou senha incorretos/);
  await assert.rejects(entrar(resposta(200, ok), cfg, '', 'x'), /Informe o e-mail/);

  // renovar: recusa do servidor invalida a sessão; falta de rede não
  const recusa = await renovar(resposta(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }), cfg, 'r1').catch((e) => e);
  assert.equal(recusa.invalida, true);
  const offline = await renovar(async () => { throw new TypeError('fetch failed'); }, cfg, 'r1').catch((e) => e);
  assert.equal(offline.semConexao, true);
  assert.equal(offline.invalida, false);
  const fora = await renovar(resposta(503, {}), cfg, 'r1').catch((e) => e);
  assert.equal(fora.semConexao, true);

  // perfil: só os campos usados, cor validada
  const p = await perfil(resposta(200, { user: { id: 7, username: 'ana', displayName: 'Ana Lima', avatarColor: '#2f6f5e' } }), cfg, 'a1');
  assert.deepEqual(p, { id: 7, usuario: 'ana', nome: 'Ana Lima', cor: '#2f6f5e' });
  const semCor = await perfil(resposta(200, { user: { id: 7, username: 'ana', avatarColor: 'red;background:url(x)' } }), cfg, 'a1');
  assert.equal(semCor.cor, null);
  assert.equal(semCor.nome, 'ana');
  assert.equal(chamadas.at(-1).init.headers.authorization, 'Bearer a1');

  chamadas.length = 0;
  await sair(resposta(204), cfg, 'a1');
  assert.match(chamadas[0].url, /\/auth\/v1\/logout\?scope=local$/);
});
