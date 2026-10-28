// Publica a versão do package.json no GitHub Releases. Uso: npm run publicar
//
// - Só publica da main, sem alterações pendentes e igual à origin/main: o instalador é gerado
//   da pasta local, então isso garante que ele corresponde ao commit da tag (que é criada
//   nesse commit). Em emergência: npm run publicar -- --ignorar-git
// - Recusa reaproveitar uma versão já publicada: quem já a tem nunca receberia a correção.
//   Se a publicação anterior foi interrompida antes do latest.yml subir, ela é retomada.
// - O token vem do GitHub CLI (conta dona do repositório, em "build.publish"),
//   então não é preciso criar nem colar token.
// - Cria a release antes do electron-builder: sozinho ele às vezes tenta criá-la
//   duas vezes em paralelo na primeira publicação e uma das tentativas falha.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const { owner, repo } = pkg.build.publish.find((p) => p.provider === 'github');
const tag = `v${pkg.version}`;

const falhar = (msg) => {
  console.error(`\nPublicação cancelada: ${msg}\n`);
  process.exit(1);
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let commit = null;
if (process.argv.includes('--ignorar-git')) {
  console.warn('--ignorar-git: o instalador sai da pasta local como ela está, e a tag vai para o topo da main no GitHub');
} else {
  if (git('status', '--porcelain')) falhar('há alterações sem commit. Faça o commit (ou descarte) e tente de novo.');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') falhar(`publique a partir da main (você está em "${branch}"). Faça o merge e rode: git checkout main`);
  git('fetch', '--quiet', 'origin', 'main');
  commit = git('rev-parse', 'HEAD');
  if (commit !== git('rev-parse', 'origin/main')) falhar('a main local está diferente da origin/main. Rode git pull e git push antes de publicar.');
}

const env = { ...process.env };
delete env.GITHUB_TOKEN; // nesta máquina pode ter o token de outra conta
if (!env.GH_TOKEN) {
  try {
    env.GH_TOKEN = execFileSync('gh', ['auth', 'token', '--user', owner], { env, encoding: 'utf8' }).trim();
  } catch {
    falhar(`faça login no GitHub CLI com a conta ${owner}: gh auth login --web`);
  }
}

const github = (caminho, init = {}) => fetch(`https://api.github.com/repos/${owner}/${repo}${caminho}`, {
  ...init,
  headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
});

const existente = await github(`/releases/tags/${tag}`);
if (existente.ok) {
  const { assets = [] } = await existente.json();
  if (assets.some((a) => a.name === 'latest.yml')) {
    falhar(`a versão ${pkg.version} já foi publicada em ${owner}/${repo}. Suba a versão: npm version patch --no-git-tag-version`);
  }
  console.log(`release ${tag} já existe sem o latest.yml (publicação interrompida): os arquivos serão enviados de novo`);
} else {
  const res = await github('/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: pkg.version, ...(commit && { target_commitish: commit }) }),
  });
  if (res.ok) console.log(`release ${tag} criada em ${owner}/${repo}${commit ? ` no commit ${commit.slice(0, 7)}` : ''}`);
  else if (res.status === 422) console.log(`release ${tag} já existe em ${owner}/${repo} (rascunho?): os arquivos serão substituídos`);
  else falhar(`o GitHub recusou criar a release (${res.status}): ${await res.text()}`);
}

const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
