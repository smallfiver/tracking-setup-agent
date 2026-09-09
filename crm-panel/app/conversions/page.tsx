import { safeQuery } from '../../lib/db';
import { getProfile } from '../../lib/profiles';
import { parseConversionFilters, buildConversionsWhere } from '../../lib/filters';
import ConversionFilters from '../ConversionFilters';

export const revalidate = 0;

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: any, currency?: any) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: (currency as string) || 'BRL' }).format(
    Number(v) || 0
  );

const DESTINATION = {
  meta: { label: 'Meta CAPI', color: '#0866ff' },
  google_ads: { label: 'Google Ads', color: '#fbbc04' }
} as const;

const STATUS = {
  sent: { label: 'Enviado', bg: 'rgba(16,185,129,0.12)', color: 'var(--success)' },
  error: { label: 'Erro', bg: 'rgba(239,68,68,0.12)', color: 'var(--danger)' },
  skipped: { label: 'Não enviado', bg: 'rgba(148,163,184,0.12)', color: 'var(--text-muted)' },
  pending: { label: 'Em andamento', bg: 'rgba(245,158,11,0.12)', color: 'var(--warning)' }
} as const;

export default async function ConversionsPage({
  searchParams
}: {
  searchParams: Record<string, string>;
}) {
  const profile = getProfile(null);

  const filters = parseConversionFilters(searchParams);
  const { where, params } = buildConversionsWhere(filters);

  const { rows: log, error } = await safeQuery(
    `SELECT * FROM conversions_log ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  );

  // Eventos distintos para o dropdown de filtro.
  const { rows: eventRows } = await safeQuery(
    'SELECT DISTINCT event_name FROM conversions_log WHERE event_name IS NOT NULL ORDER BY event_name'
  );
  const eventNames = eventRows.map((r) => String(r.event_name));

  const { rows: summary } = await safeQuery(`
    SELECT destination, status, COUNT(*) AS total, COALESCE(SUM(value), 0) AS valor
    FROM conversions_log GROUP BY destination, status
  `);

  // Vendas que o Google Ads nunca vai receber por falta de click ID.
  const { rows: gaps } = await safeQuery(`
    SELECT COUNT(*) AS total FROM purchases
    WHERE event_name = 'purchase'
      AND gclid IS NULL AND gbraid IS NULL AND wbraid IS NULL
  `);

  const stat = (destination: string, status: string) =>
    summary.find((r) => r.destination === destination && r.status === status);

  const metaEnabled = profile?.state?.metaEnabled;
  const googleEnabled = profile?.state?.googleAdsEnabled;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>Conversões enviadas</h1>
        {profile?.name && <span style={{ color: 'var(--text-muted)' }}>· {profile.name}</span>}
      </div>
      <p style={{ color: 'var(--text-muted)', marginBottom: '2rem' }}>
        O que sai daqui de volta para o Google Ads e para o Meta. É isso que faz o algoritmo
        aprender — dado parado no banco não otimiza campanha.
      </p>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{error}</div>
        </div>
      )}

      <div className="card-grid">
        {(['meta', 'google_ads'] as const).map((dest) => {
          const enabled = dest === 'meta' ? metaEnabled : googleEnabled;
          const sent = stat(dest, 'sent');
          const failed = stat(dest, 'error');
          return (
            <div key={dest} className="card">
              <div className="card-title" style={{ color: DESTINATION[dest].color }}>
                {DESTINATION[dest].label}
              </div>
              {!enabled ? (
                <>
                  <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    Não configurado
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                    Preencha as credenciais em Configurações e rode o setup.
                  </div>
                </>
              ) : (
                <>
                  <div className="card-value" style={{ color: 'var(--success)' }}>{num(sent?.total)}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                    {money(num(sent?.valor))} enviados
                    {num(failed?.total) > 0 && (
                      <span style={{ color: 'var(--danger)' }}> · {num(failed?.total)} com erro</span>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}

        <div className="card">
          <div className="card-title">Vendas sem click ID do Google</div>
          <div
            className="card-value"
            style={{ color: num(gaps[0]?.total) > 0 ? 'var(--warning)' : 'var(--success)' }}
          >
            {num(gaps[0]?.total)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
            Não podem ser enviadas como conversão offline. Se este número for alto, a captura do
            gclid está falhando.
          </div>
        </div>
      </div>

      <ConversionFilters events={eventNames} />

      <div className="table-container">
        <div className="table-header">
          <h2>Últimos 200 envios{filters.destination ? ` — ${filters.destination === 'meta' ? 'Meta CAPI' : 'Google Ads'}` : ''}</h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Destino</th>
                <th>Evento</th>
                <th>Transação</th>
                <th>Valor</th>
                <th>Status</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {log.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    Nenhuma conversão enviada ainda.
                  </td>
                </tr>
              ) : (
                log.map((c, i) => {
                  const dest = DESTINATION[c.destination as keyof typeof DESTINATION];
                  const st = STATUS[c.status as keyof typeof STATUS] || STATUS.pending;
                  return (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                        {new Date(String(c.created_at).replace(' ', 'T') + 'Z').toLocaleString('pt-BR')}
                      </td>
                      <td style={{ fontSize: '0.8rem', color: dest?.color, fontWeight: 500 }}>
                        {dest?.label || c.destination}
                      </td>
                      <td style={{ fontSize: '0.8rem' }}>{c.event_name}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{c.transaction_id || '-'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{money(c.value, c.currency)}</td>
                      <td>
                        <span className="badge" style={{ background: st.bg, color: st.color }}>
                          {st.label}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.72rem', color: 'var(--text-muted)', maxWidth: 320 }}>
                        {c.detail || '-'}
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
