import { google } from 'googleapis';
import chalk from 'chalk';

/**
 * Google Analytics Admin API.
 *
 * Duas coisas acontecem aqui:
 *   1. cria o segredo do Measurement Protocol, que permite ao Worker mandar a
 *      venda aprovada (que chega por webhook, sem navegador) para o GA4;
 *   2. cria os publicos de remarketing na propriedade.
 *
 * Precisa que a Analytics Admin API esteja ativa no projeto do Google Cloud e
 * que a service account seja Editor na propriedade do GA4.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics.readonly'
];

/**
 * Cliente da Admin API.
 *
 * Usamos a v1alpha porque publicos (properties.audiences) so existem nela —
 * a v1beta cobre propriedades e segredos do Measurement Protocol, mas nao
 * publicos. As duas versoes compartilham o mesmo endpoint para o resto.
 */
export function adminClient(credentialsPath) {
  const auth = new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: SCOPES });
  return google.analyticsadmin({ version: 'v1alpha', auth });
}

/** Erro amigavel a partir de uma falha da API do Analytics. */
function friendlyError(err, context) {
  const status = err?.response?.status || err?.code;
  const message = err?.response?.data?.error?.message || err.message;

  if (status === 403 && /has not been used|is disabled/i.test(message)) {
    return new Error(
      `${context}: a Analytics Admin API nao esta ativa no projeto do Google Cloud.\n` +
        'Ative em: APIs e Servicos > Biblioteca > "Google Analytics Admin API".'
    );
  }
  if (status === 403) {
    return new Error(
      `${context}: a service account nao tem acesso a propriedade do GA4.\n` +
        'No GA4: Administrar > Gerenciamento de acesso a propriedade > adicione o\n' +
        'e-mail do robo com permissao de Editor.'
    );
  }
  return new Error(`${context}: ${message}`);
}

/**
 * Descobre o ID numerico da propriedade a partir do Measurement ID (G-XXXX).
 * O usuario so conhece o G-; a API so trabalha com properties/123456789.
 */
export async function resolveProperty(admin, measurementId) {
  let summaries;
  try {
    const res = await admin.accountSummaries.list({ pageSize: 200 });
    summaries = res.data.accountSummaries || [];
  } catch (err) {
    throw friendlyError(err, 'Falha ao listar propriedades do GA4');
  }

  for (const account of summaries) {
    for (const property of account.propertySummaries || []) {
      try {
        const streams = await admin.properties.dataStreams.list({
          parent: property.property,
          pageSize: 50
        });
        const match = (streams.data.dataStreams || []).find(
          (s) => s.webStreamData?.measurementId === measurementId
        );
        if (match) {
          return {
            property: property.property, // properties/123456789
            displayName: property.displayName,
            dataStream: match.name
          };
        }
      } catch {
        // Propriedade sem acesso — seguimos procurando nas outras.
      }
    }
  }

  throw new Error(
    `Nao encontrei nenhuma propriedade do GA4 com o Measurement ID ${measurementId}.\n` +
      'Confira o ID e se a service account tem acesso a essa propriedade.'
  );
}

/**
 * Descobre a conta (accounts/123) dona da propriedade do Measurement ID dado.
 * Usado para criar propriedades novas de produto na mesma conta do GA4.
 */
export async function resolveAccount(admin, measurementId) {
  const res = await admin.accountSummaries.list({ pageSize: 200 });
  const summaries = res.data.accountSummaries || [];

  for (const account of summaries) {
    for (const property of account.propertySummaries || []) {
      try {
        const streams = await admin.properties.dataStreams.list({
          parent: property.property,
          pageSize: 50
        });
        const match = (streams.data.dataStreams || []).find(
          (s) => s.webStreamData?.measurementId === measurementId
        );
        if (match) return { account: account.account, displayName: account.displayName };
      } catch {
        // Sem acesso a essa propriedade — segue procurando.
      }
    }
  }
  throw new Error(`Nao encontrei a conta do GA4 dona do Measurement ID ${measurementId}.`);
}

/**
 * Cria uma propriedade GA4 nova (um produto = uma propriedade) e o stream web
 * dela, e devolve o Measurement ID pronto para uso.
 *
 * Idempotente pelo nome: se ja existir uma propriedade com esse displayName
 * na conta, reaproveita em vez de duplicar.
 */
async function acknowledgeUserDataCollection(admin, propertyName, displayName) {
  // Toda propriedade exige este aceite antes de liberar o segredo do
  // Measurement Protocol — sem ele a API recusa com "must be attested".
  // Idempotente: reaceitar uma propriedade ja confirmada nao da erro.
  try {
    await admin.properties.acknowledgeUserDataCollection({
      property: propertyName,
      requestBody: {
        acknowledgement:
          'I acknowledge that I have the necessary privacy disclosures and rights from my ' +
          'end users for the collection and processing of their data, including the ' +
          'association of such data with the visitation information Google Analytics ' +
          'collects from my site and/or app property.'
      }
    });
  } catch (err) {
    throw friendlyError(err, `Falha ao confirmar a coleta de dados de "${displayName}"`);
  }
}

export async function ensureProperty(admin, accountResource, displayName, defaultUri) {
  const existing = await admin.accountSummaries.list({ pageSize: 200 });
  for (const account of existing.data.accountSummaries || []) {
    if (account.account !== accountResource) continue;
    const found = (account.propertySummaries || []).find((p) => p.displayName === displayName);
    if (found) {
      console.log(chalk.gray(`  propriedade "${displayName}" ja existe, reaproveitando`));
      await acknowledgeUserDataCollection(admin, found.property, displayName);
      const streams = await admin.properties.dataStreams.list({ parent: found.property, pageSize: 50 });
      const stream = (streams.data.dataStreams || [])[0];
      return {
        property: found.property,
        dataStream: stream?.name,
        measurementId: stream?.webStreamData?.measurementId
      };
    }
  }

  let property;
  try {
    const created = await admin.properties.create({
      requestBody: {
        parent: accountResource,
        displayName,
        timeZone: 'America/Sao_Paulo',
        currencyCode: 'BRL'
      }
    });
    property = created.data;
    console.log(chalk.gray(`  propriedade "${displayName}" criada (${property.name})`));
  } catch (err) {
    throw friendlyError(err, `Falha ao criar a propriedade "${displayName}"`);
  }

  await acknowledgeUserDataCollection(admin, property.name, displayName);

  let stream;
  try {
    const created = await admin.properties.dataStreams.create({
      parent: property.name,
      requestBody: {
        type: 'WEB_DATA_STREAM',
        displayName,
        webStreamData: { defaultUri }
      }
    });
    stream = created.data;
  } catch (err) {
    throw friendlyError(err, `Falha ao criar o stream web de "${displayName}"`);
  }

  return { property: property.name, dataStream: stream.name, measurementId: stream.webStreamData.measurementId };
}

/** Cria (ou reaproveita) o segredo do Measurement Protocol do stream web. */
export async function ensureMeasurementProtocolSecret(admin, dataStream) {
  try {
    const existing = await admin.properties.dataStreams.measurementProtocolSecrets.list({
      parent: dataStream,
      pageSize: 50
    });
    const found = (existing.data.measurementProtocolSecrets || []).find(
      (s) => s.displayName === 'tracking-agent'
    );
    if (found) {
      console.log(chalk.gray('  segredo do Measurement Protocol reaproveitado'));
      return found.secretValue;
    }

    const created = await admin.properties.dataStreams.measurementProtocolSecrets.create({
      parent: dataStream,
      requestBody: { displayName: 'tracking-agent' }
    });
    console.log(chalk.gray('  segredo do Measurement Protocol criado'));
    return created.data.secretValue;
  } catch (err) {
    throw friendlyError(err, 'Falha ao criar o segredo do Measurement Protocol');
  }
}

/**
 * Registra um parametro de evento como dimensao customizada.
 *
 * Sem isso o GA4 recebe o parametro mas nao deixa filtrar por ele — e um
 * publico "Checkout do Produto X" fica impossivel de montar.
 */
export async function ensureCustomDimension(admin, property, parameterName, displayName) {
  try {
    const existing = await admin.properties.customDimensions.list({ parent: property, pageSize: 200 });
    const found = (existing.data.customDimensions || []).find(
      (d) => d.parameterName === parameterName
    );
    if (found) {
      console.log(chalk.gray(`  dimensao "${parameterName}" ja registrada`));
      return found;
    }

    const created = await admin.properties.customDimensions.create({
      parent: property,
      requestBody: {
        parameterName,
        displayName: displayName || parameterName,
        scope: 'EVENT'
      }
    });
    console.log(chalk.gray(`  dimensao "${parameterName}" registrada`));
    return created.data;
  } catch (err) {
    throw friendlyError(err, `Falha ao registrar a dimensao ${parameterName}`);
  }
}

/* ------------------------------------------------------------------ *
 * Publicos
 * ------------------------------------------------------------------ */

/** Condicao simples: o usuario disparou determinado evento. */
function eventCondition(eventName) {
  return {
    andGroup: {
      filterExpressions: [
        {
          orGroup: {
            filterExpressions: [
              {
                dimensionOrMetricFilter: {
                  fieldName: 'eventName',
                  stringFilter: { matchType: 'EXACT', value: eventName }
                }
              }
            ]
          }
        }
      ]
    }
  };
}

function includeClause(eventName) {
  return {
    clauseType: 'INCLUDE',
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: eventCondition(eventName)
    }
  };
}

function excludeClause(eventName) {
  return {
    clauseType: 'EXCLUDE',
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: eventCondition(eventName)
    }
  };
}

/**
 * Publicos criados por padrao.
 *
 * Os tres ultimos sao os que mais rendem em funil de infoproduto: quem chegou
 * ao checkout e nao comprou, quem gerou pix e nao pagou, e a lista de
 * compradores — esta ultima serve principalmente para *excluir* de prospeccao.
 */
export function defaultAudiences() {
  const list = [];

  for (const days of [7, 30, 90]) {
    list.push({
      displayName: `Visitantes - ${days} dias`,
      description: `Quem visitou o site nos ultimos ${days} dias`,
      membershipDurationDays: days,
      filterClauses: [includeClause('page_view')]
    });
    list.push({
      displayName: `Iniciou checkout - ${days} dias`,
      description: `Clicou para comprar nos ultimos ${days} dias`,
      membershipDurationDays: days,
      filterClauses: [includeClause('initiate_checkout')]
    });
  }

  list.push({
    displayName: 'Compradores - 180 dias',
    description: 'Quem comprou. Use para excluir de prospeccao e gerar lookalike',
    membershipDurationDays: 180,
    filterClauses: [includeClause('purchase')]
  });

  list.push({
    displayName: 'Abandonou o checkout - 30 dias',
    description: 'Iniciou o checkout e nao comprou',
    membershipDurationDays: 30,
    // Sem exclusionDurationMode o GA4 aceita o publico mas nao define por
    // quanto tempo a exclusao vale — e os dois publicos com EXCLUDE ficaram
    // zerados em todas as propriedades. EXCLUDE_TEMPORARILY: sai do publico
    // enquanto for comprador, volta se o criterio deixar de valer.
    exclusionDurationMode: 'EXCLUDE_TEMPORARILY',
    filterClauses: [includeClause('initiate_checkout'), excludeClause('purchase')]
  });

  list.push({
    displayName: 'Pix gerado sem pagar - 15 dias',
    description: 'Gerou o pix e nao concluiu. O publico mais quente do funil',
    membershipDurationDays: 15,
    exclusionDurationMode: 'EXCLUDE_TEMPORARILY',
    filterClauses: [includeClause('pix_generated'), excludeClause('purchase')]
  });

  return list;
}

/** Condicao: evento X com o parametro product_name igual a um produto. */
function productCondition(eventName, productName) {
  return {
    andGroup: {
      filterExpressions: [
        {
          orGroup: {
            filterExpressions: [
              {
                dimensionOrMetricFilter: {
                  fieldName: 'eventName',
                  stringFilter: { matchType: 'EXACT', value: eventName }
                }
              }
            ]
          }
        },
        {
          orGroup: {
            filterExpressions: [
              {
                dimensionOrMetricFilter: {
                  fieldName: 'customEvent:product_name',
                  stringFilter: { matchType: 'EXACT', value: productName, caseSensitive: false }
                }
              }
            ]
          }
        }
      ]
    }
  };
}

function productClause(eventName, productName, clauseType = 'INCLUDE') {
  return {
    clauseType,
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: productCondition(eventName, productName)
    }
  };
}

/**
 * Publicos por produto.
 *
 * Para cada produto da lista gera: quem clicou em comprar (7/30/90 dias), quem
 * comprou (30/180), quem clicou e nao comprou, e quem gerou pix e nao pagou.
 * O nome sai no formato "Checkout Curso A 30d".
 */
/** Condicao: evento X com o parametro geo_country igual a um pais. */
function countryClause(eventName, countryCode, clauseType = 'INCLUDE') {
  return {
    clauseType,
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: {
        andGroup: {
          filterExpressions: [
            {
              orGroup: {
                filterExpressions: [
                  {
                    dimensionOrMetricFilter: {
                      fieldName: 'eventName',
                      stringFilter: { matchType: 'EXACT', value: eventName }
                    }
                  }
                ]
              }
            },
            {
              orGroup: {
                filterExpressions: [
                  {
                    dimensionOrMetricFilter: {
                      // Parametro nosso, carimbado pelo Worker. A dimensao
                      // nativa "country" do GA4 nao serve aqui: ela geolocaliza
                      // pelo IP de saida do proxy, e joga metade da America
                      // Latina no balde dos Estados Unidos.
                      fieldName: 'customEvent:geo_country',
                      stringFilter: { matchType: 'EXACT', value: countryCode, caseSensitive: false }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    }
  };
}

/** Condicao: evento X com geo_country dentro de uma lista de paises (OR). */
function latamClause(eventName, countryCodes, clauseType = 'INCLUDE') {
  return {
    clauseType,
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: {
        andGroup: {
          filterExpressions: [
            {
              orGroup: {
                filterExpressions: [
                  { dimensionOrMetricFilter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } } }
                ]
              }
            },
            {
              orGroup: {
                filterExpressions: countryCodes.map((code) => ({
                  dimensionOrMetricFilter: {
                    fieldName: 'customEvent:geo_country',
                    stringFilter: { matchType: 'EXACT', value: code, caseSensitive: false }
                  }
                }))
              }
            }
          ]
        }
      }
    }
  };
}

/**
 * Publico unico "Visitantes LATAM": qualquer pais da lista, exceto Brasil (o
 * mercado principal, ja coberto pelos publicos gerais/por produto). Prefira
 * isto a um publico por pais quando o volume por pais individual for baixo
 * demais para ser acionavel e a cota de 100 publicos da propriedade for
 * escassa — um agregado consome so 3 vagas (7/30/90d) em vez de 3 por pais.
 */
export function latamAudiences(countries = []) {
  const codes = countries
    .map((c) => String(c?.code || '').trim().toUpperCase())
    .filter((c) => c && c !== 'BR');
  if (!codes.length) return [];

  const list = [];
  for (const days of [7, 30, 90]) {
    list.push({
      displayName: `Visitantes LATAM ${days}d`,
      description: `Visitou o site a partir de qualquer pais da LATAM (exceto Brasil) nos ultimos ${days} dias`,
      membershipDurationDays: days,
      filterClauses: [latamClause('page_view', codes)]
    });
  }
  return list;
}

/**
 * Publicos por pais: visitantes e quem clicou em comprar.
 *
 * Recebe uma lista de { code, name } — o codigo e o que o Worker grava
 * (BR, MX, CO...), o nome e so para o rotulo ficar legivel no GA4.
 */
export function countryAudiences(countries = []) {
  const list = [];

  for (const pais of countries) {
    const code = String(pais?.code || '').trim().toUpperCase();
    const nome = String(pais?.name || code).trim();
    if (!code) continue;

    for (const days of [30, 90]) {
      list.push({
        displayName: `Visitantes ${nome} ${days}d`,
        description: `Visitou o site a partir de ${nome} nos ultimos ${days} dias`,
        membershipDurationDays: days,
        filterClauses: [countryClause('page_view', code)]
      });
    }

    list.push({
      displayName: `Checkout ${nome} 30d`,
      description: `Clicou para comprar a partir de ${nome} nos ultimos 30 dias`,
      membershipDurationDays: 30,
      filterClauses: [countryClause('initiate_checkout', code)]
    });
  }

  return list;
}

/** Clausula de "assistiu a VSL ate o marco X" (parametro video_mark). */
function videoClause(mark, clauseType = 'INCLUDE') {
  return {
    clauseType,
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: {
        andGroup: {
          filterExpressions: [
            {
              orGroup: {
                filterExpressions: [
                  {
                    dimensionOrMetricFilter: {
                      fieldName: 'eventName',
                      stringFilter: { matchType: 'EXACT', value: 'video_progress' }
                    }
                  }
                ]
              }
            },
            {
              orGroup: {
                filterExpressions: [
                  {
                    dimensionOrMetricFilter: {
                      // Carimbado pelo snippet a partir da API do player. Ver
                      // hookSmartPlayer em worker/snippet.js.
                      fieldName: 'customEvent:video_mark',
                      stringFilter: { matchType: 'EXACT', value: mark, caseSensitive: false }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    }
  };
}

/** Clausula simples por nome de evento (sem parametro). */
function eventClause(eventName, clauseType = 'INCLUDE') {
  return {
    clauseType,
    simpleFilter: {
      scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS',
      filterExpression: {
        andGroup: {
          filterExpressions: [
            {
              orGroup: {
                filterExpressions: [
                  {
                    dimensionOrMetricFilter: {
                      fieldName: 'eventName',
                      stringFilter: { matchType: 'EXACT', value: eventName }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    }
  };
}

/**
 * Publicos de retencao de VSL.
 *
 * O sinal mais forte de uma VSL nao e ter visitado a pagina — e ate onde a
 * pessoa assistiu. Quem ouviu a oferta inteira e nao comprou tem objecao de
 * preco ou de confianca; quem saiu aos 30 segundos nem entendeu a promessa.
 * Sao dois publicos que pedem anuncios diferentes.
 *
 * Os marcos sao em SEGUNDOS assistidos porque o player nao expoe a duracao do
 * video (ver MARCOS_SEG no snippet). "pitch" e o segundo em que a oferta
 * aparece, informado pelo proprio player.
 */
export function videoAudiences() {
  const MARCOS = [
    { mark: '60s', label: '1 min', days: 30 },
    { mark: '180s', label: '3 min', days: 30 },
    { mark: '300s', label: '5 min', days: 30 },
    { mark: '600s', label: '10 min', days: 30 },
    { mark: '900s', label: '15 min', days: 30 }
  ];

  const list = MARCOS.map(({ mark, label, days }) => ({
    displayName: `VSL ${label} - ${days}d`,
    description: `Assistiu pelo menos ${label} da VSL nos ultimos ${days} dias`,
    membershipDurationDays: days,
    filterClauses: [videoClause(mark)]
  }));

  // O publico mais valioso do conjunto: ouviu a oferta e nao comprou.
  list.push({
    displayName: 'VSL ouviu a oferta - 30d',
    description: 'Assistiu ate o momento em que a oferta aparece (pitch)',
    membershipDurationDays: 30,
    filterClauses: [videoClause('pitch')]
  });
  list.push({
    displayName: 'VSL ouviu a oferta e nao comprou - 30d',
    description:
      'Assistiu ate a oferta e nao comprou. Objecao de preco ou confianca — ' +
      'e o remarketing mais quente que existe',
    membershipDurationDays: 30,
    filterClauses: [videoClause('pitch'), eventClause('purchase', 'EXCLUDE')]
  });
  list.push({
    displayName: 'VSL abandonou cedo - 30d',
    description:
      'Comecou a VSL mas nao chegou a 3 minutos. Nao entendeu a promessa — ' +
      'use criativo diferente, nao mais frequencia do mesmo',
    membershipDurationDays: 30,
    filterClauses: [videoClause('30s'), videoClause('180s', 'EXCLUDE')]
  });

  return list;
}

export function productAudiences(products = []) {
  const list = [];

  for (const product of products) {
    const nome = String(product?.name || '').trim();
    if (!nome) continue;

    // Order bump / upsell sem pagina propria (vendido dentro do checkout de
    // outro produto): nunca vai ter page_view nem initiate_checkout com o seu
    // nome, entao Visitante/Checkout/Abandonou ficariam eternamente vazios —
    // so desperdicam cota (o GA4 padrao limita a 100 publicos por propriedade).
    // Só Compra e Pix fazem sentido, porque vêm do webhook, não da URL.
    const bumpOnly = Boolean(product?.bump);

    if (!bumpOnly) {
      for (const days of [7, 30, 90]) {
        // Visitou a pagina do produto (page_view com product_name resolvido pela
        // URL — {{JS - Produto (URL)}} no GTM). Da a contagem exata de visitantes
        // por oferta, separada do generico "Visitantes - Xd".
        list.push({
          displayName: `Visitante ${nome} ${days}d`,
          description: `Visitou a pagina de ${nome} nos ultimos ${days} dias`,
          membershipDurationDays: days,
          filterClauses: [productClause('page_view', nome)]
        });
        list.push({
          displayName: `Checkout ${nome} ${days}d`,
          description: `Clicou para comprar ${nome} nos ultimos ${days} dias`,
          membershipDurationDays: days,
          filterClauses: [productClause('initiate_checkout', nome)]
        });
      }
    }

    for (const days of [30, 180]) {
      list.push({
        displayName: `Compra ${nome} ${days}d`,
        description: `Comprou ${nome}. Use para excluir de prospeccao e gerar lookalike`,
        membershipDurationDays: days,
        filterClauses: [productClause('purchase', nome)]
      });
    }

    if (!bumpOnly) {
      list.push({
        displayName: `Abandonou ${nome} 30d`,
        description: `Clicou para comprar ${nome} e nao comprou`,
        membershipDurationDays: 30,
        // Ver a nota em defaultAudiences: sem isto o publico com EXCLUDE fica
        // zerado.
        exclusionDurationMode: 'EXCLUDE_TEMPORARILY',
        filterClauses: [
          productClause('initiate_checkout', nome),
          productClause('purchase', nome, 'EXCLUDE')
        ]
      });
    }

    list.push({
      displayName: `Pix sem pagar ${nome} 15d`,
      description: `Gerou pix de ${nome} e nao concluiu`,
      membershipDurationDays: 15,
      exclusionDurationMode: 'EXCLUDE_TEMPORARILY',
      filterClauses: [
        productClause('pix_generated', nome),
        productClause('purchase', nome, 'EXCLUDE')
      ]
    });
  }

  return list;
}

/**
 * Arquiva publicos pelo nome.
 *
 * O GA4 nao permite editar o filtro de um publico depois de criado, e nao
 * existe exclusao — so arquivamento, que e definitivo. Por isso substituir
 * significa arquivar o antigo e criar o novo.
 */
export async function archiveAudiences(admin, property, displayNames = []) {
  if (!displayNames.length) return { archived: 0 };

  const res = await admin.properties.audiences.list({ parent: property, pageSize: 200 });
  const alvo = (res.data.audiences || []).filter((a) => displayNames.includes(a.displayName));

  let archived = 0;
  for (const audience of alvo) {
    try {
      await admin.properties.audiences.archive({ name: audience.name });
      console.log(chalk.gray(`  arquivado: ${audience.displayName}`));
      archived++;
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err.message;
      console.log(chalk.yellow(`  aviso: nao arquivei "${audience.displayName}" — ${detail}`));
    }
  }
  return { archived };
}

/** Cria os publicos que ainda nao existem (compara pelo nome). */
export async function ensureAudiences(admin, property, audiences = defaultAudiences()) {
  console.log(chalk.blue('→ GA4: criando publicos...'));

  let existing = [];
  try {
    const res = await admin.properties.audiences.list({ parent: property, pageSize: 200 });
    existing = res.data.audiences || [];
  } catch (err) {
    throw friendlyError(err, 'Falha ao listar publicos');
  }

  const byName = new Set(existing.map((a) => a.displayName));
  let created = 0;
  let reused = 0;

  for (const audience of audiences) {
    if (byName.has(audience.displayName)) {
      reused++;
      continue;
    }
    // O GA4 limita a descricao do publico; nomes de produto longos estouram.
    // Truncamos com folga para nao perder o publico por causa do texto.
    if (audience.description && audience.description.length > 90) {
      audience.description = audience.description.slice(0, 87) + '...';
    }
    try {
      await admin.properties.audiences.create({ parent: property, requestBody: audience });
      console.log(chalk.gray(`  criado: ${audience.displayName}`));
      created++;
    } catch (err) {
      // Um publico invalido nao pode derrubar o setup inteiro.
      const detail = err?.response?.data?.error?.message || err.message;
      console.log(chalk.yellow(`  aviso: "${audience.displayName}" nao criado — ${detail}`));
    }
  }

  console.log(chalk.green(`✓ Publicos: ${created} criados, ${reused} ja existiam.`));
  return { created, reused };
}
