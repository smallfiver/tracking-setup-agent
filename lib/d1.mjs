import axios from 'axios';
import chalk from 'chalk';

/**
 * Cloudflare D1 — provisionamento e acesso via API REST.
 *
 * O Worker fala com o D1 por binding (env.DB), que e interno e rapido.
 * Este modulo e usado apenas fora do Worker: pelo setup, para criar o banco e
 * migrar o schema, e pelo painel, para ler os dados.
 */

const API = 'https://api.cloudflare.com/client/v4';

function client({ accountId, apiToken }) {
  return axios.create({
    baseURL: `${API}/accounts/${accountId}/d1/database`,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
}

/** Mensagem util a partir de um erro da API da Cloudflare. */
export function cloudflareError(err, context) {
  const data = err?.response?.data;
  const first = data?.errors?.[0];
  const status = err?.response?.status;

  if (status === 403 || first?.code === 10000) {
    return new Error(
      `${context}: token da Cloudflare sem permissao para D1.\n` +
        'Edite o token em My Profile > API Tokens e adicione a permissao\n' +
        '"Account > D1 > Edit" (alem de "Workers Scripts > Edit").'
    );
  }
  if (first) return new Error(`${context}: ${first.message} (codigo ${first.code})`);
  return new Error(`${context}: ${err.message}`);
}

/** Cria o banco se ainda nao existir; devolve { uuid, name, created }. */
export async function ensureDatabase({ accountId, apiToken, databaseName, databaseId }) {
  const api = client({ accountId, apiToken });

  // Se ja temos o id salvo, confirmamos que ele continua valido.
  if (databaseId) {
    try {
      const res = await api.get(`/${databaseId}`);
      const db = res.data.result;
      console.log(chalk.gray(`  banco D1 existente: ${db.name} (${databaseId})`));
      return { uuid: databaseId, name: db.name, created: false };
    } catch {
      console.log(chalk.yellow('  id de D1 salvo nao existe mais — criando um novo.'));
    }
  }

  try {
    const list = await api.get('', { params: { name: databaseName, per_page: 100 } });
    const found = (list.data.result || []).find((d) => d.name === databaseName);
    if (found) {
      console.log(chalk.gray(`  banco D1 existente reutilizado: ${found.name} (${found.uuid})`));
      return { uuid: found.uuid, name: found.name, created: false };
    }
  } catch (err) {
    throw cloudflareError(err, 'Falha ao listar bancos D1');
  }

  try {
    const created = await api.post('', { name: databaseName });
    const db = created.data.result;
    console.log(chalk.gray(`  banco D1 criado: ${db.name} (${db.uuid})`));
    return { uuid: db.uuid, name: db.name, created: true };
  } catch (err) {
    throw cloudflareError(err, 'Falha ao criar o banco D1');
  }
}

/** Executa SQL no D1 pela API REST. Devolve as linhas como objetos simples. */
export async function query({ accountId, apiToken, databaseId }, sql, params = []) {
  const api = client({ accountId, apiToken });
  try {
    const res = await api.post(`/${databaseId}/query`, { sql, params });
    const first = (res.data.result || [])[0];
    return first?.results || [];
  } catch (err) {
    throw cloudflareError(err, 'Falha ao consultar o D1');
  }
}

/**
 * Grava o PRODUCT_LIST na tabela kv_config, para o Worker ler dali.
 *
 * PRODUCT_LIST cresce com cada landing page nova e ja passou do limite de
 * 5.1kB de um binding de texto da Cloudflare — por isso nao vai mais junto do
 * deploy do Worker (ver deployWorker em lib/cloudflare.mjs). Precisa da
 * tabela kv_config ja criada (setupSchema cuida disso).
 */
export async function syncProductList(ctx, productListJson) {
  await query(
    ctx,
    `INSERT INTO kv_config (key, value, updated_at) VALUES ('PRODUCT_LIST', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [productListJson]
  );
}

/**
 * Confere o token antes de o setup avancar.
 *
 * Distingue os tres casos que dao o mesmo erro generico da Cloudflare:
 * token invalido, conta errada, ou token valido sem permissao de D1.
 */
export async function checkToken({ accountId, apiToken }) {
  const api = client({ accountId, apiToken });
  try {
    await api.get('', { params: { per_page: 1 } });
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if (status !== 401 && status !== 403) throw cloudflareError(err, 'Verificacao do token');

    // O token consegue enxergar a conta? Se sim, o problema e so a permissao de D1.
    let accounts = null;
    try {
      const res = await axios.get(`${API}/accounts`, {
        headers: { Authorization: `Bearer ${apiToken}` },
        timeout: 20000
      });
      accounts = res.data.result || [];
    } catch {
      throw new Error(
        'Token da Cloudflare invalido ou expirado.\n' +
          'Gere um novo em My Profile > API Tokens e cole no perfil.'
      );
    }

    const match = accounts.find((a) => a.id === accountId);
    if (!match) {
      const list = accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n');
      throw new Error(
        `O token e valido, mas nao tem acesso a conta ${accountId}.\n` +
          (list ? `Contas que este token enxerga:\n${list}` : 'Ele nao enxerga nenhuma conta.')
      );
    }

    throw new Error(
      `Token valido na conta "${match.name}", mas sem permissao de D1.\n\n` +
        'Em My Profile > API Tokens, crie um token novo (Create Custom Token) com:\n' +
        '  Account | Workers Scripts  | Edit\n' +
        '  Account | D1               | Edit\n' +
        '  Account | Account Settings | Read\n' +
        `e em Account Resources inclua "${match.name}".\n\n` +
        'Se preferir editar o token atual, confirme que clicou em\n' +
        '"Continue to summary" e depois "Save" — sem isso a alteracao nao e aplicada.'
    );
  }
}
