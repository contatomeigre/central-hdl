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

function iconeApp(a, grande = false) {
  const cls = `app-icone${grande ? ' g' : ''}`;
  const iniciais = a.nome.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const fallback = h('span', { class: cls, 'aria-hidden': 'true' }, iniciais);
  if (!a.icone) return fallback;
  const img = h('img', { class: cls, src: a.icone, alt: '' });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

/** Barra de progresso de download/instalação, ou null se o app está livre. */
function barraProgresso(a, compacto = false) {
  if (!a.ocupado) return null;
  const p = progresso.get(a.id);
  const pct = a.ocupado === 'baixando' && p?.total ? Math.round((p.got / p.total) * 100) : null;
  const alvo = a.ultima?.versao ? ` ${a.ultima.versao}` : '';
  const rotulo = {
    baixando: `BAIXANDO${alvo}…`,
    instalando: `INSTALANDO${alvo}…`,
    desinstalando: 'DESINSTALANDO…',
  }[a.ocupado];
  const preenchido = h('span', { class: pct === null ? 'indeterminada' : '' });
  if (pct !== null) preenchido.style.width = `${pct}%`;
  return h('div', { class: `progresso${compacto ? ' compacto' : ''}` },
    h('div', { class: 'progresso-linha' }, h('span', {}, rotulo), pct === null ? null : h('b', {}, String(pct), h('em', {}, '%'))),
    h('div', {
      class: 'barra', role: 'progressbar', 'aria-label': `Progresso de ${a.nome}`,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct === null ? null : String(pct),
    }, preenchido));
}

function botoes(a, { grande = false } = {}) {
  const p = grande ? '' : ' btn-p';
  const lista = [];
  if (!a.instalada && a.ultima) lista.push(h('button', { type: 'button', class: `btn${p}`, onclick: () => instalar(a) }, 'Instalar'));
  if (a.atualizacao) lista.push(h('button', { type: 'button', class: `btn${p}`, onclick: () => instalar(a) }, 'Atualizar'));
  if (a.instalada) lista.push(h('button', { type: 'button', class: `btn${p}${a.atualizacao ? ' btn-sec' : ''}`, onclick: () => abrir(a) }, 'Abrir'));
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
  return h('article', { class: `app${a.atualizacao ? ' tem-atualizacao' : ''}` },
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
  return h('section', { class: 'destaque', 'aria-label': `Atualização do ${a.nome}` },
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

async function atualizarEstado() {
  $('verificar').disabled = true;
  try {
    apps = await api.estado();
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
  if (a) { a.ocupado = 'baixando'; render(); }
});
api.on('ocupado', ({ id, status }) => {
  const a = apps.find((x) => x.id === id);
  if (a) { a.ocupado = status; render(); }
});
api.on('abrindo', ({ id, etapa }) => telasAbertura.get(id)?.etapa(etapa));
api.on('central-status', mostrarStatusCentral);

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
  b.addEventListener('click', () => { filtro = b.dataset.filtro; render(); });
}
$('busca').addEventListener('input', render);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('busca').focus();
    $('busca').select();
  }
});
$('verificar').addEventListener('click', () => { atualizarEstado(); verificarCentral({ avisar: false }); });
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
for (const id of ['cfg-auto', 'cfg-login']) {
  $(id).addEventListener('change', () => executar(() => api.salvarConfig({ atualizarSozinho: $('cfg-auto').checked, iniciarComWindows: $('cfg-login').checked })));
}

// ------------------------------------------------------------ barra de progresso segmentada
/**
 * Barra que avança sozinha: corre até `alvo` e, sem alvo novo, rasteja até `teto`
 * (`ritmo` em ms dita a lentidão). Quem a usa só move alvo e teto conforme as etapas reais.
 */
function medidor(barra, segmentos, aoMudar) {
  const segs = Array.from({ length: segmentos }, () => h('i'));
  barra.replaceChildren(...segs);
  const m = { pct: 0, alvo: 0, teto: 0, ritmo: 900 };
  let antes = performance.now();
  // avança pelo tempo decorrido (e não por quadro), para não depender da taxa de quadros
  const relogio = setInterval(() => {
    const agora = performance.now();
    const dt = Math.min(200, agora - antes);
    antes = agora;
    if (m.pct < m.alvo) m.pct = Math.min(m.alvo, m.pct + Math.max(dt * 0.12, (m.alvo - m.pct) * (1 - Math.exp(-dt / 90))));
    else if (m.pct < m.teto) m.pct = Math.min(m.teto, m.pct + (m.teto - m.pct) * (1 - Math.exp(-dt / m.ritmo)));
    const n = Math.round(m.pct);
    barra.setAttribute('aria-valuenow', String(n));
    aoMudar(n);
    const ligados = Math.round(m.pct / (100 / segmentos));
    segs.forEach((s, i) => s.classList.toggle('on', i < ligados));
  }, 30);
  m.parar = () => clearInterval(relogio);
  return m;
}
const pct3 = (n) => String(n).padStart(3, '0');

// ------------------------------------------------------------ tela de abertura de app
// Modelo único para todos os apps do catálogo: nome, ícone, versão, executável e a
// cor opcional (`cor` no catalogo.json) vêm da entrada do app. As etapas são reais e
// chegam do processo principal pelo evento "abrindo".
const ETAPAS_ABERTURA = {
  verificando: { texto: () => 'Verificando a instalação', ate: 20 },
  iniciando: { texto: (a) => `Iniciando ${a.executavel ?? a.nome}`, ate: 45 },
  aguardando: { texto: (a) => `Aguardando a janela do ${a.nome}`, ate: 100, ritmo: 4000 },
};
const telasAbertura = new Map(); // id -> tela aberta

function anelAbertura() {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const fundo = el('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' });
  fundo.append(el('circle', { cx: 60, cy: 60, r: 57, class: 'orbita' }), el('circle', { cx: 60, cy: 60, r: 50, class: 'trilho' }));
  const giro = el('svg', { viewBox: '0 0 120 120', class: 'giro', 'aria-hidden': 'true' });
  giro.append(el('circle', { cx: 60, cy: 60, r: 50, class: 'arco', transform: 'rotate(-90 60 60)' }), el('circle', { cx: 60, cy: 10, r: 3, class: 'satelite' }));
  return [fundo, giro];
}

function telaAbertura(a) {
  const tituloId = `abertura-${a.id}`;
  const titulo = h('h2', { id: tituloId }, `Abrindo ${a.nome}`);
  const rotulo = h('span', { 'aria-live': 'polite' }, 'PREPARANDO');
  const pct = h('span', {}, '000');
  const barra = h('div', {
    class: 'segmentos', role: 'progressbar', 'aria-label': `Abrindo ${a.nome}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  });
  const etapas = h('ol', { class: 'abertura-etapas mono' });
  const rodape = h('div', { class: 'abertura-rodape' });
  const raiz = h('div', { class: 'abertura', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tituloId, tabindex: '-1' },
    h('div', { class: 'abertura-caixa' },
      ['c1', 'c2', 'c3', 'c4'].map((c) => h('span', { class: `abertura-canto ${c}`, 'aria-hidden': 'true' })),
      h('div', { class: 'abertura-topo mono' }, h('span', {}, 'HDL // INICIAR APLICATIVO'), a.instalada ? h('span', {}, `v${a.instalada}`) : null),
      h('div', { class: 'abertura-anel' }, anelAbertura(), iconeApp(a, true)),
      h('div', { class: 'abertura-titulo' }, titulo, h('small', { class: 'mono' }, [a.categoria, a.executavel].filter(Boolean).join(' · '))),
      etapas,
      h('div', { class: 'abertura-progresso' },
        h('div', { class: 'mono boot-linha' }, rotulo, h('b', {}, pct, h('em', {}, '%'))),
        barra),
      rodape));
  if (a.cor) raiz.style.setProperty('--acento', a.cor);
  const focoAntes = document.activeElement;
  document.body.append(raiz);
  raiz.focus();
  const m = medidor(barra, 24, (n) => { pct.textContent = pct3(n); });

  let atual = null; // etapa em andamento: { res, ate }
  const fecharEtapa = (texto, tipo = '') => {
    if (!atual) return;
    atual.res.className = `res ${tipo}`;
    atual.res.textContent = texto;
    if (tipo !== 'falha') m.alvo = atual.ate;
    atual = null;
  };
  // com o app já aberto as etapas chegam quase juntas: a fila segura cada uma por um
  // instante para a tela não piscar
  let fila = Promise.resolve();
  const passo = (fn) => (fila = fila.then(fn));
  const esc = (e) => { if (e.key === 'Escape') fechar(); };

  function fechar() {
    m.parar();
    document.removeEventListener('keydown', esc);
    telasAbertura.delete(a.id);
    raiz.classList.add('saindo');
    raiz.addEventListener('transitionend', () => raiz.remove(), { once: true });
    setTimeout(() => raiz.remove(), 500);
    if (focoAntes?.isConnected) focoAntes.focus();
  }

  return {
    etapa: (nome) => passo(async () => {
      const def = ETAPAS_ABERTURA[nome];
      if (!def) return;
      fecharEtapa('OK');
      const texto = def.texto(a);
      const res = h('span', { class: 'res rodando' }, '…');
      etapas.append(h('li', {}, h('span', { class: 'seta' }, '›'), h('span', { class: 'txt' }, texto), res));
      rotulo.textContent = texto.toUpperCase();
      atual = { res, ate: def.ate };
      m.teto = def.ate - 4;
      m.ritmo = def.ritmo ?? 900;
      await espera(ETAPA_MIN_MS);
    }),
    /** `janela` false: o app iniciou, mas não mostrou janela no prazo (bandeja ou lentidão). */
    concluir: (janela) => passo(async () => {
      fecharEtapa(janela ? 'OK' : 'SEGUNDO PLANO', janela ? '' : 'aviso');
      m.alvo = 100;
      while (m.pct < 100 && !document.hidden) await espera(30);
      raiz.classList.add('pronta');
      titulo.textContent = janela ? `${a.nome} aberto` : `${a.nome} iniciado`;
      rotulo.textContent = janela ? 'TUDO PRONTO' : 'ABERTO EM SEGUNDO PLANO';
      await espera(janela ? 600 : 1400);
      fechar();
    }),
    falhar: (msg) => passo(async () => {
      fecharEtapa('FALHOU', 'falha');
      m.teto = m.pct;
      raiz.classList.add('falhou');
      titulo.textContent = `Não foi possível abrir o ${a.nome}`;
      rotulo.textContent = 'FALHA AO INICIAR';
      const ok = h('button', { type: 'button', class: 'btn btn-sec', onclick: fechar }, 'Fechar');
      rodape.replaceChildren(h('p', { class: 'abertura-erro', role: 'alert' }, msg), ok);
      document.addEventListener('keydown', esc);
      ok.focus();
    }),
  };
}

async function abrir(a) {
  if (telasAbertura.has(a.id)) return;
  const tela = telaAbertura(a);
  telasAbertura.set(a.id, tela);
  try {
    const r = await api.abrir(a.id);
    await tela.concluir(r?.janela !== false);
    const atual = apps.find((x) => x.id === a.id);
    if (atual && !atual.rodando) { atual.rodando = true; render(); }
  } catch (err) {
    await tela.falhar(err.message);
  }
}

// ------------------------------------------------------------ tela de carregamento
// Cada etapa é uma chamada real; a barra avança devagar enquanto ela roda e
// salta para o fim da faixa da etapa quando ela termina.
const SEGMENTOS = 40;
const ETAPA_MIN_MS = 260; // evita que a tela pisque quando tudo responde rápido

async function carregar() {
  const inicio = performance.now();
  const m = medidor($('boot-barra'), SEGMENTOS, (n) => { $('boot-pct').textContent = pct3(n); });

  const tempo = () => `[${((performance.now() - inicio) / 1000).toFixed(2)}s]`;
  const log = $('boot-log');
  async function etapa(texto, ate, fn) {
    const res = h('span', { class: 'res rodando' }, '…');
    log.append(h('li', {}, h('span', { class: 'ts' }, tempo()), h('span', { class: 'seta' }, '›'), h('span', { class: 'txt' }, texto), res));
    $('boot-etapa').textContent = texto.toUpperCase();
    m.teto = ate - 2;
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
    m.alvo = ate;
    return saida;
  }

  let info = null;
  await etapa('Inicializando núcleo da Central', 12, async () => {
    info = await api.info();
    versaoCentral = info.versao;
    $('boot-versao').textContent = `v${info.versao}`;
    mostrarStatusCentral(info.status);
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

  $('boot-etapa').textContent = carregado?.tipo === 'falha' ? 'ABRINDO A CENTRAL SEM O CATÁLOGO' : 'TUDO PRONTO · ABRINDO A CENTRAL';
  $('boot-frase').textContent = 'ambiente pronto';
  // janela aberta oculta (na bandeja): os temporizadores ficam lentos, então fecha direto
  while (m.pct < 100 && !document.hidden) await espera(30);
  await espera(450);
  m.parar();
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
