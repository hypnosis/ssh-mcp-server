# SSH MCP Server

**Universal SSH MCP Server** for managing remote servers via AI assistants (Cursor, Claude Desktop).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**Author:** Danila Susak | **GitHub:** [@hypnosis](https://github.com/hypnosis) | **License:** MIT

## ✨ Features

### 7 Powerful Commands:

1. **ssh_exec** - Universal command execution (single or batch)
2. **ssh_file_read** - Read files (single or multiple)
3. **ssh_file_write** - Write files (single or multiple)
4. **ssh_file_list** - List files in directory
5. **ssh_log_tail** - Last N lines from logs (single or multiple)
6. **ssh_log_search** - Search logs with grep (single or multiple)
7. **ssh_snapshot** - Instant system health check

### Key Features:

- ✅ **REST approach** - arrays where logical
- ✅ **Security** - warnings for dangerous commands
- ✅ **sudo support** - parameter in every command
- ✅ **Profiles** - multiple SSH configurations
- ✅ **Retry logic** - automatic retries on network errors

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
      "privateKeyPath": "~/.ssh/id_rsa"
    },
    "staging": {
      "host": "staging.example.com",
      "username": "deploy",
      "port": 22,
      "privateKeyPath": "~/.ssh/id_rsa"
    }
  }
}
```

**Note:** You can use the same profiles file as Docker MCP Server. SSH MCP will automatically skip profiles with `mode: "local"` and use profiles with `host` and `username`.

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

```typescript
// Single command
ssh_exec({
  profile: "production",
  command: "systemctl status nginx"
})

// Batch commands
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

```typescript
// Single file
ssh_file_read({
  profile: "production",
  path: "/etc/nginx/nginx.conf"
})

// Multiple files
ssh_file_read({
  profile: "production",
  path: [
    "/etc/nginx/nginx.conf",
    "/var/www/app/.env",
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

```typescript
// Single log
ssh_log_tail({
  profile: "production",
  path: "/var/log/nginx/error.log",
  lines: 100
})

// Multiple logs
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
Profile Resolver → ~/.cursor/docker-profiles.json
      ↓
SSH Executor (new connection each time)
      ↓
7 Tools (exec, file, log, snapshot)
      ↓
Remote Server(s)
```

### Key Principles:

- **NO connection pool** - new connection for each command
- **NO streaming** - snapshot results only
- **REST approach** - arrays where logical
- **Retry logic** - automatic retries

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

## 👨‍💻 Author

**Danila Susak** - [GitHub](https://github.com/hypnosis)

## 📄 License

MIT License - Copyright (c) 2026 Danila Susak

See [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for AI-powered development**
