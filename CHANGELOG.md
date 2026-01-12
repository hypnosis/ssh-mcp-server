# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- (Future changes will be listed here)

## [1.2.2] - 2026-01-12

### Fixed
- **Connection Pool metrics** - Fixed negative `activeConnections` value (now calculated dynamically from pool size)
- **Session metrics auto-reset** - Metrics automatically reset when all connections close (session-based metrics, prevents memory leak)

## [1.2.1] - 2026-01-17

### Added - Sprint 5: Profiles Reload & Monitoring 📊

**Profile Reload:**
- **Automatic reload** - SSH profiles reload automatically when `SSH_PROFILES_FILE` changes
- **File watcher** - Monitors profile file for changes (can be disabled with `SSH_MCP_PROFILES_WATCH=false`)
- **Cache with TTL** - Profiles cached for 60 seconds (configurable with `SSH_MCP_PROFILES_CACHE_TTL`)
- **Manual reload** - `ssh_monitor(action="reload")` to force reload profiles
- **Config change detection** - ConnectionPool detects profile config changes and reconnects automatically

**Monitoring Tool (ssh_monitor):**
- **stats** - Get connection pool statistics (cache hit rate, active connections, metrics)
- **reload** - Reload SSH profiles without server restart
- **test** - Test connection to profile with timing metrics
- **list** - List all available profiles with default marked

**Enhanced Logging:**
- **Context logger** - `logger.context('ModuleName')` for scoped logging
- **Performance timer** - `logger.time('label')` for measuring operation duration
- **Configurable logging** - `SSH_MCP_LOG_LEVEL`, `SSH_MCP_LOG_TIMESTAMP`, `SSH_MCP_LOG_COLORS`

**Environment Variables:**
- **SSH_MCP_LOG_LEVEL** - Log level: debug, info, warn, error (default: info)
- **SSH_MCP_LOG_TIMESTAMP** - Show timestamps: true, false (default: true)
- **SSH_MCP_LOG_COLORS** - Enable colors: true, false (default: false)
- **SSH_MCP_POOL_IDLE_TIMEOUT** - Connection idle timeout in ms (default: 30000)
- **SSH_MCP_POOL_KEEPALIVE_INTERVAL** - Keep-alive interval in ms (default: 10000)
- **SSH_MCP_PROFILES_CACHE_TTL** - Profile cache TTL in ms (default: 60000)
- **SSH_MCP_PROFILES_WATCH** - Watch profiles file: true, false (default: true)

### Changed - Developer Experience
- **profile-resolver.ts** - Profiles now cached with TTL and auto-reload support
- **connection-pool.ts** - Detects profile config changes and reconnects automatically
- **logger.ts** - Enhanced with context logger and performance timer
- **index.ts** - Added MonitoringTool registration (8 tools total now)

### Fixed - Usability Issues
- **ARCH-007** - Profiles singleton without reload (now auto-reload with file watcher)
- **No monitoring** - Added ssh_monitor tool for diagnostics and stats
- **No profile reload** - Profiles reload automatically or manually without server restart

### Technical Details
- New file: `src/tools/monitoring-tool.ts` - MonitoringTool with 4 actions
- File watcher using Node.js `fs.watch()` for instant profile reload
- Profile cache with TTL fallback if file watcher fails
- ConnectionPool checks config changes and reconnects if needed
- Context logger and performance timer for better debugging

### Documentation
- Added Environment Variables section to README.md
- Added ssh_monitor examples to README.md
- Updated tool count from 7 to 8 commands
- Documented profile reload behavior

## [1.2.0] - 2026-01-16

### Added - Sprint 4: Timeout & Error Handling 🔧

**Retry Mechanism:**
- **Automatic retry** - Connection failures automatically retry up to 3 times
- **Exponential backoff** - Delays increase progressively (1s, 2s, 4s)
- **Smart retry logic** - Retries only temporary errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND)
- **No retry for auth errors** - Authentication failures fail immediately (no wasted attempts)

**Enhanced Error Messages:**
- **ECONNREFUSED** - "Check if SSH server is running and port is correct"
- **ETIMEDOUT** - "Check firewall rules and network connectivity"
- **ENOTFOUND** - "Check hostname/IP address in profile configuration"
- **Authentication failed** - "Check username, SSH key path, and passphrase"
- **Invalid SSH key** - "Check file exists and has correct permissions (600)"
- **Timeout after retries** - "Check network connectivity and SSH server availability"

**Stability Improvements:**
- **Race condition fix** - Already fixed in v2.0.0 (resolveOnce/rejectOnce in ssh-manager.ts)
- **Auto-reconnect** - Already implemented in v2.0.0 (ConnectionPool)
- **Graceful degradation** - System continues working after temporary failures

### Changed - Error Handling
- **ConnectionPool** - Integrated retry mechanism with exponential backoff
- **createConnection()** - Wrapped in `retryWithTimeout()` for automatic retry
- **connectClient()** - Separated single connection attempt for retry logic
- **Error messages** - Enhanced with specific troubleshooting hints

### Fixed - Reliability Issues
- **Temporary network failures** - Now automatically retry instead of failing immediately
- **Authentication errors** - No longer retry (fail fast with helpful message)
- **Timeout errors** - Clear error messages with context about what failed

### Technical Details
- **retry.ts** - Already existed, now integrated into ConnectionPool
- **createSSHRetryPredicate()** - Fixed to check auth errors first (case-insensitive)
- **retryWithTimeout()** - 3 attempts, 10s timeout per attempt, exponential backoff
- **Error context** - All errors include host, port, username for debugging

### Testing
- **22 new tests** - Comprehensive error handling test suite
- **Timeout tests** - Verify no race conditions on timeout
- **Retry tests** - Verify retry logic for temporary errors
- **Predicate tests** - Verify SSH retry predicate logic
- **Error message tests** - Verify helpful error messages
- **60 total tests** - All passing ✅

### Documentation
- Updated CHANGELOG.md with Sprint 4 changes
- Error handling improvements documented
- Retry mechanism explained

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

[Unreleased]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/hypnosis/ssh-mcp-server/compare/v2.1.0...v1.2.0
[2.1.0]: https://github.com/hypnosis/ssh-mcp-server/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hypnosis/ssh-mcp-server/releases/tag/v1.0.0
