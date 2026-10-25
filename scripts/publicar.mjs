// Publica a versão do package.json no GitHub Releases. Uso: npm run publicar
//
// - O token vem do GitHub CLI (conta dona do repositório, em "build.publish"),
//   então não é preciso criar nem colar token.
// - Cria a release antes do electron-builder: sozinho ele às vezes tenta criá-la
//   duas vezes em paralelo na primeira publicação e uma das tentativas falha.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const { owner, repo } = pkg.build.publish.find((p) => p.provider === 'github');
const tag = `v${pkg.version}`;

const env = { ...process.env };
delete env.GITHUB_TOKEN; // nesta máquina pode ter o token de outra conta
if (!env.GH_TOKEN) {
  try {
    env.GH_TOKEN = execFileSync('gh', ['auth', 'token', '--user', owner], { env, encoding: 'utf8' }).trim();
  } catch {
    console.error(`Faça login no GitHub CLI com a conta ${owner}: gh auth login --web`);
    process.exit(1);
  }
}

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
  method: 'POST',
  headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
  body: JSON.stringify({ tag_name: tag, name: pkg.version }),
});
if (res.ok) console.log(`release ${tag} criada em ${owner}/${repo}`);
else if (res.status === 422) console.log(`release ${tag} já existe em ${owner}/${repo}: os arquivos serão substituídos`);
else {
  console.error(`GitHub recusou criar a release (${res.status}):`, await res.text());
  process.exit(1);
}

const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
