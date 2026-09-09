import { getProfile } from "./profiles";

/**
 * Acesso ao Cloudflare D1 a partir do painel.
 *
 * Dentro do Worker o D1 e um binding (env.DB). Fora dele — que e o caso aqui —
 * o acesso e pela API REST da Cloudflare, usando o token do perfil ativo.
 */

const API = "https://api.cloudflare.com/client/v4";

export class NotConfiguredError extends Error {}

export type Row = Record<string, any>;

function context(profileId?: string | null) {
  const profile = getProfile(profileId);
  const accountId = profile?.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = profile?.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN;
  const databaseId = profile?.d1DatabaseId || process.env.CLOUDFLARE_D1_DATABASE_ID;

  if (!accountId || !apiToken) {
    throw new NotConfiguredError(
      "Nenhum perfil configurado. Vá em Configurações e cadastre um cliente."
    );
  }
  if (!databaseId) {
    throw new NotConfiguredError(
      "O banco D1 ainda não foi criado para este perfil. Rode o setup em Configurações."
    );
  }
  return { accountId, apiToken, databaseId };
}

/** Executa SQL no D1 e devolve as linhas como objetos. */
export async function query(sql: string, params: any[] = [], profileId?: string | null): Promise<Row[]> {
  const { accountId, apiToken, databaseId } = context(profileId);

  const res = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
    cache: "no-store",
  });

  const body = await res.json().catch(() => null);

  if (!res.ok || !body?.success) {
    const first = body?.errors?.[0];
    if (res.status === 403 || first?.code === 10000) {
      throw new Error(
        'Token da Cloudflare sem permissão de D1. Edite o token e adicione "Account > D1 > Edit".'
      );
    }
    throw new Error(first?.message || `Falha ao consultar o D1 (HTTP ${res.status})`);
  }

  return body.result?.[0]?.results || [];
}

/** Consulta que devolve lista vazia (e a mensagem) em vez de quebrar a pagina. */
export async function safeQuery(
  sql: string,
  params: any[] = [],
  profileId?: string | null
): Promise<{ rows: Row[]; error: string | null }> {
  try {
    return { rows: await query(sql, params, profileId), error: null };
  } catch (err: any) {
    return { rows: [], error: err.message };
  }
}

// Limite do plano D1 atual. Cloudflare pode mudar isso — se o plano for
// atualizado, atualize aqui tambem, senao o alerta fica errado.
export const D1_LIMIT_BYTES = 10 * 1024 ** 3; // 10 GB

/**
 * Tamanho atual do banco D1, em bytes.
 *
 * Existe por causa de um incidente real: eventos de engajamento (watch-time da
 * VSL) encheram o banco silenciosamente ate quase estourar o limite de 10 GB e
 * derrubar o rastreamento inteiro. So se soube depois, olhando o painel da
 * Cloudflare manualmente. Isso aqui e o aviso que deveria ter existido antes.
 */
export async function getDatabaseUsage(
  profileId?: string | null
): Promise<{ bytes: number; error: string | null }> {
  try {
    const { accountId, apiToken, databaseId } = context(profileId);
    const res = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      return { bytes: 0, error: body?.errors?.[0]?.message || `HTTP ${res.status}` };
    }
    return { bytes: Number(body?.result?.file_size || 0), error: null };
  } catch (err: any) {
    // Sem perfil configurado ainda nao e um erro deste alerta especifico —
    // a pagina ja mostra o aviso de configuracao em outro lugar.
    if (err instanceof NotConfiguredError) return { bytes: 0, error: null };
    return { bytes: 0, error: err?.message || "erro desconhecido" };
  }
}
