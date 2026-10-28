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
import { installedPrograms, findInstalled, isRunning, hasWindow, kill, runInstaller, runUninstall } from './lib/windows.js';
import { validateCatalog } from './lib/catalog.js';
import { createLog } from './lib/log.js';
import { entrar, renovar, sair, perfil, cadastrar, rpc } from './lib/conta.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, 'icone.png');
const CATALOG_URL = 'https://raw.githubusercontent.com/hdldev123/central-hdl/main/catalogo.json';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 30 * 1000;
const CATALOG_TTL_MS = 5 * 60 * 1000; // o raw.githubusercontent também guarda cache por uns 5 min
const WINDOW_WAIT_MS = 20 * 1000; // ao abrir um app, quanto esperar pela janela dele
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
        log.warn(`conta: sessão de ${atual.perfil?.usuario ?? '?'} recusada pelo servidor (${err.message}); voltou para a tela de login`);
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
  log.info(`conta: ${p.usuario} entrou (${p.situacao}${p.admin ? ', administrador' : ''})`);
  mudarConta({ ...nova, perfil: p });
  return estadoConta();
}

/** Cria a conta com o convite; ela nasce pendente e a Central mostra a espera pela aprovação. */
async function cadastrarConta(dados) {
  const nova = await cadastrar(net.fetch, SUPABASE, dados ?? {});
  const p = await perfil(net.fetch, SUPABASE, nova.accessToken);
  log.info(`conta: ${p.usuario} criou a conta com convite (${p.situacao})`);
  mudarConta({ ...nova, perfil: p });
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
  if (sessao?.perfil?.situacao && sessao.perfil.situacao !== p.situacao) log.info(`conta: ${p.usuario} passou de ${sessao.perfil.situacao} para ${p.situacao}`);
  if (sessao) mudarConta({ ...sessao, perfil: p });
  return estadoConta();
}

const admin = (nome, args) => comToken((t) => rpc(net.fetch, SUPABASE, t, nome, args));
/** Ação de administração que muda algo: fica no registro (só ids e papel, sem e-mails). */
async function acaoAdmin(nome, args, resumo) {
  const r = await admin(nome, args);
  log.info(`administração: ${sessao?.perfil?.usuario ?? '?'} ${resumo}`);
  return r;
}

async function sairConta() {
  const atual = sessao;
  mudarConta(null);
  if (!atual) return estadoConta();
  log.info(`conta: ${atual.perfil?.usuario ?? '?'} saiu`);
  // com o token vencido o servidor recusaria o logout: renova antes só para encerrar a sessão de vez
  let token = atual.accessToken;
  if (atual.expiraEm - Date.now() < 30 * 1000) token = (await renovar(net.fetch, SUPABASE, atual.refreshToken).catch(() => null))?.accessToken;
  if (token) await sair(net.fetch, SUPABASE, token).catch(() => {}); // sem internet: o servidor descarta quando vencer
  return estadoConta();
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

/** Tags de acesso da conta logada (vazio sem login ou com a conta ainda não ativa). */
const minhasTags = () => (sessao?.perfil?.situacao === 'ativa' ? sessao.perfil.tags ?? [] : []);
/**
 * App sem tag no catálogo é livre; com tag, precisa dela ou do godmod (que o banco só dá a
 * administradores). A Central só esconde: quem garante de verdade é o banco de cada app.
 */
const temAcesso = (a, tags = minhasTags()) => !a.tag || tags.includes(a.tag) || tags.includes('godmod');

/** Estado de cada app: versão instalada, última publicada, se está aberto. fresh: relê o catálogo do GitHub. */
async function collectState({ fresh = false } = {}) {
  const [catalog, programs] = await Promise.all([loadCatalog({ fresh }), installedPrograms()]);
  const apps = await Promise.all((catalog.apps ?? []).map(async (a) => {
    const inst = findInstalled(programs, a.nomeWindows ?? a.nome);
    const acesso = temAcesso(a);
    // sem acesso, só aparece se já estiver instalado (para poder desinstalar)
    if (!acesso && !inst) return null;
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
      executavel: a.executavel,
      // cor de destaque da tela de abertura; só aceita #rrggbb
      cor: /^#[0-9a-f]{6}$/i.test(a.cor ?? '') ? a.cor : null,
      instalada: installed,
      ultima: latest ? { versao: latest.version, data: latest.releaseDate, tamanho: latest.size, notas: latest.notesUrl } : null,
      // quem perdeu o acesso não recebe versões novas
      atualizacao: Boolean(acesso && installed && latest && compareVersions(latest.version, installed) > 0),
      rodando: installed ? await isRunning(a.executavel) : false,
      ocupado: busy.get(a.id) ?? null,
      tag: a.tag ?? null,
      semAcesso: !acesso,
      erro,
    };
  }));
  return apps.filter(Boolean);
}

/** Apps do catálogo que exigem tag, para a seção Pessoas oferecer (ex.: [{ tag: 'fluxo', nome: 'Fluxo' }]). */
async function tagsDoCatalogo() {
  const { apps = [] } = await loadCatalog();
  return apps.filter((a) => a.tag).map((a) => ({ tag: a.tag, nome: a.nome }));
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
    if (!temAcesso(a)) throw new Error(`Você não tem acesso ao ${a.nome}. Peça a um administrador da HDL.`);
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

/**
 * Abre o app e espera a janela dele aparecer. `etapa` recebe cada passo
 * (verificando, iniciando, aguardando) para a tela de abertura mostrar.
 * Sem janela no prazo (app que abre na bandeja ou demorou), resolve com { janela: false }.
 */
async function launch(a, etapa = () => {}) {
  etapa('verificando');
  const inst = await installedEntry(a);
  const exe = path.join(inst.location ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', a.nome), a.executavel);
  if (!fs.existsSync(exe)) throw new Error(`Não encontrei ${a.executavel}. Reinstale o app.`);
  etapa('iniciando');
  const err = await shell.openPath(exe);
  if (err) throw new Error(err);
  etapa('aguardando');
  const limite = Date.now() + WINDOW_WAIT_MS;
  while (Date.now() < limite) {
    if (await hasWindow(a.executavel)) return { janela: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { janela: false };
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
    // relê situação e tags: o que um administrador mudar chega aqui em até 30 min
    if (sessao && !semConexao) await atualizarPerfil().catch(() => {});
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
handle('estado', async (opts) => {
  // "Procurar atualizações" também relê as tags da conta
  if (opts?.atualizar && sessao && !semConexao) await atualizarPerfil().catch(() => {});
  return collectState({ fresh: Boolean(opts?.atualizar) });
});
handle('instalar', (id, opts) => install(String(id), opts ?? {}));
handle('abrir', async (id) => {
  const a = await catalogEntry(String(id));
  return launch(a, (etapa) => send('abrindo', { id: a.id, etapa }));
});
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
  const [pendentes, membros, convites, tags] = await Promise.all([
    admin('list_pending_accounts'), admin('list_hdl_members'), admin('list_account_invites'), tagsDoCatalogo(),
  ]);
  return { pendentes: pendentes?.accounts ?? [], membros: membros?.members ?? [], convites: convites?.invites ?? [], tags };
});
const listaDeTags = (tags) => (Array.isArray(tags) ? tags.map(String).slice(0, 50) : []);
handle('convidar', (email, papel, tags) => acaoAdmin('create_account_invite',
  { p_email: String(email ?? ''), p_role: String(papel ?? 'member'), p_tags: listaDeTags(tags) },
  `criou um convite (${papel}${listaDeTags(tags).length ? `, tags: ${listaDeTags(tags).join(', ')}` : ''})`));
handle('definir-tags', (id, tags) => acaoAdmin('set_account_tags', { p_user: Number(id), p_tags: listaDeTags(tags) },
  `definiu as tags da conta ${id}: ${listaDeTags(tags).join(', ') || '(nenhuma)'}`));
handle('revogar-convite', (id) => acaoAdmin('revoke_account_invite', { p_invite: Number(id) }, `revogou o convite ${id}`));
handle('aprovar', (id) => acaoAdmin('approve_account', { p_user: Number(id) }, `aprovou a conta ${id}`));
handle('recusar', (id) => acaoAdmin('reject_account', { p_user: Number(id) }, `recusou a conta ${id}`));
handle('copiar', (texto) => clipboard.writeText(String(texto ?? '').slice(0, 4000)));

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
