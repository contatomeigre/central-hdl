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
import { validateCatalog } from './lib/catalog.js';
import { createLog } from './lib/log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, 'icone.png');
const CATALOG_URL = 'https://raw.githubusercontent.com/contatomeigre/central-hdl/main/catalogo.json';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 30 * 1000;
const CATALOG_TTL_MS = 5 * 60 * 1000; // o raw.githubusercontent também guarda cache por uns 5 min
const HIDDEN_ARG = '--oculto';

app.setName('Central HDL');
app.setAppUserModelId('br.hdl.central');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const log = createLog(() => app.getPath('logs'));
// "Monitor" só observa: registra o erro sem mudar o que o Electron faz com ele
process.on('uncaughtExceptionMonitor', (err) => log.error(`erro não tratado: ${err?.stack ?? err}`));

let win = null;
let tray = null;
let quitting = false;
const busy = new Map();       // appId -> 'preparando' | 'baixando' | 'instalando' | 'desinstalando'
const notified = new Set();   // avisos já mostrados nesta sessão ("id@versão", "falha:id@versão")

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

/** Só as entradas válidas; as inválidas vão para o registro. */
function checkCatalog(raw, origem) {
  const { apps, problemas } = validateCatalog(raw);
  for (const p of problemas) log.warn(`catálogo (${origem}): ${p}; entrada ignorada`);
  return { apps };
}

async function fetchCatalog() {
  try {
    const res = await net.fetch(CATALOG_URL, { cache: 'no-store', signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const text = await res.text();
    const cat = checkCatalog(JSON.parse(text), 'GitHub');
    fs.writeFileSync(CACHE_FILE(), text);
    return cat;
  } catch (err) {
    log.warn(`catálogo do GitHub indisponível (${err.message}); usando a cópia local`);
  }
  // sem internet ou catálogo inválido: usa a última cópia, ou a que veio no instalador
  for (const f of [CACHE_FILE(), path.join(HERE, 'catalogo.json')]) {
    try { return checkCatalog(JSON.parse(fs.readFileSync(f, 'utf8')), f); } catch { /* próxima */ }
  }
  return { apps: [] };
}

// Guardado em memória por alguns minutos: instalar, abrir e desinstalar não baixam o catálogo de novo.
let catalog = { promise: null, em: 0 };
function loadCatalog({ fresh = false } = {}) {
  if (fresh || !catalog.promise || Date.now() - catalog.em > CATALOG_TTL_MS) {
    catalog = { promise: fetchCatalog(), em: Date.now() };
  }
  return catalog.promise;
}

/** Estado de cada app: versão instalada, última publicada, se está aberto. fresh: relê o catálogo do GitHub. */
async function collectState({ fresh = false } = {}) {
  const [catalog, programs] = await Promise.all([loadCatalog({ fresh }), installedPrograms()]);
  const apps = await Promise.all((catalog.apps ?? []).map(async (a) => {
    const inst = findInstalled(programs, a.nomeWindows ?? a.nome);
    let latest = null;
    let erro = null;
    try { latest = await latestRelease(net.fetch, a.repo); } catch (err) {
      erro = err.message;
      log.warn(`${a.id}: não foi possível consultar a última versão (${err.message})`);
    }
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
/** Marca o app como ocupado antes de qualquer await, para que dois pedidos simultâneos (rotina automática e clique) não passem juntos. */
function reserve(id, status) {
  if (busy.has(id)) throw new Error('Já existe uma operação em andamento para este app.');
  setBusy(id, status);
}

// ------------------------------------------------------------ instalar / atualizar / remover
async function install(id, { fechar = false, segundoPlano = false } = {}) {
  reserve(id, 'preparando');
  let dir = null;
  try {
    const a = await catalogEntry(id);
    const wasRunning = await isRunning(a.executavel);
    if (wasRunning && !fechar) return { precisaFechar: true };
    setBusy(id, 'baixando');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-hdl-'));
    const release = await latestRelease(net.fetch, a.repo);
    log.info(`${id}: instalando a versão ${release.version}${segundoPlano ? ' (automático)' : ''}`);
    const file = path.join(dir, path.basename(release.file));
    await download(net.fetch, release, file, (got, total) => send('progresso', { id, got, total }));
    setBusy(id, 'instalando');
    if (await isRunning(a.executavel)) await kill(a.executavel);
    try {
      await runInstaller(file);
    } catch (err) {
      if (err.exitCode !== 2) throw err;
      // Abortado pelo script: costuma ser arquivo ainda preso. Fecha de novo, espera e repete;
      // se falhar outra vez e o usuário pediu, abre o instalador com telas para mostrar o motivo.
      log.warn(`${id}: instalador interrompido (código 2); tentando de novo`);
      await kill(a.executavel);
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await runInstaller(file);
      } catch (again) {
        if (segundoPlano || again.exitCode !== 2) throw again;
        await runInstaller(file, { silent: false });
      }
    }
    if (wasRunning) launch(a).catch((err) => log.warn(`${id}: não foi possível reabrir (${err.message})`));
    log.info(`${id}: versão ${release.version} instalada`);
    return { versao: release.version };
  } catch (err) {
    log.error(`${id}: falha ao instalar (${err.message})`);
    throw err;
  } finally {
    setBusy(id, null);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
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
  reserve(id, 'desinstalando');
  try {
    const a = await catalogEntry(id);
    const inst = await installedEntry(a);
    if (!inst.uninstall) throw new Error('O Windows não informou como desinstalar este app.');
    if (await isRunning(a.executavel)) await kill(a.executavel);
    await runUninstall(inst.uninstall);
    log.info(`${id}: desinstalado`);
  } catch (err) {
    log.error(`${id}: falha ao desinstalar (${err.message})`);
    throw err;
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
    const apps = await collectState({ fresh: true });
    send('estado', apps);
    const pending = apps.filter((a) => a.atualizacao);
    updateTray(pending.length);
    log.info(`verificação: ${apps.length} app(s), ${pending.length} com atualização${pending.length ? ` (${pending.map((a) => `${a.id} ${a.ultima.versao}`).join(', ')})` : ''}`);
    const auto = readConfig().atualizarSozinho;
    for (const a of pending) {
      // apps abertos não são interrompidos: só avisa
      if (auto && !a.rodando && !busy.has(a.id)) {
        try {
          const r = await install(a.id, { segundoPlano: true });
          if (r.precisaFechar) continue; // foi aberto enquanto procurávamos
          notify(`${a.nome} atualizado`, `Versão ${r.versao} instalada.`);
        } catch (err) {
          // tenta de novo na próxima verificação, mas avisa só uma vez por versão
          notifyOnce(`falha:${a.id}@${a.ultima.versao}`, `Não foi possível atualizar ${a.nome}`, err.message);
        }
        continue;
      }
      notifyOnce(`${a.id}@${a.ultima.versao}`, `Atualização do ${a.nome}`, `A versão ${a.ultima.versao} está disponível. Abra a Central HDL para atualizar.`);
    }
    if (pending.length) send('estado', await collectState());
  } catch (err) {
    log.error(`verificação em segundo plano falhou (${err.message})`);
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
function notifyOnce(key, title, body) {
  if (notified.has(key)) return;
  notified.add(key);
  notify(title, body);
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
    log.info(`Central: versão ${version} baixada, instala ao reiniciar`);
    setSelfStatus({ estado: 'pronta', versao: version });
    notify('Atualização da Central HDL', `A versão ${version} está pronta. Reinicie a Central para instalar.`);
  });
  autoUpdater.on('error', (err) => {
    log.error(`Central: falha na autoatualização (${err?.message ?? err})`);
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
    backgroundColor: '#07090E',
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
handle('estado', (opts) => collectState({ fresh: Boolean(opts?.atualizar) }));
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
handle('abrir-registros', async () => {
  const err = await shell.openPath(log.pasta());
  if (err) throw new Error(err);
});

// ------------------------------------------------------------ ciclo de vida
app.on('second-instance', show);
app.whenReady().then(() => {
  log.info(`Central ${app.getVersion()} iniciada${process.argv.includes(HIDDEN_ARG) ? ' com o Windows' : ''}`);
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
