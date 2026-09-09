import { safeQuery } from "../lib/db";
import { getSelectedProduct } from "../lib/productFilter";
import FilterControls from "./FilterControls";

/**
 * Carrega as opções dos dropdowns (valores distintos do banco) e entrega para o
 * controle cliente. Busca produtos/campanhas/dispositivos/domínios de fato
 * presentes na tabela — nada de opção que não existe nos dados.
 */
export default async function FilterBar({
  table,
  dashboard = false,
}: {
  table: "events" | "purchases";
  dashboard?: boolean;
}) {
  const distinct = async (col: string) => {
    const tables = dashboard ? ["purchases", "events"] : [table];
    const queries = tables.map(
      (source) =>
        `SELECT ${col} AS v, COUNT(*) AS n FROM ${source}
         WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col}`
    );
    const { rows } = await safeQuery(
      `SELECT v, SUM(n) AS n FROM (${queries.join(" UNION ALL ")})
       GROUP BY v ORDER BY n DESC LIMIT 100`
    );
    return rows.map((r) => String(r.v));
  };

  const [products, campaigns, devices, sites] = await Promise.all([
    distinct("product_name"),
    distinct("utm_campaign"),
    distinct("device_type"),
    distinct("hostname"),
  ]);

  return (
    <FilterControls
      table={table}
      dashboard={dashboard}
      options={{ products, campaigns, devices, sites }}
      defaultProduct={getSelectedProduct() || ""}
    />
  );
}
