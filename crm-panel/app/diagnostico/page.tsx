import { safeQuery } from "../../lib/db";
import KpiCard from "../KpiCard";
import { Stethoscope, Smartphone, Clock, CreditCard, AlertTriangle } from "lucide-react";

export const revalidate = 0;

/**
 * Diagnostico.
 *
 * Tudo aqui responde perguntas que a plataforma de pagamento NAO consegue
 * responder, porque ela so enxerga da entrada do checkout para frente. Nos
 * temos a sessao, entao temos o denominador: quantos chegaram, quantos
 * clicaram, quantos pagaram — e onde cada um parou.
 */

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));
const pct = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0);
const fmtPct = (v: number) => `${v.toFixed(2).replace(".", ",")}%`;

/** Barra proporcional simples, para comparar linhas de olho. */
function Barra({ valor, max, cor }: { valor: number; max: number; cor: string }) {
  return (
    <div style={{ height: 5, background: "var(--neutral-soft)", borderRadius: 3, minWidth: 60 }}>
      <div
        style={{
          height: "100%",
          width: `${max > 0 ? (valor / max) * 100 : 0}%`,
          background: cor,
          borderRadius: 3,
        }}
      />
    </div>
  );
}

export default async function DiagnosticoPage() {
  const [dispositivo, paises, tempo, pagamento, recusas, cliques] = await Promise.all([
    // Sessao -> clique no checkout, por dispositivo.
    safeQuery(`
      SELECT device_type AS device,
             COUNT(DISTINCT session_id) AS sessoes,
             SUM(CASE WHEN event_name = 'initiate_checkout' THEN 1 ELSE 0 END) AS cliques
      FROM events WHERE device_type IS NOT NULL
      GROUP BY device ORDER BY sessoes DESC
    `),
    safeQuery(`
      SELECT geo_country AS pais,
             COUNT(DISTINCT session_id) AS sessoes,
             SUM(CASE WHEN event_name = 'initiate_checkout' THEN 1 ELSE 0 END) AS cliques
      FROM events WHERE geo_country IS NOT NULL
      GROUP BY pais ORDER BY sessoes DESC LIMIT 12
    `),
    // Minutos entre o primeiro clique no checkout e a venda aprovada.
    safeQuery(`
      SELECT minutos FROM (
        SELECT (julianday(p.created_at) - julianday(MIN(e.created_at))) * 1440 AS minutos
        FROM purchases p
        JOIN events e ON e.tsid = p.tsid AND e.event_name = 'initiate_checkout'
        WHERE p.event_name = 'purchase' AND p.tsid IS NOT NULL
        GROUP BY p.id
      ) WHERE minutos >= 0 AND minutos < 10080
    `),
    safeQuery(`
      SELECT COALESCE(payment_method, '(nao informado)') AS metodo,
             COALESCE(utm_campaign, '(sem campanha)') AS campanha,
             COUNT(*) AS vendas,
             COALESCE(SUM(CASE WHEN COALESCE(currency,'BRL') = 'BRL' THEN value ELSE 0 END), 0) AS receita_brl
      FROM purchases WHERE event_name = 'purchase'
      GROUP BY metodo, campanha ORDER BY vendas DESC LIMIT 40
    `),
    // Recusa por pais: o dado que diz se vale a pena anunciar la.
    safeQuery(`
      SELECT COALESCE(customer_country, '?') AS pais,
             SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS aprovadas,
             SUM(CASE WHEN event_name = 'payment_refused' THEN 1 ELSE 0 END) AS recusadas
      FROM purchases WHERE customer_country IS NOT NULL
      GROUP BY pais
      HAVING aprovadas + recusadas >= 3
      ORDER BY recusadas DESC LIMIT 12
    `),
    // Cliques no botao por pessoa: mede se o checkout esta abrindo.
    safeQuery(`
      SELECT AVG(n) AS media, MAX(n) AS maximo, COUNT(*) AS pessoas, SUM(n) AS total
      FROM (SELECT tsid, COUNT(*) AS n FROM events
            WHERE event_name = 'initiate_checkout' AND tsid IS NOT NULL GROUP BY tsid)
    `),
  ]);

  const erro =
    dispositivo.error || paises.error || tempo.error || pagamento.error || recusas.error;

  // Distribuicao do tempo ate a compra em faixas acionaveis.
  const minutos = tempo.rows.map((r) => num(r.minutos)).sort((a, b) => a - b);
  const FAIXAS = [
    { label: "até 5 min", teto: 5 },
    { label: "5 a 30 min", teto: 30 },
    { label: "30 min a 2 h", teto: 120 },
    { label: "2 h a 24 h", teto: 1440 },
    { label: "mais de 24 h", teto: Infinity },
  ];
  let anterior = 0;
  const distribuicao = FAIXAS.map((f) => {
    const n = minutos.filter((m) => m > anterior && m <= f.teto).length;
    anterior = f.teto;
    return { ...f, n };
  });
  const mediana = minutos.length ? minutos[Math.floor(minutos.length / 2)] : 0;
  const p90 = minutos.length ? minutos[Math.floor(minutos.length * 0.9)] : 0;

  const maxSessoes = Math.max(1, ...dispositivo.rows.map((r) => num(r.sessoes)));
  const maxPais = Math.max(1, ...paises.rows.map((r) => num(r.sessoes)));
  const maxFaixa = Math.max(1, ...distribuicao.map((d) => d.n));

  const c = cliques.rows[0] || {};
  const mediaCliques = num(c.media);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
        <Stethoscope size={26} style={{ color: "var(--info)" }} />
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>Diagnóstico</h1>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem", fontSize: "0.85rem" }}>
        O que a plataforma de pagamento não consegue te dizer, porque ela só enxerga da entrada do
        checkout para frente. Aqui existe o denominador: quantos chegaram antes.
      </p>

      {erro && (
        <div className="card" style={{ borderColor: "var(--danger)", marginBottom: "1.5rem" }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{erro}</div>
        </div>
      )}

      <div className="card-grid">
        <KpiCard
          icon={<Smartphone size={18} />}
          tone={mediaCliques > 2 ? "danger" : "success"}
          label="Cliques no checkout por pessoa"
          value={mediaCliques.toFixed(2).replace(".", ",")}
          hint={
            mediaCliques > 2
              ? `${num(c.pessoas).toLocaleString("pt-BR")} pessoas geraram ${num(c.total).toLocaleString("pt-BR")} cliques — quem clica mais de uma vez está tentando de novo`
              : "dentro do esperado"
          }
        />
        <KpiCard
          icon={<Clock size={18} />}
          tone="info"
          label="Mediana até a compra"
          value={mediana < 60 ? `${mediana.toFixed(0)} min` : `${(mediana / 60).toFixed(1)} h`}
          hint={`90% compram em até ${p90 < 60 ? `${p90.toFixed(0)} min` : `${(p90 / 60).toFixed(1)} h`}`}
        />
        <KpiCard
          icon={<AlertTriangle size={18} />}
          tone="warning"
          label="Maior clique único"
          value={String(num(c.maximo))}
          hint="uma só pessoa, no mesmo botão"
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", alignItems: "start", marginTop: "1.5rem" }}>
        <div className="table-container">
          <div className="table-header">
            <h2>Sessão → checkout por dispositivo</h2>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Dispositivo</th>
                  <th>Sessões</th>
                  <th>Cliques</th>
                  <th>Taxa</th>
                </tr>
              </thead>
              <tbody>
                {dispositivo.rows.map((r, i) => {
                  const taxa = pct(num(r.cliques), num(r.sessoes));
                  return (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{String(r.device)}</td>
                      <td>
                        {num(r.sessoes).toLocaleString("pt-BR")}
                        <Barra valor={num(r.sessoes)} max={maxSessoes} cor="var(--primary)" />
                      </td>
                      <td>{num(r.cliques).toLocaleString("pt-BR")}</td>
                      <td style={{ fontWeight: 600, color: taxa >= 20 ? "var(--success)" : "var(--warning)" }}>
                        {fmtPct(taxa)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="table-container">
          <div className="table-header">
            <h2>Tempo até a compra</h2>
          </div>
          <div style={{ padding: "1rem 1.5rem" }}>
            {distribuicao.map((d) => (
              <div key={d.label} style={{ marginBottom: "0.9rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", marginBottom: "0.3rem" }}>
                  <span>{d.label}</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {d.n} ({fmtPct(pct(d.n, minutos.length))})
                  </span>
                </div>
                <Barra valor={d.n} max={maxFaixa} cor="var(--info)" />
              </div>
            ))}
            <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.75rem" }}>
              Base: {minutos.length} vendas com navegação costurada. Define a janela de remarketing e
              o atraso ideal do disparo de recuperação.
            </div>
          </div>
        </div>
      </div>

      <div className="table-container" style={{ marginTop: "1.5rem" }}>
        <div className="table-header">
          <h2>Recusa de pagamento por país</h2>
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 400 }}>
            país com recusa alta é dinheiro de mídia que não vira venda
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>País</th>
                <th>Aprovadas</th>
                <th>Recusadas</th>
                <th>Taxa de recusa</th>
              </tr>
            </thead>
            <tbody>
              {recusas.rows.map((r, i) => {
                const taxa = pct(num(r.recusadas), num(r.aprovadas) + num(r.recusadas));
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{String(r.pais)}</td>
                    <td style={{ color: "var(--success)" }}>{num(r.aprovadas)}</td>
                    <td style={{ color: "var(--danger)" }}>{num(r.recusadas)}</td>
                    <td style={{ fontWeight: 600, color: taxa >= 40 ? "var(--danger)" : taxa >= 20 ? "var(--warning)" : "var(--text-muted)" }}>
                      {fmtPct(taxa)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", alignItems: "start", marginTop: "1.5rem" }}>
        <div className="table-container">
          <div className="table-header">
            <h2>Sessão → checkout por país</h2>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>País</th>
                  <th>Sessões</th>
                  <th>Cliques</th>
                  <th>Taxa</th>
                </tr>
              </thead>
              <tbody>
                {paises.rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{String(r.pais)}</td>
                    <td>
                      {num(r.sessoes).toLocaleString("pt-BR")}
                      <Barra valor={num(r.sessoes)} max={maxPais} cor="var(--primary)" />
                    </td>
                    <td>{num(r.cliques).toLocaleString("pt-BR")}</td>
                    <td style={{ fontWeight: 600 }}>{fmtPct(pct(num(r.cliques), num(r.sessoes)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="table-container">
          <div className="table-header">
            <h2>
              <CreditCard size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Pagamento × campanha
            </h2>
          </div>
          <div style={{ overflowX: "auto", maxHeight: 420 }}>
            <table>
              <thead>
                <tr>
                  <th>Método</th>
                  <th>Campanha</th>
                  <th>Vendas</th>
                  <th>Receita BRL</th>
                </tr>
              </thead>
              <tbody>
                {pagamento.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
                      Sem dados de pagamento.
                    </td>
                  </tr>
                ) : (
                  pagamento.rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{String(r.metodo)}</td>
                      <td style={{ fontSize: "0.8rem" }}>{String(r.campanha)}</td>
                      <td>{num(r.vendas)}</td>
                      <td style={{ color: "var(--success)" }}>
                        {num(r.receita_brl) > 0
                          ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(num(r.receita_brl))
                          : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
