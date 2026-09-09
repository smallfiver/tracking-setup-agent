import chalk from 'chalk';
import crypto from 'crypto';
import { readProfiles, SECRET_FIELDS } from '../lib/profiles.mjs';

/**
 * Gera as variaveis de ambiente para publicar o painel na Vercel.
 *
 * O painel local le os perfis de um arquivo. Na Vercel nao existe disco
 * gravavel, entao a mesma configuracao vai como variavel de ambiente.
 *
 *   node scripts/preparar-vercel.mjs              todos os perfis
 *   node scripts/preparar-vercel.mjs --profile=cliente-a   apenas um
 *   node scripts/preparar-vercel.mjs --sem-senha  nao gera senha nova
 */

const profileId = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1];
const SEM_SENHA = process.argv.includes('--sem-senha');

function main() {
  const store = readProfiles();
  const ids = profileId ? [profileId] : Object.keys(store.profiles);

  if (!ids.length) throw new Error('Nenhum perfil configurado.');
  for (const id of ids) {
    if (!store.profiles[id]) throw new Error(`Perfil nao encontrado: ${id}`);
  }

  // Sobe apenas o necessario para LER os dados. Credenciais de escrita
  // (Google Ads, Meta, service account) ficam de fora — o painel nao publica
  // nada, so consulta o D1.
  const NAO_ENVIAR = [
    'metaAccessToken',
    'googleAdsDeveloperToken',
    'googleAdsClientSecret',
    'googleAdsRefreshToken',
    'ga4ApiSecret'
  ];

  const enxuto = { activeProfile: profileId || store.activeProfile, profiles: {} };
  for (const id of ids) {
    const original = store.profiles[id];
    const copia = {};
    for (const [campo, valor] of Object.entries(original)) {
      if (NAO_ENVIAR.includes(campo)) continue;
      copia[campo] = valor;
    }
    enxuto.profiles[id] = copia;
  }
  if (!enxuto.profiles[enxuto.activeProfile]) {
    enxuto.activeProfile = Object.keys(enxuto.profiles)[0];
  }

  const senha = SEM_SENHA ? null : crypto.randomBytes(12).toString('base64url');

  console.log(chalk.bgBlue.white.bold(' Variaveis para a Vercel '));
  console.log(chalk.gray(`\nPerfis incluidos: ${ids.join(', ')}`));
  console.log(
    chalk.gray('Credenciais de envio de conversao NAO vao no deploy — o painel so le dados.\n')
  );

  console.log(chalk.bold('1) PANEL_PASSWORD'));
  if (senha) {
    console.log(senha);
    console.log(chalk.yellow('   Guarde: e a senha para entrar no painel publicado.\n'));
  } else {
    console.log(chalk.gray('   (mantenha a que ja usa)\n'));
  }

  console.log(chalk.bold('2) TRACKING_PROFILES'));
  console.log(JSON.stringify(enxuto));
  console.log('');

  const ativo = enxuto.profiles[enxuto.activeProfile] || {};
  const faltando = ['cloudflareAccountId', 'cloudflareApiToken', 'd1DatabaseId'].filter(
    (c) => !ativo[c]
  );
  if (faltando.length) {
    console.log(
      chalk.yellow(
        `Aviso: o perfil ativo esta sem ${faltando.join(', ')} — o painel nao vai ler o banco.`
      )
    );
  }

  console.log(chalk.bold('Como usar'));
  console.log(`  1. Na Vercel: Settings > Environment Variables
  2. Crie PANEL_PASSWORD e TRACKING_PROFILES com os valores acima
  3. Redeploy

  Toda vez que voce rodar o setup local e mudar algo do perfil,
  rode este script de novo e atualize TRACKING_PROFILES na Vercel.`);
}

try {
  main();
} catch (err) {
  console.error(chalk.red(err.message));
  process.exit(1);
}
