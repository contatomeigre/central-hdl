// Central HDL — loja de aplicativos desktop da HDL Soluções.
//
// Lê o catálogo (catalogo.json no GitHub), descobre a última versão de cada app
// no GitHub Releases, compara com o que está instalado no Windows e instala ou
// atualiza em silêncio. Fica na bandeja e atualiza os apps sozinha.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, net, Notification, safeStorage, clipboard } from 'electron';
import updater from 'electron-updater';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestRelease, download, compareVersions } from './lib/releases.js';
import { installedPrograms, findInstalled, isRunning, kill, runInstaller, runUninstall } from './lib/windows.js';
import { entrar, renovar, sair, perfil, cadastrar, rpc } from './lib/conta.js';

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

// ------------------------------------------------------------ conta HDL
// O mesmo Supabase do Prosa: quem tem conta no Prosa entra com o mesmo e-mail e senha.
// A chave publicável é pública por natureza; quem protege os dados são as regras do banco.
const SUPABASE = {
  url: 'https://uydadfhfqfeapnktwsus.supabase.co',
  chave: 'sb_publishable_ed1TW-T8r7Gx5cWkY89R4w_2nWGSk7g',
};
const CONTA_FILE = () => path.join(app.getPath('userData'), 'conta.bin');
const RENOVAR_ANTES_MS = 5 * 60 * 1000;
const TENTAR_DE_NOVO_MS = 60 * 1000;
const VER_APROVACAO_MS = 30 * 1000;

let sessao = null;          // { accessToken, refreshToken, expiraEm, email, perfil }
let semConexao = false;     // entrou com a sessão salva sem conseguir falar com o servidor
let renovando = null;       // uma renovação por vez: o Supabase derruba a sessão se o mesmo token for usado duas vezes
let timerRenovar = null;
let timerAprovacao = null;  // conta pendente: confere de tempos em tempos se já foi aprovada
let contaCarregada = null;

const estadoConta = () => (sessao ? { logado: true, semConexao, email: sessao.email, ...sessao.perfil } : { logado: false });

// gravada criptografada pelo Windows (DPAPI); sem isso, a sessão vale só até fechar a Central
function guardarSessao() {
  if (!sessao) return fs.rmSync(CONTA_FILE(), { force: true });
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(CONTA_FILE(), safeStorage.encryptString(JSON.stringify(sessao)));
}
function lerSessao() {
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(CONTA_FILE()))); } catch { return null; }
}

function mudarConta(nova, { offline = false } = {}) {
  sessao = nova;
  semConexao = offline;
  guardarSessao();
  agendarRenovacao();
  agendarAprovacao();
  send('conta', estadoConta());
}

function agendarAprovacao() {
  clearTimeout(timerAprovacao);
  if (sessao?.perfil?.situacao !== 'pendente') return;
  timerAprovacao = setTimeout(() => atualizarPerfil().catch(agendarAprovacao), VER_APROVACAO_MS);
}

function agendarRenovacao(ms) {
  clearTimeout(timerRenovar);
  if (!sessao) return;
  timerRenovar = setTimeout(() => renovarSessao().catch(() => {}), ms ?? Math.max(30 * 1000, sessao.expiraEm - Date.now() - RENOVAR_ANTES_MS));
}

/** Renova a sessão. Sem internet, mantém a salva e tenta de novo em 1 min; recusada, sai da conta. */
function renovarSessao() {
  renovando ??= (async () => {
    const atual = sessao;
    try {
      const nova = await renovar(net.fetch, SUPABASE, atual.refreshToken);
      const p = await perfil(net.fetch, SUPABASE, nova.accessToken).catch(() => atual.perfil);
      if (sessao === atual) mudarConta({ ...nova, email: nova.email ?? atual.email, perfil: p });
    } catch (err) {
      if (sessao !== atual) return; // saiu da conta enquanto renovava
      if (err.invalida) {
        console.warn('[central] sessão recusada pelo servidor:', err.message);
        mudarConta(null);
      } else {
        semConexao = true;
        send('conta', estadoConta());
        agendarRenovacao(TENTAR_DE_NOVO_MS);
      }
      throw err;
    } finally {
      renovando = null;
    }
  })();
  return renovando;
}

/** Na abertura: recupera a sessão salva e confere com o servidor (sem internet, entra com ela mesmo assim). */
function carregarConta() {
  contaCarregada ??= (async () => {
    const salva = lerSessao();
    if (!salva?.refreshToken || !salva.perfil) return estadoConta();
    sessao = salva;
    await renovarSessao().catch(() => {});
    return estadoConta();
  })();
  return contaCarregada;
}

async function entrarConta(email, senha) {
  const nova = await entrar(net.fetch, SUPABASE, email, senha);
  let p;
  try {
    p = await perfil(net.fetch, SUPABASE, nova.accessToken);
  } catch (err) {
    await sair(net.fetch, SUPABASE, nova.accessToken).catch(() => {});
    throw err;
  }
  mudarConta({ ...nova, perfil: p });
  return estadoConta();
}

/** Cria a conta com o convite; ela nasce pendente e a Central mostra a espera pela aprovação. */
async function cadastrarConta(dados) {
  const nova = await cadastrar(net.fetch, SUPABASE, dados ?? {});
  mudarConta({ ...nova, perfil: await perfil(net.fetch, SUPABASE, nova.accessToken) });
  return estadoConta();
}

/** Roda fn(token) com um token válido: renova antes se estiver vencendo e tenta de novo uma vez se o servidor recusar. */
async function comToken(fn) {
  if (!sessao) throw new Error('Entre com sua conta HDL.');
  if (sessao.expiraEm - Date.now() < 60 * 1000) await renovarSessao();
  try {
    return await fn(sessao.accessToken);
  } catch (err) {
    if (err.status !== 401 || !sessao) throw err;
    await renovarSessao();
    return fn(sessao.accessToken);
  }
}

/** Relê situação e papel (ex.: a conta pendente foi aprovada). */
async function atualizarPerfil() {
  if (!sessao) return estadoConta();
  const p = await comToken((t) => perfil(net.fetch, SUPABASE, t));
  if (sessao) mudarConta({ ...sessao, perfil: p });
  return estadoConta();
}

const admin = (nome, args) => comToken((t) => rpc(net.fetch, SUPABASE, t, nome, args));

async function sairConta() {
  const atual = sessao;
  mudarConta(null);
  if (!atual) return estadoConta();
  // com o token vencido o servidor recusaria o logout: renova antes só para encerrar a sessão de vez
  let token = atual.accessToken;
  if (atual.expiraEm - Date.now() < 30 * 1000) token = (await renovar(net.fetch, SUPABASE, atual.refreshToken).catch(() => null))?.accessToken;
  if (token) await sair(net.fetch, SUPABASE, token).catch(() => {}); // sem internet: o servidor descarta quando vencer
  return estadoConta();
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
async function install(id, { fechar = false, segundoPlano = false } = {}) {
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
    try {
      await runInstaller(file);
    } catch (err) {
      if (err.exitCode !== 2) throw err;
      // Abortado pelo script: costuma ser arquivo ainda preso. Fecha de novo, espera e repete;
      // se falhar outra vez e o usuário pediu, abre o instalador com telas para mostrar o motivo.
      await kill(a.executavel);
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await runInstaller(file);
      } catch (again) {
        if (segundoPlano || again.exitCode !== 2) throw again;
        await runInstaller(file, { silent: false });
      }
    }
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
          const r = await install(a.id, { segundoPlano: true });
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
handle('conta', () => carregarConta());
handle('entrar', (email, senha) => entrarConta(String(email ?? ''), String(senha ?? '')));
handle('sair-conta', () => sairConta());
handle('cadastrar', (dados) => cadastrarConta({
  email: String(dados?.email ?? ''), codigo: String(dados?.codigo ?? ''), usuario: String(dados?.usuario ?? ''),
  nome: String(dados?.nome ?? ''), senha: String(dados?.senha ?? ''),
}));
handle('verificar-conta', () => atualizarPerfil());
// administração: quem pode é conferido no banco (proprietário ou administrador da organização HDL)
handle('pessoas', async () => {
  const [pendentes, convites] = await Promise.all([admin('list_pending_accounts'), admin('list_account_invites')]);
  return { pendentes: pendentes?.accounts ?? [], convites: convites?.invites ?? [] };
});
handle('convidar', (email, papel) => admin('create_account_invite', { p_email: String(email ?? ''), p_role: String(papel ?? 'member') }));
handle('revogar-convite', (id) => admin('revoke_account_invite', { p_invite: Number(id) }));
handle('aprovar', (id) => admin('approve_account', { p_user: Number(id) }));
handle('recusar', (id) => admin('reject_account', { p_user: Number(id) }));
handle('copiar', (texto) => clipboard.writeText(String(texto ?? '').slice(0, 4000)));

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
