import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Perfis — um por cliente/conta.
 *
 * Cada perfil guarda tudo que um cliente precisa: conta Cloudflare, banco D1,
 * container do GTM, GA4, nome do Worker e dominio de rastreamento. O painel
 * troca de perfil no seletor; o setup roda sempre o perfil ativo.
 *
 *   tracking.profiles.json -> perfis (gitignored, permissao 600)
 *   service-account.json   -> robo do Google, compartilhado entre os perfis
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROFILES_PATH = path.join(ROOT, 'tracking.profiles.json');
export const SERVICE_ACCOUNT_PATH = path.join(ROOT, 'service-account.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, 'tracking.config.json');

/** Campos de um perfil e a variavel de ambiente correspondente. */
export const ENV_MAP = {
  gtmAccountId: 'GTM_ACCOUNT_ID',
  gtmContainerName: 'GTM_CONTAINER_NAME',
  ga4MeasurementId: 'GA4_MEASUREMENT_ID',
  ga4PropertyId: 'GA4_PROPERTY_ID',
  ga4ApiSecret: 'GA4_API_SECRET',
  cloudflareApiToken: 'CLOUDFLARE_API_TOKEN',
  cloudflareAccountId: 'CLOUDFLARE_ACCOUNT_ID',
  d1DatabaseId: 'CLOUDFLARE_D1_DATABASE_ID',
  d1DatabaseName: 'CLOUDFLARE_D1_DATABASE_NAME',
  workerName: 'WORKER_NAME',
  trackingDomain: 'TRACKING_DOMAIN',

  // Etapas do funil — order bump / upsell / downsell (listas de produtos)
  frontProductIds: 'FRONT_PRODUCT_IDS',
  orderBumpProductIds: 'ORDER_BUMP_PRODUCT_IDS',
  upsellProductIds: 'UPSELL_PRODUCT_IDS',
  downsellProductIds: 'DOWNSELL_PRODUCT_IDS',

  // Lista de produtos para publicos e separacao por oferta
  productList: 'PRODUCT_LIST',

  // Propriedades GA4 dedicadas por produto (Fase 1 do plano de "GA4 por
  // produto") — JSON [{product, property, measurementId, apiSecret}]. Ainda
  // nao usado pelo Worker/snippet (isso e a Fase 3/4); guardado aqui so para
  // nao se perder entre a criacao e o roteamento.
  productGa4Properties: 'PRODUCT_GA4_PROPERTIES',

  // Containers GTM dedicados por produto (Fase 2) — JSON
  // [{product, containerId, containerPath, measurementId}].
  productGtmContainers: 'PRODUCT_GTM_CONTAINERS',

  // Dominios de checkout extras, alem dos ja reconhecidos por padrao
  checkoutDomains: 'CHECKOUT_DOMAINS',

  // Recuperacao de carrinho abandonado (Cron do Worker)
  abandonedWebhookUrl: 'ABANDONED_WEBHOOK_URL',
  abandonedWebhookToken: 'ABANDONED_WEBHOOK_TOKEN',

  // Meta CAPI
  metaPixelId: 'META_PIXEL_ID',
  metaAccessToken: 'META_ACCESS_TOKEN',
  metaTestEventCode: 'META_TEST_EVENT_CODE',

  // Google Ads — conversoes offline
  googleAdsCustomerId: 'GOOGLE_ADS_CUSTOMER_ID',
  googleAdsLoginCustomerId: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  googleAdsConversionActionId: 'GOOGLE_ADS_CONVERSION_ACTION_ID',
  googleAdsDeveloperToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
  googleAdsClientId: 'GOOGLE_ADS_CLIENT_ID',
  googleAdsClientSecret: 'GOOGLE_ADS_CLIENT_SECRET',
  googleAdsRefreshToken: 'GOOGLE_ADS_REFRESH_TOKEN'
};

export const SECRET_FIELDS = [
  'cloudflareApiToken',
  'metaAccessToken',
  'googleAdsDeveloperToken',
  'googleAdsClientSecret',
  'googleAdsRefreshToken',
  'abandonedWebhookToken',
  'ga4ApiSecret'
];
export const BOOLEAN_FIELDS = ['trackPageViews', 'createAudiences', 'trackEngagement'];

export const REQUIRED_FIELDS = [
  'gtmAccountId',
  'gtmContainerName',
  'ga4MeasurementId',
  'cloudflareApiToken',
  'cloudflareAccountId'
];

const EMPTY = { activeProfile: null, profiles: {} };

/** Slug estavel a partir do nome do cliente. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cliente';
}

export function readProfiles() {
  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8'));
    return { activeProfile: data.activeProfile || null, profiles: data.profiles || {} };
  } catch {
    return migrateLegacy();
  }
}

export function writeProfiles(data) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  });
  return PROFILES_PATH;
}

/** Traz a configuracao antiga (arquivo unico, era Turso) para o primeiro perfil. */
function migrateLegacy() {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf-8'));
    const name = legacy.gtmContainerName || 'Principal';
    const id = slugify(name);

    const profile = { name };
    for (const key of Object.keys(ENV_MAP)) {
      if (legacy[key]) profile[key] = legacy[key];
    }
    // O Turso saiu de cena; o D1 e criado no proximo setup.
    profile.trackPageViews = false;
    if (!profile.workerName) profile.workerName = `track-${id}`.slice(0, 54);
    if (!profile.d1DatabaseName) profile.d1DatabaseName = `tracking-${id}`.slice(0, 54);
    profile.updatedAt = new Date().toISOString();

    const data = { activeProfile: id, profiles: { [id]: profile } };
    writeProfiles(data);
    return data;
  } catch {
    return { ...EMPTY };
  }
}

export function getProfile(id) {
  const data = readProfiles();
  const key = id || data.activeProfile;
  return key ? data.profiles[key] || null : null;
}

export function getActiveProfile() {
  return getProfile(null);
}

/** Cria ou atualiza um perfil. Segredos vazios preservam o valor salvo. */
export function saveProfile(id, incoming) {
  const data = readProfiles();
  const key = id || slugify(incoming.name || incoming.gtmContainerName);
  const current = data.profiles[key] || {};
  const profile = { ...current };

  if (incoming.name !== undefined) profile.name = String(incoming.name).trim();

  for (const field of Object.keys(ENV_MAP)) {
    const value = incoming[field];
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed === '' && SECRET_FIELDS.includes(field)) continue;
    profile[field] = trimmed;
  }

  for (const field of BOOLEAN_FIELDS) {
    if (incoming[field] !== undefined) profile[field] = Boolean(incoming[field]);
  }

  if (!profile.name) profile.name = key;
  // Nomes padrao derivados do perfil, para o usuario nao precisar inventar.
  if (!profile.workerName) profile.workerName = `track-${key}`.slice(0, 54);
  if (!profile.d1DatabaseName) profile.d1DatabaseName = `tracking-${key}`.slice(0, 54);

  profile.updatedAt = new Date().toISOString();

  data.profiles[key] = profile;
  if (!data.activeProfile) data.activeProfile = key;
  writeProfiles(data);

  return { id: key, profile };
}

export function setActiveProfile(id) {
  const data = readProfiles();
  if (!data.profiles[id]) throw new Error(`Perfil nao encontrado: ${id}`);
  data.activeProfile = id;
  writeProfiles(data);
  return id;
}

export function deleteProfile(id) {
  const data = readProfiles();
  delete data.profiles[id];
  if (data.activeProfile === id) {
    data.activeProfile = Object.keys(data.profiles)[0] || null;
  }
  writeProfiles(data);
  return data;
}

/** Grava o resultado do ultimo setup dentro do proprio perfil. */
export function saveProfileState(id, state) {
  const data = readProfiles();
  if (!data.profiles[id]) return null;
  data.profiles[id].state = state;
  writeProfiles(data);
  return state;
}

/** Aplica o perfil ao ambiente; variaveis ja definidas tem precedencia. */
export function applyProfileToEnv(profile) {
  if (!profile) return process.env;
  for (const [field, envName] of Object.entries(ENV_MAP)) {
    if (!process.env[envName] && profile[field]) process.env[envName] = String(profile[field]);
  }
  if (profile.trackPageViews !== undefined && !process.env.TRACK_PAGE_VIEWS) {
    process.env.TRACK_PAGE_VIEWS = profile.trackPageViews ? 'true' : 'false';
  }
  if (profile.trackEngagement !== undefined && !process.env.TRACK_ENGAGEMENT) {
    process.env.TRACK_ENGAGEMENT = profile.trackEngagement ? 'true' : 'false';
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SERVICE_ACCOUNT_PATH;
  }
  return process.env;
}
