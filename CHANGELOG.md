# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-01-15

### Added - Sprint 3: Path Security & Tilde Expansion 🛡️

**Tilde Expansion:**
- **Automatic tilde expansion** - `~/file` automatically expands to `$HOME/file` on remote server
- **Support for ~user paths** - `~username/file` properly handled by shell
- **Works in all file/log tools** - `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`, `ssh_log_search`

**Path Security (Optional):**
- **PathValidator utility** - New optional security layer for path validation
- **Whitelist support** - `allowedPaths` to restrict access to specific directories
- **Blacklist support** - `deniedPaths` to block access to sensitive paths
- **Path traversal protection** - `allowTraversal: false` prevents `../` attacks
- **Path length limits** - `maxPathLength` to prevent extremely long paths
- **Per-profile configuration** - Add `pathSecurity` to any SSH profile

**Security Improvements:**
- **Dual quoting strategy** - Single quotes (default) for safety, double quotes only for `$HOME`
- **Comprehensive escaping** - Prevents variable expansion, command substitution, history expansion
- **Injection protection** - Safe handling of special characters in paths (`;`, `$`, `` ` ``, `!`)

### Fixed - Security Issues
- **ISSUE-001** - Tilde (`~`) not expanding in file paths (now works correctly)
- **ARCH-004** - Incomplete path escaping (now escapes all special characters)
- **ARCH-005** - No path validation (now optional PathValidator available)

### Changed - Path Handling
- **file-tools.ts** - Added `expandRemoteTilde()`, `escapeForSingleQuotes()`, `escapeForDoubleQuotes()`, `buildSafeCommand()`
- **log-tools.ts** - Added `expandRemoteTilde()`, `escapeForSingleQuotes()`, `escapeForDoubleQuotes()`, `buildSafePath()`
- **All file/log operations** - Now use secure quoting strategy with proper escaping

### Technical Details
- New file: `src/utils/path-validator.ts` - PathValidator class with security rules
- New tests: `tests/unit/path-security.test.ts` - Comprehensive tests for tilde expansion and path validation
- Double quotes used ONLY for `$HOME` expansion, everything else escaped
- Single quotes used for regular paths (safest - prevents all expansions)
- PathValidator integrated into all file and log tools

### Documentation
- Added Path Security section to README.md with configuration examples
- Updated BUGLIST.md - closed ISSUE-001, ARCH-004, ARCH-005
- Added Security section to README.md explaining quoting strategy
- Documented tilde expansion in usage examples

## [2.0.0] - 2026-01-13

### Added - Sprint 2: Connection Pool & Performance 🚀
- **Connection Pool (Singleton)** - Переиспользование SSH соединений для всех команд
- **Keep-alive механизм** - Автоматические пинги каждые 10 секунд для поддержания соединения
- **Auto-reconnect** - Автоматическое переподключение при потере соединения
- **Idle cleanup** - Автоматическое закрытие неиспользуемых соединений через 30 секунд
- **Graceful shutdown** - Корректное закрытие всех соединений при остановке сервера
- **Pool metrics** - Статистика использования пула (cache hit/miss, reconnects, total commands)

### Changed - Performance Improvements
- **SSHManager** - Использует ConnectionPool вместо создания нового соединения для каждой команды
- **SSHExecutor** - Делегирует управление соединениями в SSHManager с пулом
- **executeBatch** - Оптимизирован для использования одного соединения для всех команд
- **All Tools** - Передают profileName для идентификации соединения в пуле
- **Race condition fix** - Исправлен race condition в timeout handler (resolveOnce/rejectOnce)

### Performance
- ⚡ **6-10× быстрее** для последовательных команд (16s → 2.5s для 10 команд)
- ⚡ **6-10× быстрее** для batch операций
- ⚡ Cache hit rate >80% при повторных командах
- ⚡ Одно соединение на профиль вместо N соединений для N команд

### Technical Details
- Новый файл: `src/managers/connection-pool.ts` - Singleton для управления пулом соединений
- Map<profileName, PooledConnection> для хранения активных соединений
- Автоматическая очистка idle соединений каждые 10 секунд
- Thread-safe доступ к пулу через async locks
- Логирование всех операций пула (cache hit/miss, reconnects, cleanup)

## [1.0.1] - 2026-01-12

### Added
- Input validation for array parameters in all tools (ssh_exec, ssh_file_read, ssh_log_tail, ssh_log_search)
- Centralized array validator utility (`array-validator.ts`) for reusable validation logic
- Clear error messages when using single quotes instead of double quotes in arrays
- Improved description in `ssh_exec` tool schema with examples of correct syntax
- Documentation about array syntax requirements in README.md
- Array validator documentation (docs/ARRAY_VALIDATOR.md)

### Fixed
- Fixed issue where array commands with single quotes (`['cmd1', 'cmd2']`) caused parsing errors
- Added validation to prevent execution of malformed command arrays

### Changed
- Refactored array validation to centralized utility (DRY principle)
- Applied validation to all tools with array parameters for consistency

### Documentation
- Added array syntax guidelines to README.md usage examples
- Updated DEBUG_BATCH_EXEC.md with problem solution and explanation
- Added ARRAY_VALIDATOR.md with validator API documentation
- Improved tool descriptions for AI assistants with explicit examples

## [1.0.0] - 2026-01-XX

### Added
- Initial release
- 7 core SSH tools (exec, file operations, logs, snapshot)
- SSH profile support from JSON file
- Retry logic for network errors
- Security warnings for dangerous commands
- sudo support for all commands

[Unreleased]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hypnosis/ssh-mcp-server/releases/tag/v1.0.0
