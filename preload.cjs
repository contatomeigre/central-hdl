// Ponte mínima entre a interface (sem acesso ao Node) e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.erro);
  return r.data;
};

contextBridge.exposeInMainWorld('central', {
  estado: () => call('estado'),
  instalar: (id, opts) => call('instalar', id, opts),
  abrir: (id) => call('abrir', id),
  desinstalar: (id) => call('desinstalar', id),
  config: () => call('config'),
  salvarConfig: (cfg) => call('salvar-config', cfg),
  info: () => call('central'),
  verificarCentral: () => call('verificar-central'),
  reiniciar: () => call('reiniciar-central'),
  /** Conta HDL: a interface recebe só nome, usuário e cor; os tokens ficam no processo principal. */
  conta: () => call('conta'),
  entrar: (email, senha) => call('entrar', email, senha),
  sair: () => call('sair-conta'),
  /** Eventos: estado, progresso, ocupado, central-status, conta. */
  on: (event, fn) => {
    if (!['estado', 'progresso', 'ocupado', 'central-status', 'conta'].includes(event)) return;
    ipcRenderer.on(event, (_e, payload) => fn(payload));
  },
});
