# 🐛 Bug List — SSH MCP Server

**Status:** Historical log, see the note under each section for what is current.

---

## 📋 Bugs found

### ❌ Critical bugs

*No open critical bugs* ✅

---

### ⚠️ Known issues (non-critical)

#### ✅ ISSUE-001: Tilde was not expanded in file paths [FIXED]
**Description:** When `ssh_file_read` was called with a path containing a tilde (`~`), the `cat` command could not find the file.
**Status:** ✅ Fixed
**Priority:** Medium
**Reproduction (before the fix):**
```text
ssh_file_read("~/.bashrc") → Error: cat: '~/.bashrc': No such file or directory
```
**Fix (v1.x):**
Tilde expansion was handed to the server's shell by rewriting `~/file` into `"$HOME/file"`,
with every other special character escaped.

**Where it lives now:** the mechanism moved when the transport did. The tilde is expanded on
our side, before the first command, in `src/managers/path-guard.ts` — the single place that
decides where a path actually leads. The home directory comes from one cached probe per
session rather than from the shell, because under `sudo` a shell would resolve `~` to
`/root` instead of the login user's home.

**Testing:**
- ✅ `ssh_file_read("~/.bashrc")` works
- ✅ `ssh_file_write("~/test.txt", "content")` works
- ✅ `ssh_log_tail("~/logs/app.log")` works
- ✅ Unit tests in `tests/unit/path-security.test.ts`

---

## 🔴 Architectural issues

### 🗑️ ARCH-001: No SSH connection pooling [REMOVED ALONG WITH THE MECHANISM]
**Description:** Every command opened a new SSH connection (connect → auth → exec → close).
**Impact:**
- 10 commands in a row meant 10 full connection cycles — 15-20 seconds
- The target was one connection for all commands — 2-3 seconds
**Performance:** **6-10× slower** than it could have been
**Components:** ~~`ssh-manager.ts`, `ssh-executor.ts`~~
**Status:** 🗑️ Removed — the mechanism this bug concerned no longer exists

> The connection pool built on `ssh2` (`ssh-manager.ts`) was removed together with the
> `ssh2` library itself — the transport is now the single system `ssh` (`CHANGELOG.md`).
> The "every command opens a new connection" problem was solved by a different mechanism:
> ControlMaster multiplexing in the system SSH client, where every command shares one
> master socket (`src/runner/ssh-args.ts`). The bug was not fixed by the plan that
> originally described it — that plan and the code it concerned no longer exist.

### 🗑️ ARCH-002: `executeBatch` was inefficient [REMOVED ALONG WITH THE MECHANISM]
**Description:** Batch commands ran sequentially, each opening a new connection.
**Impact:** A batch of 10 commands opened 10 connections instead of 1.
**Performance:** **10× slower** for batch operations
**Components:** ~~`ssh-manager.ts`~~
**Status:** 🗑️ Removed — `ssh-manager.ts` and the `ssh2` connection pool are gone

> `ssh-manager.ts` no longer exists in the project. Batch commands
> (`src/tools/exec-tool.ts`) still run one at a time in a loop, but each one now reuses the
> shared ControlMaster socket instead of a fresh TCP+SSH handshake — not through a dedicated
> pooled `executeBatch` as originally planned, but through a transport that gives every call
> the same benefit anyway (`src/runner/ssh-args.ts`).

### ✅ ARCH-003: Timeout race condition [FIXED]
**Description:** The timeout handler could call `reject()` after the promise had already resolved.
**Impact:** Rare errors, double resolve/reject calls.
**Components:** ~~`ssh-manager.ts`~~ → `src/runner/process.ts`
**Status:** ✅ Fixed in the current transport

> `ssh-manager.ts`, where the bug was originally described, was removed together with the
> `ssh2` connection pool. In the current transport (`src/runner/process.ts`) the race
> condition is closed by a `settled` flag checked before every resolve/reject.

### ✅ ARCH-004: Incomplete path escaping [FIXED]
**Description:** `escapePath` only escaped single quotes, not all special characters.
**Impact:** Potential problems with paths containing special characters.
**Components:** `file-tools.ts`, `log-tools.ts`
**Status:** ✅ Fixed
**Fix (v1.x):**
Two escaping methods, chosen by the path: single quotes for a regular one, double quotes
only where `$HOME` had to survive expansion.

**Where it lives now:** the double-quoted route disappeared along with `$HOME` substitution —
the tilde is expanded before the command is built, so nothing inside it needs the shell any
more. Quoting is one function, `shellQuote()` in `src/utils/shell-arg.ts`, and it always uses
single quotes. Names travelling as separate words — mode, owner, glob — have their own
validators next to it.

### ✅ ARCH-005: No path validation [FIXED, THEN CORRECTED]
**Description:** There was no whitelist/blacklist for paths — any file could be read.
**Security:** No restriction on path traversal (`../`); an AI could accidentally read
sensitive files (for example `/etc/shadow`).
**Components:** `file-tools.ts`, `log-tools.ts`, `path-validator.ts`
**Status:** ✅ Fixed
**Fix:**
- A `PathValidator` was added, configured optionally through profiles
- Support for `allowedPaths` (whitelist) and `deniedPaths` (blacklist)
- A path-length limit (`maxPathLength`)
- Integrated into `file-tools.ts` and `log-tools.ts`
**Configuration:** Optional, added to SSH profiles through `pathSecurity`

> The original "fixed" mark was wrong: the code and tests existed, but the `pathSecurity`
> field never reached the tool from the profiles file — the validator was never
> instantiated, and there was no restriction at all. This surfaced through a live measurement
> on a container. The field now travels the full path, the rules apply in the transfer
> tools too, and validation runs **after** `~` expansion.
>
> `allowTraversal: false` is a separate, still-open problem, not fixed by the work
> described above: the path is canonicalized before it reaches the validator, so any `..`
> is already resolved away by the time the rule would check for it. The rule cannot fire on
> any call. The field is kept in the profile format for backward compatibility — the
> package is published on npm and the format does not change — but setting it has no
> effect. `allowedPaths`, `deniedPaths`, and `maxPathLength` are the mechanisms that
> actually restrict paths.

### ✅ ARCH-006: Profiles were a singleton with no reload [FIXED]
**Description:** Profiles were loaded once at startup; there was no way to reload them without a restart.
**Impact:** Inconvenient during development and configuration changes.
**Components:** `src/utils/profile-resolver.ts`
**Status:** ✅ Fixed

> Implemented as planned: a cache with a TTL (`SSH_MCP_PROFILES_CACHE_TTL`), a file watcher
> on the profiles file, and a manual reload through `reloadProfiles()`
> (`src/utils/profile-resolver.ts`).

---

## 📋 Original fix plan (historical)

> The plan below is historical. See the current `docs/sprints/ROADMAP.md` for what is
> actually in progress. Every item this plan was written for has since been closed above:
> the connection pool was removed together with `ssh2` (ARCH-001, ARCH-002), path escaping
> and validation were fixed (ARCH-004, ARCH-005, with the `allowTraversal` caveat noted
> above), the timeout race was fixed (ARCH-003), and profile reload was fixed (ARCH-006).

See the detailed roadmap: `docs/sprints/ROADMAP.md`

**Original sprint plan:**
1. 🔴 Sprint 2: Connection Pool & Performance — critical
2. 🟡 Sprint 3: Path Security & Tilde Expansion
3. 🟡 Sprint 4: Timeout & Error Handling
4. 🟢 Sprint 5: Profiles Reload & Monitoring

**Expected improvements:**
- ⚡ Performance: **6-10× faster** (connection pool)
- 🛡️ Security: path validation, safe escaping
- 🔧 Stability: retry, auto-reconnect, timeout fix
- 📊 Convenience: monitoring, profile reload, debug tools

---

## ✅ Fixed bugs

### BUG-001: SSH authentication failed ✅ Fixed
**Description:** All SSH commands returned "All configured authentication methods failed".
**Status:** ✅ Fixed
**Priority:** Critical
**Fix:**
1. The problem was an incorrect SSH key path in the profile.
2. The path in the profile configuration was corrected.
3. An explicit check for the key's existence was added, with a clear error message.
4. The fallback mechanism was removed — no magic, only explicit paths.

**Testing:**
- ✅ `ssh_exec` works: command executes successfully
- ✅ SSH connection works through a plain SSH client
- ✅ The MCP tool `ssh_exec` works correctly

**Code changes:**
- Added detailed logging in `ssh-executor.ts` (the `connect` method)
- Added an explicit `existsSync` check for the SSH key with a clear error
- Removed the temporary fallback mechanism
- Key-loading errors are now thrown explicitly instead of swallowed
- Logs show full information about key loading, paths, and connection parameters

---

## 📝 Test log — v1.x

**This section is a historical test log from v1.x.** It predates the move from the
`ssh2` library to the system OpenSSH client, and it predates the current tool set (18
tools) and test suite (2160 unit tests, 307 live tests). The checkmarks below record what
passed in that older version, not the state of the current codebase. For the current
state, run the tests in the repository (`npx vitest run tests/unit/`,
`SSH_MCP_LIVE=1 npx vitest run tests/live/`).

### Functions tested (v1.x):
- [x] `ssh_exec` (single command) ✅
- [x] `ssh_exec` (batch of commands) ✅
- [x] `ssh_exec` (with sudo) ✅
- [x] `ssh_exec` (with cwd) ✅
- [x] `ssh_exec` (dangerous commands — warning) ✅
- [x] `ssh_file_read` (single file) ✅
- [x] `ssh_file_read` (multiple files) ✅
- [x] `ssh_file_read` (with sudo) ✅
- [x] `ssh_file_write` (single file) ✅
- [x] `ssh_file_write` (multiple files) ✅
- [x] `ssh_file_list` (plain listing) ✅
- [x] `ssh_file_list` (with a pattern) ✅
- [x] `ssh_file_list` (recursive) ✅
- [x] `ssh_log_tail` (single log) ✅
- [x] `ssh_log_tail` (multiple logs) ✅
- [x] `ssh_log_search` (simple search) ✅
- [x] `ssh_log_search` (with context) ✅
- [x] `ssh_log_search` (multiple logs) ✅
- [x] `ssh_snapshot` (full snapshot) ✅

### Results (v1.x):
- **`ssh_exec`**: ✅ passed (19 tests)
  - Single commands ✅
  - Batch commands ✅
  - Commands with sudo ✅
  - Commands with cwd ✅
  - Warnings for dangerous commands ✅
- **`ssh_file_read`**: ✅ passed (3 tests)
  - Reading a single file ✅
  - Reading multiple files ✅
  - Reading with sudo ✅
  - ⚠️ Note: the tilde (`~`) was not expanded yet at this point — absolute paths were required
- **`ssh_file_write`**: ✅ passed (2 tests)
  - Writing a single file ✅
  - Writing multiple files ✅
- **`ssh_file_list`**: ✅ passed (3 tests)
  - Plain listing ✅
  - Listing with a pattern ✅
  - Recursive listing ✅
- **`ssh_log_tail`**: ✅ passed (2 tests)
  - Last lines of a single log ✅
  - Last lines of multiple logs ✅
- **`ssh_log_search`**: ✅ passed (3 tests)
  - Simple search ✅
  - Search with context ✅
  - Search across multiple logs ✅
- **`ssh_snapshot`**: ✅ passed (1 test)
  - Full system snapshot ✅

**Total: all 19 v1.x tests passed** 🎉

---

## 🔍 Logging and debug information

This section also describes v1.x. The component and log-prefix names below may not match
the current codebase one to one; treat it as historical context on how debugging was
approached, not as a guide to today's logging.

### ✅ Detailed logging added:

#### 1. `ssh-executor.ts`:
- ✅ Logging at the start of a connection (host, port, username)
- ✅ Logging SSH key loading (path, existence check, validation)
- ✅ Logging the authentication method (private key / password)
- ✅ Logging all SSH events (ready, error, keyboard-interactive)
- ✅ Detailed logging of connection errors (code, level, full detail)
- ✅ Logging command execution (command, stdout/stderr size, exit code)

#### 2. `profile-resolver.ts`:
- ✅ Logging profile resolution (requested, available, default)
- ✅ Logging profile details (host, port, username, key path)
- ✅ Logging path expansion (`~` → full path)
- ✅ Logging profile validation
- ✅ Logging the final SSH configuration (without passwords)

#### 3. `profiles-file.ts`:
- ✅ Logging profiles-file loading (path, size)
- ✅ Logging validation of each profile
- ✅ Logging skipped profiles (`mode: local`, missing fields)
- ✅ Logging validation errors (invalid port, etc.)
- ✅ Logging default-profile selection

#### 4. `index.ts`:
- ✅ Logging the `SSH_PROFILES_FILE` check
- ✅ Logging profile loading at startup

### 🔍 What the logs show:

Every log line has a `[Component Name]` prefix identifying its source:
- `[MCP Server]` — initial server startup
- `[Profiles File]` — loading the profiles file
- `[Profile Resolver]` — resolving the SSH configuration
- `[SSH Executor]` — SSH connection and command execution

Log levels:
- `debug` — detailed information (every step of the process)
- `info` — important events (✅ successful operations)
- `warn` — warnings (⚠️ potential problems)
- `error` — errors (❌ critical problems)

### 📋 To enable detailed logs:

**Note:** Logs are written to the MCP server's stderr. To view them:
1. Open the console/terminal where your MCP client is running, or
2. Check the server logs in your MCP client's settings.

**Example `mcp.json` configuration (adjust the profiles-file path for your client —
`$HOME/.claude/ssh-profiles.json` for Claude Code, `$HOME/.codex/ssh-profiles.json` for
Codex CLI):**
```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp-server/dist/index.js"],
      "env": {
        "SSH_PROFILES_FILE": "$HOME/.claude/ssh-profiles.json",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

**After changing `mcp.json`:**
1. Restart the MCP client completely.
2. Run a test command.
3. Check the logs on stderr (your MCP client's console, or its MCP log view).

**What to look for in the logs:**
- `[Profiles File]` — profile loading
- `[Profile Resolver]` — SSH configuration resolution
- `[SSH Executor]` — connection details (key, path, errors)
- `[SSH Executor] ❌` — connection errors with detail
