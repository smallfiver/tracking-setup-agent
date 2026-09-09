/**
 * Cotações fixas para converter vendas internacionais em dólar (USD).
 *
 * >>> PARA ATUALIZAR: mude só os números abaixo e salve. O painel recarrega. <<<
 *
 * O número é "quantas unidades da moeda equivalem a 1 dólar".
 * Exemplos de como ler:
 *   - "1 USD = 4000 COP"  ->  COP: 4000
 *   - "1 USD = 17.2 MXN"  ->  MXN: 17.2
 *
 * Onde conferir a cotação do dia: Google ("1 usd to cop"), XE.com, Wise.
 * Moeda que não estiver nesta lista é ignorada no total (e o painel avisa).
 */
export const UNITS_PER_USD: Record<string, number> = {
  USD: 1,
  MXN: 17.2,   // México
  COP: 4000,   // Colômbia
  CLP: 950,    // Chile
  CRC: 510,    // Costa Rica
  ARS: 1000,   // Argentina (muito volátil — confira antes de decidir)
  PEN: 3.75,   // Peru
  PYG: 7300,   // Paraguai
  UYU: 40,     // Uruguai
  DOP: 60,     // Rep. Dominicana
  PAB: 1,      // Panamá (balboa é 1:1 com o dólar)
  GTQ: 7.7,    // Guatemala
  BOB: 6.9,    // Bolívia
  BRL: 5.4,    // Brasil (caso queira usar em outros cálculos)
};

/** Converte um valor na moeda local para USD. Devolve null se não houver cotação. */
export function toUsd(amount: number, currency: string): number | null {
  const rate = UNITS_PER_USD[String(currency || "").toUpperCase()];
  if (!rate) return null;
  return (amount || 0) / rate;
}

/** Formata um valor em dólar (US$ 1.234,56). */
export function usd(v: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" }).format(v || 0);
}
