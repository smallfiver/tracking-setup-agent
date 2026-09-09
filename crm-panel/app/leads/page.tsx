import { safeQuery } from '../../lib/db';
import { toUsd, usd } from '../../lib/fx';
import { parseMercado } from '../../lib/mercado';
import MarketTabs from '../MarketTabs';

export const revalidate = 0;

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

type Totais = {
  brl: number;
  usd: number;
  compras: number;
  comprasLatam: number;
  semCotacao: string[];
};

const zerado = (): Totais => ({ brl: 0, usd: 0, compras: 0, comprasLatam: 0, semCotacao: [] });

export default async function LeadsPage({
  searchParams
}: {
  searchParams: Record<string, string>;
}) {
  const mercado = parseMercado(searchParams);
  const ehLatam = mercado === 'latam';

  // O valor NAO vem de leads.total_value: aquela coluna e um acumulador que soma
  // o campo "value" cru, sem olhar a moeda — uma venda de 135.360 guaranis
  // entrava la como se fossem 135.360 reais. Aqui recalculamos a partir de
  // purchases, que guarda a moeda linha a linha.
  const { rows: leads, error } = await safeQuery('SELECT * FROM leads');

  const { rows: vendas } = await safeQuery(`
    SELECT customer_email AS email,
           customer_phone AS phone,
           COALESCE(currency, 'BRL') AS moeda,
           COUNT(*) AS vendas,
           COALESCE(SUM(value), 0) AS receita
    FROM purchases
    WHERE event_name = 'purchase'
    GROUP BY email, phone, moeda
  `);

  // O Worker casa a venda ao lead por e-mail OU telefone; repetimos a regra.
  const porEmail = new Map<string, any[]>();
  const porTelefone = new Map<string, any[]>();
  for (const v of vendas) {
    if (v.email) {
      const k = String(v.email);
      porEmail.set(k, [...(porEmail.get(k) || []), v]);
    }
    if (v.phone) {
      const k = String(v.phone);
      porTelefone.set(k, [...(porTelefone.get(k) || []), v]);
    }
  }

  const totaisPorLead = new Map<any, Totais>();
  for (const l of leads) {
    const t = zerado();
    // Set para o lead que casa por e-mail E telefone nao contar a venda duas vezes.
    const linhas = new Set<any>([
      ...(l.email ? porEmail.get(String(l.email)) || [] : []),
      ...(l.phone ? porTelefone.get(String(l.phone)) || [] : [])
    ]);

    for (const v of Array.from(linhas)) {
      const moeda = String(v.moeda);
      const receita = num(v.receita);
      t.compras += num(v.vendas);

      if (moeda === 'BRL') {
        t.brl += receita;
        continue;
      }

      t.comprasLatam += num(v.vendas);
      const emDolar = toUsd(receita, moeda);
      if (emDolar === null) t.semCotacao.push(moeda);
      else t.usd += emDolar;
    }
    totaisPorLead.set(l, t);
  }

  // Cada aba lista só os leads daquele mercado, ordenados pela moeda da aba.
  // Um lead que compra nas duas frentes aparece nas duas listas, com o valor
  // correspondente a cada uma — nunca com os dois valores somados.
  const doMercado = leads.filter((l) => {
    const t = totaisPorLead.get(l) || zerado();
    return ehLatam ? t.comprasLatam > 0 : t.compras - t.comprasLatam > 0;
  });

  const peso = (l: any) => {
    const t = totaisPorLead.get(l) || zerado();
    return ehLatam ? t.usd : t.brl;
  };
  const ordenados = [...doMercado]
    .sort((a, b) => peso(b) - peso(a) || String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, 200);

  const contagem = {
    brasil: leads.filter((l) => {
      const t = totaisPorLead.get(l) || zerado();
      return t.compras - t.comprasLatam > 0;
    }).length,
    latam: leads.filter((l) => (totaisPorLead.get(l) || zerado()).comprasLatam > 0).length
  };

  return (
    <div>
      <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>Leads</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
        Pessoas identificadas por e-mail ou telefone, com a campanha do primeiro e do último clique.
        É esta tabela que você exporta para a API de Conversões (Meta CAPI) e para conversões
        offline do Google Ads. Cada aba mostra só a moeda do seu mercado.
      </p>

      <MarketTabs searchParams={searchParams} atual={mercado} contagem={contagem} />

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{error}</div>
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h2>
            {ordenados.length} lead{ordenados.length === 1 ? '' : 's'}{' '}
            {ehLatam ? 'internacionais' : 'do Brasil'} (top 200 por valor)
          </h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Contato</th>
                <th>Primeiro clique</th>
                <th>Último clique</th>
                <th>Click IDs</th>
                <th>Compras</th>
                <th>{ehLatam ? 'Total USD' : 'Total BRL'}</th>
              </tr>
            </thead>
            <tbody>
              {ordenados.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    Nenhum lead com compra {ehLatam ? 'internacional' : 'em reais'} ainda.
                  </td>
                </tr>
              ) : (
                ordenados.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{l.name || '(sem nome)'}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{l.email || '-'}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{l.phone || ''}</div>
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {l.first_utm_source || (l.first_gclid ? 'google' : '-')}
                      {l.first_utm_campaign && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{l.first_utm_campaign}</div>
                      )}
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>
                      {l.last_utm_source || (l.last_gclid ? 'google' : '-')}
                      {l.last_utm_campaign && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{l.last_utm_campaign}</div>
                      )}
                    </td>
                    <td style={{ fontSize: '0.7rem', fontFamily: 'monospace' }}>
                      {l.last_gclid && <div>gclid ✓</div>}
                      {l.last_gbraid && <div>gbraid ✓</div>}
                      {l.last_wbraid && <div>wbraid ✓</div>}
                      {l.last_fbc && <div>fbc ✓</div>}
                      {l.last_fbp && <div>fbp ✓</div>}
                      {!l.last_gclid && !l.last_gbraid && !l.last_wbraid && !l.last_fbc && (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    {(() => {
                      const t = totaisPorLead.get(l) || zerado();
                      return (
                        <>
                          {/* Só as compras do mercado da aba — o lead que compra
                              nos dois aparece nas duas listas, cada uma com o
                              seu número. */}
                          <td>{ehLatam ? t.comprasLatam : t.compras - t.comprasLatam}</td>
                          <td
                            style={{
                              fontWeight: 600,
                              color: ehLatam
                                ? t.usd > 0 ? 'var(--warning)' : 'var(--text-muted)'
                                : t.brl > 0 ? 'var(--success)' : 'var(--text-muted)'
                            }}
                          >
                            {ehLatam
                              ? t.usd > 0 ? usd(t.usd) : '—'
                              : t.brl > 0 ? money(t.brl) : '—'}
                            {ehLatam && t.semCotacao.length > 0 && (
                              <div style={{ fontSize: '0.7rem', color: 'var(--warning)', fontWeight: 400 }}>
                                sem cotação: {Array.from(new Set(t.semCotacao)).join(', ')}
                              </div>
                            )}
                          </td>
                        </>
                      );
                    })()}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
