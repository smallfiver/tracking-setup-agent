"use client";

import { useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SalesTrendPoint } from "../lib/dashboard";

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value || 0);

function TooltipBox({ active, payload, label, kind }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as SalesTrendPoint;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      <span>{kind === "revenue" ? money(point.revenue) : `${point.sales} vendas`}</span>
      {kind === "revenue" && point.sales > 0 && <small>{point.sales} vendas · ticket {money(point.ticket)}</small>}
    </div>
  );
}

export default function SalesTrendChart({
  data,
  granularity,
}: {
  data: SalesTrendPoint[];
  granularity: string;
}) {
  const [view, setView] = useState<"revenue" | "sales">("revenue");
  const titleId = useId();

  if (!data.length) {
    return (
      <div className="chart-empty" role="status">
        Nenhuma venda aprovada no período selecionado.
      </div>
    );
  }

  const totalRevenue = data.reduce((sum, point) => sum + point.revenue, 0);
  const totalSales = data.reduce((sum, point) => sum + point.sales, 0);
  const best = data.reduce((winner, point) => point.revenue > winner.revenue ? point : winner, data[0]);

  return (
    <div className="trend-chart" aria-labelledby={titleId}>
      <div className="chart-toolbar">
        <div>
          <h2 id={titleId}>Evolução de vendas</h2>
          <p>{granularity} · {totalSales.toLocaleString("pt-BR")} vendas · {money(totalRevenue)}</p>
        </div>
        <div className="chart-toggle" aria-label="Métrica do gráfico">
          <button
            type="button"
            className={view === "revenue" ? "active" : ""}
            aria-pressed={view === "revenue"}
            onClick={() => setView("revenue")}
          >
            Receita
          </button>
          <button
            type="button"
            className={view === "sales" ? "active" : ""}
            aria-pressed={view === "sales"}
            onClick={() => setView("sales")}
          >
            Vendas
          </button>
        </div>
      </div>

      <p className="chart-insight">
        Melhor ponto do recorte: <strong>{best.label}</strong>, com {money(best.revenue)} e {best.sales} vendas.
      </p>

      <div
        className="chart-frame"
        role="img"
        aria-label={`${view === "revenue" ? "Receita" : "Vendas"} ${granularity}. Melhor período ${best.label}.`}
      >
        <ResponsiveContainer width="100%" height={300}>
          {view === "revenue" ? (
            <AreaChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
              <defs>
                <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="label" stroke="var(--text-faint)" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis stroke="var(--text-faint)" tickLine={false} axisLine={false} width={72} tickFormatter={money} />
              <Tooltip content={<TooltipBox kind="revenue" />} cursor={{ stroke: "var(--series-1)", strokeDasharray: "3 3" }} />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="var(--series-1)"
                strokeWidth={2}
                fill="url(#revenueFill)"
                activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
              />
            </AreaChart>
          ) : (
            <BarChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="label" stroke="var(--text-faint)" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis stroke="var(--text-faint)" tickLine={false} axisLine={false} width={42} allowDecimals={false} />
              <Tooltip content={<TooltipBox kind="sales" />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="sales" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>

      <details className="chart-table-details">
        <summary>Ver dados em tabela</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Período</th><th>Vendas</th><th>Receita</th><th>Ticket</th></tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.bucket}>
                  <td>{point.label}</td>
                  <td>{point.sales}</td>
                  <td>{money(point.revenue)}</td>
                  <td>{money(point.ticket)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
