/**
 * Separação por mercado: Brasil (BRL) e LATAM (moeda estrangeira).
 *
 * A regra é uma só e mora aqui: mercado é definido pela MOEDA da venda, não
 * pelo país do comprador nem pelo domínio da landing. Um brasileiro que compra
 * em dólar entra em LATAM — porque o que não pode acontecer é somar 19,90 USD
 * com 197,00 BRL como se fossem a mesma coisa.
 *
 * Venda antiga sem moeda gravada conta como BRL (COALESCE), para nenhuma linha
 * ficar fora dos dois recortes nem aparecer nos dois.
 */

export type Mercado = "brasil" | "latam";

export const MERCADOS: { id: Mercado; label: string; sufixo: string }[] = [
  { id: "brasil", label: "Brasil", sufixo: "receita em R$ (BRL)" },
  { id: "latam", label: "LATAM", sufixo: "receita em US$ (USD)" },
];

export function parseMercado(searchParams: Record<string, string>): Mercado {
  return String(searchParams?.mercado || "").toLowerCase() === "latam" ? "latam" : "brasil";
}

/** Condição SQL que isola o mercado. Sempre usada sobre a tabela purchases. */
export function mercadoSql(mercado: Mercado): string {
  return mercado === "latam"
    ? "COALESCE(currency,'BRL') != 'BRL'"
    : "COALESCE(currency,'BRL') = 'BRL'";
}

/** Junta a condição de mercado a um WHERE que já pode existir. */
export function comMercado(where: string, mercado: Mercado): string {
  const cond = mercadoSql(mercado);
  return where ? `${where} AND ${cond}` : `WHERE ${cond}`;
}

/** Mantém os filtros atuais e troca só o mercado. */
export function hrefMercado(
  searchParams: Record<string, string>,
  mercado: Mercado
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams || {})) {
    if (k !== "mercado" && v) qs.set(k, String(v));
  }
  qs.set("mercado", mercado);
  return `?${qs.toString()}`;
}
