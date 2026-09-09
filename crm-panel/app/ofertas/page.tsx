import { safeQuery } from "../../lib/db";
import { parseFilters, buildWhere } from "../../lib/filters";
import { filtersToQuery } from "../../lib/filters";
import { withProductFallback } from "../../lib/productFilter";
import { getProfile } from "../../lib/profiles";
import { toUsd, usd } from "../../lib/fx";
import { parseMercado, comMercado, mercadoSql } from "../../lib/mercado";
import FilterBar from "../FilterBar";
import MarketTabs from "../MarketTabs";
import MiniBar from "../MiniBar";
import { Package, AlertTriangle } from "lucide-react";

export const revalidate = 0;

/** Lê a productList (registro mestre) do perfil ativo. */
function readProductList(): { name: string; match: string[] }[] {
  try {
    const p = getProfile(null) as any;
    const raw = p?.productList;
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.filter((x) => x && x.name) : [];
  } catch {
    return [];
  }
}

/** Uma oferta está "registrada" se casa por nome ou por qualquer padrão de match. */
function isRegistered(oferta: string, products: { name: string; match: string[] }[]): boolean {
  const hay = oferta.toLowerCase();
  return products.some(
    (p) =>
      p.name.toLowerCase() === hay ||
      hay.includes(p.name.toLowerCase()) ||
      (p.match || []).some((m) => m && hay.includes(String(m).toLowerCase()))
  );
}

const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

export default async function OfertasPage({
  searchParams,
}: {
  searchParams: Record<string, string>;
}) {
  const filters = withProductFallback(parseFilters(searchParams));
  const { where, params } = buildWhere(filters);
  const mercado = parseMercado(searchParams);
  const ehLatam = mercado === "latam";

  // A moeda define o mercado; a aba escolhida define o recorte. Nenhuma consulta
  // desta página mistura as duas — cada uma carrega a condição de mercado.
  const whereMercado = comMercado(where, mercado);

  // Uma linha por oferta E por moeda. No Brasil a moeda é sempre BRL e o
  // agrupamento extra não custa nada; no LATAM ele é obrigatório, porque a
  // conversão para dólar precisa saber de qual moeda partiu cada valor.
  const sql = `
    SELECT
      COALESCE(NULLIF(product_name, ''), NULLIF(offer_name, ''), '(sem produto)') AS oferta,
      COALESCE(currency,'BRL') AS moeda,
      SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS vendas,
      SUM(CASE WHEN event_name = 'purchase' THEN COALESCE(value, 0) ELSE 0 END) AS receita,
      SUM(CASE WHEN event_name = 'pix_generated' THEN 1 ELSE 0 END) AS pix,
      SUM(CASE WHEN event_name = 'abandoned_checkout' THEN 1 ELSE 0 END) AS abandono,
      SUM(CASE WHEN event_name = 'purchase' AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL) THEN 1 ELSE 0 END) AS google,
      SUM(CASE WHEN event_name = 'purchase' AND (fbclid IS NOT NULL OR fbc IS NOT NULL) THEN 1 ELSE 0 END) AS meta
    FROM purchases
    ${whereMercado}
    GROUP BY oferta, moeda
  `;

  const { rows, error } = await safeQuery(sql, params);

  // Quantas vendas cada aba tem no recorte atual, para o contador das abas.
  const { rows: porMercado } = await safeQuery(
    `SELECT ${mercadoSql("latam")} AS internacional, COUNT(*) AS vendas
     FROM purchases ${where ? `${where} AND` : "WHERE"} event_name = 'purchase'
     GROUP BY internacional`,
    params
  );
  const contagem = {
    brasil: num(porMercado.find((r) => num(r.internacional) === 0)?.vendas),
    latam: num(porMercado.find((r) => num(r.internacional) === 1)?.vendas),
  };

  const products = readProductList();

  // Junta as moedas de cada oferta num único registro já convertido.
  type Oferta = {
    oferta: string;
    registered: boolean;
    vendas: number;
    receita: number;
    semCotacao: number;
    moedas: Set<string>;
    ticket: number;
    pix: number;
    abandono: number;
    google: number;
    meta: number;
  };

  const porOferta = new Map<string, Oferta>();
  const semCotacaoGeral: string[] = [];

  for (const r of rows) {
    const oferta = String(r.oferta);
    const moeda = String(r.moeda);

    if (!porOferta.has(oferta)) {
      porOferta.set(oferta, {
        oferta,
        registered: oferta === "(sem produto)" ? true : isRegistered(oferta, products),
        vendas: 0,
        receita: 0,
        semCotacao: 0,
        moedas: new Set<string>(),
        ticket: 0,
        pix: 0,
        abandono: 0,
        google: 0,
        meta: 0,
      });
    }
    const o = porOferta.get(oferta)!;

    o.vendas += num(r.vendas);
    o.pix += num(r.pix);
    o.abandono += num(r.abandono);
    o.google += num(r.google);
    o.meta += num(r.meta);
    if (num(r.vendas) > 0) o.moedas.add(moeda);

    if (!ehLatam) {
      o.receita += num(r.receita);
      continue;
    }

    const emDolar = toUsd(num(r.receita), moeda);
    // Sem cotação a venda aparece na contagem, mas não na receita — um total
    // incompleto que se anuncia é melhor do que um total que parece fechado.
    if (emDolar === null) {
      o.semCotacao += num(r.vendas);
      semCotacaoGeral.push(moeda);
    } else {
      o.receita += emDolar;
    }
  }

  const offers = Array.from(porOferta.values())
    .map((o) => {
      // No LATAM o ticket ignora as vendas sem cotação, senão ele sai diluído.
      const base = ehLatam ? o.vendas - o.semCotacao : o.vendas;
      return { ...o, ticket: base > 0 ? o.receita / base : 0 };
    })
    .sort((a, b) => b.receita - a.receita);

  /** Formata na moeda da aba — nunca na outra. */
  const valor = (v: number) => (ehLatam ? usd(v) : money(v));

  // Produtos que vendem mas ainda não estão registrados (sem público próprio).
  const naoRegistrados = offers.filter((o) => !o.registered && o.oferta !== "(sem produto)");

  const totals = offers.reduce(
    (acc, o) => {
      acc.vendas += o.vendas;
      acc.receita += o.receita;
      acc.semCotacao += o.semCotacao;
      return acc;
    },
    { vendas: 0, receita: 0, semCotacao: 0 }
  );
  const totalSemCotacao = totals.semCotacao;
  // O ticket geral usa a mesma base da receita: no LATAM, só o que foi convertido.
  const baseTicket = ehLatam ? totals.vendas - totalSemCotacao : totals.vendas;
  const ticketGeral = baseTicket > 0 ? totals.receita / baseTicket : 0;
  const comVenda = offers.filter((o) => o.vendas > 0).length;

  // O drill-down herda o mercado, senão o clique cairia numa lista com as duas
  // moedas juntas — exatamente o que estas abas existem para evitar.
  const drill = (oferta: string) =>
    `/purchases?${filtersToQuery(filters, {
      product: oferta === "(sem produto)" ? "" : oferta,
    })}&mercado=${mercado}`;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
        <Package size={26} style={{ color: "var(--primary)" }} />
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>Ofertas</h1>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.25rem", fontSize: "0.85rem" }}>
        Resumo por oferta, com métricas isoladas. Cada mercado tem a sua aba e a sua moeda — os
        valores nunca se somam entre elas. Use os filtros para recortar por campanha, plataforma,
        dispositivo ou período.
      </p>

      <MarketTabs searchParams={searchParams} atual={mercado} contagem={contagem} />

      <FilterBar table="purchases" />

      {naoRegistrados.length > 0 && (
        <div
          className="card"
          style={{ borderColor: "var(--warning)", marginBottom: "1.5rem", display: "flex", gap: "0.75rem", alignItems: "flex-start" }}
        >
          <AlertTriangle size={20} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {naoRegistrados.length} produto(s) vendendo sem registro
            </div>
            <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
              Estes produtos têm venda mas <strong>não estão na sua lista de produtos</strong>, então
              não têm público próprio no GA4 nem separação por etapa:{" "}
              <strong>{naoRegistrados.map((o) => o.oferta).join(", ")}</strong>. Cadastre-os em
              Configurações → Order Bump / produtos, e rode o setup + o script de públicos.
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)", marginBottom: "1.5rem" }}>
          <div style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{error}</div>
        </div>
      )}

      <div className="card-grid">
        <div className="card">
          <div className="card-title">
            {ehLatam ? "Receita USD (filtrada)" : "Receita BRL (filtrada)"}
          </div>
          <div
            className="card-value"
            style={{ color: ehLatam ? "var(--warning)" : "var(--success)" }}
          >
            {valor(totals.receita)}
          </div>
        </div>
        <div className="card">
          <div className="card-title">{ehLatam ? "Vendas internacionais" : "Vendas Brasil"}</div>
          <div className="card-value">{totals.vendas}</div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
            Ticket médio {valor(ticketGeral)}
          </div>
        </div>
        <div className="card">
          <div className="card-title">Ofertas com venda</div>
          <div className="card-value">{comVenda}</div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
            de {offers.length} no recorte
          </div>
        </div>
      </div>

      {ehLatam && semCotacaoGeral.length > 0 && (
        <div
          className="card"
          style={{ borderColor: "var(--warning)", marginBottom: "1.5rem", fontSize: "0.82rem" }}
        >
          <strong style={{ color: "var(--warning)" }}>{totalSemCotacao} venda(s) fora do total</strong>{" "}
          — moedas sem cotação em <code>crm-panel/lib/fx.ts</code>:{" "}
          {Array.from(new Set(semCotacaoGeral)).join(", ")}. Elas aparecem na contagem de vendas,
          mas não na receita em dólar.
        </div>
      )}

      <div className="table-container">
        <div className="table-header">
          <h2>
            Por oferta{" "}
            <span style={{ fontSize: "0.8rem", fontWeight: 400, color: "var(--text-muted)" }}>
              · {ehLatam ? "receita em USD" : "receita em BRL"}
            </span>
          </h2>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Oferta</th>
                <th>Config</th>
                {ehLatam && <th>Moedas</th>}
                <th>Vendas</th>
                <th>Receita</th>
                <th>Ticket</th>
                <th>Pix gerado</th>
                <th>Abandono</th>
                <th>Google</th>
                <th>Meta</th>
              </tr>
            </thead>
            <tbody>
              {offers.length === 0 ? (
                <tr>
                  <td colSpan={ehLatam ? 10 : 9} style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
                    Nenhuma venda {ehLatam ? "internacional" : "em reais"} no recorte selecionado.
                  </td>
                </tr>
              ) : (
                (() => {
                  const maxReceita = Math.max(...offers.map((r: any) => Number(r.receita) || 0), 1);
                  return offers.map((o, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>
                      <a href={drill(o.oferta)} style={{ color: "var(--primary)" }}>
                        {o.oferta}
                      </a>
                    </td>
                    <td>
                      {o.oferta === "(sem produto)" ? (
                        <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>—</span>
                      ) : o.registered ? (
                        <span className="badge" style={{ background: "rgba(16,185,129,0.14)", color: "var(--success)" }}>
                          registrado
                        </span>
                      ) : (
                        <span className="badge" style={{ background: "rgba(245,158,11,0.16)", color: "var(--warning)" }}>
                          não registrado
                        </span>
                      )}
                    </td>
                    {ehLatam && (
                      <td style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                        {Array.from(o.moedas).sort().join(", ") || "—"}
                      </td>
                    )}
                    <td>
                      {o.vendas}
                      {o.semCotacao > 0 && (
                        <div style={{ fontSize: "0.68rem", color: "var(--warning)" }}>
                          {o.semCotacao} sem cotação
                        </div>
                      )}
                    </td>
                    <td style={{ fontWeight: 600, color: ehLatam ? "var(--warning)" : "var(--success)" }}>
                      <div className="mini-bar-cell">
                        <span style={{ whiteSpace: "nowrap" }}>{valor(o.receita)}</span>
                        <MiniBar
                          value={Number(o.receita) || 0}
                          max={maxReceita}
                          color={ehLatam ? "var(--warning)" : "var(--success)"}
                        />
                      </div>
                    </td>
                    <td>{valor(o.ticket)}</td>
                    <td>{o.pix}</td>
                    <td>{o.abandono}</td>
                    <td>
                      <span style={{ color: "#4285f4" }}>{o.google}</span>
                      <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>
                        {" "}
                        ({pct(o.google, o.vendas)}%)
                      </span>
                    </td>
                    <td>
                      <span style={{ color: "#0866ff" }}>{o.meta}</span>
                      <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>
                        {" "}
                        ({pct(o.meta, o.vendas)}%)
                      </span>
                    </td>
                  </tr>
                  ));
                })()
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
