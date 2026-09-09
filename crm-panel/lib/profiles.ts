import fs from "fs";
import path from "path";

/**
 * Le e grava os mesmos perfis usados pelo setup.mjs
 * (tracking.profiles.json na raiz do agente).
 */

export const ENV_MAP: Record<string, string> = {
  gtmAccountId: "GTM_ACCOUNT_ID",
  gtmContainerName: "GTM_CONTAINER_NAME",
  ga4MeasurementId: "GA4_MEASUREMENT_ID",
  ga4PropertyId: "GA4_PROPERTY_ID",
  ga4ApiSecret: "GA4_API_SECRET",
  cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
  cloudflareAccountId: "CLOUDFLARE_ACCOUNT_ID",
  d1DatabaseId: "CLOUDFLARE_D1_DATABASE_ID",
  d1DatabaseName: "CLOUDFLARE_D1_DATABASE_NAME",
  workerName: "WORKER_NAME",
  trackingDomain: "TRACKING_DOMAIN",

  // Etapas do funil — order bump / upsell / downsell (listas de produtos)
  frontProductIds: "FRONT_PRODUCT_IDS",
  orderBumpProductIds: "ORDER_BUMP_PRODUCT_IDS",
  upsellProductIds: "UPSELL_PRODUCT_IDS",
  downsellProductIds: "DOWNSELL_PRODUCT_IDS",

  // Recuperação de carrinho abandonado (Cron do Worker)
  abandonedWebhookUrl: "ABANDONED_WEBHOOK_URL",
  abandonedWebhookToken: "ABANDONED_WEBHOOK_TOKEN",

  // Lista de produtos para publicos e separacao por oferta
  productList: "PRODUCT_LIST",

  // Dominios de checkout extras, alem dos ja reconhecidos por padrao
  checkoutDomains: "CHECKOUT_DOMAINS",

  // Meta CAPI
  metaPixelId: "META_PIXEL_ID",
  metaAccessToken: "META_ACCESS_TOKEN",
  metaTestEventCode: "META_TEST_EVENT_CODE",

  // Google Ads — conversoes offline
  googleAdsCustomerId: "GOOGLE_ADS_CUSTOMER_ID",
  googleAdsLoginCustomerId: "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  googleAdsConversionActionId: "GOOGLE_ADS_CONVERSION_ACTION_ID",
  googleAdsDeveloperToken: "GOOGLE_ADS_DEVELOPER_TOKEN",
  googleAdsClientId: "GOOGLE_ADS_CLIENT_ID",
  googleAdsClientSecret: "GOOGLE_ADS_CLIENT_SECRET",
  googleAdsRefreshToken: "GOOGLE_ADS_REFRESH_TOKEN",
};

export const SECRET_FIELDS = [
  "cloudflareApiToken",
  "metaAccessToken",
  "googleAdsDeveloperToken",
  "googleAdsClientSecret",
  "googleAdsRefreshToken",
  "abandonedWebhookToken",
  "ga4ApiSecret",
];
export const BOOLEAN_FIELDS = ["trackPageViews", "createAudiences", "trackEngagement"];

export const REQUIRED_FIELDS = [
  "gtmAccountId",
  "gtmContainerName",
  "ga4MeasurementId",
  "cloudflareApiToken",
  "cloudflareAccountId",
];

export const AGENT_ROOT = path.resolve(process.cwd(), "..");
export const PROFILES_PATH = path.join(AGENT_ROOT, "tracking.profiles.json");
export const SERVICE_ACCOUNT_PATH = path.join(AGENT_ROOT, "service-account.json");
const LEGACY_CONFIG_PATH = path.join(AGENT_ROOT, "tracking.config.json");

export type Profile = Record<string, any>;
export type ProfileStore = { activeProfile: string | null; profiles: Record<string, Profile> };

export function slugify(name: string): string {
  return (
    String(name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cliente"
  );
}

/**
 * Em servidor gerenciado (Vercel e afins) nao existe disco gravavel nem o
 * arquivo de perfis. Nesses casos a configuracao vem da variavel de ambiente
 * TRACKING_PROFILES, com o mesmo JSON do arquivo.
 */
export const SOMENTE_LEITURA = Boolean(process.env.VERCEL || process.env.TRACKING_PROFILES);

export function readProfiles(): ProfileStore {
  const doAmbiente = process.env.TRACKING_PROFILES;
  if (doAmbiente) {
    try {
      const data = JSON.parse(doAmbiente);
      return { activeProfile: data.activeProfile || null, profiles: data.profiles || {} };
    } catch {
      // JSON invalido no ambiente: cai para o arquivo, se houver.
    }
  }

  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf-8"));
    return { activeProfile: data.activeProfile || null, profiles: data.profiles || {} };
  } catch {
    return migrateLegacy();
  }
}

export function writeProfiles(data: ProfileStore): string {
  if (SOMENTE_LEITURA) {
    throw new Error(
      "Este painel esta em modo somente leitura (servidor gerenciado). " +
        "Edite os perfis na sua maquina e atualize a variavel TRACKING_PROFILES no deploy."
    );
  }
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return PROFILES_PATH;
}

/** Traz a configuracao antiga (arquivo unico, era Turso) para o primeiro perfil. */
function migrateLegacy(): ProfileStore {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf-8"));
    const name = legacy.gtmContainerName || "Principal";
    const id = slugify(name);
    const profile: Profile = { name, trackPageViews: false };
    for (const key of Object.keys(ENV_MAP)) if (legacy[key]) profile[key] = legacy[key];
    if (!profile.workerName) profile.workerName = `track-${id}`.slice(0, 54);
    if (!profile.d1DatabaseName) profile.d1DatabaseName = `tracking-${id}`.slice(0, 54);
    profile.updatedAt = new Date().toISOString();
    const data: ProfileStore = { activeProfile: id, profiles: { [id]: profile } };
    writeProfiles(data);
    return data;
  } catch {
    return { activeProfile: null, profiles: {} };
  }
}

export function getProfile(id?: string | null): Profile | null {
  const data = readProfiles();
  const key = id || data.activeProfile;
  return key ? data.profiles[key] || null : null;
}

export function getActiveProfileId(): string | null {
  return readProfiles().activeProfile;
}

/** Cria ou atualiza um perfil. Segredos vazios preservam o valor salvo. */
export function saveProfile(id: string | null, incoming: Record<string, any>) {
  const data = readProfiles();
  const key = id || slugify(incoming.name || incoming.gtmContainerName);
  const profile: Profile = { ...(data.profiles[key] || {}) };

  if (incoming.name !== undefined) profile.name = String(incoming.name).trim();

  for (const f of Object.keys(ENV_MAP)) {
    const value = incoming[f];
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed === "" && SECRET_FIELDS.includes(f)) continue;
    profile[f] = trimmed;
  }

  for (const f of BOOLEAN_FIELDS) {
    if (incoming[f] !== undefined) profile[f] = Boolean(incoming[f]);
  }

  if (!profile.name) profile.name = key;
  if (!profile.workerName) profile.workerName = `track-${key}`.slice(0, 54);
  if (!profile.d1DatabaseName) profile.d1DatabaseName = `tracking-${key}`.slice(0, 54);
  profile.updatedAt = new Date().toISOString();

  data.profiles[key] = profile;
  if (!data.activeProfile) data.activeProfile = key;
  writeProfiles(data);

  return { id: key, profile };
}

export function setActiveProfile(id: string): string {
  const data = readProfiles();
  if (!data.profiles[id]) throw new Error(`Perfil não encontrado: ${id}`);
  data.activeProfile = id;
  writeProfiles(data);
  return id;
}

export function deleteProfile(id: string): ProfileStore {
  const data = readProfiles();
  delete data.profiles[id];
  if (data.activeProfile === id) data.activeProfile = Object.keys(data.profiles)[0] || null;
  writeProfiles(data);
  return data;
}

export function hasServiceAccount(): boolean {
  return fs.existsSync(SERVICE_ACCOUNT_PATH);
}

/** Remove os segredos antes de enviar um perfil para o navegador. */
export function publicProfile(profile: Profile | null) {
  if (!profile) return null;
  const out: Record<string, any> = {};
  for (const key of Object.keys(ENV_MAP)) {
    if (!SECRET_FIELDS.includes(key)) out[key] = profile[key] || "";
  }
  for (const key of BOOLEAN_FIELDS) out[key] = Boolean(profile[key]);
  out.name = profile.name || "";
  out.updatedAt = profile.updatedAt || null;
  out.state = profile.state || null;
  out.secretsSaved = Object.fromEntries(SECRET_FIELDS.map((k) => [k, Boolean(profile[k])]));
  return out;
}
