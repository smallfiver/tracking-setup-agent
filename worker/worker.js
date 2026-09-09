/**
 * Tracking Worker
 *
 * Rotas:
 *   GET  /t.js          -> snippet de rastreamento first-party
 *   GET|POST /g/collect -> recebe hits do GA4 (transport_url) e faz proxy para o GA4 real
 *   POST /collect       -> evento rico em JSON vindo do snippet (dados completos do cliente)
 *   POST /webhook       -> webhooks das plataformas de venda (aceita /webhook/<plataforma>)
 *   GET  /health        -> checagem rapida (conectividade com o banco)
 *
 * Bindings esperados:
 *   DB                 -> banco Cloudflare D1
 *   GA4_MEASUREMENT_ID -> id da metrica do GA4
 *   TRACK_PAGE_VIEWS   -> "true" para gravar page_view no banco (padrao: nao grava)
 */

const SNIPPET_SOURCE = '__SNIPPET_SOURCE__';

const EVENT_COLUMNS = [
  'event_name', 'event_id', 'source', 'tsid', 'client_id', 'session_id',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid', 'fbc', 'fbp',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'hostname', 'page_location', 'page_referrer', 'page_title',
  'transaction_id', 'value', 'currency', 'items',
  'product_id', 'product_name', 'purchase_type',
  'email', 'phone', 'name', 'document', 'city', 'state', 'zip', 'country',
  'geo_lat', 'geo_lon', 'geo_city', 'geo_region', 'geo_country',
  'user_agent', 'device_type', 'browser', 'os',
  'engagement_type', 'engagement_value',
  'ip', 'raw_params'
];

const PURCHASE_COLUMNS = [
  'event_name', 'platform', 'status', 'hostname', 'transaction_id', 'order_id', 'value',
  'currency', 'commission', 'product_id', 'product_name', 'offer_name', 'purchase_type',
  'payment_method', 'installments', 'coupon_code', 'original_value',
  'customer_name', 'first_name', 'customer_email', 'email_hash',
  'customer_phone', 'phone_hash', 'customer_document',
  'customer_city', 'customer_state', 'customer_zip', 'customer_country', 'ip',
  'tsid', 'client_id', 'session_id', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp',
  'ttclid', 'msclkid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'device_type', 'browser', 'os',
  'geo_country', 'geo_region', 'geo_city',
  'attribution_source', 'raw_payload'
];

const NUMERIC_COLUMNS = new Set([
  'value', 'commission', 'installments', 'geo_lat', 'geo_lon',
  'engagement_value', 'original_value'
]);

/**
 * Eventos que o proprio GA4 dispara sozinho. Continuam sendo repassados ao GA4,
 * mas nao vao para o banco: sao volumosos e nao carregam atribuicao nenhuma.
 */
const GA4_NOISE_EVENTS = new Set(['first_visit', 'session_start']);

/**
 * Eventos de engajamento: scroll, video e tempo na pagina.
 *
 * Sao opcionais porque tem volume alto — um visitante gera varios. Ligue com o
 * binding TRACK_ENGAGEMENT="true" quando quiser analisar retencao de VSL.
 * Desligados, seguem indo para o GA4 normalmente; so nao ocupam linha no D1.
 */
const GA4_ENGAGEMENT_EVENTS = new Set([
  'user_engagement',
  'scroll',
  'video_start',
  'video_progress',
  'video_complete',
  'time_on_page'
]);

/* ------------------------------------------------------------------ *
 * Banco (Cloudflare D1)
 * ------------------------------------------------------------------ */

/** Normaliza um valor para o D1: null, numero ou texto. */
function toParam(column, value) {
  if (value === null || value === undefined || value === '') return null;
  if (NUMERIC_COLUMNS.has(column)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function statement(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  return params.length ? stmt.bind(...params) : stmt;
}

async function run(env, sql, params = []) {
  return statement(env, sql, params).run();
}

async function all(env, sql, params = []) {
  const res = await statement(env, sql, params).all();
  return res.results || [];
}

/*  ---------------------------------------------------------------------
 * PRODUCT_LIST dinamico (kv_config)
 * ------------------------------------------------------------------ */

// PRODUCT_LIST cresce com cada pagina de landing nova cadastrada e ja
// estourou o limite de 5.1kB de um binding de texto do Worker. Mora no D1
// (tabela kv_config) e e recarregado com um cache curto por isolate — sem
// isso, toda requisicao pagaria uma consulta extra so para ler a lista.
let _productListCache = null;
let _productListCacheAt = 0;
const PRODUCT_LIST_CACHE_MS = 60000;

/**
 * Preenche env.PRODUCT_LIST antes do resto do codigo rodar, para que
 * resolveProduct/resolveGa4Target/stepFromProductList e a rota /t.js
 * continuem lendo env.PRODUCT_LIST normalmente, sem saber de onde veio.
 *
 * Se o binding ja vier com valor (caso dos testes, que setam env.PRODUCT_LIST
 * direto, e de um eventual override manual), usa ele e nunca toca no D1.
 */
async function loadProductList(env) {
  const preset = clean(env.PRODUCT_LIST);
  if (preset) return;

  const now = Date.now();
  if (_productListCache !== null && now - _productListCacheAt < PRODUCT_LIST_CACHE_MS) {
    env.PRODUCT_LIST = _productListCache;
    return;
  }

  try {
    const rows = await all(env, "SELECT value FROM kv_config WHERE key = 'PRODUCT_LIST' LIMIT 1");
    const value = rows[0]?.value || '[]';
    // "[]" nao entra no cache: normalmente e so a linha ainda nao ter sido
    // sincronizada (deploy em andamento) ou a tabela estar vazia num profile
    // novo — vale reconsultar na proxima requisicao em vez de travar 60s
    // classificando tudo como produto desconhecido.
    if (value !== '[]') {
      _productListCache = value;
      _productListCacheAt = now;
    }
    env.PRODUCT_LIST = value;
  } catch (err) {
    // D1 fora do ar ou tabela ainda nao criada: cai no que tiver em cache
    // (mesmo vencido) em vez de classificar tudo como produto desconhecido.
    env.PRODUCT_LIST = _productListCache || '[]';
  }
}

function buildInsert(table, columns, data, { ignoreConflict = false } = {}) {
  const present = columns.filter((c) => data[c] !== undefined);
  const sql =
    'INSERT ' + (ignoreConflict ? 'OR IGNORE ' : '') + 'INTO ' + table +
    ' (' + present.join(', ') + ') VALUES (' + present.map(() => '?').join(', ') + ')';
  return { sql, params: present.map((c) => toParam(c, data[c])) };
}

async function insertEvent(env, data) {
  // page_view e o evento mais volumoso e o que menos ajuda a otimizar campanha.
  // Por padrao ele nao vai para o banco — o GA4 continua recebendo normalmente.
  if (data.event_name === 'page_view' && String(env.TRACK_PAGE_VIEWS) !== 'true') return null;

  // Ruido automatico do GA4, que nao carrega atribuicao nenhuma.
  if (data.source === 'ga4' && GA4_NOISE_EVENTS.has(data.event_name)) return null;

  // Engajamento nunca vai para o banco, independente de TRACK_ENGAGEMENT.
  //
  // Esse interruptor hoje significa apenas "o snippet gera estes eventos para
  // o GA4" — e precisa continuar ligado, senao os publicos de VSL param de
  // receber. Guardar no D1 e outra historia: sao ~25 mil por hora, encheram o
  // limite de 10 GB em poucos dias e derrubaram o rastreamento inteiro, sem
  // alimentar nenhuma tela do painel. O GA4 ja tem todos eles.
  if (GA4_ENGAGEMENT_EVENTS.has(data.event_name)) return null;

  const { sql, params } = buildInsert('events', EVENT_COLUMNS, data, { ignoreConflict: true });
  return run(env, sql, params);
}

async function insertPurchase(env, data) {
  const { sql, params } = buildInsert('purchases', PURCHASE_COLUMNS, data, { ignoreConflict: true });
  return run(env, sql, params);
}

/* ------------------------------------------------------------------ *
 * Helpers gerais
 * ------------------------------------------------------------------ */

function corsHeaders(request, extra) {
  const origin = request.headers.get('Origin') || '*';
  return Object.assign(
    {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    },
    extra || {}
  );
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === 'undefined' || s === 'null' ? null : s;
}

function normalizeEmail(v) {
  const s = clean(v);
  return s ? s.toLowerCase() : null;
}

/**
 * Dominio da pagina, sem "www.".
 * E o que permite usar um container do GTM em varias landing pages e ainda
 * separar o faturamento de cada uma no painel.
 */
function hostnameOf(url) {
  const s = clean(url);
  if (!s) return null;
  try {
    return new URL(s).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Valida um ID de clique.
 *
 * Algumas plataformas colocam o cookie _gcl_au ou _ga no campo "gclid" — eles
 * tem o formato "1.1.123456.789012" e nao servem para atribuicao. Enviar isso
 * ao Google Ads como conversao so gera erro, entao descartamos aqui.
 */
function cleanClickId(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^[\d.]+$/.test(s)) return null;
  return s;
}

/**
 * Documento (CPF/CNPJ/ID). A PerfectPay LATAM manda identification_type "NA" e
 * repete o e-mail em identification_number — nesse caso nao e documento nenhum.
 */
function cleanDocument(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return null; // e um e-mail, nao um documento
  return s;
}

/**
 * Click ID escondido dentro do utm_content.
 *
 * A PerfectPay recebe o gclid na URL do checkout e nao o devolve no webhook —
 * mas devolve o utm_content, e a landing empacota o click id ali no formato
 * "criativo::gclid::". Sem isto as vendas LATAM chegam sem nenhum click id e
 * nao viram conversao offline no Google Ads.
 *
 * So aceita o que tem cara de gclid (comeca com Cj/EA/Ci/GC e e longo), para
 * nao promover um pedaco qualquer de texto a identificador de clique. gbraid e
 * wbraid ficam de fora de proposito: os dois comecam com "0AA" e, embutidos,
 * seriam indistinguiveis entre si — enviar um no lugar do outro faz o Google
 * Ads recusar a conversao.
 */
const CLICK_ID_EMBUTIDO = /^(?:Cj|EA|Ci|GC)[A-Za-z0-9_\-.]{20,}$/;

function clickIdEmUtmContent(utmContent) {
  const s = clean(utmContent);
  if (!s) return null;
  for (const parte of s.split('::')) {
    const p = parte.trim();
    if (CLICK_ID_EMBUTIDO.test(p)) return p;
  }
  return null;
}

/**
 * O snippet manda o tsid tambem como utm_id, porque as plataformas de checkout
 * repassam os UTMs padrao mas descartam parametros proprios como "tsid".
 *
 * So aceitamos o valor quando tem formato de UUID — que e o que o snippet gera
 * (ver uuid() em snippet.js). Sem esta checagem, o utm_id legitimo de uma
 * campanha (que costuma ser um numero) viraria um tsid inventado, e a costura
 * juntaria vendas de pessoas diferentes que compartilham a mesma campanha.
 */
const TSID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tsidDeUtmId(valor) {
  const s = clean(valor);
  return s && TSID_UUID.test(s) ? s : null;
}

/**
 * Le o User-Agent e devolve dispositivo, navegador e sistema.
 *
 * Feito a mao de proposito: o Worker e publicado como arquivo unico, sem
 * empacotador, entao uma biblioteca npm (ua-parser-js) nao entraria. Cobrimos
 * o que aparece em trafego brasileiro de anuncio.
 *
 * Detalhe que rende: identificamos os navegadores internos do Facebook e do
 * Instagram. Eles bloqueiam cookie de terceiro e convertem bem pior — sem
 * separar isso, o numero do mobile fica injustamente ruim.
 */
function parseUserAgent(ua) {
  const s = clean(ua);
  if (!s) return { device_type: null, browser: null, os: null };

  let os = null;
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  // A ordem importa: Edge, Opera e os navegadores de app se declaram como
  // Chrome ou Safari. Quem testar Chrome primeiro classifica tudo errado.
  let browser = null;
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(s)) browser = 'Facebook (app)';
  else if (/Instagram/i.test(s)) browser = 'Instagram (app)';
  else if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/CriOS/i.test(s)) browser = 'Chrome';
  else if (/FxiOS/i.test(s)) browser = 'Firefox';
  else if (/Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Safari\//i.test(s)) browser = 'Safari';

  let device_type = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) {
    device_type = 'tablet';
  } else if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(s)) {
    device_type = 'mobile';
  }

  return { device_type, browser, os };
}

/**
 * Traduz os eventos de engajamento do GA4 para um par tipo/valor.
 *
 *   scroll          -> percentual rolado
 *   video_*         -> percentual assistido
 *   user_engagement -> segundos de atencao na pagina (_et vem em milissegundos)
 */
function engagementFrom(p, ep) {
  const name = clean(p.en);
  if (!name) return { engagement_type: null, engagement_value: null };

  if (name === 'scroll') {
    return { engagement_type: 'scroll', engagement_value: toNumber(ep.percent_scrolled) };
  }
  if (name.indexOf('video_') === 0) {
    return {
      engagement_type: name,
      engagement_value: toNumber(ep.video_percent) ?? toNumber(ep.video_current_time)
    };
  }
  if (name === 'user_engagement') {
    const ms = toNumber(p._et);
    return { engagement_type: 'tempo_na_pagina', engagement_value: ms === null ? null : ms / 1000 };
  }
  return { engagement_type: null, engagement_value: null };
}

/**
 * Dominio de uma URL, descartando os das plataformas de checkout.
 *
 * "pay.kirvano.com" nao diz nada sobre a origem da venda — a informacao util e
 * a landing page que levou ate la, que vem da costura com a navegacao.
 */
function nonCheckoutHostname(env, url) {
  const host = hostnameOf(url);
  if (!host) return null;
  return ehCheckout(env, host) ? null : host;
}

const CHECKOUT_PLATFORM_HOSTS =
  /(kirvano|kiwify|hotmart|monetizze|braip|eduzz|perfectpay|centerpag|cartpanda|ticto|greenn|lastlink|pepper|payt|appmax|yampi|doppus|mercadopago|pagseguro|stripe)\./i;

/** Dominios de checkout adicionados no painel (binding CHECKOUT_DOMAINS). */
function dominiosConfigurados(env) {
  const raw = clean(env.CHECKOUT_DOMAINS);
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** O hostname pertence a alguma plataforma de checkout (padrao ou configurada)? */
function ehCheckout(env, host) {
  if (!host) return false;
  if (CHECKOUT_PLATFORM_HOSTS.test(host)) return true;
  const h = String(host).toLowerCase();
  return dominiosConfigurados(env).some((d) => h === d || h.indexOf(d) > -1);
}

/**
 * Descobre a qual produto um evento pertence.
 *
 * O clique no botao da VSL nao diz o que esta sendo vendido — mas a URL do
 * checkout e o dominio da pagina dizem. A lista de produtos (binding
 * PRODUCT_LIST) traz os trechos que identificam cada um.
 *
 *   [{"name":"Protocolo de Genesis","match":["69b64441","codificadorangelical"]}]
 */
function resolveProduct(env, candidates) {
  const raw = clean(env.PRODUCT_LIST);
  if (!raw) return null;

  let products;
  try {
    products = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(products)) return null;

  const haystack = candidates.filter(Boolean).join(' ').toLowerCase();
  if (!haystack) return null;

  for (const product of products) {
    const tokens = [].concat(product.match || [], product.item_id || [], product.name || []);
    for (const token of tokens) {
      const t = String(token || '').trim().toLowerCase();
      if (t && haystack.indexOf(t) > -1) return product.name || null;
    }
  }
  return null;
}

/** Primeiro nome, para tratamento em mensagem sem expor o nome completo. */
function firstNameOf(fullName) {
  const s = clean(fullName);
  if (!s) return null;
  return s.split(/\s+/)[0];
}

/** Telefone em formato E.164 simplificado (assume BR quando nao ha DDI). */
function normalizePhone(v) {
  const s = clean(v);
  if (!s) return null;
  // Numero ja internacional (comeca com "+"): o codigo do pais ja veio junto
  // (ex.: +52 Mexico, +1 EUA). Nao presuma Brasil.
  const hasCountryCode = s.trim().charAt(0) === '+';
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (!hasCountryCode && digits.length <= 11) digits = '55' + digits;
  return '+' + digits;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  // "1.234,56" (pt-BR) vs "1234.56"
  const normalized =
    s.indexOf(',') > -1 && s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Busca o primeiro caminho existente dentro de um objeto aninhado. */
function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path.split('.')) {
      if (cur && typeof cur === 'object' && key in cur) cur = cur[key];
      else { ok = false; break; }
    }
    if (ok && cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return null;
}

/**
 * Metadados do request. A Cloudflare ja geolocaliza cada acesso e entrega tudo
 * em request.cf — sem servico externo, sem custo. Usamos lat/long para plotar o
 * visitante no mapa ao vivo e cidade/regiao/pais para o rotulo.
 */
function requestMeta(request) {
  const cf = request.cf || {};
  const userAgent = request.headers.get('User-Agent');
  const device = parseUserAgent(userAgent);
  return {
    user_agent: userAgent,
    device_type: device.device_type,
    browser: device.browser,
    os: device.os,
    ip: request.headers.get('CF-Connecting-IP'),
    country: cf.country || null,
    geo_lat: cf.latitude || null,
    geo_lon: cf.longitude || null,
    geo_city: cf.city || null,
    geo_region: cf.region || null,
    geo_country: cf.country || null
  };
}

/* ------------------------------------------------------------------ *
 * /g/collect  — hits do GA4 (transport_url)
 * ------------------------------------------------------------------ */

/**
 * O Measurement Protocol do GA4 envia parametros customizados prefixados:
 *   ep.<nome>  -> parametro de texto
 *   epn.<nome> -> parametro numerico
 * Alem dos campos de topo: en (event name), cid (client id), sid (session id),
 * dl (page location), dr (referrer), dt (title), cu (currency).
 */
function parseGa4Params(searchParams, bodyText) {
  const flat = {};
  for (const [k, v] of searchParams) flat[k] = v;

  // Hits em lote (POST) vem no corpo, uma linha de query string por evento.
  const lines = [];
  if (bodyText) {
    for (const line of bodyText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) lines.push(new URLSearchParams(trimmed));
    }
  }
  if (!lines.length) lines.push(new URLSearchParams());

  return lines.map((extra) => {
    const p = Object.assign({}, flat);
    for (const [k, v] of extra) p[k] = v;

    const ep = {};
    for (const key of Object.keys(p)) {
      if (key.indexOf('ep.') === 0) ep[key.slice(3)] = p[key];
      else if (key.indexOf('epn.') === 0) ep[key.slice(4)] = p[key];
    }
    return { p, ep };
  });
}

function ga4HitToEvent(p, ep, meta) {
  const engagement = engagementFrom(p, ep);
  return {
    event_name: clean(p.en) || 'page_view',
    event_id: clean(ep.event_id),
    source: 'ga4',
    tsid: clean(ep.tsid),
    client_id: clean(p.cid),
    session_id: clean(p.sid),
    gclid: clean(ep.gclid) || clean(p.gclid),
    gbraid: clean(ep.gbraid),
    wbraid: clean(ep.wbraid),
    fbclid: clean(ep.fbclid),
    ttclid: clean(ep.ttclid),
    msclkid: clean(ep.msclkid),
    fbc: clean(ep.fbc),
    fbp: clean(ep.fbp),
    utm_source: clean(ep.utm_source) || clean(p.cs),
    utm_medium: clean(ep.utm_medium) || clean(p.cm),
    utm_campaign: clean(ep.utm_campaign) || clean(p.cn),
    utm_term: clean(ep.utm_term),
    utm_content: clean(ep.utm_content),
    hostname: hostnameOf(p.dl),
    page_location: clean(p.dl),
    page_referrer: clean(p.dr),
    page_title: clean(p.dt),
    transaction_id: clean(ep.transaction_id),
    value: toNumber(ep.value),
    currency: clean(p.cu) || clean(ep.currency),
    items: clean(ep.items),
    // product_name vem de {{JS - Produto (URL)}} no fieldsToSet do GA4 Config —
    // por isso a VISITA (page_view) tambem sabe o produto, nao so o checkout.
    product_id: clean(ep.product_id),
    product_name: clean(ep.product_name),
    email: normalizeEmail(ep.email),
    phone: normalizePhone(ep.phone),
    name: clean(ep.name) || clean(ep.customer_name),
    document: clean(ep.document),
    geo_lat: meta.geo_lat,
    geo_lon: meta.geo_lon,
    geo_city: meta.geo_city,
    geo_region: meta.geo_region,
    geo_country: meta.geo_country,
    user_agent: meta.user_agent,
    device_type: meta.device_type,
    browser: meta.browser,
    os: meta.os,
    engagement_type: engagement.engagement_type,
    engagement_value: engagement.engagement_value,
    ip: meta.ip,
    country: meta.country,
    raw_params: JSON.stringify(p)
  };
}

async function handleGa4Collect(request, env, ctx, url) {
  const bodyText = request.method === 'POST' ? await request.text() : '';
  const meta = requestMeta(request);

  // 1) Repassa o hit para o GA4 real — sem isso os relatorios do GA4 ficam vazios.
  const upstream = new URL('https://www.google-analytics.com/g/collect' + url.search);

  // O Google geolocaliza pelo IP de quem faz a chamada — e quem chama aqui e o
  // Worker, nao o visitante. A saida da Cloudflare para a America Latina passa
  // muito por Miami, entao trafego do Mexico e da Colombia acaba contado como
  // Estados Unidos. O X-Forwarded-For abaixo nao e respeitado por esse endpoint.
  //
  // A Cloudflare ja nos entrega o pais real do visitante, entao carimbamos no
  // proprio hit. E este parametro que os publicos por pais devem usar, nao a
  // dimensao nativa do GA4.
  if (meta.geo_country) upstream.searchParams.set('ep.geo_country', meta.geo_country);
  if (meta.geo_city) upstream.searchParams.set('ep.geo_city', meta.geo_city);
  ctx.waitUntil(
    fetch(upstream.toString(), {
      method: request.method,
      headers: {
        'User-Agent': request.headers.get('User-Agent') || '',
        'Content-Type': request.headers.get('Content-Type') || 'text/plain;charset=UTF-8',
        'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || ''
      },
      body: request.method === 'POST' ? bodyText : undefined
    }).catch(() => {})
  );

  // 2) Grava no banco.
  const hits = parseGa4Params(url.searchParams, bodyText);
  ctx.waitUntil(
    (async () => {
      for (const hit of hits) {
        try {
          await insertEvent(env, ga4HitToEvent(hit.p, hit.ep, meta));
        } catch (err) {
          console.error('insertEvent (ga4) falhou:', err.message);
        }
      }
    })()
  );

  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/* ------------------------------------------------------------------ *
 * /collect — evento rico do snippet first-party
 * ------------------------------------------------------------------ */

async function handleCollect(request, env, ctx) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'JSON invalido' }), {
      status: 400,
      headers: corsHeaders(request, { 'content-type': 'application/json' })
    });
  }

  const meta = requestMeta(request);
  const c = payload.customer || {};

  const row = {
    event_name: clean(payload.event_name) || 'page_view',
    event_id: clean(payload.event_id),
    source: 'js',
    tsid: clean(payload.tsid),
    client_id: clean(payload.client_id),
    session_id: clean(payload.session_id),
    gclid: clean(payload.gclid),
    gbraid: clean(payload.gbraid),
    wbraid: clean(payload.wbraid),
    fbclid: clean(payload.fbclid),
    ttclid: clean(payload.ttclid),
    msclkid: clean(payload.msclkid),
    fbc: clean(payload.fbc),
    fbp: clean(payload.fbp),
    utm_source: clean(payload.utm_source),
    utm_medium: clean(payload.utm_medium),
    utm_campaign: clean(payload.utm_campaign),
    utm_term: clean(payload.utm_term),
    utm_content: clean(payload.utm_content),
    hostname: hostnameOf(payload.page_location),
    // Qual produto o visitante estava comprando. Vem da URL do checkout que ele
    // clicou ou do dominio da pagina — o clique em si nao carrega essa
    // informacao, e sem ela nao da para separar publico por produto no GA4.
    product_name:
      clean(payload.product_name) ||
      resolveProduct(env, [payload.checkout_url, payload.page_location, payload.link_text]),
    page_location: clean(payload.page_location),
    page_referrer: clean(payload.page_referrer),
    page_title: clean(payload.page_title),
    transaction_id: clean(payload.transaction_id),
    value: toNumber(payload.value),
    currency: clean(payload.currency) || 'BRL',
    items: payload.items ? JSON.stringify(payload.items) : null,
    email: normalizeEmail(c.email),
    phone: normalizePhone(c.phone),
    name: clean(c.name),
    document: clean(c.document),
    city: clean(c.city),
    state: clean(c.state),
    zip: clean(c.zip),
    country: clean(c.country) || meta.country,
    geo_lat: meta.geo_lat,
    geo_lon: meta.geo_lon,
    geo_city: meta.geo_city,
    geo_region: meta.geo_region,
    geo_country: meta.geo_country,
    user_agent: meta.user_agent,
    device_type: meta.device_type,
    browser: meta.browser,
    os: meta.os,
    ip: meta.ip,
    // Watch-time da VSL e tempo na pagina: o snippet ja manda classificado, so
    // precisamos guardar. Sem estas duas linhas o evento chegava e o campo
    // ficava nulo — foi por isso que engagement_type ficou zerado no painel.
    engagement_type: clean(payload.engagement_type),
    engagement_value: toNumber(payload.engagement_value),
    raw_params: JSON.stringify(payload)
  };

  ctx.waitUntil(
    (async () => {
      try {
        await insertEvent(env, row);
        await upsertLead(env, row);
        // Marcado como vindo do navegador: a tag do GA4 no GTM ja mandou este
        // evento. Ver a nota em sendToGa4 sobre contagem dupla.
        await dispatchConversions(env, { ...conversionFromEvent(row, meta), from_browser: true });
      } catch (err) {
        console.error('insertEvent (js) falhou:', err.message);
      }
    })()
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: corsHeaders(request, { 'content-type': 'application/json' })
  });
}

/* ------------------------------------------------------------------ *
 * Leads — pessoa consolidada com atribuicao de primeiro/ultimo clique
 * ------------------------------------------------------------------ */

async function upsertLead(env, row) {
  if (!row.email && !row.phone) return;

  const found = (
    await all(
      env,
      'SELECT id FROM leads WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?) LIMIT 1',
      [toParam('email', row.email), toParam('phone', row.phone)]
    )
  )[0];

  if (found) {
    await run(
      env,
      `UPDATE leads SET
         name = COALESCE(?, name),
         phone = COALESCE(?, phone),
         email = COALESCE(?, email),
         document = COALESCE(?, document),
         tsid = COALESCE(?, tsid),
         last_gclid = COALESCE(?, last_gclid),
         last_gbraid = COALESCE(?, last_gbraid),
         last_wbraid = COALESCE(?, last_wbraid),
         last_fbclid = COALESCE(?, last_fbclid),
         last_fbc = COALESCE(?, last_fbc),
         last_fbp = COALESCE(?, last_fbp),
         last_utm_source = COALESCE(?, last_utm_source),
         last_utm_medium = COALESCE(?, last_utm_medium),
         last_utm_campaign = COALESCE(?, last_utm_campaign),
         last_seen = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        toParam('name', row.name), toParam('phone', row.phone), toParam('email', row.email),
        toParam('document', row.document), toParam('tsid', row.tsid),
        toParam('gclid', row.gclid), toParam('gbraid', row.gbraid), toParam('wbraid', row.wbraid),
        toParam('fbclid', row.fbclid), toParam('fbc', row.fbc), toParam('fbp', row.fbp),
        toParam('utm_source', row.utm_source), toParam('utm_medium', row.utm_medium),
        toParam('utm_campaign', row.utm_campaign),
        found.id
      ]
    );
    return;
  }

  await run(
    env,
    `INSERT OR IGNORE INTO leads
       (email, phone, name, document, tsid,
        first_gclid, first_utm_source, first_utm_campaign,
        last_gclid, last_gbraid, last_wbraid, last_fbclid, last_fbc, last_fbp,
        last_utm_source, last_utm_medium, last_utm_campaign)
     VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?)`,
    [
      toParam('email', row.email), toParam('phone', row.phone), toParam('name', row.name),
      toParam('document', row.document), toParam('tsid', row.tsid),
      toParam('gclid', row.gclid), toParam('utm_source', row.utm_source), toParam('utm_campaign', row.utm_campaign),
      toParam('gclid', row.gclid), toParam('gbraid', row.gbraid), toParam('wbraid', row.wbraid),
      toParam('fbclid', row.fbclid), toParam('fbc', row.fbc), toParam('fbp', row.fbp),
      toParam('utm_source', row.utm_source), toParam('utm_medium', row.utm_medium),
      toParam('utm_campaign', row.utm_campaign)
    ]
  );
}

async function registerLeadPurchase(env, purchase) {
  if (!purchase.customer_email && !purchase.customer_phone) return;

  // total_value e uma coluna em REAIS, e uma soma so faz sentido entre valores
  // da mesma moeda: 135.360 guaranis nao sao 135.360 reais. Venda em moeda
  // estrangeira entra na contagem mas nao no valor — quem precisa do total
  // internacional soma a partir de purchases, que guarda a moeda por linha.
  const emReais = !purchase.currency || purchase.currency === 'BRL';

  await run(
    env,
    `UPDATE leads SET
       purchases_count = COALESCE(purchases_count, 0) + 1,
       total_value = COALESCE(total_value, 0) + ?,
       last_seen = CURRENT_TIMESTAMP
     WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?)`,
    [
      toParam('value', (emReais && purchase.value) || 0),
      toParam('email', purchase.customer_email),
      toParam('phone', purchase.customer_phone)
    ]
  );
}

/* ------------------------------------------------------------------ *
 * Envio de conversoes para Meta CAPI e Google Ads
 *
 * Guardar dado nao melhora campanha — o algoritmo precisa receber de volta.
 * Aqui a venda aprovada (que so o webhook conhece) volta para as plataformas
 * com o click ID junto.
 * ------------------------------------------------------------------ */

/** Nome do evento no padrao do Meta. */
const META_EVENT_NAMES = {
  purchase: 'Purchase',
  begin_checkout: 'InitiateCheckout',
  initiate_checkout: 'InitiateCheckout',
  add_to_cart: 'AddToCart',
  view_item: 'ViewContent',
  generate_lead: 'Lead',
  add_payment_info: 'AddPaymentInfo',
  sign_up: 'CompleteRegistration'
};

/** Eventos enviados por padrao. Sobrescreva com o binding CONVERSION_EVENTS. */
const DEFAULT_CONVERSION_EVENTS = ['purchase', 'generate_lead', 'begin_checkout', 'initiate_checkout'];

/**
 * O GA4 recebe uma lista mais larga que Meta e Google Ads.
 *
 * Os anuncios querem otimizar em cima do que vale dinheiro — mandar pix gerado
 * ou carrinho abandonado como conversao ensinaria o algoritmo a caçar quem nao
 * paga. Ja o GA4 e analise e publico: e ali que "quem gerou pix e nao pagou"
 * ou "quem abandonou o checkout" viram lista de remarketing.
 */
const GA4_EXTRA_EVENTS = [
  'pix_generated',
  'boleto_generated',
  'abandoned_checkout',
  'payment_refused',
  'refund',
  'chargeback',
  // Checkout expirado/cancelado — mesma logica do abandoned_checkout: clicou
  // e nao pagou. Faltava aqui e essas vendas nunca entravam em remarketing.
  'canceled'
];

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** O Meta exige os dados normalizados antes do hash. */
async function hashed(value, kind) {
  const raw = clean(value);
  if (!raw) return null;
  let normalized = String(raw).trim().toLowerCase();

  if (kind === 'phone') normalized = normalized.replace(/\D/g, '');
  else if (kind === 'zip') normalized = normalized.replace(/\D/g, '');
  else if (kind === 'name' || kind === 'city') normalized = normalized.replace(/[^a-zà-ü]/g, '');
  else if (kind === 'state') normalized = normalized.replace(/[^a-z]/g, '').slice(0, 2);
  else if (kind === 'country') normalized = normalized.replace(/[^a-z]/g, '').slice(0, 2);

  if (!normalized) return null;
  return sha256(normalized);
}

/**
 * Registra a tentativa antes de enviar. Se a linha ja existir (indice unico),
 * significa que essa conversao ja foi tratada — nao reenviamos.
 * Devolve o id do log ou null se for duplicata.
 */
async function claimConversion(env, destination, conv) {
  const res = await run(
    env,
    `INSERT OR IGNORE INTO conversions_log
       (destination, event_name, event_id, transaction_id, value, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [
      destination,
      conv.event_name,
      conv.event_id,
      toParam('transaction_id', conv.transaction_id),
      toParam('value', conv.value),
      toParam('currency', conv.currency)
    ]
  );
  const changes = res?.meta?.changes ?? res?.changes ?? 0;
  if (!changes) return null;
  return res?.meta?.last_row_id ?? null;
}

async function finishConversion(env, logId, status, detail) {
  if (!logId) return;
  await run(env, 'UPDATE conversions_log SET status = ?, detail = ? WHERE id = ?', [
    status,
    detail ? String(detail).slice(0, 900) : null,
    logId
  ]);
}

/* -------------------------- Meta CAPI ---------------------------- */

async function sendToMeta(env, conv) {
  const pixelId = clean(env.META_PIXEL_ID);
  const token = clean(env.META_ACCESS_TOKEN);
  if (!pixelId || !token) return;

  const metaName = META_EVENT_NAMES[conv.event_name];
  if (!metaName) return;

  const logId = await claimConversion(env, 'meta', conv);
  if (!logId) return; // ja enviado

  try {
    const [em, ph, fn, ct, st, zp, country, externalId] = await Promise.all([
      hashed(conv.email, 'email'),
      hashed(conv.phone, 'phone'),
      hashed(conv.name, 'name'),
      hashed(conv.city, 'city'),
      hashed(conv.state, 'state'),
      hashed(conv.zip, 'zip'),
      hashed(conv.country, 'country'),
      hashed(conv.tsid, 'raw')
    ]);

    const userData = {};
    if (em) userData.em = [em];
    if (ph) userData.ph = [ph];
    if (fn) userData.fn = [fn];
    if (ct) userData.ct = [ct];
    if (st) userData.st = [st];
    if (zp) userData.zp = [zp];
    if (country) userData.country = [country];
    if (externalId) userData.external_id = [externalId];
    if (conv.fbc) userData.fbc = conv.fbc;
    if (conv.fbp) userData.fbp = conv.fbp;
    if (conv.ip) userData.client_ip_address = conv.ip;
    if (conv.user_agent) userData.client_user_agent = conv.user_agent;

    const customData = { currency: conv.currency || 'BRL' };
    if (conv.value !== null && conv.value !== undefined) customData.value = Number(conv.value);
    if (conv.transaction_id) customData.order_id = conv.transaction_id;
    // Produto e etapa do funil ajudam o Meta a casar e segmentar (front/bump/upsell).
    if (conv.product_id) {
      customData.content_ids = [String(conv.product_id)];
      customData.content_type = 'product';
    }
    if (conv.product_name) customData.content_name = conv.product_name;
    if (conv.purchase_type) customData.funnel_step = conv.purchase_type;

    const payload = {
      data: [
        {
          event_name: metaName,
          event_time: conv.event_time,
          // Mesmo event_id do pixel — e assim que o Meta deduplica os dois caminhos.
          event_id: conv.event_id,
          action_source: conv.action_source || 'website',
          event_source_url: conv.page_location || undefined,
          user_data: userData,
          custom_data: customData
        }
      ]
    };
    if (clean(env.META_TEST_EVENT_CODE)) payload.test_event_code = env.META_TEST_EVENT_CODE;

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    const body = await res.json().catch(() => ({}));

    if (res.ok && !body.error) {
      await finishConversion(env, logId, 'sent', `matched: ${body.events_received ?? 1}`);
    } else {
      await finishConversion(env, logId, 'error', body.error?.message || `HTTP ${res.status}`);
    }
  } catch (err) {
    await finishConversion(env, logId, 'error', err.message);
  }
}

/* ------------------------ Google Ads ----------------------------- */

// Token OAuth vive ~1h. Cache por refresh token: cada conta do Google Ads tem
// o seu, entao um cache unico global misturaria as contas.
const googleTokens = new Map();

async function googleAccessToken(env, refreshToken) {
  const key = refreshToken || 'default';
  const cached = googleTokens.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: refreshToken || env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });

  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error('OAuth do Google falhou: ' + (body.error_description || body.error || res.status));
  }

  googleTokens.set(key, {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000 - 60000
  });
  return body.access_token;
}

/**
 * Descobre para qual conta do Google Ads esta venda deve ir.
 *
 * Cada linha de google_ads_accounts pode listar os produtos que atende (campo
 * products, JSON). A conta sem produtos listados e o "pega-tudo" — usada quando
 * nenhuma outra casa. Sem nenhuma conta no banco, caimos nos bindings antigos
 * (GOOGLE_ADS_*), para nao quebrar quem ainda usa conta unica.
 */
async function resolveGoogleAdsAccount(env, conv) {
  let rows = [];
  try {
    const res = await env.DB.prepare(
      'SELECT * FROM google_ads_accounts WHERE enabled = 1 AND refresh_token IS NOT NULL'
    ).all();
    rows = res.results || [];
  } catch (err) {
    rows = [];
  }

  if (!rows.length) {
    // Modo legado: conta unica vinda dos bindings.
    const customerId = String(clean(env.GOOGLE_ADS_CUSTOMER_ID) || '').replace(/\D/g, '');
    if (!customerId || !clean(env.GOOGLE_ADS_REFRESH_TOKEN)) return null;
    return {
      id: null,
      customer_id: customerId,
      login_customer_id: clean(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
      conversion_action_id: clean(env.GOOGLE_ADS_CONVERSION_ACTION_ID),
      refresh_token: clean(env.GOOGLE_ADS_REFRESH_TOKEN)
    };
  }

  const produto = String(conv.product_name || '').trim().toLowerCase();
  let pegaTudo = null;

  for (const row of rows) {
    let produtos = [];
    try {
      produtos = JSON.parse(row.products || '[]');
    } catch (err) {
      produtos = [];
    }
    if (!Array.isArray(produtos) || !produtos.length) {
      if (!pegaTudo) pegaTudo = row;
      continue;
    }
    if (produto && produtos.some((p) => String(p).trim().toLowerCase() === produto)) return row;
  }

  return pegaTudo;
}

/** O Google Ads exige "yyyy-MM-dd HH:mm:ss+HH:mm". */
function googleDateTime(unixSeconds) {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19) + '+00:00';
}

async function sendToGoogleAds(env, conv) {
  // Sem click ID do Google nao ha o que atribuir. Checado antes de resolver a
  // conta para nao gastar consulta no banco a toa.
  if (!conv.gclid && !conv.gbraid && !conv.wbraid) return;
  if (conv.event_name !== 'purchase' && String(env.GOOGLE_ADS_ALL_EVENTS) !== 'true') return;

  const account = await resolveGoogleAdsAccount(env, conv);
  if (!account) return;

  const customerId = String(account.customer_id || '').replace(/\D/g, '');
  const conversionActionId = String(account.conversion_action_id || '').replace(/\D/g, '');
  if (!customerId || !conversionActionId || !account.refresh_token) return;

  const logId = await claimConversion(env, 'google_ads', conv);
  if (!logId) return;

  try {
    const token = await googleAccessToken(env, account.refresh_token);

    const conversion = {
      conversionAction: `customers/${customerId}/conversionActions/${conversionActionId}`,
      conversionDateTime: googleDateTime(conv.event_time),
      conversionValue: Number(conv.value) || 0,
      currencyCode: conv.currency || 'BRL'
    };
    if (conv.gclid) conversion.gclid = conv.gclid;
    else if (conv.gbraid) conversion.gbraid = conv.gbraid;
    else if (conv.wbraid) conversion.wbraid = conv.wbraid;
    if (conv.transaction_id) conversion.orderId = conv.transaction_id;

    const headers = {
      Authorization: `Bearer ${token}`,
      'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'Content-Type': 'application/json'
    };
    if (clean(account.login_customer_id)) {
      headers['login-customer-id'] = String(account.login_customer_id).replace(/\D/g, '');
    }

    const res = await fetch(
      `https://googleads.googleapis.com/v18/customers/${customerId}:uploadClickConversions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversions: [conversion], partialFailure: true })
      }
    );
    const body = await res.json().catch(() => ({}));

    const partial = body.partialFailureError?.message;
    const detalhe = partial || body.error?.message || `HTTP ${res.status}`;
    if (res.ok && !partial) {
      await finishConversion(env, logId, 'sent', `ok · conta ${customerId}`);
      await markAccountError(env, account.id, null);
    } else {
      await finishConversion(env, logId, 'error', `conta ${customerId}: ${detalhe}`);
      await markAccountError(env, account.id, detalhe);
    }
  } catch (err) {
    await finishConversion(env, logId, 'error', err.message);
    await markAccountError(env, account.id, err.message);
  }
}

/* ---------------- OAuth do Google Ads (uma conta por vez) --------------- */

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/adwords';

function paginaOauth(titulo, mensagem, ok) {
  const cor = ok ? '#10b981' : '#ef4444';
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${titulo}</title>` +
      `<div style="font-family:system-ui,sans-serif;background:#0b1220;color:#e2e8f0;` +
      `min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0">` +
      `<div style="text-align:center;max-width:520px;padding:2rem">` +
      `<div style="font-size:2.5rem;color:${cor};margin-bottom:1rem">${ok ? '&#10003;' : '&#10007;'}</div>` +
      `<h1 style="font-size:1.25rem;font-weight:600;margin:0 0 .75rem">${titulo}</h1>` +
      `<p style="color:#94a3b8;font-size:.9rem;line-height:1.6;margin:0">${mensagem}</p>` +
      `</div></div>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

/**
 * Manda o usuario para a tela de consentimento do Google.
 *
 * O state carrega "<id da conta>.<segredo>" — o segredo foi sorteado quando a
 * conta foi criada no painel e so existe naquela linha do banco. Sem isso,
 * qualquer um poderia chamar o callback e plantar um refresh token.
 */
async function handleGoogleOauthStart(request, env, url) {
  const state = clean(url.searchParams.get('state'));
  if (!state || state.indexOf('.') < 0) return paginaOauth('Link invalido', 'Faltou o parametro state.', false);

  const [id, segredo] = state.split('.');
  const row = (
    await all(env, 'SELECT id, label FROM google_ads_accounts WHERE id = ? AND oauth_state = ?', [
      String(id),
      String(segredo)
    ])
  )[0];
  if (!row) {
    return paginaOauth('Link expirado', 'Gere o link de conexao de novo no painel.', false);
  }

  const clientId = clean(env.GOOGLE_ADS_CLIENT_ID);
  if (!clientId) {
    return paginaOauth('Falta configurar', 'O OAuth Client ID ainda nao foi preenchido no painel.', false);
  }

  const redirect = `${url.origin}/oauth/google/callback`;
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.searchParams.set('client_id', clientId);
  consent.searchParams.set('redirect_uri', redirect);
  consent.searchParams.set('response_type', 'code');
  consent.searchParams.set('scope', OAUTH_SCOPE);
  // "offline" + "consent" garantem que o Google devolva refresh_token mesmo
  // quando a conta ja autorizou este app antes.
  consent.searchParams.set('access_type', 'offline');
  consent.searchParams.set('prompt', 'consent');
  consent.searchParams.set('state', state);

  return Response.redirect(consent.toString(), 302);
}

/** Recebe o codigo do Google, troca por refresh token e guarda na conta. */
async function handleGoogleOauthCallback(request, env, url) {
  const erro = clean(url.searchParams.get('error'));
  if (erro) return paginaOauth('Autorizacao cancelada', `O Google respondeu: ${erro}`, false);

  const code = clean(url.searchParams.get('code'));
  const state = clean(url.searchParams.get('state'));
  if (!code || !state || state.indexOf('.') < 0) {
    return paginaOauth('Resposta incompleta', 'O Google nao devolveu o codigo esperado.', false);
  }

  const [id, segredo] = state.split('.');
  const row = (
    await all(env, 'SELECT id, label FROM google_ads_accounts WHERE id = ? AND oauth_state = ?', [
      String(id),
      String(segredo)
    ])
  )[0];
  if (!row) return paginaOauth('Link expirado', 'Gere o link de conexao de novo no painel.', false);

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_ADS_CLIENT_ID,
        client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
        redirect_uri: `${url.origin}/oauth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const body = await res.json();
    if (!res.ok || !body.refresh_token) {
      const detalhe = body.error_description || body.error || `HTTP ${res.status}`;
      return paginaOauth('Nao consegui conectar', String(detalhe), false);
    }

    // Descobre qual conta Google autorizou — util para nao confundir contas.
    let email = null;
    try {
      const perfil = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${body.access_token}` }
      }).then((r) => r.json());
      email = clean(perfil.email);
    } catch (e) { /* opcional */ }

    // oauth_state vira NULL: o link de conexao e de uso unico.
    await env.DB.prepare(
      'UPDATE google_ads_accounts SET refresh_token = ?, google_email = ?, oauth_state = NULL, ' +
        'last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
      .bind(body.refresh_token, email, row.id)
      .run();

    return paginaOauth(
      'Conta conectada',
      `${row.label || 'Conta'} conectada${email ? ` como ${email}` : ''}. Pode fechar esta aba e voltar ao painel.`,
      true
    );
  } catch (err) {
    return paginaOauth('Nao consegui conectar', err.message, false);
  }
}

/** Guarda (ou limpa) o ultimo erro da conta, para o painel mostrar o que houve. */
async function markAccountError(env, accountId, message) {
  if (!accountId) return; // modo legado (bindings) nao tem linha no banco
  try {
    await env.DB.prepare(
      'UPDATE google_ads_accounts SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
      .bind(message ? String(message).slice(0, 400) : null, accountId)
      .run();
  } catch (err) {
    /* nao deixa erro de log derrubar o envio */
  }
}

/* ----------------------- disparo unificado ------------------------ */

function conversionEvents(env) {
  const raw = clean(env.CONVERSION_EVENTS);
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CONVERSION_EVENTS;
}

/** Envia a conversao para todos os destinos configurados. */
/* --------------------- GA4 Measurement Protocol -------------------- */

/**
 * Manda o evento para o GA4 pelo servidor.
 *
 * A venda aprovada chega por webhook, sem navegador nenhum envolvido — entao o
 * GA4 nunca ficaria sabendo dela. Sem isso, publico de "compradores" no GA4
 * nasce vazio e a importacao de conversao para o Google Ads nao tem o que ler.
 *
 * O client_id e o mesmo do GA4 no navegador (guardado na costura), o que faz o
 * evento cair na sessao certa em vez de criar um usuario novo.
 */
async function sendToGa4(env, conv) {
  // Produto front com propriedade dedicada manda pra ela; o resto (bump,
  // upsell, produto nao mapeado) cai na propriedade unica original.
  const { measurementId, apiSecret } = resolveGa4Target(env, conv);
  if (!measurementId || !apiSecret) return;

  // O GA4 nao deduplica entre Measurement Protocol e a tag do navegador — ao
  // contrario do Meta, que usa o event_id para isso. Entao um evento que a tag
  // do GTM ja enviou nao pode ser reenviado por aqui: contaria duas vezes e
  // inflaria a conversao. O servidor cobre so o que o navegador nao consegue
  // mandar: venda, pix e abandono, que chegam por webhook.
  if (conv.from_browser) return;

  // Sem client_id o GA4 recusa; o tsid serve de ultimo recurso.
  const clientId = clean(conv.client_id) || clean(conv.tsid);

  const logId = await claimConversion(env, 'ga4', conv);
  if (!logId) return;

  // Antes isso era um return silencioso: a venda simplesmente nao chegava no
  // GA4 e nada aparecia no log. Agora fica registrado o motivo.
  if (!clientId) {
    await finishConversion(
      env,
      logId,
      'skipped',
      'sem client_id nem tsid — a navegacao nao foi costurada com esta venda'
    );
    return;
  }

  try {
    const params = {
      // Obrigatorio: sem ele o GA4 trata a sessao como sem engajamento.
      engagement_time_msec: 1,
      currency: conv.currency || 'BRL'
    };
    if (conv.value !== null && conv.value !== undefined) params.value = Number(conv.value);
    if (conv.transaction_id) params.transaction_id = conv.transaction_id;
    if (conv.purchase_type) params.funnel_step = conv.purchase_type;
    // Vai em todo evento (checkout e compra) para o GA4 conseguir montar
    // publico por produto. Precisa estar registrado como dimensao customizada.
    if (conv.product_name) params.product_name = conv.product_name;
    // Mesmo parametro dos hits do navegador, para o publico por pais pegar os dois.
    if (conv.geo_country) params.geo_country = conv.geo_country;

    // session_id costurado da navegacao: e o que faz a venda cair na mesma
    // sessao do clique no anuncio, em vez de virar uma sessao nova sem origem.
    if (conv.session_id) {
      params.session_id = String(conv.session_id);
    } else if (conv.utm_source) {
      // Sem sessao para juntar, a origem vai no proprio evento como plano B.
      params.source = conv.utm_source;
      if (conv.utm_medium) params.medium = conv.utm_medium;
      if (conv.utm_campaign) params.campaign = conv.utm_campaign;
    }

    // O relatorio de Monetizacao do GA4 so conta a compra quando ela vem com
    // items. Sem isso o evento aparece na lista de eventos e some do ecommerce.
    if (conv.event_name === 'purchase' || conv.event_name === 'refund') {
      params.items = [
        {
          item_id: conv.product_id || conv.transaction_id || 'produto',
          item_name: conv.product_name || 'Produto',
          item_category: conv.purchase_type || 'front',
          price: Number(conv.value) || 0,
          quantity: 1
        }
      ];
    }

    const body = {
      client_id: clientId,
      non_personalized_ads: false,
      events: [{ name: conv.event_name, params }]
    };

    // O user_id nunca leva e-mail em texto puro: o Google proibe dado pessoal
    // no Analytics. O hash mantem a uniao entre dispositivos sem expor ninguem.
    if (conv.email) body.user_id = await sha256(String(conv.email).trim().toLowerCase());

    const res = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}` +
        `&api_secret=${encodeURIComponent(apiSecret)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    // O MP responde 204 sem corpo quando aceita.
    if (res.status === 204 || res.ok) await finishConversion(env, logId, 'sent', 'ok');
    else await finishConversion(env, logId, 'error', `HTTP ${res.status}`);
  } catch (err) {
    await finishConversion(env, logId, 'error', err.message);
  }
}

async function dispatchConversions(env, conv) {
  const paraAnuncios = conversionEvents(env).includes(conv.event_name);
  const paraGa4 = paraAnuncios || GA4_EXTRA_EVENTS.includes(conv.event_name);
  if (!paraGa4) return;

  const envios = [sendToGa4(env, conv).catch((err) => console.error('GA4 MP:', err.message))];

  // Meta e Google Ads so recebem o que deve guiar o lance.
  if (paraAnuncios) {
    envios.push(
      sendToMeta(env, conv).catch((err) => console.error('Meta CAPI:', err.message)),
      sendToGoogleAds(env, conv).catch((err) => console.error('Google Ads:', err.message))
    );
  }

  await Promise.all(envios);
}

/** Monta o objeto de conversao a partir de uma linha de events. */
function conversionFromEvent(row, meta) {
  return {
    event_name: row.event_name,
    event_id: row.event_id || `${row.event_name}:${row.transaction_id || row.tsid || Date.now()}`,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    value: row.value,
    currency: row.currency,
    transaction_id: row.transaction_id,
    product_id: row.product_id,
    product_name: row.product_name,
    purchase_type: row.purchase_type,
    email: row.email,
    phone: row.phone,
    name: row.name,
    city: row.city,
    state: row.state,
    zip: row.zip,
    country: row.country,
    gclid: row.gclid,
    gbraid: row.gbraid,
    wbraid: row.wbraid,
    fbc: row.fbc,
    fbp: row.fbp,
    tsid: row.tsid,
    ip: row.ip || meta?.ip,
    user_agent: row.user_agent || meta?.user_agent,
    page_location: row.page_location
  };
}

/* ------------------------------------------------------------------ *
 * Webhooks das plataformas de venda
 * ------------------------------------------------------------------ */

const STATUS_TO_EVENT = {
  approved: 'purchase',
  paid: 'purchase',
  complete: 'purchase',
  completed: 'purchase',
  aprovado: 'purchase',
  purchase_approved: 'purchase',
  waiting_payment: 'pix_generated',
  pending: 'pix_generated',
  pix_created: 'pix_generated',
  billet_printed: 'boleto_generated',
  boleto_gerado: 'boleto_generated',
  waiting_pix: 'pix_generated',
  abandoned: 'abandoned_checkout',
  abandoned_cart: 'abandoned_checkout',
  cart_abandoned: 'abandoned_checkout',
  checkout_abandoned: 'abandoned_checkout',
  // PerfectPay (checkout abandonado) + variantes PT/ES do LATAM.
  checkout_abandon: 'abandoned_checkout',
  abandonado: 'abandoned_checkout',
  abandono: 'abandoned_checkout',
  refunded: 'refund',
  refund: 'refund',
  reembolsado: 'refund',
  estornado: 'refund',
  chargeback: 'chargeback',
  charged_back: 'chargeback', // PerfectPay: "charged_back" (com underscore)
  chargedback: 'chargeback', // Kiwify: "chargedback" (sem underscore, junto)
  canceled: 'canceled',
  cancelled: 'canceled',
  cancelado: 'canceled',
  expired: 'canceled',
  expirado: 'canceled',
  subscription_canceled: 'subscription_canceled',
  refused: 'payment_refused',
  rejected: 'payment_refused',
  rechazado: 'payment_refused',
  recusado: 'payment_refused',
  pendente: 'pix_generated',
  // PerfectPay LATAM manda o status em espanhol.
  aprobado: 'purchase',
  pagado: 'purchase',
  pendiente: 'pix_generated'
};

/**
 * Nome do evento a partir do status da plataforma.
 *
 * Webhook sem status NUNCA vira venda. Antes virava, e era o buraco mais caro
 * do sistema: bastava um payload novo, quebrado ou de teste chegar sem o campo
 * de status para entrar no painel como receita aprovada.
 *
 * Silencio agora vira "unknown_status" — que aparece no painel para ser
 * investigado, em vez de somar dinheiro que nao existe. Se alguma plataforma
 * passar a mandar venda sem status, o evento aparece la e o mapa se ajusta;
 * o custo de descobrir isso e uma linha estranha no painel, nao um numero
 * inflado em cima do qual voce decide lance de campanha.
 */
function statusToEventName(status) {
  const s = clean(status);
  if (!s) return 'unknown_status';
  const key = s.toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_TO_EVENT[key] || key;
}

/* ---------------------- PerfectPay: status ------------------------- *
 *
 * A PerfectPay e a unica plataforma aqui que manda o status de tres formas
 * diferentes, e tratar as tres e o que faz o Brasil e o LATAM funcionarem no
 * mesmo codigo:
 *
 *   1. sale_status_enum_key  string ("approved", "rejected")  — checkout BR
 *   2. sale_status_enum      numero (2, 5, 6, 7, 12, 13)      — sempre presente
 *   3. nada                  o webhook de carrinho abandonado omite a string
 *
 * O caso 3 e o perigoso: antes ele caia no `if (!s) return 'purchase'` do
 * statusToEventName e virava venda aprovada por omissao. Qualquer payload
 * quebrado, de qualquer status, entrava como receita.
 *
 * O mapa abaixo cobre so os enums observados nos payloads reais deste banco
 * (a coluna raw_payload guarda todos). O que nao estiver aqui vira
 * "unknown_status": aparece no painel para ser investigado, em vez de sumir
 * ou, pior, ser contado como venda.
 */
const PERFECTPAY_STATUS_ENUM = {
  2: 'purchase',        // approved — confirmado por sale_status_enum_key
  5: 'payment_refused', // rejected
  6: 'canceled',        // cancelled
  7: 'refund',          // refunded
  // 12 e CHECKOUT ABANDONADO — nao e venda. O que separa um do outro:
  //
  //   code            PPCCKT... (ChecKouT)   vs  PPCPMT... (venda)
  //   date_approved   ausente                vs  preenchido
  //   billet_url      .../checkout/PPCCKT... vs  vazio
  //
  // A correlacao e de 100% nos 80 webhooks recebidos ate aqui. Cuidado com o
  // sale_amount_paid: ele vem preenchido tambem no abandono (e o valor do
  // carrinho, nao um pagamento) e nao serve para distinguir os dois.
  12: 'abandoned_checkout',
  13: 'canceled'        // expired
};

/** Os unicos status que valem uma venda aprovada na PerfectPay. */
const PERFECTPAY_APROVADO = new Set(['aprovado', 'approved', 'aprobado']);

/**
 * Evento de um webhook da PerfectPay — Brasil e LATAM.
 *
 * Regra dura: purchase so sai de um status de aprovacao explicito. Silencio,
 * status desconhecido ou enum novo nunca viram venda.
 */
function perfectPayEventName(data) {
  // Trava de seguranca, antes de qualquer mapa: um webhook de CHECKOUT nunca e
  // venda, diga o status o que disser. Foi assim que 67 carrinhos abandonados
  // entraram no painel como receita — o enum era desconhecido e o payload caiu
  // no caminho generico. Aqui o formato do proprio dado tranca a porta.
  const code = clean(pick(data, ['code']));
  const ehCheckout =
    (code && /^PPCCKT/i.test(code)) ||
    /\/checkout\//i.test(clean(pick(data, ['billet_url'])) || '');
  const aprovadoEm = clean(pick(data, ['date_approved']));
  if (ehCheckout && !aprovadoEm) return 'abandoned_checkout';

  const bruto = clean(
    pick(data, ['sale_status_enum_key', 'sale_status', 'status', 'current_status'])
  );

  if (bruto) {
    const key = bruto.toLowerCase().replace(/[\s-]+/g, '_');
    if (PERFECTPAY_APROVADO.has(key)) return 'purchase';

    // Qualquer outro caminho para purchase esta fechado: um status conhecido
    // mas nao-aprovado usa o mapa geral; o resto (inclusive sinonimos de pago
    // como "paid" ou "completed") vira unknown_status, para aparecer no painel.
    const mapeado = STATUS_TO_EVENT[key];
    return mapeado && mapeado !== 'purchase' ? mapeado : 'unknown_status';
  }

  const enumNum = toNumber(pick(data, ['sale_status_enum']));
  if (enumNum !== null && PERFECTPAY_STATUS_ENUM[enumNum]) {
    return PERFECTPAY_STATUS_ENUM[enumNum];
  }

  return 'unknown_status';
}

/** Detecta a plataforma pelo formato do payload quando nao vem na URL. */
function detectPlatform(data) {
  // Kirvano: checkout_id + sale_id, com utm.* e cookies.* aninhados.
  if (data.checkout_id && data.sale_id) return 'kirvano';
  // Kirvano tambem manda ABANDONED_CART sem sale_id e com checkout_id="null"
  // (string literal) — nesse formato a unica pista e a URL do proprio checkout.
  if (typeof data.checkout_url === 'string' && /kirvano\.com/i.test(data.checkout_url)) return 'kirvano';
  if (data.webhook_event_type || data.Customer || data.order_id) return 'kiwify';
  if (data.hottok || data.prod || (data.data && data.data.purchase)) return 'hotmart';
  // PerfectPay: code (PPCPMTB...) + sale_amount/sale_status_enum, e metadados em metadata.*
  if (
    data.code_order ||
    data.sale_status_enum ||
    data.sale_status_enum_key ||
    (data.code && data.sale_amount !== undefined) ||
    (typeof data.code === 'string' && /^PPC/i.test(data.code))
  ) {
    return 'perfectpay';
  }
  if (data.cod_venda || data.venda) return 'monetizze';
  if (data.trans_key || data.basket) return 'braip';
  if (data.trans_cod || data.product_cod) return 'eduzz';
  if (data.cart_token || data.order) return 'cartpanda';
  return 'generic';
}

/** Extrai um payload normalizado a partir de qualquer plataforma conhecida. */
function normalizeWebhook(data, platform, env) {
  const status = pick(data, [
    'status', 'order_status', 'webhook_event_type', 'sale_status_enum_key',
    'data.purchase.status', 'purchase.status', 'venda.status', 'event',
    'sale_status', 'current_status'
  ]);

  // A PerfectPay tem regra propria (ver perfectPayEventName): purchase so com
  // aprovacao explicita, e o enum numerico como fonte quando a string nao vem.
  const eventName =
    platform === 'perfectpay' ? perfectPayEventName(data) : statusToEventName(status);

  let value = toNumber(
    pick(data, [
      // Valor ja numerico vem primeiro; "R$ 162,80" tambem e aceito adiante.
      'fiscal.total_value', 'fiscal.net_value',
      'value', 'amount', 'price', 'Commissions.charge_amount', 'charge_amount',
      'sale_amount', 'data.purchase.price.value', 'purchase.price.value',
      'total_price', 'venda.valor', 'order.total_price', 'commission.value'
    ])
  );
  // Kiwify e algumas plataformas enviam centavos.
  const chargeAmount = pick(data, ['Commissions.charge_amount', 'charge_amount']);
  if (chargeAmount !== null && value !== null && Number.isInteger(value) && value > 1000) {
    value = value / 100;
  }

  const items = pick(data, ['items', 'products', 'data.purchase.items', 'order.line_items']);

  // Ultimo recurso para plataformas que engolem o click id (ver
  // clickIdEmUtmContent). So entra quando o campo proprio veio vazio.
  const utmContent = clean(
    pick(data, ['utm_content', 'utm.utm_content', 'TrackingParameters.utm_content', 'metadata.utm_content'])
  );
  const clickIdResgatado = clickIdEmUtmContent(utmContent);

  const productIdRaw = clean(
    // Kiwify manda em "Product.product_id" (com P maiusculo).
    pick(data, ['product_id', 'product.id', 'product.code', 'product_code', 'prod', 'Product.product_id', 'data.product.id', 'product_cod', 'products.0.id'])
  );
  const productNameRaw = clean(
    pick(data, ['product_name', 'product.name', 'prod_name', 'Product.product_name', 'data.product.name', 'produto', 'products.0.name'])
  );
  // Hostname cru (sem excluir dominio de checkout) so para casar contra o
  // productList — domain de landing tambem e um token valido de produto.
  const hostnameCru = hostnameOf(pick(data, ['page_url', 'checkout_url', 'src_url', 'url', 'referrer']));

  return {
    event_name: eventName,
    platform: platform,
    status: clean(status),
    // O dominio que interessa e o da landing que gerou a venda, nao o do
    // checkout. Se a plataforma mandar a propria URL dela, ignoramos e deixamos
    // a costura preencher com a pagina de origem.
    hostname: nonCheckoutHostname(env, pick(data, ['page_url', 'checkout_url', 'src_url', 'url', 'referrer'])),
    transaction_id: clean(
      pick(data, [
        'transaction_id', 'order_id', 'code_order', 'trans_cod', 'trans_key',
        'cod_venda', 'data.purchase.transaction', 'purchase.transaction', 'id',
        'sale_id', 'order.id',
        // PerfectPay: o codigo da venda vem em "code" (ex.: PPCPMTB...).
        'code'
      ])
    ),
    order_id: clean(pick(data, ['order_id', 'order_ref', 'code_order', 'checkout_id', 'order.number', 'code'])),
    value: value,
    // PerfectPay usa currency_enum_key ('BRL'/'USD') — importante no LATAM.
    // PerfectPay LATAM manda a moeda real em currency_paid ('COP','CLP','MXN'...)
    // e o enum numerico em currency_enum. Sem isto a venda vira 'BRL' e infla a
    // receita em reais. currency_enum_key cobre o formato BR.
    currency: clean(pick(data, ['currency', 'currency_code', 'currency_enum_key', 'currency_paid', 'data.purchase.price.currency_value'])) || 'BRL',
    commission: toNumber(pick(data, ['fiscal.commission', 'commission', 'Commissions.my_commission', 'commission_value'])),
    // PerfectPay: product.code (id) e product.name; o "plano" vira a oferta.
    product_id: productIdRaw,
    // O nosso cadastro (productList) tem prioridade sobre o nome que a
    // plataforma manda. A mesma oferta pode ter ate 3 nomes diferentes na
    // PerfectPay — o codigo do link de checkout, o codigo do produto no
    // webhook e o nome cadastrado la dentro, que pode nao ter nada a ver com
    // como chamamos o produto aqui. Sem isto, a venda de um produto ja
    // cadastrado (por link ou dominio) chegava com o nome cru da plataforma —
    // um produto so, aparecendo como dois no painel e no GA4.
    product_name: resolveProduct(env, [productIdRaw, productNameRaw, hostnameCru]) || productNameRaw,
    offer_name: clean(pick(data, ['offer_name', 'offer.name', 'plan.name', 'data.purchase.offer.code', 'plan_name', 'products.0.offer_name'])),
    payment_method: clean(pick(data, ['payment_method', 'payment_method_enum_key', 'payment_type', 'payment.method', 'data.purchase.payment.type', 'forma_pagamento'])),
    installments: toNumber(pick(data, ['installments', 'installment_quantity', 'installments_number', 'data.purchase.payment.installments_number'])),

    // Cupom e valor cheio: permitem medir quanto desconto realmente custa.
    coupon_code: clean(pick(data, [
      'coupon_code', 'couponCode', 'coupon', 'cupom', 'discount_coupon',
      'coupon.code', 'data.purchase.offer.coupon_code'
    ])),
    original_value: toNumber(pick(data, [
      'fiscal.original_value', 'original_value', 'total_price_without_discount',
      'full_price', 'data.purchase.original_offer_price.value'
    ])),

    customer_name: clean(pick(data, ['customer_name', 'Customer.full_name', 'customer.full_name', 'Customer.first_name', 'buyer.name', 'data.buyer.name', 'customer.name', 'name', 'cliente.nome'])),
    first_name: firstNameOf(pick(data, ['customer_name', 'Customer.full_name', 'customer.full_name', 'Customer.first_name', 'customer.first_name', 'buyer.name', 'data.buyer.name', 'customer.name', 'name', 'cliente.nome'])),
    customer_email: normalizeEmail(pick(data, ['customer_email', 'Customer.email', 'buyer.email', 'data.buyer.email', 'customer.email', 'email', 'cliente.email', 'contactEmail'])),
    // PerfectPay: phone_formated ja vem com DDD; phone_number sozinho nao tem.
    // phone_formated_ddi vem primeiro: ja traz o codigo do pais (+52, +1...).
    customer_phone: normalizePhone(pick(data, ['customer.phone_formated_ddi', 'customer_phone', 'Customer.mobile', 'Customer.phone', 'buyer.phone', 'data.buyer.phone', 'customer.phone_formated', 'customer.full_phone', 'customer.phone_number', 'customer.phone', 'phone', 'cliente.telefone'])),
    // PerfectPay: identification_number (CPF/CNPJ ou documento LATAM).
    customer_document: cleanDocument(pick(data, ['customer_document', 'Customer.CPF', 'Customer.cpf', 'buyer.document', 'data.buyer.document', 'customer.identification_number', 'identification_number', 'customer.document', 'cpf', 'cliente.cpf'])),
    customer_city: clean(pick(data, ['Customer.city', 'customer.city', 'buyer.address.city', 'data.buyer.address.city', 'customer.address.city', 'city'])),
    customer_state: clean(pick(data, ['Customer.state', 'customer.state', 'buyer.address.state', 'data.buyer.address.state', 'customer.address.state', 'state'])),
    customer_zip: clean(pick(data, ['Customer.zipcode', 'customer.zip_code', 'customer.zipcode', 'buyer.address.zipcode', 'data.buyer.address.zip_code', 'customer.address.zipcode', 'zip'])),
    customer_country: clean(pick(data, ['Customer.country', 'customer.country', 'buyer.address.country', 'data.buyer.address.country', 'customer.address.country', 'country'])),
    ip: clean(pick(data, ['ip', 'customer.ip', 'client_ip', 'buyer.ip'])),

    // Os IDs de clique podem vir na raiz, em TrackingParameters, ou aninhados em
    // utm.* / cookies.* — cada plataforma escolhe um formato.
    // PerfectPay repassa os parametros do checkout em metadata.* (e as vezes src.*).
    tsid:
      clean(pick(data, ['tsid', 'TrackingParameters.tsid', 'tracking.tsid', 'utm.tsid', 'metadata.tsid', 'src.tsid'])) ||
      // Plano B: o snippet manda o mesmo id como utm_id (ver decorateUrl),
      // porque as plataformas descartam parametros proprios como "tsid" mas
      // repassam os UTMs padrao. Kirvano aninha em utm.*, PerfectPay em
      // metadata.*/src.*. So aceitamos com cara de UUID — senao o utm_id
      // legitimo de uma campanha viraria um tsid inventado.
      tsidDeUtmId(pick(data, [
        'utm_id', 'utm.utm_id', 'metadata.utm_id', 'src.utm_id',
        'TrackingParameters.utm_id', 'tracking.utm_id'
      ])),
    gclid:
      cleanClickId(pick(data, ['gclid', 'TrackingParameters.gclid', 'tracking.gclid', 'cookies.gclid', 'utm.gclid', 'metadata.gclid', 'src.gclid'])) ||
      clickIdResgatado,
    gbraid: cleanClickId(pick(data, ['gbraid', 'TrackingParameters.gbraid', 'cookies.gbraid', 'utm.gbraid', 'metadata.gbraid', 'src.gbraid'])),
    wbraid: cleanClickId(pick(data, ['wbraid', 'TrackingParameters.wbraid', 'cookies.wbraid', 'utm.wbraid', 'metadata.wbraid', 'src.wbraid'])),
    fbclid: cleanClickId(pick(data, ['fbclid', 'TrackingParameters.fbclid', 'cookies.fbclid', 'utm.fbclid', 'metadata.fbclid', 'src.fbclid'])),
    fbc: clean(pick(data, ['fbc', 'TrackingParameters.fbc', 'cookies.fbc', 'cookies._fbc', 'metadata.fbc', 'metadata._fbc'])),
    fbp: clean(pick(data, ['fbp', 'TrackingParameters.fbp', 'cookies.fbp', 'cookies._fbp', 'metadata.fbp', 'metadata._fbp'])),
    ttclid: cleanClickId(pick(data, ['ttclid', 'TrackingParameters.ttclid', 'cookies.ttclid', 'metadata.ttclid'])),
    msclkid: cleanClickId(pick(data, ['msclkid', 'TrackingParameters.msclkid', 'cookies.msclkid', 'metadata.msclkid'])),
    utm_source: clean(pick(data, ['utm_source', 'utm.utm_source', 'TrackingParameters.utm_source', 'metadata.utm_source', 'tracking.source', 'src'])),
    utm_medium: clean(pick(data, ['utm_medium', 'utm.utm_medium', 'TrackingParameters.utm_medium', 'metadata.utm_medium'])),
    utm_campaign: clean(pick(data, ['utm_campaign', 'utm.utm_campaign', 'TrackingParameters.utm_campaign', 'metadata.utm_campaign', 'tracking.campaign'])),
    utm_term: clean(pick(data, ['utm_term', 'utm.utm_term', 'TrackingParameters.utm_term', 'metadata.utm_term'])),
    utm_content: utmContent,

    items: items ? JSON.stringify(items) : null,
    raw_payload: JSON.stringify(data)
  };
}

/* ------------------------------------------------------------------ *
 * Classificacao da etapa do funil: front, order_bump, upsell, downsell
 *
 * Order bump, upsell e downsell chegam como webhooks separados (transacoes
 * distintas), com o mesmo cliente. O que os diferencia e o produto. Cada lista
 * (bindings *_PRODUCT_IDS) traz os ids/nomes daquela etapa, separados por
 * virgula/quebra de linha. Um token com prefixo "re:" e tratado como regex.
 * ------------------------------------------------------------------ */

function parseProductList(raw) {
  const s = clean(raw);
  if (!s) return [];
  return s.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
}

/** Um produto casa com a lista por id exato, por substring no id/nome/oferta, ou por regex. */
function productMatches(purchase, tokens) {
  if (!tokens.length) return false;
  const id = String(purchase.product_id || '').toLowerCase().trim();
  const hay = [purchase.product_id, purchase.product_name, purchase.offer_name]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  for (const token of tokens) {
    if (token.slice(0, 3).toLowerCase() === 're:') {
      try {
        if (new RegExp(token.slice(3), 'i').test(hay)) return true;
      } catch (e) { /* regex invalida — ignora */ }
      continue;
    }
    const t = token.toLowerCase();
    if (id && id === t) return true;      // id exato
    if (hay.indexOf(t) > -1) return true; // substring em id/nome/oferta
  }
  return false;
}

/**
 * Resolve para qual propriedade GA4 mandar um evento vindo de webhook.
 *
 * PRODUCT_GA4_PROPERTIES so lista os produtos front que ganharam propriedade
 * dedicada (ver scripts/propriedades-por-produto.mjs). Order bump, upsell,
 * produto nao mapeado ou produto nao reconhecido no nome/id caem no padrao —
 * a propriedade unica original — porque nao ha como saber com certeza a qual
 * produto principal um bump pertence.
 */
function resolveGa4Target(env, conv) {
  const fallback = { measurementId: clean(env.GA4_MEASUREMENT_ID), apiSecret: clean(env.GA4_API_SECRET) };

  let mapa;
  try {
    mapa = JSON.parse(env.PRODUCT_GA4_PROPERTIES || '[]');
  } catch {
    return fallback;
  }
  if (!Array.isArray(mapa) || !mapa.length) return fallback;

  let produtos;
  try {
    produtos = JSON.parse(env.PRODUCT_LIST || '[]');
  } catch {
    return fallback;
  }
  if (!Array.isArray(produtos) || !produtos.length) return fallback;

  for (const produto of produtos) {
    const tokens = Array.isArray(produto?.match) ? produto.match : [];
    if (!tokens.length || !productMatches(conv, tokens)) continue;
    const alvo = mapa.find((m) => m.product === produto.name);
    if (alvo && alvo.measurementId && alvo.apiSecret) {
      return { measurementId: alvo.measurementId, apiSecret: alvo.apiSecret };
    }
    break; // Produto reconhecido mas sem propriedade dedicada — usa o padrao.
  }

  return fallback;
}

/**
 * Etapa do funil vinda do proprio PRODUCT_LIST.
 *
 * O productList ja marca quem nao e produto principal (bump: true) e aceita um
 * campo step explicito ("order_bump" | "upsell" | "downsell"). Sem isto, as
 * listas *_PRODUCT_IDS teriam que repetir a mesma informacao — e quando ficam
 * vazias (o caso comum) toda venda virava "front", zerando a receita
 * incremental do painel mesmo com bump e upsell vendendo.
 */
function stepFromProductList(purchase, env) {
  let produtos;
  try {
    produtos = JSON.parse(env.PRODUCT_LIST || '[]');
  } catch (err) {
    return null;
  }
  if (!Array.isArray(produtos)) return null;

  for (const produto of produtos) {
    const tokens = Array.isArray(produto?.match) ? produto.match : [];
    if (!tokens.length || !productMatches(purchase, tokens)) continue;
    const step = clean(produto.step);
    if (step === 'order_bump' || step === 'upsell' || step === 'downsell' || step === 'front') {
      return step;
    }
    // bump: true = vendido dentro do checkout de outro produto. Sem step
    // explicito, order_bump e a leitura mais conservadora.
    return produto.bump ? 'order_bump' : 'front';
  }
  return null;
}

/**
 * Descobre a etapa do funil. A ordem importa: downsell e upsell vencem o order
 * bump, que vence o front. As listas *_PRODUCT_IDS tem prioridade (configuracao
 * explicita); sem elas, cai no que o productList ja diz. Nada casando, assume
 * "front" — a venda principal e o padrao seguro (nunca fica sem etapa).
 */
function classifyFunnelStep(purchase, env) {
  if (productMatches(purchase, parseProductList(env.DOWNSELL_PRODUCT_IDS))) return 'downsell';
  if (productMatches(purchase, parseProductList(env.UPSELL_PRODUCT_IDS))) return 'upsell';
  if (productMatches(purchase, parseProductList(env.ORDER_BUMP_PRODUCT_IDS))) return 'order_bump';
  if (productMatches(purchase, parseProductList(env.FRONT_PRODUCT_IDS))) return 'front';

  const doProductList = stepFromProductList(purchase, env);
  if (doProductList) return doProductList;

  return 'front';
}

/**
 * Costura a venda com a navegacao: se o webhook nao trouxe os IDs de clique,
 * procura o evento mais recente do mesmo cliente (email, telefone, tsid ou
 * transaction_id) e herda a atribuicao dele.
 */
async function stitchAttribution(env, purchase) {
  const hasClickId = purchase.gclid || purchase.gbraid || purchase.wbraid || purchase.fbclid || purchase.fbc;

  // Buscamos o evento de navegacao sempre que faltar alguma peca. O client_id
  // do GA4 e a mais importante: sem ele o Measurement Protocol recusa o evento,
  // e a venda nunca aparece no Analytics. A plataforma de checkout nunca manda
  // esse campo — ele so existe na navegacao.
  if (hasClickId && purchase.hostname && purchase.client_id) {
    purchase.attribution_source = 'webhook';
    return purchase;
  }

  const conditions = [];
  const args = [];
  if (purchase.tsid) { conditions.push('tsid = ?'); args.push(toParam('tsid', purchase.tsid)); }
  if (purchase.customer_email) { conditions.push('email = ?'); args.push(toParam('email', purchase.customer_email)); }
  if (purchase.customer_phone) { conditions.push('phone = ?'); args.push(toParam('phone', purchase.customer_phone)); }
  if (purchase.transaction_id) { conditions.push('transaction_id = ?'); args.push(toParam('transaction_id', purchase.transaction_id)); }

  // O click id costura o resto: a plataforma devolve o gclid que o proprio
  // visitante trouxe, e a navegacao dele tem client_id e sessao.
  if (purchase.gclid) { conditions.push('gclid = ?'); args.push(toParam('gclid', purchase.gclid)); }
  if (purchase.gbraid) { conditions.push('gbraid = ?'); args.push(toParam('gbraid', purchase.gbraid)); }
  if (purchase.wbraid) { conditions.push('wbraid = ?'); args.push(toParam('wbraid', purchase.wbraid)); }
  if (purchase.fbclid) { conditions.push('fbclid = ?'); args.push(toParam('fbclid', purchase.fbclid)); }
  if (!conditions.length) {
    purchase.attribution_source = hasClickId ? 'webhook' : 'none';
    return purchase;
  }

  const sql =
    'SELECT tsid, client_id, session_id, gclid, gbraid, wbraid, fbclid, fbc, fbp, ttclid, msclkid, ' +
    'hostname, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ' +
    'device_type, browser, os, geo_country, geo_region, geo_city FROM events WHERE (' +
    conditions.join(' OR ') +
    ') AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL OR fbclid IS NOT NULL ' +
    'OR fbc IS NOT NULL OR utm_source IS NOT NULL) ' +
    // Cada venda tambem vira um evento espelhado com o mesmo click id. Sem este
    // filtro a costura acharia o proprio espelho e voltaria de maos vazias.
    "AND source != 'webhook' " +
    // Entre os candidatos, o que tem client_id vale mais: e a peca que o GA4 exige.
    'ORDER BY (client_id IS NOT NULL) DESC, created_at DESC LIMIT 1';

  try {
    const match = (await all(env, sql, args))[0];
    if (!match) {
      // Nao achamos evento para costurar — mas se o webhook ja trouxe o click id,
      // a atribuicao continua valida.
      purchase.attribution_source = hasClickId ? 'webhook' : 'none';
      return purchase;
    }
    for (const key of ['tsid', 'client_id', 'session_id', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp',
      'ttclid', 'msclkid', 'hostname', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
      'utm_content', 'device_type', 'browser', 'os', 'geo_country', 'geo_region', 'geo_city']) {
      if (!purchase[key] && match[key]) purchase[key] = match[key];
    }
    purchase.attribution_source = hasClickId ? 'webhook' : 'stitched';
  } catch (err) {
    console.error('stitchAttribution falhou:', err.message);
    purchase.attribution_source = hasClickId ? 'webhook' : 'error';
  }
  return purchase;
}

async function handleWebhook(request, env, ctx, url) {
  let data;
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.indexOf('application/json') > -1) {
      data = await request.json();
    } else {
      // Varias plataformas mandam form-urlencoded.
      const text = await request.text();
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = Object.fromEntries(new URLSearchParams(text));
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: 'payload invalido' }), { status: 400 });
  }

  const pathPlatform = url.pathname.split('/')[2];
  const platform = clean(pathPlatform) || detectPlatform(data);

  // Responde rapido para a plataforma nao marcar o webhook como falho.
  ctx.waitUntil(
    (async () => {
      try {
        const purchase = await stitchAttribution(env, normalizeWebhook(data, platform, env));
        // Front, order bump, upsell ou downsell — pelo produto.
        purchase.purchase_type = classifyFunnelStep(purchase, env);

        // Versao com hash de e-mail e telefone, pronta para exportar sem expor
        // dado pessoal (Meta CAPI, Customer Match, planilha para o time).
        // O valor original continua na tabela para voce conseguir contatar o cliente.
        if (purchase.customer_email) {
          purchase.email_hash = await sha256(String(purchase.customer_email).trim().toLowerCase());
        }
        if (purchase.customer_phone) {
          purchase.phone_hash = await sha256(String(purchase.customer_phone).replace(/\D/g, ''));
        }

        await insertPurchase(env, purchase);

        // Espelha no funil de eventos para relatorios unificados.
        await insertEvent(env, {
          event_name: purchase.event_name,
          event_id: purchase.transaction_id ? purchase.event_name + ':' + purchase.transaction_id : null,
          source: 'webhook',
          hostname: purchase.hostname,
          tsid: purchase.tsid,
          client_id: purchase.client_id,
          gclid: purchase.gclid,
          gbraid: purchase.gbraid,
          wbraid: purchase.wbraid,
          fbclid: purchase.fbclid,
          fbc: purchase.fbc,
          fbp: purchase.fbp,
          utm_source: purchase.utm_source,
          utm_medium: purchase.utm_medium,
          utm_campaign: purchase.utm_campaign,
          utm_term: purchase.utm_term,
          utm_content: purchase.utm_content,
          transaction_id: purchase.transaction_id,
          value: purchase.value,
          currency: purchase.currency,
          items: purchase.items,
          product_id: purchase.product_id,
          product_name: purchase.product_name,
          purchase_type: purchase.purchase_type,
          email: purchase.customer_email,
          phone: purchase.customer_phone,
          name: purchase.customer_name,
          document: purchase.customer_document,
          city: purchase.customer_city,
          state: purchase.customer_state,
          zip: purchase.customer_zip,
          country: purchase.customer_country,
          raw_params: purchase.raw_payload
        });

        await upsertLead(env, {
          email: purchase.customer_email,
          phone: purchase.customer_phone,
          name: purchase.customer_name,
          document: purchase.customer_document,
          tsid: purchase.tsid,
          gclid: purchase.gclid,
          gbraid: purchase.gbraid,
          wbraid: purchase.wbraid,
          fbclid: purchase.fbclid,
          fbc: purchase.fbc,
          fbp: purchase.fbp,
          utm_source: purchase.utm_source,
          utm_medium: purchase.utm_medium,
          utm_campaign: purchase.utm_campaign
        });

        if (purchase.event_name === 'purchase') await registerLeadPurchase(env, purchase);

        // A venda aprovada volta para o Google Ads e para o Meta com o click ID.
        // E o unico ponto do funil que sabe o que virou dinheiro de verdade.
        await dispatchConversions(env, {
          event_name: purchase.event_name,
          event_id: purchase.transaction_id
            ? `${purchase.event_name}:${purchase.transaction_id}`
            : `${purchase.event_name}:${Date.now()}`,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          value: purchase.value,
          currency: purchase.currency,
          transaction_id: purchase.transaction_id,
          product_id: purchase.product_id,
          product_name: purchase.product_name,
          purchase_type: purchase.purchase_type,
          email: purchase.customer_email,
          phone: purchase.customer_phone,
          name: purchase.customer_name,
          city: purchase.customer_city,
          state: purchase.customer_state,
          zip: purchase.customer_zip,
          country: purchase.customer_country,
          gclid: purchase.gclid,
          gbraid: purchase.gbraid,
          wbraid: purchase.wbraid,
          fbc: purchase.fbc,
          fbp: purchase.fbp,
          tsid: purchase.tsid,
          // client_id vem da costura com a navegacao — e o que faz o GA4
          // reconhecer a venda como do mesmo usuario, e nao de um novo.
          client_id: purchase.client_id,
          session_id: purchase.session_id,
          geo_country: purchase.geo_country,
          utm_source: purchase.utm_source,
          utm_medium: purchase.utm_medium,
          utm_campaign: purchase.utm_campaign,
          ip: purchase.ip,
          user_agent: null,
          page_location: null
        });
      } catch (err) {
        console.error('webhook falhou:', err.message);
      }
    })()
  );

  return new Response(JSON.stringify({ status: 'ok', platform: platform }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/* ------------------------------------------------------------------ *
 * Recuperacao de carrinho abandonado (Cron Trigger — 1x/dia)
 *
 * Le os abandonos das ultimas 24h e envia cada um para a URL de webhook
 * configurada (ActiveCampaign, RD Station, n8n, etc.). E SO LEITURA no D1 —
 * nao grava nada, entao nao pesa no limite de escrita.
 *
 * Regras:
 *   - so quem tem e-mail ou telefone (da para contatar);
 *   - exclui quem ja comprou (mesmo e-mail/telefone) — nao incomoda comprador;
 *   - roda uma vez por dia, janela de 24h, sem sobreposicao entre execucoes.
 * ------------------------------------------------------------------ */

async function runAbandonedRecovery(env) {
  const url = clean(env.ABANDONED_WEBHOOK_URL);
  if (!url) return { skipped: 'sem ABANDONED_WEBHOOK_URL' };

  const rows = await all(
    env,
    `SELECT customer_name, first_name, customer_email, customer_phone, product_name,
            offer_name, value, currency, utm_source, utm_campaign, transaction_id,
            hostname, created_at
       FROM purchases
      WHERE event_name = 'abandoned_checkout'
        AND created_at >= datetime('now', '-1 day')
        AND (customer_email IS NOT NULL OR customer_phone IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM purchases p2
           WHERE p2.event_name = 'purchase'
             AND ((p2.customer_email IS NOT NULL AND p2.customer_email = purchases.customer_email)
               OR (p2.customer_phone IS NOT NULL AND p2.customer_phone = purchases.customer_phone))
        )
      ORDER BY created_at DESC
      LIMIT 500`
  );

  const headers = { 'Content-Type': 'application/json' };
  if (clean(env.ABANDONED_WEBHOOK_TOKEN)) {
    headers['Authorization'] = `Bearer ${clean(env.ABANDONED_WEBHOOK_TOKEN)}`;
  }

  let sent = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event: 'abandoned_cart',
            name: r.customer_name || null,
            first_name: r.first_name || null,
            email: r.customer_email || null,
            phone: r.customer_phone || null,
            product: r.product_name || r.offer_name || null,
            value: r.value,
            currency: r.currency || 'BRL',
            utm_source: r.utm_source || null,
            utm_campaign: r.utm_campaign || null,
            transaction_id: r.transaction_id || null,
            hostname: r.hostname || null,
            abandoned_at: r.created_at
          })
        });
        if (res.ok) sent++;
      } catch (err) {
        console.error('abandono -> webhook falhou:', err.message);
      }
    })
  );

  console.log(`recuperacao de abandono: ${sent}/${rows.length} enviados`);
  return { total: rows.length, sent };
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export default {
  // Cron Trigger da Cloudflare: dispara a recuperacao de abandono.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAbandonedRecovery(env).catch((err) => console.error('scheduled falhou:', err.message))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    await loadProductList(env);

    if (path === '/t.js') {
      // productList do perfil, validada, injetada como literal JS no snippet.
      let productListJson = '[]';
      const rawList = clean(env.PRODUCT_LIST);
      if (rawList) {
        try { JSON.parse(rawList); productListJson = rawList; } catch (e) { /* invalido: fica [] */ }
      }
      const body = SNIPPET_SOURCE.replace('__ENDPOINT__', url.origin)
        .replace('__GA4_ID__', env.GA4_MEASUREMENT_ID || '')
        .replace('__TRACK_PV__', String(env.TRACK_PAGE_VIEWS) === 'true' ? 'true' : 'false')
        .replace('__TRACK_ENGAGEMENT__', String(env.TRACK_ENGAGEMENT) === 'true' ? 'true' : 'false')
        .replace('__CHECKOUT_DOMAINS__', dominiosConfigurados(env).join(','))
        .replace('__PRODUCT_LIST__', () => productListJson);
      return new Response(body, {
        status: 200,
        headers: corsHeaders(request, {
          'content-type': 'application/javascript; charset=utf-8',
          // Cache curto: uma correcao no rastreamento precisa chegar rapido,
          // e o arquivo e pequeno.
          'cache-control': 'public, max-age=60'
        })
      });
    }

    if (path === '/g/collect') {
      return handleGa4Collect(request, env, ctx, url);
    }

    if (path === '/collect' && request.method === 'POST') {
      return handleCollect(request, env, ctx);
    }

    if (path === '/webhook' || path.indexOf('/webhook/') === 0) {
      if (request.method !== 'POST') {
        return new Response('Use POST', { status: 405 });
      }
      return handleWebhook(request, env, ctx, url);
    }

    // Dispara a recuperacao de abandono na hora (para testar sem esperar o cron).
    if (path === '/abandoned/run') {
      const token = clean(env.ABANDONED_WEBHOOK_TOKEN);
      const given = url.searchParams.get('token');
      if (token && given !== token) {
        return new Response('Unauthorized', { status: 401 });
      }
      const result = await runAbandonedRecovery(env);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: corsHeaders(request, { 'content-type': 'application/json' })
      });
    }

    // OAuth do Google Ads: uma conta por vez, cada uma com o seu refresh token.
    if (path === '/oauth/google/start') {
      return handleGoogleOauthStart(request, env, url);
    }
    if (path === '/oauth/google/callback') {
      return handleGoogleOauthCallback(request, env, url);
    }

    if (path === '/health') {
      try {
        const row = (await all(env, 'SELECT COUNT(*) AS total FROM events'))[0];
        return new Response(
          JSON.stringify({
            ok: true,
            database: 'd1',
            events: (row && row.total) || 0,
            trackPageViews: String(env.TRACK_PAGE_VIEWS) === 'true'
          }),
          { status: 200, headers: corsHeaders(request, { 'content-type': 'application/json' }) }
        );
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: corsHeaders(request, { 'content-type': 'application/json' })
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
