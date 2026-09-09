"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Link2,
  Power,
} from "lucide-react";

type Account = {
  id: number;
  label: string;
  customerId: string;
  loginCustomerId: string;
  conversionActionId: string;
  googleEmail: string | null;
  products: string[];
  enabled: boolean;
  conectada: boolean;
  lastError: string | null;
  connectUrl: string | null;
};

const VAZIO = { label: "", customerId: "", loginCustomerId: "", conversionActionId: "", products: [] as string[] };

export default function GoogleAdsAccounts({ produtos }: { produtos: string[] }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [novo, setNovo] = useState({ ...VAZIO });
  const [criando, setCriando] = useState(false);
  const [form, setForm] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/google-ads-accounts", { cache: "no-store" });
      const data = await res.json();
      setAccounts(data.accounts || []);
      setErro(data.error || null);
    } catch (err: any) {
      setErro(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function criar() {
    setCriando(true);
    try {
      const res = await fetch("/api/google-ads-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(novo),
      });
      const data = await res.json();
      if (!res.ok) {
        setErro(data.error);
        return;
      }
      setNovo({ ...VAZIO });
      setForm(false);
      setErro(null);
      await load();
    } finally {
      setCriando(false);
    }
  }

  async function acao(id: number, patch: any) {
    await fetch("/api/google-ads-accounts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    await load();
  }

  async function remover(a: Account) {
    if (!confirm(`Remover a conta "${a.label}"?\n\nIsso apaga o token de acesso guardado. As conversões param de ser enviadas para ela.`)) return;
    await fetch("/api/google-ads-accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id }),
    });
    await load();
  }

  const input: React.CSSProperties = {
    padding: "0.5rem 0.65rem",
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    color: "var(--text-main)",
    fontSize: "0.82rem",
    fontFamily: "inherit",
    width: "100%",
  };

  return (
    <div className="table-container" style={{ marginBottom: "2rem" }}>
      <div className="table-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Link2 size={18} /> Contas do Google Ads
        </h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="btn" style={{ background: "var(--surface-hover)", color: "var(--text-main)" }} onClick={load} disabled={loading}>
            {loading ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
          </button>
          <button className="btn btn-primary" onClick={() => setForm((v) => !v)}>
            <Plus size={16} /> Nova conta
          </button>
        </div>
      </div>

      <div style={{ padding: "0.85rem 1.25rem", borderBottom: "1px solid var(--border)", fontSize: "0.78rem", color: "var(--text-muted)" }}>
        Cada conta guarda o seu próprio acesso — não depende de uma MCC única. A venda vai para a
        conta cujo produto casar; a conta <strong>sem produtos marcados</strong> recebe todo o resto.
      </div>

      {erro && (
        <div style={{ padding: "0.85rem 1.25rem", background: "rgba(239,68,68,0.08)", borderBottom: "1px solid var(--border)", fontSize: "0.8rem", color: "var(--danger)" }}>
          {erro}
        </div>
      )}

      {form && (
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.75rem", marginBottom: "0.75rem" }}>
            <div>
              <label style={{ fontSize: "0.68rem", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Nome</label>
              <input style={input} placeholder="ex: Conta BR principal" value={novo.label} onChange={(e) => setNovo({ ...novo, label: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: "0.68rem", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Customer ID</label>
              <input style={input} placeholder="123-456-7890" value={novo.customerId} onChange={(e) => setNovo({ ...novo, customerId: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: "0.68rem", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>ID da ação de conversão</label>
              <input style={input} placeholder="987654321" value={novo.conversionActionId} onChange={(e) => setNovo({ ...novo, conversionActionId: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: "0.68rem", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Login Customer ID (MCC, opcional)</label>
              <input style={input} placeholder="só se acessar via MCC" value={novo.loginCustomerId} onChange={(e) => setNovo({ ...novo, loginCustomerId: e.target.value })} />
            </div>
          </div>

          <label style={{ fontSize: "0.68rem", textTransform: "uppercase", color: "var(--text-muted)", display: "block", marginBottom: 6 }}>
            Produtos desta conta (nenhum marcado = recebe todo o resto)
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginBottom: "0.9rem" }}>
            {produtos.map((p) => {
              const on = novo.products.includes(p);
              return (
                <button
                  key={p}
                  className="badge"
                  onClick={() => setNovo({ ...novo, products: on ? novo.products.filter((x) => x !== p) : [...novo.products, p] })}
                  style={{ background: on ? "var(--primary)" : "rgba(255,255,255,0.06)", color: on ? "#fff" : "var(--text-muted)", border: "none", cursor: "pointer" }}
                >
                  {p}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="btn btn-primary" onClick={criar} disabled={criando}>
              {criando ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={16} />} Criar
            </button>
            <button className="btn" style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }} onClick={() => { setForm(false); setNovo({ ...VAZIO }); }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {accounts.length === 0 && !loading ? (
        <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Nenhuma conta conectada ainda. Clique em “Nova conta” para começar.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Conta</th>
                <th>Customer ID</th>
                <th>Produtos</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} style={{ opacity: a.enabled ? 1 : 0.5 }}>
                  <td style={{ fontSize: "0.85rem", fontWeight: 500, verticalAlign: "top" }}>
                    {a.label}
                    {a.googleEmail && (
                      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontWeight: 400 }}>{a.googleEmail}</div>
                    )}
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: "0.78rem", verticalAlign: "top" }}>
                    {a.customerId}
                    {a.conversionActionId ? (
                      <div style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>ação {a.conversionActionId}</div>
                    ) : (
                      <div style={{ color: "var(--warning)", fontSize: "0.72rem" }}>sem ação de conversão</div>
                    )}
                  </td>
                  <td style={{ fontSize: "0.75rem", verticalAlign: "top", maxWidth: 260 }}>
                    {a.products.length === 0 ? (
                      <span style={{ color: "var(--text-muted)" }}>todo o resto</span>
                    ) : (
                      a.products.join(", ")
                    )}
                  </td>
                  <td style={{ verticalAlign: "top" }}>
                    {a.conectada ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.78rem", color: "var(--success)" }}>
                        <CheckCircle2 size={13} /> Conectada
                      </span>
                    ) : a.connectUrl ? (
                      <a href={a.connectUrl} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ fontSize: "0.75rem", padding: "0.3rem 0.7rem" }}>
                        <Link2 size={13} /> Conectar
                      </a>
                    ) : (
                      <span style={{ fontSize: "0.75rem", color: "var(--warning)" }}>configure o domínio</span>
                    )}
                    {a.lastError && (
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 4, fontSize: "0.7rem", color: "var(--danger)", marginTop: 4, maxWidth: 240 }}>
                        <AlertTriangle size={11} style={{ marginTop: 2, flexShrink: 0 }} /> {a.lastError}
                      </div>
                    )}
                  </td>
                  <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => acao(a.id, { enabled: !a.enabled })}
                      title={a.enabled ? "Desativar" : "Ativar"}
                      style={{ background: "none", border: "none", cursor: "pointer", color: a.enabled ? "var(--success)" : "var(--text-muted)", padding: 4 }}
                    >
                      <Power size={15} />
                    </button>
                    {a.conectada && (
                      <button
                        onClick={() => acao(a.id, { action: "reconnect" })}
                        title="Reconectar (gera novo link)"
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}
                      >
                        <RefreshCw size={15} />
                      </button>
                    )}
                    <button
                      onClick={() => remover(a)}
                      title="Remover"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", padding: 4 }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
