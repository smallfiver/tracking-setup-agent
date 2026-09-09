import chalk from 'chalk';
import { query } from './d1.mjs';

/**
 * Schema do banco de rastreamento (Cloudflare D1 / SQLite).
 *
 * events    -> todo hit de navegacao e conversao
 * purchases -> tudo que chega por webhook das plataformas de venda
 * leads     -> pessoa consolidada por email/telefone, com atribuicao
 */

export const EVENT_COLUMNS = [
  'event_name',
  'event_id',
  'source',
  'tsid',
  'client_id',
  'session_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'ttclid',
  'msclkid',
  'fbc',
  'fbp',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'hostname',
  'page_location',
  'page_referrer',
  'page_title',
  'transaction_id',
  'value',
  'currency',
  'items',
  'product_id',
  'product_name',
  'purchase_type',
  'email',
  'phone',
  'name',
  'document',
  'city',
  'state',
  'zip',
  'country',
  'geo_lat',
  'geo_lon',
  'geo_city',
  'geo_region',
  'geo_country',
  'user_agent',
  'device_type',
  'browser',
  'os',
  'engagement_type',
  'engagement_value',
  'ip',
  'raw_params'
];

export const PURCHASE_COLUMNS = [
  'event_name',
  'platform',
  'status',
  'hostname',
  'transaction_id',
  'order_id',
  'value',
  'currency',
  'commission',
  'product_id',
  'product_name',
  'offer_name',
  'purchase_type',
  'payment_method',
  'installments',
  'coupon_code',
  'original_value',
  'customer_name',
  'first_name',
  'customer_email',
  'email_hash',
  'customer_phone',
  'phone_hash',
  'customer_document',
  'customer_city',
  'customer_state',
  'customer_zip',
  'customer_country',
  'ip',
  'tsid',
  'client_id',
  'session_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'fbc',
  'fbp',
  'ttclid',
  'msclkid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'device_type',
  'browser',
  'os',
  'geo_country',
  'geo_region',
  'geo_city',
  'attribution_source',
  'raw_payload'
];

const COLUMN_TYPES = {
  value: 'REAL',
  commission: 'REAL',
  installments: 'INTEGER',
  engagement_value: 'REAL',
  original_value: 'REAL',
  geo_lat: 'REAL',
  geo_lon: 'REAL'
};

const BASE_TABLES = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_name TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS purchases (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_name TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS conversions_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     destination TEXT,
     event_name TEXT,
     event_id TEXT,
     transaction_id TEXT,
     value REAL,
     currency TEXT,
     status TEXT,
     detail TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  // Uma linha por conta do Google Ads conectada. O refresh token e por conta:
  // e assim que damos conta de varias contas sem depender de uma MCC unica.
  // client_id/client_secret/developer_token continuam sendo do app (bindings do
  // Worker) — o que muda por conta e quem autorizou e para onde a venda vai.
  `CREATE TABLE IF NOT EXISTS google_ads_accounts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     label TEXT,
     customer_id TEXT,
     login_customer_id TEXT,
     conversion_action_id TEXT,
     refresh_token TEXT,
     google_email TEXT,
     products TEXT,
     enabled INTEGER DEFAULT 1,
     oauth_state TEXT,
     last_error TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS leads (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT,
     phone TEXT,
     name TEXT,
     document TEXT,
     tsid TEXT,
     first_gclid TEXT,
     first_utm_source TEXT,
     first_utm_campaign TEXT,
     last_gclid TEXT,
     last_gbraid TEXT,
     last_wbraid TEXT,
     last_fbclid TEXT,
     last_fbc TEXT,
     last_fbp TEXT,
     last_utm_source TEXT,
     last_utm_medium TEXT,
     last_utm_campaign TEXT,
     purchases_count INTEGER DEFAULT 0,
     total_value REAL DEFAULT 0,
     first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
     last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
   )`,
  // Configuracao grande demais para um binding de texto do Worker (o limite da
  // Cloudflare e 5.1kB). PRODUCT_LIST cresce direto proporcional ao numero de
  // paginas de landing cadastradas — com o tempo estoura o binding, entao mora
  // aqui em vez de no deploy. O Worker le com cache curto (ver loadProductList
  // em worker.js); o valor de fallback no binding continua funcionando (e o
  // que os testes usam, sem precisar mockar D1 para isso).
  `CREATE TABLE IF NOT EXISTS kv_config (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_events_email ON events (email)',
  'CREATE INDEX IF NOT EXISTS idx_events_tsid ON events (tsid)',
  'CREATE INDEX IF NOT EXISTS idx_events_txn ON events (transaction_id)',
  'CREATE INDEX IF NOT EXISTS idx_events_name ON events (event_name)',
  'CREATE INDEX IF NOT EXISTS idx_events_hostname ON events (hostname)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_hostname ON purchases (hostname)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_type ON purchases (purchase_type)',
  'CREATE INDEX IF NOT EXISTS idx_events_device ON events (device_type)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_device ON purchases (device_type)',
  'CREATE INDEX IF NOT EXISTS idx_events_type ON events (purchase_type)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events (event_id) WHERE event_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_email ON purchases (customer_email)',
  // session_id e product_name faltavam aqui — sao os dois campos mais pesados
  // do dashboard (COUNT DISTINCT session_id e GROUP BY product_name em toda
  // consulta de funil/produto). Sem indice, cada um vira varredura completa da
  // tabela; com events passando de 600 mil linhas isso ficou de 4 a 13
  // segundos por consulta e travava o painel inteiro.
  'CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id)',
  'CREATE INDEX IF NOT EXISTS idx_events_product ON events (product_name)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases (product_name)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_campaign ON purchases (utm_campaign)',
  // event_name em purchases nunca teve indice — e a condicao mais repetida do
  // sistema (WHERE event_name = 'purchase'/'refund'/...). Hoje a tabela e
  // pequena e nao doia, mas cresce ~500 linhas/dia; melhor ja deixar coberto.
  'CREATE INDEX IF NOT EXISTS idx_purchases_name ON purchases (event_name)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_txn ON purchases (transaction_id, event_name) WHERE transaction_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_email ON leads (email) WHERE email IS NOT NULL',
  // Garante que a mesma conversao nunca seja enviada duas vezes ao mesmo destino,
  // mesmo se a plataforma reenviar o webhook.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_conversions_unique ON conversions_log (destination, event_id)',
  'CREATE INDEX IF NOT EXISTS idx_conversions_created ON conversions_log (created_at DESC)',
  // Duas contas nunca podem apontar para o mesmo customer_id do Google Ads:
  // a venda ficaria ambigua e seria enviada duas vezes.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_gads_customer ON google_ads_accounts (customer_id) WHERE customer_id IS NOT NULL'
];

async function existingColumns(ctx, table) {
  const rows = await query(ctx, `PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => String(r.name)));
}

async function ensureColumns(ctx, table, wanted) {
  const have = await existingColumns(ctx, table);
  let added = 0;
  for (const col of wanted) {
    if (have.has(col)) continue;
    await query(ctx, `ALTER TABLE ${table} ADD COLUMN ${col} ${COLUMN_TYPES[col] || 'TEXT'}`);
    added++;
  }
  return added;
}

/**
 * Cria e migra o schema. Roda quantas vezes quiser: tabelas usam IF NOT EXISTS
 * e colunas novas entram por ALTER TABLE, entao nada e perdido.
 */
export async function setupSchema(ctx) {
  console.log(chalk.blue('→ D1: criando/migrando schema...'));

  for (const sql of BASE_TABLES) await query(ctx, sql);

  const a = await ensureColumns(ctx, 'events', EVENT_COLUMNS);
  const b = await ensureColumns(ctx, 'purchases', PURCHASE_COLUMNS);

  for (const sql of INDEXES) {
    try {
      await query(ctx, sql);
    } catch (err) {
      console.log(chalk.yellow(`  aviso (indice): ${err.message}`));
    }
  }

  console.log(
    chalk.green(`✓ Schema pronto (events: +${a} colunas, purchases: +${b} colunas, leads ok).`)
  );
}
