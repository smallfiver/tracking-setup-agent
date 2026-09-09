"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { SlidersHorizontal, Download, X } from "lucide-react";
import { PERIOD_LABELS, PLATFORM_LABELS } from "../lib/filters";

type Options = {
  products: string[];
  campaigns: string[];
  devices: string[];
  sites: string[];
};

/**
 * Barra de filtros avançados. Dirige tudo pela URL (?product=&campaign=...),
 * então cada combinação é um link compartilhável — útil quando se opera muitas
 * contas e ofertas. O botão de CSV exporta exatamente o recorte filtrado.
 */
export default function FilterControls({
  table,
  options,
  dashboard = false,
  defaultProduct = "",
}: {
  table: "events" | "purchases";
  options: Options;
  dashboard?: boolean;
  /** Produto vindo do seletor global da sidebar, quando a URL não escolheu nenhum. */
  defaultProduct?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const val = (k: string) => sp.get(k) || "";
  // Sentinela: "ver todos" explicito na URL precisa vencer o padrao da sidebar,
  // senao escolher "Todos os produtos" aqui so volta pro filtro global de novo.
  const ALL = "__todos__";
  const rawProduct = sp.get("product");
  const productFromCookie = !rawProduct && Boolean(defaultProduct);
  const productValue = rawProduct === ALL ? "" : rawProduct || defaultProduct;

  const setParam = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.push(`${pathname}?${next.toString()}`);
    },
    [sp, pathname, router]
  );

  const exportHref = `/api/export?table=${table}&${sp.toString()}`;
  const hasAny = ["site", "product", "campaign", "platform", "device", "period", "from", "to"].some(
    (k) => sp.get(k)
  );

  const selectStyle: React.CSSProperties = {
    padding: "0.5rem 0.65rem",
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    color: "var(--text-main)",
    fontSize: "0.8rem",
    fontFamily: "inherit",
    minWidth: 140,
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
    value,
    children,
    minWidth,
  }: {
    label: string;
    param: string;
    value: string;
    children: React.ReactNode;
    minWidth?: number;
  }) => {
    const id = `filter-${param}`;
    return (
      <div className="filter-field">
        <label htmlFor={id} style={labelStyle}>{label}</label>
        <select
          id={id}
          value={value}
          onChange={(e) => setParam({ [param]: e.target.value })}
          style={{ ...selectStyle, minWidth: minWidth ?? 140 }}
        >
          {children}
        </select>
      </div>
    );
  };

  return (
    <div className={`card filter-card ${dashboard ? "dashboard-filter-card" : ""}`}>
      <div className="filter-card-head">
        <SlidersHorizontal size={16} style={{ color: "var(--primary)" }} />
        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
          {dashboard ? "Recorte da análise" : "Filtros avançados"}
        </span>
        {hasAny && (
          <button
            type="button"
            onClick={() => router.push(pathname)}
            className="filter-clear"
          >
            <X size={13} aria-hidden="true" /> limpar filtros
          </button>
        )}
        {!dashboard && (
          <a
            href={exportHref}
            className="btn filter-export"
          >
            <Download size={15} aria-hidden="true" /> Exportar CSV
          </a>
        )}
      </div>

      <div className="filter-fields">
        <Field label="Período" param="period" value={val("period")} minWidth={150}>
          {Object.entries(PERIOD_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Field>

        {val("period") === "custom" && (
          <>
            <div className="filter-field">
              <label htmlFor="filter-from" style={labelStyle}>De</label>
              <input
                id="filter-from"
                type="date"
                value={val("from")}
                onChange={(e) => setParam({ from: e.target.value, period: "custom" })}
                style={selectStyle}
              />
            </div>
            <div className="filter-field">
              <label htmlFor="filter-to" style={labelStyle}>Até</label>
              <input
                id="filter-to"
                type="date"
                value={val("to")}
                onChange={(e) => setParam({ to: e.target.value, period: "custom" })}
                style={selectStyle}
              />
            </div>
          </>
        )}

        <Field
          label={productFromCookie ? "Produto / Oferta (da sidebar)" : "Produto / Oferta"}
          param="product"
          value={productValue}
          minWidth={180}
        >
          <option value={defaultProduct ? ALL : ""}>Todos os produtos</option>
          {options.products.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Field>

        <Field label="Campanha" param="campaign" value={val("campaign")} minWidth={180}>
          <option value="">Todas as campanhas</option>
          {options.campaigns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Field>

        <Field label="Plataforma" param="platform" value={val("platform")}>
          {Object.entries(PLATFORM_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Field>

        <Field label="Dispositivo" param="device" value={val("device")}>
          <option value="">Todos</option>
          {options.devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Field>

        {options.sites.length > 1 && (
          <Field label="Domínio" param="site" value={val("site")} minWidth={180}>
            <option value="">Todos os domínios</option>
            {options.sites.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Field>
        )}
      </div>
    </div>
  );
}
