import chalk from 'chalk';
import path from 'path';
import { google } from 'googleapis';
import { adminClient } from '../lib/ga4.mjs';
import { getActiveProfile, applyProfileToEnv, SERVICE_ACCOUNT_PATH } from '../lib/profiles.mjs';

/**
 * Piloto: recria os dois publicos com clausula de EXCLUDE que ficaram zerados
 * em todas as propriedades, agora com exclusionDurationMode definido.
 *
 * Roda em UMA propriedade so, de proposito — se a hipotese estiver errada,
 * o estrago fica contido. Publico do GA4 nao pode ser editado depois de
 * criado: a unica forma de corrigir e arquivar e criar de novo.
 *
 *   node scripts/piloto-publicos-exclusao.mjs                 mostra o plano
 *   node scripts/piloto-publicos-exclusao.mjs --apply         aplica
 */

const APPLY = process.argv.includes('--apply');
const PROPRIEDADE = 'properties/547518559'; // Protocolo de Genesis
const SUFIXO = ' v2';

function eventCondition(eventName) {
  return { andGroup: { filterExpressions: [
    { orGroup: { filterExpressions: [
      { dimensionOrMetricFilter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } } }
    ] } }
  ] } };
}
const clause = (evento, tipo) => ({
  clauseType: tipo,
  simpleFilter: { scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS', filterExpression: eventCondition(evento) }
});

const ALVOS = [
  { antigo: 'Abandonou o checkout - 30 dias', dias: 30, inclui: 'initiate_checkout' },
  { antigo: 'Pix gerado sem pagar - 15 dias', dias: 15, inclui: 'pix_generated' }
];

const profile = getActiveProfile();
applyProfileToEnv(profile);
const credentials = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || SERVICE_ACCOUNT_PATH);
const admin = adminClient(credentials);

const res = await admin.properties.audiences.list({ parent: PROPRIEDADE, pageSize: 100 });
const existentes = res.data.audiences || [];

console.log(chalk.blue(`→ Propriedade piloto: ${PROPRIEDADE} (Protocolo de Gênesis)`));

for (const alvo of ALVOS) {
  const atual = existentes.find((a) => a.displayName === alvo.antigo);
  const novoNome = alvo.antigo + SUFIXO;
  if (existentes.some((a) => a.displayName === novoNome)) {
    console.log(chalk.gray(`  "${novoNome}" ja existe — pulando`));
    continue;
  }
  console.log(`  ${alvo.antigo}`);
  console.log(chalk.gray(`    arquivar: ${atual ? atual.name : '(nao encontrado)'}`));
  console.log(chalk.gray(`    criar   : "${novoNome}" com exclusionDurationMode=EXCLUDE_TEMPORARILY`));

  if (!APPLY) continue;

  if (atual) {
    await admin.properties.audiences.archive({ name: atual.name });
    console.log(chalk.gray('    ✓ antigo arquivado'));
  }
  const criado = await admin.properties.audiences.create({
    parent: PROPRIEDADE,
    requestBody: {
      displayName: novoNome,
      description: 'Piloto: mesma regra, com exclusionDurationMode definido',
      membershipDurationDays: alvo.dias,
      adsPersonalizationEnabled: true,
      exclusionDurationMode: 'EXCLUDE_TEMPORARILY',
      filterClauses: [clause(alvo.inclui, 'INCLUDE'), clause('purchase', 'EXCLUDE')]
    }
  });
  console.log(chalk.green(`    ✓ criado: ${criado.data.name}`));
}

if (!APPLY) console.log(chalk.yellow('\nSimulacao. Rode com --apply para aplicar.'));
else console.log(chalk.green('\n✓ Piloto aplicado. GA4 leva 24-48h para popular — confira depois.'));
