import chalk from 'chalk';
import { getActiveProfile, getProfile } from '../lib/profiles.mjs';
import { query } from '../lib/d1.mjs';

/**
 * Recupera atribuicao de vendas antigas.
 *
 * O payload cru de cada webhook fica salvo em purchases.raw_payload. Se o
 * normalizador nao conhecia o formato da plataforma na epoca, os campos de
 * atribuicao ficaram nulos — mas o dado esta la. Este script le o JSON salvo e
 * preenche apenas o que esta vazio (COALESCE), sem sobrescrever nada.
 *
 *   node scripts/backfill-attribution.mjs           (perfil ativo, simulacao)
 *   node scripts/backfill-attribution.mjs --apply   (grava)
 */

const APPLY = process.argv.includes('--apply');
const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];

/** Caminhos alternativos do mesmo campo dentro do payload das plataformas. */
const FIELD_PATHS = {
  gclid: ['$.cookies.gclid', '$.gclid', '$.TrackingParameters.gclid', '$.utm.gclid'],
  gbraid: ['$.cookies.gbraid', '$.gbraid'],
  wbraid: ['$.cookies.wbraid', '$.wbraid'],
  fbclid: ['$.cookies.fbclid', '$.fbclid'],
  fbc: ['$.cookies.fbc', '$.cookies._fbc', '$.fbc'],
  fbp: ['$.cookies.fbp', '$.cookies._fbp', '$.fbp'],
  ttclid: ['$.cookies.ttclid', '$.ttclid'],
  msclkid: ['$.cookies.msclkid', '$.msclkid'],
  utm_source: ['$.utm.utm_source', '$.utm_source', '$.TrackingParameters.utm_source'],
  utm_medium: ['$.utm.utm_medium', '$.utm_medium'],
  utm_campaign: ['$.utm.utm_campaign', '$.utm_campaign'],
  utm_term: ['$.utm.utm_term', '$.utm_term'],
  utm_content: ['$.utm.utm_content', '$.utm_content'],
  ip: ['$.ip', '$.customer.ip'],
  customer_phone: ['$.customer.phone_number', '$.customer.phone'],
  customer_document: ['$.customer.document'],
  product_name: ['$.products[0].name', '$.product_name'],
  payment_method: ['$.payment.method', '$.payment_method']
};

const coalesceFrom = (column, paths) =>
  `${column} = COALESCE(${column}, ${paths.map((p) => `json_extract(raw_payload, '${p}')`).join(', ')})`;

async function main() {
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile?.state?.databaseId) {
    throw new Error('Perfil sem banco D1. Rode o setup primeiro.');
  }

  const ctx = {
    accountId: profile.cloudflareAccountId,
    apiToken: profile.cloudflareApiToken,
    databaseId: profile.state.databaseId
  };

  console.log(chalk.blue(`→ Perfil: ${profile.name}`));

  const pending = await query(
    ctx,
    `SELECT id, transaction_id, event_name,
            json_extract(raw_payload, '$.cookies.gclid') AS gclid_payload,
            json_extract(raw_payload, '$.utm.utm_source') AS utm_payload
     FROM purchases
     WHERE gclid IS NULL AND fbc IS NULL AND utm_source IS NULL
       AND raw_payload IS NOT NULL`
  );

  const recuperaveis = pending.filter((r) => r.gclid_payload || r.utm_payload);

  console.log(`  vendas sem atribuicao: ${pending.length}`);
  console.log(`  com dado recuperavel no payload: ${recuperaveis.length}`);

  if (!recuperaveis.length) {
    console.log(chalk.green('✓ Nenhuma venda a recuperar.'));
    // Ainda assim sincronizamos os eventos espelhados — eles podem estar
    // defasados de uma execucao anterior.
    if (APPLY) await syncMirroredEvents(ctx);
    return;
  }

  if (!APPLY) {
    recuperaveis.slice(0, 10).forEach((r) =>
      console.log(`    ${r.transaction_id} (${r.event_name}) -> gclid: ${r.gclid_payload || '-'} | utm: ${r.utm_payload || '-'}`)
    );
    console.log(chalk.yellow('\nSimulacao. Rode com --apply para gravar.'));
    return;
  }

  const sets = Object.entries(FIELD_PATHS).map(([col, paths]) => coalesceFrom(col, paths));
  sets.push(
    `attribution_source = CASE
       WHEN COALESCE(gclid, json_extract(raw_payload, '$.cookies.gclid')) IS NOT NULL
         OR COALESCE(utm_source, json_extract(raw_payload, '$.utm.utm_source')) IS NOT NULL
       THEN 'webhook' ELSE attribution_source END`
  );

  await query(
    ctx,
    `UPDATE purchases SET ${sets.join(', ')}
     WHERE raw_payload IS NOT NULL
       AND gclid IS NULL AND fbc IS NULL AND utm_source IS NULL`
  );

  // Algumas plataformas colocam o cookie _gcl_au/_ga no campo gclid ("1.1.123.456").
  // Isso nao e ID de clique e seria recusado pelo Google Ads — limpamos.
  await query(
    ctx,
    `UPDATE purchases SET gclid = NULL
     WHERE gclid IS NOT NULL AND gclid GLOB '[0-9.]*'
       AND gclid NOT GLOB '*[A-Za-z_-]*'`
  );

  await syncMirroredEvents(ctx);

  const restantes = await query(
    ctx,
    `SELECT COUNT(*) AS n FROM purchases
     WHERE gclid IS NULL AND fbc IS NULL AND utm_source IS NULL`
  );

  console.log(chalk.green(`✓ Recuperadas. Vendas ainda sem atribuicao: ${restantes[0].n}`));
}

/**
 * Cada venda tambem vira uma linha em events (para o funil unificado).
 * Sincroniza a atribuicao da venda para la, senao o painel mostra "-".
 */
async function syncMirroredEvents(ctx) {
  await query(
    ctx,
    `UPDATE events SET
       gclid = COALESCE(gclid, (SELECT p.gclid FROM purchases p WHERE p.transaction_id = events.transaction_id AND p.event_name = events.event_name)),
       utm_source = COALESCE(utm_source, (SELECT p.utm_source FROM purchases p WHERE p.transaction_id = events.transaction_id AND p.event_name = events.event_name)),
       utm_medium = COALESCE(utm_medium, (SELECT p.utm_medium FROM purchases p WHERE p.transaction_id = events.transaction_id AND p.event_name = events.event_name)),
       utm_campaign = COALESCE(utm_campaign, (SELECT p.utm_campaign FROM purchases p WHERE p.transaction_id = events.transaction_id AND p.event_name = events.event_name)),
       hostname = COALESCE(hostname, (SELECT p.hostname FROM purchases p WHERE p.transaction_id = events.transaction_id AND p.event_name = events.event_name))
     WHERE source = 'webhook' AND transaction_id IS NOT NULL`
  );
  console.log(chalk.gray('  eventos do funil sincronizados com as vendas'));
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
