import { safeQuery, type Row } from "./db";
import { buildWhere, TIMEZONE_OPERACAO, type Filters } from "./filters";
import { toUsd } from "./fx";

const FUNNEL_EVENTS = [
  // "landing" e "page_view" são a mesma etapa (visita) — qual dos dois é
  // gravado depende de trackPageViews. Manter os dois evita o funil perder a
  // primeira etapa quando a configuração muda.
  "landing",
  "page_view",
  "view_item",
  "add_to_cart",
  "initiate_checkout",
  "begin_checkout",
  "add_payment_info",
  "generate_lead",
  "pix_generated",
  "boleto_generated",
  "abandoned_checkout",
  "purchase",
] as const;

export type DashboardTotals = {
  revenue: number;
  purchases: number;
  ticket: number;
  sessions: number;
  leads: number;
  checkouts: number;
  conversionRate: number | null;
  attributed: number;
  attributionTotal: number;
  attributionRate: number | null;
  incrementalRevenue: number;
  incrementalShare: number | null;

  /* --- metricas do lado da plataforma de pagamento ---------------------
   *
   * Sao outra pergunta, e por isso ficam separadas da conversao do site.
   *
   *   conversao do SITE       compras / sessoes      — o anuncio trouxe gente certa?
   *   conversao da PLATAFORMA compras / (compras + abandonos + recusas)
   *                                                  — o checkout converte quem chega nele?
   *
   * A segunda so existe porque a plataforma manda webhook de abandono e de
   * recusa: eles sao o denominador de quem de fato entrou no checkout dela.
   */
  /** Compras de TODAS as moedas — o numerador da conversao da plataforma.
   *  Diferente de `purchases`, que e so BRL por ser a receita do painel. */
  platformPurchases: number;
  platformArrivals: number;
  platformConversion: number | null;
  abandoned: number;
  refused: number;
  refusedRate: number | null;
  pixGenerated: number;
  pixPaidRate: number | null;
  refunds: number;
  chargebacks: number;
  refundRate: number | null;
  revenuePerSession: number | null;
  recoverable: number;
  /** Valor recuperavel em reais e, separado, o internacional em dolar — as
   *  duas moedas nunca somadas (ver lib/mercado.ts). */
  recoverableValue: number;
  recoverableValueUsd: number;
};

export type TrendDirection = "up" | "down" | "flat";
export type MetricTrend = { direction: TrendDirection; label: string } | null;

export type SalesTrendPoint = {
  bucket: string;
  label: string;
  revenue: number;
  sales: number;
  ticket: number;
};

export type ProductPerformance = {
  product: string;
  revenueBrl: number;
  revenueUsd: number;
  salesBrl: number;
  salesIntl: number;
  salesIntlWithoutRate: number;
  sessions: number;
  checkouts: number;
  conversionRate: number | null;
  ticketBrl: number | null;
  shareBrl: number | null;
};

export type DashboardData = {
  totals: DashboardTotals;
  previous: DashboardTotals | null;
  trend: SalesTrendPoint[];
  granularityLabel: string;
  funnel: { name: string; count: number }[];
  postPurchase: { refunds: number; chargebacks: number };
  campaigns: Row[];
  sites: Row[];
  funnelSteps: Row[];
  latam: Row[];
  products: ProductPerformance[];
  error: string | null;
};

type Built = { clauses: string[]; params: any[] };

const num = (value: any) => (value === null || value === undefined ? 0 : Number(value));

function withClauses(base: Built, clauses: string[]): Built {
  return { clauses: [...base.clauses, ...clauses], params: [...base.params] };
}

function sqlWhere(built: Built): string {
  return built.clauses.length ? `WHERE ${built.clauses.join(" AND ")}` : "";
}

function dimensionsOnly(filters: Filters): Filters {
  return { ...filters, period: "", from: "", to: "" };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Hoje no fuso do negócio, não em UTC.
 *
 * As datas daqui viram from/to do período "custom", e buildWhere as converte
 * de volta para UTC assumindo o fuso de Brasília. Se calculássemos em UTC, das
 * 21h à meia-noite o "período anterior" apontaria para o dia errado.
 */
function hojeNoFusoOperacao(): Date {
  const local = new Date().toLocaleDateString("sv-SE", { timeZone: TIMEZONE_OPERACAO });
  return new Date(`${local}T00:00:00Z`);
}

function previousFilters(filters: Filters): Filters | null {
  const base = dimensionsOnly(filters);
  const today = hojeNoFusoOperacao();

  if (filters.period === "today") {
    const previous = new Date(today);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return { ...base, period: "custom", from: dateOnly(previous), to: dateOnly(previous) };
  }

  const rollingDays = /^([0-9]+)d$/.exec(filters.period);
  if (rollingDays) {
    const days = Number(rollingDays[1]);
    const to = new Date(today);
    to.setUTCDate(to.getUTCDate() - days);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - days + 1);
    return { ...base, period: "custom", from: dateOnly(from), to: dateOnly(to) };
  }

  if (filters.period === "custom" && filters.from && filters.to) {
    const from = new Date(`${filters.from}T00:00:00Z`);
    const to = new Date(`${filters.to}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
    const durationDays = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    const previousTo = new Date(from);
    previousTo.setUTCDate(previousTo.getUTCDate() - 1);
    const previousFrom = new Date(previousTo);
    previousFrom.setUTCDate(previousFrom.getUTCDate() - durationDays + 1);
    return {
      ...base,
      period: "custom",
      from: dateOnly(previousFrom),
      to: dateOnly(previousTo),
    };
  }

  return null;
}

function trendConfig(filters: Filters): { expression: string; label: string } {
  if (filters.period === "today") {
    return { expression: "strftime('%Y-%m-%d %H:00', created_at)", label: "por hora" };
  }

  if (filters.period === "90d") {
    return { expression: "strftime('%Y-W%W', created_at)", label: "por semana" };
  }

  if (filters.period === "custom" && filters.from && filters.to) {
    const from = new Date(`${filters.from}T00:00:00Z`);
    const to = new Date(`${filters.to}T00:00:00Z`);
    const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > 120) return { expression: "strftime('%Y-%m', created_at)", label: "por mês" };
    if (days > 45) return { expression: "strftime('%Y-W%W', created_at)", label: "por semana" };
  }

  return { expression: "date(created_at)", label: "por dia" };
}

async function loadTotals(filters: Filters): Promise<{ totals: DashboardTotals; error: string | null }> {
  const purchasesBase = buildWhere(filters);
  const eventsBase = buildWhere(filters);
  const approvedBrl = withClauses(purchasesBase, [
    "event_name = 'purchase'",
    "COALESCE(currency,'BRL') = 'BRL'",
  ]);
  const approvedAll = withClauses(purchasesBase, ["event_name = 'purchase'"]);
  const eventMetrics = withClauses(eventsBase, [
    "event_name IN ('initiate_checkout','begin_checkout','generate_lead','landing','page_view','view_item','add_to_cart')",
  ]);

  // Todo webhook da plataforma no recorte, sem filtrar por evento: e daqui que
  // saem abandono, recusa, pix e reembolso — o que a plataforma enxerga.
  const plataforma = withClauses(purchasesBase, []);

  const [sales, events, attribution, platform, recuperaveis] = await Promise.all([
    safeQuery(
      `SELECT COUNT(*) AS purchases,
              COALESCE(SUM(value), 0) AS revenue,
              COALESCE(SUM(CASE WHEN COALESCE(purchase_type,'front') != 'front' THEN value ELSE 0 END), 0) AS incremental_revenue
       FROM purchases ${sqlWhere(approvedBrl)}`,
      approvedBrl.params
    ),
    safeQuery(
      `SELECT COUNT(DISTINCT CASE WHEN session_id IS NOT NULL AND session_id != '' THEN session_id END) AS sessions,
              SUM(CASE WHEN event_name = 'generate_lead' THEN 1 ELSE 0 END) AS leads,
              SUM(CASE WHEN event_name IN ('initiate_checkout','begin_checkout') THEN 1 ELSE 0 END) AS checkouts
       FROM events ${sqlWhere(eventMetrics)}`,
      eventMetrics.params
    ),
    safeQuery(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL
                        OR fbclid IS NOT NULL OR fbc IS NOT NULL OR utm_source IS NOT NULL
                       THEN 1 ELSE 0 END) AS attributed
       FROM purchases ${sqlWhere(approvedAll)}`,
      approvedAll.params
    ),
    safeQuery(
      `SELECT
         SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS compras,
         SUM(CASE WHEN event_name = 'abandoned_checkout' THEN 1 ELSE 0 END) AS abandonos,
         SUM(CASE WHEN event_name = 'payment_refused' THEN 1 ELSE 0 END) AS recusas,
         SUM(CASE WHEN event_name = 'pix_generated' THEN 1 ELSE 0 END) AS pix,
         SUM(CASE WHEN event_name = 'refund' THEN 1 ELSE 0 END) AS reembolsos,
         SUM(CASE WHEN event_name = 'chargeback' THEN 1 ELSE 0 END) AS chargebacks
       FROM purchases ${sqlWhere(plataforma)}`,
      plataforma.params
    ),
    // Abandono com contato = o que da para recuperar hoje. Agrupado por moeda
    // porque somar as moedas daria um numero sem significado nenhum.
    safeQuery(
      `SELECT COALESCE(currency,'BRL') AS moeda, COUNT(*) AS n,
              COALESCE(SUM(value), 0) AS valor
       FROM purchases ${sqlWhere(withClauses(purchasesBase, [
         "event_name = 'abandoned_checkout'",
         "(customer_email IS NOT NULL OR customer_phone IS NOT NULL)",
       ]))}
       GROUP BY moeda`,
      purchasesBase.params
    ),
  ]);

  const purchases = num(sales.rows[0]?.purchases);
  const revenue = num(sales.rows[0]?.revenue);
  const sessions = num(events.rows[0]?.sessions);
  const attributed = num(attribution.rows[0]?.attributed);
  const attributionTotal = num(attribution.rows[0]?.total);
  const incrementalRevenue = num(sales.rows[0]?.incremental_revenue);

  const p = platform.rows[0] || {};
  const comprasPlataforma = num(p.compras);
  const abandoned = num(p.abandonos);
  const refused = num(p.recusas);
  const pixGenerated = num(p.pix);
  const refunds = num(p.reembolsos);
  const chargebacks = num(p.chargebacks);

  // Quem chegou no checkout da plataforma: comprou, abandonou ou teve o
  // pagamento recusado. Sao os tres desfechos que ela nos reporta.
  const platformArrivals = comprasPlataforma + abandoned + refused;

  let recoverable = 0;
  let recoverableValue = 0;
  let recoverableValueUsd = 0;
  for (const row of recuperaveis.rows) {
    const moeda = String(row.moeda);
    recoverable += num(row.n);
    if (moeda === "BRL") recoverableValue += num(row.valor);
    else recoverableValueUsd += toUsd(num(row.valor), moeda) ?? 0;
  }

  // Tentativas de pagamento (exclui abandono): mede a maquininha, nao a pagina.
  const tentativas = comprasPlataforma + refused;

  return {
    totals: {
      revenue,
      purchases,
      ticket: purchases > 0 ? revenue / purchases : 0,
      sessions,
      leads: num(events.rows[0]?.leads),
      checkouts: num(events.rows[0]?.checkouts),
      conversionRate: sessions > 0 ? (purchases / sessions) * 100 : null,
      attributed,
      attributionTotal,
      attributionRate: attributionTotal > 0 ? (attributed / attributionTotal) * 100 : null,
      incrementalRevenue,
      incrementalShare: revenue > 0 ? (incrementalRevenue / revenue) * 100 : null,

      platformPurchases: comprasPlataforma,
      platformArrivals,
      platformConversion:
        platformArrivals > 0 ? (comprasPlataforma / platformArrivals) * 100 : null,
      abandoned,
      refused,
      refusedRate: tentativas > 0 ? (refused / tentativas) * 100 : null,
      pixGenerated,
      // Pix gerado e pix pago sao eventos diferentes; a razao aproxima quantos
      // dos que geraram o codigo chegaram a pagar.
      pixPaidRate:
        pixGenerated > 0 ? Math.min(100, (comprasPlataforma / pixGenerated) * 100) : null,
      refunds,
      chargebacks,
      refundRate:
        comprasPlataforma > 0 ? ((refunds + chargebacks) / comprasPlataforma) * 100 : null,
      revenuePerSession: sessions > 0 ? revenue / sessions : null,
      recoverable,
      recoverableValue,
      recoverableValueUsd,
    },
    error: sales.error || events.error || attribution.error || platform.error,
  };
}

function productRows(vendas: Row[], navegacao: Row[], totalRevenueBrl: number): ProductPerformance[] {
  type Mutable = Omit<ProductPerformance, "conversionRate" | "ticketBrl" | "shareBrl">;
  const map = new Map<string, Mutable>();
  const get = (product: string): Mutable => {
    const current = map.get(product);
    if (current) return current;
    const created: Mutable = {
      product,
      revenueBrl: 0,
      revenueUsd: 0,
      salesBrl: 0,
      salesIntl: 0,
      salesIntlWithoutRate: 0,
      sessions: 0,
      checkouts: 0,
    };
    map.set(product, created);
    return created;
  };

  for (const row of vendas) {
    const item = get(String(row.produto || "(não identificado)"));
    const currency = String(row.moeda || "BRL").toUpperCase();
    const sales = num(row.vendas);
    const revenue = num(row.receita);
    if (currency === "BRL") {
      item.salesBrl += sales;
      item.revenueBrl += revenue;
    } else {
      item.salesIntl += sales;
      const converted = toUsd(revenue, currency);
      if (converted === null) item.salesIntlWithoutRate += sales;
      else item.revenueUsd += converted;
    }
  }

  for (const row of navegacao) {
    const item = get(String(row.produto || "(não identificado)"));
    item.sessions = num(row.sessoes);
    item.checkouts = num(row.checkouts);
  }

  return Array.from(map.values())
    .map((item) => {
      const totalSales = item.salesBrl + item.salesIntl;
      return {
        ...item,
        conversionRate: item.sessions > 0 ? (totalSales / item.sessions) * 100 : null,
        ticketBrl: item.salesBrl > 0 ? item.revenueBrl / item.salesBrl : null,
        shareBrl: totalRevenueBrl > 0 ? (item.revenueBrl / totalRevenueBrl) * 100 : null,
      };
    })
    .sort((a, b) => b.revenueBrl + b.revenueUsd * 5.4 - (a.revenueBrl + a.revenueUsd * 5.4));
}

export function metricTrend(current: number | null, previous: number | null): MetricTrend {
  if (current === null || previous === null || previous === 0) return null;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(change) < 0.05) return { direction: "flat", label: "0% vs. período anterior" };
  return {
    direction: change > 0 ? "up" : "down",
    label: `${Math.abs(change).toFixed(1).replace(".", ",")}% vs. período anterior`,
  };
}

export async function loadDashboard(filters: Filters): Promise<DashboardData> {
  const purchasesBase = buildWhere(filters);
  const eventsBase = buildWhere(filters);
  const approvedBrl = withClauses(purchasesBase, [
    "event_name = 'purchase'",
    "COALESCE(currency,'BRL') = 'BRL'",
  ]);
  const approvedAll = withClauses(purchasesBase, ["event_name = 'purchase'"]);
  const trend = trendConfig(filters);

  const currentResult = await loadTotals(filters);
  const previous = previousFilters(filters);

  const [previousResult, funnelResult, postResult, campaignsResult, sitesResult, stepsResult, latamResult, trendResult, productSalesResult, productEventsResult] = await Promise.all([
    previous ? loadTotals(previous) : Promise.resolve(null),
    safeQuery(
      `SELECT event_name, COUNT(*) AS total FROM events ${sqlWhere(eventsBase)} GROUP BY event_name`,
      eventsBase.params
    ),
    safeQuery(
      `SELECT
         SUM(CASE WHEN event_name = 'refund' THEN 1 ELSE 0 END) AS refunds,
         SUM(CASE WHEN event_name = 'chargeback' THEN 1 ELSE 0 END) AS chargebacks
       FROM purchases ${sqlWhere(purchasesBase)}`,
      purchasesBase.params
    ),
    safeQuery(
      `SELECT COALESCE(utm_campaign, CASE WHEN gclid IS NOT NULL THEN '(google ads - sem utm)' ELSE '(direto/sem campanha)' END) AS campanha,
              COALESCE(utm_source, CASE WHEN gclid IS NOT NULL THEN 'google' WHEN fbclid IS NOT NULL THEN 'facebook' ELSE '(nenhum)' END) AS origem,
              COUNT(*) AS vendas, COALESCE(SUM(value), 0) AS receita,
              CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(value),0) / COUNT(*) ELSE 0 END AS ticket
       FROM purchases ${sqlWhere(approvedBrl)}
       GROUP BY campanha, origem ORDER BY receita DESC LIMIT 15`,
      approvedBrl.params
    ),
    safeQuery(
      `SELECT COALESCE(hostname, '(não identificado)') AS dominio,
              COUNT(*) AS vendas, COALESCE(SUM(value), 0) AS receita,
              CASE WHEN COUNT(*) > 0 THEN COALESCE(SUM(value),0) / COUNT(*) ELSE 0 END AS ticket
       FROM purchases ${sqlWhere(approvedBrl)}
       GROUP BY dominio ORDER BY receita DESC LIMIT 15`,
      approvedBrl.params
    ),
    safeQuery(
      `SELECT COALESCE(purchase_type, 'front') AS etapa,
              COUNT(*) AS vendas, COALESCE(SUM(value), 0) AS receita
       FROM purchases ${sqlWhere(approvedBrl)} GROUP BY etapa`,
      approvedBrl.params
    ),
    safeQuery(
      `SELECT COALESCE(currency,'BRL') AS moeda, COUNT(*) AS vendas,
              COALESCE(SUM(value), 0) AS receita
       FROM purchases ${sqlWhere(withClauses(approvedAll, ["COALESCE(currency,'BRL') != 'BRL'"]))}
       GROUP BY moeda ORDER BY vendas DESC`,
      approvedAll.params
    ),
    safeQuery(
      `SELECT ${trend.expression} AS bucket, COUNT(*) AS vendas,
              COALESCE(SUM(value), 0) AS receita
       FROM purchases ${sqlWhere(approvedBrl)}
       GROUP BY bucket ORDER BY bucket ASC`,
      approvedBrl.params
    ),
    safeQuery(
      `SELECT COALESCE(product_name,'(não identificado)') AS produto,
              COALESCE(currency,'BRL') AS moeda,
              COUNT(*) AS vendas, COALESCE(SUM(value), 0) AS receita
       FROM purchases ${sqlWhere(approvedAll)}
       GROUP BY produto, moeda`,
      approvedAll.params
    ),
    safeQuery(
      `SELECT COALESCE(product_name,'(não identificado)') AS produto,
              COUNT(DISTINCT session_id) AS sessoes,
              SUM(CASE WHEN event_name IN ('initiate_checkout','begin_checkout') THEN 1 ELSE 0 END) AS checkouts
       FROM events ${sqlWhere(eventsBase)} GROUP BY produto`,
      eventsBase.params
    ),
  ]);

  const countMap = new Map(funnelResult.rows.map((row) => [String(row.event_name), num(row.total)]));
  const funnel = FUNNEL_EVENTS.filter((name) => countMap.has(name)).map((name) => ({
    name,
    count: countMap.get(name) || 0,
  }));

  const salesTrend = trendResult.rows.map((row) => {
    const sales = num(row.vendas);
    const revenue = num(row.receita);
    const bucket = String(row.bucket);
    let label = bucket;
    if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
      label = new Date(`${bucket}T12:00:00Z`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:00$/.test(bucket)) {
      label = `${bucket.slice(11, 13)}h`;
    }
    return { bucket, label, sales, revenue, ticket: sales > 0 ? revenue / sales : 0 };
  });

  const errors = [
    currentResult.error,
    previousResult?.error,
    funnelResult.error,
    postResult.error,
    campaignsResult.error,
    sitesResult.error,
    stepsResult.error,
    latamResult.error,
    trendResult.error,
    productSalesResult.error,
    productEventsResult.error,
  ].filter(Boolean);

  return {
    totals: currentResult.totals,
    previous: previousResult?.totals || null,
    trend: salesTrend,
    granularityLabel: trend.label,
    funnel,
    postPurchase: {
      refunds: num(postResult.rows[0]?.refunds),
      chargebacks: num(postResult.rows[0]?.chargebacks),
    },
    campaigns: campaignsResult.rows,
    sites: sitesResult.rows,
    funnelSteps: stepsResult.rows,
    latam: latamResult.rows,
    products: productRows(productSalesResult.rows, productEventsResult.rows, currentResult.totals.revenue),
    error: errors[0] ? String(errors[0]) : null,
  };
}
