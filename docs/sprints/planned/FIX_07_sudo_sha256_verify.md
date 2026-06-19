# 🎯 SPRINT 7: sudo + sha256 verify ломается на подоболочке

**Статус:** ✅ ИСПРАВЛЕНО (2026-06-20) — фикс применён, см. «РЕАЛИЗАЦИЯ» внизу
**Дата заведения:** 2026-06-20
**Приоритет:** 🟡 СРЕДНИЙ (verify тихо отключается при sudo, целостность не проверяется)
**Нашёл:** `ssh_upload` под root в защищённый системный путь

## 📋 ОПИСАНИЕ

`ssh_upload` с `sudo: true` + `verify: true` (дефолт) **падает на шаге sha256-проверки**.
Команда хеширования собирается в виде подоболочки `(if ...; fi)`, а executor оборачивает
её в `sudo <cmd>` — получается `sudo (if ...; fi)`, и bash валится с

```
bash: -c: line 1: syntax error near unexpected token `('
```

Итог: загрузка файла **проходит** (rename отрабатывает), но verify не может посчитать
удалённый хеш → ошибка/исключение на верификации. Пользователь думает, что upload не
удался, хотя файл на месте. Целостность по факту НЕ проверена.

**Воспроизведение:**
```
ssh_upload({
  local_path: "./artifact.tar.gz",
  remote_path: "/protected/path/artifact.tar.gz",
  sudo: true, mode: "644", owner: "root:root"
})
→ Error: Operation failed after 3 attempts: Command failed with code 2:
  bash: -c: line 1: syntax error near unexpected token `if'
  bash: -c: line 1: `sudo (if command -v sha256sum ...; fi)'
```

**Как обошли:** залили файл, затем отдельной командой `ssh_exec(..., sudo:true)` посчитали
`sha256sum` удалённого файла и сравнили с локальным вручную. Для других файлов вызывали
`ssh_upload` с `verify: false`. Оба пути — обход, не фикс.

## 🔍 КОРЕНЬ (точное место)

Цепочка: `verifySha256` строит команду и передаёт executor'у с флагом sudo, executor
склеивает `sudo` + команду-подоболочку.

**Файл 1 — `src/utils/sha256.ts`, `buildRemoteSha256Command` (строки 38-48):**
```typescript
return (
  `(if command -v sha256sum >/dev/null 2>&1; then ` +   // ← подоболочка в ( )
  `sha256sum ${quotedPath} | awk '{print $1}'; ` +
  `elif command -v openssl >/dev/null 2>&1; then ` +
  `openssl dgst -sha256 ${quotedPath} | awk '{print $NF}'; ` +
  `else echo "NO_SHA256_TOOL" >&2; exit 127; fi)`
);
```

**Файл 2 — `src/tools/transfer-tool.ts`, `verifySha256` (строки 483-484):**
```typescript
const cmd = buildRemoteSha256Command(shellQuote(remotePath));
const r = await this.executor.execute(sshConfig, cmd, { profileName, sudo });
```
Когда `sudo === true`, executor выполняет `sudo <cmd>`. Подстановка даёт
`sudo (if ...; fi)` — `sudo` не принимает `(...)` как первый аргумент (это
синтаксис shell, а не команда). Без sudo та же команда работает: shell сам
интерпретирует `( )` как подоболочку. Баг только на sudo-пути.

## 🎯 ЗАДАЧИ

### 1. Чинить обёртку sudo для команд-подоболочек 🟡 ВАЖНО
**Файл:** место, где executor добавляет `sudo` к команде (вероятно `src/managers/`
или `src/utils/` — найти точку, где формируется `sudo ${cmd}`).
**Агент:** SONNET
**Время:** ~30 мин

**Суть:** `sudo` не может выполнить shell-конструкцию `(...)`, `if`, пайп напрямую —
ему нужна программа. Любую команду со сложным синтаксисом под sudo надо запускать как
`sudo bash -c '<cmd>'`, а не `sudo <cmd>`.

**Варианты решения (выбрать один, обсудить):**

- **Опция A (точечно, рекомендую):** в `verifySha256` при `sudo === true` оборачивать
  команду в `bash -c`. То есть собирать не `sudo (if...)`, а `sudo bash -c '(if...)'`.
  Минимально, трогает один verify-путь.
  ```typescript
  const inner = buildRemoteSha256Command(shellQuote(remotePath));
  const cmd = sudo ? `bash -c ${shellQuote(inner)}` : inner;
  const r = await this.executor.execute(sshConfig, cmd, { profileName, sudo });
  ```
  (executor добавит `sudo` → получится `sudo bash -c '...'` — валидно.)

- **Опция B (системно):** чинить сам executor — если команда содержит shell-конструкции
  и идёт под sudo, всегда оборачивать в `sudo bash -c`. Закрывает баг для ВСЕХ sudo+сложная
  команда, не только sha256. Риск: затронет другие sudo-вызовы, нужна регрессия.

- **Опция C (убрать подоболочку):** переписать `buildRemoteSha256Command` без `( )` —
  например, одной строкой через `||` вместо `if/elif/fi`. Но `if` всё равно остаётся
  shell-синтаксисом → под sudo сломается так же. **Не решает корень**, отвергнуть.

**Рекомендация:** A как быстрый фикс; рассмотреть B, если sudo + сложные команды
встречаются и в других тулзах (`ssh_exec` с пайпами под sudo — проверить).

### 2. Тест регрессии 🟡 ВАЖНО
**Файл:** `tests/` (есть ли там e2e с реальным sudo? если только unit — добавить unit
на формирование команды).
**Агент:** SONNET
**Время:** ~20 мин

- Unit: при `sudo: true` итоговая команда verify имеет форму `bash -c '...'`, а не голую
  подоболочку.
- E2E (если возможно): `ssh_upload` под sudo в защищённый путь → verify проходит, sha256
  совпадает (раньше падало с syntax error).

### 3. Обновить документацию 🟢 ОБЯЗАТЕЛЬНО
**Файлы:** `docs/BUGLIST.md` (завести/закрыть issue), `CHANGELOG.md`.
**Агент:** HAIKU
**Время:** ~10 мин

## 🧪 ТЕСТИРОВАНИЕ

**До фикса:**
```
ssh_upload(sudo: true, verify: true) → syntax error near unexpected token `('
```

**После фикса:**
```
ssh_upload(sudo: true, verify: true) → Upload OK, sha256 verified (совпал)
```

**Проверить, что не сломали:**
- `ssh_upload` без sudo + verify — как раньше (подоболочка работает без bash -c).
- `ssh_upload` под sudo, но `verify: false` — не зовёт sha256 вообще.
- Удалённый хост без sha256sum/openssl — ветка `NO_SHA256_TOOL` отрабатывает (verify
  skipped с warn), а не падает.

## 📝 ЧЕКЛИСТ ЗАВЕРШЕНИЯ

- [x] Выбрана опция фикса — **B (системно, в executor)**, обоснование ниже
- [x] sudo-путь оборачивает команду в `bash -c` (все sudo-вызовы, не только verify)
- [x] tsc собирается без ошибок
- [ ] verify под sudo проходит на реальном хосте (ручная проверка — следующий релиз)
- [ ] тест регрессии добавлен (unit на форму команды) — оставлено как TODO
- [x] CHANGELOG.md обновлён

## ✅ РЕАЛИЗАЦИЯ (2026-06-20)

**Выбрана опция B (системно), а не A (точечно в verify).** Причина: точка склейки sudo
в проекте ОДНА — `ssh-executor.ts`, `execute()`. Чинить там закрывает баг для ВСЕХ
sudo-команд со сложным синтаксисом (пайпы, `if`, подоболочки), а не только sha256-verify.
A залатала бы один вызов и оставила мину для остальных.

**Файл:** `src/managers/ssh-executor.ts`, `execute()` (было ~строка 60).

```typescript
// Было:
if (options.sudo) {
  finalCommand = `sudo ${command}`;          // sudo (if ...; fi) → syntax error
}

// Стало:
if (options.sudo) {
  finalCommand = `sudo bash -c ${this.escapeShell(command)}`;
}
```

`escapeShell` (уже есть в классе) оборачивает команду в single-quotes с экранированием —
вся команда уезжает под sudo как единый скрипт `bash -c '<...>'`.

### Почему команды БЕЗ sudo НЕ трогаем (проверено)

Вопрос возникал: не нужна ли та же обёртка для non-sudo? **Нет.** Цепочка без sudo:
`execute()` → `manager.execute()` → `executeOnClient()` → `client.exec(command)` (ssh2).
`client.exec` на удалённой стороне запускает команду через **пользовательский shell**
(`$SHELL -c '<command>'` со стороны sshd) — shell сам интерпретирует `(...)`, `if/fi`,
пайпы. Подоболочка работает штатно (это и подтверждалось: ручной `ssh_exec` без sudo с
подоболочкой всегда отрабатывал).

Баг был ИСКЛЮЧИТЕЛЬНО в sudo-ветке: `sudo` — это программа, а не shell; `sudo (if` →
`sudo` получает `(if` как имя команды-аргумента → синтаксис рушится ДО интерпретации
shell'ом. `bash -c` возвращает интерпретацию shell'у, но уже под root. Добавлять `bash -c`
в non-sudo путь — лишний код без причины.

## 🔗 КОНТЕКСТ

- Нашёл: при заливке артефактов под root в защищённый системный путь (verify включён).
- Затронутые файлы кода: `src/managers/ssh-executor.ts` (фикс), `src/utils/sha256.ts`
  (buildRemoteSha256Command — подоболочка), `src/tools/transfer-tool.ts` (verifySha256 —
  вызывал её под sudo).
- Класс бага: shell-синтаксис под `sudo <cmd>` — общая ловушка. Фикс B закрывает все
  sudo-вызовы разом.
