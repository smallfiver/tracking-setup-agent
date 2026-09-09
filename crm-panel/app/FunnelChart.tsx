type Step = { name: string; label: string; count: number };

/**
 * Funil de verdade: barras com largura proporcional ao maior estágio, e a
 * queda percentual entre uma etapa e a seguinte — o dado que mais importa
 * para um analista (onde o funil está vazando). Sempre com texto/número
 * visível, nunca só a cor (WCAG color-not-only) — serve também de fallback
 * acessível equivalente a uma tabela.
 */
export default function FunnelChart({ steps }: { steps: Step[] }) {
  if (steps.length === 0) {
    return <div style={{ color: "var(--text-muted)" }}>Nenhum evento registrado ainda.</div>;
  }

  const max = Math.max(...steps.map((s) => s.count), 1);

  // Maior queda percentual entre etapas consecutivas — o gargalo do funil.
  let biggestDropIdx = -1;
  let biggestDrop = -Infinity;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].count;
    const cur = steps[i].count;
    if (prev <= 0) continue;
    const drop = ((prev - cur) / prev) * 100;
    if (drop > biggestDrop) {
      biggestDrop = drop;
      biggestDropIdx = i;
    }
  }

  return (
    <div
      className="funnel-chart"
      role="img"
      aria-label={`Funil com ${steps.length} etapas, de ${steps[0]?.label} até ${steps[steps.length - 1]?.label}`}
    >
      {steps.map((step, i) => {
        const widthPct = (step.count / max) * 100;
        const isFinal = step.name === "purchase" || step.name === "refund" || step.name === "chargeback";
        const color = step.name === "purchase" ? "var(--success)" : step.name === "refund" || step.name === "chargeback" ? "var(--danger)" : "var(--chart-1)";

        let dropInfo: { pct: number; big: boolean } | null = null;
        if (i > 0 && steps[i - 1].count > 0) {
          const pct = ((steps[i - 1].count - step.count) / steps[i - 1].count) * 100;
          dropInfo = { pct, big: i === biggestDropIdx && pct > 0 };
        }

        return (
          <div key={step.name} className="funnel-step">
            {dropInfo && (
              <div className={`funnel-drop ${dropInfo.big ? "big-drop" : ""}`}>
                <span className="arrow">↓</span>
                {dropInfo.pct >= 0
                  ? `${dropInfo.pct.toFixed(0)}% não avançaram`
                  : `+${Math.abs(dropInfo.pct).toFixed(0)}% (evento fora de ordem)`}
                {dropInfo.big && ' · maior queda do funil'}
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "0.85rem",
                marginBottom: "0.35rem",
                fontWeight: isFinal ? 600 : 400,
              }}
            >
              <span>{step.label}</span>
              <span style={{ color: "var(--text-muted)" }} className="mono-num">
                {step.count.toLocaleString("pt-BR")}
              </span>
            </div>
            <div className="funnel-bar-track">
              <div
                className="funnel-bar-fill"
                style={{ width: `${Math.max(widthPct, 1.5)}%`, background: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
