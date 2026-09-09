import dotenv from 'dotenv';
import chalk from 'chalk';
import { deployWorker, attachCustomDomain, verifyWorker } from '../lib/cloudflare.mjs';
import { syncProductList } from '../lib/d1.mjs';
import { readProfiles, getProfile, applyProfileToEnv } from '../lib/profiles.mjs';

/**
 * Republica so o Worker — sem tocar em GTM, GA4 ou banco.
 *
 * O setup.mjs completo leva minutos e mexe no container do GTM; quando a
 * mudanca e apenas de configuracao do Worker (dominio de checkout novo, produto
 * novo na lista), este atalho basta.
 *
 *   node scripts/deploy-worker.mjs
 *   node scripts/deploy-worker.mjs --profile=cliente-a
 *
 * Os bindings sao remontados do zero a cada publicacao (a API da Cloudflare
 * substitui a lista inteira), entao tudo vem do perfil — inclusive os secrets.
 */

dotenv.config();

const profileId =
  process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ||
  process.env.SETUP_PROFILE ||
  readProfiles().activeProfile;

const profile = getProfile(profileId);
if (!profile) throw new Error('Nenhum perfil configurado.');
applyProfileToEnv(profile);

const SCRIPT_NAME = process.env.WORKER_NAME || 'tracking-worker-agent';

const cf = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN
};

const pick = (names) => {
  const out = {};
  for (const n of names) if (process.env[n]) out[n] = process.env[n];
  return out;
};

const conversions = pick([
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
]);

const funnel = pick([
  'FRONT_PRODUCT_IDS',
  'ORDER_BUMP_PRODUCT_IDS',
  'UPSELL_PRODUCT_IDS',
  'DOWNSELL_PRODUCT_IDS',
  'PRODUCT_LIST',
  'CHECKOUT_DOMAINS'
]);

const abandoned = pick(['ABANDONED_WEBHOOK_URL', 'ABANDONED_WEBHOOK_TOKEN']);

// Sem o binding do D1 o Worker sobe mudo — melhor parar aqui do que descobrir
// pelo painel vazio no dia seguinte.
if (!process.env.CLOUDFLARE_D1_DATABASE_ID) {
  throw new Error('Perfil sem CLOUDFLARE_D1_DATABASE_ID. Rode o setup completo uma vez.');
}

console.log(chalk.blue(`→ Perfil: ${profile.name}`));
console.log(chalk.gray(`  checkouts: ${funnel.CHECKOUT_DOMAINS || '(nenhum extra)'}`));

const workersDevUrl = await deployWorker({
  ...cf,
  scriptName: SCRIPT_NAME,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME || `tracking-${SCRIPT_NAME}`,
  measurementId: process.env.GA4_MEASUREMENT_ID,
  trackPageViews: String(process.env.TRACK_PAGE_VIEWS) === 'true',
  trackEngagement: String(process.env.TRACK_ENGAGEMENT) === 'true',
  conversions,
  funnel,
  abandoned,
  productGa4Properties: process.env.PRODUCT_GA4_PROPERTIES
});

let url = workersDevUrl;
if (process.env.TRACKING_DOMAIN) {
  const custom = await attachCustomDomain({
    ...cf,
    scriptName: SCRIPT_NAME,
    hostname: process.env.TRACKING_DOMAIN
  });
  if (custom) url = custom;
}

// PRODUCT_LIST nao vai mais no binding do Worker (estoura o limite de 5.1kB
// da Cloudflare) — mora no D1, sincronizado aqui a cada deploy.
if (process.env.PRODUCT_LIST && process.env.CLOUDFLARE_D1_DATABASE_ID) {
  await syncProductList(
    { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN, databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID },
    process.env.PRODUCT_LIST
  );
  console.log(chalk.gray(`  PRODUCT_LIST sincronizado no D1 (${(process.env.PRODUCT_LIST.length / 1024).toFixed(1)}kB)`));
}

await verifyWorker(url);
console.log(chalk.green(`✓ Publicado em ${url}`));
console.log(chalk.gray('  o /t.js fica em cache de 60s na borda — aguarde antes de testar.'));
