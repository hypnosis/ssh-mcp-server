# SSH MCP Server

**Universal SSH MCP Server** for managing remote servers via AI assistants (Cursor, Claude Desktop).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**Author:** Danila Susak | **GitHub:** [@hypnosis](https://github.com/hypnosis) | **License:** MIT

## ✨ Features

### 8 Powerful Commands:

1. **ssh_exec** - Universal command execution (single or batch)
2. **ssh_file_read** - Read files (single or multiple)
3. **ssh_file_write** - Write files (single or multiple)
4. **ssh_file_list** - List files in directory
5. **ssh_log_tail** - Last N lines from logs (single or multiple)
6. **ssh_log_search** - Search logs with grep (single or multiple)
7. **ssh_snapshot** - Instant system health check
8. **ssh_monitor** - Monitor connections, reload profiles, test connections

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
npm install -g @hypnosis/ssh-mcp-server
```

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
- These rules apply to: `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`, `ssh_log_search`
- Tilde (`~`) paths are supported and automatically expanded to `$HOME`

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

## 🔧 Environment Variables

### Required
- `SSH_PROFILES_FILE` - Path to SSH profiles JSON file

### Optional (Logging)
- `SSH_MCP_LOG_LEVEL` - Log level: `debug`, `info`, `warn`, `error` (default: `info`)
- `SSH_MCP_LOG_TIMESTAMP` - Show timestamps in logs: `true`, `false` (default: `true`)
- `SSH_MCP_LOG_COLORS` - Enable colors in logs: `true`, `false` (default: `false`)

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
8 Tools (exec, file, log, snapshot, monitor)
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
│   └── ssh-executor.ts         # SSH commands (no pool)
├── tools/
│   ├── exec-tool.ts           # ssh_exec
│   ├── file-tools.ts          # file read/write/list
│   ├── log-tools.ts           # log tail/search
│   └── snapshot-tool.ts       # system health
└── utils/
    ├── logger.ts              # Logging
    ├── ssh-config.ts          # SSH configuration
    ├── profile-resolver.ts    # Load profiles
    ├── profiles-file.ts       # Parse profiles
    └── retry.ts               # Retry logic
```

## 📝 Roadmap

### v1.0 (MVP) ✅
- ✅ 7 core commands
- ✅ Profiles from file
- ✅ Retry logic
- ✅ Security (warnings)

### v1.1 (Planned)
- 📋 SFTP file upload/download
- 📋 Connection caching (optional)
- 📋 Extended snapshot (custom checks)

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
- `~/file` → `$HOME/file` (automatic)
- `~user/file` → shell expands `~user` (automatic)
- Works in: `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`, `ssh_log_search`

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

## 👨‍💻 Author

**Danila Susak** - [GitHub](https://github.com/hypnosis)

## 📄 License

MIT License - Copyright (c) 2026 Danila Susak

See [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for AI-powered development**
