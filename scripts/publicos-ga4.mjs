import chalk from 'chalk';
import path from 'path';
import {
  adminClient,
  resolveProperty,
  ensureCustomDimension,
  ensureAudiences,
  archiveAudiences,
  defaultAudiences,
  productAudiences,
  latamAudiences,
  videoAudiences
} from '../lib/ga4.mjs';
import {
  getProfile,
  getActiveProfile,
  applyProfileToEnv,
  SERVICE_ACCOUNT_PATH
} from '../lib/profiles.mjs';

/**
 * Cria os publicos do GA4 — e so isso.
 *
 * Separado do setup.mjs porque publico e a parte que voce mexe com frequencia
 * (produto novo, nome novo), enquanto Worker, banco e GTM ficam parados.
 *
 *   node scripts/publicos-ga4.mjs                 mostra o que faria
 *   node scripts/publicos-ga4.mjs --apply         cria os publicos
 *   node scripts/publicos-ga4.mjs --apply --substituir
 *        arquiva os publicos genericos antigos e cria os por produto no lugar
 *
 *   --profile=cliente-a   roda em outro perfil
 *   --so-produtos         cria apenas os por produto (pula os gerais)
 *   --paises              inclui tambem "Visitantes LATAM" (agregado, exceto Brasil)
 *   --so-paises           cria apenas o agregado LATAM
 *   --video               inclui os publicos de retencao da VSL
 *   --so-video            cria apenas os publicos de VSL
 *
 * A lista de produtos vem do campo productList do perfil (ou da variavel
 * PRODUCT_LIST), no formato:
 *
 *   [{"name":"Protocolo de Genesis","match":["69b64441","codificadorangelical"]}]
 *
 * "match" sao trechos que identificam o produto na URL do checkout ou no
 * dominio da pagina — e assim que o clique no botao vira "checkout do produto X".
 */

const APPLY = process.argv.includes('--apply');
const SUBSTITUIR = process.argv.includes('--substituir');
const SO_PRODUTOS = process.argv.includes('--so-produtos');
const SO_PAISES = process.argv.includes('--so-paises');
const SO_VIDEO = process.argv.includes('--so-video');
const COM_VIDEO = process.argv.includes('--video') || SO_VIDEO;
const COM_PAISES = process.argv.includes('--paises') || SO_PAISES;
const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];

/** Publicos genericos que os por produto tornam redundantes. */
const SUBSTITUIVEIS = [
  'Iniciou checkout - 7 dias',
  'Iniciou checkout - 30 dias',
  'Iniciou checkout - 90 dias',
  'Compradores - 180 dias',
  'Abandonou o checkout - 30 dias',
  'Pix gerado sem pagar - 15 dias'
];

/**
 * Paises atendidos, com o codigo que o Worker grava (o mesmo da Cloudflare).
 * Configuravel pelo campo countryList do perfil; sem ele, usa este padrao.
 */
const PAISES_PADRAO = [
  { code: 'BR', name: 'Brasil' },
  { code: 'MX', name: 'México' },
  { code: 'CO', name: 'Colômbia' },
  { code: 'AR', name: 'Argentina' },
  { code: 'CL', name: 'Chile' },
  { code: 'PE', name: 'Peru' },
  { code: 'EC', name: 'Equador' },
  { code: 'DO', name: 'República Dominicana' }
];

function lerPaises(profile) {
  const raw = profile?.countryList || process.env.COUNTRY_LIST;
  if (!raw) return PAISES_PADRAO;
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.filter((p) => p && p.code) : PAISES_PADRAO;
  } catch (err) {
    throw new Error(
      'COUNTRY_LIST nao e um JSON valido.\n' +
        'Formato esperado: [{"code":"BR","name":"Brasil"}]\n' +
        `Erro: ${err.message}`
    );
  }
}

function lerProdutos(profile) {
  const raw = profile?.productList || process.env.PRODUCT_LIST;
  if (!raw) return [];

  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list.filter((p) => p && p.name) : [];
  } catch (err) {
    throw new Error(
      'PRODUCT_LIST nao e um JSON valido.\n' +
        'Formato esperado: [{"name":"Produto","match":["trecho-da-url"]}]\n' +
        `Erro: ${err.message}`
    );
  }
}

async function main() {
  const profile = profileId ? getProfile(profileId) : getActiveProfile();
  if (!profile) throw new Error('Nenhum perfil configurado.');
  applyProfileToEnv(profile);

  const measurementId = profile.ga4MeasurementId || process.env.GA4_MEASUREMENT_ID;
  if (!measurementId) throw new Error('Perfil sem GA4 Measurement ID.');

  const produtos = lerProdutos(profile);

  console.log(chalk.blue(`→ Perfil: ${profile.name}`));
  console.log(chalk.gray(`  produtos na lista: ${produtos.length || '(nenhum)'}`));
  produtos.forEach((p) => console.log(chalk.gray(`    ${p.name}`)));

  if (SO_PRODUTOS && !produtos.length) {
    throw new Error(
      'Nenhum produto configurado. Preencha productList no perfil ou PRODUCT_LIST no .env.'
    );
  }

  const paises = COM_PAISES ? lerPaises(profile) : [];
  if (paises.length) {
    console.log(chalk.gray(`  paises: ${paises.map((p) => p.code).join(', ')}`));
  }

  const restrito = SO_PRODUTOS || SO_PAISES || SO_VIDEO;
  const desejados = [
    ...(restrito ? [] : defaultAudiences()),
    ...(SO_PAISES || SO_VIDEO ? [] : productAudiences(produtos)),
    ...(SO_VIDEO ? [] : latamAudiences(paises)),
    ...(COM_VIDEO || !restrito ? videoAudiences() : [])
  ];

  if (!APPLY) {
    console.log(chalk.yellow(`\nSeriam garantidos ${desejados.length} publicos:`));
    desejados.forEach((a) => console.log(`  ${a.displayName}`));
    if (SUBSTITUIR) {
      console.log(chalk.yellow('\nE seriam arquivados (se existirem):'));
      SUBSTITUIVEIS.forEach((n) => console.log(`  ${n}`));
    }
    console.log(chalk.yellow('\nSimulacao. Rode com --apply para aplicar.'));
    return;
  }

  const credentials = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || SERVICE_ACCOUNT_PATH);
  const admin = adminClient(credentials);
  const property = await resolveProperty(admin, measurementId);
  console.log(chalk.gray(`  ${property.displayName} (${property.property})`));

  // Sem a dimensao registrada, o filtro por produto nao existe no GA4.
  if (produtos.length && !SO_PAISES) {
    await ensureCustomDimension(admin, property.property, 'product_name', 'Produto');
  }
  // Sem esta dimensao o filtro por pais nao existe no GA4. Usamos a nossa em vez
  // da nativa porque o proxy distorce a geolocalizacao por IP.
  if (paises.length) {
    await ensureCustomDimension(admin, property.property, 'geo_country', 'Pais do visitante');
  }
  // Sem video_mark registrado, o GA4 nao consegue filtrar "assistiu ate X" —
  // o parametro chega no evento mas nao vira dimensao usavel em publico.
  if (COM_VIDEO || !restrito) {
    await ensureCustomDimension(admin, property.property, 'video_mark', 'Marco da VSL');
  }

  if (SUBSTITUIR) {
    console.log(chalk.blue('→ GA4: arquivando publicos genericos...'));
    const { archived } = await archiveAudiences(admin, property.property, SUBSTITUIVEIS);
    console.log(chalk.gray(`  ${archived} arquivado(s)`));
  }

  await ensureAudiences(admin, property.property, desejados);

  console.log(
    chalk.gray(
      '\nLembrete: publico do GA4 so comeca a encher a partir de agora — ' +
        'nao retroage sobre o historico.'
    )
  );
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
