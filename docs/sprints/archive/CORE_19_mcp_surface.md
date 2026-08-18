# CORE_19 — сервер рассказывает агенту, чем пользоваться

**Статус:** ✅ ЗАКРЫТ 2026-08-18 — шаги 1 и 2 сделаны и проверены живьём, релиз вынесен
**Дата заведения:** 2026-08-18
**Ветка:** `main` — 2.0.3 опубликована в npm и в официальном реестре MCP
**Происхождение:** разговор 2026-08-18 — «для ИИ-агентов есть описание тулзы, чтобы он
использовал не 2–3 любимых, а весь перечень?»

---

## Зачем этот спринт

Инструментов восемнадцать, а работает агент через два-три.

1. Сервер не говорит агенту о себе ни слова: клиент получает список имён и всё. Чем эти
   инструменты лучше и что теряется, если пойти в обход, не сказано нигде.
2. Поэтому агент берёт `ssh_exec`: тот умеет всё, и цена выбора не видна.
3. Теряется ровно то, ради чего специальные инструменты написаны — батчинг в один заход,
   разбор вывода, сверка sha256, честная пометка «проверить нечем».

Протокол даёт штатное место, чтобы это исправить: `instructions` уходит клиенту при
подключении и попадает агенту в системный промпт до всякой работы. Мы его не заполняем.

---

## Что уже сделано — не переделывать

| Что | Где |
|---|---|
| Аннотации всех 18 инструментов | коммит `d269568`, `src/tools/annotations.ts` |
| Таблица поведения инструментов | `docs/tools.md`, раздел «What each tool declares about itself» |
| Тест аннотаций, 78 проверок | `tests/unit/tool-annotations.test.ts` |
| Схема ответа для `ssh_audit_baseline` и `ssh_tls_check` | `src/tools/audit-output.ts`, `src/tools/audit-tool.ts:105,129` |
| Живая проверка схемы настоящим клиентом | `tests/live/structured-output.live.test.ts` |
| Запись в официальном реестре | `server.json`, `io.github.hypnosis/ssh-mcp-server` |

---

## Факты, проверенные по SDK и спецификации

| Факт | Где видно |
|---|---|
| Протокол `2025-11-25`, назад до `2024-10-07` | `sdk/dist/esm/types.js:2,4` |
| `instructions` — поле `ServerOptions` | `sdk/dist/esm/server/index.d.ts:13-15` |
| Уходит клиенту в ответе на `initialize`, только если задано | сервер SDK добавляет поле условно |
| Клиент читает его как `getInstructions()` и кладёт агенту в системный промпт | документация SDK, `docs/clients/connect.md` |
| `instructions` у нас не задан ни разу | `src/mcp-server.ts` — объявлены только `tools` |
| Объявленная возможность обязывает отвечать на её запросы | комментарий к `ServerOptions`; на низкоуровневом `Server` хендлеры пишем мы |
| Клиент сверяет ответ с объявленной схемой и на расхождении отдаёт ошибку протокола | `src/tools/audit-output.ts`, шапка файла |
| `icons` поддержаны уже сейчас — у сервера, инструментов и промптов | `sdk/dist/esm/types.d.ts` |
| 1.30.0 — последняя опубликованная версия SDK (2026-07-27) | npm |
| Протокол `2026-07-28` есть только в main-ветке SDK, релиза нет | npm, репозиторий спецификации |

---

## Что берём

### Шаг 1. `instructions` — карта набора в системном промпте агента ✅

Текст говорит не «для логов есть `ssh_log_tail`», а что агент теряет, выбрав `ssh_exec`:
заход на каждый файл вместо одного, отсутствие атомарной записи, молчаливо обрезанный
base64. Тривиальное — что такое `tail` и что показывает `df` — не пишем: на это уходит
внимание, нужное строке про `limited` и строке про двоичные файлы.

Текст согласован с владельцем дословно 2026-08-18:

```
SSH access to remote machines. Every call names a profile; there is no default.

Reach for the specific tool before ssh_exec. Each one below does something exec
cannot: it batches round trips, parses the answer, verifies what it wrote, or
says it could not check — instead of returning a blank you would read as zero.

logs       ssh_log_tail and ssh_log_search take a list of files, and a glob in
           the file name, in one call. The glob is expanded by the server's
           find, not by its shell, so a name with a space or a newline stays a
           name. A result cut short says so. exec + tail/grep gives none of
           that and costs a round trip per file.

files      ssh_file_read takes a list of paths. ssh_file_write takes a list of
           files with mode and sudo per file, writes each one beside its target
           and moves it into place, and with verify:true compares sha256
           afterwards. exec + cat/echo has no such step: a half-written config
           is already live. ssh_file_list filters by pattern and walks down
           recursively.

binaries   ssh_upload and ssh_download. Never move bytes as base64 through
           exec — output limits truncate it silently and the file lands broken.

health     ssh_snapshot for one machine at a glance. ssh_audit_baseline and
           ssh_tls_check return structured fields — read them, do not parse the
           text. What could not be measured says NOT CHECKED: that is neither
           zero nor healthy, and reporting it as either is a lie.

digging    ssh_service_status for one unit, ssh_disk_breakdown when a disk
           fills up. Each collects its evidence in one round trip and classifies
           it; exec + systemctl + du + find is four calls and no verdict.

slow work  ssh_exec with detach:true answers with a job id at once, and
           ssh_job_status, ssh_job_output, ssh_job_kill, ssh_job_list follow it.
           The same command without detach dies on the timeout with the work
           half done and out of reach. Job state lives on the server, so it
           survives a restart of this process. Three outcomes: running,
           finished, lost — lost is neither success nor failure.

is it up   ssh_monitor action:test answers with one of four states. limited
           means logged in, but the shell is the device's own CLI (routers,
           appliances): the connection is fine, file and audit tools are not.
           Use exec with the vendor's commands there, and do not go fixing a
           network that works.

ssh_exec is for what has no tool of its own. It refuses a recursive delete aimed
at a system path and stops the whole batch; append # CONFIRMED-DESTRUCTIVE to
that one command when you mean it.
```

**Проверки:**

- Тест поднимает сервер через `InMemoryTransport` и берёт текст у настоящего клиента
  (`client.getInstructions()`) — вызова функции напрямую недостаточно.
- Тест держит список всех 18 имён и требует, чтобы каждое было названо в тексте. Список
  исключений не заводим: сейчас названы все, и новый инструмент обязан краснеть.
- Приёмка — перезапущенный Claude Code с собранным сервером: текст должен доехать до
  живого клиента, а не только до нашего процесса.

**Текст поправлен по итогам работы на роутере** (согласовано 2026-08-18): карта советует
начинать с `ssh_monitor action:test` на незнакомой машине, при `limited` называет
неприменимые инструменты поимённо вместо «audit tools», лишилась тривиальной строки про
рекурсию в списке файлов, а блок про фоновые задачи ужат до двух нетривиальных фактов.

**Сделано.** `src/tools/instructions.ts` рядом с `annotations.ts`, поле в опциях сервера,
`tests/unit/server-instructions.test.ts` — четыре проверки настоящим клиентом. Собранный
пакет опрошен отдельным stdio-клиентом: 2755 знаков, все 18 инструментов названы.

Мутация показала, что первая версия теста ничего не сторожила: сервер создавался на
верхнем уровне файла, а Stryker считает покрытие потестово — мутант «выкинуть опции вместе
с `instructions`» выжил. После переноса создания в `beforeEach` мутант умер, балл по
`mcp-server.ts` 60 → 94.87%. Заодно закрыт давний выживший: имя сервера можно было
заменить на пустую строку, и ни один тест не краснел — проверка добавлена в
`tests/unit/mcp-contract.test.ts`.

### Шаг 2. Схема ответа для `ssh_disk_breakdown` и `ssh_service_status` ✅

Оба лежат в `audit-tool.ts` рядом с `ssh_audit_baseline` и `ssh_tls_check`, у которых
схема уже есть. Половина семейства отдаёт поля, половина — текст, и агент не знает
заранее, какой инструмент что вернёт. По обоим решение принимается по числу и по
состоянию, а число, вынутое глазами из строки, ошибается молча.

Делаем по образцу соседей: тип и схема рядом в `audit-output.ts`, отсутствие поля значит
«раздел не запрашивали», «проверить нечем» выражается схемой, а не пропуском.

**Проверки:** живой тест через настоящего клиента — он сверяет пришедшее с объявленным и
на расхождении вернёт ошибку протокола; оба контейнера, BusyBox и coreutils.

**Сделано.** Схемы и типы в `src/tools/audit-output.ts`, разбор листинга `du` — в
`src/utils/du-lines.ts` рядом с готовым `df-table.ts` (`df -hT` уже разбирался, заново не
писали). Живые проверки обоих инструментов добавлены в
`tests/live/structured-output.live.test.ts`, юниты — в `tests/unit/audit-tls-service.test.ts`.

Три дефекта, найденные проверками по дороге, все в свежем коде:

- жалоба `du: cannot access` читалась как запись с размером «du:» — тест упал сразу;
- мутант потребовал суффикс у размера, и замер на обоих контейнерах подтвердил его правоту:
  `du -sh` пустого файла печатает `0` без суффикса, такая запись улетала в мусор;
- отсутствующая секция `docker` уезжала пустой строкой, то есть молчание сервера читалось
  как «docker не установлен». Теперь секция попадает в `unavailable`, а `null` осталось
  ответом «его тут нет».

Отдельным тестом закрыт случай, ради которого всё и разделялось: `systemctl show` для
несуществующего юнита печатает `ActiveState=inactive`, и взять это значение — доложить о
простое службы, которой на машине нет.

**Проверка на боевом роутере (office-router — вендорский CLI вместо shell).** Связь —
`⚠️ limited`, чем закрыт вчерашний долг «проверить состояние на настоящем роутере».
Разбор диска ответил честно: все шесть секций в `unavailable`, ни одного ложного нуля.
А `ssh_service_status` соврал — `outcome: checked` на машине, где мерить было нечем: CLI
роутера отвечает не как systemd и не как пропавшая команда, поэтому все секции приходят
пустыми, а сторож их не ловил. Исправлено: молчание всех секций (автозапуск, статус,
свойства) читается как «нечем проверить». Подтверждено на том же роутере — `no_systemd`.

**Четыре места, вскрытые тем же роутером** (правились сверх плана шага 2, по решению
владельца 2026-08-18):

- `ssh_audit_baseline` показывал `services: 0 running, none failed` там, где `systemctl`
  нет вовсе, и пустые `hostname`/`os`/`kernel` вместо пометки;
- `ssh_snapshot` печатал `Established connections: 0`, когда считать было нечем;
- экранные последовательности CLI уезжали в значения (`load: [K[K`) — заведён
  `src/utils/terminal-noise.ts`, чистка стоит там, где ответ читают, и не трогает чтение
  файлов: escape внутри файла — это данные;
- совет при `limited` говорил «инструменты аудита», не называя ни одного.

Всё четыре подтверждено на роутере после сборки: связь `limited` без мусора, у baseline
раздел служб ушёл в `unavailable`, у снимка сеть — `NOT CHECKED`.

Итог прогонов: 2302 юнита, 322 живых на трёх контейнерах, `tsc` чист. Выжившие мутанты в
новом коде разобраны поимённо: два подставляют заглушку туда, где парсер её всё равно не
примет, один снимает `.trim()` там, где `splitSections` уже сделал `trimEnd`.

### Шаг 3. Релиз — вынесен из спринта

Решение владельца 2026-08-18: версия выходит не отсюда. Сначала [CORE_20](../planned/CORE_20_answer_summary.md)
— сводка рядом с выводом, потом CORE_21 — готовые сценарии командами. Всё копится под
`[Unreleased]` и уезжает одним релизом, когда набор перестанет меняться на глазах у
пользователя.

---

## Что сознательно не берём

| Что | Куда |
|---|---|
| Уведомления о прогрессе при передаче | выброшено: «не для серверных» — решение владельца 2026-08-18 |
| Наши логи в клиент | выброшено там же |
| Слэш-команды `ssh/ping`, `ssh/health`, `ssh/debug` | отдельный спринт, [TD-21](../../tech-debt/scenarios-not-slash-commands_21.md) |
| Схема ответа для `ssh_snapshot`, задач, передачи, `ssh_monitor` | [TD-20](../../tech-debt/structured-answers-missing_20.md) |
| Обновление SDK | обновлять нечего: 1.30.0 последняя, протокол `2026-07-28` не выпущен |

Схема нужна не всем восемнадцати: у файлов и журналов ответ — это само содержимое, и
поля поверх него ничего не добавляют. Она оправдана там, где агент решает по числу или по
состоянию.

---

## Как проверять

Правила проекта из `CLAUDE.md` действуют целиком. Коротко о главном:

- Живой тест обязателен там, где заявлена функция: юниты с моками не доказывают, что
  клиент действительно получил текст.
- Каждый новый тест ломается мутацией — не покраснел, значит это не тест.
- `npm run mutate -- HEAD` перед коммитом; смотреть на выживших в свежем коде.
- Имена инструментов и формат профилей не ломаем — пакет в npm.
- Лаборатория: `npm run lab:up`, два контейнера, BusyBox и coreutils.
