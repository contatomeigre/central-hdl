// Regra de acesso aos apps. A regra de cada app (livre ou restrito) vem do banco;
// o "tag" do catálogo é só o padrão de um app que ainda não tem regra lá.

/** regras: { [appId]: boolean } vindo do banco, ou null/undefined quando não deu para ler. */
export function appRestrito(app, regras) {
  if (regras && typeof regras[app.id] === 'boolean') return regras[app.id];
  return Boolean(app.tag);
}

/** Livre, ou a conta tem a tag com o id do app (ou o `tag` do catálogo, por compatibilidade) ou godmod. */
export function temAcesso(app, tags = [], regras = null) {
  if (!appRestrito(app, regras)) return true;
  return tags.includes(app.id) || (Boolean(app.tag) && tags.includes(app.tag)) || tags.includes('godmod');
}
