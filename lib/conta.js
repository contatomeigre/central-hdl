// Conta HDL: login no Supabase Auth (o mesmo do Prosa) pela API HTTP, sem biblioteca.
// Roda só no processo principal; a interface nunca vê os tokens.

const TIMEOUT_MS = 20 * 1000;
const COR_RE = /^#[0-9a-f]{6}$/i;

const MENSAGENS = [
  [/invalid login credentials|invalid_credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed|email_not_confirmed/i, 'Este e-mail ainda não foi confirmado. Fale com um administrador da HDL.'],
  [/rate limit|too many|over_request_rate_limit/i, 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.'],
  [/user_banned|banned/i, 'Esta conta está bloqueada. Fale com um administrador da HDL.'],
  [/refresh.?token|session_not_found|session_expired/i, 'Sua sessão expirou. Entre de novo.'],
];

/** Erro da conta. semConexao: falha de rede (vale tentar de novo); invalida: a sessão não serve mais. */
export class ErroConta extends Error {
  constructor(message, { semConexao = false, invalida = false, status = 0 } = {}) {
    super(message);
    this.semConexao = semConexao;
    this.invalida = invalida;
    this.status = status;
  }
}

async function chamar(fetch, cfg, caminho, { metodo = 'POST', corpo, token } = {}) {
  const headers = { apikey: cfg.anonKey, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${cfg.url}${caminho}`, {
      method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ErroConta('Sem conexão com o servidor da HDL. Verifique a internet e tente de novo.', { semConexao: true });
  }
  const texto = await res.text().catch(() => '');
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* resposta sem JSON */ }
  if (res.ok) return json;
  if (res.status === 429 || res.status >= 500) {
    throw new ErroConta(res.status === 429 ? MENSAGENS[2][1] : `O servidor da HDL respondeu ${res.status}. Tente de novo em instantes.`, { semConexao: res.status >= 500, status: res.status });
  }
  // o Supabase responde em dois formatos: { error, error_description } ou { error_code, msg }
  const bruta = [json?.error_code, json?.error, json?.error_description, json?.msg, json?.message].filter(Boolean).join(' ');
  const traduzida = MENSAGENS.find(([re]) => re.test(bruta))?.[1];
  throw new ErroConta(traduzida ?? (json?.msg || json?.message || json?.error_description || `Erro ${res.status}.`), { invalida: true, status: res.status });
}

function sessaoDe(r) {
  if (!r?.access_token || !r?.refresh_token) throw new ErroConta('Resposta inesperada do servidor da HDL.');
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    // expires_at vem em segundos; sem ele, conta a partir de agora
    expiraEm: r.expires_at ? r.expires_at * 1000 : Date.now() + (r.expires_in ?? 3600) * 1000,
    email: r.user?.email ?? null,
  };
}

/** Entra com e-mail e senha. */
export async function entrar(fetch, cfg, email, senha) {
  if (!String(email ?? '').trim() || !senha) throw new ErroConta('Informe o e-mail e a senha.');
  return sessaoDe(await chamar(fetch, cfg, '/auth/v1/token?grant_type=password', { corpo: { email: String(email).trim(), password: senha } }));
}

/** Troca o refresh token por uma sessão nova (o Supabase invalida o anterior). */
export async function renovar(fetch, cfg, refreshToken) {
  return sessaoDe(await chamar(fetch, cfg, '/auth/v1/token?grant_type=refresh_token', { corpo: { refresh_token: refreshToken } }));
}

/**
 * Encerra a sessão no servidor. "local" encerra só a da Central; "global" encerra também a dos apps
 * (usado quando os apps passarem a entrar pela Central).
 */
export async function sair(fetch, cfg, accessToken, { escopo = 'local' } = {}) {
  await chamar(fetch, cfg, `/auth/v1/logout?scope=${escopo}`, { token: accessToken });
}

/** Nome, usuário e cor do avatar, pela mesma função do banco que o Prosa usa (get_me). */
export async function perfil(fetch, cfg, accessToken) {
  const r = await chamar(fetch, cfg, '/rest/v1/rpc/get_me', { corpo: {}, token: accessToken });
  const u = r?.user;
  if (!u?.username) throw new ErroConta('Não encontrei o seu perfil na HDL.', { invalida: true });
  return {
    id: u.id,
    usuario: u.username,
    nome: u.displayName || u.username,
    cor: COR_RE.test(u.avatarColor ?? '') ? u.avatarColor : null,
  };
}
