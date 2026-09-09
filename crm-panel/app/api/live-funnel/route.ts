import { NextResponse } from "next/server";
import { safeQuery } from "../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Quantas pessoas estao "ao vivo" em cada etapa do funil agora.
 *
 * Conta visitantes distintos (tsid, ou client_id/session_id quando falta o
 * tsid) que geraram cada tipo de evento dentro da janela — um retrato de
 * onde o trafego esta concentrado neste momento, nao um total acumulado.
 *
 * Query params:
 *   sinceMin -> janela em minutos (padrao 15, teto 180)
 *   produto  -> filtra por product_name (seletor global da sidebar)
 */
/**
 * Cada etapa aceita mais de um nome de evento porque a visita muda de nome
 * conforme a configuracao: com TRACK_PAGE_VIEWS ligado o snippet manda
 * "page_view", desligado manda "landing". Contar so um dos dois zerava a
 * etapa de visita quando a configuracao mudava.
 */
const STAGES: { key: string; label: string; events: string[] }[] = [
  { key: "visita", label: "Visita", events: ["page_view", "landing"] },
  { key: "initiate_checkout", label: "Checkout", events: ["initiate_checkout", "begin_checkout"] },
  { key: "pix_generated", label: "Pix gerado", events: ["pix_generated"] },
  { key: "purchase", label: "Compra", events: ["purchase"] },
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sinceMin = Math.min(Math.max(Number(searchParams.get("sinceMin")) || 15, 1), 180);
  const produto = searchParams.get("produto") || "";
  const produtoClause = produto ? "AND product_name = ?" : "";
  const produtoParams = produto ? [produto] : [];

  // Agrupa por ETAPA, nao por evento: assim quem tem page_view e landing na
  // mesma janela conta como uma pessoa so, nao duas.
  const caseWhen = STAGES.map(
    (s) => `WHEN event_name IN (${s.events.map((e) => `'${e}'`).join(", ")}) THEN '${s.key}'`
  ).join(" ");

  const sql = `
    SELECT
      CASE ${caseWhen} ELSE 'outro' END AS etapa,
      COUNT(DISTINCT COALESCE(tsid, client_id, session_id)) AS visitantes,
      COUNT(*) AS eventos
    FROM events
    WHERE created_at >= datetime('now', ?) ${produtoClause}
    GROUP BY etapa
  `;

  const { rows, error } = await safeQuery(sql, [`-${sinceMin} minutes`, ...produtoParams]);

  if (error) {
    return NextResponse.json({ stages: [], totalAoVivo: 0, error });
  }

  const byStage = new Map<string, { visitantes: number; eventos: number }>();
  for (const r of rows) {
    byStage.set(String(r.etapa || ""), {
      visitantes: Number(r.visitantes) || 0,
      eventos: Number(r.eventos) || 0,
    });
  }

  const stages = STAGES.map((s) => ({
    event: s.key,
    label: s.label,
    visitantes: byStage.get(s.key)?.visitantes || 0,
    eventos: byStage.get(s.key)?.eventos || 0,
  }));

  // Total ao vivo = visitantes distintos com qualquer evento na janela (nao a
  // soma das etapas, que contaria a mesma pessoa mais de uma vez).
  const totalSql = `
    SELECT COUNT(DISTINCT COALESCE(tsid, client_id, session_id)) AS n
    FROM events
    WHERE created_at >= datetime('now', ?) ${produtoClause}
  `;
  const { rows: totalRows, error: totalError } = await safeQuery(totalSql, [
    `-${sinceMin} minutes`,
    ...produtoParams,
  ]);
  const totalAoVivo = totalError ? 0 : Number(totalRows?.[0]?.n) || 0;

  return NextResponse.json({ stages, totalAoVivo, sinceMin, error: null });
}
