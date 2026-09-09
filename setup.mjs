import dotenv from 'dotenv';
import chalk from 'chalk';
import axios from 'axios';
import path from 'path';

import { setupSchema } from './lib/schema.mjs';
import { ensureDatabase, checkToken, query, syncProductList } from './lib/d1.mjs';
import { deployWorker, verifyWorker, attachCustomDomain } from './lib/cloudflare.mjs';
import { setupGTM, publishContainer } from './lib/gtm.mjs';
import {
  adminClient,
  resolveProperty,
  ensureMeasurementProtocolSecret,
  ensureAudiences
} from './lib/ga4.mjs';
import {
  readProfiles,
  getProfile,
  applyProfileToEnv,
  saveProfile,
  saveProfileState,
  PROFILES_PATH
} from './lib/profiles.mjs';

dotenv.config();

// Perfil ativo (ou o informado em SETUP_PROFILE) entra no ambiente.
const profileId = process.env.SETUP_PROFILE || readProfiles().activeProfile;
const profile = getProfile(profileId);
applyProfileToEnv(profile);

const REQUIRED = [
  'GTM_ACCOUNT_ID',
  'GTM_CONTAINER_NAME',
  'GA4_MEASUREMENT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID'
];

const SCRIPT_NAME = process.env.WORKER_NAME || 'tracking-worker-agent';
const DATABASE_NAME = process.env.CLOUDFLARE_D1_DATABASE_NAME || `tracking-${SCRIPT_NAME}`;
const TRACK_PAGE_VIEWS = String(process.env.TRACK_PAGE_VIEWS) === 'true';
const TRACK_ENGAGEMENT = String(process.env.TRACK_ENGAGEMENT) === 'true';

/** Dispara um evento sintetico e confirma que ele chegou no banco. */
async function smokeTest(workerUrl, ctx) {
  console.log(chalk.blue('→ Teste ponta a ponta...'));
  const marker = `setup-test-${Date.now()}`;

  try {
    await axios.post(
      `${workerUrl}/collect`,
      {
        event_name: 'setup_test',
        event_id: marker,
        tsid: marker,
        gclid: 'TESTE_GCLID',
        utm_source: 'setup',
        value: 1,
        currency: 'BRL',
        customer: { email: 'teste@setup.local', phone: '11999999999', name: 'Teste Setup' }
      },
      { timeout: 10000 }
    );

    // O Worker grava de forma assincrona (waitUntil).
    await new Promise((r) => setTimeout(r, 2500));

    const rows = await query(ctx, 'SELECT COUNT(*) AS total FROM events WHERE event_id = ?', [marker]);
    if (Number(rows[0]?.total) > 0) {
      console.log(chalk.green('✓ Evento de teste percorreu Worker → D1 com sucesso.'));
      return true;
    }
    console.log(chalk.yellow('  o evento de teste nao apareceu no banco — confira os logs do Worker.'));
    return false;
  } catch (err) {
    console.log(chalk.yellow(`  aviso: teste nao concluiu (${err.message}).`));
    return false;
  }
}

async function main() {
  console.log(chalk.bgBlue.white.bold(' Setup do ecossistema de tracking '));
  console.log(chalk.gray(`  perfil: ${profile?.name || profileId || '(nenhum)'}`));

  if (!profile && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      `Nenhum perfil configurado.\nCrie um na aba Configurações do painel, ou preencha ${PROFILES_PATH}.`
    );
  }

  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `Configuracao incompleta: ${missing.join(', ')}.\n` +
        'Preencha na dashboard (aba Configurações) ou no arquivo .env.'
    );
  }

  const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const cf = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN
  };

  // 1. Token com permissao de D1 — falha cedo e com mensagem clara.
  console.log(chalk.blue('→ Cloudflare: verificando token...'));
  await checkToken(cf);
  console.log(chalk.green('✓ Token com acesso ao D1.'));

  // 2. Banco D1
  console.log(chalk.blue('→ D1: provisionando banco...'));
  const database = await ensureDatabase({
    ...cf,
    databaseName: DATABASE_NAME,
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID
  });

  const ctx = { ...cf, databaseId: database.uuid };
  await setupSchema(ctx);

  // 3. GA4: descobre a propriedade e cria o segredo do Measurement Protocol.
  //     Sem ele o Worker nao consegue mandar a venda do webhook para o GA4 —
  //     e sem a venda no GA4 os publicos de remarketing nascem vazios.
  let ga4 = null;
  if (process.env.GA4_MEASUREMENT_ID) {
    try {
      console.log(chalk.blue('→ GA4: localizando propriedade...'));
      const admin = adminClient(credentialsPath);
      const property = await resolveProperty(admin, process.env.GA4_MEASUREMENT_ID);
      console.log(chalk.gray(`  ${property.displayName} (${property.property})`));

      const secret =
        process.env.GA4_API_SECRET || (await ensureMeasurementProtocolSecret(admin, property.dataStream));

      ga4 = { admin, ...property, secret };
      process.env.GA4_API_SECRET = secret;
      if (profileId) {
        saveProfile(profileId, {
          ga4PropertyId: property.property.replace('properties/', ''),
          ga4ApiSecret: secret
        });
      }
    } catch (err) {
      // Sem acesso ao GA4 o rastreamento continua funcionando — so os publicos
      // e o envio server-side para o GA4 ficam de fora.
      console.log(chalk.yellow(`  aviso: ${err.message}`));
    }
  }

  const CONVERSION_VARS = [
    'GA4_API_SECRET',
    'META_PIXEL_ID',
    'META_ACCESS_TOKEN',
    'META_TEST_EVENT_CODE',
    'GOOGLE_ADS_CUSTOMER_ID',
    'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    'GOOGLE_ADS_CONVERSION_ACTION_ID',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN',
    'CONVERSION_EVENTS'
  ];
  const conversions = {};
  for (const name of CONVERSION_VARS) {
    if (process.env[name]) conversions[name] = process.env[name];
  }

  // Listas de produtos por etapa do funil (order bump / upsell / downsell).
  const FUNNEL_VARS = [
    'FRONT_PRODUCT_IDS',
    'ORDER_BUMP_PRODUCT_IDS',
    'UPSELL_PRODUCT_IDS',
    'DOWNSELL_PRODUCT_IDS',
    'PRODUCT_LIST',
    'CHECKOUT_DOMAINS'
  ];
  const funnel = {};
  for (const name of FUNNEL_VARS) {
    if (process.env[name]) funnel[name] = process.env[name];
  }

  // Recuperacao de carrinho abandonado (Cron do Worker, so leitura).
  const abandoned = {};
  for (const name of ['ABANDONED_WEBHOOK_URL', 'ABANDONED_WEBHOOK_TOKEN']) {
    if (process.env[name]) abandoned[name] = process.env[name];
  }

  // 4. Worker com o binding do D1 e as credenciais de envio de conversao
  const workersDevUrl = await deployWorker({
    ...cf,
    scriptName: SCRIPT_NAME,
    databaseId: database.uuid,
    databaseName: database.name,
    measurementId: process.env.GA4_MEASUREMENT_ID,
    trackPageViews: TRACK_PAGE_VIEWS,
    trackEngagement: TRACK_ENGAGEMENT,
    conversions,
    funnel,
    abandoned
  });

  // PRODUCT_LIST nao vai no binding do Worker (estoura o limite de 5.1kB da
  // Cloudflare com o tempo) — mora no D1, sincronizado aqui.
  if (funnel.PRODUCT_LIST) {
    await syncProductList(
      { accountId: cf.accountId, apiToken: cf.apiToken, databaseId: database.uuid },
      funnel.PRODUCT_LIST
    );
  }

  // 4. Dominio proprio (opcional — cai no workers.dev se nao der)
  const customUrl = await attachCustomDomain({
    ...cf,
    scriptName: SCRIPT_NAME,
    hostname: process.env.TRACKING_DOMAIN
  });

  const workerUrl = customUrl || workersDevUrl;
  await verifyWorker(workersDevUrl);

  // 5. GTM ja com a URL definitiva
  const gtmCtx = await setupGTM({
    accountId: process.env.GTM_ACCOUNT_ID,
    containerName: process.env.GTM_CONTAINER_NAME,
    measurementId: process.env.GA4_MEASUREMENT_ID,
    credentialsPath,
    workerUrl,
    funnel
  });

  await publishContainer({
    gtm: gtmCtx.gtm,
    workspacePath: gtmCtx.workspacePath,
    notes: `Worker: ${workerUrl}`
  });

  // 5b. Publicos de remarketing no GA4.
  if (ga4 && process.env.CREATE_AUDIENCES !== 'false') {
    try {
      await ensureAudiences(ga4.admin, ga4.property);
    } catch (err) {
      console.log(chalk.yellow('  aviso: ' + err.message));
    }
  }

  // 6. Validacao
  const smokeOk = await smokeTest(workersDevUrl, ctx);

  const containerId = gtmCtx.container.publicId;

  // 7. Guarda o resultado dentro do perfil
  const state = {
    workerUrl,
    workersDevUrl,
    customDomain: customUrl,
    containerId,
    databaseId: database.uuid,
    databaseName: database.name,
    workerName: SCRIPT_NAME,
    trackPageViews: TRACK_PAGE_VIEWS,
    smokeTestOk: smokeOk,
    metaEnabled: Boolean(conversions.META_PIXEL_ID && conversions.META_ACCESS_TOKEN),
    googleAdsEnabled: Boolean(
      conversions.GOOGLE_ADS_CUSTOMER_ID && conversions.GOOGLE_ADS_REFRESH_TOKEN
    ),
    lastRunAt: new Date().toISOString(),
    endpoints: {
      ga4: `${workerUrl}/g/collect`,
      collect: `${workerUrl}/collect`,
      webhook: `${workerUrl}/webhook`,
      snippet: `${workerUrl}/t.js`,
      health: `${workerUrl}/health`
    }
  };

  if (profileId) {
    // Guarda o id do D1 para as proximas execucoes nao procurarem de novo.
    saveProfile(profileId, { d1DatabaseId: database.uuid, d1DatabaseName: database.name });
    saveProfileState(profileId, state);
  }

  console.log(chalk.bgGreen.black.bold('\n Setup concluido '));
  console.log(`
${chalk.bold('Perfil')}             ${profile?.name || profileId}
${chalk.bold('Container GTM')}      ${containerId}
${chalk.bold('Banco D1')}           ${database.name} (${database.uuid})
${chalk.bold('Worker')}             ${workerUrl}${customUrl ? chalk.green('  ← dominio proprio') : ''}

${chalk.bold('Endpoints')}
  Webhook de vendas  ${workerUrl}/webhook
  Hits do GA4        ${workerUrl}/g/collect
  Eventos do site    ${workerUrl}/collect
  Snippet            ${workerUrl}/t.js
  Saude              ${workerUrl}/health

${chalk.bold('Proximos passos')}
  1. Instale o GTM no site: container ${containerId}.
  2. Na plataforma de venda, aponte os webhooks para ${workerUrl}/webhook
     — marque TODOS os eventos: compra aprovada, pix/boleto gerado, carrinho
     abandonado, reembolso e chargeback.
  3. Confira os dados no painel.

${chalk.bold('page_view')}          ${
    TRACK_PAGE_VIEWS
      ? 'gravado no banco'
      : 'nao gravado (economiza escrita do D1; o GA4 recebe normalmente)'
  }
${chalk.bold('Meta CAPI')}          ${state.metaEnabled ? chalk.green('ativo') : 'nao configurado'}
${chalk.bold('Google Ads offline')} ${state.googleAdsEnabled ? chalk.green('ativo') : 'nao configurado'}
`);
}

main().catch((error) => {
  console.error(chalk.red('\n=== Erro no Setup ==='));
  if (error.response && error.response.data) {
    console.error(chalk.red(JSON.stringify(error.response.data, null, 2)));
  } else {
    console.error(chalk.red(error.stack || error.message || error));
  }
  process.exit(1);
});
