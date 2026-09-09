import chalk from 'chalk';
import { getActiveProfile, getProfile } from '../lib/profiles.mjs';
import { query } from '../lib/d1.mjs';

/**
 * Remove os registros criados durante os testes de configuracao.
 *
 * Roda em modo simulacao por padrao — so apaga com --apply. A selecao e
 * conservadora: identificadores que so existem em teste (prefixos, dominios de
 * localhost, e-mails ficticios). Nada que venha de trafego real casa com isso.
 *
 *   node scripts/limpar-testes.mjs           (mostra o que seria apagado)
 *   node scripts/limpar-testes.mjs --apply   (apaga)
 */

const APPLY = process.argv.includes('--apply');
const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];

const TEST_TRANSACTIONS = [
  'TESTE-VENDA-001',
  'TESTE-MP-001',
  'LP1-VENDA',
  'LP2-VENDA'
];

/** Vendas de teste: id conhecido, ou e-mail de dominio ficticio. */
const PURCHASE_FILTER = `
  transaction_id IN (${TEST_TRANSACTIONS.map((t) => `'${t}'`).join(', ')})
  OR customer_email LIKE '%@exemplo.com'
  OR customer_email LIKE '%@teste.com'
  OR customer_email = 'cliente.teste@exemplo.com'
`;

/** Eventos de teste: setup, paginas locais, e visitantes sinteticos. */
const EVENT_FILTER = `
  event_name = 'setup_test'
  OR page_location LIKE '%localhost%'
  OR page_location LIKE '%:3456%'
  OR page_location LIKE '%oferta-um.com.br%'
  OR page_location LIKE '%oferta-dois.com%'
  OR hostname IN ('oferta-um.com.br', 'oferta-dois.com', 'localhost')
  OR gclid LIKE 'TESTE%'
  OR gclid IN ('GCLID-LP1', 'GCLID-LP2', 'GCLID-TESTE-GA4')
  OR email LIKE '%@exemplo.com'
  OR email LIKE '%@teste.com'
  OR email = 'teste@setup.local'
  OR transaction_id IN (${TEST_TRANSACTIONS.map((t) => `'${t}'`).join(', ')})
`;

const LEAD_FILTER = `
  email LIKE '%@exemplo.com'
  OR email LIKE '%@teste.com'
  OR email = 'teste@setup.local'
`;

const CONVERSION_FILTER = `
  transaction_id IN (${TEST_TRANSACTIONS.map((t) => `'${t}'`).join(', ')})
  OR event_id LIKE '%TESTE%'
  OR event_id LIKE '%GA4-VENDA%'
  OR event_id LIKE '%SEM-%'
`;

const TARGETS = [
  { table: 'purchases', where: PURCHASE_FILTER, label: 'vendas de teste' },
  { table: 'events', where: EVENT_FILTER, label: 'eventos de teste' },
  { table: 'leads', where: LEAD_FILTER, label: 'leads de teste' },
  { table: 'conversions_log', where: CONVERSION_FILTER, label: 'envios de conversao de teste' }
];

async function main() {
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile?.state?.databaseId) throw new Error('Perfil sem banco D1.');

  const ctx = {
    accountId: profile.cloudflareAccountId,
    apiToken: profile.cloudflareApiToken,
    databaseId: profile.state.databaseId
  };

  console.log(chalk.blue(`→ Perfil: ${profile.name}`));

  for (const { table, where, label } of TARGETS) {
    const antes = (await query(ctx, `SELECT COUNT(*) AS n FROM ${table}`))[0].n;
    const alvo = (await query(ctx, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))[0].n;

    if (!APPLY) {
      console.log(`  ${label}: ${alvo} de ${antes} seriam apagados`);
      continue;
    }

    if (alvo > 0) await query(ctx, `DELETE FROM ${table} WHERE ${where}`);
    const depois = (await query(ctx, `SELECT COUNT(*) AS n FROM ${table}`))[0].n;
    console.log(chalk.green(`  ${table}: ${antes} → ${depois} (${alvo} removidos)`));
  }

  if (!APPLY) console.log(chalk.yellow('\nSimulacao. Rode com --apply para apagar.'));
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
