# Central HDL

Loja de aplicativos desktop da HDL Soluções. As pessoas instalam a Central **uma vez**. Depois disso, ela instala e mantém atualizados todos os programas da empresa (começando pelo Prosa), sem ninguém precisar baixar um executável a cada versão.

## Como funciona

```
catalogo.json (GitHub, repo central-hdl)        ← lista de apps da empresa
        │
        ▼
Central HDL ── lê latest.yml de cada app ──► GitHub Releases (ex.: prosa-releases)
        │       baixa o instalador e confere o SHA-512
        ▼
instala em silêncio (/S) e reabre o app, se ele estava aberto
```

- **Abre com uma tela de carregamento** que mostra cada etapa de verdade (núcleo, catálogo e apps instalados, atualizações) num log de inicialização. Se o catálogo não carregar, a Central abre assim mesmo e avisa.
- **Visual escuro de terminal**: barra lateral com Todos os apps, Instalados e Atualizações; apps com versão nova aparecem num painel de destaque com o progresso do download. Busca com `Ctrl K`. As fontes (Space Grotesk, JetBrains Mono e Inter, licença OFL) vão embutidas em `ui/fonts`, porque a política de segurança da janela não carrega nada de fora.
- **Fica na bandeja** e inicia com o Windows (dá para desligar nas configurações).
- A cada 30 min procura versões novas. Com "Atualizar apps automaticamente" ligado (o padrão), ela instala sozinha. **Apps abertos não são interrompidos**: a pessoa recebe uma notificação e atualiza quando quiser. Se o app estiver aberto, ele é fechado e reaberto.
- Ela **se atualiza sozinha** pelo repositório `contatomeigre/central-hdl`: procura ao abrir e a cada 2 h, baixa em segundo plano e instala ao fechar. Ao lado da versão, no topo, o botão **Procurar atualização da Central** força a verificação e, com a versão nova baixada, vira **Reiniciar e atualizar**. "Procurar atualizações" e o menu da bandeja também verificam a Central.
- O próprio Prosa também se atualiza ao abrir (electron-updater). Quem não tem a Central continua recebendo as versões novas.
- Para saber o que está instalado, ela lê "Aplicativos instalados" do Windows (registro `Uninstall`), procurando pelo nome em `nomeWindows`.

## Conta HDL

Depois da tela de carregamento, a Central pede login. A conta é a mesma do Prosa (o mesmo projeto Supabase): quem já usa o Prosa entra com o mesmo e-mail e senha.

- **Sessão:** fica só no processo principal (a interface recebe apenas nome, usuário e cor do avatar), gravada em `%APPDATA%\Central HDL\conta.bin` criptografada pelo Windows (DPAPI). É renovada 5 min antes de vencer, uma renovação por vez: o Supabase derruba a sessão se o mesmo token de renovação for usado duas vezes.
- **Ao abrir:** renova a sessão salva. Sem internet, entra com ela mesmo assim ("sem conexão" no cartão da conta) e tenta de novo a cada minuto. Se o servidor recusar (senha trocada, conta removida), volta para a tela de login.
- **Sair** (cartão da conta, na barra lateral) encerra só a sessão da Central.
- As atualizações automáticas dos apps continuam funcionando com a Central deslogada.
- "Esqueci minha senha" orienta a pedir a um administrador, porque o projeto ainda não tem serviço de e-mail.
- A Central usa a **chave publicável** do Supabase (`sb_publishable_…`), pública por natureza. A chave `service_role` (ou `sb_secret_…`) nunca vai em app nenhum: ela ignora todas as regras do banco.

### Convites e aprovação

Não existe mais código de cadastro único. Para alguém entrar:

1. Um **proprietário ou administrador da organização HDL** (no Prosa) abre **Pessoas › Convidar pessoa**, informa o e-mail e o papel e copia a mensagem com o código. O convite vale 7 dias, é de uso único e pode ser revogado; o banco guarda só o hash do código. Só o proprietário convida administradores.
2. A pessoa instala a Central, clica em **Criar minha conta** e usa o mesmo e-mail e o código. A conta nasce **pendente**: ela vê "Aguardando aprovação" e a Central confere sozinha a cada 30 s.
3. O administrador aprova (ou recusa) em **Pessoas**. Ao aprovar, a pessoa entra na organização HDL com o papel do convite.

Conta pendente ou recusada não acessa nada no Prosa: as regras do banco só reconhecem contas ativas. As regras ficam na migração `supabase/migrations/20261027180000_conta_hdl_convites.sql` do repositório do Prosa (o banco é o mesmo). A organização HDL é definida em `prosa_private.config.hdl_org_id`; a migração preenche sozinha quando só existe uma organização (ou uma só com "HDL" no nome).

## Onde fica cada coisa

Tudo fica na conta **`contatomeigre`** do GitHub, em repositórios **públicos** que guardam só as versões. O código do Prosa não vai para lá.

- `contatomeigre/central-hdl`: este projeto (com `catalogo.json` e `icones/` na branch `main`) e as versões da própria Central.
- `contatomeigre/prosa-releases`: só as versões do Prosa.

## Publicar uma versão nova do Prosa

```powershell
cd ..\aplicativo-independente
npm version patch --no-git-tag-version   # 0.3.1 → 0.3.2 (ou minor / major)
npm run publicar
```

O `npm run publicar` (`desktop/scripts/publicar.mjs`):

1. pega o token da conta `contatomeigre` no GitHub CLI, sem precisar criar ou colar token;
2. cria a release `v0.3.2` em `prosa-releases` (feito antes, porque o electron-builder sozinho às vezes falha na primeira publicação);
3. gera o instalador e envia o `.exe`, o `.blockmap` e o `latest.yml`.

Em até 30 min as Centrais (e os Prosas abertos) encontram a versão nova. Se o GitHub CLI pedir login: `gh auth login --web` com a conta `contatomeigre` (veja o login com conta secundária abaixo).

Para conferir uma versão publicada: `https://github.com/contatomeigre/prosa-releases/releases/latest/download/latest.yml`.

> As releases são criadas como **publicadas** (`releaseType: release`). Para revisar antes, troque para `"draft"` no `package.json` e publique a release manualmente no GitHub.

## Publicar a própria Central

```powershell
npm version patch --no-git-tag-version
npm run publicar
```

A **primeira** instalação é a única feita à mão: envie para as pessoas o `Central-HDL-Setup-x.y.z.exe`, que fica na release do repositório `central-hdl`. O link fixo da última versão é:
`https://github.com/contatomeigre/central-hdl/releases/latest`

## Login com a conta secundária no GitHub CLI

Esta máquina tem uma variável `GITHUB_TOKEN` com o token do `matheusmeigre`, que tem prioridade sobre as contas do `gh`. Para logar na `contatomeigre`:

```powershell
$env:GITHUB_TOKEN = $null
gh auth login --hostname github.com --git-protocol https --web
```

Copie o código e aperte Enter; feche a aba que abrir no navegador normal. Depois, numa **janela anônima** logada na `contatomeigre`, abra https://github.com/login/device e cole o código. O script de publicação já ignora o `GITHUB_TOKEN` sozinho.

## Colocar mais um programa da empresa na Central

1. O programa precisa ser instalado por um **instalador NSIS** que aceite `/S` (o padrão do electron-builder) e publicar `latest.yml` no GitHub Releases. Para apps Electron, basta copiar o bloco `publish` do Prosa, apontando para um repositório `<app>-releases`.
2. Adicione uma entrada em `catalogo.json` e envie para a branch `main` do `central-hdl`:
   ```json
   {
     "id": "meu-app",
     "nome": "Meu App",
     "descricao": "O que ele faz, em uma frase.",
     "categoria": "Financeiro",
     "repo": "contatomeigre/meu-app-releases",
     "nomeWindows": "Meu App",
     "executavel": "Meu App.exe",
     "icone": "https://raw.githubusercontent.com/contatomeigre/central-hdl/main/icones/meu-app.png"
   }
   ```
   - `nomeWindows` é o nome que aparece em "Aplicativos instalados" (sem a versão), normalmente o `productName`.
   - `executavel` é o `.exe` dentro da pasta de instalação.

A Central relê o catálogo a cada verificação, então **não é preciso publicar uma versão nova dela** para aparecer um app novo. Sem internet, ela usa a última cópia do catálogo que baixou.

## Desenvolvimento

```powershell
npm install
npm start          # abre a Central (em dev não se autoatualiza nem entra na inicialização)
npm test           # testes de latest.yml, versões, registro e verificação do download
npm run icone      # regenera build/icon.png e icone.png a partir de scripts/icone.svg
npm run dist       # gera o instalador em dist/ sem publicar
```

## Assinatura de código (recomendado depois)

Os executáveis não são assinados. Na **primeira** instalação da Central (e do Prosa baixado pelo navegador), o Windows SmartScreen mostra "O Windows protegeu o computador" › *Mais informações* › *Executar assim mesmo*. As atualizações feitas pela Central não passam por esse aviso. Para eliminá-lo, é preciso um certificado de assinatura de código (configurado em `build.win` no electron-builder).
