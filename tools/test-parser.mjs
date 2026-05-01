/**
 * tools/test-parser.mjs
 *
 * Petit harness Node : charge le HTML de leçon réelle, monte un DOM via jsdom,
 * exécute parser.js dedans, puis imprime le JSON de sortie.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PARSER_PATH = path.join(PROJECT_ROOT, 'src/content/parser.js');
const HTML_PATH = process.argv[2] ||
  '/home/kalinux/Téléchargements/view-source_https___www.gymglish.com_gymglish_workbook_show-lesson_182747925_L.html';

const html = readFileSync(HTML_PATH, 'utf8');
const parserSrc = readFileSync(PARSER_PATH, 'utf8');

const dom = new JSDOM(html, {
  url: 'https://www.gymglish.com/gymglish/workbook/show-lesson/182747925/L',
  runScripts: 'outside-only'
});
// Inject parser source into the JSDOM window
dom.window.eval(parserSrc);

const result = dom.window.autoGymglishParser.parse(dom.window.document);

// Pretty print summary first
console.log('=== STATS ===');
console.log(JSON.stringify(result.stats, null, 2));
console.log('\n=== EXERCICES ===');
for (const ex of result.exercises) {
  const blanks =
    (ex.choices && ex.choices.length) ||
    (ex.dropdowns && ex.dropdowns.reduce((n, d) => n + d.options.length, 0)) ||
    (ex.blanks && ex.blanks.length) || 0;
  const inputCount =
    (ex.choices && ex.choices.length) ||
    (ex.dropdowns && ex.dropdowns.length) ||
    (ex.blanks && ex.blanks.length) || 0;
  console.log(`  - ${ex.id} [${ex.type}] inputs=${inputCount} (choix/options=${blanks})`);
}
console.log('\n=== SKIPPED ===');
console.log(JSON.stringify(result.skipped, null, 2));
console.log('\n=== UNSUPPORTED ===');
console.log(JSON.stringify(result.unsupported.map(u => ({ id: u.id, debugSize: (u.debug || '').length })), null, 2));
console.log('\n=== CONTEXT (preview 300) ===');
console.log((result.context || '').slice(0, 300));

console.log('\n=== FULL JSON ===');
console.log(JSON.stringify(result, null, 2));
