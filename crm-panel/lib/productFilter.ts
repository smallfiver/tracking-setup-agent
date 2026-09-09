import { cookies } from "next/headers";
import type { Filters } from "./filters";

const COOKIE = "tracking_produto";
/** Precisa bater com o ALL de FilterControls.tsx. */
const ALL_SENTINEL = "__todos__";

/** Produto selecionado no seletor global da sidebar, ou null (todos os produtos). */
export function getSelectedProduct(): string | null {
  return cookies().get(COOKIE)?.value || null;
}

/**
 * Aplica o produto do seletor global como padrão quando a URL não escolheu
 * nenhum (?product= sempre vence). Chame isso em cada page.tsx logo depois de
 * parseFilters — nunca dentro de lib/filters.ts, que é importado por
 * componentes client e não pode puxar next/headers.
 */
export function withProductFallback(filters: Filters): Filters {
  // "Todos os produtos" escolhido explicitamente na tela vence o cookie —
  // sem isso, dava pra nunca sair do produto fixado na sidebar.
  if (filters.product === ALL_SENTINEL) return { ...filters, product: "" };
  if (filters.product) return filters;
  const selected = getSelectedProduct();
  return selected ? { ...filters, product: selected } : filters;
}
