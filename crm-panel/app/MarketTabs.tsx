import { MERCADOS, Mercado, hrefMercado } from "../lib/mercado";

/**
 * Abas Brasil / LATAM.
 *
 * Cada aba e um link que so troca o parametro "mercado" — os filtros que o
 * usuario ja aplicou (periodo, campanha, plataforma) sobrevivem a troca.
 */
export default function MarketTabs({
  searchParams,
  atual,
  contagem,
}: {
  searchParams: Record<string, string>;
  atual: Mercado;
  /** Quantas vendas cada mercado tem no recorte, para a aba vazia se anunciar. */
  contagem?: Partial<Record<Mercado, number>>;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        marginBottom: "1.25rem",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {MERCADOS.map((m) => {
        const ativo = m.id === atual;
        const n = contagem?.[m.id];
        return (
          <a
            key={m.id}
            href={hrefMercado(searchParams, m.id)}
            style={{
              padding: "0.6rem 1.1rem",
              fontSize: "0.9rem",
              fontWeight: ativo ? 600 : 400,
              color: ativo ? "var(--text-main)" : "var(--text-muted)",
              borderBottom: `2px solid ${ativo ? "var(--primary)" : "transparent"}`,
              marginBottom: -1,
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
              gap: "0.45rem",
            }}
          >
            {m.label}
            {typeof n === "number" && (
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "var(--text-muted)",
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 10,
                  padding: "0.1rem 0.45rem",
                }}
              >
                {n}
              </span>
            )}
          </a>
        );
      })}
      <div
        style={{
          marginLeft: "auto",
          alignSelf: "center",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          paddingBottom: "0.5rem",
        }}
      >
        {MERCADOS.find((m) => m.id === atual)?.sufixo}
      </div>
    </div>
  );
}
