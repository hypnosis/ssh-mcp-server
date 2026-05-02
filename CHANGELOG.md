# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-05-03

### Added — Transfer & Audit Sprint

**SFTP Transfer Tools (Sprint 6) 📦**
- `ssh_upload` — binary-safe file/directory upload through SFTP with sha256 verify and atomic rename
- `ssh_download` — binary-safe download with sha256 verify
- Native ssh2 SFTP channel piggy-backed on the existing connection pool — no extra deps
- Concurrent fastPut chunks (default concurrency=4)
- Atomic semantics: temp file next to target + mv (avoids EXDEV across FS borders)
- sudo path: stage in /tmp under user → `sudo install -m mode -o owner src dst`
- sha256 fallback: tries sha256sum, falls back to openssl dgst -sha256

**Audit Tools (Sprint 6) 🔍**
- `ssh_audit_baseline` — single-batch baseline: hostname, disk, mem, net listeners, sshd config, services, docker, firewall, updates with auto-classification CRITICAL/WARNING/OK
- `ssh_tls_check` — TLS expiry + SAN match + issuer chain + Let's Encrypt renew_hook detection
- `ssh_disk_breakdown` — top-N largest dirs + docker df + journald + cache breakdown
- `ssh_service_status` — combined systemctl status + journalctl tail in one call

**ssh_file_write extensions (back-compat)**
- New per-file flags: `verify` (sha256 after write), `atomic` (.tmp + rename), `binary` (content as base64; uploaded via SFTP)
- Routing: any of verify/atomic/binary OR size > 256KB → SFTP path; otherwise legacy heredoc fast path
- sudo write: stage in /tmp + `sudo install` (avoids sftp under root)

**ssh_file_read extensions (back-compat)**
- New `binary: true` — reads via SFTP, returns base64 (binary-safe; legacy `cat` over PTY corrupts binaries)

### Changed
- Connection pool: added `getSftp()` helper around `client.sftp()` for tool reuse
- SSHManager.uploadFile/downloadFile: implemented (were `throw new Error('not implemented yet')`)
- Total tool count: 8 → 14

### Technical Details
- New file: `src/tools/transfer-tool.ts` — TransferTool with ssh_upload, ssh_download
- New file: `src/tools/audit-tool.ts` — AuditTool with 4 audit primitives
- New file: `src/utils/sha256.ts` — local + remote hashing helpers
- New file: `src/utils/tmp-name.ts` — atomic temp/staging path generators
- New tests: `tests/unit/sha256.test.ts` (8 tests), `tests/unit/tmp-name.test.ts` (9 tests)
- 77 total tests passing

### Documentation
- New: docs/transfer.md (SFTP transfer guide)
- New: docs/audit.md (audit tools guide)
- README.md: updated tool count and added Transfer/Audit sections

## [1.2.2] - 2026-01-12

**Note on version jump (1.0.1 → 1.2.2):** This release combines changes from multiple development sprints that were documented in CHANGELOG as versions 1.1.0, 1.1.1, 1.2.0, and 1.2.1, but were never released as separate git tags or npm packages. To maintain consistency with the [Keep a Changelog](https://keepachangelog.com/) standard (every version in CHANGELOG must have a corresponding git tag), all these changes have been consolidated into version 1.2.2.

**Why not 2.0.0?** This is not a breaking change release. All changes are backward compatible - existing functionality continues to work, and new features are additive. According to [Semantic Versioning](https://semver.org/), breaking changes would require a major version bump (2.0.0). The jump from 1.0.1 to 1.2.2 reflects the accumulation of multiple minor feature releases (Sprints 2-5) that were developed but not individually released.

### Added - Major Features Update (Sprints 2-5) 🚀

**Sprint 2: Connection Pool & Performance 🚀**
- **Connection Pool (Singleton)** - Reuse SSH connections for all commands
- **Keep-alive mechanism** - Automatic pings every 10 seconds to maintain connection
- **Auto-reconnect** - Automatic reconnection on connection loss
- **Idle cleanup** - Automatic closure of unused connections after 30 seconds
- **Graceful shutdown** - Proper closure of all connections on server stop
- **Pool metrics** - Pool usage statistics (cache hit/miss, reconnects, total commands)
- ⚡ **6-10× faster** for sequential commands (16s → 2.5s for 10 commands)
- ⚡ **6-10× faster** for batch operations
- ⚡ Cache hit rate >80% for repeated commands
- ⚡ One connection per profile instead of N connections for N commands

**Sprint 3: Path Security & Tilde Expansion 🛡️**
- **Tilde Expansion:**
  - Automatic tilde expansion - `~/file` automatically expands to `$HOME/file` on remote server
  - Support for ~user paths - `~username/file` properly handled by shell
  - Works in all file/log tools - `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`, `ssh_log_search`
- **Path Security (Optional):**
  - PathValidator utility - New optional security layer for path validation
  - Whitelist support - `allowedPaths` to restrict access to specific directories
  - Blacklist support - `deniedPaths` to block access to sensitive paths
  - Path traversal protection - `allowTraversal: false` prevents `../` attacks
  - Path length limits - `maxPathLength` to prevent extremely long paths
  - Per-profile configuration - Add `pathSecurity` to any SSH profile
- **Security Improvements:**
  - Dual quoting strategy - Single quotes (default) for safety, double quotes only for `$HOME`
  - Comprehensive escaping - Prevents variable expansion, command substitution, history expansion
  - Injection protection - Safe handling of special characters in paths (`;`, `$`, `` ` ``, `!`)

**Sprint 4: Timeout & Error Handling 🔧**
- **Retry Mechanism:**
  - Automatic retry - Connection failures automatically retry up to 3 times
  - Exponential backoff - Delays increase progressively (1s, 2s, 4s)
  - Smart retry logic - Retries only temporary errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND)
  - No retry for auth errors - Authentication failures fail immediately (no wasted attempts)
- **Enhanced Error Messages:**
  - ECONNREFUSED - "Check if SSH server is running and port is correct"
  - ETIMEDOUT - "Check firewall rules and network connectivity"
  - ENOTFOUND - "Check hostname/IP address in profile configuration"
  - Authentication failed - "Check username, SSH key path, and passphrase"
  - Invalid SSH key - "Check file exists and has correct permissions (600)"
  - Timeout after retries - "Check network connectivity and SSH server availability"

**Sprint 5: Profiles Reload & Monitoring 📊**
- **Profile Reload:**
  - Automatic reload - SSH profiles reload automatically when `SSH_PROFILES_FILE` changes
  - File watcher - Monitors profile file for changes (can be disabled with `SSH_MCP_PROFILES_WATCH=false`)
  - Cache with TTL - Profiles cached for 60 seconds (configurable with `SSH_MCP_PROFILES_CACHE_TTL`)
  - Manual reload - `ssh_monitor(action="reload")` to force reload profiles
  - Config change detection - ConnectionPool detects profile config changes and reconnects automatically
- **Monitoring Tool (ssh_monitor):**
  - stats - Get connection pool statistics (cache hit rate, active connections, metrics)
  - reload - Reload SSH profiles without server restart
  - test - Test connection to profile with timing metrics
  - list - List all available profiles with default marked
- **Enhanced Logging:**
  - Context logger - `logger.context('ModuleName')` for scoped logging
  - Performance timer - `logger.time('label')` for measuring operation duration
  - Configurable logging - `SSH_MCP_LOG_LEVEL`, `SSH_MCP_LOG_TIMESTAMP`, `SSH_MCP_LOG_COLORS`

**Environment Variables:**
- `SSH_MCP_LOG_LEVEL` - Log level: debug, info, warn, error (default: info)
- `SSH_MCP_LOG_TIMESTAMP` - Show timestamps: true, false (default: true)
- `SSH_MCP_LOG_COLORS` - Enable colors: true, false (default: false)
- `SSH_MCP_POOL_IDLE_TIMEOUT` - Connection idle timeout in ms (default: 30000)
- `SSH_MCP_POOL_KEEPALIVE_INTERVAL` - Keep-alive interval in ms (default: 10000)
- `SSH_MCP_PROFILES_CACHE_TTL` - Profile cache TTL in ms (default: 60000)
- `SSH_MCP_PROFILES_WATCH` - Watch profiles file: true, false (default: true)

### Changed - Performance & Developer Experience
- **SSHManager** - Uses ConnectionPool instead of creating new connection for each command
- **SSHExecutor** - Delegates connection management to SSHManager with pool
- **executeBatch** - Optimized to use single connection for all commands
- **All Tools** - Pass profileName for connection identification in pool
- **profile-resolver.ts** - Profiles now cached with TTL and auto-reload support
- **connection-pool.ts** - Detects profile config changes and reconnects automatically
- **logger.ts** - Enhanced with context logger and performance timer
- **index.ts** - Added MonitoringTool registration (8 tools total now)
- **file-tools.ts** - Added `expandRemoteTilde()`, `escapeForSingleQuotes()`, `escapeForDoubleQuotes()`, `buildSafeCommand()`
- **log-tools.ts** - Added `expandRemoteTilde()`, `escapeForSingleQuotes()`, `escapeForDoubleQuotes()`, `buildSafePath()`
- **All file/log operations** - Now use secure quoting strategy with proper escaping
- **ConnectionPool** - Integrated retry mechanism with exponential backoff
- **createConnection()** - Wrapped in `retryWithTimeout()` for automatic retry
- **connectClient()** - Separated single connection attempt for retry logic
- **Error messages** - Enhanced with specific troubleshooting hints

### Fixed
- **Connection Pool metrics** - Fixed negative `activeConnections` value (now calculated dynamically from pool size)
- **Session metrics auto-reset** - Metrics automatically reset when all connections close (session-based metrics, prevents memory leak)
- **Race condition** - Fixed race condition in timeout handler (resolveOnce/rejectOnce in ssh-manager.ts)
- **ISSUE-001** - Tilde (`~`) not expanding in file paths (now works correctly)
- **ARCH-004** - Incomplete path escaping (now escapes all special characters)
- **ARCH-005** - No path validation (now optional PathValidator available)
- **ARCH-007** - Profiles singleton without reload (now auto-reload with file watcher)
- **Temporary network failures** - Now automatically retry instead of failing immediately
- **Authentication errors** - No longer retry (fail fast with helpful message)
- **Timeout errors** - Clear error messages with context about what failed
- **No monitoring** - Added ssh_monitor tool for diagnostics and stats
- **No profile reload** - Profiles reload automatically or manually without server restart

### Technical Details
- New file: `src/managers/connection-pool.ts` - ConnectionPool Singleton for connection management
- New file: `src/tools/monitoring-tool.ts` - MonitoringTool with 4 actions
- New file: `src/utils/path-validator.ts` - PathValidator class with security rules
- New tests: `tests/unit/path-security.test.ts` - Comprehensive tests for tilde expansion and path validation
- File watcher using Node.js `fs.watch()` for instant profile reload
- Profile cache with TTL fallback if file watcher fails
- Map<profileName, PooledConnection> for storing active connections
- Automatic cleanup of idle connections every 10 seconds
- Thread-safe access to pool via async locks
- Logging of all pool operations (cache hit/miss, reconnects, cleanup)
- **retry.ts** - Integrated into ConnectionPool
- **createSSHRetryPredicate()** - Fixed to check auth errors first (case-insensitive)
- **retryWithTimeout()** - 3 attempts, 10s timeout per attempt, exponential backoff
- **Error context** - All errors include host, port, username for debugging
- **22 new tests** - Comprehensive error handling test suite
- **60 total tests** - All passing ✅

### Documentation
- Added Environment Variables section to README.md
- Added ssh_monitor examples to README.md
- Updated tool count from 7 to 8 commands
- Documented profile reload behavior
- Added Path Security section to README.md with configuration examples
- Updated BUGLIST.md - closed ISSUE-001, ARCH-004, ARCH-005
- Added Security section to README.md explaining quoting strategy
- Documented tilde expansion in usage examples
- Error handling improvements documented
- Retry mechanism explained

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

[1.3.0]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.1...v1.2.2
[1.0.1]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hypnosis/ssh-mcp-server/releases/tag/v1.0.0
