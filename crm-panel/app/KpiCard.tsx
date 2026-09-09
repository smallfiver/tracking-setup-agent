import type { ReactNode } from "react";

type Tone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

const TONE_VARS: Record<Tone, { accent: string; soft: string }> = {
  primary: { accent: "var(--primary)", soft: "var(--primary-soft)" },
  success: { accent: "var(--success)", soft: "var(--success-soft)" },
  warning: { accent: "var(--warning)", soft: "var(--warning-soft)" },
  danger: { accent: "var(--danger)", soft: "var(--danger-soft)" },
  info: { accent: "var(--info)", soft: "var(--info-soft)" },
  neutral: { accent: "var(--text-muted)", soft: "var(--neutral-soft)" },
};

/**
 * Card de KPI padronizado: ícone com acento colorido, valor grande, dica
 * opcional e badge de tendência opcional. Usado no Dashboard para dar
 * hierarquia visual imediata às métricas mais importantes.
 */
export default function KpiCard({
  icon,
  label,
  value,
  valueColor,
  hint,
  tone = "primary",
  trend,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueColor?: string;
  hint?: ReactNode;
  tone?: Tone;
  trend?: { direction: "up" | "down" | "flat"; label: string };
}) {
  const t = TONE_VARS[tone];
  return (
    <div
      className="kpi-card"
      style={{ ["--kpi-accent" as any]: t.accent, ["--kpi-accent-soft" as any]: t.soft }}
    >
      <div className="kpi-head">
        <div className="kpi-icon">{icon}</div>
        {trend && (
          <span className={`kpi-trend ${trend.direction}`}>
            {trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "–"} {trend.label}
          </span>
        )}
      </div>
      <div className="kpi-label">{label}</div>
      <div
        className="kpi-value"
        aria-label={`${label}: ${value}`}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}
