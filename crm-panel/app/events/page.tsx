import { safeQuery } from '../../lib/db';
import { parseFilters, buildWhere } from '../../lib/filters';
import { withProductFallback } from '../../lib/productFilter';
import FilterBar from '../FilterBar';

export const revalidate = 0;

const money = (v: any) =>
  v === null || v === undefined
    ? '-'
    : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));

const SOURCE_COLOR: Record<string, string> = {
  ga4: 'var(--primary)',
  js: '#22d3ee',
  webhook: 'var(--success)'
};

export default async function EventsPage({
  searchParams
}: {
  searchParams: Record<string, string>;
}) {
  const filter = searchParams?.event || '';
  const filters = withProductFallback(parseFilters(searchParams));

  const nameRows = await safeQuery(
    'SELECT event_name, COUNT(*) AS total FROM events GROUP BY event_name ORDER BY total DESC'
  );
  const names = nameRows.rows.map((r) => String(r.event_name));

  // Filtros avançados + o filtro por nome de evento (específico desta tela).
  const built = buildWhere(filters);
  const clauses = [...built.clauses];
  const args = [...built.params];
  if (filter) {
    clauses.push('event_name = ?');
    args.push(filter);
  }

  const result = await safeQuery(
    `SELECT * FROM events ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY created_at DESC LIMIT 200`,
    args
  );

  const events = result.rows;
  const error = result.error || nameRows.error;
  const eventHref = (name: string) => {
    const q = new URLSearchParams(searchParams as Record<string, string>);
    if (name) q.set('event', name);
    else q.delete('event');
    return `/events?${q.toString()}`;
  };

  return (
    <div>
      <h1 style={{ fontSize: '2rem', fontWeight: 600, marginBottom: '1rem' }}>Eventos</h1>

      <FilterBar table="events" />

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.5rem' }}>
        <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          Evento
        </span>
        <a
          href={eventHref('')}
          className="badge"
          style={{
            background: !filter ? 'var(--primary)' : 'rgba(255,255,255,0.06)',
            color: !filter ? '#fff' : 'var(--text-muted)'
          }}
        >
          todos
        </a>
        {names.map((n) => (
          <a
            key={n}
            href={eventHref(n)}
            className="badge"
            style={{
              background: filter === n ? 'var(--primary)' : 'rgba(255,255,255,0.06)',
              color: filter === n ? '#fff' : 'var(--text-muted)'
            }}
          >
            {n}
          </a>
        ))}
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{error}</div>
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h2>
            Últimos 200 eventos{filter ? ` — ${filter}` : ''}
            {filters.site ? ` — ${filters.site}` : ''}
          </h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Evento</th>
                <th>Origem</th>
                <th>Cliente</th>
                <th>Dispositivo</th>
                <th>Campanha</th>
                <th>Click IDs</th>
                <th>Valor</th>
                <th>JSON</th>
                <th>Sessão</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                    Nenhum evento registrado ainda.
                  </td>
                </tr>
              ) : (
                events.map((e, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                      {new Date(String(e.created_at).replace(' ', 'T') + 'Z').toLocaleString('pt-BR')}
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--primary)' }}
                      >
                        {e.event_name || 'page_view'}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: SOURCE_COLOR[String(e.source)] || 'var(--text-muted)' }}>
                      {e.source || '-'}
                    </td>
                    <td style={{ fontSize: '0.75rem' }}>
                      {e.email || e.phone ? (
                        <>
                          <div>{e.email || '-'}</div>
                          <div style={{ color: 'var(--text-muted)' }}>{e.phone || ''}</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>anônimo</span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.72rem' }}>
                      {e.device_type ? (
                        <>
                          <div>{e.device_type}</div>
                          <div style={{ color: 'var(--text-muted)' }}>{e.browser}</div>
                          <div style={{ color: 'var(--text-muted)' }}>{e.geo_city || e.geo_country || ''}</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.75rem' }}>
                      {e.utm_source || '-'}
                      {e.utm_campaign && (
                        <div style={{ color: 'var(--text-muted)' }}>{e.utm_campaign}</div>
                      )}
                    </td>
                    <td style={{ fontSize: '0.7rem', fontFamily: 'monospace' }}>
                      {e.gclid && <div title={String(e.gclid)}>gclid ✓</div>}
                      {e.gbraid && <div>gbraid ✓</div>}
                      {e.wbraid && <div>wbraid ✓</div>}
                      {e.fbc && <div>fbc ✓</div>}
                      {e.fbp && <div>fbp ✓</div>}
                      {!e.gclid && !e.gbraid && !e.wbraid && !e.fbc && !e.fbp && (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.value !== null ? money(e.value) : '-'}</td>
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
                          {e.raw_params}
                        </pre>
                      </details>
                    </td>
                    <td>
                      {(e.tsid || e.client_id) && (
                        <a
                          href={`/session/${encodeURIComponent(String(e.tsid || e.client_id))}`}
                          className="badge"
                          style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                        >
                          ver sessão
                        </a>
                      )}
                    </td>
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
