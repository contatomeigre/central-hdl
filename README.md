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
- Ela **se atualiza sozinha** pelo repositório `hdldev123/central-hdl`: procura ao abrir e a cada 2 h, baixa em segundo plano e instala ao fechar. Ao lado da versão, no topo, o botão **Procurar atualização da Central** força a verificação e, com a versão nova baixada, vira **Reiniciar e atualizar**. "Procurar atualizações" e o menu da bandeja também verificam a Central.
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

1. Um **proprietário ou administrador da organização HDL** (no Prosa) abre **Pessoas › Convites › Novo convite**, informa o e-mail e o papel e copia a mensagem com o código. O convite vale 7 dias, é de uso único e pode ser revogado; o banco guarda só o hash do código. Só o proprietário convida administradores.
2. A pessoa instala a Central, clica em **Criar minha conta** e usa o mesmo e-mail e o código. A conta nasce **pendente**: ela vê "Aguardando aprovação" e a Central confere sozinha a cada 30 s.
3. O administrador aprova (ou recusa) em **Pessoas**. Ao aprovar, a pessoa entra na organização HDL com o papel do convite.

Conta pendente ou recusada não acessa nada no Prosa: as regras do banco só reconhecem contas ativas. As regras ficam na migração `supabase/migrations/20261027180000_conta_hdl_convites.sql` do repositório do Prosa (o banco é o mesmo). A organização HDL é definida em `prosa_private.config.hdl_org_id`; a migração preenche sozinha quando só existe uma organização (ou uma só com "HDL" no nome).

### Autorização na aba Pessoas

Toda a autorização da Central e dos apps fica em **Pessoas** (seção Administração, visível só para administradores e proprietários da HDL), em quatro sub-abas:

- **Pessoas:** quem aguarda aprovação e os membros. Cada membro tem **cargo** (Convidado, Membro, Administrador ou Proprietário), os apps que acessa, **Acessos** e **Remover**. As regras são as do Prosa: só o **proprietário** dá ou tira administrador/proprietário; administrador só mexe em convidados e membros; ninguém muda o próprio cargo nem remove a si mesmo; sempre resta um proprietário. Mudar cargo para ou de Administrador/Proprietário pede confirmação.
- **Apps:** a regra de cada app do catálogo, **Livre para todos** ou **Restrito**, e, quando restrito, quem tem acesso (caixas de marcar e **Salvar acessos**, que grava a lista inteira). Quem tem `godmod` aparece marcado e travado ("acesso total").
- **Convites:** convites dos últimos 30 dias e **Novo convite** (ver acima).
- **Inativas:** contas **removidas** ou **recusadas**, com **Reativar** no cargo escolhido (Administrador só pelo proprietário). Os acessos aos apps precisam ser dados de novo.

**Remover** tira a pessoa da organização HDL e **desativa a conta** (situação "removida", sem tags): ela perde o acesso a todos os apps e, ao abrir a Central, vê "Seu acesso à HDL foi encerrado.". Dá para reativar em Inativas.

#### Regra de cada app

- **A regra (livre ou restrito) fica no banco** e é gerida em Pessoas › Apps. A Central lê as regras no login e as guarda no perfil da sessão (funcionam sem internet). Se o banco ainda não tiver a função `app_access_rules`, a Central usa o catálogo.
- O campo **`tag`** no `catalogo.json` virou só o **padrão inicial** de um app novo: sem regra no banco, o app com `tag` nasce **restrito** até um administrador decidir (o cartão em Apps avisa "Regra padrão do catálogo: salve para valer pelo banco."). App sem `tag` nasce livre (o Prosa é livre).
- **A tag de acesso de um app é o próprio `id` dele** (`fluxo`, `financeiro`…). **`godmod`** libera todos os apps e só vale para proprietários e administradores: o banco recusa dá-la a outra pessoa e a ignora se a pessoa deixar de ser administradora.
- A Central esconde os apps restritos sem acesso e não deixa instalá-los nem atualizá-los. Quem perdeu o acesso a um app instalado vê o cartão como **Sem acesso**, só com o botão de desinstalar. Ela relê tags e regras a cada verificação (30 min) e em **Procurar atualizações**.
- **Quem garante o acesso é o banco de cada app, não a Central** (os instaladores ficam em repositórios públicos). Nas regras de acesso do app, use `prosa_private.has_app_access('<id do app>')`. Tabelas e funções nas migrações `20261028150000_tags_de_acesso.sql` e `20261029150000_central_acessos.sql` do repositório do Prosa.
- Os botões de administração só aparecem para administradores, o processo principal recusa as ações de quem não é administrador, e o banco confere de novo.

## Onde fica cada coisa

Tudo fica na conta da empresa no GitHub, **`hdldev123`** (a mesma do Luz de Minas e do Rotas):

- `hdldev123/central-hdl` (público): este projeto (com `catalogo.json` e `icones/` na branch `main`) e as versões da própria Central.
- `hdldev123/prosa-releases` (público): só as versões do Prosa.
- `hdldev123/hello-prosa` (privado): o código do Prosa e o banco (migrações do Supabase).

Até outubro de 2026 os três ficavam na conta pessoal `contatomeigre` e foram **transferidos** (não copiados) para a `hdldev123`. O GitHub redireciona os endereços antigos, e é isso que mantém funcionando as Centrais e os Prosas instalados antes da troca. Para não quebrar esse redirecionamento: **não crie repositórios com esses nomes na `contatomeigre` e não apague nem renomeie essa conta.**

## Publicar uma versão nova do Prosa

```powershell
cd ..\aplicativo-independente
npm version patch --no-git-tag-version   # 0.3.1 → 0.3.2 (ou minor / major)
npm run publicar
```

O `npm run publicar` (`desktop/scripts/publicar.mjs`):

1. pega o token da conta dona (`hdldev123`) no GitHub CLI, sem precisar criar ou colar token. O script do Prosa ainda não aceita colaboradoras: para publicar o Prosa, entre no `gh` com a `hdldev123`;
2. cria a release `v0.3.2` em `prosa-releases` (feito antes, porque o electron-builder sozinho às vezes falha na primeira publicação);
3. gera o instalador e envia o `.exe`, o `.blockmap` e o `latest.yml`.

Em até 30 min as Centrais (e os Prosas abertos) encontram a versão nova. Se o GitHub CLI pedir login: `gh auth login --web` com a conta `hdldev123` (veja o login com conta secundária abaixo).

Para conferir uma versão publicada: `https://github.com/hdldev123/prosa-releases/releases/latest/download/latest.yml`.

> As releases são criadas como **publicadas** (`releaseType: release`). Para revisar antes, troque para `"draft"` no `package.json` e publique a release manualmente no GitHub.

## Publicar a própria Central

```powershell
git checkout main; git pull                 # com as mudanças já mescladas na main
npm version patch --no-git-tag-version
git commit -am "Central HDL x.y.z"; git push
npm run publicar
```

Quem pode publicar: a conta dona (`hdldev123`) ou qualquer colaboradora com permissão de **escrita** no repositório (ex.: `davydsonmr1`), logada no GitHub CLI com `gh auth login --web`. O script tenta primeiro a `hdldev123` e depois a conta ativa do `gh`, e mostra com qual conta está publicando. Para dar acesso a mais alguém: **Settings → Collaborators** do repositório, com o papel *Write*.

O `npm run publicar` recusa publicar quando:

- nenhuma conta logada no `gh` tem permissão de escrita no repositório;
- há alterações sem commit, você não está na `main`, ou a `main` local está diferente da `origin/main`. O instalador é gerado da pasta local; com essas travas ele corresponde exatamente ao commit da tag (a release é criada nesse commit). Em emergência: `npm run publicar -- --ignorar-git`;
- a versão já foi publicada (a release já tem o `latest.yml`). Quem já tem essa versão nunca receberia a correção: suba a versão. Se uma publicação anterior foi interrompida antes do `latest.yml` subir, ela é retomada.

A **primeira** instalação é a única feita à mão: envie para as pessoas o `Central-HDL-Setup-x.y.z.exe`, que fica na release do repositório `central-hdl`. O link fixo da última versão é:
`https://github.com/hdldev123/central-hdl/releases/latest`

## Login com a conta secundária no GitHub CLI

Colaboradores publicam com a própria conta: basta `gh auth login --web` no navegador de sempre. O passo abaixo é só para quem precisa logar numa conta diferente da que está aberta no navegador.

Se a máquina tiver uma variável `GITHUB_TOKEN` com o token de outra conta, ela tem prioridade sobre as contas do `gh`. Para logar na `hdldev123` (por exemplo, para publicar o Prosa):

```powershell
$env:GITHUB_TOKEN = $null
gh auth login --hostname github.com --git-protocol https --web
```

Copie o código e aperte Enter; feche a aba que abrir no navegador normal. Depois, numa **janela anônima** logada na `hdldev123`, abra https://github.com/login/device e cole o código. O script de publicação já ignora o `GITHUB_TOKEN` sozinho.

## Colocar mais um programa da empresa na Central

1. O programa precisa ser instalado por um **instalador NSIS** que aceite `/S` (o padrão do electron-builder) e publicar `latest.yml` no GitHub Releases. Para apps Electron, basta copiar o bloco `publish` do Prosa, apontando para um repositório `<app>-releases`.
2. Adicione uma entrada em `catalogo.json` e envie para a branch `main` do `central-hdl`:
   ```json
   {
     "id": "meu-app",
     "nome": "Meu App",
     "descricao": "O que ele faz, em uma frase.",
     "categoria": "Financeiro",
     "repo": "hdldev123/meu-app-releases",
     "nomeWindows": "Meu App",
     "executavel": "Meu App.exe",
     "icone": "https://raw.githubusercontent.com/hdldev123/central-hdl/main/icones/meu-app.png"
   }
   ```
   - `nomeWindows` é o nome que aparece em "Aplicativos instalados" (sem a versão), normalmente o `productName`.
   - `executavel` é o `.exe` dentro da pasta de instalação.
   - `tag` (opcional) é só o **padrão inicial** do app: com ela, o app nasce restrito até um administrador decidir em Pessoas › Apps (a regra de verdade fica no banco); sem ela, nasce livre. Letras minúsculas, números e hífen; não pode ser `godmod`.
   - `cor` (opcional, `#rrggbb`) é a cor de destaque da tela de abertura do app; sem ela, usa o ciano da Central.

Ao clicar em **Abrir**, todo app do catálogo ganha a mesma tela de abertura, montada a partir da entrada dele (nome, ícone, versão, executável e `cor`). As etapas são reais: verifica a instalação, inicia o `.exe` e espera a janela do app aparecer (até 20 s; se não aparecer, avisa que ele abriu em segundo plano). Se falhar, a tela mostra o motivo e um botão **Fechar**. Não é preciso nada no app novo para ter essa tela.

A Central relê o catálogo a cada verificação (a cada 30 min ou em "Procurar atualizações"), então **não é preciso publicar uma versão nova dela** para aparecer um app novo. Sem internet, ela usa a última cópia do catálogo que baixou.

Cada entrada é conferida e, se tiver erro, é ignorada (as outras continuam valendo) e o motivo vai para o registro: `id` só com letras minúsculas, números e hífen, sem repetir; `nome`, `repo` (`dono/repositório`) e `executavel` obrigatórios; `executavel` é só o nome do `.exe`, sem pastas; `icone` precisa ser `https://`. Se o arquivo vier sem a lista `apps`, a Central mantém a última cópia boa.

## Quando algo dá errado

A Central grava o que faz em `%APPDATA%\Central HDL\logs\central.log`: verificações, instalações (com a versão), falhas e o motivo, catálogo inválido, autoatualização e erros não tratados. Passando de 1 MB, o arquivo vira `central.old.log`. Para a pessoa enviar: **Configurações › Abrir pasta de registros**.

Se a atualização automática de um app falhar, a Central tenta de novo a cada verificação, mas avisa só uma vez por versão.

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
