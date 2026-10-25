// Abre o Electron garantindo que ELECTRON_RUN_AS_NODE não está ligado
// (terminais dentro de editores baseados em Electron às vezes herdam essa variável).
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.length > 2 ? process.argv.slice(2) : ['.'];
const child = spawn(electron, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
