import { safeQuery } from "../../../../lib/db";
import { parseMercado, comMercado } from "../../../../lib/mercado";

export const dynamic = "force-dynamic";

/**
 * CSV da lista de recuperacao de carrinho.
 *
 * Formato pensado para colar direto em ferramenta de disparo: contato primeiro,
 * depois valor e origem. Quem ja comprou fica de fora — cobrar quem pagou e a
 * forma mais rapida de queimar a lista.
 */

const COLS = [
  "abandonado_em",
  "nome",
  "email",
  "telefone",
  "produto",
  "valor",
  "moeda",
  "utm_source",
  "utm_campaign",
  "pais",
  "dispositivo",
  "plataforma",
];

function csvCell(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mercado = parseMercado(Object.fromEntries(searchParams));

  const base =
    "WHERE event_name = 'abandoned_checkout' AND (customer_email IS NOT NULL OR customer_phone IS NOT NULL)";

  const { rows, error } = await safeQuery(
    `SELECT created_at, customer_name, customer_email, customer_phone, product_name,
            value, currency, utm_source, utm_campaign, customer_country, device_type, platform
     FROM purchases ${comMercado(base, mercado)}
     ORDER BY created_at DESC LIMIT 50000`
  );
  if (error) return new Response(`Erro ao exportar: ${error}`, { status: 500 });

  const { rows: compradores } = await safeQuery(
    "SELECT DISTINCT customer_email AS email, customer_phone AS phone FROM purchases WHERE event_name = 'purchase'"
  );
  const emails = new Set(compradores.map((c) => String(c.email || "")).filter(Boolean));
  const fones = new Set(compradores.map((c) => String(c.phone || "")).filter(Boolean));

  const lines = [COLS.join(",")];
  for (const r of rows) {
    const email = String(r.customer_email || "");
    const phone = String(r.customer_phone || "");
    if ((email && emails.has(email)) || (phone && fones.has(phone))) continue;

    lines.push(
      [
        r.created_at,
        r.customer_name,
        email,
        phone,
        r.product_name,
        r.value,
        r.currency,
        r.utm_source,
        r.utm_campaign,
        r.customer_country,
        r.device_type,
        r.platform,
      ]
        .map(csvCell)
        .join(",")
    );
  }

  // BOM para o Excel abrir acentuacao corretamente.
  const csv = "﻿" + lines.join("\r\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="recuperacao_${mercado}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
