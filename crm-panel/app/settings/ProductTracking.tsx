"use client";

import { useEffect, useState } from "react";
import { Boxes, RefreshCw, Loader2, CheckCircle2, AlertTriangle, HelpCircle, ArrowRightLeft } from "lucide-react";

type DomainStatus = "migrado" | "outro_produto" | "pendente" | "nao_verificavel";

type DomainCheck = {
  hostname: string;
  events: number;
  status: DomainStatus;
  foundIds: string[];
  ownerProduct: string | null;
};

type ProductRow = {
  product: string;
  measurementId: string;
  containerId: string | null;
  domains: DomainCheck[];
  semDominioConhecido: boolean;
};

type Payload = {
  products: ProductRow[];
  sharedDomains: { hostname: string; products: string[] }[];
  summary: { total: number; ok: number; pendente: number; naoVerificavel: number } | null;
  error: string | null;
};

const STATUS_UI: Record<DomainStatus, { label: string; color: string; icon: any }> = {
  migrado: { label: "Migrado", color: "var(--success)", icon: CheckCircle2 },
  outro_produto: { label: "Container de outro produto", color: "var(--info, #38bdf8)", icon: ArrowRightLeft },
  pendente: { label: "Pendente (container antigo)", color: "var(--warning)", icon: AlertTriangle },
  nao_verificavel: { label: "Não verificável (anti-bot?)", color: "var(--text-muted)", icon: HelpCircle },
};

export default function ProductTracking() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<string>("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/product-tracking", { cache: "no-store" });
      setData(await res.json());
    } catch (err: any) {
      setData({ products: [], sharedDomains: [], summary: null, error: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading && !data) {
    return (
      <div className="card" style={{ marginBottom: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
          <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
          Conferindo propriedades GA4, containers GTM e domínios...
        </div>
      </div>
    );
  }

  if (!data || data.error) {
    return (
      <div className="card" style={{ marginBottom: "2rem", borderColor: "var(--warning)" }}>
        <div style={{ fontSize: "0.85rem", color: "var(--warning)" }}>{data?.error || "Não foi possível carregar."}</div>
      </div>
    );
  }

  const visiveis = filtro ? data.products.filter((p) => p.product === filtro) : data.products;
  const s = data.summary;
  const pct = s && s.total > 0 ? Math.round((s.ok / s.total) * 100) : 0;

  return (
    <div className="table-container" style={{ marginBottom: "2rem" }}>
      <div className="table-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Boxes size={18} /> Propriedade GA4 + container GTM por produto
        </h2>
        <button className="btn" style={{ background: "var(--surface-hover)", color: "var(--text-main)" }} onClick={load} disabled={loading}>
          {loading ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
          Reconferir
        </button>
      </div>

      {/* Resumo da migração */}
      {s && s.total > 0 && (
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "1.4rem", fontWeight: 700, color: pct === 100 ? "var(--success)" : "var(--text-main)" }}>{pct}%</span>
            <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
              {s.ok} de {s.total} domínios já com container próprio
              {s.pendente > 0 && <span style={{ color: "var(--warning)" }}> · {s.pendente} ainda no container antigo</span>}
              {s.naoVerificavel > 0 && <span> · {s.naoVerificavel} não verificável</span>}
            </span>
          </div>
          <div style={{ height: 6, background: "var(--surface)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "var(--success)" : "var(--primary)", transition: "width .3s var(--ease-out, ease)" }} />
          </div>
        </div>
      )}

      {/* Filtro por produto / container */}
      <div style={{ padding: "0.85rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "0.7rem", textTransform: "uppercase", color: "var(--text-muted)", marginRight: 4 }}>Filtrar</span>
        <button
          className="badge"
          onClick={() => setFiltro("")}
          style={{ background: !filtro ? "var(--primary)" : "rgba(255,255,255,0.06)", color: !filtro ? "#fff" : "var(--text-muted)", border: "none", cursor: "pointer" }}
        >
          todos
        </button>
        {data.products.map((p) => (
          <button
            key={p.product}
            className="badge"
            onClick={() => setFiltro(p.product)}
            title={p.containerId || ""}
            style={{ background: filtro === p.product ? "var(--primary)" : "rgba(255,255,255,0.06)", color: filtro === p.product ? "#fff" : "var(--text-muted)", border: "none", cursor: "pointer" }}
          >
            {p.containerId || p.product}
          </button>
        ))}
      </div>

      {data.sharedDomains.length > 0 && !filtro && (
        <div style={{ padding: "0.85rem 1.25rem", background: "rgba(245,158,11,0.08)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: "0.8rem", color: "var(--warning)", fontWeight: 600, marginBottom: 4 }}>
            Domínio(s) com histórico de mais de um produto — só um container fica instalado por vez
          </div>
          {data.sharedDomains.map((sd) => (
            <div key={sd.hostname} style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              <code>{sd.hostname}</code> → {sd.products.join(" + ")}
            </div>
          ))}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Produto</th>
              <th>Propriedade GA4</th>
              <th>Container GTM</th>
              <th>Domínio(s)</th>
              <th>Status da migração</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((p) => (
              <tr key={p.product}>
                <td style={{ fontSize: "0.85rem", fontWeight: 500, verticalAlign: "top" }}>{p.product}</td>
                <td style={{ fontFamily: "monospace", fontSize: "0.78rem", verticalAlign: "top" }}>{p.measurementId}</td>
                <td style={{ fontFamily: "monospace", fontSize: "0.78rem", verticalAlign: "top" }}>{p.containerId || "—"}</td>
                <td style={{ verticalAlign: "top" }}>
                  {p.semDominioConhecido ? (
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>sem tráfego com domínio ainda</span>
                  ) : (
                    p.domains.map((d) => (
                      <div key={d.hostname} style={{ fontSize: "0.78rem", marginBottom: 2 }}>
                        {d.hostname} <span style={{ color: "var(--text-muted)" }}>({d.events})</span>
                      </div>
                    ))
                  )}
                </td>
                <td style={{ verticalAlign: "top" }}>
                  {p.domains.length === 0
                    ? "—"
                    : p.domains.map((d) => {
                        const ui = STATUS_UI[d.status];
                        const Icon = ui.icon;
                        return (
                          <div key={d.hostname} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem", color: ui.color, marginBottom: 2 }}>
                            <Icon size={13} />
                            {d.status === "outro_produto" ? `É do ${d.ownerProduct}` : ui.label}
                            {d.status === "pendente" && d.foundIds.length > 0 && (
                              <span style={{ color: "var(--text-muted)" }}>({d.foundIds.join(", ")})</span>
                            )}
                          </div>
                        );
                      })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
