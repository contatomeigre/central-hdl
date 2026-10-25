// Central HDL — loja de aplicativos desktop da HDL Soluções.
//
// Lê o catálogo (catalogo.json no GitHub), descobre a última versão de cada app
// no GitHub Releases, compara com o que está instalado no Windows e instala ou
// atualiza em silêncio. Fica na bandeja e atualiza os apps sozinha.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, net, Notification } from 'electron';
import updater from 'electron-updater';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestRelease, download, compareVersions } from './lib/releases.js';
import { installedPrograms, findInstalled, isRunning, kill, runInstaller, runUninstall } from './lib/windows.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, 'icone.png');
const CATALOG_URL = 'https://raw.githubusercontent.com/contatomeigre/central-hdl/main/catalogo.json';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const HIDDEN_ARG = '--oculto';

app.setName('Central HDL');
app.setAppUserModelId('br.hdl.central');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
const busy = new Map();       // appId -> 'baixando' | 'instalando' | 'desinstalando'
const notified = new Set();   // "id@versão" já avisados

// ------------------------------------------------------------ preferências
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = { atualizarSozinho: true, iniciarComWindows: true };
function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function writeConfig(next) {
  const cfg = { ...readConfig(), ...next };
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2));
  applyLoginItem(cfg);
  return cfg;
}
function applyLoginItem(cfg) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: cfg.iniciarComWindows, args: [HIDDEN_ARG] });
}

// ------------------------------------------------------------ catálogo
const CACHE_FILE = () => path.join(app.getPath('userData'), 'catalogo.json');
async function loadCatalog() {
  try {
    const res = await net.fetch(CATALOG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    const cat = JSON.parse(text);
    fs.writeFileSync(CACHE_FILE(), text);
    return cat;
  } catch {
    // sem internet ou catálogo ainda não publicado: usa a última cópia, ou a que veio no instalador
    for (const f of [CACHE_FILE(), path.join(HERE, 'catalogo.json')]) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* próxima */ }
    }
    return { apps: [] };
  }
}

/** Estado de cada app: versão instalada, última publicada, se está aberto. */
async function collectState() {
  const [catalog, programs] = await Promise.all([loadCatalog(), installedPrograms()]);
  const apps = await Promise.all((catalog.apps ?? []).map(async (a) => {
    const inst = findInstalled(programs, a.nomeWindows ?? a.nome);
    let latest = null;
    let erro = null;
    try { latest = await latestRelease(net.fetch, a.repo); } catch (err) { erro = err.message; }
    const installed = inst ? inst.version ?? '0.0.0' : null;
    return {
      id: a.id,
      nome: a.nome,
      descricao: a.descricao ?? '',
      categoria: a.categoria ?? 'Outros',
      icone: a.icone ?? null,
      instalada: installed,
      ultima: latest ? { versao: latest.version, data: latest.releaseDate, tamanho: latest.size, notas: latest.notesUrl } : null,
      atualizacao: Boolean(installed && latest && compareVersions(latest.version, installed) > 0),
      rodando: installed ? await isRunning(a.executavel) : false,
      ocupado: busy.get(a.id) ?? null,
      erro,
    };
  }));
  return apps;
}

async function catalogEntry(id) {
  const a = (await loadCatalog()).apps?.find((x) => x.id === id);
  if (!a) throw new Error('App não encontrado no catálogo.');
  return a;
}

const send = (channel, payload) => win?.webContents.send(channel, payload);
const setBusy = (id, status) => {
  if (status) busy.set(id, status); else busy.delete(id);
  send('ocupado', { id, status });
};

// ------------------------------------------------------------ instalar / atualizar / remover
async function install(id, { fechar = false } = {}) {
  if (busy.has(id)) throw new Error('Já existe uma operação em andamento para este app.');
  const a = await catalogEntry(id);
  const wasRunning = await isRunning(a.executavel);
  if (wasRunning && !fechar) return { precisaFechar: true };
  setBusy(id, 'baixando');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-hdl-'));
  try {
    const release = await latestRelease(net.fetch, a.repo);
    const file = path.join(dir, path.basename(release.file));
    await download(net.fetch, release, file, (got, total) => send('progresso', { id, got, total }));
    setBusy(id, 'instalando');
    if (await isRunning(a.executavel)) await kill(a.executavel);
    await runInstaller(file);
    if (wasRunning) launch(a).catch(() => {});
    return { versao: release.version };
  } finally {
    setBusy(id, null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function installedEntry(a) {
  const inst = findInstalled(await installedPrograms(), a.nomeWindows ?? a.nome);
  if (!inst) throw new Error(`${a.nome} não está instalado.`);
  return inst;
}

async function launch(a) {
  const inst = await installedEntry(a);
  const exe = path.join(inst.location ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', a.nome), a.executavel);
  if (!fs.existsSync(exe)) throw new Error(`Não encontrei ${a.executavel}. Reinstale o app.`);
  const err = await shell.openPath(exe);
  if (err) throw new Error(err);
}

async function uninstall(id) {
  const a = await catalogEntry(id);
  const inst = await installedEntry(a);
  if (!inst.uninstall) throw new Error('O Windows não informou como desinstalar este app.');
  setBusy(id, 'desinstalando');
  try {
    if (await isRunning(a.executavel)) await kill(a.executavel);
    await runUninstall(inst.uninstall);
  } finally {
    setBusy(id, null);
  }
}

// ------------------------------------------------------------ rotina em segundo plano
let checking = false;
async function backgroundCheck() {
  if (checking) return;
  checking = true;
  try {
    const apps = await collectState();
    send('estado', apps);
    const pending = apps.filter((a) => a.atualizacao);
    updateTray(pending.length);
    const auto = readConfig().atualizarSozinho;
    for (const a of pending) {
      // apps abertos não são interrompidos: só avisa
      if (auto && !a.rodando && !busy.has(a.id)) {
        try {
          const r = await install(a.id);
          if (r.precisaFechar) continue; // foi aberto enquanto procurávamos
          notify(`${a.nome} atualizado`, `Versão ${r.versao} instalada.`);
        } catch (err) {
          notify(`Não foi possível atualizar ${a.nome}`, err.message);
        }
        continue;
      }
      const key = `${a.id}@${a.ultima.versao}`;
      if (!notified.has(key)) {
        notified.add(key);
        notify(`Atualização do ${a.nome}`, `A versão ${a.ultima.versao} está disponível. Abra a Central HDL para atualizar.`);
      }
    }
    if (pending.length) send('estado', await collectState());
  } finally {
    checking = false;
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', show);
  n.show();
}

// ------------------------------------------------------------ atualização da própria Central
// estado: ocioso | verificando | baixando | pronta | em-dia | erro | indisponivel (fora do instalador)
let selfStatus = { estado: app.isPackaged ? 'ocioso' : 'indisponivel' };
function setSelfStatus(next) {
  // com a versão nova já baixada, só um reinício muda o estado
  if (selfStatus.estado === 'pronta' && next.estado !== 'pronta') return;
  selfStatus = next;
  send('central-status', selfStatus);
}
function setupSelfUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setSelfStatus({ estado: 'verificando' }));
  autoUpdater.on('update-available', ({ version }) => setSelfStatus({ estado: 'baixando', versao: version, progresso: 0 }));
  autoUpdater.on('update-not-available', () => setSelfStatus({ estado: 'em-dia', verificadoEm: Date.now() }));
  autoUpdater.on('download-progress', ({ percent }) =>
    setSelfStatus({ ...selfStatus, estado: 'baixando', progresso: Math.round(percent ?? 0) }));
  autoUpdater.on('update-downloaded', ({ version }) => {
    setSelfStatus({ estado: 'pronta', versao: version });
    notify('Atualização da Central HDL', `A versão ${version} está pronta. Reinicie a Central para instalar.`);
  });
  autoUpdater.on('error', (err) => {
    console.warn('[central] atualização:', err?.message ?? err);
    setSelfStatus({ estado: 'erro', erro: 'Não foi possível procurar a atualização. Verifique a internet e tente de novo.' });
  });
  checkSelfUpdate();
  setInterval(checkSelfUpdate, CHECK_EVERY_MS * 4);
}
/** Procura versão nova da Central (baixa sozinha se houver). */
async function checkSelfUpdate() {
  if (!app.isPackaged) return selfStatus;
  if (['verificando', 'baixando', 'pronta'].includes(selfStatus.estado)) return selfStatus;
  await updater.autoUpdater.checkForUpdates().catch(() => {}); // erros chegam pelo evento 'error'
  return selfStatus;
}
function restartToUpdate() {
  if (selfStatus.estado !== 'pronta') throw new Error('Ainda não há uma atualização da Central pronta para instalar.');
  quitting = true;
  updater.autoUpdater.quitAndInstall(true, true);
}

// ------------------------------------------------------------ janela e bandeja
function createWindow({ hidden = false } = {}) {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Central HDL',
    icon: ICON,
    backgroundColor: '#121722',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (!hidden) win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide(); // continua na bandeja cuidando das atualizações
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(HERE, 'ui', 'index.html'));
}

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray(pending) {
  tray?.setToolTip(pending ? `Central HDL — ${pending} atualização(ões)` : 'Central HDL');
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Central HDL');
  tray.on('click', show);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir a Central HDL', click: show },
    { label: 'Procurar atualizações', click: () => { backgroundCheck(); checkSelfUpdate(); } },
    { label: 'Atualizar a Central HDL', click: () => (selfStatus.estado === 'pronta' ? restartToUpdate() : (show(), checkSelfUpdate())) },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ------------------------------------------------------------ IPC
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, erro: err.message }; }
});
handle('estado', () => collectState());
handle('instalar', (id, opts) => install(String(id), opts ?? {}));
handle('abrir', async (id) => launch(await catalogEntry(String(id))));
handle('desinstalar', (id) => uninstall(String(id)));
handle('config', () => readConfig());
handle('salvar-config', (cfg) => writeConfig({
  atualizarSozinho: Boolean(cfg?.atualizarSozinho),
  iniciarComWindows: Boolean(cfg?.iniciarComWindows),
}));
handle('central', () => ({ versao: app.getVersion(), status: selfStatus }));
handle('verificar-central', () => checkSelfUpdate());
handle('reiniciar-central', () => restartToUpdate());

// ------------------------------------------------------------ ciclo de vida
app.on('second-instance', show);
app.whenReady().then(() => {
  applyLoginItem(readConfig());
  buildTray();
  createWindow({ hidden: process.argv.includes(HIDDEN_ARG) });
  setupSelfUpdate();
  setTimeout(backgroundCheck, 5000);
  setInterval(backgroundCheck, CHECK_EVERY_MS);
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
app.on('before-quit', () => { quitting = true; });
