# Organização por produto — guia do time

Este documento explica **como o rastreamento funciona** e, principalmente, **como
ver os dados de cada produto** — no painel e no GA4.

---

## 1. Como o sistema funciona (visão geral)

Cada visita e cada venda passa por dois caminhos, e os dois alimentam o GA4:

```
  Navegador (GTM + snippet /t.js) ──► page_view, initiate_checkout ──► GA4
  Plataforma de venda (webhook) ──► Worker ──► purchase, pix, abandono ──► GA4 + banco
```

- **Navegador:** marca quem viu a página (`page_view`) e quem clicou pra comprar
  (`initiate_checkout`). O snippet identifica **qual produto** pela URL do checkout.
- **Servidor (webhook):** quando a venda acontece (PerfectPay/Kirvano), o Worker
  recebe o aviso e manda pro GA4 o que o navegador não tem como saber: `purchase`,
  `pix_generated`, `abandoned_checkout`. Sempre com o **`product_name`** junto.

Resultado: **todo evento importante carrega o nome do produto**, e é isso que
permite separar tudo por produto.

---

## 2. O registro mestre: a lista de produtos

Tudo nasce de uma lista única — a **`productList`** do perfil (em Configurações).
Cada produto tem:

- **`name`** — o nome exato, igual ao que aparece na venda (ex.: `Manuscrito dos Milagres`).
- **`match`** — trechos que identificam o produto na URL do checkout (o `product_id`,
  um slug do nome, etc.). É por isso que o `initiate_checkout` sabe de qual produto é.

> **Regra de ouro:** produto que não está na lista **não tem público próprio** no GA4
> nem separação por etapa. A tela **Ofertas** avisa em amarelo quando um produto vende
> sem estar registrado.

### Como adicionar um produto novo

1. Descubra o `name` e o `product_id` (aparecem na aba **Ofertas** / **Compras**).
2. Adicione em Configurações (nome + padrões de match).
3. Rode o **setup** (atualiza Worker + GTM) e o script de públicos:
   `node scripts/publicos-ga4.mjs --apply`.

---

## 3. O que cada produto ganha automaticamente

Ao registrar um produto, o sistema cria pra ele:

- **Públicos no GA4:** `Checkout {produto}` (7/30/90d), `Compra {produto}` (30/180d),
  `Abandonou {produto}` (30d), `Pix sem pagar {produto}` (15d).
- **Classificação de etapa** (front / order bump / upsell / downsell) pelo produto.
- **Visão no painel** (Ofertas): receita, ticket, pix, abandono, % Google/Meta.

---

## 4. Como ver os dados por produto

### No painel

- **Ofertas** → uma linha por produto, com métricas isoladas + o selo
  **registrado / não registrado**. Clique no produto pra abrir **Compras** já filtrada.
- **Compras / Eventos** → use o filtro **Produto** no topo. Dá pra combinar com
  campanha, plataforma, dispositivo e período, e **exportar em CSV**.

### No GA4

**a) Públicos** (Administrar → Públicos): veja `Checkout {produto}`, `Compra {produto}`,
etc. enchendo. São eles que viram audiência de remarketing/lookalike no Google Ads.

**b) Explorar (relatório personalizado por produto):**
1. GA4 → **Explorar** → nova exploração em branco.
2. Em **Dimensões**, adicione `product_name` (é uma **dimensão personalizada** já
   registrada) e `Nome do evento`.
3. Em **Métricas**, adicione `Contagem de eventos` e `Receita`.
4. Arraste `product_name` para Linhas e `Nome do evento` para Colunas.
5. Adicione um **filtro** `product_name` = *o produto que você quer* para isolar.

Assim você vê, pra cada produto: quantos `page_view`, `initiate_checkout`, `purchase`,
e a receita — tudo separado.

**c) Filtro rápido em qualquer relatório:** em relatórios padrão, clique em
**Adicionar filtro** → `product_name` → escolha o produto.

---

## 5. Organização do GTM (pastas)

O container está dividido em pastas nomeadas, pra qualquer um do time entender:

| Pasta | O que tem |
|---|---|
| `01 · Config & Transporte` | Tag de configuração do GA4 + variável `transporturl` |
| `02 · Snippet` | Tag que carrega o `/t.js` |
| `03 · Eventos GA4` | Tags de `view_item`, `checkout`, `purchase`, order bump/upsell… |
| `04 · Variáveis` | Click IDs, UTMs, cookies, dataLayer (produto, valor, e-mail…) |
| `05 · Acionadores` | Todos os gatilhos (All Pages, cliques de checkout, eventos) |

---

## Lembrete importante

Público do GA4 **não retroage**: começa a encher a partir do momento em que foi
criado. Números pequenos aparecem como `< 10 Users` por privacidade do Google — é
normal, enchem sozinhos com os dias.
