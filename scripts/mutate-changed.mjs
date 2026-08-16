#!/usr/bin/env node
/**
 * Мутационный прогон по тем файлам, которые изменила ветка.
 *
 * Зачем: полный прогон по всему `src/` идёт часами, поэтому его перестают
 * запускать. Мутировать имеет смысл ровно то, что тронуто сейчас — там и живут
 * свежие тесты, про которые ещё не известно, проверяют они хоть что-нибудь.
 *
 * База сравнения — первым аргументом, по умолчанию `main`:
 *   node scripts/mutate-changed.mjs          # всё, что ветка изменила
 *   node scripts/mutate-changed.mjs HEAD     # только незакоммиченное
 *   node scripts/mutate-changed.mjs HEAD~1   # последний коммит и правки поверх
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const base = process.argv[2] ?? 'main';

try {
  execFileSync('git', ['rev-parse', '--verify', base], { stdio: 'ignore' });
} catch {
  console.error(`Не нахожу базу сравнения «${base}» — такой ветки или коммита нет.`);
  process.exit(1);
}

function listFiles(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Три источника: что ветка закоммитила, что лежит несохранённым и что вообще
// новое. Без последних двух прогон перед коммитом мутирует не то, что написано.
const changedFiles = new Set([
  ...listFiles(['diff', '--name-only', `${base}...HEAD`]),
  ...listFiles(['diff', '--name-only', 'HEAD']),
  ...listFiles(['ls-files', '--others', '--exclude-standard']),
]);

// existsSync отсекает удалённые файлы: git их всё ещё называет, мутировать нечего.
const targets = [...changedFiles].filter(
  (file) => file.startsWith('src/') && file.endsWith('.ts') && existsSync(file)
);

if (targets.length === 0) {
  console.log(`Относительно «${base}» в src/ ничего не изменилось — мутировать нечего.`);
  process.exit(0);
}

console.log(`Мутирую ${targets.length} файл(ов) относительно «${base}»:`);
for (const file of targets) console.log(`  ${file}`);
console.log('');

const run = spawnSync('npx', ['stryker', 'run', '--mutate', targets.join(',')], {
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
