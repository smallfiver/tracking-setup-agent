import { google } from 'googleapis';
import fs from 'fs';
import chalk from 'chalk';

/**
 * Configuracao do container web do GTM.
 *
 * Tudo aqui e idempotente: container, variaveis, acionadores e tags sao
 * procurados pelo nome e atualizados se ja existirem. Rodar o setup duas vezes
 * nao cria containers duplicados.
 */

const tpl = (key, value) => ({ type: 'template', key, value });
const bool = (key, value) => ({ type: 'boolean', key, value: String(value) });

/**
 * A API do GTM permite 30 chamadas por minuto por usuario e o setup completo
 * faz cerca de 45. Espacamos as chamadas e, se ainda assim tomarmos 429,
 * esperamos a janela virar e tentamos de novo.
 */
const MIN_INTERVAL_MS = 2200; // ~27 chamadas/min, com folga
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCallAt = 0;
let callCount = 0;

function isRateLimit(err) {
  const status = err?.response?.status || err?.code;
  const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.errors?.[0]?.reason;
  return status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
}

/** Executa uma chamada da API respeitando o limite de cota. */
async function api(label, fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    try {
      const result = await fn();
      callCount++;
      return result;
    } catch (err) {
      if (!isRateLimit(err) || attempt === MAX_RETRIES) throw err;
      console.log(chalk.yellow(`  cota do GTM atingida em "${label}" — aguardando 65s (tentativa ${attempt})`));
      await sleep(65000);
      lastCallAt = 0;
    }
  }
}

/** Converte a lista de produtos ("123, curso, re:bump\d+") numa regex do GTM. */
function funnelListToRegex(raw) {
  const tokens = String(raw || '')
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens
    .map((t) =>
      t.slice(0, 3).toLowerCase() === 're:'
        ? t.slice(3)
        : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('|');
}

/**
 * Gera o corpo de uma variavel "Custom JavaScript" do GTM que resolve o
 * produto direto de location/document — sem depender do snippet (que carrega
 * async e pode nao ter rodado ainda quando o page_view automatico do GTM
 * dispara). E o mesmo casamento (substring/regex) que o snippet faz para o
 * checkout, aplicado aqui a toda visita.
 */
function productResolverJs(productListRaw) {
  let list = [];
  try {
    const parsed = JSON.parse(productListRaw || '[]');
    if (Array.isArray(parsed)) list = parsed.filter((p) => p && p.name);
  } catch (err) {
    list = [];
  }
  // JSON.stringify escapa tudo (aspas, unicode) com seguranca para virar literal JS.
  const listJson = JSON.stringify(list);
  return `function() {
  var PRODUCT_LIST = ${listJson};
  if (!PRODUCT_LIST.length) return undefined;
  var hay = ((location.href || '') + ' ' + (document.referrer || '') + ' ' + (document.title || '')).toLowerCase();
  for (var i = 0; i < PRODUCT_LIST.length; i++) {
    var prod = PRODUCT_LIST[i];
    var tokens = prod && prod.match ? prod.match : [];
    for (var j = 0; j < tokens.length; j++) {
      var t = String(tokens[j] || '').toLowerCase().trim();
      if (!t) continue;
      if (t.slice(0, 3) === 're:') {
        try { if (new RegExp(t.slice(3), 'i').test(hay)) return prod.name; } catch (e) {}
        continue;
      }
      if (hay.indexOf(t) > -1) return prod.name;
    }
  }
  return undefined;
}`;
}

export async function setupGTM({ accountId, containerName, measurementId, credentialsPath, workerUrl, funnel = {} }) {
  console.log(chalk.blue('→ GTM: configurando container...'));

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Credenciais do Google nao encontradas em: ${credentialsPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: [
      // Tags, acionadores e variaveis.
      'https://www.googleapis.com/auth/tagmanager.edit.containers',
      // Criar a versao do container — escopo separado, exigido por CreateContainerVersion.
      'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
      // Publicar a versao criada.
      'https://www.googleapis.com/auth/tagmanager.publish'
    ]
  });

  const gtm = google.tagmanager({ version: 'v2', auth });
  const accountPath = `accounts/${accountId}`;

  /* ----------------------- container ----------------------- */

  const existing = await api('listar containers', () =>
    gtm.accounts.containers.list({ parent: accountPath })
  );
  let container = (existing.data.container || []).find((c) => c.name === containerName);

  if (container) {
    console.log(chalk.gray(`  container existente reutilizado: ${container.publicId}`));
  } else {
    const created = await api('criar container', () =>
      gtm.accounts.containers.create({
        parent: accountPath,
        requestBody: { name: containerName, usageContext: ['web'] }
      })
    );
    container = created.data;
    console.log(chalk.gray(`  container criado: ${container.publicId}`));
  }

  const containerPath = container.path;
  const workspaces = await api('listar workspaces', () =>
    gtm.accounts.containers.workspaces.list({ parent: containerPath })
  );
  const workspacePath = workspaces.data.workspace[0].path;

  console.log(
    chalk.gray('  configurando ~45 itens; a API do GTM limita 30 chamadas/min, entao leva ~2 min')
  );

  /* ------------------- variaveis built-in ------------------ */

  try {
    await api('variaveis built-in', () =>
      gtm.accounts.containers.workspaces.built_in_variables.create({
        parent: workspacePath,
        type: ['clickUrl', 'clickText', 'clickClasses', 'clickId', 'pageUrl', 'pagePath', 'pageHostname', 'referrer', 'event']
      })
    );
  } catch (err) {
    // Ja habilitadas — nao e erro.
  }

  /* --------------------- upsert helpers -------------------- */

  const cache = {};
  async function listAll(kind) {
    if (cache[kind]) return cache[kind];
    const res = await api(`listar ${kind}`, () =>
      gtm.accounts.containers.workspaces[kind].list({ parent: workspacePath })
    );
    cache[kind] = res.data[kind === 'variables' ? 'variable' : kind === 'triggers' ? 'trigger' : 'tag'] || [];
    return cache[kind];
  }

  async function upsert(kind, body) {
    const items = await listAll(kind);
    const found = items.find((i) => i.name === body.name);
    const idField = kind === 'variables' ? 'variableId' : kind === 'triggers' ? 'triggerId' : 'tagId';

    if (found) {
      const res = await api(`atualizar ${body.name}`, () =>
        gtm.accounts.containers.workspaces[kind].update({ path: found.path, requestBody: body })
      );
      return res.data[idField];
    }

    const res = await api(`criar ${body.name}`, () =>
      gtm.accounts.containers.workspaces[kind].create({ parent: workspacePath, requestBody: body })
    );
    cache[kind].push(res.data);
    return res.data[idField];
  }

  /* ------------------------ variaveis ---------------------- */

  await upsert('variables', {
    name: 'transporturl',
    type: 'c',
    parameter: [tpl('value', workerUrl)]
  });

  // IDs de clique e UTMs vindos da query string.
  const urlParams = [
    'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'
  ];
  for (const param of urlParams) {
    await upsert('variables', {
      name: `${param.toUpperCase()} - URL`,
      type: 'u',
      parameter: [tpl('component', 'QUERY'), tpl('queryKey', param)]
    });
  }

  // _fbc/_fbp/_tsid sao cookies de primeira parte, nao parametros de URL.
  // _tsprod e escrito pelo snippet com o produto da pagina — e o que permite
  // mandar product_name em TODO evento do GA4, nao so nas tags de conversao.
  const cookies = { FBC: '_fbc', FBP: '_fbp', TSID: '_tsid', PRODUCT: '_tsprod' };
  for (const [name, cookieName] of Object.entries(cookies)) {
    await upsert('variables', {
      name: `${name} - Cookie`,
      type: 'k',
      parameter: [tpl('name', cookieName), bool('decodeCookie', true)]
    });
  }

  // Variaveis de dataLayer usadas pelas tags de ecommerce.
  const dataLayerVars = {
    'DL - transaction_id': 'ecommerce.transaction_id',
    'DL - value': 'ecommerce.value',
    'DL - currency': 'ecommerce.currency',
    'DL - items': 'ecommerce.items',
    'DL - email': 'customer.email',
    'DL - phone': 'customer.phone',
    'DL - name': 'customer.name',
    'DL - event_id': 'event_id',
    // Produto — usados para separar front / order bump / upsell / downsell.
    'DL - product_id': 'ecommerce.items.0.item_id',
    'DL - product_name': 'ecommerce.items.0.item_name',
    // Marco da VSL (30s, 300s, "pitch"...). Sem esta variavel o GA4 recebe o
    // evento de video sem saber ate onde a pessoa assistiu — e o publico de
    // retencao fica impossivel de montar.
    'DL - video_mark': 'video_mark',
    'DL - video_seconds': 'video_seconds',
    // Tempo na pagina (30s/1min/3min/5min/10min) — rede de seguranca para
    // paginas sem player de VSL. Mesmo par (tipo, valor) que a VSL usa.
    'DL - engagement_value': 'engagement_value'
  };
  for (const [name, dlPath] of Object.entries(dataLayerVars)) {
    await upsert('variables', {
      name,
      type: 'v',
      parameter: [tpl('name', dlPath), { type: 'integer', key: 'dataLayerVersion', value: '2' }]
    });
  }

  console.log(chalk.gray('  variaveis prontas'));

  /* ------------------------ acionadores --------------------- */

  const allPagesId = await upsert('triggers', { name: 'All Pages', type: 'pageview' });

  // Dispara begin_checkout so quando o clique VAI para o dominio do checkout
  // (a plataforma de pagamento). Antes casava palavras genericas (comprar,
  // assinar, pagamento) que aparecem tambem no botao da pre-venda e faziam o
  // evento disparar cedo demais. Olhar o host do checkout elimina o falso
  // positivo: o botao da pre-venda e um link interno e nunca casa aqui.
  // Se o checkout usa dominio proprio, acrescente o host ao final da regex.
  const checkoutClickId = await upsert('triggers', {
    name: 'Click - Link de Checkout',
    type: 'linkClick',
    waitForTags: bool('waitForTags', false),
    checkValidation: bool('checkValidation', false),
    filter: [
      {
        type: 'matchRegex',
        parameter: [
          tpl('arg0', '{{Click URL}}'),
          tpl('arg1', 'pay\\.kirvano\\.com'),
          bool('ignore_case', true)
        ]
      }
    ]
  });

  const customEvents = [
    'view_item', 'add_to_cart', 'initiate_checkout', 'begin_checkout',
    'add_payment_info', 'generate_lead', 'purchase'
  ];
  const triggerIds = {};
  for (const eventName of customEvents) {
    triggerIds[eventName] = await upsert('triggers', {
      name: `CE - ${eventName}`,
      type: 'customEvent',
      customEventFilter: [
        { type: 'equals', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', eventName)] }
      ]
    });
  }

  console.log(chalk.gray('  acionadores prontos'));

  /* -------------- variavel: produto resolvido pela URL -------------- *
   * Roda em JS puro (location/document), sem depender do snippet — que
   * carrega async e pode nao ter executado ainda quando o page_view
   * automatico do GTM dispara. Por isso a visita tambem sabe o produto,
   * nao so o checkout.
   */
  await upsert('variables', {
    name: 'JS - Produto (URL)',
    type: 'jsm',
    parameter: [tpl('javascript', productResolverJs(funnel.PRODUCT_LIST))]
  });

  /* --------------------------- tags -------------------------- */

  // 1) Carrega o snippet first-party o mais cedo possivel.
  await upsert('tags', {
    name: 'Tracking - Snippet First Party',
    type: 'html',
    priority: { type: 'integer', key: 'priority', value: '1000' },
    parameter: [
      tpl('html', `<script src="${workerUrl}/t.js" async></script>`),
      bool('supportDocumentWrite', false)
    ],
    firingTriggerId: [allPagesId]
  });

  // 2) GA4 config apontando o transporte para o Worker.
  await upsert('tags', {
    name: 'GA4 - Config',
    type: 'gaawc',
    parameter: [
      tpl('measurementId', measurementId),
      bool('sendPageView', true),
      bool('enableSendToServerContainer', true),
      tpl('serverContainerUrl', '{{transporturl}}'),
      {
        // Vai em TODO evento do GA4, inclusive os automaticos. Sem isto, so as
        // tags de conversao carregariam a atribuicao.
        type: 'list',
        key: 'fieldsToSet',
        list: [
          { type: 'map', map: [tpl('name', 'tsid'), tpl('value', '{{TSID - Cookie}}')] },
          { type: 'map', map: [tpl('name', 'gclid'), tpl('value', '{{GCLID - URL}}')] },
          { type: 'map', map: [tpl('name', 'gbraid'), tpl('value', '{{GBRAID - URL}}')] },
          { type: 'map', map: [tpl('name', 'wbraid'), tpl('value', '{{WBRAID - URL}}')] },
          { type: 'map', map: [tpl('name', 'fbclid'), tpl('value', '{{FBCLID - URL}}')] },
          { type: 'map', map: [tpl('name', 'fbc'), tpl('value', '{{FBC - Cookie}}')] },
          { type: 'map', map: [tpl('name', 'fbp'), tpl('value', '{{FBP - Cookie}}')] },
          { type: 'map', map: [tpl('name', 'utm_source'), tpl('value', '{{UTM_SOURCE - URL}}')] },
          { type: 'map', map: [tpl('name', 'utm_campaign'), tpl('value', '{{UTM_CAMPAIGN - URL}}')] },
          { type: 'map', map: [tpl('name', 'product_name'), tpl('value', '{{JS - Produto (URL)}}')] }
        ]
      }
    ],
    firingTriggerId: [allPagesId]
  });

  // 3) Tags de evento — todos carregam os IDs de clique e os dados do cliente.
  const attributionParams = [
    { type: 'map', map: [tpl('name', 'gclid'), tpl('value', '{{GCLID - URL}}')] },
    { type: 'map', map: [tpl('name', 'gbraid'), tpl('value', '{{GBRAID - URL}}')] },
    { type: 'map', map: [tpl('name', 'wbraid'), tpl('value', '{{WBRAID - URL}}')] },
    { type: 'map', map: [tpl('name', 'fbclid'), tpl('value', '{{FBCLID - URL}}')] },
    { type: 'map', map: [tpl('name', 'ttclid'), tpl('value', '{{TTCLID - URL}}')] },
    { type: 'map', map: [tpl('name', 'msclkid'), tpl('value', '{{MSCLKID - URL}}')] },
    { type: 'map', map: [tpl('name', 'fbc'), tpl('value', '{{FBC - Cookie}}')] },
    { type: 'map', map: [tpl('name', 'fbp'), tpl('value', '{{FBP - Cookie}}')] },
    { type: 'map', map: [tpl('name', 'tsid'), tpl('value', '{{TSID - Cookie}}')] },
    { type: 'map', map: [tpl('name', 'utm_source'), tpl('value', '{{UTM_SOURCE - URL}}')] },
    { type: 'map', map: [tpl('name', 'utm_medium'), tpl('value', '{{UTM_MEDIUM - URL}}')] },
    { type: 'map', map: [tpl('name', 'utm_campaign'), tpl('value', '{{UTM_CAMPAIGN - URL}}')] },
    { type: 'map', map: [tpl('name', 'utm_term'), tpl('value', '{{UTM_TERM - URL}}')] },
    { type: 'map', map: [tpl('name', 'utm_content'), tpl('value', '{{UTM_CONTENT - URL}}')] }
  ];

  const ecommerceParams = [
    { type: 'map', map: [tpl('name', 'transaction_id'), tpl('value', '{{DL - transaction_id}}')] },
    { type: 'map', map: [tpl('name', 'value'), tpl('value', '{{DL - value}}')] },
    { type: 'map', map: [tpl('name', 'currency'), tpl('value', '{{DL - currency}}')] },
    { type: 'map', map: [tpl('name', 'items'), tpl('value', '{{DL - items}}')] },
    { type: 'map', map: [tpl('name', 'product_id'), tpl('value', '{{DL - product_id}}')] },
    { type: 'map', map: [tpl('name', 'product_name'), tpl('value', '{{DL - product_name}}')] }
  ];

  const customerParams = [
    { type: 'map', map: [tpl('name', 'email'), tpl('value', '{{DL - email}}')] },
    { type: 'map', map: [tpl('name', 'phone'), tpl('value', '{{DL - phone}}')] },
    { type: 'map', map: [tpl('name', 'name'), tpl('value', '{{DL - name}}')] },
    { type: 'map', map: [tpl('name', 'event_id'), tpl('value', '{{DL - event_id}}')] }
  ];

  async function eventTag(eventName, firingTriggerId, extras) {
    await upsert('tags', {
      name: `GA4 - ${eventName}`,
      type: 'gaawe',
      parameter: [
        tpl('measurementIdOverride', measurementId),
        tpl('eventName', eventName),
        { type: 'list', key: 'eventParameters', list: attributionParams.concat(extras || []) }
      ],
      firingTriggerId: [firingTriggerId]
    });
  }

  const ecomAndCustomer = ecommerceParams.concat(customerParams);

  await eventTag('view_item', triggerIds.view_item, ecommerceParams);
  await eventTag('add_to_cart', triggerIds.add_to_cart, ecommerceParams);
  await eventTag('initiate_checkout', triggerIds.initiate_checkout, ecomAndCustomer);
  await eventTag('begin_checkout', triggerIds.begin_checkout, ecomAndCustomer);
  await eventTag('add_payment_info', triggerIds.add_payment_info, ecomAndCustomer);
  await eventTag('generate_lead', triggerIds.generate_lead, customerParams);
  await eventTag('purchase', triggerIds.purchase, ecomAndCustomer);

  /* --------- etapas do funil: order bump / upsell / downsell --------- *
   *
   * Cada etapa e uma transacao separada com o mesmo cliente; o que muda e o
   * produto. Quando o cliente informa os ids/nomes de cada etapa, criamos um
   * acionador que casa `purchase` com o produto por regex e uma tag GA4 com
   * nome de evento proprio — assim a etapa aparece no GA4 e no funil do painel.
   * A classificacao definitiva continua no Worker (pelo webhook); isto e o
   * espelho no lado do navegador.
   */
  const FUNNEL_STEPS = [
    { key: 'order_bump', event: 'purchase_order_bump', raw: funnel.ORDER_BUMP_PRODUCT_IDS },
    { key: 'upsell', event: 'purchase_upsell', raw: funnel.UPSELL_PRODUCT_IDS },
    { key: 'downsell', event: 'purchase_downsell', raw: funnel.DOWNSELL_PRODUCT_IDS }
  ];

  let funnelTagCount = 0;
  for (const step of FUNNEL_STEPS) {
    const regex = funnelListToRegex(step.raw);
    if (!regex) continue;

    const triggerId = await upsert('triggers', {
      name: `CE - ${step.event}`,
      type: 'customEvent',
      customEventFilter: [
        { type: 'equals', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', 'purchase')] }
      ],
      filter: [
        {
          type: 'matchRegex',
          parameter: [
            tpl('arg0', '{{DL - product_id}}'),
            tpl('arg1', regex),
            bool('ignore_case', true)
          ]
        }
      ]
    });

    await upsert('tags', {
      name: `GA4 - ${step.event}`,
      type: 'gaawe',
      parameter: [
        tpl('measurementIdOverride', measurementId),
        tpl('eventName', step.event),
        {
          type: 'list',
          key: 'eventParameters',
          list: attributionParams.concat(ecomAndCustomer, [
            { type: 'map', map: [tpl('name', 'funnel_step'), tpl('value', step.key)] }
          ])
        }
      ],
      firingTriggerId: [triggerId]
    });
    funnelTagCount++;
  }

  if (funnelTagCount) {
    console.log(chalk.gray(`  etapas do funil: ${funnelTagCount} tag(s) de order bump/upsell/downsell`));
  }

  /* --------------------- retencao da VSL ---------------------------- *
   * O snippet mede ate onde a pessoa assistiu e empurra video_progress para o
   * dataLayer com o marco (30s, 300s, "pitch"). Esta tag leva isso ao GA4, que
   * e onde o publico de remarketing e montado e de onde o Google Ads le.
   */
  const videoTriggerId = await upsert('triggers', {
    name: 'CE - video_progress',
    type: 'customEvent',
    customEventFilter: [
      { type: 'equals', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', 'video_progress')] }
    ]
  });

  await upsert('tags', {
    name: 'GA4 - video_progress (VSL)',
    type: 'gaawe',
    parameter: [
      tpl('measurementIdOverride', measurementId),
      tpl('eventName', 'video_progress'),
      {
        type: 'list',
        key: 'eventParameters',
        list: attributionParams.concat([
          { type: 'map', map: [tpl('name', 'video_mark'), tpl('value', '{{DL - video_mark}}')] },
          { type: 'map', map: [tpl('name', 'video_seconds'), tpl('value', '{{DL - video_seconds}}')] },
          { type: 'map', map: [tpl('name', 'product_name'), tpl('value', '{{JS - Produto (URL)}}')] }
        ])
      }
    ],
    firingTriggerId: [videoTriggerId]
  });

  /* ------------------- tempo na pagina (rede de seguranca) ----------- *
   * Mesma ideia do video_progress, para paginas sem player: 30s/1min/3min/
   * 5min/10min de permanencia. Antes ficava so no navegador — nao ia nem
   * para o D1 (bloqueado desde o incidente de espaco) nem para o GA4.
   */
  const tempoTriggerId = await upsert('triggers', {
    name: 'CE - time_on_page',
    type: 'customEvent',
    customEventFilter: [
      { type: 'equals', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', 'time_on_page')] }
    ]
  });

  await upsert('tags', {
    name: 'GA4 - time_on_page',
    type: 'gaawe',
    parameter: [
      tpl('measurementIdOverride', measurementId),
      tpl('eventName', 'time_on_page'),
      {
        type: 'list',
        key: 'eventParameters',
        list: attributionParams.concat([
          { type: 'map', map: [tpl('name', 'engagement_value'), tpl('value', '{{DL - engagement_value}}')] },
          { type: 'map', map: [tpl('name', 'product_name'), tpl('value', '{{JS - Produto (URL)}}')] }
        ])
      }
    ],
    firingTriggerId: [tempoTriggerId]
  });

  console.log(chalk.gray('  retencao da VSL: tag video_progress pronta'));

  // Clique em link de checkout tambem dispara begin_checkout (sites sem dataLayer).
  await upsert('tags', {
    name: 'GA4 - begin_checkout (clique)',
    type: 'gaawe',
    parameter: [
      tpl('measurementIdOverride', measurementId),
      tpl('eventName', 'begin_checkout'),
      { type: 'list', key: 'eventParameters', list: attributionParams }
    ],
    firingTriggerId: [checkoutClickId]
  });

  /* -------------------------- pastas ------------------------- *
   * Agrupa tudo em pastas nomeadas para o container ficar legivel — qualquer
   * pessoa do time abre e entende o que e cada coisa.
   */
  async function organizeFolders() {
    console.log(chalk.blue('→ GTM: organizando em pastas...'));
    const desired = [
      '01 · Config & Transporte',
      '02 · Snippet',
      '03 · Eventos GA4',
      '04 · Variáveis',
      '05 · Acionadores'
    ];

    const existing = await api('listar pastas', () =>
      gtm.accounts.containers.workspaces.folders.list({ parent: workspacePath })
    );
    const folders = existing.data.folder || [];
    const folderPath = {};
    for (const name of desired) {
      let f = folders.find((x) => x.name === name);
      if (!f) {
        const created = await api(`criar pasta ${name}`, () =>
          gtm.accounts.containers.workspaces.folders.create({ parent: workspacePath, requestBody: { name } })
        );
        f = created.data;
      }
      folderPath[name] = f.path;
    }

    const tags = await listAll('tags');
    const triggers = await listAll('triggers');
    const variables = await listAll('variables');

    const bucket = {};
    for (const name of desired) bucket[name] = { tagId: [], triggerId: [], variableId: [] };

    for (const t of tags) {
      if (t.name === 'GA4 - Config') bucket['01 · Config & Transporte'].tagId.push(t.tagId);
      else if (t.name.indexOf('Tracking - Snippet') === 0) bucket['02 · Snippet'].tagId.push(t.tagId);
      else bucket['03 · Eventos GA4'].tagId.push(t.tagId);
    }
    for (const v of variables) {
      if (v.name === 'transporturl') bucket['01 · Config & Transporte'].variableId.push(v.variableId);
      else bucket['04 · Variáveis'].variableId.push(v.variableId);
    }
    for (const tr of triggers) bucket['05 · Acionadores'].triggerId.push(tr.triggerId);

    for (const name of desired) {
      const b = bucket[name];
      if (!b.tagId.length && !b.triggerId.length && !b.variableId.length) continue;
      await api(`mover para ${name}`, () =>
        gtm.accounts.containers.workspaces.folders.move_entities_to_folder({
          path: folderPath[name],
          tagId: b.tagId,
          triggerId: b.triggerId,
          variableId: b.variableId
        })
      );
    }
    console.log(chalk.gray('  tags, variaveis e acionadores agrupados em 5 pastas'));
  }

  try {
    await organizeFolders();
  } catch (err) {
    console.log(chalk.yellow(`  aviso: nao consegui organizar as pastas (${err.message})`));
  }


  console.log(chalk.green(`✓ GTM configurado (${callCount} chamadas de API).`));
  return { gtm, workspacePath, containerPath, container };
}

export async function publishContainer({ gtm, workspacePath, notes }) {
  console.log(chalk.blue('→ GTM: criando versao e publicando...'));

  const version = await api('criar versao', () =>
    gtm.accounts.containers.workspaces.create_version({
      path: workspacePath,
      requestBody: {
        name: `Setup Tracking ${new Date().toISOString().slice(0, 16)}`,
        notes: notes || 'Gerado automaticamente pelo agente de tracking.'
      }
    })
  );

  const containerVersion = version.data.containerVersion;
  if (!containerVersion) {
    // Nada mudou desde a ultima versao.
    console.log(chalk.yellow('  nenhuma alteracao para publicar.'));
    return null;
  }

  await api('publicar', () => gtm.accounts.containers.versions.publish({ path: containerVersion.path }));
  console.log(chalk.green('✓ Container publicado.'));
  return containerVersion.path;
}
