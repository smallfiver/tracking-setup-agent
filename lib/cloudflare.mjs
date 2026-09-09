import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { cloudflareError } from './d1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..', 'worker');

const API = 'https://api.cloudflare.com/client/v4';

/** Monta o codigo final do worker com o snippet embutido. */
export function buildWorkerBundle() {
  const worker = fs.readFileSync(path.join(WORKER_DIR, 'worker.js'), 'utf-8');
  const snippet = fs.readFileSync(path.join(WORKER_DIR, 'snippet.js'), 'utf-8');
  // JSON.stringify cuida de todo o escape (aspas, quebras de linha, barras).
  return worker.replace("'__SNIPPET_SOURCE__'", JSON.stringify(snippet));
}

export async function deployWorker({
  accountId,
  apiToken,
  scriptName,
  databaseId,
  databaseName,
  measurementId,
  trackPageViews,
  trackEngagement,
  conversions = {},
  funnel = {},
  abandoned = {},
  productGa4Properties
}) {
  console.log(chalk.blue('→ Cloudflare: publicando Worker...'));

  const bindings = [
    { type: 'd1', name: 'DB', id: databaseId, database_name: databaseName },
    { type: 'plain_text', name: 'GA4_MEASUREMENT_ID', text: measurementId || '' },
    { type: 'plain_text', name: 'TRACK_PAGE_VIEWS', text: trackPageViews ? 'true' : 'false' },
    { type: 'plain_text', name: 'TRACK_ENGAGEMENT', text: trackEngagement ? 'true' : 'false' }
  ];

  // Listas de produtos que classificam a etapa do funil (order bump/upsell/downsell).
  // Vao como texto: nao sao segredo, e o Worker le direto do binding.
  //
  // PRODUCT_LIST fica de fora de proposito: cresce com cada landing page nova
  // e ja estourou o limite de 5.1kB de um binding de texto da Cloudflare. Mora
  // no D1 (tabela kv_config, escrita por syncProductList abaixo) — o Worker le
  // de la com cache curto. Ver loadProductList em worker/worker.js.
  const FUNNEL_VARS = [
    'FRONT_PRODUCT_IDS',
    'ORDER_BUMP_PRODUCT_IDS',
    'UPSELL_PRODUCT_IDS',
    'DOWNSELL_PRODUCT_IDS',
    'CHECKOUT_DOMAINS'
  ];
  for (const name of FUNNEL_VARS) {
    if (funnel[name]) bindings.push({ type: 'plain_text', name, text: String(funnel[name]) });
  }

  // Credenciais de envio de conversao. Ids publicos vao como texto; tokens
  // como secret, para nao aparecerem no codigo do Worker.
  const PUBLIC_VARS = [
    'META_PIXEL_ID',
    'META_TEST_EVENT_CODE',
    'GOOGLE_ADS_CUSTOMER_ID',
    'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    'GOOGLE_ADS_CONVERSION_ACTION_ID',
    'GOOGLE_ADS_CLIENT_ID',
    'CONVERSION_EVENTS'
  ];
  const SECRET_VARS = [
    'GA4_API_SECRET',
    'META_ACCESS_TOKEN',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN'
  ];

  for (const name of PUBLIC_VARS) {
    if (conversions[name]) bindings.push({ type: 'plain_text', name, text: String(conversions[name]) });
  }
  for (const name of SECRET_VARS) {
    if (conversions[name]) bindings.push({ type: 'secret_text', name, text: String(conversions[name]) });
  }

  // Recuperacao de carrinho abandonado: URL do webhook (texto) e token (secret).
  if (abandoned.ABANDONED_WEBHOOK_URL) {
    bindings.push({ type: 'plain_text', name: 'ABANDONED_WEBHOOK_URL', text: String(abandoned.ABANDONED_WEBHOOK_URL) });
  }
  if (abandoned.ABANDONED_WEBHOOK_TOKEN) {
    bindings.push({ type: 'secret_text', name: 'ABANDONED_WEBHOOK_TOKEN', text: String(abandoned.ABANDONED_WEBHOOK_TOKEN) });
  }

  // Mapa produto -> propriedade GA4 dedicada (Fase 3 do plano de GA4 por
  // produto). Vai como secret porque carrega o api_secret de cada propriedade.
  if (productGa4Properties) {
    bindings.push({ type: 'secret_text', name: 'PRODUCT_GA4_PROPERTIES', text: String(productGa4Properties) });
  }

  const enabled = [];
  if (conversions.META_PIXEL_ID && conversions.META_ACCESS_TOKEN) enabled.push('Meta CAPI');
  if (conversions.GOOGLE_ADS_CUSTOMER_ID && conversions.GOOGLE_ADS_REFRESH_TOKEN) {
    enabled.push('Google Ads offline');
  }
  console.log(
    chalk.gray(`  envio de conversoes: ${enabled.length ? enabled.join(' + ') : 'nao configurado'}`)
  );

  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-09-23',
    bindings
  };

  const form = new FormData();
  form.append('worker.js', buildWorkerBundle(), {
    filename: 'worker.js',
    contentType: 'application/javascript+module'
  });
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });

  try {
    await axios.put(`${API}/accounts/${accountId}/workers/scripts/${scriptName}`, form, {
      headers: { Authorization: `Bearer ${apiToken}`, ...form.getHeaders() },
      maxBodyLength: Infinity
    });
  } catch (err) {
    throw cloudflareError(err, 'Falha ao publicar o Worker');
  }

  let workerUrl = `https://${scriptName}.workers.dev`;
  try {
    const sub = await axios.get(`${API}/accounts/${accountId}/workers/subdomain`, {
      headers: { Authorization: `Bearer ${apiToken}` }
    });
    if (sub.data?.result?.subdomain) {
      workerUrl = `https://${scriptName}.${sub.data.result.subdomain}.workers.dev`;
    }

    await axios.post(
      `${API}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      { enabled: true },
      { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.log(chalk.yellow('  aviso: nao consegui configurar o subdominio workers.dev.'));
  }

  // Cron Trigger: recuperacao de abandono 1x/dia (12:00 UTC ~ 09:00 BRT).
  // Se nao houver webhook configurado, limpamos o agendamento (nao roda nada).
  try {
    const schedules = abandoned.ABANDONED_WEBHOOK_URL ? [{ cron: '0 12 * * *' }] : [];
    await axios.put(
      `${API}/accounts/${accountId}/workers/scripts/${scriptName}/schedules`,
      schedules,
      { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } }
    );
    if (schedules.length) {
      console.log(chalk.gray('  recuperacao de abandono: cron diario as 09:00 (BRT) ativo'));
    }
  } catch (err) {
    console.log(chalk.yellow('  aviso: nao consegui configurar o Cron Trigger de abandono.'));
  }

  console.log(chalk.green(`✓ Worker publicado: ${workerUrl}`));
  return workerUrl;
}

/**
 * Aponta um dominio proprio para o Worker (ex.: track.cliente.com).
 *
 * Isso deixa o cookie em primeira parte e escapa dos bloqueadores que derrubam
 * *.workers.dev. Exige que o dominio esteja na mesma conta Cloudflare.
 * Se nao der, o setup continua com o endereco workers.dev.
 */
export async function attachCustomDomain({ accountId, apiToken, scriptName, hostname }) {
  if (!hostname) return null;

  const clean = String(hostname).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean) return null;

  console.log(chalk.blue(`→ Cloudflare: apontando ${clean} para o Worker...`));
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  try {
    // A zona e o dominio raiz: track.cliente.com -> cliente.com
    const parts = clean.split('.');
    const candidates = [];
    for (let i = 0; i < parts.length - 1; i++) candidates.push(parts.slice(i).join('.'));

    let zone = null;
    for (const candidate of candidates) {
      const res = await axios.get(`${API}/zones`, { headers, params: { name: candidate } });
      if (res.data.result?.length) {
        zone = res.data.result[0];
        break;
      }
    }

    if (!zone) {
      console.log(
        chalk.yellow(
          `  aviso: o dominio ${clean} nao esta nesta conta Cloudflare. Adicione-o primeiro\n` +
            '  (Websites > Add a site) e rode de novo. Seguindo com o endereco workers.dev.'
        )
      );
      return null;
    }

    await axios.put(
      `${API}/accounts/${accountId}/workers/domains`,
      { environment: 'production', hostname: clean, service: scriptName, zone_id: zone.id },
      { headers }
    );

    const url = `https://${clean}`;
    console.log(chalk.green(`✓ Dominio proprio ativo: ${url}`));
    return url;
  } catch (err) {
    const detail = err?.response?.data?.errors?.[0]?.message || err.message;
    console.log(chalk.yellow(`  aviso: nao consegui configurar ${clean} (${detail}).`));
    console.log(chalk.yellow('  Seguindo com o endereco workers.dev — o rastreamento funciona igual.'));
    return null;
  }
}

/** Confere se o Worker esta de pe e conversando com o D1. */
export async function verifyWorker(workerUrl) {
  console.log(chalk.blue('→ Validando Worker...'));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.get(`${workerUrl}/health`, { timeout: 10000 });
      if (res.data?.ok) {
        console.log(chalk.green(`✓ Worker respondendo. Eventos no banco: ${res.data.events}`));
        return true;
      }
      console.log(chalk.yellow(`  banco inacessivel pelo Worker: ${res.data?.error}`));
      return false;
    } catch (err) {
      if (attempt === 5) {
        console.log(chalk.yellow(`  aviso: /health nao respondeu (${err.message}).`));
        return false;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}
