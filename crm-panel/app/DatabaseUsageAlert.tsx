import { getDatabaseUsage, D1_LIMIT_BYTES } from "../lib/db";
import { AlertTriangle, DatabaseZap } from "lucide-react";

/**
 * Aviso de uso do banco D1.
 *
 * Existe porque o D1 encheu silenciosamente uma vez — ninguem soube ate o
 * rastreamento inteiro cair. Fica quieto (nada renderiza) enquanto o uso for
 * saudavel; so aparece quando vale a pena agir, bem antes do limite.
 */

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2).replace(".", ",");

export default async function DatabaseUsageAlert() {
  const { bytes, error } = await getDatabaseUsage();
  if (error || !bytes) return null;

  const pct = (bytes / D1_LIMIT_BYTES) * 100;
  if (pct < 70) return null; // saudavel — nao polui o dashboard

  const critico = pct >= 90;

  return (
    <div
      className="card"
      role="alert"
      style={{
        borderColor: critico ? "var(--danger)" : "var(--warning)",
        marginBottom: "1.5rem",
        display: "flex",
        gap: "0.75rem",
        alignItems: "flex-start",
      }}
    >
      {critico ? (
        <AlertTriangle size={20} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
      ) : (
        <DatabaseZap size={20} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} />
      )}
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4, color: critico ? "var(--danger)" : "var(--warning)" }}>
          Banco D1 em {pct.toFixed(0)}% de uso ({gb(bytes)} GB de {gb(D1_LIMIT_BYTES)} GB)
        </div>
        <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
          {critico
            ? "Perto do limite do plano. Ao encher, o rastreamento inteiro para de gravar. Vale limpar dados antigos ou reduzir o volume de eventos gravados agora."
            : "Ainda dentro do normal, mas subindo. Fique de olho — foi assim que o banco quase encheu da última vez."}
        </div>
      </div>
    </div>
  );
}
