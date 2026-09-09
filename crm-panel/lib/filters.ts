/**
 * Filtros avançados compartilhados.
 *
 * Uma fonte única de verdade para montar o WHERE a partir dos parâmetros de URL,
 * usada por todas as telas (Compras, Eventos, Ofertas) e pelo export de CSV.
 * Assim o que você vê na tela é exatamente o que sai no CSV.
 *
 * As colunas usadas aqui existem tanto em `events` quanto em `purchases`
 * (product_name, utm_campaign, click IDs, device_type, hostname, created_at),
 * então o mesmo construtor serve para as duas tabelas.
 */

export type Filters = {
  site: string;
  product: string;
  campaign: string;
  platform: string; // '', 'google', 'meta', 'other'
  device: string; // '', 'mobile', 'desktop', 'tablet'
  period: string; // '', 'today', '7d', '30d', '90d', 'custom'
  from: string; // YYYY-MM-DD (quando period = custom)
  to: string; // YYYY-MM-DD
};

export const EMPTY_FILTERS: Filters = {
  site: "",
  product: "",
  campaign: "",
  platform: "",
  device: "",
  period: "",
  from: "",
  to: "",
};

export const PERIOD_LABELS: Record<string, string> = {
  "": "Todo o período",
  today: "Hoje",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  "90d": "Últimos 90 dias",
  custom: "Período personalizado",
};

export const PLATFORM_LABELS: Record<string, string> = {
  "": "Todas as plataformas",
  google: "Google",
  meta: "Meta / Facebook",
  other: "Outras / direto",
};

type RawParams = Record<string, string | string[] | undefined> | URLSearchParams;

/**
 * Fuso do negócio. O banco grava created_at em UTC, mas "hoje" para quem opera
 * é o dia no horário de Brasília. Sem converter, entre 21h e meia-noite o
 * filtro "Hoje" já pulava para o dia seguinte e mostrava quase nada — e no
 * resto do dia trazia junto as últimas 3 horas de ontem.
 */
export const TIMEZONE_OPERACAO = "America/Sao_Paulo";

/** Minutos que o fuso está à frente do UTC neste instante (Brasília: -180). */
function offsetMinutos(instante: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const parte of fmt.formatToParts(instante)) p[parte.type] = parte.value;
  // "hour" volta como 24 na virada da meia-noite em alguns runtimes.
  const hora = Number(p.hour) % 24;
  const comoUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hora,
    Number(p.minute),
    Number(p.second)
  );
  return (comoUtc - instante.getTime()) / 60000;
}

/** Formata para o texto que o D1 compara com created_at ("YYYY-MM-DD HH:MM:SS"). */
function paraD1(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Meia-noite (no fuso do negócio) de N dias atrás, devolvida em UTC — que é
 * como created_at está gravado.
 */
export function inicioDoDiaUtc(diasAtras = 0, tz = TIMEZONE_OPERACAO): string {
  const agora = new Date();
  const off = offsetMinutos(agora, tz);
  const local = new Date(agora.getTime() + off * 60000);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - diasAtras);
  return paraD1(new Date(local.getTime() - off * 60000));
}

/** Converte uma data escolhida no seletor (YYYY-MM-DD, fuso local) para UTC. */
export function limiteDoDiaUtc(dia: string, fim = false, tz = TIMEZONE_OPERACAO): string {
  const [ano, mes, d] = dia.split("-").map(Number);
  if (!ano || !mes || !d) return fim ? `${dia} 23:59:59` : `${dia} 00:00:00`;
  const provisorio = new Date(Date.UTC(ano, mes - 1, d, fim ? 23 : 0, fim ? 59 : 0, fim ? 59 : 0));
  const off = offsetMinutos(provisorio, tz);
  return paraD1(new Date(provisorio.getTime() - off * 60000));
}

function one(params: RawParams, key: string): string {
  if (params instanceof URLSearchParams) return params.get(key) || "";
  const v = params[key];
  return (Array.isArray(v) ? v[0] : v) || "";
}

/** Lê os filtros dos parâmetros de URL (aceita searchParams de página ou API). */
export function parseFilters(params: RawParams): Filters {
  const f: Filters = {
    site: one(params, "site"),
    product: one(params, "product"),
    campaign: one(params, "campaign"),
    platform: one(params, "platform"),
    device: one(params, "device"),
    period: one(params, "period"),
    from: one(params, "from"),
    to: one(params, "to"),
  };
  // from/to implicam período personalizado.
  if ((f.from || f.to) && f.period !== "custom") f.period = "custom";
  return f;
}

/**
 * Monta o WHERE + params para a query. `alias` prefixa as colunas quando a
 * query usa apelido de tabela (ex.: 'e.').
 */
export function buildWhere(
  filters: Filters,
  opts: { alias?: string } = {}
): { where: string; params: any[]; clauses: string[] } {
  const a = opts.alias ? `${opts.alias}.` : "";
  const clauses: string[] = [];
  const params: any[] = [];

  if (filters.site) {
    clauses.push(`${a}hostname = ?`);
    params.push(filters.site);
  }
  if (filters.product) {
    clauses.push(`${a}product_name = ?`);
    params.push(filters.product);
  }
  if (filters.campaign) {
    clauses.push(`${a}utm_campaign = ?`);
    params.push(filters.campaign);
  }
  if (filters.device) {
    clauses.push(`${a}device_type = ?`);
    params.push(filters.device);
  }

  if (filters.platform === "google") {
    clauses.push(`(${a}gclid IS NOT NULL OR ${a}gbraid IS NOT NULL OR ${a}wbraid IS NOT NULL)`);
  } else if (filters.platform === "meta") {
    clauses.push(`(${a}fbclid IS NOT NULL OR ${a}fbc IS NOT NULL)`);
  } else if (filters.platform === "other") {
    clauses.push(
      `(${a}gclid IS NULL AND ${a}gbraid IS NULL AND ${a}wbraid IS NULL AND ${a}fbclid IS NULL AND ${a}fbc IS NULL)`
    );
  }

  // Período. Todos os limites saem em UTC a partir do fuso do negócio —
  // ver inicioDoDiaUtc/limiteDoDiaUtc.
  if (filters.period === "custom") {
    if (filters.from) {
      clauses.push(`${a}created_at >= ?`);
      params.push(limiteDoDiaUtc(filters.from));
    }
    if (filters.to) {
      clauses.push(`${a}created_at <= ?`);
      params.push(limiteDoDiaUtc(filters.to, true));
    }
  } else if (filters.period === "today") {
    clauses.push(`${a}created_at >= ?`);
    params.push(inicioDoDiaUtc(0));
  } else if (filters.period === "7d" || filters.period === "30d" || filters.period === "90d") {
    const days = Number(filters.period.replace("d", ""));
    clauses.push(`${a}created_at >= ?`);
    params.push(inicioDoDiaUtc(days));
  }

  return {
    where: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
    params,
    clauses,
  };
}

/** Expressão SQL que rotula a plataforma de uma linha (para agrupar/exibir). */
export function platformExpr(alias = ""): string {
  const a = alias ? `${alias}.` : "";
  return `CASE
    WHEN ${a}gclid IS NOT NULL OR ${a}gbraid IS NOT NULL OR ${a}wbraid IS NOT NULL THEN 'google'
    WHEN ${a}fbclid IS NOT NULL OR ${a}fbc IS NOT NULL THEN 'meta'
    ELSE 'other' END`;
}

/** Serializa filtros em query string (só os preenchidos), com override opcional. */
export function filtersToQuery(filters: Partial<Filters>, patch: Partial<Filters> = {}): string {
  const merged = { ...filters, ...patch };
  const parts: string[] = [];
  for (const key of Object.keys(EMPTY_FILTERS) as (keyof Filters)[]) {
    const v = merged[key];
    if (v) parts.push(`${key}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

/* ------------------------------------------------------------------ *
 * Conversões (conversions_log) — colunas próprias: destination, status,
 * event_name, value, created_at. Não tem produto/campanha/dispositivo, então
 * os filtros aqui são outros.
 * ------------------------------------------------------------------ */

export type ConversionFilters = {
  destination: string; // '', 'meta', 'google_ads'
  status: string; // '', 'sent', 'error', 'pending'
  event: string; // '', event_name
  period: string;
  from: string;
  to: string;
};

export const CONV_DESTINATION_LABELS: Record<string, string> = {
  "": "Todos os destinos",
  meta: "Meta CAPI",
  google_ads: "Google Ads",
};

export const CONV_STATUS_LABELS: Record<string, string> = {
  "": "Todos os status",
  sent: "Enviado",
  error: "Erro",
  pending: "Em andamento",
};

/** Cláusula de período (compartilhada com buildWhere). */
function periodClauses(period: string, from: string, to: string, a = ""): { clauses: string[]; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  if (period === "custom") {
    if (from) {
      clauses.push(`${a}created_at >= ?`);
      params.push(limiteDoDiaUtc(from));
    }
    if (to) {
      clauses.push(`${a}created_at <= ?`);
      params.push(limiteDoDiaUtc(to, true));
    }
  } else if (period === "today") {
    clauses.push(`${a}created_at >= ?`);
    params.push(inicioDoDiaUtc(0));
  } else if (period === "7d" || period === "30d" || period === "90d") {
    clauses.push(`${a}created_at >= ?`);
    params.push(inicioDoDiaUtc(Number(period.replace("d", ""))));
  }
  return { clauses, params };
}

export function parseConversionFilters(params: RawParams): ConversionFilters {
  const f: ConversionFilters = {
    destination: one(params, "destination"),
    status: one(params, "status"),
    event: one(params, "event"),
    period: one(params, "period"),
    from: one(params, "from"),
    to: one(params, "to"),
  };
  if ((f.from || f.to) && f.period !== "custom") f.period = "custom";
  return f;
}

export function buildConversionsWhere(
  filters: ConversionFilters
): { where: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filters.destination) {
    clauses.push("destination = ?");
    params.push(filters.destination);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.event) {
    clauses.push("event_name = ?");
    params.push(filters.event);
  }
  const p = periodClauses(filters.period, filters.from, filters.to);
  clauses.push(...p.clauses);
  params.push(...p.params);

  return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

/** Quantos filtros estão ativos (para o resumo/label). */
export function activeCount(filters: Filters): number {
  let n = 0;
  if (filters.site) n++;
  if (filters.product) n++;
  if (filters.campaign) n++;
  if (filters.platform) n++;
  if (filters.device) n++;
  if (filters.period) n++;
  return n;
}
