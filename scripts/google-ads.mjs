import chalk from 'chalk';
import {
  credenciaisFaltando,
  ensureConversionAction,
  uploadConversions,
  soDigitos
} from '../lib/google-ads.mjs';
import { getProfile, getActiveProfile, saveProfile, readProfiles } from '../lib/profiles.mjs';
import { query } from '../lib/d1.mjs';

/**
 * Google Ads sem passar pelo GA4.
 *
 *   node scripts/google-ads.mjs criar-conversao
 *       Cria a acao "importar de cliques" na conta e salva o id no perfil.
 *       Substitui o passo manual de Metas > Conversoes > Importar.
 *
 *   node scripts/google-ads.mjs enviar
 *       Mostra quais vendas do banco subiriam (simulacao).
 *
 *   node scripts/google-ads.mjs enviar --apply
 *       Sobe as vendas com click ID que ainda nao foram enviadas.
 *
 *   node scripts/google-ads.mjs enviar --apply --evento=pix_generated
 *       Sobe outro evento (util como conversao secundaria).
 *
 * O Worker ja envia cada venda nova em tempo real. Este script serve para o
 * historico que ficou no banco antes das credenciais existirem.
 */

const comando = process.argv[2];
const APPLY = process.argv.includes('--apply');
const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];
const evento = process.argv.find((a) => a.startsWith('--evento='))?.split('=')[1] || 'purchase';

/** O Google aceita conversao de clique com ate 90 dias. */
const JANELA_DIAS = 90;

function contexto(profile) {
  return {
    accountId: profile.cloudflareAccountId,
    apiToken: profile.cloudflareApiToken,
    databaseId: profile.state?.databaseId
  };
}

async function criarConversao(profile, id) {
  const faltando = credenciaisFaltando({ ...profile, googleAdsConversionActionId: 'x' });
  if (faltando.length) {
    throw new Error(`Faltam credenciais no perfil: ${faltando.join(', ')}`);
  }

  const actionId = await ensureConversionAction(profile);
  saveProfile(id, { googleAdsConversionActionId: actionId });

  console.log(chalk.green(`\n✓ Salvo no perfil: googleAdsConversionActionId = ${actionId}`));
  console.log(
    chalk.gray(
      '\nAgora rode o setup para o Worker receber essa credencial:\n' +
        `  SETUP_PROFILE=${id} node setup.mjs`
    )
  );
}

async function enviar(profile) {
  const faltando = credenciaisFaltando(profile);
  if (faltando.length) {
    throw new Error(
      `Faltam credenciais no perfil: ${faltando.join(', ')}\n` +
        'Preencha em Configurações no painel, ou rode "criar-conversao" para gerar o id da acao.'
    );
  }

  const ctx = contexto(profile);
  if (!ctx.databaseId) throw new Error('Perfil sem banco D1.');

  // Nao reenviamos o que o Worker ja mandou: o conversions_log guarda o registro.
  const vendas = await query(
    ctx,
    `SELECT p.transaction_id, p.value, p.currency, p.gclid, p.gbraid, p.wbraid, p.created_at
     FROM purchases p
     WHERE p.event_name = ?
       AND (p.gclid IS NOT NULL OR p.gbraid IS NOT NULL OR p.wbraid IS NOT NULL)
       AND p.created_at > datetime('now', '-${JANELA_DIAS} days')
       AND NOT EXISTS (
         SELECT 1 FROM conversions_log c
         WHERE c.destination = 'google_ads'
           AND c.status = 'sent'
           AND c.transaction_id = p.transaction_id
       )
     ORDER BY p.created_at`,
    [evento]
  );

  console.log(chalk.blue(`→ Evento: ${evento}`));
  console.log(`  ${vendas.length} registro(s) prontos para enviar\n`);

  if (!vendas.length) {
    console.log(chalk.green('Nada pendente — o Worker ja deu conta.'));
    return;
  }

  vendas.forEach((v) =>
    console.log(
      `  ${String(v.transaction_id || '-').padEnd(14)} R$ ${String(v.value).padEnd(9)} ` +
        `${v.created_at}  ${String(v.gclid || v.gbraid || v.wbraid).slice(0, 22)}...`
    )
  );

  if (!APPLY) {
    console.log(chalk.yellow('\nSimulacao. Rode com --apply para enviar de verdade.'));
    return;
  }

  // Lotes de 100: limite confortavel da API.
  let total = 0;
  const todosErros = [];
  for (let i = 0; i < vendas.length; i += 100) {
    const lote = vendas.slice(i, i + 100);
    const { enviadas, erros } = await uploadConversions(profile, lote);
    total += enviadas;
    todosErros.push(...erros);
  }

  console.log(chalk.green(`\n✓ ${total} conversao(oes) enviada(s) ao Google Ads.`));
  if (todosErros.length) {
    console.log(chalk.yellow('\nAvisos devolvidos pelo Google:'));
    todosErros.slice(0, 10).forEach((e) => console.log('  ' + e));
  }
  console.log(
    chalk.gray(
      '\nO Google leva ate 3 horas para exibir. Confira em\n' +
        'Metas > Conversoes > (sua acao) > historico de uploads.'
    )
  );
}

async function main() {
  const store = readProfiles();
  const id = profileId || store.activeProfile;
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile) throw new Error('Nenhum perfil configurado.');

  console.log(chalk.blue(`→ Perfil: ${profile.name}`));
  if (profile.googleAdsCustomerId) {
    console.log(chalk.gray(`  conta Google Ads: ${soDigitos(profile.googleAdsCustomerId)}`));
  }

  if (comando === 'criar-conversao') return criarConversao(profile, id);
  if (comando === 'enviar') return enviar(profile);

  console.log(`
Comandos:
  node scripts/google-ads.mjs criar-conversao      cria a acao de conversao e salva o id
  node scripts/google-ads.mjs enviar               simula o envio do historico
  node scripts/google-ads.mjs enviar --apply       envia de verdade

Opcoes:
  --evento=pix_generated    envia outro evento (padrao: purchase)
  --profile=cliente-b       usa outro perfil
`);
}

main().catch((err) => {
  console.error(chalk.red('\n' + err.message));
  process.exit(1);
});
