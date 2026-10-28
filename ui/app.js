// Interface da Central HDL. Todo conteúdo do catálogo entra como texto (nunca innerHTML).

const api = window.central;
const $ = (id) => document.getElementById(id);
let apps = [];
let filtro = 'todos';
let versaoCentral = '';
const progresso = new Map(); // id -> { got, total }

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Ícone de traço (24×24) a partir dos "d" de cada <path>. */
function svg(...caminhos) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  for (const d of caminhos) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    el.append(p);
  }
  return el;
}
const ICONE = {
  ok: () => svg('M5 12l5 5L20 7'),
  lixeira: () => svg('M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'),
  mais: () => svg('M12 5v14M5 12h14'),
};

function toast(msg, tipo = '') {
  const el = h('div', { class: `toast ${tipo}` }, msg);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

const mb = (n) => (n ? `${(n / 1048576).toFixed(0)} MB` : '');
const data = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '');
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const iniciais = (nome) => nome.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function iconeApp(a, grande = false) {
  const cls = `app-icone${grande ? ' g' : ''}`;
  const fallback = h('span', { class: cls, 'aria-hidden': 'true' }, iniciais(a.nome));
  if (!a.icone) return fallback;
  const img = h('img', { class: cls, src: a.icone, alt: '' });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

/** Porcentagem baixada, ou null quando não há como medir (barra indeterminada). */
function porcentagem(a) {
  const p = progresso.get(a.id);
  return a.ocupado === 'baixando' && p?.total ? Math.round((p.got / p.total) * 100) : null;
}

/** Ajusta a barra e o texto de progresso já desenhados, sem recriar o cartão. */
function pintarProgresso(el, a) {
  const pct = porcentagem(a);
  const alvo = a.ocupado !== 'desinstalando' && a.ultima?.versao ? ` ${a.ultima.versao}` : '';
  const rotulo = { preparando: 'PREPARANDO', baixando: 'BAIXANDO', instalando: 'INSTALANDO', desinstalando: 'DESINSTALANDO' }[a.ocupado];
  el.querySelector('.progresso-linha span').textContent = `${rotulo}${alvo}…`;
  const numero = el.querySelector('.progresso-linha b');
  numero.hidden = pct === null;
  numero.firstChild.nodeValue = String(pct ?? 0);
  const barra = el.querySelector('.barra');
  if (pct === null) barra.removeAttribute('aria-valuenow'); else barra.setAttribute('aria-valuenow', String(pct));
  const preenchido = barra.firstElementChild;
  preenchido.classList.toggle('indeterminada', pct === null);
  preenchido.style.width = pct === null ? '' : `${pct}%`;
}

/** Barra de progresso de download/instalação, ou null se o app está livre. */
function barraProgresso(a, compacto = false) {
  if (!a.ocupado) return null;
  const el = h('div', { class: `progresso${compacto ? ' compacto' : ''}` },
    h('div', { class: 'progresso-linha' }, h('span'), h('b', {}, '0', h('em', {}, '%'))),
    h('div', { class: 'barra', role: 'progressbar', 'aria-label': `Progresso de ${a.nome}`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span')));
  pintarProgresso(el, a);
  return el;
}

function botoes(a, { grande = false } = {}) {
  const p = grande ? '' : ' btn-p';
  const lista = [];
  if (!a.instalada && a.ultima) lista.push(h('button', { type: 'button', class: `btn${p}`, onclick: () => instalar(a) }, 'Instalar'));
  if (a.atualizacao) lista.push(h('button', { type: 'button', class: `btn${p}`, onclick: () => instalar(a) }, 'Atualizar'));
  if (a.instalada) lista.push(h('button', { type: 'button', class: `btn${p}${a.atualizacao ? ' btn-sec' : ''}`, onclick: () => executar(() => api.abrir(a.id)) }, 'Abrir'));
  if (a.instalada) lista.push(h('button', { type: 'button', class: 'icone-btn', title: 'Desinstalar', 'aria-label': `Desinstalar ${a.nome}`, onclick: () => desinstalar(a) }, ICONE.lixeira()));
  return h('div', { class: 'botoes' }, lista);
}

function estadoApp(a) {
  if (a.rodando) return h('span', { class: 'estado' }, h('i', { class: 'ponto pulsa' }), 'Aberto agora');
  if (a.atualizacao) return h('span', { class: 'estado ambar' }, h('i', { class: 'ponto ambar' }), 'Atualização disponível');
  if (a.instalada) return h('span', { class: 'estado' }, h('i', { class: 'ponto' }), 'Instalado');
  if (!a.ultima) return h('span', { class: 'estado erro' }, h('i', { class: 'ponto perigo' }), a.erro ?? 'Indisponível');
  return h('span', { class: 'estado neutro' }, h('i', { class: 'ponto' }), a.ultima.tamanho ? `Não instalado · ${mb(a.ultima.tamanho)}` : 'Não instalado');
}

function cartao(a) {
  const versao = a.instalada ?? a.ultima?.versao;
  return h('article', { class: `app${a.atualizacao ? ' tem-atualizacao' : ''}`, 'data-id': a.id },
    h('div', { class: 'app-cab' }, iconeApp(a),
      h('div', {}, h('h3', {}, a.nome), h('small', {}, a.categoria)),
      versao ? h('span', { class: 'v' }, `v${versao}`) : null),
    h('p', { class: 'app-desc' }, a.descricao),
    a.instalada && a.erro ? h('span', { class: 'erro', title: 'Não foi possível consultar a última versão' }, a.erro) : null,
    a.ocupado
      ? barraProgresso(a, true)
      : h('div', { class: 'app-rodape' }, estadoApp(a), botoes(a)));
}

/** Painel grande no topo para cada app com atualização pendente. */
function destaque(a) {
  const novidades = a.ultima?.notas
    ? h('a', { href: a.ultima.notas, target: '_blank' }, `Novidades${a.ultima.data ? ` de ${data(a.ultima.data)}` : ''} →`)
    : null;
  return h('section', { class: 'destaque', 'aria-label': `Atualização do ${a.nome}`, 'data-id': a.id },
    h('div', { class: 'destaque-info' }, iconeApp(a, true),
      h('div', { class: 'destaque-txt' },
        h('div', { class: 'destaque-tit' },
          h('h2', {}, a.nome),
          h('span', { class: 'etiqueta' }, a.categoria),
          h('span', { class: 'etiqueta versao' }, `${a.instalada} → ${a.ultima.versao}`)),
        h('p', {}, a.descricao),
        novidades)),
    h('div', { class: 'destaque-acao' },
      a.ocupado ? barraProgresso(a) : [estadoApp(a), botoes(a, { grande: true })]));
}

function vazio(titulo, texto) {
  return h('div', { class: 'vazio-caixa' }, ICONE.ok(), h('h2', {}, titulo), h('p', {}, texto));
}

const TITULOS = {
  todos: ['CATÁLOGO HDL', 'Todos os aplicativos'],
  instalados: ['NESTE COMPUTADOR', 'Instalados'],
  atualizacoes: ['MANUTENÇÃO', 'Atualizações'],
  pessoas: ['ADMINISTRAÇÃO', 'Pessoas'],
};

function render() {
  const termo = $('busca').value.trim().toLowerCase();
  const pendentes = apps.filter((a) => a.atualizacao);
  const instalados = apps.filter((a) => a.instalada);

  $('n-todos').textContent = apps.length ? String(apps.length) : '';
  $('n-instalados').textContent = instalados.length ? String(instalados.length) : '';
  $('n-atualizacoes').hidden = !pendentes.length;
  $('n-atualizacoes').textContent = String(pendentes.length);
  $('atualizar-tudo').hidden = !pendentes.length;
  $('atualizar-tudo').querySelector('span').textContent = `Atualizar tudo (${pendentes.length})`;
  $('tudo-em-dia').hidden = Boolean(pendentes.length) || !instalados.length;
  $('chip-instalados').textContent = plural(instalados.length, 'instalado', 'instalados');
  $('chip-atualizacoes').textContent = plural(pendentes.length, 'atualização', 'atualizações');
  $('chip-atualizacoes').classList.toggle('ambar', pendentes.length > 0);

  const [sobrancelha, titulo] = TITULOS[filtro];
  $('sobrancelha').textContent = `// ${sobrancelha}`;
  $('titulo').textContent = titulo;
  for (const b of document.querySelectorAll('[data-filtro]')) {
    if (b.dataset.filtro === filtro) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }

  // Pessoas (administração) troca o catálogo inteiro pela lista de contas e convites
  const naPessoas = filtro === 'pessoas';
  $('pessoas').hidden = !naPessoas;
  document.querySelector('.ferramentas').hidden = naPessoas;
  document.querySelector('.chips').hidden = naPessoas;
  $('destaques').hidden = naPessoas;
  if (naPessoas) {
    $('biblioteca').hidden = true;
    renderPessoas();
    return;
  }

  const busca = (a) => !termo || [a.nome, a.descricao, a.categoria].some((x) => x.toLowerCase().includes(termo));
  const ordem = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');

  // destaques: atualizações pendentes, nas abas Todos e Atualizações
  const comDestaque = filtro === 'instalados' ? [] : pendentes.filter(busca).sort(ordem);
  const paineis = comDestaque.map(destaque);
  if (filtro === 'atualizacoes' && !paineis.length) {
    paineis.push(termo
      ? vazio('Nada encontrado', 'Nenhuma atualização corresponde à busca.')
      : vazio('Tudo em dia', 'Seus aplicativos HDL estão na versão mais recente.'));
  }
  $('destaques').replaceChildren(...paineis);

  $('biblioteca').hidden = filtro === 'atualizacoes';
  if (filtro === 'atualizacoes') return;
  const lista = apps
    .filter((a) => filtro === 'todos' || a.instalada)
    .filter(busca)
    .sort((a, b) => b.atualizacao - a.atualizacao || ordem(a, b));
  const cartoes = lista.map(cartao);
  if (filtro === 'todos' && !termo) {
    cartoes.push(h('article', { class: 'em-breve' }, h('div', {}, ICONE.mais()), h('b', {}, 'EM BREVE'), h('span', {}, 'Novos softwares HDL aparecem aqui')));
  } else if (!lista.length) {
    cartoes.push(termo
      ? vazio('Nada encontrado', `Nenhum aplicativo corresponde a “${$('busca').value.trim()}”.`)
      : vazio('Nenhum app instalado', 'Instale um aplicativo HDL na aba Todos os apps.'));
  }
  $('lista').replaceChildren(...cartoes);
}

/** atualizar: relê o catálogo do GitHub (botão "Procurar atualizações"). */
async function atualizarEstado({ atualizar = false } = {}) {
  $('verificar').disabled = true;
  try {
    apps = await api.estado({ atualizar });
    render();
  } catch (err) {
    toast(err.message, 'erro');
  } finally {
    $('verificar').disabled = false;
  }
}

async function executar(fn) {
  try { await fn(); } catch (err) { toast(err.message, 'erro'); }
}

async function instalar(a, { silencioso = false } = {}) {
  try {
    let r = await api.instalar(a.id);
    if (r.precisaFechar) {
      if (!confirm(`${a.nome} está aberto. Ele será fechado para atualizar e reaberto em seguida. Continuar?`)) return;
      r = await api.instalar(a.id, { fechar: true });
    }
    if (!silencioso) toast(`${a.nome} ${a.instalada ? 'atualizado' : 'instalado'} (versão ${r.versao}).`);
  } catch (err) {
    toast(`${a.nome}: ${err.message}`, 'erro');
  } finally {
    progresso.delete(a.id);
    await atualizarEstado();
  }
}

async function desinstalar(a) {
  if (!confirm(`Desinstalar ${a.nome} deste computador?`)) return;
  await executar(async () => { await api.desinstalar(a.id); toast(`${a.nome} foi desinstalado.`); });
  await atualizarEstado();
}

// ------------------------------------------------------------ eventos
api.on('estado', (lista) => { apps = lista; render(); });
api.on('progresso', ({ id, got, total }) => {
  progresso.set(id, { got, total });
  const a = apps.find((x) => x.id === id);
  if (!a) return;
  if (a.ocupado !== 'baixando') { a.ocupado = 'baixando'; render(); return; }
  // chega a cada 150 ms: só a barra muda, sem recriar a lista (que tiraria o foco dos botões)
  for (const el of document.querySelectorAll(`[data-id="${CSS.escape(id)}"] .progresso`)) pintarProgresso(el, a);
});
api.on('ocupado', ({ id, status }) => {
  const a = apps.find((x) => x.id === id);
  if (a) { a.ocupado = status; render(); }
});
api.on('central-status', mostrarStatusCentral);
api.on('conta', mostrarConta);

// ------------------------------------------------------------ conta HDL
let conta = { logado: false };
let bootTerminou = false;
let painelEntrada = 'entrar'; // sem sessão: 'entrar' ou 'cadastro'
let timerPessoas = null;

const ehAdmin = (c) => Boolean(c.logado && c.situacao === 'ativa' && c.admin);

function mostrarConta(c) {
  const eraAdmin = ehAdmin(conta);
  conta = c;
  $('conta-card').hidden = !c.logado;
  if (c.logado) {
    $('conta-nome').textContent = c.nome;
    $('conta-nome').title = c.nome;
    $('conta-usuario').textContent = c.semConexao ? 'sem conexão' : `@${c.usuario}`;
    $('conta-usuario').classList.toggle('ambar', Boolean(c.semConexao));
    $('conta-usuario').title = c.semConexao ? 'Sem conexão com o servidor da HDL. Você continua com a sessão salva; ela é renovada quando a internet voltar.' : (c.email ?? '');
    const avatar = $('conta-avatar');
    avatar.textContent = iniciais(c.nome);
    avatar.style.backgroundColor = c.cor ?? '';
  }
  const admin = ehAdmin(c);
  $('secao-admin').hidden = !admin;
  if (admin && !eraAdmin) {
    atualizarPessoas();
    timerPessoas = setInterval(atualizarPessoas, 2 * 60 * 1000);
  } else if (!admin) {
    clearInterval(timerPessoas);
    if (filtro === 'pessoas') { filtro = 'todos'; render(); }
  }
  atualizarEntrada();
}

/** Mostra a tela certa por cima da Central: entrar, criar conta, ou a conta aguardando aprovação. */
function atualizarEntrada() {
  if (!bootTerminou) return; // durante a tela de carregamento quem decide é o fim do carregar()
  const tela = $('entrada');
  const situacao = conta.logado ? conta.situacao ?? 'ativa' : null;
  const mostrar = !conta.logado || situacao !== 'ativa';
  const antes = tela.hidden ? null : tela.dataset.painel;
  tela.hidden = !mostrar;
  $('casca').inert = mostrar;
  if (!mostrar) return;
  const painel = conta.logado ? 'situacao' : painelEntrada;
  tela.dataset.painel = painel;
  $('entrada-versao').textContent = versaoCentral ? `v${versaoCentral}` : '';
  $('form-entrar').hidden = painel !== 'entrar';
  $('form-cadastro').hidden = painel !== 'cadastro';
  $('painel-situacao').hidden = painel !== 'situacao';
  if (painel === 'situacao') preencherSituacao(situacao);
  if (antes === painel) return; // mesma tela: não apaga o que a pessoa digitou nem tira o foco
  if (painel === 'entrar') {
    $('entrada-senha').value = '';
    erroEntrada('');
    $('entrada-email').focus();
  } else if (painel === 'cadastro') {
    erroCampo('cad-erro', '');
    $('cad-email').focus();
  } else {
    $(situacao === 'pendente' ? 'situacao-verificar' : 'situacao-sair').focus();
  }
}

function preencherSituacao(situacao) {
  const pendente = situacao === 'pendente';
  $('situacao-icone').className = `situacao-icone${pendente ? ' ambar' : ' perigo'}`;
  $('situacao-icone').replaceChildren(pendente
    ? svg('M6 2h12M6 22h12', 'M7 2c0 5 5 6 5 10s-5 5-5 10M17 2c0 5-5 6-5 10s5 5 5 10')
    : svg('M18 6 6 18', 'M6 6l12 12'));
  $('situacao-sobrancelha').textContent = pendente ? '// AGUARDANDO APROVAÇÃO' : '// ACESSO NÃO APROVADO';
  $('situacao-titulo').textContent = pendente ? `Quase lá, ${conta.nome.split(/\s+/)[0]}` : 'Acesso não aprovado';
  $('situacao-texto').textContent = pendente
    ? 'Sua conta foi criada. Um administrador da HDL precisa aprovar o acesso; a Central confere sozinha a cada 30 segundos e libera tudo assim que for aprovado.'
    : 'Um administrador da HDL não aprovou esta conta. Se achar que é um engano, fale com ele.';
  $('situacao-verificar').hidden = !pendente;
}

function erroCampo(id, msg) {
  $(id).hidden = !msg;
  $(id).textContent = msg;
}
const erroEntrada = (msg) => erroCampo('entrada-erro', msg);

/** Botão de envio ocupado enquanto fn roda; o erro aparece na caixa indicada. */
async function enviando(botao, rotulo, erroId, fn) {
  const original = botao.textContent;
  erroCampo(erroId, '');
  botao.disabled = true;
  botao.textContent = rotulo;
  try {
    await fn();
  } catch (err) {
    erroCampo(erroId, err.message);
  } finally {
    botao.disabled = false;
    botao.textContent = original;
  }
}

$('form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const botao = $('entrada-botao');
  erroEntrada('');
  botao.disabled = true;
  botao.textContent = 'Entrando…';
  try {
    mostrarConta(await api.entrar($('entrada-email').value, $('entrada-senha').value));
    $('entrada-senha').value = '';
    toast(`Olá, ${conta.nome}!`);
  } catch (err) {
    erroEntrada(err.message);
    $('entrada-senha').select();
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
});
$('esqueci').addEventListener('click', () => {
  const txt = $('esqueci-txt');
  txt.hidden = !txt.hidden;
  $('esqueci').setAttribute('aria-expanded', String(!txt.hidden));
});
$('ir-cadastro').addEventListener('click', () => { painelEntrada = 'cadastro'; atualizarEntrada(); });
$('ir-entrar').addEventListener('click', () => { painelEntrada = 'entrar'; atualizarEntrada(); });
$('form-cadastro').addEventListener('submit', (e) => {
  e.preventDefault();
  enviando($('cad-botao'), 'Criando conta…', 'cad-erro', async () => {
    mostrarConta(await api.cadastrar({
      email: $('cad-email').value, codigo: $('cad-codigo').value, nome: $('cad-nome').value,
      usuario: $('cad-usuario').value, senha: $('cad-senha').value,
    }));
    $('cad-senha').value = '';
    $('cad-codigo').value = '';
  });
});
$('situacao-verificar').addEventListener('click', () => executar(async () => {
  $('situacao-verificar').disabled = true;
  try {
    mostrarConta(await api.verificarConta());
    if (conta.situacao === 'pendente') toast('Ainda aguardando a aprovação de um administrador.');
    else if (conta.situacao === 'ativa') toast(`Acesso aprovado. Bem-vindo, ${conta.nome}!`);
  } finally {
    $('situacao-verificar').disabled = false;
  }
}));
const sairDaConta = () => executar(async () => {
  painelEntrada = 'entrar';
  mostrarConta(await api.sair());
});
$('sair').addEventListener('click', sairDaConta);
$('situacao-sair').addEventListener('click', sairDaConta);

// ------------------------------------------------------------ pessoas (administração)
const PAPEIS = { owner: 'Proprietário', admin: 'Administrador', member: 'Membro', guest: 'Convidado' };
const ESTADOS_CONVITE = { open: ['Em aberto', 'ciano'], accepted: ['Aceito', 'ok'], expired: ['Vencido', 'neutro'], revoked: ['Revogado', 'neutro'] };
let pessoas = { pendentes: [], convites: [], erro: null, carregado: false };

async function atualizarPessoas() {
  if (!ehAdmin(conta)) return;
  try {
    pessoas = { ...(await api.pessoas()), erro: null, carregado: true };
  } catch (err) {
    pessoas = { ...pessoas, erro: err.message, carregado: true };
  }
  const n = pessoas.pendentes.length;
  $('n-pendentes').hidden = !n;
  $('n-pendentes').textContent = String(n);
  if (filtro === 'pessoas') renderPessoas();
}

function avatarDe(nome, cor) {
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, iniciais(nome));
  if (/^#[0-9a-f]{6}$/i.test(cor ?? '')) el.style.backgroundColor = cor;
  return el;
}

function renderPessoas() {
  erroCampo('pessoas-erro', pessoas.erro ?? '');
  const pendentes = pessoas.pendentes.map((p) => h('article', { class: 'pessoa' },
    avatarDe(p.displayName, p.avatarColor),
    h('div', { class: 'pessoa-txt' },
      h('b', {}, p.displayName),
      h('small', {}, `@${p.username} · ${p.email}`),
      h('small', {}, `Convidado${p.invitedBy ? ` por ${p.invitedBy}` : ''} como ${PAPEIS[p.invitedRole] ?? 'Membro'} · conta criada em ${data(p.createdAt)}`)),
    h('div', { class: 'botoes' },
      h('button', { type: 'button', class: 'btn btn-p', onclick: () => aprovar(p) }, 'Aprovar'),
      h('button', { type: 'button', class: 'btn btn-p btn-sec', onclick: () => recusar(p) }, 'Recusar'))));
  $('lista-pendentes').replaceChildren(...(pendentes.length ? pendentes
    : [h('p', { class: 'pessoas-vazio' }, pessoas.carregado ? 'Ninguém aguardando aprovação.' : 'Carregando…')]));

  const convites = pessoas.convites.map((i) => {
    const [rotulo, cls] = ESTADOS_CONVITE[i.state] ?? [i.state, 'neutro'];
    return h('article', { class: 'pessoa convite' },
      h('div', { class: 'pessoa-txt' },
        h('b', {}, i.email),
        h('small', {}, `${PAPEIS[i.role] ?? i.role} · criado por ${i.createdBy ?? '—'} em ${data(i.createdAt)}${i.state === 'open' ? ` · vale até ${data(i.expiresAt)}` : ''}`)),
      h('span', { class: `etiqueta-estado ${cls}` }, rotulo),
      i.state === 'open' ? h('button', { type: 'button', class: 'btn btn-p btn-sec', onclick: () => revogar(i) }, 'Revogar') : null);
  });
  $('lista-convites').replaceChildren(...(convites.length ? convites
    : [h('p', { class: 'pessoas-vazio' }, pessoas.carregado ? 'Nenhum convite nos últimos 30 dias.' : 'Carregando…')]));
}

const aprovar = (p) => executar(async () => {
  await api.aprovar(p.id);
  toast(`${p.displayName} foi aprovado e entrou na HDL.`);
  await atualizarPessoas();
});
const recusar = (p) => executar(async () => {
  if (!confirm(`Recusar o acesso de ${p.displayName} (${p.email})?`)) return;
  await api.recusar(p.id);
  toast(`O acesso de ${p.displayName} foi recusado.`);
  await atualizarPessoas();
});
const revogar = (i) => executar(async () => {
  if (!confirm(`Revogar o convite de ${i.email}? O código deixa de valer na hora.`)) return;
  await api.revogarConvite(i.id);
  toast('Convite revogado.');
  await atualizarPessoas();
});

let mensagemConvite = '';
$('btn-convidar').addEventListener('click', () => {
  $('form-convite').hidden = false;
  $('convite-pronto').hidden = true;
  $('convite-email').value = '';
  $('convite-papel').value = 'member';
  // só o proprietário pode convidar administradores (o banco também confere)
  const opAdmin = $('convite-papel').querySelector('[value="admin"]');
  opAdmin.hidden = opAdmin.disabled = conta.papel !== 'owner';
  erroCampo('convite-erro', '');
  $('dlg-convite').showModal();
  $('convite-email').focus();
});
$('convite-cancelar').addEventListener('click', () => $('dlg-convite').close());
$('form-convite').addEventListener('submit', (e) => {
  e.preventDefault();
  enviando($('convite-gerar'), 'Gerando…', 'convite-erro', async () => {
    const { invite, code } = await api.convidar($('convite-email').value, $('convite-papel').value);
    const validade = data(invite.expiresAt);
    $('convite-para').textContent = `Para ${invite.email}, como ${PAPEIS[invite.role] ?? invite.role}. Vale até ${validade} e só pode ser usado uma vez.`;
    $('convite-codigo').textContent = code;
    mensagemConvite = [
      'Você foi convidado para a Central HDL, a plataforma de aplicativos da HDL.',
      '',
      '1. Baixe e instale a Central: https://github.com/contatomeigre/central-hdl/releases/latest',
      '2. Abra a Central e clique em "Criar minha conta".',
      `3. Use o e-mail ${invite.email} e o código ${code}.`,
      '',
      `O convite vale até ${validade}. Depois de criar a conta, aguarde a aprovação de um administrador.`,
    ].join('\n');
    $('form-convite').hidden = true;
    $('convite-pronto').hidden = false;
    $('convite-copiar').focus();
    atualizarPessoas();
  });
});
$('convite-copiar').addEventListener('click', () => executar(async () => {
  await api.copiar(mensagemConvite);
  toast('Mensagem copiada. Cole no WhatsApp ou no e-mail.');
}));
$('convite-ok').addEventListener('click', () => $('dlg-convite').close());

// ------------------------------------------------------------ atualização da própria Central
const reiniciarCentral = () => executar(() => api.reiniciar());

function mostrarStatusCentral(st) {
  const btn = $('central-atualizar');
  btn.hidden = st.estado === 'indisponivel';
  btn.disabled = st.estado === 'verificando' || st.estado === 'baixando';
  btn.classList.toggle('destaque', st.estado === 'pronta');
  btn.textContent = {
    verificando: 'Verificando…',
    baixando: `Baixando ${st.progresso ?? 0}%…`,
    pronta: 'Reiniciar e atualizar',
  }[st.estado] ?? 'Procurar atualização da Central';
  $('central-status').textContent = {
    'em-dia': 'Você está na versão mais recente.',
    verificando: 'Procurando uma versão nova…',
    baixando: `Baixando a versão ${st.versao}.`,
    pronta: `A versão ${st.versao} está pronta para instalar.`,
    erro: 'Não foi possível verificar.',
    indisponivel: 'Atualização só na versão instalada.',
  }[st.estado] ?? '';
  $('central-status').title = st.erro ?? '';
  const ponto = $('central-ponto');
  ponto.classList.toggle('ambar', st.estado === 'baixando' || st.estado === 'pronta');
  ponto.classList.toggle('perigo', st.estado === 'erro');
  ponto.classList.toggle('pulsa', st.estado === 'verificando' || st.estado === 'baixando' || st.estado === 'em-dia');
  $('marca-versao').textContent = `v${versaoCentral}${{ 'em-dia': ' · em dia', pronta: ' · nova versão', baixando: ' · nova versão' }[st.estado] ?? ''}`;

  const faixa = $('faixa-central');
  faixa.hidden = st.estado !== 'pronta';
  if (st.estado === 'pronta') {
    faixa.replaceChildren(h('span', {}, `Uma nova versão da Central HDL (${st.versao}) está pronta.`),
      h('button', { type: 'button', class: 'btn', onclick: reiniciarCentral }, 'Reiniciar e atualizar'));
  }
}

async function verificarCentral({ avisar = true } = {}) {
  try {
    const st = await api.verificarCentral();
    mostrarStatusCentral(st);
    if (!avisar) return;
    if (st.estado === 'em-dia') toast('A Central HDL já está na versão mais recente.');
    else if (st.estado === 'erro') toast(st.erro, 'erro');
  } catch (err) {
    toast(err.message, 'erro');
  }
}

for (const b of document.querySelectorAll('[data-filtro]')) {
  b.addEventListener('click', () => {
    filtro = b.dataset.filtro;
    render();
    if (filtro === 'pessoas') atualizarPessoas();
  });
}
$('busca').addEventListener('input', render);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('busca').focus();
    $('busca').select();
  }
});
$('verificar').addEventListener('click', () => { atualizarEstado({ atualizar: true }); verificarCentral({ avisar: false }); });
$('central-atualizar').addEventListener('click', () => {
  if ($('central-atualizar').classList.contains('destaque')) reiniciarCentral();
  else verificarCentral();
});
$('atualizar-tudo').addEventListener('click', async () => {
  for (const a of apps.filter((x) => x.atualizacao)) await instalar(a, { silencioso: true });
  toast('Atualizações concluídas.');
});

$('abrir-config').addEventListener('click', async () => {
  const cfg = await api.config();
  $('cfg-auto').checked = cfg.atualizarSozinho;
  $('cfg-login').checked = cfg.iniciarComWindows;
  $('config').showModal();
});
$('abrir-registros').addEventListener('click', () => executar(() => api.abrirRegistros()));
for (const id of ['cfg-auto', 'cfg-login']) {
  $(id).addEventListener('change', () => executar(() => api.salvarConfig({ atualizarSozinho: $('cfg-auto').checked, iniciarComWindows: $('cfg-login').checked })));
}

// ------------------------------------------------------------ tela de carregamento
// Cada etapa é uma chamada real; a barra avança devagar enquanto ela roda e
// salta para o fim da faixa da etapa quando ela termina.
const SEGMENTOS = 40;
const ETAPA_MIN_MS = 260; // evita que a tela pisque quando tudo responde rápido

async function carregar() {
  const inicio = performance.now();
  const barra = $('boot-barra');
  const segs = Array.from({ length: SEGMENTOS }, () => h('i'));
  barra.replaceChildren(...segs);
  let pct = 0;
  let alvo = 0;
  let teto = 0;
  let antes = performance.now();

  // avança pelo tempo decorrido (e não por quadro), para não depender da taxa de quadros
  const relogio = setInterval(() => {
    const agora = performance.now();
    const dt = Math.min(200, agora - antes);
    antes = agora;
    // aproxima do alvo; sem alvo novo, rasteja até o teto da etapa
    if (pct < alvo) pct = Math.min(alvo, pct + Math.max(dt * 0.12, (alvo - pct) * (1 - Math.exp(-dt / 90))));
    else if (pct < teto) pct = Math.min(teto, pct + (teto - pct) * (1 - Math.exp(-dt / 900)));
    const n = Math.round(pct);
    $('boot-pct').textContent = String(n).padStart(3, '0');
    barra.setAttribute('aria-valuenow', String(n));
    const ligados = Math.round(pct / (100 / SEGMENTOS));
    segs.forEach((s, i) => s.classList.toggle('on', i < ligados));
  }, 30);

  const tempo = () => `[${((performance.now() - inicio) / 1000).toFixed(2)}s]`;
  const log = $('boot-log');
  async function etapa(texto, ate, fn) {
    const res = h('span', { class: 'res rodando' }, '…');
    log.append(h('li', {}, h('span', { class: 'ts' }, tempo()), h('span', { class: 'seta' }, '›'), h('span', { class: 'txt' }, texto), res));
    $('boot-etapa').textContent = texto.toUpperCase();
    teto = ate - 2;
    const t0 = performance.now();
    let saida;
    try {
      saida = await fn();
    } catch {
      saida = { texto: 'FALHOU', tipo: 'falha' };
    }
    const resto = ETAPA_MIN_MS - (performance.now() - t0);
    if (resto > 0) await espera(resto);
    res.className = `res ${saida?.tipo ?? ''}`;
    res.textContent = saida?.texto ?? 'OK';
    alvo = ate;
    return saida;
  }

  let info = null;
  await etapa('Inicializando núcleo da Central', 12, async () => {
    info = await api.info();
    versaoCentral = info.versao;
    $('boot-versao').textContent = `v${info.versao}`;
    mostrarStatusCentral(info.status);
  });
  await etapa('Verificando sua conta HDL', 24, async () => {
    mostrarConta(await api.conta());
    if (!conta.logado) return { texto: 'ENTRAR', tipo: 'aviso' };
    if (conta.situacao === 'pendente') return { texto: 'AGUARDANDO APROVAÇÃO', tipo: 'aviso' };
    if (conta.situacao === 'recusada') return { texto: 'NÃO APROVADA', tipo: 'falha' };
    return conta.semConexao ? { texto: 'SEM CONEXÃO', tipo: 'aviso' } : { texto: 'CONECTADO' };
  });
  const carregado = await etapa('Sincronizando catálogo do repositório HDL', 78, async () => {
    apps = await api.estado();
    return { texto: plural(apps.length, 'APP', 'APPS') };
  });
  await etapa('Procurando atualizações', 92, async () => {
    if (carregado?.tipo === 'falha') return { texto: 'IGNORADO', tipo: 'aviso' };
    const n = apps.filter((a) => a.atualizacao).length;
    return n ? { texto: `${n} ${n === 1 ? 'ENCONTRADA' : 'ENCONTRADAS'}`, tipo: 'aviso' } : { texto: 'EM DIA' };
  });
  await etapa('Preparando interface', 100, async () => {
    render();
    return { texto: 'PRONTO' };
  });

  $('boot-etapa').textContent = !conta.logado ? 'ENTRE COM SUA CONTA HDL'
    : conta.situacao === 'pendente' ? 'CONTA AGUARDANDO APROVAÇÃO'
    : carregado?.tipo === 'falha' ? 'ABRINDO A CENTRAL SEM O CATÁLOGO' : 'TUDO PRONTO · ABRINDO A CENTRAL';
  $('boot-frase').textContent = 'ambiente pronto';
  // janela aberta oculta (na bandeja): os temporizadores ficam lentos, então fecha direto
  while (pct < 100 && !document.hidden) await espera(30);
  await espera(450);
  clearInterval(relogio);
  // a tela de entrada fica por baixo da de carregamento, que some por cima dela
  bootTerminou = true;
  atualizarEntrada();
  const boot = $('boot');
  boot.classList.add('saindo');
  boot.addEventListener('transitionend', () => boot.remove(), { once: true });
  setTimeout(() => boot.remove(), 600);
  if (carregado?.tipo === 'falha') {
    toast('Não foi possível carregar o catálogo. Verifique a internet e use "Procurar atualizações".', 'erro');
  }
}

render();
carregar();
