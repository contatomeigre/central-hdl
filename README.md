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

- **Fica na bandeja** e inicia com o Windows (dá para desligar nas configurações).
- A cada 30 min procura versões novas. Com "Atualizar apps automaticamente" ligado (o padrão), ela instala sozinha. **Apps abertos não são interrompidos**: a pessoa recebe uma notificação e atualiza quando quiser. Se o app estiver aberto, ele é fechado e reaberto.
- Ela **se atualiza sozinha** pelo repositório `contatomeigre/central-hdl`.
- O próprio Prosa também se atualiza ao abrir (electron-updater). Quem não tem a Central continua recebendo as versões novas.
- Para saber o que está instalado, ela lê "Aplicativos instalados" do Windows (registro `Uninstall`), procurando pelo nome em `nomeWindows`.

## Onde fica cada coisa

Tudo fica na conta **`contatomeigre`** do GitHub, em repositórios **públicos** que guardam só as versões. O código do Prosa não vai para lá.

- `contatomeigre/central-hdl`: este projeto (com `catalogo.json` e `icones/` na branch `main`) e as versões da própria Central.
- `contatomeigre/prosa-releases`: só as versões do Prosa.

## Antes de publicar (em cada terminal novo)

A conta `contatomeigre` está logada no GitHub CLI. O token sai dele, sem precisar criar um à mão:

```powershell
$env:GITHUB_TOKEN = $null                               # esta máquina tem o token do matheusmeigre nessa variável
$env:GH_TOKEN = gh auth token --user contatomeigre
```

## Publicar uma versão nova do Prosa

```powershell
cd ..\aplicativo-independente
npm version patch --no-git-tag-version   # 0.3.0 → 0.3.1 (ou minor / major)
npm run publicar
```

O `electron-builder` gera o instalador e cria a release `v0.3.1` em `prosa-releases`, com o `.exe`, o `.blockmap` e o `latest.yml`. Em até 30 min as Centrais (e os Prosas abertos) encontram a versão nova.

> As releases são criadas como **publicadas** (`releaseType: release`). Para revisar antes, troque para `"draft"` no `package.json` e publique a release manualmente no GitHub.

## Publicar a própria Central

```powershell
npm version patch --no-git-tag-version
npm run publicar
```

A **primeira** instalação é a única feita à mão: envie para as pessoas o `Central-HDL-Setup-x.y.z.exe`, que fica na release do repositório `central-hdl`. O link fixo da última versão é:
`https://github.com/contatomeigre/central-hdl/releases/latest`

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
