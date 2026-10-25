// O que está instalado e rodando no Windows, e como instalar/desinstalar em silêncio.

import { execFile, spawn } from 'node:child_process';

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
});

/** Converte a saída de "reg query /s" em uma lista de chaves com seus valores. */
export function parseRegistry(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      cur = { key: line.trim(), values: {} };
      entries.push(cur);
      continue;
    }
    const m = line.match(/^ {4}(.+?) {4}(REG_\w+)(?: {4}(.*))?$/);
    if (m && cur) cur.values[m[1]] = m[3] ?? '';
  }
  return entries.filter((e) => e.values.DisplayName);
}

/** Apps instalados (entradas de "Aplicativos instalados" do Windows). */
export async function installedPrograms() {
  const outs = await Promise.all(UNINSTALL_KEYS.map((k) => run('reg', ['query', k, '/s'])));
  return outs.flatMap(parseRegistry).map((e) => ({
    displayName: e.values.DisplayName,
    version: e.values.DisplayVersion || null,
    // o NSIS do electron-builder não grava InstallLocation: a pasta é a do desinstalador
    location: e.values.InstallLocation || folderOf(e.values.UninstallString),
    uninstall: e.values.QuietUninstallString || (e.values.UninstallString ? `${e.values.UninstallString} /S` : null),
  }));
}

/** Pasta do executável no início de um comando: "C:\Pasta\Uninstall X.exe" /S → C:\Pasta */
export function folderOf(command) {
  const exe = command?.match(/^"([^"]+)"/)?.[1] ?? command?.match(/^(\S+\.exe)/i)?.[1];
  return exe ? exe.replace(/[\\/][^\\/]+$/, '') : null;
}

/** O electron-builder registra "Nome 1.2.3"; aceita também só "Nome". */
export function findInstalled(programs, windowsName) {
  return programs.find((p) => p.displayName === windowsName || p.displayName.startsWith(`${windowsName} `)) ?? null;
}

export async function isRunning(exe) {
  const out = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH']);
  return out.toLowerCase().includes(`"${exe.toLowerCase()}"`);
}

export async function kill(exe) {
  await run('taskkill', ['/IM', exe, '/F', '/T']);
  await new Promise((r) => setTimeout(r, 800)); // o Windows solta os arquivos logo depois
}

/** Roda um instalador NSIS em modo silencioso e espera terminar. */
export function runInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['/S'], { windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`O instalador terminou com código ${code}.`))));
  });
}

/** Desinstala pelo comando registrado no Windows (já vem com o caminho entre aspas). */
export function runUninstall(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`A desinstalação terminou com código ${code}.`))));
  });
}
