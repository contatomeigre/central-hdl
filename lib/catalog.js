// Validação do catálogo (catalogo.json). Uma entrada com erro é descartada sem derrubar as outras.

import { REPO_RE } from './releases.js';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// só o nome do .exe, sem pastas: o valor vai para o taskkill /IM e para o caminho de instalação
const EXE_RE = /^[\w .()-]+\.exe$/i;
// tag de acesso (opcional): só quem tem a tag (ou godmod) vê o app; mesmo formato que o banco aceita
const TAG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

const texto = (v) => typeof v === 'string' && v.trim() !== '';

function problemaDe(a, ids) {
  if (!a || typeof a !== 'object') return 'não é um objeto';
  if (!texto(a.id) || !ID_RE.test(a.id)) return 'id inválido (use letras minúsculas, números e hífen)';
  if (ids.has(a.id)) return 'id repetido';
  if (!texto(a.nome)) return 'falta o nome';
  if (!texto(a.repo) || !REPO_RE.test(a.repo)) return 'repo inválido (formato dono/repositório)';
  if (!texto(a.executavel) || !EXE_RE.test(a.executavel)) return 'executavel deve ser só o nome do .exe, sem pastas';
  if (a.nomeWindows != null && !texto(a.nomeWindows)) return 'nomeWindows deve ser texto';
  for (const campo of ['descricao', 'categoria']) if (a[campo] != null && typeof a[campo] !== 'string') return `${campo} deve ser texto`;
  if (a.icone != null && !(typeof a.icone === 'string' && a.icone.startsWith('https://'))) return 'icone deve ser um endereço https://';
  if (a.tag != null && (typeof a.tag !== 'string' || !TAG_RE.test(a.tag) || a.tag === 'godmod')) {
    return 'tag deve ter letras minúsculas, números e hífen (2 a 32), e não pode ser godmod';
  }
  return null;
}

/** Separa as entradas válidas das inválidas: { apps, problemas }. Sem a lista "apps", o catálogo inteiro é recusado. */
export function validateCatalog(cat) {
  if (!Array.isArray(cat?.apps)) throw new Error('catálogo sem a lista "apps"');
  const apps = [];
  const problemas = [];
  const ids = new Set();
  for (const [i, a] of cat.apps.entries()) {
    const erro = problemaDe(a, ids);
    if (erro) {
      problemas.push(`entrada ${i + 1} (${typeof a?.id === 'string' ? a.id : 'sem id'}): ${erro}`);
      continue;
    }
    ids.add(a.id);
    apps.push(a);
  }
  return { apps, problemas };
}
