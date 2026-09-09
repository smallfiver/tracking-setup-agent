# Como ver os dados de cada produto no GA4

Guia para a equipe. Leva 5 minutos por produto, você faz uma vez e o relatório
fica salvo para sempre.

---

## Antes de começar

Cada evento que o nosso sistema envia ao GA4 carrega uma etiqueta com o nome do
produto. Essa etiqueta se chama **Produto** e já está criada na propriedade —
você não precisa configurar nada, só usar.

Produtos disponíveis hoje:

- Protocolo de Gênesis
- Mercado de Ações no Brasil
- Acelerador Angelical: 7 Orações para Riqueza.

> A etiqueta só existe nos eventos a partir do dia em que foi criada. Datas
> anteriores aparecem como "(not set)" — isso é esperado, não é erro.

---

## Receita 1 — Exploração rápida (2 minutos)

Para responder "quantas compras esse produto teve esta semana?".

1. No menu da esquerda, clique em **Explorar**
2. Clique em **Exploração em branco**
3. Em **Dimensões**, clique no `+`, procure por **Produto**, marque e clique em **Importar**
4. Em **Dimensões**, clique no `+` de novo, procure por **Nome do evento**, marque e importe
5. Em **Métricas**, clique no `+`, procure por **Contagem de eventos**, marque e importe
6. Arraste **Produto** para o campo **Linhas**
7. Arraste **Nome do evento** para **Linhas** também (fica abaixo de Produto)
8. Arraste **Contagem de eventos** para **Valores**

Pronto. Você vê cada produto e, dentro dele, quantos `initiate_checkout`,
`purchase` e `pix_generated` aconteceram.

**Para filtrar um produto só:** arraste **Produto** para o campo **Filtros**,
escolha "corresponde exatamente" e digite o nome do produto.

---

## Receita 2 — Relatório de receita por produto (3 minutos)

Para responder "quanto cada produto faturou?".

1. **Explorar** → **Exploração em branco**
2. Importe as dimensões **Produto** e **Nome do evento**
3. Importe as métricas **Contagem de eventos** e **Receita total**
4. **Linhas:** Produto
5. **Valores:** Contagem de eventos e Receita total
6. Em **Filtros**, adicione: Nome do evento **corresponde exatamente** `purchase`

Agora a tabela mostra, por produto, quantas compras e quanto entrou.

**Salve para não refazer:** clique no nome da exploração (canto superior
esquerdo, onde está escrito "Exploração sem título") e renomeie para
`Receita por produto`. Ela fica salva na aba Explorar.

---

## Receita 3 — Funil de um produto (5 minutos)

Para responder "onde as pessoas desistem?".

1. **Explorar** → escolha o modelo **Exploração de funil**
2. Em **Etapas**, clique no lápis para editar
3. Monte quatro etapas, cada uma com a condição "Nome do evento é":
   - Etapa 1: `landing`
   - Etapa 2: `initiate_checkout`
   - Etapa 3: `pix_generated`
   - Etapa 4: `purchase`
4. Clique em **Aplicar**
5. Em **Filtros**, adicione: **Produto** corresponde exatamente ao nome do produto

O gráfico mostra quantas pessoas passam de uma etapa para a outra.

---

## O que cada evento significa

| Evento | O que aconteceu |
|---|---|
| `landing` | a pessoa chegou na página (1 por sessão) |
| `initiate_checkout` | clicou no botão de comprar |
| `pix_generated` | gerou o pix, ainda não pagou |
| `purchase` | pagamento aprovado |
| `abandoned_checkout` | chegou no checkout e desistiu |
| `payment_refused` | cartão recusado |

---

## Perguntas frequentes

**"Aparece (not set) no Produto."**
São eventos de antes da etiqueta existir, ou de uma página que ainda não foi
mapeada. Filtre por um período mais recente. Se continuar, avise o responsável
pelo tracking — pode faltar mapear a landing daquele produto.

**"Os números do GA4 não batem com o painel interno."**
Não vão bater exatamente, e está tudo bem:
- o **painel interno** conta a venda quando a plataforma confirma o pagamento
- o **GA4** conta na sessão da pessoa, e ignora quem bloqueia rastreamento

Para valores financeiros, o painel interno e a plataforma de vendas mandam.
Use o GA4 para entender comportamento: de onde veio, o que fez, onde parou.

**"Criei o relatório e está vazio."**
Confira o período no canto superior direito — o padrão costuma ser "últimos 28
dias", mas dados novos levam até 48h para aparecer nos relatórios. Em
**Relatórios → Tempo real** você vê o que está acontecendo agora.

**"Onde vejo isso sem montar relatório?"**
No painel interno, seção **Visão por Produto** na tela inicial: receita,
compras e sessões de cada produto, já prontos.
