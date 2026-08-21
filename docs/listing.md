# Карточка для каталогов

Один набор ответов на все формы. Площадки спрашивают одно и то же разными словами и с
разными пределами длины, поэтому описания заготовлены сразу в трёх размерах.

## Постоянное

| Поле | Значение |
|---|---|
| Название | SSH MCP Server |
| Репозиторий | https://github.com/hypnosis/ssh-mcp-server |
| npm | `@hypnosis/ssh-mcp-server` |
| Имя в реестре MCP | `io.github.hypnosis/ssh-mcp-server` |
| Установка | `npx -y @hypnosis/ssh-mcp-server` |
| Лицензия | MIT |
| Знак (светлая тема) | https://raw.githubusercontent.com/hypnosis/ssh-mcp-server/main/assets/icon-512.png |
| Знак (тёмная тема) | https://raw.githubusercontent.com/hypnosis/ssh-mcp-server/main/assets/icon-dark-512.png |

## Описания

**До 100 знаков** — то же, что в `server.json`, его читают клиенты и оценщики каталогов:

> Modern SSH for AI agents — cloud servers to BusyBox routers, with destructive commands blocked.

**До 140 знаков** — для карточек в списках:

> Remote server work for AI agents over SSH: run commands, move files, search logs, audit hosts. Destructive commands blocked before the shell.

**Абзац** — для форм, где место не ограничено:

> An SSH MCP server that uses the OpenSSH client already on your machine — your keys, your
> `~/.ssh/config`, your jump hosts. Run commands, move files with checksum verification, search
> logs and audit machines: a cloud VPS, a bare-metal box, or the BusyBox router in your closet.
> Destructive commands are checked before they reach the shell. 18 tools, structured output,
> works with Claude Code, Codex CLI, Gemini CLI and any MCP client.

## Категория и теги

| Площадка | Категория | Теги |
|---|---|---|
| mcp.so | Command Line / DevOps | `ssh`, `devops`, `server-management`, `remote-execution`, `sysadmin` |
| mcpmarket | по их разбору репозитория | — |
| awesome-mcp-servers | 🖥️ Command Line | значки: 📇 🏠 🍎 🐧 |

Значка 🪟 в списке нет намеренно: режим совместимости с Windows в коде есть, сквозного прогона
на Windows — нет. Появится прогон, появится и значок.

## Строка для awesome-mcp-servers

Раздел **🖥️ Command Line**, порядок алфавитный по владельцу — между `gerard-kanters` и
`lacs-project`:

```markdown
- [hypnosis/ssh-mcp-server](https://github.com/hypnosis/ssh-mcp-server) 📇 🏠 🍎 🐧 - Remote server work over the OpenSSH client already on your machine: run commands, move files with checksum verification, search logs and audit hosts. Destructive commands are blocked before they reach the shell; works from a cloud VPS down to a BusyBox router.
```

Заголовок PR у них помечается `🤖🤖🤖`, если правку готовил агент — так они её пропускают
быстрее.

## Кто как принимает

| Площадка | Приём | Что делать |
|---|---|---|
| Официальный реестр MCP | `mcp-publisher` из workflow | уже там, едет с каждым релизом |
| Glama | индексирует сама | уже там |
| PulseMCP | тянет из реестра; своя форма приостановлена | ждать; письмо в их поддержку ускоряет |
| mcp.so | форма `/submit` | ссылка на репозиторий, описание, теги, категория |
| mcpmarket | форма `/submit` | ссылка на репозиторий и почта, дальше ручное ревью |
| Cursor Directory | только через сайт, вход GitHub или Google | подаёт владелец; просят репозиторий с `.mcp.json` |
| awesome-mcp-servers | PR в `README.md` | строка выше |

Две двери закрыты: галерея VS Code берёт из реестра не всё подряд, а каталог Claude принимает
только удалённые серверы. Заново не пробовать.
