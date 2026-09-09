import axios from 'axios';
import chalk from 'chalk';

/**
 * Google Ads API — upload de conversoes offline.
 *
 * Mesmo caminho que o Worker usa em tempo real, mas chamavel do Node. Serve
 * para duas coisas que o Worker nao faz:
 *   1. criar a acao de conversao (assim voce nao precisa criar na mao);
 *   2. reenviar vendas antigas que ficaram no banco antes das credenciais.
 */

const API = 'https://googleads.googleapis.com/v18';

/** Ids do Google Ads sao numericos; a interface mostra com tracos. */
export const soDigitos = (v) => String(v || '').replace(/\D/g, '');

export function credenciaisFaltando(config) {
  const obrigatorias = {
    googleAdsCustomerId: 'Customer ID',
    googleAdsConversionActionId: 'ID da acao de conversao',
    googleAdsDeveloperToken: 'Developer Token',
    googleAdsClientId: 'OAuth Client ID',
    googleAdsClientSecret: 'OAuth Client Secret',
    googleAdsRefreshToken: 'Refresh Token'
  };
  return Object.entries(obrigatorias)
    .filter(([campo]) => !config[campo])
    .map(([, label]) => label);
}

/** Troca o refresh token por um access token (vale ~1h). */
export async function accessToken(config) {
  try {
    const res = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: config.googleAdsClientId,
        client_secret: config.googleAdsClientSecret,
        refresh_token: config.googleAdsRefreshToken,
        grant_type: 'refresh_token'
      })
    );
    return res.data.access_token;
  } catch (err) {
    const detalhe = err.response?.data?.error_description || err.response?.data?.error || err.message;
    throw new Error(
      `OAuth do Google falhou: ${detalhe}\n` +
        'Confira Client ID, Client Secret e Refresh Token — e se o refresh token\n' +
        'foi gerado com o escopo https://www.googleapis.com/auth/adwords.'
    );
  }
}

function headers(config, token) {
  const h = {
    Authorization: `Bearer ${token}`,
    'developer-token': config.googleAdsDeveloperToken,
    'Content-Type': 'application/json'
  };
  if (config.googleAdsLoginCustomerId) {
    h['login-customer-id'] = soDigitos(config.googleAdsLoginCustomerId);
  }
  return h;
}

/** Traduz o erro da API para algo acionavel. */
function erroGoogleAds(err, contexto) {
  const data = err.response?.data;
  const detalhe = data?.error?.message || data?.[0]?.error?.message || err.message;
  const status = err.response?.status;

  if (status === 401) {
    return new Error(`${contexto}: token expirado ou invalido.`);
  }
  if (/developer token/i.test(detalhe)) {
    return new Error(
      `${contexto}: problema com o Developer Token.\n` +
        'Ele precisa estar aprovado com acesso basico no Google Ads API Center.'
    );
  }
  if (/not permitted|permission/i.test(detalhe)) {
    return new Error(
      `${contexto}: a conta OAuth nao tem acesso a este Customer ID.\n` +
        'Se voce acessa via MCC, preencha tambem o Login Customer ID.'
    );
  }
  return new Error(`${contexto}: ${detalhe}`);
}

/**
 * Cria (ou reaproveita) a acao de conversao do tipo "importar de cliques".
 *
 * E este passo que voce faria na mao em Metas > Conversoes > Importar.
 * Devolve o id numerico, que e o que o Worker precisa.
 */
export async function ensureConversionAction(config, nome = 'Compra aprovada (Tracking Agent)') {
  const customerId = soDigitos(config.googleAdsCustomerId);
  const token = await accessToken(config);
  const h = headers(config, token);

  // Ja existe uma com esse nome?
  try {
    const busca = await axios.post(
      `${API}/customers/${customerId}/googleAds:search`,
      {
        query:
          'SELECT conversion_action.id, conversion_action.name, conversion_action.type ' +
          'FROM conversion_action ' +
          `WHERE conversion_action.name = '${nome.replace(/'/g, "\\'")}'`
      },
      { headers: h }
    );
    const achou = (busca.data.results || [])[0];
    if (achou) {
      const id = String(achou.conversionAction.id);
      console.log(chalk.gray(`  acao de conversao existente reaproveitada: ${id}`));
      return id;
    }
  } catch (err) {
    throw erroGoogleAds(err, 'Falha ao consultar acoes de conversao');
  }

  try {
    const res = await axios.post(
      `${API}/customers/${customerId}/conversionActions:mutate`,
      {
        operations: [
          {
            create: {
              name: nome,
              // UPLOAD_CLICKS e o tipo que aceita conversao offline por gclid.
              type: 'UPLOAD_CLICKS',
              category: 'PURCHASE',
              status: 'ENABLED',
              primaryForGoal: true,
              valueSettings: { alwaysUseDefaultValue: false },
              countingType: 'ONE_PER_CLICK'
            }
          }
        ]
      },
      { headers: h }
    );

    const resourceName = res.data.results?.[0]?.resourceName || '';
    const id = resourceName.split('/').pop();
    console.log(chalk.green(`✓ Acao de conversao criada: ${nome} (${id})`));
    return id;
  } catch (err) {
    throw erroGoogleAds(err, 'Falha ao criar a acao de conversao');
  }
}

/** Formato exigido pelo Google Ads: "yyyy-MM-dd HH:mm:ss+HH:mm". */
export function dataGoogleAds(iso) {
  // O D1 grava "2026-07-26 22:13:42" em UTC.
  const texto = String(iso).replace(' ', 'T');
  const d = new Date(texto.endsWith('Z') ? texto : texto + 'Z');
  const s = d.toISOString();
  return s.slice(0, 10) + ' ' + s.slice(11, 19) + '+00:00';
}

/**
 * Sobe um lote de conversoes.
 *
 * partialFailure liga o modo "aceita o que der": uma linha ruim nao derruba o
 * lote inteiro, e os erros voltam individualizados.
 */
export async function uploadConversions(config, conversoes) {
  if (!conversoes.length) return { enviadas: 0, erros: [] };

  const customerId = soDigitos(config.googleAdsCustomerId);
  const actionId = soDigitos(config.googleAdsConversionActionId);
  const token = await accessToken(config);

  const payload = conversoes.map((c) => {
    const item = {
      conversionAction: `customers/${customerId}/conversionActions/${actionId}`,
      conversionDateTime: dataGoogleAds(c.created_at),
      conversionValue: Number(c.value) || 0,
      currencyCode: c.currency || 'BRL'
    };
    if (c.gclid) item.gclid = c.gclid;
    else if (c.gbraid) item.gbraid = c.gbraid;
    else if (c.wbraid) item.wbraid = c.wbraid;
    if (c.transaction_id) item.orderId = c.transaction_id;
    return item;
  });

  try {
    const res = await axios.post(
      `${API}/customers/${customerId}:uploadClickConversions`,
      { conversions: payload, partialFailure: true },
      { headers: headers(config, token) }
    );

    const falhaParcial = res.data.partialFailureError;
    const erros = [];
    if (falhaParcial) {
      erros.push(falhaParcial.message);
      for (const d of falhaParcial.details || []) {
        for (const e of d.errors || []) {
          if (e.message) erros.push(e.message);
        }
      }
    }

    const enviadas = (res.data.results || []).filter(Boolean).length;
    return { enviadas, erros };
  } catch (err) {
    throw erroGoogleAds(err, 'Falha ao enviar conversoes');
  }
}
