import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { buildWorkerBundle } from '../lib/cloudflare.mjs';

// Monta o bundle do Worker (worker.js + snippet embutido) e o carrega.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(os.tmpdir(), `tracking-worker-${process.pid}.mjs`);
fs.writeFileSync(bundlePath, buildWorkerBundle());
process.on('exit', () => { try { fs.unlinkSync(bundlePath); } catch {} });

const worker = (await import('file://' + bundlePath.replace(/\\/g, '/'))).default;

const captured = [];

// Stub do fetch: GA4, Meta e Google Ads. O D1 e binding, nao passa por aqui.
globalThis.fetch = async (url, init) => {
  const u = String(url);

  // /mp/collect vem antes: a URL do Measurement Protocol tambem contem
  // "google-analytics.com" e cairia no proxy por engano.
  if (u.includes('/mp/collect')) {
    captured.push({ ga4mp: u, body: JSON.parse(init.body) });
    return { ok: true, status: 204, json: async () => ({}) };
  }
  if (u.includes('google-analytics.com')) {
    captured.push({ proxy: u });
    return { ok: true, json: async () => ({}) };
  }
  if (u.includes('graph.facebook.com')) {
    captured.push({ meta: u, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ events_received: 1 }) };
  }
  if (u.includes('oauth2.googleapis.com')) {
    captured.push({ oauth: true });
    return { ok: true, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
  }
  if (u.includes('googleads.googleapis.com')) {
    captured.push({ googleAds: u, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ results: [{}] }) };
  }
  if (u.includes('webhook.test')) {
    captured.push({ abandonedPost: u, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  }
  throw new Error('fetch inesperado: ' + u);
};

/** Linha devolvida pela costura de atribuicao, quando o teste quiser simula-la. */
let stitchRow = null;

/** Linhas de abandono devolvidas para a recuperacao (Cron), quando o teste pedir. */
let abandonedRows = null;

/** Linha de kv_config (PRODUCT_LIST no D1), quando o teste quiser simular o fallback. */
let kvConfigRow = null;

/** Conversoes ja "gravadas", para simular o indice unico anti-duplicata. */
const seenConversions = new Set();

/** Stub do binding D1: registra as statements e devolve resultados plausiveis. */
function fakeD1() {
  return {
    prepare(sql) {
      const stmt = {
        sql,
        params: [],
        bind(...params) {
          stmt.params = params;
          return stmt;
        },
        async run() {
          captured.push({ sql: stmt.sql, params: stmt.params });
          // conversions_log usa INSERT OR IGNORE: changes=0 significa duplicata.
          const isClaim = /INSERT OR IGNORE INTO conversions_log/i.test(stmt.sql);
          const duplicate = isClaim && seenConversions.has(stmt.params.slice(0, 3).join('|'));
          if (isClaim) seenConversions.add(stmt.params.slice(0, 3).join('|'));
          return {
            success: true,
            meta: { changes: duplicate ? 0 : 1, last_row_id: 1 }
          };
        },
        async all() {
          captured.push({ sql: stmt.sql, params: stmt.params });
          let results = [];
          if (/COUNT\(\*\) AS total/i.test(stmt.sql)) results = [{ total: 42 }];
          // A costura so devolve linha quando o teste pede — assim os demais
          // testes continuam vendo o cenario "nao achou evento anterior".
          else if (stitchRow && /FROM events WHERE/i.test(stmt.sql)) results = [stitchRow];
          else if (abandonedRows && /abandoned_checkout/i.test(stmt.sql) && /FROM\s+purchases/i.test(stmt.sql)) {
            results = abandonedRows;
          }
          else if (/FROM kv_config/i.test(stmt.sql)) results = kvConfigRow ? [kvConfigRow] : [];
          return { success: true, results };
        }
      };
      return stmt;
    }
  };
}

const env = {
  DB: fakeD1(),
  GA4_MEASUREMENT_ID: 'G-TEST',
  TRACK_PAGE_VIEWS: 'true'
};

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

async function call(url, init = {}) {
  captured.length = 0;
  pending.length = 0;
  const res = await worker.fetch(new Request(url, init), env, ctx);
  await Promise.all(pending);
  return res;
}

function show(title, ok, extra) {
  console.log((ok ? '  OK   ' : '  FALHA') + ' | ' + title + (extra ? ' -> ' + extra : ''));
  if (!ok) process.exitCode = 1;
}

function argsToObject(stmt) {
  const cols = stmt.sql.match(/\(([^)]+)\) VALUES/);
  if (!cols) return {};
  const names = cols[1].split(',').map((s) => s.trim());
  const out = {};
  names.forEach((n, i) => {
    out[n] = stmt.params[i] ?? null;
  });
  return out;
}

console.log('\n=== 1. GA4 /g/collect (GET) ===');
{
  const qs = new URLSearchParams({
    v: '2', tid: 'G-TEST', cid: '123.456', sid: '999', en: 'begin_checkout',
    dl: 'https://loja.com/checkout', dt: 'Checkout', cu: 'BRL',
    'ep.gclid': 'Cj0KCQ_TESTE', 'ep.fbp': 'fb.1.123.456', 'ep.tsid': 'visitor-1',
    'ep.transaction_id': 'ORD-1', 'epn.value': '197.5', 'ep.email': 'JOAO@Teste.com '
  });
  await call('https://w.dev/g/collect?' + qs.toString());
  const inserts = captured.filter((c) => c.sql && c.sql.startsWith('INSERT'));
  const row = argsToObject(inserts[0]);
  show('proxy para o GA4 real', captured.some((c) => c.proxy));
  show('event_name', row.event_name === 'begin_checkout', row.event_name);
  show('gclid capturado (ep.)', row.gclid === 'Cj0KCQ_TESTE', row.gclid);
  show('value numerico (epn.)', Number(row.value) === 197.5, row.value);
  show('transaction_id', row.transaction_id === 'ORD-1', row.transaction_id);
  show('email normalizado', row.email === 'joao@teste.com', row.email);
  show('tsid', row.tsid === 'visitor-1', row.tsid);
}

console.log('\n=== 2. GA4 /g/collect (POST em lote) ===');
{
  const body = [
    'en=view_item&ep.gclid=AAA&epn.value=10',
    'en=add_to_cart&ep.gclid=AAA&epn.value=20'
  ].join('\n');
  await call('https://w.dev/g/collect?v=2&tid=G-TEST&cid=1.2', { method: 'POST', body });
  const inserts = captured.filter((c) => c.sql && c.sql.startsWith('INSERT'));
  show('2 eventos gravados do lote', inserts.length === 2, String(inserts.length));
  show('segundo evento correto', argsToObject(inserts[1]).event_name === 'add_to_cart');
}

console.log('\n=== 3. OPTIONS (preflight CORS) ===');
{
  const res = await call('https://w.dev/g/collect', { method: 'OPTIONS' });
  show('204 no preflight', res.status === 204, String(res.status));
  show('header CORS presente', !!res.headers.get('Access-Control-Allow-Origin'));
}

console.log('\n=== 4. /collect (snippet, dados completos) ===');
{
  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_name: 'initiate_checkout',
      tsid: 'visitor-9', gclid: 'GCL-9', utm_campaign: 'black-friday',
      value: 297, currency: 'BRL',
      customer: { email: 'Maria@Loja.com', phone: '(11) 98888-7777', name: 'Maria' }
    })
  });
  const inserts = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO events'));
  const row = argsToObject(inserts[0]);
  show('evento gravado', !!row.event_name, row.event_name);
  show('telefone E.164', row.phone === '+5511988887777', row.phone);
  show('utm_campaign', row.utm_campaign === 'black-friday');
  show('lead criado/atualizado', captured.some((c) => c.sql && c.sql.includes('leads')));
}

console.log('\n=== 5. Webhook Kiwify (compra aprovada) ===');
{
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      order_id: 'KWF-123',
      order_status: 'paid',
      webhook_event_type: 'order_approved',
      Customer: { full_name: 'Joao Silva', email: 'joao@teste.com', mobile: '11977776666', CPF: '12345678900' },
      Commissions: { charge_amount: 19700, my_commission: 15000 },
      product_id: 'PROD-1',
      TrackingParameters: { utm_source: 'google', gclid: 'GCLID-WEBHOOK' }
    })
  });
  const p = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO purchases'));
  const row = argsToObject(p[0]);
  show('plataforma detectada', row.platform === 'kiwify', row.platform);
  show('status -> purchase', row.event_name === 'purchase', row.event_name);
  show('valor em centavos convertido', Number(row.value) === 197, row.value);
  show('cliente capturado', row.customer_email === 'joao@teste.com' && row.customer_name === 'Joao Silva');
  show('CPF capturado', row.customer_document === '12345678900');
  show('telefone E.164', row.customer_phone === '+5511977776666', row.customer_phone);
  show('gclid do webhook', row.gclid === 'GCLID-WEBHOOK');
  show('atribuicao = webhook', row.attribution_source === 'webhook', row.attribution_source);
  show('espelhado em events', captured.some((c) => c.sql && c.sql.includes('INSERT OR IGNORE INTO events')));
}

console.log('\n=== 6. Webhook Hotmart (pix gerado, sem click id) ===');
{
  await call('https://w.dev/webhook/hotmart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hottok: 'x',
      data: {
        purchase: { transaction: 'HP-999', status: 'waiting_payment', price: { value: 97.9 } },
        buyer: { name: 'Ana', email: 'ana@teste.com', phone: '11955554444' },
        product: { id: 'P9', name: 'Curso' }
      }
    })
  });
  const p = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO purchases'));
  const row = argsToObject(p[0]);
  show('plataforma pela URL', row.platform === 'hotmart', row.platform);
  show('status -> pix_generated', row.event_name === 'pix_generated', row.event_name);
  show('valor aninhado', Number(row.value) === 97.9, row.value);
  show('transaction_id aninhado', row.transaction_id === 'HP-999', row.transaction_id);
  show('produto', row.product_name === 'Curso');
  show('tentou costurar atribuicao', captured.some((c) => c.sql && c.sql.includes('FROM events WHERE')));
}

console.log('\n=== 7. Webhook form-urlencoded (carrinho abandonado) ===');
{
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'code_order=PP-1&status=abandoned_cart&email=lead@teste.com&value=147,90&name=Carlos'
  });
  const p = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO purchases'));
  const row = argsToObject(p[0]);
  show('form-urlencoded parseado', row.transaction_id === 'PP-1', row.transaction_id);
  show('status -> abandoned_checkout', row.event_name === 'abandoned_checkout', row.event_name);
  show('valor pt-BR (147,90)', Number(row.value) === 147.9, row.value);
}

console.log('\n=== 8. Webhook reembolso ===');
{
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'R-1', status: 'refunded', value: 50, email: 'x@y.com' })
  });
  const p = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO purchases'));
  show('status -> refund', argsToObject(p[0]).event_name === 'refund');
}

console.log('\n=== 9. /t.js e /health ===');
{
  const js = await call('https://meu-worker.dev/t.js');
  const text = await js.text();
  show('snippet servido', text.includes('tsTrack'));
  show('endpoint injetado', text.includes('https://meu-worker.dev') && !text.includes('__ENDPOINT__'));
  show('content-type js', (js.headers.get('content-type') || '').includes('javascript'));

  const h = await call('https://w.dev/health');
  const body = await h.json();
  show('health ok', body.ok === true && body.events === 42, JSON.stringify(body));
  show('reporta backend d1', body.database === 'd1');
}

console.log('\n=== 10. Parametros do D1 ===');
{
  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'page_view' })
  });
  const insert = captured.find((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO events'));
  const row = argsToObject(insert);
  show('nulos viram null nativo', insert.params.some((p) => p === null));
  show('sem objetos nao serializados', insert.params.every((p) => p === null || typeof p !== 'object'));
  show('currency default BRL', row.currency === 'BRL');

  const numericIdx = insert.sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim()).indexOf('value');
  show('coluna numerica vazia vira null', insert.params[numericIdx] === null);
}

console.log('\n=== 11. page_view desligado (padrao) ===');
{
  const saved = env.TRACK_PAGE_VIEWS;
  env.TRACK_PAGE_VIEWS = 'false';

  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'page_view' })
  });
  const pv = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO events'));
  show('page_view nao vai ao banco', pv.length === 0, `${pv.length} insert(s)`);

  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'purchase', value: 97 })
  });
  const conv = captured.filter((c) => c.sql && c.sql.startsWith('INSERT OR IGNORE INTO events'));
  show('conversao continua gravando', conv.length === 1, `${conv.length} insert(s)`);

  // O GA4 recebe o pageview de qualquer forma.
  await call('https://w.dev/g/collect?v=2&tid=G-TEST&cid=1.2&en=page_view');
  show('GA4 ainda recebe o pageview', captured.some((c) => c.proxy));

  env.TRACK_PAGE_VIEWS = saved;
}

console.log('\n=== 12. Meta CAPI e Google Ads (venda aprovada) ===');
{
  Object.assign(env, {
    META_PIXEL_ID: '111222333',
    META_ACCESS_TOKEN: 'EAAtoken',
    GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
    GOOGLE_ADS_CONVERSION_ACTION_ID: '987654',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'devtoken',
    GOOGLE_ADS_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: '1//refresh',
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: '555-666-7777'
  });
  seenConversions.clear();

  await call('https://w.dev/webhook/kiwify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      order_id: 'VENDA-777',
      order_status: 'paid',
      Customer: { full_name: 'Maria Souza', email: 'MARIA@Teste.com', mobile: '(11) 98888-7777', city: 'São Paulo', state: 'SP', zipcode: '01310-100' },
      Commissions: { charge_amount: 29700 },
      TrackingParameters: { gclid: 'GCLID-777', fbc: 'fb.1.123.abc', fbp: 'fb.1.456.def' }
    })
  });

  // --- Meta ---
  const meta = captured.find((c) => c.meta);
  show('enviou para o Meta', !!meta);
  const ev = meta?.body?.data?.[0];
  show('evento traduzido para Purchase', ev?.event_name === 'Purchase', ev?.event_name);
  show('event_id estavel (dedup com o pixel)', ev?.event_id === 'purchase:VENDA-777', ev?.event_id);
  show('valor e moeda', ev?.custom_data?.value === 297 && ev?.custom_data?.currency === 'BRL');
  show('order_id enviado', ev?.custom_data?.order_id === 'VENDA-777');
  show('fbc/fbp em texto puro', ev?.user_data?.fbc === 'fb.1.123.abc' && ev?.user_data?.fbp === 'fb.1.456.def');

  const SHA256_HEX = /^[a-f0-9]{64}$/;
  show('email com hash', SHA256_HEX.test(ev?.user_data?.em?.[0] || ''), (ev?.user_data?.em?.[0] || '').slice(0, 16) + '...');
  show('telefone com hash', SHA256_HEX.test(ev?.user_data?.ph?.[0] || ''));
  show('cidade/estado/CEP com hash', ['ct', 'st', 'zp'].every((k) => SHA256_HEX.test(ev?.user_data?.[k]?.[0] || '')));
  show('nenhum dado pessoal em texto puro',
    !JSON.stringify(ev.user_data).toLowerCase().includes('maria') &&
    !JSON.stringify(ev.user_data).includes('98888'));

  // Hash correto: email normalizado (minusculo, sem espaco) -> SHA-256
  const expected = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('maria@teste.com')))
  ).map((b) => b.toString(16).padStart(2, '0')).join('');
  show('hash bate com o esperado pelo Meta', ev?.user_data?.em?.[0] === expected);

  // --- Google Ads ---
  show('renovou o token OAuth', captured.some((c) => c.oauth));
  const ads = captured.find((c) => c.googleAds);
  show('enviou para o Google Ads', !!ads);
  show('customer id sem tracos na URL', (ads?.googleAds || '').includes('/customers/1234567890:uploadClickConversions'));
  show('developer-token no header', ads?.headers?.['developer-token'] === 'devtoken');
  show('login-customer-id sem tracos', ads?.headers?.['login-customer-id'] === '5556667777');

  const conv = ads?.body?.conversions?.[0];
  show('gclid enviado', conv?.gclid === 'GCLID-777', conv?.gclid);
  show('valor da venda', conv?.conversionValue === 297, String(conv?.conversionValue));
  show('conversionAction montado', conv?.conversionAction === 'customers/1234567890/conversionActions/987654');
  show('data no formato do Google', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(conv?.conversionDateTime || ''), conv?.conversionDateTime);
  show('orderId para deduplicar', conv?.orderId === 'VENDA-777');
}

console.log('\n=== 13. Webhook repetido nao envia de novo ===');
{
  const body = JSON.stringify({
    order_id: 'VENDA-777',
    order_status: 'paid',
    Customer: { email: 'maria@teste.com' },
    Commissions: { charge_amount: 29700 },
    TrackingParameters: { gclid: 'GCLID-777' }
  });
  // seenConversions ja tem VENDA-777 do teste anterior — simula o indice unico.
  await call('https://w.dev/webhook/kiwify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  show('nao reenviou ao Meta', !captured.some((c) => c.meta));
  show('nao reenviou ao Google Ads', !captured.some((c) => c.googleAds));
}

console.log('\n=== 14. Sem credencial, nao tenta enviar ===');
{
  for (const k of ['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_REFRESH_TOKEN']) {
    delete env[k];
  }
  seenConversions.clear();

  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'SEM-CRED', status: 'paid', value: 50, gclid: 'X' })
  });
  show('nenhuma chamada externa', !captured.some((c) => c.meta || c.googleAds || c.oauth));
  show('venda continua sendo gravada', captured.some((c) => c.sql?.includes('INSERT OR IGNORE INTO purchases')));
}

console.log('\n=== 15. Evento sem click ID do Google nao vai ao Google Ads ===');
{
  Object.assign(env, {
    META_PIXEL_ID: '111',
    META_ACCESS_TOKEN: 'tok',
    GOOGLE_ADS_CUSTOMER_ID: '1234567890',
    GOOGLE_ADS_CONVERSION_ACTION_ID: '987',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
    GOOGLE_ADS_CLIENT_ID: 'cid',
    GOOGLE_ADS_CLIENT_SECRET: 'sec',
    GOOGLE_ADS_REFRESH_TOKEN: '1//r'
  });
  seenConversions.clear();

  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'SO-META', status: 'paid', value: 80, email: 'x@y.com', fbc: 'fb.1.1.a' })
  });
  show('Meta recebe (tem fbc)', captured.some((c) => c.meta));
  show('Google Ads e pulado (sem gclid)', !captured.some((c) => c.googleAds));
}

console.log('\n=== 16. Dominio (varias landing pages no mesmo container) ===');
{
  for (const k of ['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_REFRESH_TOKEN']) {
    delete env[k];
  }

  // Evento vindo do snippet
  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_name: 'begin_checkout',
      page_location: 'https://www.landing-a.com.br/oferta?utm_source=google'
    })
  });
  let row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));
  show('dominio extraido da URL', row.hostname === 'landing-a.com.br', row.hostname);
  show('www removido', !String(row.hostname).startsWith('www.'));

  // Hit do GA4
  await call('https://w.dev/g/collect?v=2&tid=G-T&cid=1.2&en=add_to_cart&dl=' +
    encodeURIComponent('https://landing-b.com/pagina'));
  row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));
  show('dominio tambem no hit do GA4', row.hostname === 'landing-b.com', row.hostname);

  // URL invalida nao quebra
  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'generate_lead', page_location: 'nao-e-url' })
  });
  row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));
  show('URL invalida vira null (sem quebrar)', row.hostname === null, String(row.hostname));
}

console.log('\n=== 17. Venda herda o dominio pela costura ===');
{
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'D-1', status: 'paid', value: 100, email: 'a@b.com' })
  });
  const stitchQuery = captured.find((c) => c.sql?.includes('FROM events WHERE'));
  show('busca o dominio junto com a atribuicao', stitchQuery?.sql.includes('hostname'));

  const p = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('coluna hostname existe na venda', 'hostname' in p);
}

console.log('\n=== 18. Ruido automatico do GA4 nao vai ao banco ===');
{
  for (const noise of ['user_engagement', 'scroll', 'first_visit', 'session_start']) {
    await call(`https://w.dev/g/collect?v=2&tid=G-T&cid=1.2&en=${noise}`);
    const stored = captured.filter((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events'));
    show(`${noise} descartado`, stored.length === 0, `${stored.length} insert(s)`);
    show(`${noise} ainda vai ao GA4`, captured.some((c) => c.proxy));
  }

  await call('https://w.dev/g/collect?v=2&tid=G-T&cid=1.2&en=purchase&ep.gclid=G1');
  show('conversao continua sendo gravada',
    captured.some((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));

  // O evento "landing" do snippet e a ancora da atribuicao: nunca pode ser filtrado.
  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'landing', tsid: 'v1', gclid: 'G-ANCORA' })
  });
  const anchor = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));
  show('landing gravado (ancora da atribuicao)', anchor.event_name === 'landing', anchor.event_name);
  show('landing carrega o gclid', anchor.gclid === 'G-ANCORA');
}

console.log('\n=== 19. Order bump / upsell / downsell classificados pelo produto ===');
{
  for (const k of ['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_REFRESH_TOKEN']) {
    delete env[k];
  }
  Object.assign(env, {
    FRONT_PRODUCT_IDS: 'PROD-FRONT',
    ORDER_BUMP_PRODUCT_IDS: 'BUMP-1, garantia-estendida',
    UPSELL_PRODUCT_IDS: 're:UPSELL\\d+',
    DOWNSELL_PRODUCT_IDS: 'DOWN-9'
  });

  const casos = [
    ['PROD-FRONT', 'front'],
    ['BUMP-1', 'order_bump'],
    ['UPSELL42', 'upsell'],
    ['DOWN-9', 'downsell'],
    ['PRODUTO-DESCONHECIDO', 'front'] // sem casar -> front (padrao seguro)
  ];

  for (const [productId, esperado] of casos) {
    await call('https://w.dev/webhook/kiwify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        order_id: 'OB-' + productId,
        order_status: 'paid',
        Customer: { email: 'cliente@funil.com' },
        Commissions: { charge_amount: 4700 },
        product_id: productId
      })
    });
    const p = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
    show(`${productId} -> ${esperado}`, p.purchase_type === esperado, p.purchase_type);
  }

  // A etapa tambem chega no espelho de events (para o funil do painel).
  const ev = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));
  show('purchase_type espelhado em events', 'purchase_type' in ev);

  for (const k of ['FRONT_PRODUCT_IDS', 'ORDER_BUMP_PRODUCT_IDS', 'UPSELL_PRODUCT_IDS', 'DOWNSELL_PRODUCT_IDS']) {
    delete env[k];
  }
}

console.log('\n=== 20. Venda do webhook chega no GA4 (Measurement Protocol) ===');
{
  for (const k of ['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_REFRESH_TOKEN']) {
    delete env[k];
  }
  env.GA4_MEASUREMENT_ID = 'G-TEST';
  env.GA4_API_SECRET = 'segredo-mp';
  seenConversions.clear();

  // Simula a navegacao anterior que a costura vai encontrar — e dela que sai o
  // client_id do GA4, sem o qual o Measurement Protocol recusa o evento.
  stitchRow = { client_id: '111.222', tsid: 'v-ga4', gclid: 'G-CLICK', utm_source: 'google' };

  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: 'GA4-VENDA',
      status: 'paid',
      value: 197,
      email: 'ga4@teste.com'
    })
  });

  const mp = captured.find((c) => c.ga4mp);
  show('enviou para o GA4', !!mp);
  show('measurement_id na URL', (mp?.ga4mp || '').includes('measurement_id=G-TEST'));
  show('api_secret na URL', (mp?.ga4mp || '').includes('api_secret=segredo-mp'));
  show('evento purchase', mp?.body?.events?.[0]?.name === 'purchase', mp?.body?.events?.[0]?.name);
  show('client_id preenchido', !!mp?.body?.client_id, mp?.body?.client_id);
  show('valor e moeda', mp?.body?.events?.[0]?.params?.value === 197);
  show('transaction_id', mp?.body?.events?.[0]?.params?.transaction_id === 'GA4-VENDA');

  // Reenvio do mesmo webhook nao duplica no GA4
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'GA4-VENDA', status: 'paid', value: 197, email: 'ga4@teste.com' })
  });
  show('nao reenvia duplicado', !captured.some((c) => c.ga4mp));
  stitchRow = null;
}

console.log('\n=== 21. Sem segredo do GA4, nao tenta enviar ===');
{
  delete env.GA4_API_SECRET;
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'SEM-MP', status: 'paid', value: 50, email: 'x@y.com' })
  });
  show('nenhuma chamada ao GA4', !captured.some((c) => c.ga4mp));
  show('venda continua gravada', captured.some((c) => c.sql?.includes('INSERT OR IGNORE INTO purchases')));
}

console.log('\n=== 22. Dispositivo, navegador e sistema ===');
{
  const UAS = [
    ['Mozilla/5.0 (Linux; Android 14; moto g04) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36', 'mobile', 'Chrome', 'Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'mobile', 'Safari', 'iOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'desktop', 'Chrome', 'Windows'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1 Version/17.0 Safari/604.1', 'tablet', 'Safari', 'iOS'],
    // Navegador interno do app: converte pior, precisa aparecer separado
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1 [FBAN/FBIOS;FBAV/449.0]', 'mobile', 'Facebook (app)', 'iOS'],
    ['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 Instagram 300.0', 'mobile', 'Instagram (app)', 'Android']
  ];

  for (const [ua, device, browser, os] of UAS) {
    await call('https://w.dev/collect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': ua },
      body: JSON.stringify({ event_name: 'initiate_checkout', tsid: 'ua-' + browser })
    });
    const row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));
    show(
      `${browser} / ${os} / ${device}`,
      row.device_type === device && row.browser === browser && row.os === os,
      `${row.device_type} / ${row.browser} / ${row.os}`
    );
  }
}

console.log('\n=== 23. Engajamento vai ao GA4, nunca ao banco ===');
{
  // Estes eventos chegaram a 25 mil por hora e encheram o limite de 10 GB do
  // D1, derrubando o rastreamento. Nao alimentam nenhuma tela do painel e o
  // GA4 ja os tem, entao nao sao gravados — nem com TRACK_ENGAGEMENT ligado,
  // que hoje significa apenas "o snippet gera estes eventos para o GA4".
  for (const ligado of ['true', 'false']) {
    env.TRACK_ENGAGEMENT = ligado;

    for (const evento of ['scroll&epn.percent_scrolled=75', 'video_progress&epn.video_percent=50', 'user_engagement&_et=15300']) {
      captured.length = 0;
      await call(`https://w.dev/g/collect?v=2&tid=G-T&cid=1.2&en=${evento}`);
      const gravou = captured.some((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events'));
      const foiAoGa4 = captured.some((c) => c.proxy);
      const nome = evento.split('&')[0];
      show(`TRACK_ENGAGEMENT=${ligado}: ${nome} nao ocupa o banco`, !gravou);
      show(`TRACK_ENGAGEMENT=${ligado}: ${nome} continua indo para o GA4`, foiAoGa4);
    }
  }
  env.TRACK_ENGAGEMENT = 'true';
}

console.log('\n=== 24. Cupom, valor original, primeiro nome e hashes ===');
{
  seenConversions.clear();
  await call('https://w.dev/webhook/kirvano', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sale_id: 'CUPOM-1',
      checkout_id: 'CK-2',
      status: 'paid',
      coupon_code: 'DESCONTO20',
      customer: { name: 'Maria Aparecida Souza', email: 'MARIA@Loja.com', phone_number: '(11) 98888-7777' },
      fiscal: { total_value: 157.6, original_value: 197 }
    })
  });
  const row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));

  show('cupom capturado', row.coupon_code === 'DESCONTO20', row.coupon_code);
  show('valor com desconto', Number(row.value) === 157.6, row.value);
  show('valor original', Number(row.original_value) === 197, row.original_value);
  // Comparacao com tolerancia: 197 - 157.6 da 39.400000000000006 em ponto flutuante.
  show('desconto calculavel', Math.abs(Number(row.original_value) - Number(row.value) - 39.4) < 0.01);
  show('primeiro nome isolado', row.first_name === 'Maria', row.first_name);
  show('nome completo preservado', row.customer_name === 'Maria Aparecida Souza');

  const SHA = /^[a-f0-9]{64}$/;
  show('email com hash', SHA.test(row.email_hash || ''), (row.email_hash || '').slice(0, 12) + '...');
  show('telefone com hash', SHA.test(row.phone_hash || ''));

  // O hash tem que bater com o que Meta e Google esperam (minusculo, sem espaco)
  const esperado = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('maria@loja.com')))
  ).map((b) => b.toString(16).padStart(2, '0')).join('');
  show('hash confere com o padrao das plataformas', row.email_hash === esperado);
}

console.log('\n=== 25. Venda herda dispositivo e regiao pela costura ===');
{
  seenConversions.clear();
  stitchRow = {
    client_id: '1.2', tsid: 'v', gclid: 'G-1', utm_source: 'google',
    device_type: 'mobile', browser: 'Chrome', os: 'Android',
    geo_country: 'BR', geo_region: 'Sao Paulo', geo_city: 'Campinas'
  };
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'GEO-1', status: 'paid', value: 97, email: 'geo@teste.com' })
  });
  const row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('dispositivo na venda', row.device_type === 'mobile' && row.browser === 'Chrome' && row.os === 'Android',
    `${row.device_type}/${row.browser}/${row.os}`);
  show('cidade e estado na venda', row.geo_city === 'Campinas' && row.geo_region === 'Sao Paulo',
    `${row.geo_city}/${row.geo_region}`);
  stitchRow = null;
}

console.log('\n=== 26. Dominios de checkout configuraveis ===');
{
  // O snippet servido carrega a lista do binding.
  env.CHECKOUT_DOMAINS = 'go.centerpag.com, checkout.perfectpay.com.br';
  const js = await (await call('https://w.dev/t.js')).text();
  show('lista injetada no snippet', js.includes('go.centerpag.com'), '');
  show('placeholder substituido', !js.includes('__CHECKOUT_DOMAINS__'));

  // O dominio configurado nao pode ser confundido com a origem da venda.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: 'CFG-1',
      status: 'paid',
      value: 97,
      email: 'cfg@teste.com',
      url: 'https://go.centerpag.com/abc123'
    })
  });
  let row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('centerpag nao vira hostname da venda', row.hostname === null, String(row.hostname));

  // A Kirvano tem que continuar exatamente como estava.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: 'KIR-1',
      status: 'paid',
      value: 97,
      email: 'k@teste.com',
      url: 'https://pay.kirvano.com/69b64441'
    })
  });
  row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('kirvano segue ignorada como origem', row.hostname === null, String(row.hostname));

  // A landing de verdade continua sendo gravada.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: 'LP-1',
      status: 'paid',
      value: 97,
      email: 'lp@teste.com',
      url: 'https://minhaoferta.com.br/vsl'
    })
  });
  row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('landing normal continua virando hostname', row.hostname === 'minhaoferta.com.br', String(row.hostname));

  // Sem configuracao, nada muda em relacao ao comportamento antigo.
  delete env.CHECKOUT_DOMAINS;
  const jsSemConfig = await (await call('https://w.dev/t.js')).text();
  show('sem configuracao o snippet continua valido', !jsSemConfig.includes('__CHECKOUT_DOMAINS__'));

  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transaction_id: 'SEMCFG-1',
      status: 'paid',
      value: 97,
      email: 's@teste.com',
      url: 'https://pay.kirvano.com/x'
    })
  });
  row = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('kirvano ignorada mesmo sem configuracao', row.hostname === null, String(row.hostname));
}

console.log('\n=== 27. Costura pelo gclid recupera o client_id do GA4 ===');
{
  env.GA4_MEASUREMENT_ID = 'G-TEST';
  env.GA4_API_SECRET = 'segredo-mp';
  seenConversions.clear();

  // Cenario real: a Kirvano devolve o gclid mas nunca o client_id do GA4.
  // A navegacao daquele mesmo clique tem os dois.
  stitchRow = {
    client_id: '1244369265.1778542874',
    session_id: '1785200000',
    tsid: 'visitante-1',
    gclid: 'Cj0KCQjw4JbTBhCo',
    utm_source: 'google'
  };

  await call('https://w.dev/webhook/kirvano', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sale_id: 'GCLID-STITCH',
      checkout_id: 'CK-1',
      status: 'paid',
      customer: { name: 'Teste', email: 'gclidstitch@teste.com' },
      fiscal: { total_value: 97 },
      cookies: { gclid: 'Cj0KCQjw4JbTBhCo' }
    })
  });

  const busca = captured.find((c) => c.sql?.includes('FROM events WHERE'));
  show('a costura procura por gclid', busca?.sql.includes('gclid = ?'));
  show('ignora o espelho do proprio webhook', busca?.sql.includes("source != 'webhook'"));
  show('prioriza evento com client_id', busca?.sql.includes('(client_id IS NOT NULL) DESC'));

  const venda = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('client_id recuperado', venda.client_id === '1244369265.1778542874', venda.client_id);
  show('session_id recuperado', venda.session_id === '1785200000', venda.session_id);

  const mp = captured.find((c) => c.ga4mp);
  show('agora a venda CHEGA no GA4', !!mp);
  show('com o client_id certo', mp?.body?.client_id === '1244369265.1778542874');

  stitchRow = null;
}

console.log('\n=== 28. Sem client_id, o motivo fica registrado ===');
{
  seenConversions.clear();
  stitchRow = null; // nenhuma navegacao para costurar

  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'SEM-CID', status: 'paid', value: 97, email: 'x@y.com' })
  });

  show('nao tenta enviar ao GA4', !captured.some((c) => c.ga4mp));

  const log = captured.filter((c) => c.sql?.includes('UPDATE conversions_log'));
  const skipped = log.find((c) => c.params?.[0] === 'skipped');
  show('registra como "skipped"', !!skipped, skipped?.params?.[0]);
  show('com o motivo explicado', String(skipped?.params?.[1] || '').includes('client_id'));
}

console.log('\n=== 29. Pix e abandono chegam ao GA4, mas nao aos anuncios ===');
{
  Object.assign(env, {
    GA4_MEASUREMENT_ID: 'G-TEST',
    GA4_API_SECRET: 'segredo-mp',
    META_PIXEL_ID: '111',
    META_ACCESS_TOKEN: 'tok',
    GOOGLE_ADS_CUSTOMER_ID: '1234567890',
    GOOGLE_ADS_CONVERSION_ACTION_ID: '987',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
    GOOGLE_ADS_CLIENT_ID: 'cid',
    GOOGLE_ADS_CLIENT_SECRET: 'sec',
    GOOGLE_ADS_REFRESH_TOKEN: '1//r'
  });
  stitchRow = { client_id: '1.2', tsid: 'v', gclid: 'G-1', utm_source: 'google' };

  // Pix gerado: alimenta publico de remarketing, mas nao deve guiar o lance.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'PIX-GA4', status: 'pending', value: 97, email: 'p@t.com' })
  });
  show('pix_generated CHEGA no GA4', captured.some((c) => c.ga4mp));
  show('pix nao vai para o Meta', !captured.some((c) => c.meta));
  show('pix nao vai para o Google Ads', !captured.some((c) => c.googleAds));

  // Carrinho abandonado: mesma logica.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'ABD-GA4', status: 'abandoned_cart', value: 97, email: 'a@t.com' })
  });
  show('abandoned_checkout CHEGA no GA4', captured.some((c) => c.ga4mp));
  show('abandono nao vai para os anuncios', !captured.some((c) => c.meta || c.googleAds));

  // A compra continua indo para os tres.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'CMP-GA4', status: 'paid', value: 97, email: 'c@t.com' })
  });
  show('compra vai para o GA4', captured.some((c) => c.ga4mp));
  show('compra vai para o Meta', captured.some((c) => c.meta));
  show('compra vai para o Google Ads', captured.some((c) => c.googleAds));

  // Checkout expirado/cancelado: mesma logica do abandono — alimenta
  // remarketing no GA4, mas nao guia lance de anuncio.
  seenConversions.clear();
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'CANC-GA4', status: 'expired', value: 97, email: 'x@t.com' })
  });
  show('canceled CHEGA no GA4', captured.some((c) => c.ga4mp));
  show('canceled nao vai para os anuncios', !captured.some((c) => c.meta || c.googleAds));

  stitchRow = null;
}

console.log('\n=== 30. Evento do navegador nao e reenviado ao GA4 ===');
{
  Object.assign(env, { GA4_MEASUREMENT_ID: 'G-TEST', GA4_API_SECRET: 'segredo-mp' });
  seenConversions.clear();

  // O clique no botao ja foi para o GA4 pela tag do GTM. Reenviar pelo servidor
  // contaria duas vezes, porque o GA4 nao deduplica como o Meta.
  await call('https://w.dev/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_name: 'initiate_checkout',
      tsid: 'nav-1',
      client_id: '1.2',
      gclid: 'G-NAV'
    })
  });
  show('clique do navegador NAO vai ao GA4 pelo servidor', !captured.some((c) => c.ga4mp));
  show('mas continua sendo gravado no banco',
    captured.some((c) => c.sql?.startsWith('INSERT OR IGNORE INTO events')));

  // A venda vem do webhook: o navegador nao participou, entao o servidor manda.
  seenConversions.clear();
  stitchRow = { client_id: '1.2', tsid: 'v', gclid: 'G-1', utm_source: 'google' };
  await call('https://w.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transaction_id: 'SRV-1', status: 'paid', value: 97, email: 'w@t.com' })
  });
  show('venda do webhook CONTINUA indo ao GA4', captured.some((c) => c.ga4mp));
  stitchRow = null;
}

console.log('\n=== 31. PerfectPay (formato real: code, product.code, metadata.*) ===');
{
  stitchRow = null;
  seenConversions.clear();
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'PPCPMTB1A2B3C',
      sale_amount: 197.0,
      currency_enum_key: 'BRL',
      sale_status_enum: 2,
      sale_status_enum_key: 'approved',
      payment_method_enum_key: 'pix',
      installment_quantity: 1,
      product: { code: 'PPPBPROD1', name: 'Protocolo de Gênesis' },
      plan: { code: 'PLAN1', name: 'Plano Único' },
      customer: {
        full_name: 'Fulano de Tal',
        email: 'FULANO@Teste.com',
        identification_number: '12345678900',
        phone_formated: '(11) 98888-7777',
        city: 'São Paulo',
        state: 'SP',
        zip_code: '01310-100'
      },
      metadata: { utm_source: 'google', utm_campaign: 'camp-1', gclid: 'GCLID-PP', tsid: 'v-pp' }
    })
  });
  const p = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('plataforma perfectpay', p.platform === 'perfectpay', p.platform);
  show('status approved -> purchase', p.event_name === 'purchase', p.event_name);
  show('code -> transaction_id', p.transaction_id === 'PPCPMTB1A2B3C', p.transaction_id);
  show('valor', Number(p.value) === 197, p.value);
  show('product.code -> product_id', p.product_id === 'PPPBPROD1', p.product_id);
  show('product.name', p.product_name === 'Protocolo de Gênesis');
  show('plan.name -> offer_name', p.offer_name === 'Plano Único', p.offer_name);
  show('customer.full_name', p.customer_name === 'Fulano de Tal');
  show('email normalizado', p.customer_email === 'fulano@teste.com', p.customer_email);
  show('identification_number -> documento', p.customer_document === '12345678900');
  show('phone E.164', p.customer_phone === '+5511988887777', p.customer_phone);
  show('cidade/estado', p.customer_city === 'São Paulo' && p.customer_state === 'SP');
  show('gclid via metadata', p.gclid === 'GCLID-PP', p.gclid);
  show('utm_campaign via metadata', p.utm_campaign === 'camp-1', p.utm_campaign);
  show('tsid via metadata', p.tsid === 'v-pp', p.tsid);
  show('pagamento', p.payment_method === 'pix', p.payment_method);
}

console.log('\n=== 32. PerfectPay abandono, estorno e LATAM (espanhol) ===');
{
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PPC-AB1', sale_amount: 97, sale_status_enum_key: 'checkout_abandon', customer: { email: 'ab@teste.com' } })
  });
  show('checkout_abandon -> abandoned_checkout',
    argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'))).event_name === 'abandoned_checkout');

  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PPC-RF1', sale_amount: 97, sale_status_enum_key: 'estornado', customer: { email: 'rf@teste.com' } })
  });
  show('estornado -> refund',
    argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'))).event_name === 'refund');

  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PPC-LATAM', sale_amount: 49.9, currency_enum_key: 'USD', sale_status_enum_key: 'aprobado', customer: { email: 'latam@teste.com' } })
  });
  const latam = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('aprobado (LATAM) -> purchase', latam.event_name === 'purchase', latam.event_name);
  show('moeda USD (currency_enum_key)', latam.currency === 'USD', latam.currency);
}

console.log('\n=== 33. Recuperacao de abandono (Cron, so leitura) ===');
{
  // Sem URL configurada: nao faz nada.
  delete env.ABANDONED_WEBHOOK_URL;
  abandonedRows = null;
  await call('https://w.dev/abandoned/run');
  show('sem URL configurada nao envia', !captured.some((c) => c.abandonedPost));

  // Com URL + linhas de abandono: envia cada uma, sem escrever no D1.
  env.ABANDONED_WEBHOOK_URL = 'https://webhook.test/abandoned';
  abandonedRows = [
    { customer_name: 'Ana', first_name: 'Ana', customer_email: 'ana@x.com', customer_phone: '+5511999998888', product_name: 'Curso A', value: 197, currency: 'BRL', utm_source: 'google', utm_campaign: 'c1', transaction_id: 'T1', hostname: 'lp.com', created_at: '2026-07-27 10:00:00' }
  ];
  const res = await call('https://w.dev/abandoned/run');
  const body = await res.json();
  const post = captured.find((c) => c.abandonedPost);
  show('enviou o abandono para o webhook', !!post);
  show('payload traz email e produto', post?.body?.email === 'ana@x.com' && post?.body?.product === 'Curso A');
  show('marca event abandoned_cart', post?.body?.event === 'abandoned_cart', post?.body?.event);
  show('resposta reporta enviados', body?.sent === 1 && body?.total === 1, JSON.stringify(body));
  show('nao gravou nada no D1', !captured.some((c) => c.sql && /INSERT|UPDATE/i.test(c.sql)));

  abandonedRows = null;
  delete env.ABANDONED_WEBHOOK_URL;
}

console.log('\n=== 34. PerfectPay LATAM: moeda real via currency_paid ===');
{
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'PPC-COP', sale_amount: 71458.56, sale_amount_paid: 71458.56,
      currency_enum: 2, currency_paid: 'COP', sale_status_enum_key: 'approved',
      product: { code: 'P-CAP', name: 'El Capítulo Prohibido' },
      customer: { full_name: 'Juan', email: 'juan@latam.com' }
    })
  });
  const p = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('moeda COP (nao vira BRL)', p.currency === 'COP', p.currency);
  show('valor preservado (nao divide por 100)', Number(p.value) === 71458.56, p.value);
}

console.log('\n=== 35. Click id resgatado do utm_content (PerfectPay LATAM) ===');
{
  const GCLID = 'Cj0KCQjwg5zTBhCLARIsAP2AFU4-qrhfNI4ipZzSNt2gMjp-lRRxdZCBeyPaorUs3VpaDEn_cmlpsykaAraEEALw_wcB';

  // A PerfectPay nao devolve o campo gclid, mas devolve o utm_content com o
  // click id empacotado no formato "criativo::gclid::".
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'PPC-RESGATE', sale_amount: 19.9, currency_enum_key: 'USD',
      sale_status_enum_key: 'approved',
      product: { code: 'P-CAP', name: 'El Capítulo Prohibido' },
      customer: { full_name: 'Ana', email: 'ana@latam.com' },
      metadata: { utm_content: `817775467151::${GCLID}::`, utm_campaign: '24046652535' }
    })
  });
  const p = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('gclid resgatado do utm_content', p.gclid === GCLID, String(p.gclid).slice(0, 24));
  show('utm_content preservado inteiro', String(p.utm_content).includes('817775467151'), p.utm_content);

  // Texto comum no utm_content nao pode virar click id.
  captured.length = 0;
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'PPC-SEM-CLICK', sale_amount: 19.9, sale_status_enum_key: 'approved',
      product: { code: 'P-CAP', name: 'El Capítulo Prohibido' },
      metadata: { utm_content: 'banner-azul::criativo-03::' }
    })
  });
  const q = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('texto qualquer nao vira gclid', q.gclid === null, String(q.gclid));

  // O campo proprio, quando existe, tem precedencia sobre o resgate.
  captured.length = 0;
  await call('https://w.dev/webhook/perfectpay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'PPC-PRECEDENCIA', sale_amount: 19.9, sale_status_enum_key: 'approved',
      product: { code: 'P-CAP', name: 'El Capítulo Prohibido' },
      metadata: { gclid: 'GCLID-DIRETO', utm_content: `x::${GCLID}::` }
    })
  });
  const r = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('campo proprio tem precedencia', r.gclid === 'GCLID-DIRETO', String(r.gclid));
}

console.log('\n=== 36. PerfectPay: status BR e LATAM ===');
{
  /** Manda um webhook da PerfectPay e devolve o event_name gravado. */
  const evento = async (payload) => {
    captured.length = 0;
    await call('https://w.dev/webhook/perfectpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PPC-STATUS', sale_amount: 19.9, ...payload })
    });
    const insert = captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'));
    return insert ? argsToObject(insert).event_name : null;
  };

  // Aprovacao explicita, nas tres linguas.
  for (const s of ['aprovado', 'approved', 'aprobado', 'APROVADO', 'Approved']) {
    const e = await evento({ sale_status_enum_key: s });
    show(`"${s}" -> purchase`, e === 'purchase', String(e));
  }

  // Nao-aprovados, cada um no seu evento.
  const naoAprovados = [
    ['pendente', 'pix_generated'],
    ['pending', 'pix_generated'],
    ['pendiente', 'pix_generated'],
    ['recusado', 'payment_refused'],
    ['refused', 'payment_refused'],
    ['rechazado', 'payment_refused'],
    ['rejected', 'payment_refused'],
    ['reembolsado', 'refund'],
    ['refunded', 'refund'],
    ['estornado', 'refund'],
    ['cancelado', 'canceled'],
    ['cancelled', 'canceled'],
    ['canceled', 'canceled'],
    ['expired', 'canceled'],
    ['chargeback', 'chargeback'],
    ['checkout_abandon', 'abandoned_checkout']
  ];
  for (const [s, esperado] of naoAprovados) {
    const e = await evento({ sale_status_enum_key: s });
    show(`"${s}" -> ${esperado}`, e === esperado, String(e));
  }

  // O checkout LATAM nao manda a string: so o enum numerico.
  const porEnum = [
    [2, 'purchase'],
    [5, 'payment_refused'],
    [6, 'canceled'],
    [7, 'refund'],
    [12, 'abandoned_checkout'], // enum 12 = checkout abandonado, nunca venda
    [13, 'canceled']
  ];
  for (const [n, esperado] of porEnum) {
    const e = await evento({ sale_status_enum: n, currency_paid: 'COP' });
    show(`enum ${n} -> ${esperado}`, e === esperado, String(e));
  }

  // A string manda quando as duas vem — e diverge do enum de proposito aqui.
  const conflito = await evento({ sale_status_enum: 12, sale_status_enum_key: 'refunded' });
  show('string tem precedencia sobre o enum', conflito === 'refund', String(conflito));

  console.log('  -- os que NUNCA podem virar venda --');

  // Este era o bug: sem status, o webhook virava purchase por omissao.
  const semStatus = await evento({});
  show('payload sem status nao vira purchase', semStatus !== 'purchase', String(semStatus));
  show('  vira unknown_status', semStatus === 'unknown_status', String(semStatus));

  const enumNovo = await evento({ sale_status_enum: 99 });
  show('enum desconhecido nao vira purchase', enumNovo !== 'purchase', String(enumNovo));

  const statusNovo = await evento({ sale_status_enum_key: 'em_analise_manual' });
  show('status desconhecido nao vira purchase', statusNovo !== 'purchase', String(statusNovo));

  // Sinonimos de pago que NAO estao na lista de aprovados ficam de fora.
  for (const s of ['paid', 'completed', 'pagado']) {
    const e = await evento({ sale_status_enum_key: s });
    show(`"${s}" nao vira purchase (fora da lista)`, e !== 'purchase', String(e));
  }

  // As outras plataformas seguem com o mapa geral, sem a regra dura.
  captured.length = 0;
  await call('https://w.dev/webhook/kirvano', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checkout_id: 'c1', sale_id: 's1', status: 'paid', total_price: 97 })
  });
  const kirvano = argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  show('Kirvano "paid" segue purchase', kirvano.event_name === 'purchase', String(kirvano.event_name));
}

console.log('\n=== 37. Regra dura em TODAS as plataformas: sem status nao e venda ===');
{
  /** Manda um webhook cru e devolve o event_name gravado. */
  const evento = async (rota, payload) => {
    captured.length = 0;
    await call(`https://w.dev/webhook/${rota}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const insert = captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'));
    return insert ? argsToObject(insert).event_name : null;
  };

  // Cada plataforma com um payload plausivel de venda, mas sem campo de status.
  const semStatus = [
    ['kirvano', { checkout_id: 'c9', sale_id: 's9', total_price: 97 }],
    ['kiwify', { order_id: 'k9', Commissions: { charge_amount: 9700 } }],
    ['hotmart', { hottok: 'h9', data: { purchase: { price: { value: 97 } } } }],
    ['generic', { transaction_id: 't9', value: 97 }]
  ];
  for (const [rota, payload] of semStatus) {
    const e = await evento(rota, payload);
    show(`${rota} sem status nao vira purchase`, e !== 'purchase', String(e));
    show(`  ${rota} -> unknown_status`, e === 'unknown_status', String(e));
  }

  // Com status, tudo segue funcionando como antes.
  const comStatus = [
    ['kirvano', { checkout_id: 'c8', sale_id: 's8', status: 'paid', total_price: 97 }, 'purchase'],
    ['kirvano', { checkout_id: 'c7', sale_id: 's7', status: 'refunded', total_price: 97 }, 'refund'],
    ['generic', { transaction_id: 't8', status: 'approved', value: 97 }, 'purchase']
  ];
  for (const [rota, payload, esperado] of comStatus) {
    const e = await evento(rota, payload);
    show(`${rota} "${payload.status}" -> ${esperado}`, e === esperado, String(e));
  }
}

console.log('\n=== 38. PerfectPay: venda aprovada x carrinho abandonado ===');
{
  const evento = async (payload) => {
    captured.length = 0;
    await call('https://w.dev/webhook/perfectpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const insert = captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'));
    return insert ? argsToObject(insert) : null;
  };

  // Venda aprovada real (payload da PerfectPay LATAM, encurtado).
  const venda = await evento({
    code: 'PPCPMTB5HG6J4N5882',
    sale_amount: 19.9,
    currency_enum_key: 'USD',
    payment_method_enum: 6,
    payment_type_enum_key: 'credit_card',
    sale_status_enum: 2,
    sale_status_enum_key: 'approved',
    sale_status_detail: 'approved',
    date_created: '2026-06-13 00:36:45',
    date_approved: '2026-06-13 00:36:45',
    billet_url: '',
    product: { code: 'PPPBEQCP', name: 'El Capítulo Prohibido de los 3 Arcángeles' },
    customer: { full_name: 'Hector Estrada', email: 'estradahector69@hotmail.com', country: 'MX' },
    metadata: { utm_source: 'PF63-13', utm_campaign: '23895532308' }
  });
  show('venda aprovada -> purchase', venda.event_name === 'purchase', String(venda.event_name));
  show('  moeda USD', venda.currency === 'USD', String(venda.currency));
  show('  valor 19.9', Number(venda.value) === 19.9, String(venda.value));

  // Carrinho abandonado: code PPCCKT, sem date_approved, billet_url do checkout.
  const abandono = await evento({
    code: 'PPCCKT15GBQT96',
    sale_amount: 71458.56,
    sale_amount_paid: 71458.56,
    currency_paid: 'COP',
    sale_status_enum: 12,
    payment_method_enum: 0,
    date_created: '2026-07-27 16:53:10',
    billet_url: 'https://checkout.perfectpay.com.br/checkout/PPCCKT15GBQT96',
    product: { code: 'PPPBEQCP', name: 'El Capítulo Prohibido de los 3 Arcángeles' }
  });
  show('carrinho abandonado -> abandoned_checkout', abandono.event_name === 'abandoned_checkout', String(abandono.event_name));
  show('  NAO vira purchase', abandono.event_name !== 'purchase', String(abandono.event_name));

  // A trava do formato vence ate um status de aprovacao mentiroso.
  const mentiroso = await evento({
    code: 'PPCCKT99XPTO',
    sale_amount: 500,
    sale_status_enum: 2,
    sale_status_enum_key: 'approved',
    billet_url: 'https://checkout.perfectpay.com.br/checkout/PPCCKT99XPTO'
  });
  show(
    'code de checkout sem date_approved nao vira venda',
    mentiroso.event_name === 'abandoned_checkout',
    String(mentiroso.event_name)
  );

  // Enum novo num payload de checkout continua nao sendo venda.
  const enumNovo = await evento({
    code: 'PPCCKT77NOVO',
    sale_amount: 100,
    sale_status_enum: 44,
    billet_url: 'https://checkout.perfectpay.com.br/checkout/PPCCKT77NOVO'
  });
  show('enum novo em checkout -> abandoned_checkout', enumNovo.event_name === 'abandoned_checkout', String(enumNovo.event_name));

  // E uma venda de verdade nao pode ser confundida com abandono.
  const vendaBr = await evento({
    code: 'PPCPMTB5ZZZ',
    sale_amount: 197,
    currency_enum_key: 'BRL',
    sale_status_enum: 2,
    sale_status_enum_key: 'aprovado',
    date_approved: '2026-07-28 10:00:00',
    billet_url: '',
    product: { code: 'PPPBR01', name: 'Produto BR' }
  });
  show('venda BR "aprovado" -> purchase', vendaBr.event_name === 'purchase', String(vendaBr.event_name));
}

console.log('\n=== 39. PerfectPay LATAM: telefone com DDI e documento ===');
{
  const venda = async (payload) => {
    captured.length = 0;
    await call('https://w.dev/webhook/perfectpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return argsToObject(captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases')));
  };

  // México: phone_formated_ddi = +52..., identification_number = e-mail (NA).
  const mx = await venda({
    code: 'PPCPMTB-MX', sale_amount: 19.9, sale_status_enum_key: 'approved', date_approved: '2026-06-13 00:36:45',
    product: { code: 'P1', name: 'El Capítulo Prohibido' },
    customer: {
      full_name: 'Hector', email: 'h@x.com', identification_type: 'NA', identification_number: 'h@x.com',
      phone_formated: '(77) 7288-8762', phone_formated_ddi: '+527772888762', country: 'MX'
    }
  });
  show('telefone MX com +52 (nao +55)', mx.customer_phone === '+527772888762', mx.customer_phone);
  show('documento nao vira o e-mail (NA)', mx.customer_document === null, String(mx.customer_document));

  // EUA: +1 com 11 dígitos — nao pode ganhar 55 na frente.
  const us = await venda({
    code: 'PPCPMTB-US', sale_amount: 19.9, sale_status_enum_key: 'approved', date_approved: '2026-05-30 04:47:54',
    product: { code: 'P2', name: 'Genesis Protocol EN' },
    customer: { full_name: 'Ernedette', email: 'e@y.com', phone_formated_ddi: '+18474096529', country: 'US' }
  });
  show('telefone EUA com +1 (nao +55)', us.customer_phone === '+18474096529', us.customer_phone);

  // Brasil sem "+" continua assumindo 55 (comportamento antigo intacto).
  const br = await venda({
    code: 'PPCPMTB-BR', sale_amount: 197, sale_status_enum_key: 'aprovado', date_approved: '2026-07-28 10:00:00',
    product: { code: 'P3', name: 'Protocolo' },
    customer: { full_name: 'Joao', email: 'j@z.com', phone_formated: '(11) 98888-7777', country: 'BR' }
  });
  show('telefone BR mantem +55', br.customer_phone === '+5511988887777', br.customer_phone);
}

console.log('\n=== 40. GA4 hit: product_name resolvido pela URL (JS - Produto) chega ao D1 ===');
{
  // Simula o hit que o GA4 Config manda com fieldsToSet.product_name preenchido
  // por {{JS - Produto (URL)}} — o page_view passa a carregar o produto, sem
  // depender do snippet ter carregado a tempo.
  const qs = new URLSearchParams({
    v: '2', tid: 'G-TEST', cid: '1.1', sid: '1', en: 'page_view',
    dl: 'https://capsecret206.lovable.app/', dt: 'Capitulo Secreto',
    'ep.product_id': 'PROD-CS', 'ep.product_name': 'Capítulo Secreto'
  });
  await call('https://w.dev/g/collect?' + qs.toString());
  const inserts = captured.filter((c) => c.sql && c.sql.startsWith('INSERT'));
  const row = argsToObject(inserts[0]);
  show('product_name chega no evento de page_view', row.product_name === 'Capítulo Secreto', row.product_name);
  show('product_id chega junto', row.product_id === 'PROD-CS', row.product_id);
}

console.log('\n=== 41. Venda por webhook: nosso cadastro vence o nome cru da plataforma ===');
{
  // Caso real: a PerfectPay chamava um produto ja cadastrado (via codigo de
  // link e codigo de webhook) de "El Secreto del Orgasmo Femenino." — nome
  // que nunca apareceu no nosso cadastro. Antes desta correcao, resolveProduct
  // so era chamado no /collect (clique do navegador); o webhook sempre usava
  // o nome cru da plataforma, sem chance de cair no produto certo.
  Object.assign(env, {
    PRODUCT_LIST: JSON.stringify([
      { name: 'ORG LATAM', match: ['PPU38CQEGA6', 'PPPBF5PK'] }
    ])
  });

  const evento = async (payload) => {
    captured.length = 0;
    await call('https://w.dev/webhook/perfectpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const insert = captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'));
    return insert ? argsToObject(insert) : null;
  };

  const venda = await evento({
    code: 'PPCPMTB5HJ72BO2HE4',
    sale_amount: 27.9,
    currency_enum_key: 'USD',
    sale_status_enum: 2,
    sale_status_enum_key: 'approved',
    date_approved: '2026-08-24 10:00:00',
    billet_url: '',
    product: { code: 'PPPBF5PK', name: 'El Secreto del Orgasmo Femenino.' }
  });
  show(
    'nosso cadastro (ORG LATAM) vence o nome da plataforma',
    venda.product_name === 'ORG LATAM',
    venda.product_name
  );
  show('product_id continua vindo da plataforma', venda.product_id === 'PPPBF5PK', venda.product_id);

  // Produto SEM token cadastrado: preserva o nome cru — nao pode sumir nem
  // virar null so porque nao esta no productList (regressao dos 12 produtos
  // ja existentes, cujo nome cru ja bate com o cadastro por coincidencia).
  const semCadastro = await evento({
    code: 'PPCPMTB5ZZZ999',
    sale_amount: 19.9,
    currency_enum_key: 'USD',
    sale_status_enum: 2,
    sale_status_enum_key: 'approved',
    date_approved: '2026-08-24 10:05:00',
    billet_url: '',
    product: { code: 'PPPBOUTRO', name: 'Produto Nao Cadastrado' }
  });
  show(
    'sem token cadastrado, preserva o nome cru da plataforma',
    semCadastro.product_name === 'Produto Nao Cadastrado',
    semCadastro.product_name
  );

  delete env.PRODUCT_LIST;
}

console.log('\n=== 42. Kiwify: Product.product_id/product_name (P maiusculo) e "chargedback" ===');
{
  // Payload real do botao "disparar evento de teste" da Kiwify: produto vem
  // aninhado em "Product" com P maiusculo (nao "product" minusculo como as
  // outras plataformas), e o chargeback chega como "chargedback" (junto, sem
  // underscore) — nenhum dos dois batia nos pick()/STATUS_TO_EVENT antes desta
  // correcao, entao toda venda da Kiwify perdia product_id/product_name.
  Object.assign(env, {
    PRODUCT_LIST: JSON.stringify([{ name: 'GAMAPA APP', match: ['bh8HPUz'] }])
  });

  const evento = async (payload) => {
    captured.length = 0;
    await call('https://w.dev/webhook/kiwify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const insert = captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'));
    return insert ? argsToObject(insert) : null;
  };

  const venda = await evento({
    order_id: 'c8ea1dd3-f28c-4640-bd57-bac4b3dae417',
    order_status: 'paid',
    webhook_event_type: 'order_approved',
    Product: { product_id: 'bh8HPUz', product_name: 'Example product' },
    Customer: { full_name: 'John Doe', email: 'johndoe@example.com', mobile: '+22429552246' },
    Commissions: { charge_amount: 9770, currency: 'BRL' },
    TrackingParameters: { utm_source: null, utm_medium: null, utm_campaign: null }
  });
  show('product_id vem de Product.product_id (P maiusculo)', venda.product_id === 'bh8HPUz', venda.product_id);
  show('product_name resolvido pelo cadastro', venda.product_name === 'GAMAPA APP', venda.product_name);
  show('evento vira purchase', venda.event_name === 'purchase', venda.event_name);

  const chargeback = await evento({
    order_id: '85693fee-594d-402a-9fa6-a77a41ca087f',
    order_status: 'chargedback',
    webhook_event_type: 'order_chargedback',
    Product: { product_id: 'bh8HPUz', product_name: 'Example product' }
  });
  show('"chargedback" (sem underscore) vira chargeback', chargeback.event_name === 'chargeback', chargeback.event_name);

  delete env.PRODUCT_LIST;
}

console.log('\n=== 43. PRODUCT_LIST sem binding: cai no D1 (kv_config) ===');
{
  // PRODUCT_LIST estourou o limite de 5.1kB de binding de texto da
  // Cloudflare — sem env.PRODUCT_LIST setado, o Worker tem que buscar no D1
  // (tabela kv_config) e classificar normalmente a partir dali.
  delete env.PRODUCT_LIST;
  kvConfigRow = { value: JSON.stringify([{ name: 'MM-ITALIANO', match: ['bh8HPUz'] }]) };

  captured.length = 0;
  await call('https://w.dev/webhook/kiwify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      order_id: 'TESTE-KVCONFIG-1',
      order_status: 'paid',
      webhook_event_type: 'order_approved',
      Product: { product_id: 'bh8HPUz', product_name: 'Nome cru da plataforma' }
    })
  });
  const insert = captured.find((c) => c.sql?.startsWith('INSERT OR IGNORE INTO purchases'));
  const venda = insert ? argsToObject(insert) : null;
  show('buscou PRODUCT_LIST no kv_config e classificou certo', venda?.product_name === 'MM-ITALIANO', venda?.product_name);
  show('consultou a tabela kv_config', captured.some((c) => c.sql && /FROM kv_config/i.test(c.sql)));

  kvConfigRow = null;
}

console.log('\n' + (process.exitCode ? 'HOUVE FALHAS' : 'TODOS OS TESTES PASSARAM'));
