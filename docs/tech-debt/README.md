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
| TD-08 | Отмена доходит до нашей стороны, но не снимает работу на сервере | ✅ закрыт 2026-08-23 | [archive/cancellation-not-wired_08.md](archive/cancellation-not-wired_08.md) |
| TD-09 | Проверка точки монтирования не знает BSD и macOS | 📌 названное ограничение README, стенд macOS в Roadmap | [mountpoint-check-bsd_09.md](mountpoint-check-bsd_09.md) |
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
| TD-20 | Половина ответов разобрана, половина — текст | ✅ закрыт 2026-08-19 | [archive/structured-answers-missing_20.md](archive/structured-answers-missing_20.md) |
| TD-21 | Готовые сценарии живут в голове, а не в сервере | 🔹 отложено, шагом CORE_21 больше не закрывается | [scenarios-not-slash-commands_21.md](scenarios-not-slash-commands_21.md) |
| TD-22 | Про видеокарту сервер не спрашивают | ❌ отказ 2026-08-19 | [deprecated/gpu-not-measured_22.md](deprecated/gpu-not-measured_22.md) |
| TD-23 | Двум инструментам нечем взять права, а остальным не сказано, когда их брать | ✅ закрыт 2026-08-19 | [archive/sudo-missing-and-unruled_23.md](archive/sudo-missing-and-unruled_23.md) |
| TD-24 | Закрытый каталог выпадает из поиска молча | ✅ закрыт 2026-08-19 | [archive/glob-and-window-swallow-permission_24.md](archive/glob-and-window-swallow-permission_24.md) |
| TD-25 | Выжившие мутанты в свежем коде CORE_21 | ✅ закрыт 2026-08-19 | [archive/mutants-alive-in-fresh-code_25.md](archive/mutants-alive-in-fresh-code_25.md) |
| TD-26 | Ответ приходит агенту без содержания там, где объявлена схема | ✅ закрыт 2026-08-21 | [archive/content-lost-when-schema-declared_26.md](archive/content-lost-when-schema-declared_26.md) |
| TD-27 | Фоновую задачу опрашивают вслепую | ✅ закрыт 2026-08-20 | [archive/job-polled-blind_27.md](archive/job-polled-blind_27.md) |
| TD-28 | Профилю по ключу нечем предъявить пароль на `sudo` | ✅ закрыт 2026-08-22 | [archive/sudo-needs-a-password-nobody-has_28.md](archive/sudo-needs-a-password-nobody-has_28.md) |
| TD-29 | Долгую работу под root запустить нечем | ✅ закрыт 2026-08-21 | [archive/detached-work-cannot-be-root_29.md](archive/detached-work-cannot-be-root_29.md) |
| TD-30 | Каталог доставляется только заменой целиком | ✅ закрыт 2026-08-25 | [archive/directory-upload-replaces-whole_30.md](archive/directory-upload-replaces-whole_30.md) |
| TD-31 | Легенда ответа объявлена, но правило её ключей нигде не сказано | ✅ закрыт 2026-08-21 | [archive/legend-keys-not-declared_31.md](archive/legend-keys-not-declared_31.md) |
| TD-32 | Поверхность читают кусками, и связи между кусками не держатся | ✅ закрыт 2026-08-23 | [archive/surface-read-in-pieces_32.md](archive/surface-read-in-pieces_32.md) |
| TD-33 | Слова ответа объяснены только в ответе, а решение принимается до него | ✅ закрыт 2026-08-23 | [archive/answer-words-explained-too-late_33.md](archive/answer-words-explained-too-late_33.md) |
| TD-34 | Записать файл можно, назначить ему владельца — нет | ✅ закрыт 2026-08-23 | [archive/write-cannot-set-an-owner_34.md](archive/write-cannot-set-an-owner_34.md) |
| TD-35 | Список файлов обещан полями, а приезжает текстом | ✅ закрыт 2026-08-23 | [archive/list-answers-without-a-schema_35.md](archive/list-answers-without-a-schema_35.md) |
| TD-36 | Экран не прочитан, и поднять права нечем | ✅ закрыт 2026-08-23 | [archive/firewall-unreadable-and-unfixable_36.md](archive/firewall-unreadable-and-unfixable_36.md) |
| TD-37 | Логи контейнера достаются только через `ssh_exec` | ✅ закрыт 2026-08-24 | [archive/container-logs-need-exec_37.md](archive/container-logs-need-exec_37.md) |
| TD-38 | Расхождение сумм не названо в ответе, хотя исход у него есть | ✅ закрыт 2026-08-24 | [archive/mismatch-missing-from-answer_38.md](archive/mismatch-missing-from-answer_38.md) |

**Жизненный цикл** — как у спринтов: закрыт → `archive/`, отказались → `deprecated/`.

**📌 названное ограничение** — не «руки не дошли», а граница, с которой пакет живёт.
Записано в CHANGELOG и README, чтобы пользователь узнал о ней из документа, а не из
поведения. К версии не привязано: ограничение снимается работой, а не выпуском.
