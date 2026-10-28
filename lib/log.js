// Registro em arquivo, para diagnosticar problemas no computador de quem usa a Central.
// Fica em %APPDATA%\Central HDL\logs\central.log; passando de 1 MB, vira central.old.log.

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** dir: a pasta dos registros, ou uma função que a devolve (resolvida a cada escrita). */
export function createLog(dir, { maxBytes = MAX_BYTES } = {}) {
  const pasta = () => (typeof dir === 'function' ? dir() : dir);
  const write = (nivel, msg) => {
    const linha = `${new Date().toISOString()} ${nivel.padEnd(5)} ${msg}\n`;
    try {
      const d = pasta();
      const file = path.join(d, 'central.log');
      fs.mkdirSync(d, { recursive: true });
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) fs.renameSync(file, path.join(d, 'central.old.log'));
      fs.appendFileSync(file, linha);
    } catch { /* um registro que falha nunca pode derrubar a Central */ }
  };
  return {
    pasta,
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('AVISO', msg),
    error: (msg) => write('ERRO', msg),
  };
}
