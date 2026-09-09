import { NextResponse } from "next/server";
import { safeQuery } from "../../../lib/db";
import { getProfile } from "../../../lib/profiles";

export const dynamic = "force-dynamic";

/**
 * Visao "1 produto = 1 propriedade GA4 + 1 container GTM": junta o mapa
 * gravado no perfil (productGa4Properties / productGtmContainers) com o
 * dominio real de cada produto (do banco) e confere ao vivo, buscando o HTML
 * da pagina, se o GTM instalado la e o certo.
 */

/** Plataformas de checkout: nunca recebem o nosso GTM, so a landing recebe. */
const CHECKOUT_HOST_RE =
  /(kirvano|kiwify|hotmart|monetizze|braip|eduzz|perfectpay|centerpag|cartpanda|ticto|greenn|lastlink|pepper|payt|appmax|yampi|doppus|mercadopago|pagseguro|stripe)\./i;

type DomainStatus = "migrado" | "outro_produto" | "pendente" | "nao_verificavel";

type DomainCheck = {
  hostname: string;
  events: number;
  status: DomainStatus;
  foundIds: string[];
  /** Quando o GTM encontrado e de outro produto nosso, qual e esse produto. */
  ownerProduct: string | null;
};

async function checkDomain(
  hostname: string,
  expectedContainerId: string | null,
  containerOwner: Map<string, string>
): Promise<Omit<DomainCheck, "hostname" | "events">> {
  try {
    const res = await fetch(`https://${hostname}`, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    const html = await res.text();
    const foundIds = Array.from(
      new Set(Array.from(html.matchAll(/GTM-[A-Z0-9]+/g)).map((m) => m[0]))
    );

    if (!foundIds.length) return { status: "nao_verificavel", foundIds: [], ownerProduct: null };
    if (expectedContainerId && foundIds.includes(expectedContainerId)) {
      return { status: "migrado", foundIds, ownerProduct: null };
    }

    // O GTM instalado e de outro produto nosso? Entao a pagina esta certa —
    // ela so pertence aquele outro produto (dominio compartilhado / evento
    // historico atribuido errado antes de a lista de produtos ser corrigida).
    const owner = foundIds.map((id) => containerOwner.get(id)).find(Boolean);
    if (owner) return { status: "outro_produto", foundIds, ownerProduct: owner };

    return { status: "pendente", foundIds, ownerProduct: null };
  } catch {
    return { status: "nao_verificavel", foundIds: [], ownerProduct: null };
  }
}

export async function GET() {
  const profile = getProfile(null);
  if (!profile) {
    return NextResponse.json({ products: [], sharedDomains: [], summary: null, error: "Nenhum perfil configurado." });
  }

  let ga4Properties: any[] = [];
  let gtmContainers: any[] = [];
  try {
    ga4Properties = JSON.parse(profile.productGa4Properties || "[]");
    gtmContainers = JSON.parse(profile.productGtmContainers || "[]");
  } catch {
    return NextResponse.json({
      products: [],
      sharedDomains: [],
      summary: null,
      error: "productGa4Properties/productGtmContainers invalido no perfil.",
    });
  }

  if (!ga4Properties.length) {
    return NextResponse.json({
      products: [],
      sharedDomains: [],
      summary: null,
      error: "Nenhuma propriedade GA4 por produto ainda — rode a Fase 1 (propriedades-por-produto.mjs).",
    });
  }

  // container GTM -> produto dono, para reconhecer um container nosso instalado
  // numa pagina que historicamente aparecia sob outro produto.
  const containerOwner = new Map<string, string>();
  for (const c of gtmContainers) if (c.containerId) containerOwner.set(c.containerId, c.product);

  // Dominio(s) reais de cada produto, pelos ultimos 30 dias de eventos.
  const domainRows: Record<string, { hostname: string; n: number }[]> = {};
  for (const item of ga4Properties) {
    const { rows } = await safeQuery(
      `SELECT hostname, COUNT(*) AS n FROM events
       WHERE product_name = ? AND hostname IS NOT NULL AND created_at >= datetime('now', '-30 days')
       GROUP BY hostname ORDER BY n DESC LIMIT 6`,
      [item.product]
    );
    domainRows[item.product] = rows
      .map((r) => ({ hostname: String(r.hostname), n: Number(r.n) }))
      // Checkout nao carrega o nosso GTM — listar aqui so gera ruido.
      .filter((d) => !CHECKOUT_HOST_RE.test(d.hostname));
  }

  const domainOwners = new Map<string, string[]>();
  for (const [product, doms] of Object.entries(domainRows)) {
    for (const d of doms) {
      domainOwners.set(d.hostname, [...(domainOwners.get(d.hostname) || []), product]);
    }
  }
  const sharedDomains = Array.from(domainOwners.entries())
    .filter(([, products]) => new Set(products).size > 1)
    .map(([hostname, products]) => ({ hostname, products: Array.from(new Set(products)) }));

  const products = await Promise.all(
    ga4Properties.map(async (item) => {
      const container = gtmContainers.find((c) => c.product === item.product);
      const doms = (domainRows[item.product] || []).slice(0, 3);

      const checks: DomainCheck[] = await Promise.all(
        doms.map(async (d) => {
          const r = await checkDomain(d.hostname, container?.containerId || null, containerOwner);
          return { hostname: d.hostname, events: d.n, ...r };
        })
      );

      return {
        product: item.product,
        measurementId: item.measurementId,
        containerId: container?.containerId || null,
        domains: checks,
        semDominioConhecido: doms.length === 0,
      };
    })
  );

  // Resumo da migracao: cada dominio distinto conta uma vez.
  const seen = new Set<string>();
  let ok = 0;
  let pendente = 0;
  let naoVerificavel = 0;
  for (const p of products) {
    for (const d of p.domains) {
      if (seen.has(d.hostname)) continue;
      seen.add(d.hostname);
      if (d.status === "migrado" || d.status === "outro_produto") ok++;
      else if (d.status === "pendente") pendente++;
      else naoVerificavel++;
    }
  }

  return NextResponse.json({
    products,
    sharedDomains,
    summary: { total: seen.size, ok, pendente, naoVerificavel },
    error: null,
  });
}
