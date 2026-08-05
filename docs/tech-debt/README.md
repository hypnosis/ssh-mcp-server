# tech-debt/

Крупный и архитектурный долг, не привязанный к одной строке кода. Точечное —
`TODO`/`FIXME` прямо в коде, баги — `docs/BUGLIST.md`.

Долг ≠ баг. Здесь лежит то, что работает, но держится на честном слове:
непокрытый тестами код, отложенные решения, места с известной слабостью.

## Реестр

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| TD-01 | Код, который не заметит поломки: мутационные находки | 🔴 открыт | [test-coverage_01.md](test-coverage_01.md) |
| TD-02 | CI собран на устаревших версиях чужих блоков | ✅ закрыт | [archive/ci-actions_02.md](archive/ci-actions_02.md) |
| TD-03 | Ответ инструмента не отличает провал от результата | 🔴 открыт | [tool-schemas_03.md](tool-schemas_03.md) |
| TD-04 | Косметика вывода аудита | 🟡 открыт | [audit-output_04.md](audit-output_04.md) |
| TD-05 | Комментарии в разборе путей пересказывают решение | 🟡 открыт | [path-guard-comments_05.md](path-guard-comments_05.md) |
| TD-06 | Поиск следов не отличает полный список от обрезанного | 🟡 открыт | [leftover-scan-truncation_06.md](leftover-scan-truncation_06.md) |
| TD-07 | Проигравший в гонке установок получает сырой текст `mv` | 🟡 открыт | [install-race-message_07.md](install-race-message_07.md) |
| TD-08 | Отмена есть в контракте, но не доходит до инструментов | 🟡 открыт | [cancellation-not-wired_08.md](cancellation-not-wired_08.md) |
| TD-09 | Проверка точки монтирования не знает BSD и macOS | 🟡 открыт | [mountpoint-check-bsd_09.md](mountpoint-check-bsd_09.md) |
| TD-10 | Имя профиля течёт через стек, потребителя нет | 🟡 открыт | [profile-name-flows-nowhere_10.md](profile-name-flows-nowhere_10.md) |

**Жизненный цикл** — как у спринтов: закрыт → `archive/`, отказались → `deprecated/`.
