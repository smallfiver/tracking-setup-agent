import { safeQuery } from "../lib/db";
import { buildWhere, type Filters } from "../lib/filters";

/**
 * Retencao da VSL.
 *
 * Os marcos vem em SEGUNDOS assistidos, nao em porcentagem: o player nao expoe
 * a duracao do video. Para VSL isso e melhor mesmo — o que importa e se a
 * pessoa chegou no minuto em que a oferta aparece, e esse minuto o proprio
 * player informa (pitchTime).
 *
 * Contamos PESSOAS (tsid), nao eventos: quem recarrega a pagina e assiste de
 * novo passaria duas vezes pelo mesmo marco e inflaria a curva.
 */

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

/** Ordem e rotulo de cada marco. O que nao estiver aqui nao entra na curva. */
const MARCOS: { key: string; label: string }[] = [
  { key: "30s", label: "30 segundos" },
  { key: "60s", label: "1 minuto" },
  { key: "180s", label: "3 minutos" },
  { key: "300s", label: "5 minutos" },
  { key: "600s", label: "10 minutos" },
  { key: "900s", label: "15 minutos" },
  { key: "pitch", label: "Ouviu a oferta" },
  { key: "1200s", label: "20 minutos" },
];

export default async function VslRetention({ filters }: { filters: Filters }) {
  const { where, params } = buildWhere(filters);
  const clause = where
    ? `${where} AND event_name = 'video_progress'`
    : "WHERE event_name = 'video_progress'";

  const [marcos, compradores] = await Promise.all([
    safeQuery(
      `SELECT json_extract(raw_params, '$.video_mark') AS marco,
              COUNT(DISTINCT tsid) AS pessoas
       FROM events ${clause} AND json_extract(raw_params, '$.video_mark') IS NOT NULL
       GROUP BY marco`,
      params
    ),
    // Quem ouviu a oferta e comprou — o resto e o publico de remarketing.
    safeQuery(
      `SELECT COUNT(DISTINCT e.tsid) AS n
       FROM events e
       JOIN purchases p ON p.tsid = e.tsid AND p.event_name = 'purchase'
       WHERE e.event_name = 'video_progress'
         AND json_extract(e.raw_params, '$.video_mark') = 'pitch'`
    ),
  ]);

  if (marcos.error || !marcos.rows.length) return null;

  const porMarco = new Map<string, number>();
  for (const r of marcos.rows) porMarco.set(String(r.marco), num(r.pessoas));

  const linhas = MARCOS.filter((m) => porMarco.has(m.key)).map((m) => ({
    ...m,
    pessoas: porMarco.get(m.key) || 0,
  }));
  if (!linhas.length) return null;

  const base = Math.max(...linhas.map((l) => l.pessoas));
  const pitch = porMarco.get("pitch") || 0;
  const comprou = num(compradores.rows[0]?.n);
  const semComprar = Math.max(0, pitch - comprou);

  return (
    <section aria-labelledby="vsl-title" style={{ marginTop: "1.5rem" }}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">Retenção</span>
          <h2 id="vsl-title">Até onde assistem a VSL</h2>
        </div>
        <span className="section-note">pessoas únicas por marco, não visualizações</span>
      </div>

      <div className="table-container">
        <div style={{ padding: "1.25rem 1.5rem" }}>
          {linhas.map((l) => {
            const share = base > 0 ? (l.pessoas / base) * 100 : 0;
            const ehPitch = l.key === "pitch";
            return (
              <div key={l.key} style={{ marginBottom: "0.95rem" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "0.84rem",
                    marginBottom: "0.3rem",
                    fontWeight: ehPitch ? 600 : 400,
                    color: ehPitch ? "var(--warning)" : undefined,
                  }}
                >
                  <span>{l.label}</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {l.pessoas.toLocaleString("pt-BR")} · {share.toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: 6, background: "var(--neutral-soft)", borderRadius: 3 }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${share}%`,
                      background: ehPitch ? "var(--warning)" : "var(--primary)",
                      borderRadius: 3,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {pitch > 0 && (
          <div
            style={{
              borderTop: "1px solid var(--border)",
              padding: "1rem 1.5rem",
              display: "flex",
              gap: "2rem",
              flexWrap: "wrap",
              alignItems: "baseline",
            }}
          >
            <div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                Ouviram a oferta e NÃO compraram
              </div>
              <div style={{ fontSize: "1.6rem", fontWeight: 700, color: "var(--warning)" }}>
                {semComprar.toLocaleString("pt-BR")}
              </div>
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", maxWidth: 460 }}>
              Objeção de preço ou de confiança — não de interesse. É o público de remarketing mais
              quente que existe, e já está no GA4 como{" "}
              <strong>VSL ouviu a oferta e nao comprou - 30d</strong>.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
