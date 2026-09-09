import Link from "next/link";
import { Fingerprint, MapPin, Monitor, Tag, User, ShoppingCart } from "lucide-react";
import { safeQuery } from "../../../lib/db";

export const revalidate = 0;

/**
 * Visão completa de uma sessão: todo evento e toda venda ligados ao mesmo
 * visitante (por tsid, ou por client_id/transaction_id/e-mail quando o tsid
 * nao existe), com cada parametro rastreado explicito — nao um dump de JSON.
 */

const money = (v: any, currency?: any) =>
  v === null || v === undefined
    ? "-"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: (currency as string) || "BRL" }).format(
        Number(v) || 0
      );

const fmtDate = (v: any) =>
  v ? new Date(String(v).replace(" ", "T") + "Z").toLocaleString("pt-BR") : "-";

function Field({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--text-muted)" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "0.82rem",
          fontFamily: mono ? "var(--font-mono, monospace)" : undefined,
          color: empty ? "var(--text-muted)" : "var(--text-main)",
          wordBreak: "break-all",
        }}
      >
        {empty ? "-" : String(value)}
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: "1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.85rem" }}>
        {icon}
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>{title}</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.85rem" }}>
        {children}
      </div>
    </div>
  );
}

/** Primeiro valor nao-nulo de uma coluna, entre todas as linhas da sessao. */
function firstNonNull(rows: Record<string, any>[], col: string) {
  for (const r of rows) if (r[col] !== null && r[col] !== undefined && r[col] !== "") return r[col];
  return null;
}

export default async function SessionPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);

  const [eventsByTsid, eventsByClientId, purchasesByTsid, purchasesByClientId, purchasesByTx] = await Promise.all([
    safeQuery("SELECT *, 'event' AS _kind FROM events WHERE tsid = ? ORDER BY created_at ASC", [id]),
    safeQuery("SELECT *, 'event' AS _kind FROM events WHERE client_id = ? AND (tsid IS NULL OR tsid != ?) ORDER BY created_at ASC", [id, id]),
    safeQuery("SELECT *, 'purchase' AS _kind FROM purchases WHERE tsid = ? ORDER BY created_at ASC", [id]),
    safeQuery("SELECT *, 'purchase' AS _kind FROM purchases WHERE client_id = ? AND (tsid IS NULL OR tsid != ?) ORDER BY created_at ASC", [id, id]),
    safeQuery("SELECT *, 'purchase' AS _kind FROM purchases WHERE transaction_id = ? ORDER BY created_at ASC", [id]),
  ]);

  const error =
    eventsByTsid.error || eventsByClientId.error || purchasesByTsid.error || purchasesByClientId.error || purchasesByTx.error;

  const seen = new Set<string>();
  const rows: Record<string, any>[] = [];
  for (const set of [eventsByTsid.rows, purchasesByTsid.rows, eventsByClientId.rows, purchasesByClientId.rows, purchasesByTx.rows]) {
    for (const r of set) {
      const key = `${r._kind}:${r.event_name}:${r.created_at}:${r.transaction_id || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  if (error) {
    return (
      <div className="card" style={{ borderColor: "var(--danger)" }}>
        <div style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{error}</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div>
        <h1 style={{ fontSize: "1.6rem", fontWeight: 600, marginBottom: "0.5rem" }}>Sessão não encontrada</h1>
        <p style={{ color: "var(--text-muted)" }}>
          Nenhum evento ou venda casa com <code>{id}</code> (tsid, client_id ou transação).
        </p>
        <Link href="/events" className="btn" style={{ marginTop: "1rem", display: "inline-flex" }}>
          Voltar para Eventos
        </Link>
      </div>
    );
  }

  const attribution = {
    tsid: firstNonNull(rows, "tsid"),
    client_id: firstNonNull(rows, "client_id"),
    session_id: firstNonNull(rows, "session_id"),
    gclid: firstNonNull(rows, "gclid"),
    gbraid: firstNonNull(rows, "gbraid"),
    wbraid: firstNonNull(rows, "wbraid"),
    fbclid: firstNonNull(rows, "fbclid"),
    fbc: firstNonNull(rows, "fbc"),
    fbp: firstNonNull(rows, "fbp"),
    ttclid: firstNonNull(rows, "ttclid"),
    msclkid: firstNonNull(rows, "msclkid"),
    utm_source: firstNonNull(rows, "utm_source"),
    utm_medium: firstNonNull(rows, "utm_medium"),
    utm_campaign: firstNonNull(rows, "utm_campaign"),
    utm_term: firstNonNull(rows, "utm_term"),
    utm_content: firstNonNull(rows, "utm_content"),
  };

  const identity = {
    name: firstNonNull(rows, "name") || firstNonNull(rows, "customer_name"),
    email: firstNonNull(rows, "email") || firstNonNull(rows, "customer_email"),
    phone: firstNonNull(rows, "phone") || firstNonNull(rows, "customer_phone"),
    document: firstNonNull(rows, "document") || firstNonNull(rows, "customer_document"),
    city: firstNonNull(rows, "city") || firstNonNull(rows, "customer_city") || firstNonNull(rows, "geo_city"),
    state: firstNonNull(rows, "state") || firstNonNull(rows, "customer_state") || firstNonNull(rows, "geo_region"),
    country: firstNonNull(rows, "country") || firstNonNull(rows, "customer_country") || firstNonNull(rows, "geo_country"),
  };

  const device = {
    device_type: firstNonNull(rows, "device_type"),
    browser: firstNonNull(rows, "browser"),
    os: firstNonNull(rows, "os"),
    user_agent: firstNonNull(rows, "user_agent"),
    ip: firstNonNull(rows, "ip"),
    hostname: firstNonNull(rows, "hostname"),
  };

  const purchaseRows = rows.filter((r) => r._kind === "purchase");
  const eventRows = rows.filter((r) => r._kind === "event");
  const totalValue = purchaseRows.reduce((acc, r) => acc + (Number(r.value) || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "0.35rem" }}>
        <Fingerprint size={24} style={{ color: "var(--primary)" }} />
        <h1 style={{ fontSize: "1.6rem", fontWeight: 600 }}>Sessão</h1>
        <code style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{id}</code>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>
        {eventRows.length} evento{eventRows.length === 1 ? "" : "s"} · {purchaseRows.length} venda
        {purchaseRows.length === 1 ? "" : "s"}
        {purchaseRows.length > 0 ? ` · ${money(totalValue)} no total` : ""}
      </p>

      <Section icon={<Tag size={16} style={{ color: "var(--primary)" }} />} title="Atribuição (clique e UTM)">
        <Field label="tsid" value={attribution.tsid} mono />
        <Field label="client_id (GA4)" value={attribution.client_id} mono />
        <Field label="session_id" value={attribution.session_id} mono />
        <Field label="gclid" value={attribution.gclid} mono />
        <Field label="gbraid" value={attribution.gbraid} mono />
        <Field label="wbraid" value={attribution.wbraid} mono />
        <Field label="fbclid" value={attribution.fbclid} mono />
        <Field label="fbc" value={attribution.fbc} mono />
        <Field label="fbp" value={attribution.fbp} mono />
        <Field label="ttclid" value={attribution.ttclid} mono />
        <Field label="msclkid" value={attribution.msclkid} mono />
        <Field label="utm_source" value={attribution.utm_source} />
        <Field label="utm_medium" value={attribution.utm_medium} />
        <Field label="utm_campaign" value={attribution.utm_campaign} />
        <Field label="utm_term" value={attribution.utm_term} />
        <Field label="utm_content" value={attribution.utm_content} />
      </Section>

      <Section icon={<User size={16} style={{ color: "var(--warning)" }} />} title="Identidade">
        <Field label="Nome" value={identity.name} />
        <Field label="E-mail" value={identity.email} />
        <Field label="Telefone" value={identity.phone} />
        <Field label="Documento" value={identity.document} />
        <Field label="Cidade" value={identity.city} />
        <Field label="Estado" value={identity.state} />
        <Field label="País" value={identity.country} />
      </Section>

      <Section icon={<Monitor size={16} style={{ color: "#38bdf8" }} />} title="Dispositivo e origem">
        <Field label="Tipo" value={device.device_type} />
        <Field label="Navegador" value={device.browser} />
        <Field label="Sistema" value={device.os} />
        <Field label="IP" value={device.ip} mono />
        <Field label="Domínio" value={device.hostname} />
      </Section>
      {device.user_agent && (
        <div className="card" style={{ marginTop: "-1rem", marginBottom: "1.25rem" }}>
          <div style={{ fontSize: "0.66rem", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>
            User-Agent completo
          </div>
          <div style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "var(--text-muted)", wordBreak: "break-all" }}>
            {device.user_agent}
          </div>
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ShoppingCart size={16} /> Linha do tempo completa
          </h2>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Tipo</th>
                <th>Evento</th>
                <th>Origem</th>
                <th>Domínio</th>
                <th>Produto</th>
                <th>Valor</th>
                <th>Todos os parâmetros</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>{fmtDate(r.created_at)}</td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background: r._kind === "purchase" ? "rgba(16,185,129,0.12)" : "rgba(99,102,241,0.12)",
                        color: r._kind === "purchase" ? "var(--success)" : "var(--primary)",
                      }}
                    >
                      {r._kind === "purchase" ? "venda" : "evento"}
                    </span>
                  </td>
                  <td style={{ fontSize: "0.8rem" }}>{r.event_name}</td>
                  <td style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{r.source || r.platform || "-"}</td>
                  <td style={{ fontSize: "0.75rem" }}>{r.hostname || "-"}</td>
                  <td style={{ fontSize: "0.75rem" }}>{r.product_name || "-"}</td>
                  <td style={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                    {r.value !== null && r.value !== undefined ? money(r.value, r.currency) : "-"}
                  </td>
                  <td>
                    <details style={{ cursor: "pointer" }}>
                      <summary style={{ fontSize: "0.75rem", color: "var(--primary)" }}>ver tudo</summary>
                      <div
                        style={{
                          fontSize: "0.72rem",
                          background: "rgba(0,0,0,0.3)",
                          padding: "0.6rem 0.75rem",
                          marginTop: "0.5rem",
                          borderRadius: 4,
                          minWidth: 260,
                          maxHeight: 320,
                          overflow: "auto",
                        }}
                      >
                        {Object.entries(r)
                          .filter(([k, v]) => !k.startsWith("_") && k !== "raw_params" && k !== "raw_payload" && v !== null && v !== "")
                          .map(([k, v]) => (
                            <div key={k} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                              <span style={{ color: "var(--text-muted)", minWidth: 130 }}>{k}</span>
                              <span style={{ wordBreak: "break-all" }}>{String(v)}</span>
                            </div>
                          ))}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
