import { NextResponse } from "next/server";
import { safeQuery } from "../../../lib/db";

export const dynamic = "force-dynamic";

/**
 * Pontos geolocalizados para o mapa ao vivo.
 *
 * A geo vem do request.cf da Cloudflare, gravada em cada evento (geo_lat/lon +
 * cidade/regiao/pais). Nao devolvemos e-mail — apenas se o visitante ja foi
 * identificado (has_email), para colorir lead x visita no mapa.
 *
 * Query params:
 *   site     -> filtra por hostname (landing page)
 *   produto  -> filtra por product_name (seletor global da sidebar)
 *   sinceMin -> janela em minutos (padrao 1440 = 24h, teto 7 dias)
 *   limit    -> maximo de pontos (padrao 400, teto 2000)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const site = searchParams.get("site") || "";
  const produto = searchParams.get("produto") || "";
  const sinceMin = Math.min(Math.max(Number(searchParams.get("sinceMin")) || 1440, 1), 10080);
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 400, 1), 2000);

  const where = [
    "geo_lat IS NOT NULL",
    "geo_lon IS NOT NULL",
    "created_at >= datetime('now', ?)",
  ];
  const params: any[] = [`-${sinceMin} minutes`];
  if (site) {
    where.push("hostname = ?");
    params.push(site);
  }
  if (produto) {
    where.push("product_name = ?");
    params.push(produto);
  }

  const sql = `
    SELECT
      event_name,
      geo_lat AS lat,
      geo_lon AS lon,
      geo_city AS city,
      geo_region AS region,
      geo_country AS country,
      hostname,
      utm_source,
      utm_campaign,
      CASE WHEN gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL THEN 1 ELSE 0 END AS is_google,
      CASE WHEN fbclid IS NOT NULL OR fbc IS NOT NULL THEN 1 ELSE 0 END AS is_meta,
      CASE WHEN email IS NOT NULL OR phone IS NOT NULL THEN 1 ELSE 0 END AS identified,
      created_at
    FROM events
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  const { rows, error } = await safeQuery(sql, params);

  if (error) {
    // Coluna geo ainda nao existe (setup nao rodou) -> devolve vazio, sem quebrar.
    const missingGeo = /geo_lat|no such column/i.test(error);
    return NextResponse.json({
      points: [],
      total: 0,
      error: missingGeo
        ? "As colunas de geolocalização ainda não existem. Rode o setup para migrar o banco."
        : error,
    });
  }

  const points = rows.map((r) => ({
    event: String(r.event_name || ""),
    lat: Number(r.lat),
    lon: Number(r.lon),
    city: r.city || null,
    region: r.region || null,
    country: r.country || null,
    hostname: r.hostname || null,
    source:
      r.utm_source || (Number(r.is_google) ? "google" : Number(r.is_meta) ? "facebook" : null),
    campaign: r.utm_campaign || null,
    identified: Boolean(Number(r.identified)),
    at: String(r.created_at || ""),
  }));

  return NextResponse.json({ points, total: points.length, error: null });
}
