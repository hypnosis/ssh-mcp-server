# tech-debt/

Крупный и архитектурный долг, не привязанный к одной строке кода. Точечное —
`TODO`/`FIXME` прямо в коде, баги — `docs/BUGLIST.md`.

Долг ≠ баг. Здесь лежит то, что работает, но держится на честном слове:
непокрытый тестами код, отложенные решения, места с известной слабостью.

## Реестр

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| TD-01 | Код, который не заметит поломки: мутационные находки | ✅ закрыт | [archive/test-coverage_01.md](archive/test-coverage_01.md) |
| TD-02 | CI собран на устаревших версиях чужих блоков | ✅ закрыт | [archive/ci-actions_02.md](archive/ci-actions_02.md) |
| TD-03 | Ответ инструмента не отличает провал от результата | ✅ закрыт | [archive/tool-schemas_03.md](archive/tool-schemas_03.md) |
| TD-04 | Косметика вывода аудита | ✅ закрыт | [archive/audit-output_04.md](archive/audit-output_04.md) |
| TD-05 | Комментарии в разборе путей пересказывают решение | ✅ закрыт | [archive/path-guard-comments_05.md](archive/path-guard-comments_05.md) |
| TD-06 | Поиск следов не отличает полный список от обрезанного | ✅ закрыт | [archive/leftover-scan-truncation_06.md](archive/leftover-scan-truncation_06.md) |
| TD-07 | Проигравший в гонке установок получает сырой текст `mv` | ✅ закрыт | [archive/install-race-message_07.md](archive/install-race-message_07.md) |
| TD-08 | Отмена доходит до нашей стороны, но не снимает работу на сервере | 📌 условие релиза v2.0.0 | [cancellation-not-wired_08.md](cancellation-not-wired_08.md) |
| TD-09 | Проверка точки монтирования не знает BSD и macOS | 📌 условие релиза v2.0.0 | [mountpoint-check-bsd_09.md](mountpoint-check-bsd_09.md) |
| TD-10 | Имя профиля течёт через стек, потребителя нет | ✅ закрыт | [archive/profile-name-flows-nowhere_10.md](archive/profile-name-flows-nowhere_10.md) |
| TD-11 | Экспорты, которых никто не зовёт | ✅ закрыт | [archive/unused-exports_11.md](archive/unused-exports_11.md) |
| TD-12 | Снимок шлёт десять чтений разом и теряет часть молча | ✅ закрыт | [archive/snapshot-parallel-sessions_12.md](archive/snapshot-parallel-sessions_12.md) |
| TD-13 | Названный срок и объём ответа не соблюдаются | ✅ закрыт | [archive/limits-time-and-volume_13.md](archive/limits-time-and-volume_13.md) |
| TD-14 | Разбор чужого вывода теряет строки и путает колонки | ✅ закрыт | [archive/parsing-foreign-output_14.md](archive/parsing-foreign-output_14.md) |
| TD-15 | В ответах видно внутреннюю кухню | ✅ закрыт | [archive/internal-names-in-answers_15.md](archive/internal-names-in-answers_15.md) |
| TD-16 | Проглоченная ошибка читается как факт | ✅ закрыт | [archive/swallowed-errors_16.md](archive/swallowed-errors_16.md) |
| TD-17 | Шаблон пути в журнальных инструментах обещан, но не работает | ✅ закрыт | [archive/glob-path-not-expanded_17.md](archive/glob-path-not-expanded_17.md) |
| TD-18 | Красный флаг аудита называет порт, которого никто не слушает | ✅ закрыт | [archive/audit-port-mismatch_18.md](archive/audit-port-mismatch_18.md) |
| TD-19 | Предупреждения ловят слово, а не команду | ✅ закрыт | [archive/pattern-warnings-match-substring_19.md](archive/pattern-warnings-match-substring_19.md) |
| TD-20 | Половина ответов разобрана, половина — текст | 🔹 отложено | [structured-answers-missing_20.md](structured-answers-missing_20.md) |
| TD-21 | Готовые сценарии живут в голове, а не в сервере | 🔹 отложено | [scenarios-not-slash-commands_21.md](scenarios-not-slash-commands_21.md) |

**Жизненный цикл** — как у спринтов: закрыт → `archive/`, отказались → `deprecated/`.

**📌 условие релиза** — не «руки не дошли», а названное ограничение, с которым версия
выходит. Записано в CHANGELOG и ROADMAP, чтобы пользователь узнал о нём из документа, а
не из поведения.
