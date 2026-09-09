import { safeQuery } from '../lib/db';

/**
 * Filtro por dominio.
 *
 * Um perfil costuma cobrir varias landing pages com o mesmo container do GTM;
 * isto permite olhar uma de cada vez.
 */
export default async function SiteFilter({
  table,
  active,
  basePath,
  extraParams = ''
}: {
  table: 'events' | 'purchases';
  active: string;
  basePath: string;
  extraParams?: string;
}) {
  const { rows } = await safeQuery(
    `SELECT hostname, COUNT(*) AS total FROM ${table}
     WHERE hostname IS NOT NULL
     GROUP BY hostname ORDER BY total DESC LIMIT 30`
  );

  // Com um dominio so, o filtro nao acrescenta nada.
  if (rows.length < 2) return null;

  const href = (site: string) =>
    `${basePath}?${[site ? `site=${encodeURIComponent(site)}` : '', extraParams]
      .filter(Boolean)
      .join('&')}`;

  const chip = (label: string, value: string) => {
    const selected = active === value;
    return (
      <a
        key={value || 'all'}
        href={href(value)}
        className="badge"
        style={{
          background: selected ? 'var(--primary)' : 'rgba(255,255,255,0.06)',
          color: selected ? '#fff' : 'var(--text-muted)'
        }}
      >
        {label}
      </a>
    );
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.25rem' }}>
      <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        Domínio
      </span>
      {chip('todos', '')}
      {rows.map((r) => chip(String(r.hostname), String(r.hostname)))}
    </div>
  );
}
