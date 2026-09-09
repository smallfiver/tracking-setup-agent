import { safeQuery } from '../../lib/db';
import { parseFilters, buildWhere } from '../../lib/filters';
import { withProductFallback } from '../../lib/productFilter';
import { parseMercado, comMercado, mercadoSql } from '../../lib/mercado';
import { toUsd, usd } from '../../lib/fx';
import FilterBar from '../FilterBar';
import MarketTabs from '../MarketTabs';

export const revalidate = 0;

const money = (v: any, currency?: any) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: (currency as string) || 'BRL'
  }).format(Number(v) || 0);

const EVENT_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  purchase: { label: 'Aprovada', bg: 'rgba(16,185,129,0.12)', color: 'var(--success)' },
  pix_generated: { label: 'Pix gerado', bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' },
  boleto_generated: { label: 'Boleto gerado', bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' },
  abandoned_checkout: { label: 'Abandonado', bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
  refund: { label: 'Reembolso', bg: 'rgba(239,68,68,0.12)', color: 'var(--danger)' },
  chargeback: { label: 'Chargeback', bg: 'rgba(239,68,68,0.12)', color: 'var(--danger)' },
  payment_refused: { label: 'Recusado', bg: 'rgba(239,68,68,0.12)', color: 'var(--danger)' },
  canceled: { label: 'Cancelado', bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' }
};

const PURCHASE_TYPE_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  front: { label: 'Front', bg: 'rgba(59,130,246,0.14)', color: '#3b82f6' },
  order_bump: { label: 'Order Bump', bg: 'rgba(168,85,247,0.16)', color: '#a855f7' },
  upsell: { label: 'Upsell', bg: 'rgba(16,185,129,0.14)', color: 'var(--success)' },
  downsell: { label: 'Downsell', bg: 'rgba(245,158,11,0.14)', color: '#f59e0b' }
};

const ATTRIBUTION_LABEL: Record<string, string> = {
  webhook: 'do webhook',
  stitched: 'costurada',
  none: 'sem atribuição',
  error: 'erro'
};

export default async function PurchasesPage({
  searchParams
}: {
  searchParams: Record<string, string>;
}) {
  const filters = withProductFallback(parseFilters(searchParams));
  const { where, params } = buildWhere(filters);
  const mercado = parseMercado(searchParams);

  // A lista respeita a aba: BRL e moeda estrangeira nunca aparecem juntas, mesmo
  // que cada linha traga a sua moeda — ler as duas na mesma tabela induz a erro.
  const { rows: purchases, error } = await safeQuery(
    `SELECT * FROM purchases ${comMercado(where, mercado)} ORDER BY created_at DESC LIMIT 200`,
    params
  );

  const { rows: porMercado } = await safeQuery(
    `SELECT ${mercadoSql('latam')} AS internacional, COUNT(*) AS linhas
     FROM purchases ${where || ''} GROUP BY internacional`,
    params
  );
  const n = (v: any) => (v === null || v === undefined ? 0 : Number(v));
  const contagem = {
    brasil: n(porMercado.find((r) => n(r.internacional) === 0)?.linhas),
    latam: n(porMercado.find((r) => n(r.internacional) === 1)?.linhas)
  };

  return (
    <div>
      <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '0.5rem' }}>Vendas e Webhooks</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
        Todo evento recebido da plataforma de venda: aprovada, pix/boleto, abandono, reembolso e chargeback.
      </p>

      <MarketTabs searchParams={searchParams} atual={mercado} contagem={contagem} />

      <FilterBar table="purchases" />

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{error}</div>
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h2>Últimos 200 registros{filters.product ? ` — ${filters.product}` : ''}</h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Status</th>
                <th>Transação</th>
                <th>Cliente</th>
                <th>Produto</th>
                <th>Dispositivo</th>
                <th>Etapa</th>
                <th>Atribuição</th>
                <th>Valor</th>
                <th>JSON</th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
                    Nenhum webhook recebido ainda.
                  </td>
                </tr>
              ) : (
                purchases.map((p, i) => {
                  const style =
                    EVENT_STYLE[String(p.event_name)] || {
                      label: String(p.event_name || '-'),
                      bg: 'rgba(148,163,184,0.15)',
                      color: '#94a3b8'
                    };
                  return (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                        {new Date(String(p.created_at).replace(' ', 'T') + 'Z').toLocaleString('pt-BR')}
                      </td>
                      <td>
                        <span className="badge" style={{ background: style.bg, color: style.color }}>
                          {style.label}
                        </span>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          {p.platform}
                        </div>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{p.transaction_id || '-'}</td>
                      <td style={{ fontSize: '0.75rem' }}>
                        <div>{p.customer_name || '-'}</div>
                        <div style={{ color: 'var(--text-muted)' }}>{p.customer_email || ''}</div>
                        <div style={{ color: 'var(--text-muted)' }}>{p.customer_phone || ''}</div>
                      </td>
                      <td style={{ fontSize: '0.78rem' }}>
                        {p.product_name || p.product_id || '-'}
                        {p.coupon_code && (
                          <div style={{ fontSize: '0.7rem', color: '#f59e0b' }}>cupom {p.coupon_code}</div>
                        )}
                        {p.original_value && Number(p.original_value) > Number(p.value) && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            de {money(p.original_value, p.currency)}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: '0.72rem' }}>
                        {p.device_type ? (
                          <>
                            <div>{p.device_type}</div>
                            <div style={{ color: 'var(--text-muted)' }}>{p.browser}</div>
                            <div style={{ color: 'var(--text-muted)' }}>
                              {[p.geo_city, p.geo_region].filter(Boolean).join(' · ')}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                      <td>
                        {p.event_name === 'purchase' && p.purchase_type
                          ? (() => {
                              const ts =
                                PURCHASE_TYPE_STYLE[String(p.purchase_type)] || {
                                  label: String(p.purchase_type),
                                  bg: 'rgba(148,163,184,0.15)',
                                  color: '#94a3b8'
                                };
                              return (
                                <span className="badge" style={{ background: ts.bg, color: ts.color }}>
                                  {ts.label}
                                </span>
                              );
                            })()
                          : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>}
                      </td>
                      <td style={{ fontSize: '0.75rem' }}>
                        <div>{p.utm_source || (p.gclid ? 'google' : p.fbclid ? 'facebook' : '-')}</div>
                        {p.utm_campaign && (
                          <div style={{ color: 'var(--text-muted)' }}>{p.utm_campaign}</div>
                        )}
                        <div
                          style={{
                            color: p.attribution_source === 'none' ? 'var(--danger)' : 'var(--text-muted)',
                            fontSize: '0.68rem'
                          }}
                        >
                          {ATTRIBUTION_LABEL[String(p.attribution_source)] || '-'}
                          {p.gclid ? ' · gclid ✓' : ''}
                        </div>
                      </td>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {/* Na aba LATAM o dolar vem em destaque, porque e a moeda
                            de leitura do mercado; abaixo fica o valor realmente
                            cobrado, que e o que aparece no extrato da plataforma. */}
                        {mercado === 'latam' ? (
                          (() => {
                            const emDolar = toUsd(Number(p.value) || 0, String(p.currency || ''));
                            return (
                              <>
                                <div style={{ color: 'var(--warning)' }}>
                                  {emDolar === null ? '—' : usd(emDolar)}
                                </div>
                                {String(p.currency || '').toUpperCase() !== 'USD' && (
                                  <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>
                                    {emDolar === null ? 'sem cotação · ' : ''}
                                    {money(p.value, p.currency)}
                                  </div>
                                )}
                              </>
                            );
                          })()
                        ) : (
                          money(p.value, p.currency)
                        )}
                      </td>
                      <td>
                        <details style={{ cursor: 'pointer' }}>
                          <summary style={{ fontSize: '0.75rem', color: 'var(--primary)' }}>ver</summary>
                          <pre
                            style={{
                              fontSize: '0.68rem',
                              background: 'rgba(0,0,0,0.3)',
                              padding: '0.5rem',
                              marginTop: '0.5rem',
                              borderRadius: 4,
                              maxWidth: 320,
                              maxHeight: 240,
                              overflow: 'auto'
                            }}
                          >
                            {p.raw_payload}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
