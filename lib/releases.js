// Versões publicadas no GitHub Releases (formato do electron-builder: latest.yml).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const RESPONSE_TIMEOUT_MS = 30 * 1000; // GitHub sem responder ao latest.yml
const STALL_TIMEOUT_MS = 60 * 1000;    // download sem receber nenhum dado

/** Lê os campos que importam do latest.yml (version, path, sha512, size, releaseDate). */
export function parseLatestYml(text) {
  const top = (key) => text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm'))?.[1]?.trim() ?? null;
  const version = top('version');
  const file = top('path');
  const sha512 = top('sha512');
  if (!version || !file || !sha512) throw new Error('latest.yml incompleto');
  // o tamanho fica na lista "files", junto da entrada do instalador
  const size = Number(text.match(/^\s+size:\s*(\d+)/m)?.[1]) || null;
  return { version, file, sha512, size, releaseDate: top('releaseDate') };
}

/** Compara versões "1.2.10" x "1.2.9" (pré-lançamentos "-beta" ficam antes da versão final). */
export function compareVersions(a, b) {
  const split = (v) => {
    const [main, pre = ''] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Última versão publicada de um app do catálogo. */
export async function latestRelease(fetch, repo, { timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
  if (!REPO_RE.test(repo ?? '')) throw new Error(`Repositório inválido no catálogo: ${repo}`);
  const signal = AbortSignal.timeout(timeoutMs);
  let info;
  try {
    // /releases/latest/download/... não conta no limite de requisições da API do GitHub
    const res = await fetch(`https://github.com/${repo}/releases/latest/download/latest.yml`, { cache: 'no-store', signal });
    if (res.status === 404) throw new Error('Nenhuma versão publicada ainda.');
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}.`);
    info = parseLatestYml(await res.text());
  } catch (err) {
    if (signal.aborted) throw new Error('O GitHub não respondeu a tempo. Verifique a internet e tente de novo.');
    throw err;
  }
  const tag = `v${info.version}`;
  return {
    ...info,
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(info.file)}`,
    notesUrl: `https://github.com/${repo}/releases/tag/${tag}`,
  };
}

/**
 * Baixa o instalador conferindo o SHA-512 publicado. onProgress(recebidos, total).
 * Desiste se passar `stallMs` sem receber dados, para que uma conexão travada não prenda a Central.
 */
export async function download(fetch, release, dest, onProgress, { stallMs = STALL_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), stallMs); };
  const hash = crypto.createHash('sha512');
  let got = 0;
  let total = 0;
  let last = 0;
  try {
    arm();
    const res = await fetch(release.url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`Falha no download (${res.status}).`);
    total = Number(res.headers.get('content-length')) || release.size || 0;
    // o pipeline cuida da contrapressão e dos erros de escrita (ex.: disco cheio)
    await pipeline(async function* () {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          arm();
          hash.update(value);
          got += value.length;
          if (Date.now() - last > 150) { last = Date.now(); onProgress?.(got, total); }
          yield value;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }, fs.createWriteStream(dest));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    if (ctrl.signal.aborted) throw new Error('O download parou de receber dados. Verifique a internet e tente de novo.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  onProgress?.(got, total);
  if (hash.digest('base64') !== release.sha512) {
    fs.rmSync(dest, { force: true });
    throw new Error('O arquivo baixado não confere com a versão publicada (SHA-512). Tente de novo.');
  }
}
