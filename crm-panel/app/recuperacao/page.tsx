import { safeQuery } from "../../lib/db";
import { toUsd, usd } from "../../lib/fx";
import { parseMercado, comMercado, mercadoSql } from "../../lib/mercado";
import MarketTabs from "../MarketTabs";
import KpiCard from "../KpiCard";
import { ShoppingBag, Mail, Phone, Clock } from "lucide-react";

export const revalidate = 0;

/**
 * Recuperacao de carrinho.
 *
 * A plataforma tambem lista carrinho abandonado — o que ela nao tem e de ONDE
 * cada um veio. Aqui cada abandono carrega campanha, click id, produto, pais e
 * dispositivo, entao da para responder "qual campanha gera carrinho
 * recuperavel" e priorizar quem contatar primeiro.
 */

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);

/** "há 3 h", "há 2 d" — o que decide se ainda vale a pena ligar. */
function desde(iso: any): string {
  if (!iso) return "—";
  const t = Date.parse(String(iso).replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "—";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / 1440)} d`;
}

export default async function RecuperacaoPage({
  searchParams,
}: {
  searchParams: Record<string, string>;
}) {
  const mercado = parseMercado(searchParams);
  const ehLatam = mercado === "latam";

  const base = `WHERE event_name = 'abandoned_checkout' AND (customer_email IS NOT NULL OR customer_phone IS NOT NULL)`;
  const where = comMercado(base, mercado);

  const { rows, error } = await safeQuery(
    `SELECT created_at, customer_name, customer_email, customer_phone,
            product_name, value, currency, utm_source, utm_campaign,
            gclid, gbraid, wbraid, customer_country, device_type, platform
     FROM purchases ${where}
     ORDER BY created_at DESC
     LIMIT 500`
  );

  // Quem ja comprou depois nao deve ser cobrado de novo — casamos por contato.
  const { rows: compradores } = await safeQuery(
    `SELECT DISTINCT customer_email AS email, customer_phone AS phone
     FROM purchases WHERE event_name = 'purchase'`
  );
  const emailsQueCompraram = new Set(compradores.map((c) => String(c.email || "")).filter(Boolean));
  const fonesQueCompraram = new Set(compradores.map((c) => String(c.phone || "")).filter(Boolean));

  const { rows: contagem } = await safeQuery(
    `SELECT ${mercadoSql("latam")} AS internacional, COUNT(*) AS n
     FROM purchases ${base} GROUP BY internacional`
  );
  const abas = {
    brasil: num(contagem.find((r) => num(r.internacional) === 0)?.n),
    latam: num(contagem.find((r) => num(r.internacional) === 1)?.n),
  };

  // Marca quem ja comprou e converte o valor para a moeda da aba.
  type Linha = Record<string, any> & { recuperado: boolean; valorUsd: number | null };
  const linhas: Linha[] = rows.map((r) => {
    const email = String(r.customer_email || "");
    const phone = String(r.customer_phone || "");
    const recuperado = Boolean(
      (email && emailsQueCompraram.has(email)) || (phone && fonesQueCompraram.has(phone))
    );
    const valorUsd = ehLatam ? toUsd(num(r.value), String(r.currency || "")) : null;
    return { ...r, recuperado, valorUsd };
  });

  const pendentes = linhas.filter((l) => !l.recuperado);
  const totalValor = pendentes.reduce(
    (acc, l) => acc + (ehLatam ? l.valorUsd || 0 : num(l.value)),
    0
  );
  const comEmail = pendentes.filter((l) => l.customer_email).length;
  const comFone = pendentes.filter((l) => l.customer_phone).length;

  // Onde o dinheiro abandonado esta concentrado — e por onde comecar.
  const porCampanha = new Map<string, { n: number; valor: number }>();
  for (const l of pendentes) {
    const k = String(l.utm_campaign || "(sem campanha)");
    const atual = porCampanha.get(k) || { n: 0, valor: 0 };
    atual.n += 1;
    atual.valor += ehLatam ? l.valorUsd || 0 : num(l.value);
    porCampanha.set(k, atual);
  }
  const topCampanhas = Array.from(porCampanha.entries())
    .map(([campanha, v]) => ({ campanha, ...v }))
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 6);

  const valor = (v: number) => (ehLatam ? usd(v) : money(v));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
        <ShoppingBag size={26} style={{ color: "var(--warning)" }} />
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>Recuperação de carrinho</h1>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.25rem", fontSize: "0.85rem" }}>
        Quem chegou no checkout, deixou contato e não pagou — com a campanha que trouxe cada um.
        Quem comprou depois some da lista automaticamente.
      </p>

      <MarketTabs searchParams={searchParams} atual={mercado} contagem={abas} />

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)", marginBottom: "1.5rem" }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{error}</div>
        </div>
      )}

      <div className="card-grid">
        <KpiCard
          icon={<ShoppingBag size={18} />}
          tone="warning"
          label="Valor a recuperar"
          value={valor(totalValor)}
          hint={`${pendentes.length} carrinhos ainda em aberto`}
        />
        <KpiCard
          icon={<Mail size={18} />}
          tone="info"
          label="Com e-mail"
          value={String(comEmail)}
          hint="prontos para sequência de e-mail"
        />
        <KpiCard
          icon={<Phone size={18} />}
          tone="info"
          label="Com telefone"
          value={String(comFone)}
          hint="prontos para WhatsApp"
        />
        <KpiCard
          icon={<Clock size={18} />}
          tone="success"
          label="Já recuperados"
          value={String(linhas.length - pendentes.length)}
          hint="abandonaram e compraram depois"
        />
      </div>

      {topCampanhas.length > 0 && (
        <div className="table-container" style={{ margin: "1.5rem 0" }}>
          <div className="table-header">
            <h2>Onde está o dinheiro abandonado</h2>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Carrinhos</th>
                  <th>Valor</th>
                </tr>
              </thead>
              <tbody>
                {topCampanhas.map((c) => (
                  <tr key={c.campanha}>
                    <td style={{ fontWeight: 600 }}>{c.campanha}</td>
                    <td>{c.n}</td>
                    <td style={{ fontWeight: 600, color: "var(--warning)" }}>{valor(c.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h2>{pendentes.length} carrinhos em aberto</h2>
          <a
            href={`/api/recuperacao/csv?mercado=${mercado}`}
            className="badge"
            style={{ background: "var(--primary-soft)", color: "var(--primary)", textDecoration: "none" }}
          >
            Exportar CSV
          </a>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Contato</th>
                <th>Produto</th>
                <th>Valor</th>
                <th>Campanha</th>
                <th>Origem</th>
              </tr>
            </thead>
            <tbody>
              {pendentes.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
                    Nenhum carrinho {ehLatam ? "internacional" : "em reais"} para recuperar.
                  </td>
                </tr>
              ) : (
                pendentes.slice(0, 200).map((l, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>{desde(l.created_at)}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{String(l.customer_name || "(sem nome)")}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        {String(l.customer_email || "—")}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        {String(l.customer_phone || "")}
                      </div>
                    </td>
                    <td style={{ fontSize: "0.8rem" }}>{String(l.product_name || "—")}</td>
                    <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                      {ehLatam
                        ? l.valorUsd === null
                          ? `${l.currency} ${num(l.value).toFixed(2)}`
                          : usd(l.valorUsd)
                        : money(num(l.value))}
                    </td>
                    <td style={{ fontSize: "0.8rem" }}>
                      {String(l.utm_campaign || "—")}
                      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                        {String(l.utm_source || "")}
                      </div>
                    </td>
                    <td style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                      {[l.customer_country, l.device_type].filter(Boolean).join(" · ") || "—"}
                      {(l.gclid || l.gbraid || l.wbraid) && (
                        <div style={{ color: "var(--success)" }}>click ID ✓</div>
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
