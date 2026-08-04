# SSH MCP Server

**Universal SSH MCP Server** for managing remote servers via AI assistants (Cursor, Claude Desktop).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**GitHub:** [@hypnosis](https://github.com/hypnosis) | **License:** MIT | **npm:** [@hypnosis/ssh-mcp-server](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server)

> **⚠️ IMPORTANT for binaries and large files:** use `ssh_upload` / `ssh_download` (SFTP, binary-safe, sha256 verify, atomic rename) — **NOT** base64-chunks through `ssh_exec` or `ssh_file_write` heredoc. Heredoc-based writes corrupt binaries and have no atomic / integrity guarantees. See [Transfer tools](#-transfer-tools-v130) and [docs/transfer.md](docs/transfer.md).

## ✨ Features

### 14 Powerful Commands:

**Core (8):**
1. **ssh_exec** - Universal command execution (single or batch)
2. **ssh_file_read** - Read files (single or multiple); `binary: true` for base64
3. **ssh_file_write** - Write files (single or multiple); `verify` / `atomic` / `binary`
4. **ssh_file_list** - List files in directory
5. **ssh_log_tail** - Last N lines from logs (single or multiple)
6. **ssh_log_search** - Search logs with grep (single or multiple)
7. **ssh_snapshot** - Instant system health check
8. **ssh_monitor** - Monitor connections, reload profiles, test connections

**Transfer — SFTP (2, v1.3.0+):**
9. **ssh_upload** - Binary-safe file/directory upload (sha256 verify, atomic rename, sudo via `install`)
10. **ssh_download** - Binary-safe file/directory download (sha256 verify)

**Audit — read-only deep checks (4, v1.3.0+):**
11. **ssh_audit_baseline** - One-shot system audit (replaces 5+ ssh_exec calls)
12. **ssh_tls_check** - TLS expiry + SAN + issuer + Let's Encrypt renew_hook
13. **ssh_disk_breakdown** - df + top-N du + docker df + journald + caches
14. **ssh_service_status** - systemctl status + journalctl tail in one call

### Key Features:

- ✅ **REST approach** - arrays where logical
- ✅ **Security** - warnings for dangerous commands, path validation, safe quoting
- ✅ **Tilde expansion** - `~/file` automatically expands to `$HOME/file`
- ✅ **Path security** - optional whitelist/blacklist per profile
- ✅ **sudo support** - parameter in every command
- ✅ **Profiles** - multiple SSH configurations
- ✅ **Retry logic** - automatic retries on network errors
- ✅ **Connection pooling** - reuse SSH connections for better performance

## 📦 Installation

```bash
# Global install
npm install -g @hypnosis/ssh-mcp-server

# Or run on demand without installing
npx @hypnosis/ssh-mcp-server
```

Latest published version: see [npmjs.com/@hypnosis/ssh-mcp-server](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server).

## 🚀 Quick Start

### 1. Create Profile Configuration

Create file `~/.cursor/ssh-profiles.json`:

```json
{
  "default": "production",
  "profiles": {
    "production": {
      "host": "server.example.com",
      "username": "admin",
      "port": 22,
      "privateKeyPath": "~/.ssh/your_private_key"
    },
    "staging": {
      "host": "staging.example.com",
      "username": "deploy",
      "port": 22,
      "privateKeyPath": "~/.ssh/your_private_key"
    }
  }
}
```

**Note:** You can use the same profiles file as Docker MCP Server. SSH MCP will automatically skip profiles with `mode: "local"` and use profiles with `host` and `username`.

### 1.1. Optional: Path Security Configuration

You can add optional security rules to restrict file access per profile:

```json
{
  "default": "production",
  "profiles": {
    "production": {
      "host": "prod.example.com",
      "username": "admin",
      "port": 22,
      "privateKeyPath": "~/.ssh/id_rsa_prod",
      
      "pathSecurity": {
        "allowedPaths": ["/home/admin", "/var/www", "/var/log"],
        "deniedPaths": ["/etc/shadow", "/root", "/etc/ssh"],
        "allowTraversal": false,
        "maxPathLength": 1000
      }
    }
  }
}
```

**Path Security Options:**

- **`allowedPaths`** (optional): Whitelist of allowed directories. If specified, only paths starting with these prefixes are allowed.
  - Example: `["/home/admin", "/var/www"]`
  - Subdirectories are allowed: `/home/admin/subdir/file.txt` ✅

- **`deniedPaths`** (optional): Blacklist of forbidden paths. Paths starting with these prefixes will be rejected.
  - Example: `["/etc/shadow", "/root", "/etc/ssh"]`
  - Takes priority over `allowedPaths`

- **`allowTraversal`** (optional): Allow path traversal (`../`) in paths. Default: `true`
  - Set to `false` to prevent directory traversal attacks
  - Example: `../../../etc/passwd` ❌ rejected

- **`maxPathLength`** (optional): Maximum allowed path length. Default: unlimited
  - Example: `1000` (paths longer than 1000 chars rejected)

**Security Notes:**

- Path security is **optional**. If not configured, all paths are allowed.
- Blacklist (`deniedPaths`) is checked before whitelist (`allowedPaths`)
- These rules apply to: `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`,
  `ssh_log_search`, `ssh_upload`, `ssh_download`
- Tilde (`~`) paths are expanded **before** the rules are checked, using the home directory
  reported by the server — so `deniedPaths: ["/root"]` also rejects `~/secret` when the
  session user is `root`
- A malformed `pathSecurity` block is a profile error, not a silently ignored setting:
  a rule that quietly disappears looks like protection that is not there

### 2. Configure Cursor

Add to `~/.cursor/mcp.json` (example):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp-server/dist/index.js"],
      "env": {
        "SSH_PROFILES_FILE": "~/.cursor/ssh-profiles.json"
      }
    }
  }
}
```

### 3. Restart Cursor

Done! AI can now manage your servers.

## 📚 Usage Examples

### ssh_exec - Execute Commands

**⚠️ Important: Array Syntax**

For batch commands, use **double quotes** in JSON format:
- ✅ Correct: `command: ["cmd1", "cmd2"]`
- ❌ Incorrect: `command: ['cmd1', 'cmd2']`

MCP tools require valid JSON syntax. Single quotes will cause errors.

```typescript
// Single command
ssh_exec({
  profile: "production",
  command: "systemctl status nginx"
})

// Batch commands (use double quotes!)
ssh_exec({
  profile: "production",
  command: [
    "systemctl status nginx",
    "docker ps",
    "df -h"
  ]
})

// With sudo
ssh_exec({
  profile: "production",
  command: "systemctl restart nginx",
  sudo: true
})

// With working directory
ssh_exec({
  profile: "production",
  command: "npm install",
  cwd: "/var/www/app"
})
```

### ssh_file_read - Read Files

**Note:** For multiple files, use double quotes: `path: ["file1", "file2"]`

**Tilde Support:** Paths with `~` are automatically expanded to `$HOME`

```typescript
// Single file
ssh_file_read({
  profile: "production",
  path: "/etc/nginx/nginx.conf"
})

// Tilde paths (automatically expanded)
ssh_file_read({
  profile: "production",
  path: "~/.bashrc"  // Expands to $HOME/.bashrc ✅
})

// Multiple files (use double quotes!)
ssh_file_read({
  profile: "production",
  path: [
    "/etc/nginx/nginx.conf",
    "~/.ssh/config",        // Tilde works! ✅
    "/etc/hosts"
  ]
})

// With sudo
ssh_file_read({
  profile: "production",
  path: "/root/.ssh/config",
  sudo: true
})
```

### ssh_file_write - Write Files

```typescript
// Single file
ssh_file_write({
  profile: "production",
  files: {
    path: "/var/www/app/.env",
    content: "APP_ENV=production\nDB_HOST=localhost",
    mode: "600"
  }
})

// Multiple files
ssh_file_write({
  profile: "production",
  files: [
    {
      path: "/etc/nginx/sites-available/app.conf",
      content: "server { ... }",
      mode: "644",
      sudo: true
    },
    {
      path: "/var/www/app/.env",
      content: "APP_ENV=production",
      mode: "600"
    }
  ]
})
```

#### v1.3.0+ Per-File Flags: `verify`, `atomic`, `binary`

`ssh_file_write` is back-compat by default but now supports three new per-file flags. Internally any of these — or content size > 256KB — routes the write through SFTP instead of the legacy heredoc fast path.

| Flag | Default | What it does |
|------|---------|--------------|
| `verify` | `false` | Compute local sha256, compare against remote `sha256sum` (fallback `openssl dgst -sha256`) after write |
| `atomic` | `false` | Write to `<path>.tmp.<rand>` next to target, then `mv` (atomic on the same FS) |
| `binary` | `false` | `content` is base64; decoded and uploaded via SFTP. Use this for non-text payloads |

```typescript
// Verified atomic config write (text)
ssh_file_write({
  profile: "production",
  files: {
    path: "/etc/nginx/conf.d/app.conf",
    content: "server { listen 80; }\n",
    mode: "644",
    sudo: true,
    atomic: true,
    verify: true
  }
})

// Binary payload (e.g. small image, certificate, .pem)
ssh_file_write({
  profile: "production",
  files: {
    path: "/etc/ssl/private/app.pem",
    content: "<base64-encoded-bytes>",
    binary: true,
    mode: "600",
    sudo: true,
    atomic: true,
    verify: true
  }
})
```

> For files larger than ~1 MB, prefer `ssh_upload` — it streams chunks directly and avoids loading content into the LLM context.

#### v1.3.0+ ssh_file_read — `binary: true`

Reads via SFTP and returns base64-encoded bytes, byte-for-byte safe (legacy `cat` over PTY corrupts binaries due to encoding/CR-LF translation).

```typescript
ssh_file_read({
  profile: "production",
  path: "/etc/ssl/certs/app.crt",
  binary: true   // returns base64
})
```

### ssh_file_list - List Files

```typescript
// List directory
ssh_file_list({
  profile: "production",
  path: "/var/log/nginx"
})

// With pattern filter
ssh_file_list({
  profile: "production",
  path: "/var/log",
  pattern: "*.log"
})

// Recursively
ssh_file_list({
  profile: "production",
  path: "/etc/nginx",
  recursive: true
})
```

### ssh_log_tail - Last Log Lines

**Note:** For multiple logs, use double quotes: `path: ["log1", "log2"]`

```typescript
// Single log
ssh_log_tail({
  profile: "production",
  path: "/var/log/nginx/error.log",
  lines: 100
})

// Multiple logs (use double quotes!)
ssh_log_tail({
  profile: "production",
  path: [
    "/var/log/nginx/error.log",
    "/var/log/nginx/access.log"
  ],
  lines: 50
})
```

### ssh_log_search - Search Logs

```typescript
// Search for errors
ssh_log_search({
  profile: "production",
  path: "/var/log/nginx/error.log",
  query: "error|fatal"
})

// With context lines
ssh_log_search({
  profile: "production",
  path: "/var/log/syslog",
  query: "docker",
  context: 3
})

// Multiple logs
ssh_log_search({
  profile: "production",
  path: [
    "/var/log/nginx/*.log",
    "/var/log/syslog"
  ],
  query: "500|502|503"
})
```

### ssh_snapshot - System Health Check

```typescript
// Full system snapshot
ssh_snapshot({
  profile: "production"
})

// Returns:
// - Hostname, uptime
// - Service status (nginx, docker, postgresql, etc)
// - Resources (CPU, Memory, Disk)
// - Docker containers (if available)
// - Open ports and connections
// - Recent errors from logs
```

### ssh_monitor - Monitoring & Diagnostics

```typescript
// Get connection pool statistics
ssh_monitor({
  action: "stats"
})
// Returns: cache hit rate, active connections, session metrics
// Note: Metrics reset automatically when all connections close (session-based)

// Reload SSH profiles (without server restart)
ssh_monitor({
  action: "reload"
})
// Reloads SSH_PROFILES_FILE and shows new profiles

// Test connection to profile
ssh_monitor({
  action: "test",
  profile: "production"
})
// Tests connection and shows connect/command timings

// List available profiles
ssh_monitor({
  action: "list"
})
// Shows all available profiles with default marked
```

---

## 📦 Transfer tools (v1.3.0+)

Binary-safe SFTP transfer, piggy-backed on the same connection pool used by other tools. **Use these instead of base64-chunks through ssh_exec** — heredoc / `cat > file` corrupts binaries, has no atomic semantics, no integrity verification, and pulls the whole payload into Node memory.

Defaults: `atomic=true` (write to `<path>.tmp.<rand>`, then `mv`), `verify=true` (local sha256 vs remote `sha256sum` / `openssl dgst -sha256` fallback).

**File-size guidance:**
- ≤ 256 KB, text only → `ssh_file_write` (legacy heredoc, slightly faster — no second sha256 round-trip)
- 256 KB – 1 MB, text → `ssh_file_write` with `atomic: true, verify: true` (auto-routes to SFTP)
- Anything binary, or > 1 MB → `ssh_upload` (streams chunks, never loads file into LLM context)

For full API and architecture see [docs/transfer.md](docs/transfer.md).

### ssh_upload — Binary-safe upload

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `local_path` | string | **required** | Local file or directory path |
| `remote_path` | string | **required** | Remote destination path |
| `mode` | string | — | Octal file mode, e.g. `"644"` |
| `recursive` | boolean | auto | Force directory mode (auto-detected via local `stat()`) |
| `atomic` | boolean | `true` | Write to `<path>.tmp.<rand>`, then `mv` |
| `verify` | boolean | `true` | Compare local and remote sha256 after upload |
| `sudo` | boolean | `false` | Stage in `/tmp`, then `sudo install` into target |
| `owner` | string | — | When `sudo=true`: `"user:group"` for `install -o/-g` |
| `overwrite` | boolean | `true` | Allow overwriting an existing remote file |
| `concurrency` | number | `4` | Parallel SFTP chunk concurrency for `fastPut` |

```typescript
// 1) Single file with sha256 verify and atomic rename (defaults)
ssh_upload({
  profile: "production",
  local_path: "./build/app.tar.gz",
  remote_path: "/srv/releases/app-2026-05.tar.gz",
  mode: "644"
})
// SFTP fastPut → write to .tmp.<rand> → sha256 verify → mv → chmod

// 2) Recursive directory upload (auto-detected from local stat)
ssh_upload({
  profile: "production",
  local_path: "./dist",
  remote_path: "/var/www/app/current",
  mode: "755",
  concurrency: 8
})
// walks local tree, uploads to staging dir, atomic mv into place

// 3) sudo write to /etc — staged in /tmp, then `sudo install -m 644 -o root:root`
ssh_upload({
  profile: "production",
  local_path: "./nginx-site.conf",
  remote_path: "/etc/nginx/conf.d/site.conf",
  mode: "644",
  owner: "root:root",
  sudo: true
})
// Note: recursive + sudo is not supported in one shot — workaround:
//   1) upload to a user-writable staging path (no sudo)
//   2) sudo cp -r via ssh_exec
// Symlinks in recursive uploads are skipped (not dereferenced, not recreated).
// For symlink fidelity tar -czf locally and upload the tarball.

// 4) Download a binary back (verify on by default)
ssh_download({
  profile: "production",
  remote_path: "/var/log/nginx/access.log.1.gz",
  local_path: "./logs/access.log.1.gz"
})
```

### ssh_download — Binary-safe download

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `remote_path` | string | **required** | Remote source path |
| `local_path` | string | **required** | Local destination path |
| `recursive` | boolean | auto | Force directory mode (auto-detected via remote `test -d`) |
| `verify` | boolean | `true` | Compare local and remote sha256 after download |
| `concurrency` | number | `4` | Parallel SFTP chunk concurrency for `fastGet` |

```typescript
ssh_download({
  profile: "production",
  remote_path: "/var/backups/db",
  local_path: "./backups/db",
  recursive: true,
  concurrency: 4
})
```

---

## 🔍 Audit tools (v1.3.0+)

Specialized read-only audit primitives that collect evidence in **one round-trip each**. The big win is `ssh_audit_baseline`: **one call replaces 5+ separate ssh_exec invocations** (df, free, ss, docker ps, systemctl, sshd -T, ufw, …) — both the latency and the result-merging cost are gone.

For pipeline guidance and full section descriptions see [docs/audit.md](docs/audit.md).

### ssh_audit_baseline

One batched compound shell command, results split by sentinel markers, parsed into structured JSON + a CRITICAL/WARNING/OK shortlist. Replaces 5–10 separate `ssh_exec` calls (df, free, ss, docker, systemctl, sshd -T, ufw, apt …) with **one round-trip**.

Sections (toggle via `include`): `system, disk, mem, net, ssh, services, docker, firewall, updates`. By default all sections except `ssh` (sudo).

| Flag | Default | Purpose |
|------|---------|---------|
| `include` | all except `ssh` | Restrict to subset, e.g. `["disk", "services"]` |
| `include_sudo_sections` | `false` | Enables `sshd -T` (whole compound runs under sudo) |
| `compact` | `true` | Trim long sections (listeners, interfaces, docker rows) for smaller LLM payload |

Output format: human-readable summary (host header → CRITICAL/WARNING shortlist → disk table → listeners → sshd → services → docker → firewall → updates) followed by `--- raw JSON ---` and the full structured result.

Auto red-flag rules:
- **CRITICAL**: filesystem ≥ 90%, `PermitRootLogin yes`, `PasswordAuthentication yes` on port 22
- **WARNING**: filesystem 70–90%, exited containers, failed systemd units, reboot pending, > 50 upgradable packages
- **OK**: filesystem < 70% per mount, everything nominal

```typescript
ssh_audit_baseline({
  profile: "production",
  include_sudo_sections: true   // enables sshd -T section
})

// Restrict to a subset
ssh_audit_baseline({
  profile: "production",
  include: ["disk", "services", "docker"]
})
```

### ssh_tls_check

Pipes `openssl s_client -connect <domain>:<port> -servername <domain>` into `openssl x509`, parses `notAfter`, SAN entries (X509v3 Subject Alternative Name), issuer; computes `days_until_expiry`. Also scans `/etc/letsencrypt/renewal/*.conf` for `renew_hook` and `/etc/letsencrypt/renewal-hooks/deploy/`.

- **CRITICAL**: expired, ≤ 7 days, or SAN does not include the requested domain
- **WARNING**: ≤ 30 days, or no Let's Encrypt deploy_hook configured

```typescript
ssh_tls_check({
  profile: "production",
  domain: "app.example.com",
  port: 443,
  check_renew_hook: true
})
```

### ssh_disk_breakdown

Single batched call. Use when `ssh_audit_baseline` flags a disk above 70%. Heavier than baseline (multiple `du -shx` traversals), so don't run unconditionally.

| Section | Command |
|---------|---------|
| `df` | `df -hT` |
| `du_<path>` | `du -shx <path>/* \| sort -rh \| head -<top_n>` for each `paths[]` |
| `docker` | `docker system df -v` (or `NO_DOCKER`) |
| `journald` | `journalctl --disk-usage` (or `NO_JOURNALD`) |
| `var_log` | `du -sh /var/log/* \| sort -rh \| head -<top_n>` |
| `cache` | `du -sh "$HOME"/.cache/* \| sort -rh \| head -<top_n>` |

Defaults: `top_n: 20`, `paths: ["/"]`. `paths` is shell-quoted before interpolation.

```typescript
ssh_disk_breakdown({
  profile: "production",
  top_n: 20,
  paths: ["/", "/var", "/home"]
})
```

### ssh_service_status

Replaces `systemctl status` + `journalctl -u` for one systemd unit. All in one batched call, parsed into structured `enabled / active / restart / status_head / log_tail`.

| Section | Command |
|---------|---------|
| `status` | `systemctl status <unit> --no-pager \| head -40` |
| `is_enabled` | `systemctl is-enabled <unit>` |
| `show` | `systemctl show <unit> --property=Restart,RestartSec,LoadState,ActiveState,SubState` |
| `log` | `journalctl -u <unit> -n <log_lines> --no-pager [--since <since>]` |

Defaults: `log_lines: 50`. `since` accepts any `journalctl --since` value (`"1h ago"`, `"2026-05-03"`). Unit name is validated against `^[a-zA-Z0-9@._-]+$` for shell-injection safety.

```typescript
ssh_service_status({
  profile: "production",
  unit: "nginx.service",
  log_lines: 50,
  since: "1h ago"
})
```

### Recommended audit pipeline

```typescript
// 1) One-shot baseline → CRITICAL/WARNING shortlist
const baseline = ssh_audit_baseline({ profile: "production", include_sudo_sections: true });

// 2) If any disk warning/critical → drill down
ssh_disk_breakdown({ profile: "production", top_n: 20 });

// 3) For each public FQDN
ssh_tls_check({ profile: "production", domain: "app.example.com" });

// 4) For each failed systemd unit
ssh_service_status({ profile: "production", unit: "nginx.service" });
```

This pipeline covers ~80% of a typical server audit without touching `ssh_exec`.

---

## 🔧 Environment Variables

### Required
- `SSH_PROFILES_FILE` - Path to SSH profiles JSON file

### Optional (Logging)
- `SSH_MCP_LOG_LEVEL` - Log level: `debug`, `info`, `warn`, `error` (default: `info`)
- `SSH_MCP_LOG_TIMESTAMP` - Show timestamps in logs: `true`, `false` (default: `true`)

### Optional (Connection Pool)
- `SSH_MCP_POOL_IDLE_TIMEOUT` - Idle timeout for connections in ms (default: `30000`)
- `SSH_MCP_POOL_KEEPALIVE_INTERVAL` - Keep-alive ping interval in ms (default: `10000`)

### Optional (Profiles)
- `SSH_MCP_PROFILES_CACHE_TTL` - Profile cache TTL in ms (default: `60000`)
- `SSH_MCP_PROFILES_WATCH` - Watch profiles file for changes: `true`, `false` (default: `true`)

### Example Configuration

```bash
# Required
export SSH_PROFILES_FILE="$HOME/.ssh/mcp-profiles.json"

# Optional - Logging
export SSH_MCP_LOG_LEVEL="debug"
export SSH_MCP_LOG_TIMESTAMP="true"

# Optional - Connection Pool
export SSH_MCP_POOL_IDLE_TIMEOUT="60000"

# Optional - Profiles
export SSH_MCP_PROFILES_WATCH="true"
export SSH_MCP_PROFILES_CACHE_TTL="60000"
```

**Note:** Profile reload happens automatically when `SSH_PROFILES_FILE` changes (if `SSH_MCP_PROFILES_WATCH=true`). You can also manually reload profiles using `ssh_monitor(action="reload")`.

---

## 🔒 Security

### Dangerous Command Warnings

The server automatically detects dangerous commands:

```typescript
ssh_exec({
  command: "rm -rf /"
})
// ⚠️  DANGEROUS COMMAND: rm -rf / detected
// Command will execute but with warning
```

Dangerous patterns detected:
- `rm -rf /`, `rm -rf ~`, `rm -rf *`
- `chmod 777`
- `reboot`, `shutdown`, `halt`
- `docker system prune -a`
- `DROP DATABASE`, `TRUNCATE`

### Recommendations

1. **Use SSH keys** instead of passwords
2. **Limit user permissions** (use non-root user with sudo)
3. **Regularly rotate keys**
4. **Check MCP server logs**

## 🏗️ Architecture

```
~/.cursor/mcp.json
      ↓
SSH MCP Server
      ↓
Profile Resolver → ~/.cursor/ssh-profiles.json
      ↓
Connection Pool (reuse connections)
      ↓
SSH Executor
      ↓
14 Tools (exec, file, log, snapshot, monitor, transfer, audit)
      ↓
Remote Server(s)
```

### Key Principles:

- **Connection Pool** - reuse SSH connections for better performance (6-10× faster)
- **Session-based metrics** - metrics reset automatically when all connections close
- **NO streaming** - snapshot results only
- **REST approach** - arrays where logical
- **Retry logic** - automatic retries with exponential backoff
- **Auto-reconnect** - automatic reconnection on connection loss

## 🛠️ Development

### Requirements

- Node.js 18+
- TypeScript 5+
- SSH access to remote servers

### Development Setup

```bash
git clone https://github.com/hypnosis/ssh-mcp-server.git
cd ssh-mcp-server
npm install
npm run build
```

### Run in Dev Mode

```bash
npm run dev
```

### Project Structure

```
src/
├── index.ts                    # Entry point + routing
├── managers/
│   ├── ssh-executor.ts         # SSH commands
│   └── connection-pool.ts      # Connection pool + getSftp()
├── tools/
│   ├── exec-tool.ts            # ssh_exec
│   ├── file-tools.ts           # ssh_file_read/write/list (verify/atomic/binary)
│   ├── log-tools.ts            # ssh_log_tail/search
│   ├── snapshot-tool.ts        # ssh_snapshot
│   ├── monitoring-tool.ts      # ssh_monitor
│   ├── transfer-tool.ts        # ssh_upload, ssh_download (v1.3.0)
│   └── audit-tool.ts           # ssh_audit_baseline, ssh_tls_check,
│                               # ssh_disk_breakdown, ssh_service_status (v1.3.0)
└── utils/
    ├── logger.ts               # Logging
    ├── ssh-config.ts           # SSH configuration
    ├── profile-resolver.ts     # Load profiles
    ├── profiles-file.ts        # Parse profiles
    ├── path-validator.ts       # Path security
    ├── retry.ts                # Retry logic
    ├── sha256.ts               # Local + remote sha256 helpers (v1.3.0)
    └── tmp-name.ts             # Atomic temp / staging path generators (v1.3.0)
```

## 📝 Roadmap

### v1.0 (MVP) ✅
- ✅ 7 core commands
- ✅ Profiles from file
- ✅ Retry logic
- ✅ Security (warnings)

### v1.1 - v1.2.2 (Released) ✅
- ✅ Connection pooling (6-10× faster)
- ✅ Path security & tilde expansion
- ✅ Retry mechanism with exponential backoff
- ✅ Enhanced error messages
- ✅ Profile reload & monitoring
- ✅ Session-based metrics

### v1.3.0 (Released) ✅
- ✅ SFTP transfer tools — `ssh_upload`, `ssh_download` (binary-safe, atomic, sha256 verify)
- ✅ `ssh_file_write` / `ssh_file_read` extended with `verify`, `atomic`, `binary`
- ✅ Audit tools — `ssh_audit_baseline`, `ssh_tls_check`, `ssh_disk_breakdown`, `ssh_service_status`
- ✅ Tool count: 8 → 14

### v2.0.0 (in progress) 🚧
- ✅ Transport moved to the system OpenSSH client with connection multiplexing
- ✅ Malformed tool arguments are rejected before the first command runs
- ✅ Password profiles verified live: no secret in `ps`, none on disk, one prompt
      per `ControlPersist` window (requires a local OpenSSH client 8.4+)
- ✅ The sudo path is verified live on both BusyBox and coreutils servers
- 🚧 Default backend flip and removal of the bundled ssh2 backend

### Future (Planned)
- 📋 Recursive sudo upload (one-shot, without staging workaround)
- 📋 Extended snapshot (custom checks)
- 📋 Connection metrics dashboard

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 🔒 Security

### Path Handling & Quoting

SSH MCP Server uses a secure quoting strategy to prevent injection attacks:

**Single Quotes (default):**
- Used for regular paths without tilde
- Prevents ALL expansions (variables, commands, globs)
- Example: `cat '/etc/hosts'` - safest option

**Double Quotes (for tilde):**
- Used only when path contains `~` (expanded to `$HOME`)
- Everything except `$HOME` is escaped
- Prevents: variable expansion (`$VAR`), command substitution (`` `cmd` ``), history expansion (`!`)
- Example: `cat "$HOME/.bashrc"` - `$HOME` expands, but `$VAR` in filename won't

**What's Protected:**
- ✅ Command injection via `;`, `&&`, `||`
- ✅ Variable expansion (`$VAR`)
- ✅ Command substitution (`` `cmd` ``, `$(cmd)`)
- ✅ History expansion (`!`)
- ✅ Glob expansion (`*`, `?`)

**Tilde Expansion:**
- `~/file` → expanded on our side to the home directory reported by the SSH session
  (probed once per session, then cached) — the path reaches the server fully quoted
- `~user/file` → **rejected** with an explanation: writing to a guessed home directory is
  worse than refusing
- Under `sudo: true`, `~` still means the home of the **login** user, not root — the tool
  says so in its answer
- Works in: `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`,
  `ssh_log_search`, `ssh_upload`, `ssh_download`

### Path Security (Optional)

Add `pathSecurity` to profiles for additional protection:

```json
{
  "pathSecurity": {
    "allowedPaths": ["/home/admin", "/var/www"],
    "deniedPaths": ["/etc/shadow", "/root"],
    "allowTraversal": false,
    "maxPathLength": 1000
  }
}
```

See [Quick Start](#11-optional-path-security-configuration) for details.

## 📄 License

MIT License - Copyright (c) 2026 hypnosis

See [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for AI-powered development**
