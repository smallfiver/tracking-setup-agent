import { safeQuery } from "../../../lib/db";
import {
  parseFilters,
  buildWhere,
  platformExpr,
  parseConversionFilters,
  buildConversionsWhere,
} from "../../../lib/filters";

export const dynamic = "force-dynamic";

/** Colunas exportadas por tabela (ordem = ordem das colunas no CSV). */
const COLUMNS: Record<string, string[]> = {
  purchases: [
    "created_at",
    "event_name",
    "purchase_type",
    "platform",
    "product_name",
    "offer_name",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "device_type",
    "browser",
    "os",
    "value",
    "currency",
    "payment_method",
    "installments",
    "transaction_id",
    "customer_name",
    "customer_email",
    "customer_phone",
    "customer_document",
    "customer_city",
    "customer_state",
    "geo_country",
    "attribution_source",
    "gclid",
    "gbraid",
    "wbraid",
    "fbclid",
    "hostname",
  ],
  events: [
    "created_at",
    "event_name",
    "source",
    "platform",
    "product_name",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "device_type",
    "browser",
    "os",
    "geo_city",
    "geo_region",
    "geo_country",
    "value",
    "currency",
    "email",
    "phone",
    "gclid",
    "gbraid",
    "wbraid",
    "fbclid",
    "fbc",
    "hostname",
    "page_location",
  ],
  conversions: [
    "created_at",
    "destination",
    "event_name",
    "event_id",
    "transaction_id",
    "value",
    "currency",
    "status",
    "detail",
  ],
};

const MAX_ROWS = 50000;

/** Escapa um campo para CSV (RFC 4180). */
function csvCell(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const param = searchParams.get("table");
  const table = param === "events" ? "events" : param === "conversions" ? "conversions" : "purchases";
  const dbTable = table === "conversions" ? "conversions_log" : table;

  const { where, params } =
    table === "conversions"
      ? buildConversionsWhere(parseConversionFilters(searchParams))
      : buildWhere(parseFilters(searchParams));

  const cols = COLUMNS[table];
  // 'platform' é derivado; as demais são colunas reais.
  const select = cols
    .map((c) => (c === "platform" ? `${platformExpr()} AS platform` : c))
    .join(", ");

  const sql = `SELECT ${select} FROM ${dbTable} ${where} ORDER BY created_at DESC LIMIT ${MAX_ROWS}`;
  const { rows, error } = await safeQuery(sql, params);

  if (error) {
    return new Response(`Erro ao exportar: ${error}`, { status: 500 });
  }

  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row[c])).join(","));
  }
  // BOM para o Excel abrir acentuação corretamente.
  const csv = "﻿" + lines.join("\r\n");

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (v: string | null) => (v ? v.replace(/[^a-z0-9]+/gi, "-").slice(0, 30) : "");
  const parts = [table, stamp];
  for (const k of ["product", "campaign", "destination", "status"]) {
    const v = slug(searchParams.get(k));
    if (v) parts.push(v);
  }
  const filename = parts.join("_") + ".csv";

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
