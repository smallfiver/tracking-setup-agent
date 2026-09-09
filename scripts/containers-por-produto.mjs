import chalk from 'chalk';
import path from 'path';
import { setupGTM, publishContainer } from '../lib/gtm.mjs';
import {
  getProfile,
  getActiveProfile,
  applyProfileToEnv,
  saveProfile,
  readProfiles,
  SERVICE_ACCOUNT_PATH
} from '../lib/profiles.mjs';

/**
 * Fase 2 do plano de "GA4 + GTM por produto": cria um container GTM dedicado
 * para cada produto front que ja tem propriedade GA4 (Fase 1), com as mesmas
 * tags/variaveis/acionadores do container principal, mas com a tag "GA4 -
 * Config" (e todas as tags de evento) apontando para o Measurement ID daquele
 * produto especifico.
 *
 * Nao mexe no Worker nem no snippet (Fase 3/4) — os containers ficam criados
 * e publicados, mas nenhuma pagina carrega eles ainda ate essa fase rodar.
 *
 *   node scripts/containers-por-produto.mjs             mostra o que faria
 *   node scripts/containers-por-produto.mjs --apply      cria de verdade
 */

const APPLY = process.argv.includes('--apply');
const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];

const FUNNEL_VARS = [
  'FRONT_PRODUCT_IDS',
  'ORDER_BUMP_PRODUCT_IDS',
  'UPSELL_PRODUCT_IDS',
  'DOWNSELL_PRODUCT_IDS',
  'PRODUCT_LIST',
  'CHECKOUT_DOMAINS'
];

async function main() {
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile) throw new Error('Nenhum perfil configurado.');
  applyProfileToEnv(profile);

  const accountId = profile.gtmAccountId || process.env.GTM_ACCOUNT_ID;
  if (!accountId) throw new Error('Perfil sem GTM Account ID.');

  const properties = JSON.parse(profile.productGa4Properties || '[]');
  if (!properties.length) {
    throw new Error('productGa4Properties vazio — rode a Fase 1 (propriedades-por-produto.mjs) primeiro.');
  }

  const workerUrl = `https://${profile.trackingDomain}`;
  const baseName = profile.gtmContainerName || profile.name;

  console.log(chalk.blue(`→ Perfil: ${profile.name}`));
  console.log(chalk.gray(`  ${properties.length} containers GTM vao ser criados/atualizados:`));
  properties.forEach((p) => console.log(chalk.gray(`    ${baseName} — ${p.product} (${p.measurementId})`)));

  if (!APPLY) {
    console.log(chalk.yellow('\nSimulacao. Rode com --apply para criar de verdade.'));
    return;
  }

  const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || SERVICE_ACCOUNT_PATH);

  const funnel = {};
  for (const name of FUNNEL_VARS) {
    if (process.env[name]) funnel[name] = process.env[name];
  }

  const resultados = [];

  for (const item of properties) {
    console.log(chalk.blue(`\n→ ${item.product}`));
    // O nome do container do GTM nao aceita ":" (e provavelmente outros
    // caracteres de pontuacao pesada) — troca por espaco antes de truncar.
    const nomeLimpo = item.product.replace(/[:]/g, '').replace(/\s+/g, ' ').trim();
    const containerName = `${baseName} — ${nomeLimpo}`.slice(0, 55);

    const gtmCtx = await setupGTM({
      accountId,
      containerName,
      measurementId: item.measurementId,
      credentialsPath,
      workerUrl,
      funnel
    });

    await publishContainer({
      gtm: gtmCtx.gtm,
      workspacePath: gtmCtx.workspacePath,
      notes: `Container dedicado — ${item.product} (${item.measurementId})`
    });

    console.log(chalk.green(`  ✓ ${item.product}: ${gtmCtx.container.publicId}`));

    resultados.push({
      product: item.product,
      containerId: gtmCtx.container.publicId,
      containerPath: gtmCtx.containerPath,
      measurementId: item.measurementId
    });
  }

  const profileKey = profileId || readProfiles().activeProfile;
  saveProfile(profileKey, { productGtmContainers: JSON.stringify(resultados) });

  console.log(chalk.green(`\n✓ ${resultados.length} containers GTM prontos e publicados.`));
  console.log(chalk.gray('  Guardados em productGtmContainers no perfil.'));
  console.log(
    chalk.gray(
      '  Nenhuma pagina carrega estes containers ainda — isso e a Fase 4 (snippet dinamico por produto).'
    )
  );
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
