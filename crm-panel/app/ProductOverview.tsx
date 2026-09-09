import { safeQuery } from '../lib/db';
import { toUsd, usd } from '../lib/fx';

/**
 * Visao por Produto.
 *
 * A equipe pensa por oferta, nao por evento solto. Esta secao junta, para cada
 * produto: quanto entrou, quantas compras e quantas sessoes chegaram — que sao
 * as tres perguntas que aparecem em toda reuniao.
 *
 * Sessoes vem de events (navegacao) e receita de purchases (webhook), entao a
 * juncao e feita aqui, pelo nome do produto.
 *
 * Receita aparece em duas colunas — reais e internacional em dolar — porque
 * somar moedas diferentes nao significa nada. Um produto que so vende no
 * exterior mostrava "R$ 0,00" e "conversao 0%" mesmo sendo o campeao de vendas.
 */

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

const money = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

/** Cotacao so para ORDENAR os cards; nao aparece como valor em lugar nenhum. */
const BRL_POR_USD = 5.4;

type Linha = {
  produto: string;
  receita: number;
  receitaUsd: number;
  compras: number;
  latam: number;
  latamSemCotacao: number;
  sessoes: number;
  pessoas: number;
  checkouts: number;
  pix: number;
};

export default async function ProductOverview() {
  const [vendas, navegacao] = await Promise.all([
    // Uma linha por produto E por moeda: a conversao para dolar precisa saber
    // qual moeda e cada valor, entao ela e feita aqui e nao no SQL.
    safeQuery(`
      SELECT product_name AS produto,
             COALESCE(currency,'BRL') AS moeda,
             SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS compras,
             COALESCE(SUM(CASE WHEN event_name = 'purchase' THEN value ELSE 0 END), 0) AS receita,
             SUM(CASE WHEN event_name = 'pix_generated' THEN 1 ELSE 0 END) AS pix
      FROM purchases
      WHERE product_name IS NOT NULL
      GROUP BY produto, moeda
    `),
    safeQuery(`
      SELECT product_name AS produto,
             COUNT(DISTINCT session_id) AS sessoes,
             COUNT(DISTINCT tsid) AS pessoas,
             SUM(CASE WHEN event_name = 'initiate_checkout' THEN 1 ELSE 0 END) AS checkouts
      FROM events
      WHERE product_name IS NOT NULL
      GROUP BY produto
    `)
  ]);

  if (vendas.error || navegacao.error) return null;

  const mapa = new Map<string, Linha>();
  const pegar = (produto: string): Linha => {
    if (!mapa.has(produto)) {
      mapa.set(produto, {
        produto,
        receita: 0,
        receitaUsd: 0,
        compras: 0,
        latam: 0,
        latamSemCotacao: 0,
        sessoes: 0,
        pessoas: 0,
        checkouts: 0,
        pix: 0
      });
    }
    return mapa.get(produto)!;
  };

  for (const r of vendas.rows) {
    const linha = pegar(String(r.produto));
    const moeda = String(r.moeda);
    linha.pix += num(r.pix);

    if (moeda === 'BRL') {
      linha.receita += num(r.receita);
      linha.compras += num(r.compras);
      continue;
    }

    linha.latam += num(r.compras);
    const emDolar = toUsd(num(r.receita), moeda);
    // Sem cotacao a venda e contada, mas nao entra na receita — melhor um card
    // que avisa do buraco do que um numero que finge estar completo.
    if (emDolar === null) linha.latamSemCotacao += num(r.compras);
    else linha.receitaUsd += emDolar;
  }
  for (const r of navegacao.rows) {
    const linha = pegar(String(r.produto));
    linha.sessoes = num(r.sessoes);
    linha.pessoas = num(r.pessoas);
    linha.checkouts = num(r.checkouts);
  }

  // Ordena pelo peso real do produto. Antes era so a receita em reais, e o
  // produto que mais vende — todo ele no exterior — caia para o fim da fila.
  const peso = (l: Linha) => l.receita + l.receitaUsd * BRL_POR_USD;
  const linhas = Array.from(mapa.values()).sort((a, b) => peso(b) - peso(a));
  if (!linhas.length) return null;

  return (
    <div style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.35rem', fontWeight: 600 }}>Visão por Produto</h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {linhas.length} produto{linhas.length > 1 ? 's' : ''}
        </span>
      </div>

      <div className="card-grid">
        {linhas.map((l) => {
          // A conversao conta TODAS as compras, nao so as em reais: um produto
          // que vende 60 vezes no exterior mostrava "0%" so porque nenhuma
          // dessas vendas era em BRL.
          const comprasTotais = l.compras + l.latam;
          // Sem sessao registrada, a taxa nao significa nada — melhor omitir.
          const taxa = l.sessoes > 0 ? (comprasTotais / l.sessoes) * 100 : null;
          const ticket = l.compras > 0 ? l.receita / l.compras : 0;
          const ticketUsd = l.latam > l.latamSemCotacao
            ? l.receitaUsd / (l.latam - l.latamSemCotacao)
            : 0;

          return (
            <div key={l.produto} className="card">
              <div
                className="card-title"
                style={{ color: 'var(--text-main)', fontWeight: 600, marginBottom: '0.75rem' }}
                title={l.produto}
              >
                {l.produto}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                <div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                    {l.receitaUsd > 0 && l.receita === 0 ? 'Receita USD' : 'Receita BRL'}
                  </div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--success)' }}>
                    {l.receitaUsd > 0 && l.receita === 0 ? usd(l.receitaUsd) : money(l.receita)}
                  </div>
                  {/* Produto que vende nas duas frentes mostra a segunda linha. */}
                  {l.receita > 0 && l.receitaUsd > 0 && (
                    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--warning)' }}>
                      + {usd(l.receitaUsd)}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Compras</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{comprasTotais}</div>
                  {l.latam > 0 && l.compras > 0 && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      {l.compras} BR · {l.latam} intl
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Sessões</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                    {l.sessoes > 0 ? l.sessoes.toLocaleString('pt-BR') : '—'}
                  </div>
                </div>
              </div>

              <div
                style={{
                  marginTop: '0.85rem',
                  paddingTop: '0.75rem',
                  borderTop: '1px solid var(--border)',
                  fontSize: '0.72rem',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.75rem'
                }}
              >
                {l.compras > 0 && <span>Ticket {money(ticket)}</span>}
                {ticketUsd > 0 && <span>Ticket intl {usd(ticketUsd)}</span>}
                {l.checkouts > 0 && <span>{l.checkouts.toLocaleString('pt-BR')} checkouts</span>}
                {l.pix > 0 && <span>{l.pix} pix</span>}
                {l.latamSemCotacao > 0 && (
                  <span style={{ color: 'var(--warning)' }}>
                    {l.latamSemCotacao} venda{l.latamSemCotacao > 1 ? 's' : ''} sem cotação em fx.ts
                  </span>
                )}
                {taxa !== null ? (
                  <span style={{ color: taxa >= 1 ? 'var(--success)' : 'var(--text-muted)' }}>
                    conversão {taxa.toFixed(2)}%
                  </span>
                ) : (
                  <span style={{ color: 'var(--warning)' }}>
                    sem sessão — falta mapear em productList
                  </span>
                )}
              </div>

              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.75rem' }}>
                <a
                  href={`/purchases?product=${encodeURIComponent(l.produto)}`}
                  style={{ fontSize: '0.72rem', color: 'var(--primary)' }}
                >
                  ver vendas
                </a>
                <a
                  href={`/events?product=${encodeURIComponent(l.produto)}`}
                  style={{ fontSize: '0.72rem', color: 'var(--primary)' }}
                >
                  ver eventos
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
