// Interface da Central HDL. Todo conteúdo do catálogo entra como texto (nunca innerHTML).

const api = window.central;
const $ = (id) => document.getElementById(id);
let apps = [];
let filtro = 'todos';
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

function toast(msg, tipo = '') {
  const el = h('div', { class: `toast ${tipo}` }, msg);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

const mb = (n) => (n ? `${(n / 1048576).toFixed(0)} MB` : '');
const data = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '');

function iconeApp(a) {
  const iniciais = a.nome.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const fallback = h('span', { class: 'app-icone' }, iniciais);
  if (!a.icone) return fallback;
  const img = h('img', { class: 'app-icone', src: a.icone, alt: '' });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

function acoes(a) {
  if (a.ocupado) {
    const p = progresso.get(a.id);
    const pct = a.ocupado === 'baixando' && p?.total ? Math.round((p.got / p.total) * 100) : null;
    const rotulo = { preparando: 'Preparando', baixando: 'Baixando', instalando: 'Instalando', desinstalando: 'Desinstalando' }[a.ocupado];
    return h('div', { class: 'progresso' },
      h('div', { class: 'barra' }, h('span', { class: pct === null ? 'indeterminada' : '', style: null })),
      h('small', {}, pct === null ? `${rotulo}…` : `${rotulo}… ${pct}%`));
  }
  if (!a.ultima && !a.instalada) return h('small', { class: 'erro' }, a.erro ?? 'Indisponível');
  const botoes = [];
  if (!a.instalada) botoes.push(h('button', { class: 'btn', onclick: () => instalar(a) }, 'Instalar'));
  if (a.atualizacao) botoes.push(h('button', { class: 'btn', onclick: () => instalar(a) }, 'Atualizar'));
  if (a.instalada) botoes.push(h('button', { class: a.atualizacao ? 'btn btn-sec' : 'btn', onclick: () => executar(() => api.abrir(a.id)) }, 'Abrir'));
  if (a.instalada) botoes.push(h('button', { class: 'icone-btn', title: 'Desinstalar', 'aria-label': `Desinstalar ${a.nome}`, onclick: () => desinstalar(a) }, '✕'));
  return h('div', { class: 'botoes' }, botoes);
}

function cartao(a) {
  const versao = a.instalada
    ? (a.atualizacao ? `Instalado ${a.instalada} → nova ${a.ultima.versao}` : `Instalado · versão ${a.instalada}`)
    : a.ultima ? `Versão ${a.ultima.versao}${a.ultima.tamanho ? ` · ${mb(a.ultima.tamanho)}` : ''}` : '';
  const el = h('article', { class: `app ${a.atualizacao ? 'tem-atualizacao' : ''}` },
    h('div', { class: 'app-cab' }, iconeApp(a),
      h('div', {}, h('h2', {}, a.nome), h('small', {}, a.categoria))),
    h('p', { class: 'app-desc' }, a.descricao),
    h('div', { class: 'app-info' },
      h('span', {}, versao),
      a.rodando ? h('span', { class: 'pilula' }, 'Aberto') : null,
      a.instalada && a.erro ? h('span', { class: 'erro', title: 'Não foi possível consultar a última versão' }, a.erro) : null,
      a.ultima?.notas ? h('a', { href: a.ultima.notas, target: '_blank' }, `Novidades${a.ultima.data ? ` de ${data(a.ultima.data)}` : ''}`) : null),
    acoes(a));
  const p = progresso.get(a.id);
  const span = el.querySelector('.barra span:not(.indeterminada)');
  if (span && p?.total) span.style.width = `${(p.got / p.total) * 100}%`;
  return el;
}

function render() {
  const termo = $('busca').value.trim().toLowerCase();
  const pendentes = apps.filter((a) => a.atualizacao);
  $('n-atualizacoes').hidden = !pendentes.length;
  $('n-atualizacoes').textContent = String(pendentes.length);
  $('atualizar-tudo').hidden = !pendentes.length;
  $('atualizar-tudo').textContent = `Atualizar tudo (${pendentes.length})`;
  const lista = apps
    .filter((a) => filtro === 'todos' || (filtro === 'instalados' ? a.instalada : a.atualizacao))
    .filter((a) => !termo || [a.nome, a.descricao, a.categoria].some((x) => x.toLowerCase().includes(termo)))
    .sort((a, b) => b.atualizacao - a.atualizacao || a.nome.localeCompare(b.nome, 'pt-BR'));
  const vazio = { todos: 'Nenhum aplicativo no catálogo ainda.', instalados: 'Nenhum app da HDL instalado neste computador.', atualizacoes: 'Tudo em dia. 🎉' }[filtro];
  $('lista').replaceChildren(...(lista.length ? lista.map(cartao) : [h('p', { class: 'vazio' }, termo ? 'Nada encontrado.' : vazio)]));
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
api.on('central-status', mostrarStatusCentral);

// ------------------------------------------------------------ atualização da própria Central
const reiniciarCentral = () => executar(() => api.reiniciar());

function mostrarStatusCentral(st) {
  const btn = $('central-atualizar');
  const status = $('central-status');
  const faixa = $('faixa-central');
  btn.hidden = st.estado === 'indisponivel';
  btn.disabled = st.estado === 'verificando' || st.estado === 'baixando';
  btn.classList.toggle('destaque', st.estado === 'pronta');
  btn.textContent = {
    verificando: 'Verificando…',
    baixando: `Baixando ${st.progresso ?? 0}%…`,
    pronta: `Reiniciar e atualizar para ${st.versao}`,
  }[st.estado] ?? 'Procurar atualização da Central';
  status.textContent = {
    'em-dia': '· em dia',
    baixando: `· nova versão ${st.versao}`,
    erro: '· falha ao verificar',
    indisponivel: '· atualização só na versão instalada',
  }[st.estado] ?? '';
  status.title = st.erro ?? '';
  faixa.hidden = st.estado !== 'pronta';
  if (st.estado === 'pronta') {
    faixa.replaceChildren(`Uma nova versão da Central HDL (${st.versao}) está pronta.`,
      h('button', { class: 'btn', onclick: reiniciarCentral }, 'Reiniciar e atualizar'));
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

for (const tab of document.querySelectorAll('[data-filtro]')) {
  tab.addEventListener('click', () => {
    filtro = tab.dataset.filtro;
    for (const t of document.querySelectorAll('[data-filtro]')) t.setAttribute('aria-selected', String(t === tab));
    render();
  });
}
$('busca').addEventListener('input', render);
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

api.info().then((i) => {
  $('versao').textContent = `versão ${i.versao}`;
  mostrarStatusCentral(i.status);
});
atualizarEstado();
