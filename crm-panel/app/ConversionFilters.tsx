"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SlidersHorizontal, Download, X } from "lucide-react";
import { PERIOD_LABELS, CONV_DESTINATION_LABELS, CONV_STATUS_LABELS } from "../lib/filters";

/**
 * Filtros da tela de Conversões enviadas. Dimensões próprias do log:
 * Destino (Meta/Google), Status, Evento e Período. Tudo por URL + export CSV.
 */
export default function ConversionFilters({ events }: { events: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const val = (k: string) => sp.get(k) || "";
  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.push(`${pathname}?${next.toString()}`);
  };

  const exportHref = `/api/export?table=conversions&${sp.toString()}`;
  const hasAny = ["destination", "status", "event", "period", "from", "to"].some((k) => sp.get(k));

  const selectStyle: React.CSSProperties = {
    padding: "0.5rem 0.65rem",
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    color: "var(--text-main)",
    fontSize: "0.8rem",
    fontFamily: "inherit",
    minWidth: 150,
    cursor: "pointer",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "0.65rem",
    textTransform: "uppercase",
    color: "var(--text-muted)",
    marginBottom: 4,
    letterSpacing: "0.03em",
  };

  const Field = ({
    label,
    param,
    children,
  }: {
    label: string;
    param: string;
    children: React.ReactNode;
  }) => (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={labelStyle}>{label}</span>
      <select value={val(param)} onChange={(e) => setParam({ [param]: e.target.value })} style={selectStyle}>
        {children}
      </select>
    </div>
  );

  return (
    <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.9rem" }}>
        <SlidersHorizontal size={16} style={{ color: "var(--primary)" }} />
        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Filtros</span>
        {hasAny && (
          <button
            onClick={() => router.push(pathname)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginLeft: 4,
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              fontSize: "0.72rem",
              cursor: "pointer",
            }}
          >
            <X size={13} /> limpar
          </button>
        )}
        <a
          href={exportHref}
          className="btn"
          style={{
            marginLeft: "auto",
            background: "var(--surface-hover)",
            color: "var(--text-main)",
            padding: "0.45rem 0.9rem",
            fontSize: "0.8rem",
          }}
        >
          <Download size={15} /> Exportar CSV
        </a>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Período" param="period">
          {Object.entries(PERIOD_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Field>

        {val("period") === "custom" && (
          <>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={labelStyle}>De</span>
              <input type="date" value={val("from")} onChange={(e) => setParam({ from: e.target.value, period: "custom" })} style={selectStyle} />
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={labelStyle}>Até</span>
              <input type="date" value={val("to")} onChange={(e) => setParam({ to: e.target.value, period: "custom" })} style={selectStyle} />
            </div>
          </>
        )}

        <Field label="Destino" param="destination">
          {Object.entries(CONV_DESTINATION_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Field>

        <Field label="Status" param="status">
          {Object.entries(CONV_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Field>

        <Field label="Evento" param="event">
          <option value="">Todos os eventos</option>
          {events.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Field>
      </div>
    </div>
  );
}
