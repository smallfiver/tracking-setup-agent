import {
  BadgeDollarSign,
  CircleDollarSign,
  Globe2,
  Layers3,
  MousePointerClick,
  ReceiptText,
  ShoppingCart,
  Target,
  CreditCard,
  XCircle,
  ShoppingBag,
  QrCode,
  Undo2,
  Coins,
} from "lucide-react";
import { getProfile } from "../lib/profiles";
import { toUsd, usd } from "../lib/fx";
import { parseFilters, PERIOD_LABELS } from "../lib/filters";
import { withProductFallback } from "../lib/productFilter";
import { loadDashboard, metricTrend } from "../lib/dashboard";
import FilterBar from "./FilterBar";
import FunnelChart from "./FunnelChart";
import KpiCard from "./KpiCard";
import MiniBar from "./MiniBar";
import ProductPerformanceTable from "./ProductPerformanceTable";
import VslRetention from "./VslRetention";
import DatabaseUsageAlert from "./DatabaseUsageAlert";
import SalesTrendChart from "./SalesTrendChart";

export const revalidate = 0;

const num = (value: any) => (value === null || value === undefined ? 0 : Number(value));
const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
const percent = (value: number | null, digits = 1) =>
  value === null ? "—" : `${value.toFixed(digits).replace(".", ",")}%`;

const FUNNEL_LABELS: Record<string, string> = {
  // A visita muda de nome conforme a configuração: com trackPageViews ligado o
  // snippet grava "page_view" a cada página; desligado (padrão), grava
  // "landing" uma vez por sessão. Sem os dois aqui, o funil perde a primeira
  // etapa quando a configuração muda.
  landing: "Visitas",
  page_view: "Visitas",
  view_item: "Viu produto",
  add_to_cart: "Adicionou ao carrinho",
  initiate_checkout: "Iniciou checkout",
  begin_checkout: "Começou checkout",
  add_payment_info: "Adicionou pagamento",
  generate_lead: "Leads",
  pix_generated: "Pix gerado",
  boleto_generated: "Boleto gerado",
  abandoned_checkout: "Checkout abandonado",
  purchase: "Compras",
};

const FUNNEL_STEP_META: Record<string, { label: string; color: string }> = {
  front: { label: "Produto principal", color: "var(--series-1)" },
  order_bump: { label: "Order bump", color: "var(--series-2)" },
  upsell: { label: "Upsell", color: "var(--series-3)" },
  downsell: { label: "Downsell", color: "var(--series-4)" },
};
const FUNNEL_STEP_ORDER = ["front", "order_bump", "upsell", "downsell"];

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const filters = withProductFallback(parseFilters(searchParams));
  const profile = getProfile(null);
  const data = await loadDashboard(filters);
  const { totals, previous } = data;

  const periodLabel = PERIOD_LABELS[filters.period] || "Período personalizado";
  const customPeriod = filters.period === "custom"
    ? [filters.from, filters.to].filter(Boolean).join(" a ") || "datas em aberto"
    : "";
  const filterSummary = [
    filters.product || "Todos os produtos",
    customPeriod || periodLabel,
    filters.campaign || null,
  ].filter(Boolean).join(" · ");

  let latamUsd = 0;
  let latamSales = 0;
  let latamConverted = 0;
  const withoutRate: string[] = [];
  for (const row of data.latam) {
    const currency = String(row.moeda);
    const sales = num(row.vendas);
    latamSales += sales;
    const converted = toUsd(num(row.receita), currency);
    if (converted === null) withoutRate.push(currency);
    else {
      latamUsd += converted;
      latamConverted += sales;
    }
  }

  const bestProduct = data.products[0] || null;
  const bestCampaign = data.campaigns[0] || null;
  const funnelDrops = data.funnel.slice(1).map((step, index) => {
    const previousStep = data.funnel[index];
    const drop = previousStep.count > 0 ? ((previousStep.count - step.count) / previousStep.count) * 100 : 0;
    return { from: previousStep, to: step, drop };
  }).filter((item) => item.drop > 0);
  const biggestDrop = funnelDrops.sort((a, b) => b.drop - a.drop)[0] || null;

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">Performance comercial</span>
          <h1>Dashboard</h1>
          <p>{filterSummary}{profile?.name ? ` · ${profile.name}` : ""}</p>
        </div>
        <div className="dashboard-status" aria-label="Dados atualizados em tempo real">
          <span className="status-dot ok pulse" />
          Dados do D1 em tempo real
        </div>
      </header>

      <FilterBar table="purchases" dashboard />

      <DatabaseUsageAlert />

      {data.error && (
        <div className="card dashboard-error" role="alert">
          <strong>Não foi possível carregar todos os dados do D1.</strong>
          <code>{data.error}</code>
          <span>Confira o perfil ativo e a permissão Account &gt; D1 &gt; Edit.</span>
        </div>
      )}

      <section aria-labelledby="kpi-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Indicadores do recorte</span>
            <h2 id="kpi-title">Saúde da operação</h2>
          </div>
          {previous && <span className="section-note">comparado ao período anterior equivalente</span>}
        </div>
        <div className="dashboard-kpi-grid">
          <KpiCard
            icon={<CircleDollarSign size={18} />}
            tone="success"
            label="Receita aprovada BRL"
            value={money(totals.revenue)}
            hint="Somente compras aprovadas em reais"
            trend={metricTrend(totals.revenue, previous?.revenue ?? null) || undefined}
          />
          <KpiCard
            icon={<ShoppingCart size={18} />}
            tone="primary"
            label="Vendas aprovadas"
            value={totals.purchases.toLocaleString("pt-BR")}
            hint={`${totals.checkouts.toLocaleString("pt-BR")} checkouts registrados`}
            trend={metricTrend(totals.purchases, previous?.purchases ?? null) || undefined}
          />
          <KpiCard
            icon={<ReceiptText size={18} />}
            tone="info"
            label="Ticket médio"
            value={money(totals.ticket)}
            hint="Receita BRL ÷ vendas aprovadas"
            trend={metricTrend(totals.ticket, previous?.ticket ?? null) || undefined}
          />
          <KpiCard
            icon={<MousePointerClick size={18} />}
            tone={totals.conversionRate !== null && totals.conversionRate >= 1 ? "success" : "warning"}
            label="Conversão sessão → compra"
            value={percent(totals.conversionRate, 2)}
            hint={totals.sessions > 0 ? `${totals.sessions.toLocaleString("pt-BR")} sessões identificadas` : "Sem sessão identificada no recorte"}
            trend={metricTrend(totals.conversionRate, previous?.conversionRate ?? null) || undefined}
          />
          <KpiCard
            icon={<Layers3 size={18} />}
            tone="warning"
            label="Receita incremental"
            value={money(totals.incrementalRevenue)}
            hint={`${percent(totals.incrementalShare)} da receita em bumps, upsells e downsells`}
            trend={metricTrend(totals.incrementalRevenue, previous?.incrementalRevenue ?? null) || undefined}
          />
          <KpiCard
            icon={<Target size={18} />}
            tone={totals.attributionRate !== null && totals.attributionRate >= 70 ? "success" : "warning"}
            label="Vendas com atribuição"
            value={percent(totals.attributionRate, 0)}
            hint={`${totals.attributed} de ${totals.attributionTotal} com click ID ou UTM`}
            trend={metricTrend(totals.attributionRate, previous?.attributionRate ?? null) || undefined}
          />
        </div>
      </section>

      {/* A plataforma de pagamento responde outra pergunta que o site: nao "o
          anuncio trouxe gente certa", mas "o checkout converte quem chega nele".
          Separado em bloco proprio para as duas taxas nunca serem confundidas. */}
      <section aria-labelledby="plataforma-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Depois do clique</span>
            <h2 id="plataforma-title">Checkout da plataforma</h2>
          </div>
          <span className="section-note">
            {totals.platformArrivals.toLocaleString("pt-BR")} pessoas entraram no checkout no recorte
          </span>
        </div>
        <div className="dashboard-kpi-grid">
          <KpiCard
            icon={<CreditCard size={18} />}
            tone={
              totals.platformConversion !== null && totals.platformConversion >= 30
                ? "success"
                : totals.platformConversion !== null && totals.platformConversion >= 15
                ? "warning"
                : "danger"
            }
            label="Conversão da plataforma"
            value={percent(totals.platformConversion, 1)}
            hint={`${totals.platformPurchases.toLocaleString("pt-BR")} pagas de ${totals.platformArrivals.toLocaleString("pt-BR")} que entraram no checkout (todas as moedas)`}
            trend={metricTrend(totals.platformConversion, previous?.platformConversion ?? null) || undefined}
          />
          <KpiCard
            icon={<XCircle size={18} />}
            tone={totals.refusedRate !== null && totals.refusedRate >= 20 ? "danger" : "neutral"}
            label="Pagamento recusado"
            value={percent(totals.refusedRate, 1)}
            hint={`${totals.refused.toLocaleString("pt-BR")} recusas — cartão sem saldo, bloqueado ou não autorizado`}
            trend={metricTrend(totals.refusedRate, previous?.refusedRate ?? null) || undefined}
          />
          <KpiCard
            icon={<ShoppingBag size={18} />}
            tone="warning"
            label="Carrinho recuperável"
            value={
              totals.recoverableValue > 0
                ? money(totals.recoverableValue)
                : usd(totals.recoverableValueUsd)
            }
            hint={
              <>
                {totals.recoverable.toLocaleString("pt-BR")} abandonos com e-mail ou telefone
                {totals.recoverableValue > 0 && totals.recoverableValueUsd > 0 && (
                  <> · + {usd(totals.recoverableValueUsd)} internacional</>
                )}
              </>
            }
          />
          <KpiCard
            icon={<QrCode size={18} />}
            tone="info"
            label="Pix gerado"
            value={totals.pixGenerated.toLocaleString("pt-BR")}
            hint={
              totals.pixPaidRate !== null
                ? `${percent(totals.pixPaidRate, 0)} viraram pagamento`
                : "nenhum pix no recorte"
            }
          />
          <KpiCard
            icon={<Undo2 size={18} />}
            tone={totals.refundRate !== null && totals.refundRate >= 5 ? "danger" : "neutral"}
            label="Reembolso + chargeback"
            value={percent(totals.refundRate, 1)}
            hint={`${totals.refunds} reembolso(s) e ${totals.chargebacks} chargeback(s)`}
          />
          <KpiCard
            icon={<Coins size={18} />}
            tone="primary"
            label="Receita por sessão"
            value={
              // Produto que so vende em moeda estrangeira tem receita BRL zero;
              // mostrar "R$ 0,00" pareceria erro de calculo.
              totals.revenue === 0 && latamSales > 0
                ? "—"
                : totals.revenuePerSession === null
                ? "—"
                : money(totals.revenuePerSession)
            }
            hint={
              totals.revenue === 0 && latamSales > 0
                ? "receita deste recorte é internacional — ver bloco em USD"
                : "quanto cada visita vale — o teto do seu CPC"
            }
            trend={metricTrend(totals.revenuePerSession, previous?.revenuePerSession ?? null) || undefined}
          />
        </div>
      </section>

      <div className="dashboard-main-grid">
        <section className="analytics-card analytics-card-wide" aria-label="Evolução temporal">
          <SalesTrendChart data={data.trend} granularity={data.granularityLabel} />
        </section>

        <aside className="analytics-card business-readings" aria-labelledby="readings-title">
          <div className="analytics-card-head">
            <div>
              <span className="eyebrow">Leitura executiva</span>
              <h2 id="readings-title">O que merece atenção</h2>
            </div>
          </div>
          <div className="reading-list">
            {bestProduct ? (
              <div className="reading-item">
                <BadgeDollarSign size={18} aria-hidden="true" />
                <div><strong>{bestProduct.product}</strong><span>lidera por peso de receita, com {money(bestProduct.revenueBrl)} em BRL{bestProduct.revenueUsd > 0 ? ` e ${usd(bestProduct.revenueUsd)} internacional` : ""}.</span></div>
              </div>
            ) : <div className="reading-empty">Ainda não há produto com venda no recorte.</div>}
            {bestCampaign && (
              <div className="reading-item">
                <Target size={18} aria-hidden="true" />
                <div><strong>{String(bestCampaign.campanha)}</strong><span>é a campanha com maior receita: {money(num(bestCampaign.receita))}.</span></div>
              </div>
            )}
            {biggestDrop && (
              <div className="reading-item warning">
                <MousePointerClick size={18} aria-hidden="true" />
                <div><strong>Maior gargalo: {FUNNEL_LABELS[biggestDrop.from.name]} → {FUNNEL_LABELS[biggestDrop.to.name]}</strong><span>{biggestDrop.drop.toFixed(0)}% não avançaram entre essas etapas.</span></div>
              </div>
            )}
            {totals.incrementalShare !== null && (
              <div className="reading-item">
                <Layers3 size={18} aria-hidden="true" />
                <div><strong>{percent(totals.incrementalShare)} de receita incremental</strong><span>veio de order bumps, upsells e downsells.</span></div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <section className="analytics-card product-section" aria-labelledby="products-title">
        <div className="analytics-card-head">
          <div>
            <span className="eyebrow">Portfólio</span>
            <h2 id="products-title">Performance por produto</h2>
          </div>
          <span className="section-note">{data.products.length} produto{data.products.length === 1 ? "" : "s"} · clique nos títulos para ordenar</span>
        </div>
        <ProductPerformanceTable products={data.products} filters={filters} />
      </section>

      <VslRetention filters={filters} />

      <div className="dashboard-detail-grid">
        <section className="analytics-card" aria-labelledby="funnel-title">
          <div className="analytics-card-head">
            <div>
              <span className="eyebrow">Jornada</span>
              <h2 id="funnel-title">Funil de conversão</h2>
            </div>
          </div>
          <FunnelChart steps={data.funnel.map((step) => ({ ...step, label: FUNNEL_LABELS[step.name] || step.name }))} />
          {(data.postPurchase.refunds > 0 || data.postPurchase.chargebacks > 0) && (
            <div className="post-purchase-metrics">
              <span><strong>{data.postPurchase.refunds}</strong> reembolsos</span>
              <span><strong>{data.postPurchase.chargebacks}</strong> chargebacks</span>
            </div>
          )}
        </section>

        <section className="analytics-card" aria-labelledby="steps-title">
          <div className="analytics-card-head">
            <div>
              <span className="eyebrow">Monetização</span>
              <h2 id="steps-title">Receita por etapa</h2>
            </div>
            <span className="section-note">BRL</span>
          </div>
          <div className="funnel-revenue-list">
            {FUNNEL_STEP_ORDER.filter((key) => data.funnelSteps.some((row) => String(row.etapa) === key))
              .concat(data.funnelSteps.map((row) => String(row.etapa)).filter((key) => !FUNNEL_STEP_ORDER.includes(key)))
              .map((key) => {
                const row = data.funnelSteps.find((item) => String(item.etapa) === key);
                const meta = FUNNEL_STEP_META[key] || { label: key, color: "var(--text-muted)" };
                const revenue = num(row?.receita);
                const share = totals.revenue > 0 ? (revenue / totals.revenue) * 100 : 0;
                return (
                  <div className="funnel-revenue-row" key={key}>
                    <span className="series-swatch" style={{ background: meta.color }} />
                    <div><strong>{meta.label}</strong><small>{num(row?.vendas)} vendas · {percent(share)}</small></div>
                    <b>{money(revenue)}</b>
                  </div>
                );
              })}
            {data.funnelSteps.length === 0 && <div className="table-empty">Nenhuma venda aprovada no período.</div>}
          </div>
        </section>
      </div>

      {latamSales > 0 && (
        <section className="analytics-card latam-card" aria-labelledby="latam-title">
          <div className="analytics-card-head">
            <div>
              <span className="eyebrow">Mercado internacional</span>
              <h2 id="latam-title"><Globe2 size={18} aria-hidden="true" /> Vendas LATAM</h2>
            </div>
            <strong>{usd(latamUsd)}</strong>
          </div>
          <p>{latamConverted} de {latamSales} vendas convertidas em dólar. Esses valores não entram na Receita aprovada BRL.</p>
          {withoutRate.length > 0 && <span className="warning-note">Sem cotação em `lib/fx.ts`: {Array.from(new Set(withoutRate)).join(", ")}.</span>}
        </section>
      )}

      <div className="dashboard-table-grid">
        <BusinessTable
          title="Receita por campanha"
          eyebrow="Aquisição"
          rows={data.campaigns}
          nameKey="campanha"
          secondaryKey="origem"
          totalRevenue={totals.revenue}
        />
        <BusinessTable
          title="Receita por domínio"
          eyebrow="Landing pages"
          rows={data.sites}
          nameKey="dominio"
          totalRevenue={totals.revenue}
        />
      </div>
    </div>
  );
}

function BusinessTable({
  title,
  eyebrow,
  rows,
  nameKey,
  secondaryKey,
  totalRevenue,
}: {
  title: string;
  eyebrow: string;
  rows: any[];
  nameKey: string;
  secondaryKey?: string;
  totalRevenue: number;
}) {
  const maxRevenue = Math.max(...rows.map((row) => num(row.receita)), 1);
  return (
    <section className="analytics-card" aria-label={title}>
      <div className="analytics-card-head">
        <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Nome</th><th>Vendas</th><th>Ticket</th><th>Receita</th><th>% total</th></tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="table-empty">Nenhuma venda no recorte.</td></tr>
            ) : rows.map((row, index) => (
              <tr key={`${String(row[nameKey])}-${index}`}>
                <td><strong>{String(row[nameKey])}</strong>{secondaryKey && <small className="cell-note">{String(row[secondaryKey])}</small>}</td>
                <td>{num(row.vendas)}</td>
                <td>{money(num(row.ticket))}</td>
                <td><div className="mini-bar-cell"><span>{money(num(row.receita))}</span><MiniBar value={num(row.receita)} max={maxRevenue} color="var(--series-1)" /></div></td>
                <td>{totalRevenue > 0 ? percent((num(row.receita) / totalRevenue) * 100) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
