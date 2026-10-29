// Ponte mínima entre a interface (sem acesso ao Node) e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.erro);
  return r.data;
};

contextBridge.exposeInMainWorld('central', {
  /** atualizar: relê o catálogo do GitHub em vez da cópia em memória. */
  estado: (opts) => call('estado', opts),
  instalar: (id, opts) => call('instalar', id, opts),
  abrir: (id) => call('abrir', id),
  desinstalar: (id) => call('desinstalar', id),
  config: () => call('config'),
  salvarConfig: (cfg) => call('salvar-config', cfg),
  info: () => call('central'),
  verificarCentral: () => call('verificar-central'),
  reiniciar: () => call('reiniciar-central'),
  abrirRegistros: () => call('abrir-registros'),
  /** Conta HDL: a interface recebe só nome, usuário e cor; os tokens ficam no processo principal. */
  conta: () => call('conta'),
  entrar: (email, senha) => call('entrar', email, senha),
  sair: () => call('sair-conta'),
  cadastrar: (dados) => call('cadastrar', dados),
  verificarConta: () => call('verificar-conta'),
  /** Administração da Conta HDL (o banco confere se a pessoa é proprietária ou administradora). */
  pessoas: () => call('pessoas'),
  convidar: (email, papel, tags) => call('convidar', email, papel, tags),
  definirTags: (id, tags) => call('definir-tags', id, tags),
  revogarConvite: (id) => call('revogar-convite', id),
  aprovar: (id) => call('aprovar', id),
  recusar: (id) => call('recusar', id),
  definirCargo: (id, papel) => call('definir-cargo', id, papel),
  removerMembro: (id) => call('remover-membro', id),
  reativar: (id, papel) => call('reativar', id, papel),
  regraApp: (appId, restrito) => call('regra-app', appId, restrito),
  acessoApp: (appId, ids) => call('acesso-app', appId, ids),
  copiar: (texto) => call('copiar', texto),
  /** Eventos: estado, progresso, ocupado, abrindo, central-status, conta. */
  on: (event, fn) => {
    if (!['estado', 'progresso', 'ocupado', 'abrindo', 'central-status', 'conta'].includes(event)) return;
    ipcRenderer.on(event, (_e, payload) => fn(payload));
  },
});
