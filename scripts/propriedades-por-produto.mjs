import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import {
  adminClient,
  resolveAccount,
  ensureProperty,
  ensureMeasurementProtocolSecret,
  ensureCustomDimension,
  ensureAudiences,
  defaultAudiences,
  videoAudiences
} from '../lib/ga4.mjs';
import {
  getProfile,
  getActiveProfile,
  applyProfileToEnv,
  saveProfile,
  readProfiles,
  SERVICE_ACCOUNT_PATH
} from '../lib/profiles.mjs';

/**
 * Fase 1 do plano de "propriedade GA4 por produto": cria uma propriedade GA4
 * dedicada para cada produto front confirmado, com dimensao product_name e os
 * publicos padrao (Checkout 7/30/90d, Compra 30/180d, Abandono 30d, Pix sem
 * pagar 15d). Nao mexe no Worker nem no snippet — isso e a Fase 3/4, feita
 * depois que estas propriedades estiverem criadas e conferidas.
 *
 *   node scripts/propriedades-por-produto.mjs             mostra o que faria
 *   node scripts/propriedades-por-produto.mjs --apply      cria de verdade
 *   node scripts/propriedades-por-produto.mjs --apply --profile=cliente-a
 */

const APPLY = process.argv.includes('--apply');
const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];

// Os 5 produtos confirmados nesta rodada (Fase 0 corrigiu a lista: exclui o
// produto-teste "Mercado de Acoes no Brasil" e deixa Genesis Protocol EN e
// El Sello de fora ate a confirmacao dos dados).
const PRODUTOS_CONFIRMADOS = [
  'Protocolo de Gênesis',
  'El Capítulo Prohibido de los 3 Arcángeles',
  'Manuscrito dos Milagres',
  'Capítulo Secreto',
  'Acelerador Angelical: 7 Orações para Riqueza.',
  'Genesis Protocol EN',
  'Numerologia Cabalistica -'
];

async function main() {
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile) throw new Error('Nenhum perfil configurado.');
  applyProfileToEnv(profile);

  const measurementId = profile.ga4MeasurementId || process.env.GA4_MEASUREMENT_ID;
  if (!measurementId) throw new Error('Perfil sem GA4 Measurement ID (propriedade principal).');

  const productList = JSON.parse(profile.productList || '[]');
  const alvo = PRODUTOS_CONFIRMADOS.map((nome) => {
    const p = productList.find((x) => x.name === nome);
    if (!p) throw new Error(`Produto "${nome}" nao encontrado no productList do perfil.`);
    return p;
  });

  const defaultUri = `https://${profile.trackingDomain || 'track.odexwa.sbs'}`;

  console.log(chalk.blue(`→ Perfil: ${profile.name}`));
  console.log(chalk.gray(`  ${alvo.length} produtos vao ganhar propriedade GA4 propria:`));
  alvo.forEach((p) => console.log(chalk.gray(`    ${p.name}`)));

  if (!APPLY) {
    console.log(chalk.yellow('\nSimulacao. Rode com --apply para criar de verdade.'));
    return;
  }

  const credentials = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || SERVICE_ACCOUNT_PATH);
  const admin = adminClient(credentials);

  console.log(chalk.blue('\n→ Descobrindo a conta do GA4 (a mesma da propriedade atual)...'));
  const account = await resolveAccount(admin, measurementId);
  console.log(chalk.gray(`  ${account.displayName} (${account.account})`));

  const resultados = [];

  for (const produto of alvo) {
    console.log(chalk.blue(`\n→ ${produto.name}`));

    const { property, dataStream, measurementId: novoMeasurementId } = await ensureProperty(
      admin,
      account.account,
      produto.name,
      defaultUri
    );

    const apiSecret = await ensureMeasurementProtocolSecret(admin, dataStream);
    await ensureCustomDimension(admin, property, 'product_name', 'Produto');
    // Sem video_mark registrado o GA4 recebe o evento de VSL mas nao consegue
    // filtrar por marco — e o publico de retencao nao tem como existir.
    await ensureCustomDimension(admin, property, 'video_mark', 'Marco da VSL');
    const { created, reused } = await ensureAudiences(admin, property, [
      ...defaultAudiences(),
      ...videoAudiences()
    ]);

    console.log(
      chalk.green(
        `  ✓ ${produto.name}: ${novoMeasurementId} — ${created} publicos criados, ${reused} ja existiam`
      )
    );

    resultados.push({
      product: produto.name,
      property,
      measurementId: novoMeasurementId,
      apiSecret
    });
  }

  // Guarda o resultado no perfil para a Fase 3 (roteamento no Worker) usar
  // depois — nao afeta o campo ga4MeasurementId/ga4ApiSecret unico atual.
  const profileKey = profileId || readProfiles().activeProfile;
  saveProfile(profileKey, { productGa4Properties: JSON.stringify(resultados) });

  console.log(chalk.green(`\n✓ ${resultados.length} propriedades GA4 prontas.`));
  console.log(chalk.gray('  Guardadas em productGa4Properties no perfil.'));
  console.log(
    chalk.gray(
      '  Lembrete: cada propriedade comeca zerada — o historico da propriedade unica atual nao migra.'
    )
  );
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
