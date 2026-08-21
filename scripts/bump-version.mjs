#!/usr/bin/env node
/**
 * Поднимает версию сразу во всех местах, где она записана.
 *
 * Зачем: версия лежит в четырёх файлах, и правится она руками по одному. Забытый
 * `server.json` уезжает в реестр MCP с чужим номером, забытый CHANGELOG оставляет
 * релиз без записи. Скрипт правит всё разом и в конце перечитывает файлы: пока
 * каждое место не показало новую версию, работа не считается сделанной.
 *
 *   node scripts/bump-version.mjs patch          # 2.2.0 → 2.2.1
 *   node scripts/bump-version.mjs minor          # 2.2.0 → 2.3.0
 *   node scripts/bump-version.mjs major          # 2.2.0 → 3.0.0
 *   node scripts/bump-version.mjs 2.5.0          # явный номер
 *   node scripts/bump-version.mjs minor --dry-run  # показать, ничего не трогая
 *
 * Коммит и тег скрипт не делает: коммит идёт через git-committer, а тег `v*.*.*`
 * запускает публикацию в npm — это отдельное решение, а не побочный эффект бампа.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_KINDS = ['major', 'minor', 'patch'];

// В server.json номер записан дважды: версия самого сервера и версия пакета npm.
// Разойтись они не имеют права, поэтому замена ждёт ровно столько вхождений.
const SERVER_JSON_VERSION_FIELDS = 2;

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const spec = args.find((arg) => !arg.startsWith('--'));

if (!spec) {
  console.error('Не сказано, насколько поднимать: major, minor, patch или точный номер вида 2.5.0.');
  process.exit(1);
}

const paths = {
  packageJson: join(ROOT, 'package.json'),
  packageLock: join(ROOT, 'package-lock.json'),
  serverJson: join(ROOT, 'server.json'),
  changelog: join(ROOT, 'CHANGELOG.md'),
};

const read = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));

// Где именно лежит номер. Тот же список работает и как сверка перед правкой, и как
// проверка после неё — иначе «проверено» означало бы «проверено не всё».
function collectVersions() {
  const lock = readJson(paths.packageLock);
  const server = readJson(paths.serverJson);
  return [
    { where: 'package.json → version', value: readJson(paths.packageJson).version },
    { where: 'package-lock.json → version', value: lock.version },
    { where: 'package-lock.json → packages[""].version', value: lock.packages?.['']?.version },
    { where: 'server.json → version', value: server.version },
    { where: 'server.json → packages[0].version', value: server.packages?.[0]?.version },
  ];
}

function nextVersion(current, requested) {
  if (SEMVER.test(requested)) return requested;
  if (!RELEASE_KINDS.includes(requested)) {
    console.error(`«${requested}» — не major, не minor, не patch и не номер вида 2.5.0.`);
    process.exit(1);
  }
  const [major, minor, patch] = current.match(SEMVER).slice(1).map(Number);
  if (requested === 'major') return `${major + 1}.0.0`;
  if (requested === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Сравнение по числам, а не по строкам: «2.10.0» строкой меньше «2.9.0».
function isHigher(candidate, current) {
  const left = candidate.match(SEMVER).slice(1).map(Number);
  const right = current.match(SEMVER).slice(1).map(Number);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

const current = readJson(paths.packageJson).version;
if (!SEMVER.test(current)) {
  console.error(`В package.json версия «${current}» — не разбирается как major.minor.patch.`);
  process.exit(1);
}

// Разъехавшиеся места означают, что прошлый бамп не доехал докуда-то. Поднимать
// поверх такого нельзя: расхождение уедет в релиз незамеченным.
const before = collectVersions();
const mismatched = before.filter((place) => place.value !== current);
if (mismatched.length > 0) {
  console.error(`Места с версией разошлись — в package.json ${current}, а:`);
  for (const place of mismatched) console.error(`  ${place.where}: ${place.value ?? 'поля нет'}`);
  console.error('Сначала свести их вручную, потом бампать.');
  process.exit(1);
}

const next = nextVersion(current, spec);
if (!isHigher(next, current)) {
  console.error(`${next} не выше текущей ${current} — поднимать некуда.`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const changelog = read(paths.changelog);
const unreleasedHeading = '## [Unreleased]';
if (!changelog.includes(unreleasedHeading)) {
  console.error('В CHANGELOG.md нет раздела «## [Unreleased]» — некуда переносить записи релиза.');
  process.exit(1);
}

// Что накопилось под Unreleased. Пусто — релиз без единой записи, о таком лучше знать
// до тега, а не после.
const unreleasedBody = changelog
  .split(unreleasedHeading)[1]
  .split(/^## /m)[0]
  .trim();

// server.json правится текстом, а не через JSON.stringify: пересборка объекта
// переписала бы форматирование всего файла и утопила правку в шумном диффе. Формат
// полей проверяется до первой записи — иначе отказ застаёт версию поднятой наполовину.
const serverText = read(paths.serverJson);
const versionField = new RegExp(`"version": "${current.replace(/\./g, '\\.')}"`, 'g');
const found = serverText.match(versionField)?.length ?? 0;
if (found !== SERVER_JSON_VERSION_FIELDS) {
  console.error(`В server.json ожидалось ${SERVER_JSON_VERSION_FIELDS} поля версии, нашлось ${found}.`);
  console.error('Ничего не менял — привести server.json к обычному виду и повторить.');
  process.exit(1);
}

console.log(`${current} → ${next}${isDryRun ? '  (сухой прогон, ничего не пишу)' : ''}`);
for (const place of before) console.log(`  ${place.where}`);
console.log(`  CHANGELOG.md → раздел [${next}] - ${today}`);
console.log('');

if (isDryRun) {
  if (unreleasedBody === '') console.log('Под [Unreleased] пусто — записей о релизе нет.');
  process.exit(0);
}

// package.json и package-lock.json правит сам npm — свой разбор lock-файла заводить
// незачем, он знает про оба поля и про формат записи.
execFileSync('npm', ['version', next, '--no-git-tag-version'], { cwd: ROOT, stdio: 'ignore' });

writeFileSync(paths.serverJson, serverText.replace(versionField, `"version": "${next}"`));

// Накопленное под Unreleased становится разделом релиза, а сам Unreleased остаётся
// пустым сверху — следующему спринту есть куда писать.
writeFileSync(
  paths.changelog,
  changelog.replace(unreleasedHeading, `${unreleasedHeading}\n\n## [${next}] - ${today}`)
);

const after = collectVersions();
const missed = after.filter((place) => place.value !== next);
const changelogUpdated = read(paths.changelog).includes(`## [${next}] - ${today}`);
if (missed.length > 0 || !changelogUpdated) {
  console.error('Версия поднялась не везде:');
  for (const place of missed) console.error(`  ${place.where}: ${place.value ?? 'поля нет'}`);
  if (!changelogUpdated) console.error('  CHANGELOG.md: раздела нового релиза нет');
  process.exit(1);
}

console.log(`Готово, везде ${next}.`);
if (unreleasedBody === '') {
  console.log('Внимание: под [Unreleased] не было ни строки — раздел релиза пустой.');
}
console.log('');
console.log('Дальше:');
console.log('  git diff package.json package-lock.json server.json CHANGELOG.md');
console.log('  коммит — через git-committer');
console.log(`  тег ставить отдельно: git tag v${next} && git push origin v${next}  (запускает публикацию)`);
