import chalk from 'chalk';
import path from 'path';
import { google } from 'googleapis';
import { getProfile, getActiveProfile, applyProfileToEnv, SERVICE_ACCOUNT_PATH } from '../lib/profiles.mjs';
import { query } from '../lib/d1.mjs';

/**
 * Auditoria do rastreamento.
 *
 * Percorre o checklist das duas skills (configuracao GTM/GA4 e trackeamento de
 * order bump/upsell) conferindo cada item contra o dado real — nao contra o que
 * deveria estar configurado.
 *
 *   node scripts/auditoria.mjs
 *   node scripts/auditoria.mjs --profile=cliente-b
 */

const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];

const resultados = [];
function ok(item, detalhe) { resultados.push({ nivel: 'ok', item, detalhe }); }
function alerta(item, detalhe) { resultados.push({ nivel: 'alerta', item, detalhe }); }
function falha(item, detalhe) { resultados.push({ nivel: 'falha', item, detalhe }); }

async function main() {
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile) throw new Error('Nenhum perfil configurado.');
  applyProfileToEnv(profile);

  const ctx = {
    accountId: profile.cloudflareAccountId,
    apiToken: profile.cloudflareApiToken,
    databaseId: profile.state?.databaseId
  };
  const q = (sql, args) => query(ctx, sql, args);
  const workerUrl = profile.state?.workerUrl;

  console.log(chalk.bgBlue.white.bold(' Auditoria do rastreamento '));
  console.log(chalk.gray(`  perfil: ${profile.name}\n`));

  /* ---------- 1. Infraestrutura ---------- */
  console.log(chalk.bold('1. Infraestrutura'));

  if (!ctx.databaseId) falha('Banco D1', 'nao provisionado — rode o setup');
  else {
    try {
      const t = (await q('SELECT COUNT(*) n FROM events'))[0];
      ok('Banco D1', `${t.n} eventos armazenados`);
    } catch (err) {
      falha('Banco D1', err.message);
    }
  }

  if (!workerUrl) falha('Worker', 'nunca publicado');
  else {
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(10000) });
      const body = await res.json();
      body?.ok ? ok('Worker', workerUrl) : falha('Worker', body?.error || `HTTP ${res.status}`);
    } catch (err) {
      falha('Worker', err.message);
    }

    try {
      const res = await fetch(`${workerUrl}/t.js?v=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
      const js = await res.text();
      js.includes('tsTrack')
        ? ok('Snippet servido', `${(js.length / 1024).toFixed(1)} KB`)
        : falha('Snippet servido', 'conteudo inesperado');
    } catch (err) {
      falha('Snippet servido', err.message);
    }
  }

  /* ---------- 2. GTM (skill: configuracao-gtm-ga4) ---------- */
  console.log(chalk.bold('\n2. Google Tag Manager'));

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || SERVICE_ACCOUNT_PATH),
      scopes: [
        'https://www.googleapis.com/auth/tagmanager.edit.containers',
        'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
        'https://www.googleapis.com/auth/tagmanager.publish'
      ]
    });
    const gtm = google.tagmanager({ version: 'v2', auth });
    const cs = await gtm.accounts.containers.list({ parent: `accounts/${profile.gtmAccountId}` });
    const container = (cs.data.container || []).find((c) => c.publicId === profile.state?.containerId);

    if (!container) falha('Container', `${profile.state?.containerId} nao encontrado`);
    else {
      const live = await gtm.accounts.containers.versions.live({ parent: container.path });
      const v = live.data;
      const tags = (v.tag || []).map((t) => t.name);
      const vars = (v.variable || []).map((x) => x.name);

      ok('Container publicado', `${profile.state.containerId} — versao ${v.containerVersionId}`);

      // A skill exige os nomes exatos: GCLID, GBRAID, WBRAID.
      const exigidas = ['GCLID - URL', 'GBRAID - URL', 'WBRAID - URL'];
      const faltando = exigidas.filter((n) => !vars.includes(n));
      faltando.length
        ? falha('Variaveis de click ID', `faltando: ${faltando.join(', ')}`)
        : ok('Variaveis de click ID', 'GCLID, GBRAID e WBRAID presentes');

      const cookies = ['FBC - Cookie', 'FBP - Cookie', 'TSID - Cookie'];
      const semCookie = cookies.filter((n) => !vars.includes(n));
      semCookie.length
        ? alerta('Variaveis de cookie', `faltando: ${semCookie.join(', ')}`)
        : ok('Variaveis de cookie', 'FBC, FBP e TSID presentes');

      // A tag de configuracao existe em dois formatos: o antigo (gaawc, com o
      // parametro serverContainerUrl solto) e o atual (googtag, que guarda tudo
      // numa tabela de configuracoes). O GTM migra sozinho de um para o outro.
      const config = (v.tag || []).find((t) => t.type === 'googtag' || t.type === 'gaawc');
      let transporte = config?.parameter?.find((x) => x.key === 'serverContainerUrl')?.value;

      if (!transporte) {
        const tabela = config?.parameter?.find((x) => x.key === 'configSettingsTable');
        for (const item of tabela?.list || []) {
          const m = {};
          (item.map || []).forEach((x) => (m[x.key] = x.value));
          if (m.parameter === 'server_container_url') transporte = m.parameterValue;
        }
      }

      transporte
        ? ok('transport_url', `configurado (${transporte})`)
        : falha('transport_url', 'a tag do GA4 nao esta enviando para o Worker');

      // Confirma no dado: o proxy realmente recebeu hits recentes?
      try {
        const h = (
          await q("SELECT COUNT(*) n FROM events WHERE source='ga4' AND created_at > datetime('now','-1 day')")
        )[0];
        Number(h.n) > 0
          ? ok('Proxy do GA4 ativo', `${h.n} hits nas ultimas 24h`)
          : alerta('Proxy do GA4 ativo', 'nenhum hit em 24h — confira se o GTM esta no site');
      } catch {
        /* sem banco, ja reportado acima */
      }

      tags.some((t) => t.includes('Snippet'))
        ? ok('Tag do snippet', 'carrega o rastreamento first-party')
        : alerta('Tag do snippet', 'nao encontrada');

      ok('Tags publicadas', `${tags.length} tags, ${(v.trigger || []).length} acionadores`);
    }
  } catch (err) {
    falha('GTM', (err?.response?.data?.error?.message || err.message).slice(0, 120));
  }

  /* ---------- 3. GA4 ---------- */
  console.log(chalk.bold('\n3. Google Analytics 4'));

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || SERVICE_ACCOUNT_PATH),
      scopes: ['https://www.googleapis.com/auth/analytics.edit', 'https://www.googleapis.com/auth/analytics.readonly']
    });
    const admin = google.analyticsadmin({ version: 'v1alpha', auth });
    const data = google.analyticsdata({ version: 'v1beta', auth });
    const prop = `properties/${profile.ga4PropertyId}`;

    profile.ga4ApiSecret
      ? ok('Measurement Protocol', 'segredo configurado — servidor consegue enviar')
      : falha('Measurement Protocol', 'sem segredo — venda do webhook nao chega ao GA4');

    const links = (await admin.properties.googleAdsLinks.list({ parent: prop })).data.googleAdsLinks || [];
    links.length
      ? ok('Vinculo com Google Ads', `conta ${links[0].customerId}`)
      : falha('Vinculo com Google Ads', 'sem vinculo — publicos e conversoes nao chegam la');

    const ke = (await admin.properties.keyEvents.list({ parent: prop, pageSize: 50 })).data.keyEvents || [];
    ke.length
      ? ok('Eventos-chave', ke.map((k) => k.eventName).join(', '))
      : falha('Eventos-chave', 'nenhum evento marcado como conversao');

    const dims = (await admin.properties.customDimensions.list({ parent: prop, pageSize: 50 })).data.customDimensions || [];
    dims.find((d) => d.parameterName === 'product_name')
      ? ok('Dimensao product_name', 'registrada — permite filtrar por produto')
      : alerta('Dimensao product_name', 'nao registrada');

    const aud = (await admin.properties.audiences.list({ parent: prop, pageSize: 200 })).data.audiences || [];
    ok('Publicos', `${aud.length} criados`);

    // Eventos que o GA4 realmente recebeu nos ultimos 7 dias.
    const rel = await data.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        limit: 50
      }
    });
    const recebidos = {};
    (rel.data.rows || []).forEach((r) => (recebidos[r.dimensionValues[0].value] = Number(r.metricValues[0].value)));

    for (const ev of ['page_view', 'initiate_checkout', 'purchase']) {
      recebidos[ev]
        ? ok(`GA4 recebe ${ev}`, `${recebidos[ev]} em 7 dias`)
        : falha(`GA4 recebe ${ev}`, 'nenhum evento');
    }
    for (const ev of ['pix_generated', 'abandoned_checkout']) {
      recebidos[ev]
        ? ok(`GA4 recebe ${ev}`, `${recebidos[ev]} em 7 dias`)
        : alerta(`GA4 recebe ${ev}`, 'ainda nenhum — recem habilitado');
    }
  } catch (err) {
    falha('GA4', (err?.response?.data?.error?.message || err.message).slice(0, 120));
  }

  /* ---------- 4. Webhook e captura ---------- */
  console.log(chalk.bold('\n4. Webhook e captura de dados'));

  try {
    const tipos = await q(
      "SELECT event_name, COUNT(*) n FROM purchases WHERE created_at > datetime('now','-7 days') GROUP BY event_name"
    );
    const mapa = Object.fromEntries(tipos.map((t) => [t.event_name, Number(t.n)]));

    mapa.purchase
      ? ok('Webhook: compra aprovada', `${mapa.purchase} em 7 dias`)
      : falha('Webhook: compra aprovada', 'nenhuma');

    // A skill do GTM diz "so compra aprovada", mas os demais eventos sao o que
    // alimenta remarketing — entao a ausencia deles e alerta, nao acerto.
    for (const [ev, label] of [
      ['pix_generated', 'pix gerado'],
      ['abandoned_checkout', 'carrinho abandonado'],
      ['refund', 'reembolso']
    ]) {
      mapa[ev]
        ? ok(`Webhook: ${label}`, `${mapa[ev]} em 7 dias`)
        : alerta(`Webhook: ${label}`, 'nenhum — confira se o evento esta marcado na plataforma');
    }

    const at = (
      await q(
        "SELECT COUNT(*) total, SUM(CASE WHEN gclid IS NOT NULL OR fbc IS NOT NULL OR utm_source IS NOT NULL THEN 1 ELSE 0 END) com FROM purchases WHERE event_name='purchase'"
      )
    )[0];
    const taxa = at.total ? Math.round((at.com / at.total) * 100) : 0;
    taxa >= 80
      ? ok('Atribuicao das vendas', `${taxa}% (${at.com}/${at.total})`)
      : alerta('Atribuicao das vendas', `${taxa}% — abaixo do esperado`);

    const cid = (
      await q("SELECT COUNT(*) total, SUM(CASE WHEN client_id IS NOT NULL THEN 1 ELSE 0 END) com FROM purchases WHERE event_name='purchase'")
    )[0];
    const taxaCid = cid.total ? Math.round((cid.com / cid.total) * 100) : 0;
    taxaCid >= 50
      ? ok('Costura com a navegacao', `${taxaCid}% das vendas tem client_id do GA4`)
      : alerta('Costura com a navegacao', `so ${taxaCid}% tem client_id — o resto nao chega ao GA4`);
  } catch (err) {
    falha('Webhook', err.message);
  }

  /* ---------- 5. Order bump / upsell (skill: trackeamento-order-bump-upsell) ---------- */
  console.log(chalk.bold('\n5. Order bump, upsell e downsell'));

  const listas = ['frontProductIds', 'orderBumpProductIds', 'upsellProductIds', 'downsellProductIds'];
  const preenchidas = listas.filter((l) => profile[l]);
  preenchidas.length
    ? ok('Listas de produto', `${preenchidas.length} de 4 preenchidas`)
    : alerta('Listas de produto', 'nenhuma — tudo e classificado como front');

  try {
    const etapas = await q(
      "SELECT COALESCE(purchase_type,'(nao classificado)') etapa, COUNT(*) n, ROUND(SUM(value),2) v FROM purchases WHERE event_name='purchase' GROUP BY etapa"
    );
    etapas.forEach((e) => ok(`Etapa: ${e.etapa}`, `${e.n} venda(s) — R$ ${e.v}`));

    // A skill exige o e-mail como indexador entre plataformas.
    const idx = (
      await q("SELECT COUNT(*) total, SUM(CASE WHEN customer_email IS NOT NULL THEN 1 ELSE 0 END) com FROM purchases WHERE event_name='purchase'")
    )[0];
    const taxaEmail = idx.total ? Math.round((idx.com / idx.total) * 100) : 0;
    taxaEmail >= 90
      ? ok('Indexador (e-mail)', `${taxaEmail}% das vendas tem e-mail`)
      : alerta('Indexador (e-mail)', `${taxaEmail}% — a skill pede e-mail em todas`);
  } catch (err) {
    falha('Classificacao de funil', err.message);
  }

  /* ---------- 6. Envio de conversoes ---------- */
  console.log(chalk.bold('\n6. Envio de conversoes'));

  profile.metaPixelId && profile.metaAccessToken
    ? ok('Meta CAPI', 'configurado')
    : alerta('Meta CAPI', 'nao configurado — Meta nao recebe suas conversoes');

  profile.googleAdsCustomerId && profile.googleAdsRefreshToken
    ? ok('Google Ads offline', 'configurado')
    : alerta('Google Ads offline', 'nao configurado — depende do developer token');

  try {
    const envios = await q(
      "SELECT destination, status, COUNT(*) n FROM conversions_log WHERE created_at > datetime('now','-7 days') GROUP BY destination, status"
    );
    envios.forEach((e) => {
      const texto = `${e.n} em 7 dias`;
      e.status === 'sent' ? ok(`Envios ${e.destination}`, texto) : alerta(`Envios ${e.destination} (${e.status})`, texto);
    });
  } catch (err) {
    falha('Log de conversoes', err.message);
  }

  /* ---------- Resumo ---------- */
  const cont = { ok: 0, alerta: 0, falha: 0 };
  resultados.forEach((r) => cont[r.nivel]++);

  console.log(chalk.bold('\n' + '─'.repeat(70)));
  resultados.forEach((r) => {
    const marca =
      r.nivel === 'ok' ? chalk.green('  OK   ') : r.nivel === 'alerta' ? chalk.yellow('  ATEN ') : chalk.red('  FALHA');
    console.log(marca + '│ ' + r.item.padEnd(30) + chalk.gray(r.detalhe || ''));
  });

  console.log(chalk.bold('─'.repeat(70)));
  console.log(
    `${chalk.green(cont.ok + ' ok')}   ${chalk.yellow(cont.alerta + ' atencao')}   ${chalk.red(cont.falha + ' falha')}`
  );

  if (cont.falha) console.log(chalk.red('\nHa falhas que impedem o rastreamento de funcionar por completo.'));
  else if (cont.alerta) console.log(chalk.yellow('\nFunciona, mas ha pontos que limitam o resultado.'));
  else console.log(chalk.green('\nTudo funcional.'));
}

main().catch((err) => {
  console.error(chalk.red('\n' + (err.stack || err.message)));
  process.exit(1);
});
