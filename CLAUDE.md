# Guia para o Claude — configurando o rastreamento de um cliente novo

Este repositório provisiona rastreamento server-side (GTM + GA4 + Cloudflare
Workers + D1) para funis de infoproduto. Se você (Claude) está lendo isso pela
primeira vez neste projeto, siga este roteiro com o usuário — ele guia a
pessoa do zero até o primeiro webhook chegando.

**Antes de tudo**: leia o `README.md` inteiro — ele documenta a arquitetura,
o que cada tabela/rota faz, e o formato de order bump/upsell/downsell. Este
arquivo aqui é só o roteiro de conversa; o README é a referência técnica.

## Passo 1 — Confirmar o que a pessoa já tem

Pergunte, uma coisa de cada vez (não jogue as 4 perguntas juntas — a pessoa
provavelmente não tem todos os dados na mão ainda):

1. Ela já tem conta na **Cloudflare**? (é grátis, precisa criar se não tiver)
2. Ela já tem um container do **Google Tag Manager**? Se não, você cria um
   durante o setup — só precisa do Account ID.
3. Ela tem uma propriedade **GA4**? Mesma lógica: se não tiver, oriente a
   criar uma vazia no analytics.google.com antes de continuar.
4. Qual plataforma de pagamento ela usa (Kirvano, Kiwify, Hotmart, PerfectPay,
   Monetizze, Braip, Eduzz, CartPanda)? Isso não bloqueia o setup, mas define
   o que testar depois.

## Passo 2 — Credenciais Cloudflare

Ela precisa gerar um API Token em
`dash.cloudflare.com` → **Meu Perfil → Tokens de API → Criar Token**, com
permissões **`Workers Scripts: Edit`** e **`D1: Edit`** (o template pronto
"Edit Cloudflare Workers" às vezes não inclui D1 — avise pra conferir).

Também precisa do **Account ID** (aparece na barra lateral do dashboard,
ou na URL).

**Nunca peça pra ela colar o token na conversa em texto puro se puder
evitar** — o setup roda via `npm run panel` (`http://localhost:3000/settings`),
que tem um formulário próprio e nunca devolve os segredos pra tela depois de
salvos. Prefira guiá-la a preencher lá.

## Passo 3 — Service Account do Google (compartilhada, não é por cliente)

O projeto usa **uma única service account do Google**, referenciada em
`service-account.json` (fora do Git, veja `.env.example` para o formato
esperado). Se a pessoa ainda não tem uma:

1. Google Cloud Console → criar projeto → ativar **Tag Manager API** e
   **Google Analytics Admin API**.
2. Criar uma Service Account, gerar uma chave JSON, salvar como
   `service-account.json` na raiz do projeto.
3. Convidar o e-mail dessa service account como usuário com permissão de
   **Publicar** no GTM, e como usuário no GA4 (Admin ou Editor).

## Passo 4 — Instalar e rodar

```bash
npm install
npm --prefix crm-panel install
npm run panel
```

Abra `http://localhost:3000/settings`, clique em **Novo cliente**, preencha
os campos (Cloudflare, GTM, GA4) e clique em **Salvar e rodar setup**. Isso
cria o banco D1, publica o Worker, configura e publica o container do GTM —
tudo em um clique. Acompanhe o log na tela; se algo falhar, geralmente é
permissão faltando (confira o Passo 2/3).

## Passo 5 — Depois que o setup terminar

1. **Confirme que o Worker respondeu**: `curl <worker-url>/health` deve
   devolver `{"ok":true,...}`.
2. **Cole o snippet do GTM** na página de vendas dela (o setup mostra o
   `GTM-XXXXXXX` no final — o código head+body é o snippet padrão do Google
   Tag Manager, não precisa de nada além disso).
3. **Configure o webhook** na plataforma de pagamento dela, apontando pra
   `<worker-url>/webhook/<plataforma>` (ex: `/webhook/kirvano`). Marque
   **todos os eventos disponíveis**, não só compra aprovada — veja a seção
   "Depois do setup" do README para a lista completa e por quê isso importa.
4. **Teste de ponta a ponta**: abra a página dela, confirme que o GTM carrega
   (`window.dataLayer` deve existir), clique no botão de checkout e confirme
   que o link final tem `tsid`/`gclid` carimbados. Dispare um evento de teste
   na plataforma de pagamento e confirme que aparece no D1 classificado
   corretamente.

## Cadastrando produtos (quando ela tiver mais de uma oferta)

Cada produto pode ganhar uma propriedade GA4 e um container GTM **dedicados**
(ver `scripts/propriedades-por-produto.mjs` e `scripts/containers-por-produto.mjs`),
e um token de identificação (UUID do checkout, código do produto, ou domínio
da landing page) no campo `productList` do perfil — é isso que faz o Worker
saber de qual produto veio cada venda quando o webhook não deixa óbvio.

**Sempre confira colisão antes de adicionar um token novo** — dois produtos
não podem compartilhar o mesmo identificador, ou um vai roubar as vendas do
outro silenciosamente.

## Erros comuns (e o que costuma ser)

- **Webhook não gera nenhuma linha no D1, nem `abandoned_checkout`**: o
  webhook nunca foi configurado na plataforma de pagamento — não é bug no
  Worker. Confirme a URL e se os eventos estão marcados.
- **Produto aparece como `unknown_status` ou sem nome**: falta um token de
  identificação pra esse produto no perfil, ou a plataforma manda o campo em
  um formato/casing diferente do esperado (aconteceu com a Kiwify, que manda
  `Product.product_id` com P maiúsculo — veja `normalizeWebhook` em
  `worker/worker.js` se isso se repetir com outra plataforma).
- **Painel lento/travando**: confirme que está rodando em modo produção
  (`npm run build && npm run start` dentro de `crm-panel/`), não em modo dev
  (`next dev` recompila a cada navegação e trava sob uso real).
- **`PRODUCT_LIST` estourando limite de binding da Cloudflare (5.1kB)**: já
  resolvido — a lista mora na tabela `kv_config` do D1, não no binding do
  Worker. Se voltar a acontecer outro binding grande demais, o mesmo padrão
  (mover pra D1 com cache curto) resolve.

## Regra geral de trabalho

Verifique tudo ao vivo antes de dizer que está funcionando — abra a página
real, dispare um evento de teste real, confira a linha real no banco. Nunca
assuma que algo está configurado certo só porque o passo anterior não deu
erro.
