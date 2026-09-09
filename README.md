# Agente de Tracking (GTM + GA4 + Cloudflare Workers + D1)

Provisiona, em um clique, todo o rastreamento server-side de um cliente: banco
D1, Worker de coleta, container do GTM configurado e publicado, domínio próprio.

O objetivo é simples: **saber de qual clique veio cada venda**, com os dados do
cliente junto, para otimizar campanha e alimentar Meta CAPI / Google Ads
conversões offline.

Tudo vive na Cloudflare — sem banco externo.

---

## Arquitetura

```
  Site ──┬── GTM ── GA4 (transport_url) ──┐
         │                                 ├──► Worker ──(binding env.DB)──► D1
         └── snippet /t.js ────────────────┘      │
                                                  └──► proxy p/ google-analytics.com
  Plataforma de venda ── webhook ────────► Worker ─────► D1

  Painel Next.js ──(API REST da Cloudflare)──► D1
```

O Worker fala com o D1 por *binding*, dentro da própria Cloudflare — sem
requisição externa no caminho crítico. E faz **proxy** dos hits para o GA4 real,
então você fica com o banco *e* com os relatórios do GA4 funcionando.

---

## Vários clientes

Cada cliente é um **perfil**: conta Cloudflare, banco D1, container do GTM, GA4,
Worker e domínio próprios. O seletor na barra lateral troca o cliente e todas as
telas passam a mostrar os dados dele.

Como um Worker vive dentro de uma conta Cloudflare, clientes em contas
diferentes têm necessariamente um deploy cada — os perfis são o que torna isso
gerenciável a partir de um único painel.

Os perfis ficam em `tracking.profiles.json` (fora do Git, permissão 600). A
service account do Google é **uma só**, compartilhada: convide o mesmo robô para
o GTM de cada cliente.

---

## O que é criado por perfil

**Cloudflare D1** — três tabelas, migradas de forma incremental (`ALTER TABLE`),
então rodar de novo nunca perde dado:

| Tabela | Conteúdo |
|---|---|
| `events` | eventos de navegação e conversão, com click IDs, UTMs, dados do cliente e payload cru |
| `purchases` | todo webhook da plataforma: aprovada, pix, boleto, abandono, reembolso, chargeback |
| `leads` | pessoa consolidada por e-mail/telefone, com atribuição de primeiro e último clique |

**Cloudflare Worker** — endpoints:

| Rota | Função |
|---|---|
| `GET /t.js` | snippet de rastreamento first-party |
| `GET\|POST /g/collect` | recebe os hits do GA4 e repassa ao GA4 real |
| `POST /collect` | evento rico em JSON (dados completos do cliente) |
| `POST /webhook[/plataforma]` | webhooks das plataformas de venda |
| `GET /health` | saúde do Worker e do banco |

**GTM** — container web idempotente (procurado pelo nome, atualizado se já
existir), com variáveis de URL (6 click IDs + 5 UTMs), de cookie (`_fbc`,
`_fbp`, `_tsid`) e de dataLayer; acionadores; e tags GA4 para `view_item`,
`add_to_cart`, `initiate_checkout`, `begin_checkout`, `add_payment_info`,
`generate_lead` e `purchase`.

---

## Uso

```bash
npm install
npm --prefix crm-panel install
npm run panel
```

Abra `http://localhost:3000/settings`, clique em **Novo cliente**, preencha e
clique em **Salvar e rodar setup**. Da segunda vez em diante é só escolher o
cliente na aba e rodar — nada precisa ser redigitado, e os campos secretos não
voltam para a tela.

Pela linha de comando funciona igual, usando o perfil ativo:

```bash
npm start
```

Para rodar um perfil específico: `SETUP_PROFILE=cliente-a npm start`.

### Pré-requisitos por cliente

- **Cloudflare**: Account ID + API Token com **`Workers Scripts: Edit`** e
  **`D1: Edit`**. O template pronto "Edit Cloudflare Workers" pode não incluir
  D1 — confira e adicione. O setup valida isso logo no início.
- **GTM**: Account ID numérico (aparece na URL do container), e a service
  account precisa de permissão de **Publicar** na conta.
- **GA4**: Measurement ID (`G-XXXXXXXX`).
- **Domínio** (opcional): `track.dominiodocliente.com`, com o domínio já
  adicionado nessa conta Cloudflare.

---

## Depois do setup

**1. Webhooks.** Aponte para `<worker>/webhook` e marque **todos** os eventos,
não só compra aprovada — pix gerado, boleto, carrinho abandonado, reembolso e
chargeback também entram. Para identificar a origem, use
`<worker>/webhook/kiwify`, `/hotmart`, `/perfectpay`, etc.

Normalizadores prontos: Kiwify, Hotmart, PerfectPay, Monetizze, Braip, Eduzz,
CartPanda e um genérico. Aceita JSON e form-urlencoded.

**2. Eventos no site.** Duas formas:

```js
// via dataLayer (o snippet espelha automaticamente)
dataLayer.push({
  event: 'begin_checkout',
  ecommerce: { value: 197, currency: 'BRL', items: [...] },
  customer: { email: 'cliente@email.com', phone: '11999998888' }
});

// ou direto
tsTrack('initiate_checkout', { value: 197, customer: { email: '...' } });
tsIdentify({ email: '...', phone: '...', name: '...' });
tsData();   // debug: mostra tsid, atribuição e cliente conhecidos
```

O snippet também faz sozinho: persiste click IDs e UTMs por 90 dias, gera um
`tsid` que costura navegação → venda, lê `_fbc`/`_fbp`/`_ga`, captura
e-mail/telefone em formulários, e **propaga `tsid` e click IDs para links de
checkout em outro domínio**.

**3. Atribuição costurada.** Se o webhook não trouxer o `gclid`, o Worker busca
o evento mais recente do mesmo cliente (por `tsid`, e-mail, telefone ou
transaction_id) e herda a campanha. A coluna `attribution_source` diz se veio
`webhook`, `stitched` ou `none`.

---

## Envio de conversões — o que faz a campanha melhorar

Guardar dado não otimiza nada. O que move o ponteiro é **devolver a conversão**
para as plataformas. Assim que o webhook de compra aprovada chega, o Worker
dispara sozinho:

**Google Ads — conversões offline.** Sobe a venda com `gclid`/`gbraid`/`wbraid`,
valor, moeda e `orderId`. É o item de maior impacto em funil de infoproduto: o
pix é aprovado horas depois, o checkout é em outro domínio, e a tag do navegador
ou não dispara ou dispara em pedido que nunca foi pago. **Só o webhook sabe o que
virou dinheiro.**

**Meta CAPI.** Envia `Purchase`, `Lead` e `InitiateCheckout` pelo servidor com
`fbc`, `fbp` e e-mail/telefone/cidade/estado/CEP com **hash SHA-256** (nada
pessoal em texto puro). Usa o mesmo `event_id` do pixel, então o Meta deduplica
os dois caminhos em vez de contar duas vezes.

Garantias:

- **Nunca envia duas vezes.** Índice único em `conversions_log` — se a plataforma
  reenviar o webhook, o segundo é ignorado.
- **Sem credencial, não tenta.** Se você não preencher, nada é enviado e a venda
  continua sendo gravada normalmente.
- **Sem click ID do Google, pula o Google Ads** (não há o que atribuir) e segue
  enviando para o Meta.
- Cada tentativa fica registrada com status e resposta na aba **Conversões**.

### O que você precisa

| Meta CAPI | Onde pegar |
|---|---|
| Pixel ID | Events Manager |
| Access Token | Events Manager → Configurações → API de Conversões |

| Google Ads | Onde pegar |
|---|---|
| Customer ID | canto superior da conta |
| ID da ação de conversão | crie uma conversão "Importar → De cliques"; o ID está na URL |
| OAuth Client ID/Secret | Google Cloud → Credenciais |
| Refresh Token | fluxo OAuth com escopo `adwords` |
| Developer Token | Google Ads API Center — **precisa de aprovação, leva alguns dias** |

O developer token é o único item com espera. Até sair, o Meta CAPI já funciona
sozinho.

---

## Order Bump, Upsell e Downsell

Em funil de infoproduto, o order bump, o upsell e o downsell chegam como
**vendas separadas** (webhooks distintos, cada um com seu `transaction_id`), mas
com o **mesmo cliente**. O que os diferencia é o **produto** — o e-mail é o
indexador que costura todas as etapas à mesma pessoa.

O sistema classifica cada venda aprovada em `front`, `order_bump`, `upsell` ou
`downsell` e guarda isso na coluna `purchase_type`. Você informa quais produtos
são de cada etapa no perfil (aba Configurações → *Order Bump / Upsell /
Downsell*), por ID ou nome, separados por vírgula. Prefixe com `re:` para regex:

```
Order Bump:  998877, bump-garantia
Upsell:      445566, oferta-vip, re:upsell\d+
Downsell:    112233, plano-basico
```

O que **não casar com nenhuma lista é tratado como `front`** — a venda principal
é o padrão seguro, então nada fica sem etapa.

Onde isso aparece e o que passa a funcionar:

- **Painel.** A aba Vendas ganha a coluna *Etapa* e o dashboard mostra
  **receita por etapa do funil** (front / order bump / upsell / downsell).
- **Conversões.** Cada etapa é uma venda de verdade, com seu próprio
  `transaction_id` — então dispara sua própria conversão (Meta `Purchase` /
  Google Ads), sem risco de duplicar. O Meta ainda recebe `content_ids` e
  `funnel_step` para segmentar.
- **GTM/GA4.** Quando você informa as listas, o setup cria tags GA4 próprias
  (`purchase_order_bump`, `purchase_upsell`, `purchase_downsell`) com acionador
  por regex de `product_id`, espelhando a classificação no lado do navegador.
- **Costura pelo indexador.** O snippet propaga o e-mail (além de `tsid` e click
  IDs) para links **e iframes** de checkout, inclusive os injetados depois por
  players de VSL. Botões de checkout são forçados para a mesma aba, para o
  redirecionador não ser cortado por uma nova guia.

A classificação definitiva é **server-side**, pelo webhook — a parte do GTM é só
o espelho no navegador. Ou seja: mesmo sem tocar no GTM, basta preencher as
listas no perfil e rodar o setup para o funil passar a ser separado.

---

## page_view e os limites do D1

Por padrão **`page_view` não é gravado no banco**. O GA4 continua recebendo os
pageviews normalmente — só não gastamos linha do D1 com o evento mais volumoso e
menos útil para otimizar campanha. O banco guarda o que importa: view_item,
add_to_cart, checkout, lead, compra e os webhooks.

O plano grátis do D1 tem um teto diário de escritas (na casa das 100 mil linhas).
Com `page_view` desligado, um site precisa de muito volume para chegar perto. Se
quiser gravar tudo, marque a opção no perfil e considere o Workers Paid.

---

## Verificação

```bash
npm test
```

Roda a lógica do Worker contra payloads reais das plataformas, com o D1 simulado
— não precisa de credencial nem de rede.

Em produção: `curl https://<worker>/health`.

O painel mostra funil, receita por campanha e o **% de vendas com atribuição** —
esse número é o termômetro: se cair, algo quebrou no rastreamento.

---

## Segurança

- `service-account.json`, `tracking.profiles.json` e `.env*` estão no `.gitignore`.
- Os perfis são gravados com permissão 600 e os segredos nunca são devolvidos ao
  navegador — o formulário só sabe *se* estão preenchidos.
- `/api/setup` e `/api/profiles` só aceitam chamadas locais; para liberar
  remotamente defina `SETUP_PASSWORD` no `.env.local` do painel.

---

## Cruzando os dados

```sql
-- receita por campanha
SELECT utm_campaign, COUNT(*) vendas, SUM(value) receita
FROM purchases WHERE event_name = 'purchase'
GROUP BY utm_campaign ORDER BY receita DESC;

-- vendas prontas para conversão offline do Google Ads
SELECT gclid, transaction_id, value, currency, created_at
FROM purchases WHERE event_name = 'purchase' AND gclid IS NOT NULL;

-- audiência para Meta CAPI (faça o hash SHA-256 na exportação)
SELECT customer_email, customer_phone, fbc, fbp, value, transaction_id
FROM purchases WHERE event_name = 'purchase';

-- onde o funil está vazando
SELECT event_name, COUNT(*) FROM events GROUP BY event_name;

-- receita por etapa do funil (front / order bump / upsell / downsell)
SELECT COALESCE(purchase_type, 'front') etapa, COUNT(*) vendas, SUM(value) receita
FROM purchases WHERE event_name = 'purchase'
GROUP BY etapa ORDER BY receita DESC;
```
