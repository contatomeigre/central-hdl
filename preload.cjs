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
  /** Eventos: estado, progresso, ocupado, central-status. */
  on: (event, fn) => {
    if (!['estado', 'progresso', 'ocupado', 'central-status'].includes(event)) return;
    ipcRenderer.on(event, (_e, payload) => fn(payload));
  },
});
