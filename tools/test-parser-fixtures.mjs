/**
 * tools/test-parser-fixtures.mjs
 *
 * Smoke test multi-leçons : exécute parser.js sur les 2 fichiers HTML de
 * référence, vérifie les stats globales, la présence/absence de wordBank
 * sur les exos text-conjugation, et la qualité du whitespace dans les
 * statements (présence de \n entre phrases sensibles).
 *
 * Sortie : exit 0 si tout passe, 1 sinon (avec liste des échecs).
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PARSER_PATH = path.join(PROJECT_ROOT, 'src/content/parser.js');
const parserSrc = readFileSync(PARSER_PATH, 'utf8');

const FIXTURES = [
  {
    name: 'lesson1 (Bruno/Dr. Badguy initial)',
    path: '/home/kalinux/Téléchargements/view-source_https___www.gymglish.com_gymglish_workbook_show-lesson_182747925_L.html',
    url: 'https://www.gymglish.com/gymglish/workbook/show-lesson/182747925/L',
    expect: {
      total: 15,
      active: 7,
      // Aucune wordBank attendue : tous les hints text-conjugation sont fournis (placeholder verbe)
      wordBanks: {},
      // Vérification que les statements ont au moins un \n quelque part
      requireMultiline: ['TST151822', 'TST151825', 'TST84124'],
    },
  },
  {
    name: 'lesson2 (avec wordBank)',
    path: '/home/kalinux/Téléchargements/view-source_https___www.gymglish.com_gymglish_workbook_show-lesson_182795774_L.html',
    url: 'https://www.gymglish.com/gymglish/workbook/show-lesson/182795774/L',
    expect: {
      total: 14,
      active: 6,
      wordBanks: {
        TST5244614: ['should', 'would', 'could'],
        TST84154: ['still', 'yet', 'always'],
      },
      requireMultiline: ['TST5244614', 'TST84154'],
      // Vérifie la séparation explicite entre 2 phrases qui étaient collées (au moins un \n)
      requireFragmentsRegex: {
        TST5244614: /not be a smart move\.\n+When she was young/,
        TST84154: /Mealworm film [^\n]+\?\n+/,
      },
    },
  },
];

let failures = [];

function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function runFixture(fix) {
  const html = readFileSync(fix.path, 'utf8');
  const dom = new JSDOM(html, { url: fix.url, runScripts: 'outside-only' });
  dom.window.eval(parserSrc);
  const result = dom.window.autoGymglishParser.parse(dom.window.document);
  const exById = Object.fromEntries(result.exercises.map((e) => [e.id, e]));

  console.log(`\n--- ${fix.name} ---`);
  console.log(`stats: ${JSON.stringify(result.stats)}`);

  check(
    result.stats.total === fix.expect.total,
    `[${fix.name}] stats.total attendu=${fix.expect.total} reçu=${result.stats.total}`,
  );
  check(
    result.stats.active === fix.expect.active,
    `[${fix.name}] stats.active attendu=${fix.expect.active} reçu=${result.stats.active}`,
  );

  // wordBanks attendues
  for (const [tstId, expected] of Object.entries(fix.expect.wordBanks || {})) {
    const ex = exById[tstId];
    check(!!ex, `[${fix.name}] exo ${tstId} introuvable`);
    if (!ex) continue;
    const got = ex.wordBank;
    const ok = Array.isArray(got)
      && got.length === expected.length
      && got.every((w, i) => w === expected[i]);
    check(
      ok,
      `[${fix.name}] ${tstId}.wordBank attendu=${JSON.stringify(expected)} reçu=${JSON.stringify(got)}`,
    );
    if (ok) console.log(`  ok ${tstId}.wordBank = [${got.join(', ')}]`);
  }

  // Aucune wordBank parasite sur la leçon 1
  if (Object.keys(fix.expect.wordBanks || {}).length === 0) {
    for (const ex of result.exercises) {
      check(
        !('wordBank' in ex),
        `[${fix.name}] ${ex.id} ne devrait pas avoir de wordBank (reçu=${JSON.stringify(ex.wordBank)})`,
      );
    }
  }

  // Statements multiline (au moins un \n)
  for (const tstId of fix.expect.requireMultiline || []) {
    const ex = exById[tstId];
    check(!!ex, `[${fix.name}] exo ${tstId} introuvable`);
    if (!ex) continue;
    check(
      typeof ex.statement === 'string' && ex.statement.includes('\n'),
      `[${fix.name}] ${tstId}.statement devrait contenir au moins un \\n. Reçu: ${JSON.stringify(ex.statement && ex.statement.slice(0, 120))}`,
    );
  }

  // Fragments précis attendus (regex pour souplesse \n / \n\n)
  for (const [tstId, regex] of Object.entries(fix.expect.requireFragmentsRegex || {})) {
    const ex = exById[tstId];
    check(!!ex, `[${fix.name}] exo ${tstId} introuvable`);
    if (!ex) continue;
    const ok = regex.test(ex.statement);
    check(
      ok,
      `[${fix.name}] ${tstId}.statement devrait matcher ${regex}. Reçu (extrait): ${JSON.stringify(ex.statement.slice(0, 250))}`,
    );
    if (ok) console.log(`  ok ${tstId} matche ${regex}`);
  }

  // Aperçu des statements text-conjugation
  for (const ex of result.exercises) {
    if (ex.type === 'text-conjugation') {
      console.log(`  ${ex.id} statement preview: ${JSON.stringify(ex.statement.slice(0, 120))}`);
      if (ex.wordBank !== undefined) {
        console.log(`    wordBank=${JSON.stringify(ex.wordBank)}`);
      }
    }
  }
}

for (const fix of FIXTURES) {
  try {
    runFixture(fix);
  } catch (err) {
    failures.push(`[${fix.name}] erreur d'exécution : ${err.message}`);
  }
}

console.log('\n=== RÉSULTAT ===');
if (failures.length === 0) {
  console.log('OK — tous les tests passent.');
  process.exit(0);
} else {
  console.log(`KO — ${failures.length} échec(s) :`);
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
