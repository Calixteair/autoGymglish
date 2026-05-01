/**
 * tools/test-base.mjs
 *
 * Tests unitaires pour src/providers/base.js :
 * - buildUserPrompt produit un string non-vide contenant "Exercises:"
 * - parseLLMResponse accepte JSON pur, JSON entouré de ```json, rejette du non-JSON
 * - validateAnswers valide une réponse correcte, rejette ids inconnus, rejette selected vide
 *   pour radio-single, vérifie wordBank, etc.
 *
 * Sortie : exit 0 si tout passe, 1 sinon.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_PATH = path.join(PROJECT_ROOT, 'src/providers/base.js');

// On charge base.js via require puisqu'il expose module.exports.
const require_ = createRequire(import.meta.url);
const base = require_(BASE_PATH);

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}
function checkThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  if (!threw) failures.push(msg);
}

// ----- Payload minimal reproduisant la sortie du parser ------------------
const PAYLOAD = {
  url: 'https://www.gymglish.com/gymglish/workbook/show-lesson/X/L',
  productLang: 'en',
  context: 'Bruno: I want to steal the bananas.\nDr. Badguy: You should help me!',
  exercises: [
    {
      id: 'TST_RADIO',
      type: 'radio-single',
      statement: 'Bruno is...',
      choices: [
        { id: 'QCMC1', text: 'a chimp' },
        { id: 'QCMC2', text: 'a human' },
        { id: 'QCMC3', text: 'a banana' }
      ]
    },
    {
      id: 'TST_CHECK',
      type: 'checkbox-multiple',
      statement: 'Which of these are fruits?',
      choices: [
        { id: 'QCMC10', text: 'banana' },
        { id: 'QCMC11', text: 'rock' },
        { id: 'QCMC12', text: 'apple' }
      ]
    },
    {
      id: 'TST_DROP',
      type: 'dropdown',
      statement: 'I [BLANK_BRAF1] going to [BLANK_BRAF2] today.',
      dropdowns: [
        { id: 'BRAF1', options: [{ id: 'BRAC1', text: 'am' }, { id: 'BRAC2', text: 'is' }] },
        { id: 'BRAF2', options: [{ id: 'BRAC3', text: 'work' }, { id: 'BRAC4', text: 'worked' }] }
      ]
    },
    {
      id: 'TST_TEXT',
      type: 'text-conjugation',
      statement: 'He [BLANK_BRAM1] the bananas yesterday.',
      blanks: [{ id: 'BRAM1', hint: 'to steal' }]
    },
    {
      id: 'TST_BANK',
      type: 'text-conjugation',
      statement: 'You [BLANK_BRAM2] do it. should | would | could',
      blanks: [{ id: 'BRAM2', hint: '' }],
      wordBank: ['should', 'would', 'could']
    }
  ]
};

// ----- Test 1: buildUserPrompt -------------------------------------------
const prompt = base.buildUserPrompt(PAYLOAD);
check(typeof prompt === 'string' && prompt.length > 0, 'buildUserPrompt returns non-empty string');
check(prompt.includes('Exercises:'), 'buildUserPrompt includes "Exercises:"');
check(prompt.includes('Language: en'), 'buildUserPrompt includes language');
check(prompt.includes('TST_RADIO'), 'buildUserPrompt includes exercise ids');

checkThrows(() => base.buildUserPrompt(null), 'buildUserPrompt throws on null');

// ----- Test 2: SYSTEM_PROMPT ---------------------------------------------
check(typeof base.SYSTEM_PROMPT === 'string' && base.SYSTEM_PROMPT.length > 100,
  'SYSTEM_PROMPT is a non-trivial string');

// ----- Test 3: RESPONSE_SCHEMA -------------------------------------------
check(base.RESPONSE_SCHEMA && base.RESPONSE_SCHEMA.type === 'object',
  'RESPONSE_SCHEMA exposed and is an object schema');
check(base.RESPONSE_SCHEMA.required && base.RESPONSE_SCHEMA.required.includes('answers'),
  'RESPONSE_SCHEMA requires "answers"');

// ----- Test 4: parseLLMResponse pure JSON --------------------------------
{
  const obj = base.parseLLMResponse('{"answers":[{"exerciseId":"X","selected":["a"]}]}');
  check(obj && Array.isArray(obj.answers) && obj.answers[0].exerciseId === 'X',
    'parseLLMResponse parses pure JSON');
}

// ----- Test 5: parseLLMResponse with ```json fence ----------------------
{
  const raw = '```json\n{"answers":[{"exerciseId":"Y","selected":["b"]}]}\n```';
  const obj = base.parseLLMResponse(raw);
  check(obj && obj.answers[0].exerciseId === 'Y', 'parseLLMResponse handles ```json fence');
}

// ----- Test 6: parseLLMResponse with ``` fence (no lang) ----------------
{
  const raw = '```\n{"answers":[]}\n```';
  const obj = base.parseLLMResponse(raw);
  check(obj && Array.isArray(obj.answers), 'parseLLMResponse handles plain ``` fence');
}

// ----- Test 7: parseLLMResponse with prose prefix -----------------------
{
  const raw = 'Voici ma réponse:\n{"answers":[{"exerciseId":"Z"}]}\nVoilà.';
  const obj = base.parseLLMResponse(raw);
  check(obj && obj.answers[0].exerciseId === 'Z', 'parseLLMResponse strips prose around JSON');
}

// ----- Test 8: parseLLMResponse rejects non-JSON ------------------------
checkThrows(() => base.parseLLMResponse('not json'), 'parseLLMResponse rejects "not json"');
checkThrows(() => base.parseLLMResponse(''), 'parseLLMResponse rejects empty string');
checkThrows(() => base.parseLLMResponse(null), 'parseLLMResponse rejects null');

// ----- Test 9: validateAnswers — réponse correcte ------------------------
{
  const good = [
    { exerciseId: 'TST_RADIO', selected: ['QCMC1'] },
    { exerciseId: 'TST_CHECK', selected: ['QCMC10', 'QCMC12'] },
    { exerciseId: 'TST_DROP', dropdowns: { BRAF1: 'BRAC1', BRAF2: 'BRAC3' } },
    { exerciseId: 'TST_TEXT', blanks: { BRAM1: 'stole' } },
    { exerciseId: 'TST_BANK', blanks: { BRAM2: 'should' } }
  ];
  const r = base.validateAnswers(good, PAYLOAD);
  check(r.valid === true,
    'validateAnswers accepts a fully-correct response (errors=' + JSON.stringify(r.errors) + ')');
}

// ----- Test 10: validateAnswers rejects unknown exerciseId ---------------
{
  const bad = [{ exerciseId: 'TST_UNKNOWN', selected: ['x'] }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false && r.errors.some((e) => e.includes('TST_UNKNOWN')),
    'validateAnswers rejects unknown exerciseId');
}

// ----- Test 11: validateAnswers rejects empty selected for radio-single -
{
  const bad = [{ exerciseId: 'TST_RADIO', selected: [] }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false && r.errors.length > 0,
    'validateAnswers rejects empty selected for radio-single');
}

// ----- Test 12: validateAnswers rejects 2-element selected for radio-single -
{
  const bad = [{ exerciseId: 'TST_RADIO', selected: ['QCMC1', 'QCMC2'] }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false, 'validateAnswers rejects multi-selected for radio-single');
}

// ----- Test 13: validateAnswers rejects unknown choice id ---------------
{
  const bad = [{ exerciseId: 'TST_RADIO', selected: ['NOT_A_CHOICE'] }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false && r.errors.some((e) => e.includes('not in choices')),
    'validateAnswers rejects unknown choice id for radio-single');
}

// ----- Test 14: validateAnswers rejects empty checkbox-multiple ---------
{
  const bad = [{ exerciseId: 'TST_CHECK', selected: [] }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false, 'validateAnswers rejects empty selected for checkbox-multiple');
}

// ----- Test 15: validateAnswers rejects missing dropdown key ------------
{
  const bad = [{ exerciseId: 'TST_DROP', dropdowns: { BRAF1: 'BRAC1' } }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false && r.errors.some((e) => e.includes('BRAF2')),
    'validateAnswers rejects missing dropdown key');
}

// ----- Test 16: validateAnswers rejects invalid option id ---------------
{
  const bad = [{ exerciseId: 'TST_DROP', dropdowns: { BRAF1: 'BAD', BRAF2: 'BRAC3' } }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false, 'validateAnswers rejects invalid dropdown option id');
}

// ----- Test 17: validateAnswers rejects empty blank value ---------------
{
  const bad = [{ exerciseId: 'TST_TEXT', blanks: { BRAM1: '' } }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false, 'validateAnswers rejects empty string in blanks');
}

// ----- Test 18: validateAnswers enforces wordBank -----------------------
{
  const bad = [{ exerciseId: 'TST_BANK', blanks: { BRAM2: 'might' } }];
  const r = base.validateAnswers(bad, PAYLOAD);
  check(r.valid === false && r.errors.some((e) => e.includes('wordBank')),
    'validateAnswers enforces wordBank constraint');
}

// ----- Test 19: validateAnswers handles non-array gracefully ------------
{
  const r = base.validateAnswers(null, PAYLOAD);
  check(r.valid === false, 'validateAnswers rejects non-array answers');
}

// ----- Sortie ------------------------------------------------------------
console.log('=== test-base.mjs ===');
if (failures.length === 0) {
  console.log(`OK — tous les tests passent (19 cas).`);
  process.exit(0);
} else {
  console.log(`KO — ${failures.length} échec(s) :`);
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
