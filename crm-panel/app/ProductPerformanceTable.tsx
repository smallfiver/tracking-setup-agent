"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { Filters } from "../lib/filters";
import { filtersToQuery } from "../lib/filters";
import type { ProductPerformance } from "../lib/dashboard";
import MiniBar from "./MiniBar";

const brl = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
const usd = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" }).format(value || 0);
const pct = (value: number | null) => value === null ? "—" : `${value.toFixed(2).replace(".", ",")}%`;

type SortKey = "product" | "revenueBrl" | "sales" | "sessions" | "conversionRate" | "ticketBrl";

export default function ProductPerformanceTable({
  products,
  filters,
}: {
  products: ProductPerformance[];
  filters: Filters;
}) {
  const [sort, setSort] = useState<SortKey>("revenueBrl");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const value = (row: ProductPerformance): string | number => {
      if (sort === "product") return row.product.toLocaleLowerCase("pt-BR");
      if (sort === "sales") return row.salesBrl + row.salesIntl;
      return row[sort] ?? -1;
    };
    return [...products].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const comparison = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, "pt-BR") : Number(av) - Number(bv);
      return direction === "asc" ? comparison : -comparison;
    });
  }, [products, sort, direction]);

  const setSortKey = (key: SortKey) => {
    if (sort === key) setDirection((current) => current === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDirection(key === "product" ? "asc" : "desc");
    }
  };

  const SortButton = ({ column, children }: { column: SortKey; children: React.ReactNode }) => {
    const active = sort === column;
    const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        className="sort-button"
        onClick={() => setSortKey(column)}
        aria-label={`Ordenar por ${String(children)}`}
      >
        {children}<Icon size={12} aria-hidden="true" />
      </button>
    );
  };

  if (!products.length) {
    return <div className="table-empty">Nenhum produto encontrado neste recorte.</div>;
  }

  const maxRevenue = Math.max(...products.map((row) => row.revenueBrl), 1);

  return (
    <div className="table-scroll">
      <table className="product-table">
        <thead>
          <tr>
            <th aria-sort={sort === "product" ? (direction === "asc" ? "ascending" : "descending") : "none"}><SortButton column="product">Produto</SortButton></th>
            <th aria-sort={sort === "revenueBrl" ? (direction === "asc" ? "ascending" : "descending") : "none"}><SortButton column="revenueBrl">Receita</SortButton></th>
            <th aria-sort={sort === "sales" ? (direction === "asc" ? "ascending" : "descending") : "none"}><SortButton column="sales">Vendas</SortButton></th>
            <th aria-sort={sort === "sessions" ? (direction === "asc" ? "ascending" : "descending") : "none"}><SortButton column="sessions">Sessões</SortButton></th>
            <th>Checkouts</th>
            <th aria-sort={sort === "conversionRate" ? (direction === "asc" ? "ascending" : "descending") : "none"}><SortButton column="conversionRate">Conversão</SortButton></th>
            <th aria-sort={sort === "ticketBrl" ? (direction === "asc" ? "ascending" : "descending") : "none"}><SortButton column="ticketBrl">Ticket</SortButton></th>
            <th>Participação</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const query = filtersToQuery(filters, { product: row.product });
            return (
              <tr key={row.product}>
                <td>
                  <strong className="product-name" title={row.product}>{row.product}</strong>
                  <div className="product-links">
                    <a href={`/purchases?${query}`}>vendas</a>
                    <a href={`/events?${query}`}>eventos</a>
                  </div>
                </td>
                <td>
                  <div className="mini-bar-cell product-revenue">
                    <span>
                      <strong>{brl(row.revenueBrl)}</strong>
                      {row.revenueUsd > 0 && <small>+ {usd(row.revenueUsd)} intl</small>}
                    </span>
                    <MiniBar value={row.revenueBrl} max={maxRevenue} color="var(--series-1)" />
                  </div>
                </td>
                <td>
                  {row.salesBrl + row.salesIntl}
                  {row.salesIntl > 0 && <small className="cell-note">{row.salesIntl} internacionais</small>}
                </td>
                <td>{row.sessions > 0 ? row.sessions.toLocaleString("pt-BR") : "—"}</td>
                <td>{row.checkouts.toLocaleString("pt-BR")}</td>
                <td>{pct(row.conversionRate)}</td>
                <td>{row.ticketBrl === null ? "—" : brl(row.ticketBrl)}</td>
                <td>{pct(row.shareBrl)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
