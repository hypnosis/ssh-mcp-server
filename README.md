# SSH MCP Server

**Universal SSH MCP Server** for managing remote servers via AI assistants (Cursor, Claude Desktop).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

**GitHub:** [@hypnosis](https://github.com/hypnosis) | **License:** MIT | **npm:** [@hypnosis/ssh-mcp-server](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server)

> **⚠️ IMPORTANT for binaries and large files:** use `ssh_upload` / `ssh_download` (binary-safe, sha256 verify, atomic rename) — **NOT** base64 chunks through `ssh_exec`. Chunking pulls the whole file into the LLM context and leaves no end-to-end check that what arrived is what you sent. See [Transfer tools](#-transfer-tools-v130) and [docs/transfer.md](docs/transfer.md).

## ✨ Features

### 18 Powerful Commands:

**Core (8):**
1. **ssh_exec** - Universal command execution (single or batch)
2. **ssh_file_read** - Read files (single or multiple); `binary: true` for base64
3. **ssh_file_write** - Write files (single or multiple); `verify` / `atomic` / `binary`
4. **ssh_file_list** - List files in directory
5. **ssh_log_tail** - Last N lines from logs (single or multiple)
6. **ssh_log_search** - Search logs with grep (single or multiple)
7. **ssh_snapshot** - Instant system health check
8. **ssh_monitor** - Monitor connections, reload profiles, test connections, close a shared connection

**Background jobs — commands that outlive the call (4, v2.0.0+):**
9. **ssh_job_status** - Is it running, finished with an exit code, or lost
10. **ssh_job_output** - Output from a byte offset, so repeated reads never overlap
11. **ssh_job_list** - Jobs on the server, old finished ones cleaned up along the way
12. **ssh_job_kill** - Stop a job and its children

**Transfer — binary-safe (2, v1.3.0+):**
13. **ssh_upload** - Binary-safe file/directory upload (sha256 verify, atomic rename)
14. **ssh_download** - Binary-safe file/directory download (sha256 verify)

**Audit — read-only deep checks (4, v1.3.0+):**
15. **ssh_audit_baseline** - One-shot system audit (replaces 5+ ssh_exec calls)
16. **ssh_tls_check** - TLS expiry + SAN + issuer + Let's Encrypt renew_hook
17. **ssh_disk_breakdown** - df + top-N du + docker df + journald + caches
18. **ssh_service_status** - systemctl status + journalctl tail in one call

### Key Features:

- ✅ **REST approach** - arrays where logical
- ✅ **Security** - warnings for dangerous commands, path validation, safe quoting
- ✅ **Tilde expansion** - `~/file` automatically expands to `$HOME/file`
- ✅ **Path security** - optional whitelist/blacklist per profile
- ✅ **sudo support** - parameter in every command
- ✅ **Profiles** - multiple SSH configurations
- ✅ **Retry logic** - one retry after a transport failure, and only for commands that are safe to repeat
- ✅ **Connection reuse** - one shared, multiplexed OpenSSH connection per destination

## 📦 Installation

**What the machine needs:** Node.js 18+ and a system `ssh` client — commands and transfers
are delivered by it, nothing is bundled. Any OpenSSH will run; some features have their own
floor:

| From version | What it gives |
|---|---|
| 5.6 | Shared multiplexed connection (`ControlPersist`). Below this every command opens its own |
| 8.4 | Password and passphrase profiles (`SSH_ASKPASS_REQUIRE`). Key-based profiles do not need it |
| 9.0 | `scp` rides SFTP; older clients use the classic protocol, as do servers without an sftp subsystem |

`ssh_monitor({ action: "stats" })` reports the version it found and whether multiplexing works.

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

**A working directory the server cannot enter stops the call.** Nothing after the failed
`cd` runs — not the parts separated by `;`, not the rest of a batch — and the answer comes
back with a non-zero exit code. A typo in `cwd` can no longer send `rm -rf ./cache` into
your home directory and call it a success.

**Recursive deletes that would destroy the server are refused, not warned about.**

Nothing is sent to the server when a `rm -r` in the call targets:

- the filesystem root, the home directory, or a system tree (`/etc`, `/usr`, `/var`, `/home`, …);
- a path that only *reaches* one of them through a symlink — `rm -rf /var/www/data/`, where
  `data` links to `/`, empties the root on GNU coreutils;
- something the server expands itself (`$DIR`, `` `cmd` ``, `*`) — an empty variable turns
  `rm -rf "$DIR"/*` into wiping the root, and that cannot be checked in advance;
- anything the server cannot resolve, including a server with no `readlink`. Not knowing is
  a reason to ask, not a reason to delete.

The whole call stops, batch included: a half-executed batch leaves the server in an unknown state.
`rm -rf link` without a trailing slash removes the link itself and is allowed — that is ordinary
cleanup, measured on both BusyBox and coreutils.

To run such a command deliberately, append the marker to that specific command:

```typescript
ssh_exec({
  profile: "production",
  command: "rm -rf /var/lib/old-app # CONFIRMED-DESTRUCTIVE"
})
```

Other commands in the same batch are unaffected, and the marker stays in the server's shell
history as a record of a deliberate decision.

### Background jobs — a command that outlives the call (v2.0.0+)

A command that runs longer than the timeout used to be impossible: the client was killed and
you got a refusal, with the work neither finished nor reachable. Pass `detach: true` and the
command is started as a job on the server — the answer comes back with its id right away.

```typescript
// Starts and answers in under a second
ssh_exec({
  profile: "production",
  command: "apt-get -y dist-upgrade",
  detach: true
})
// → Job mst0f2q1-9ab3c4d5 started (pid 4242).

ssh_job_status({ profile: "production", id: "mst0f2q1-9ab3c4d5" })
ssh_job_output({ profile: "production", id: "mst0f2q1-9ab3c4d5", offset: 0 })
ssh_job_kill({ profile: "production", id: "mst0f2q1-9ab3c4d5" })
ssh_job_list({ profile: "production" })
```

The job keeps its state on the server — the command, its pid, when it started, its output and
its exit code live in `~/.ssh-mcp/jobs/<id>/`. Restarting this MCP server, or watching a job
from another window, changes nothing: nothing is remembered on our side.

**Three outcomes, kept apart.** `running` — no exit code and the process is alive. `finished` —
there is an exit code. `lost` — no exit code and no process: it was signalled or the server
restarted, and how far it got is unknown. The last one is not reported as success or as
failure, because it is neither.

**Reading output never overlaps.** `ssh_job_output` answers with the offset to continue from;
send it back on the next read and you get exactly what appeared since. The offset counts what
was actually read, so an answer cut off at the transport buffer does not skip the middle.

**Limits.** One command per job (arrays are refused), and `detach` cannot be combined with
`sudo` — a background job has nowhere to take a password from. Jobs that are no longer running
are cleaned up by `ssh_job_list` seven days after they started; running ones are never touched.

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

`ssh_file_write` is back-compat by default but now supports three new per-file flags. The route is chosen by size alone: content over 256KB travels through the transfer runner (`scp`, which rides SFTP on client 9.0+), smaller content goes through the command's stdin. The flags below do not change that.

| Flag | Default | What it does |
|------|---------|--------------|
| `verify` | `false` | Compute local sha256, compare against remote `sha256sum` (fallback `openssl dgst -sha256`) after write |
| `atomic` | `true` (ignored) | Always on: writes to `.upload-<rand>.<name>` next to the target, then `mv -T` into place |
| `binary` | `false` | `content` is base64; decoded and sent through the transfer runner. Use this for non-text payloads |

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

Reads through the transfer runner (`scp`, which rides SFTP on client 9.0+) and returns base64-encoded bytes, byte-for-byte safe (legacy `cat` over PTY corrupts binaries due to encoding/CR-LF translation).

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

// A busy log: at most 200 matches per file come back by default,
// and the answer says when it was cut
ssh_log_search({
  profile: "production",
  path: "/var/log/syslog",
  query: "error",
  maxMatches: 1000
})

// Multiple logs
ssh_log_search({
  profile: "production",
  path: [
    "/var/log/nginx/error.log",
    "/var/log/syslog"
  ],
  query: "500|502|503"
})
```

```typescript
// A glob pattern in the file name: the matching logs are read one by one
ssh_log_search({
  profile: "production",
  path: "/var/log/nginx/*.log",
  query: "error"
})
```

**About glob patterns:** the pattern is expanded by the server's `find`, not by its shell,
so a name with a space, `$(…)` or a newline stays a name. It is supported in the file name
only — `/var/*/app.log` is refused — and at most 50 matching files are read, with a note in
the answer when there were more. A path that exists under its own name (`a[1].log`) is read
as itself.

### ssh_snapshot - System Health Check

```typescript
// Full system snapshot
ssh_snapshot({
  profile: "production"
})

// Returns:
// - Hostname, uptime
// - Service status (nginx, docker, postgresql, etc)
// - Resources (CPU, Memory, Disk — one row per device, root included even on overlay)
// - Docker containers (if available)
// - Open ports and connections (IPv4 and IPv6 alike)
// - Recent errors from logs
//
// Anything the server could not answer says NOT CHECKED instead of showing as a zero:
// no systemctl, a systemd that does not answer, no ss/netstat, no readable syslog,
// a reading that never came back.
```

### ssh_monitor - Monitoring & Diagnostics

```typescript
// Get transport statistics
ssh_monitor({
  action: "stats"
})
// Returns: backend, whether multiplexing works, ssh version, whether the master
// connection is alive, and how many commands and transfers this session ran

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

// Close the shared connection now, without waiting for it to idle out
ssh_monitor({
  action: "close",
  profile: "production"
})
// Closes the connection of that profile and reports what is still left on
// this machine — connections of other profiles outlive both this call and
// the server itself
```

---

## 📦 Transfer tools (v1.3.0+)

Binary-safe transfer through the system `scp`, over the same multiplexed connection the other tools use. **Use these instead of base64 chunks through `ssh_exec`** — chunking a file through the command channel puts the whole payload into the LLM context and into Node memory, and every chunk is a place for the file to end up half-written with nothing checking it. `ssh_upload` streams from disk, renames into place, and compares sha256.

Every upload writes to a hidden temp file next to the target and renames it into place — this isn't a choice, it's built in (`atomic` is accepted but ignored, kept so existing calls don't break). Default: `verify=true` (local sha256 vs remote `sha256sum` / `openssl dgst -sha256` fallback).

**Servers without an sftp subsystem** (routers, embedded devices, dropbear) are handled automatically: on client 9.0+ `scp` rides SFTP, which such a server refuses, so the transfer falls back to the classic scp protocol once and remembers that destination. Nothing to configure. One limitation there: a remote path containing a newline is rejected instead of being sent — the classic protocol has no safe way to carry it.

**Which one to use:**
- Text you are composing right now (a config, a unit file) → `ssh_file_write`. Up to 256 KB it rides the command's stdin; above that the same tool switches to the transfer route by itself
- A file that already exists on disk, of any size, and anything binary → `ssh_upload` (streams from disk, never loads the content into LLM context)
- A directory → `ssh_upload`; `ssh_file_write` takes files, one by one

For full API and architecture see [docs/transfer.md](docs/transfer.md).

### ssh_upload — Binary-safe upload

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `local_path` | string | **required** | Local file or directory path |
| `remote_path` | string | **required** | Remote destination path |
| `mode` | string | — | Octal file mode, e.g. `"644"` |
| `recursive` | boolean | auto | Force directory mode (auto-detected via local `stat()`) |
| `atomic` | boolean | `true` (ignored) | Always on: writes to `.upload-<rand>.<name>` next to the target, then `mv -T` into place |
| `verify` | boolean | `true` | Compare local and remote sha256 after upload |
| `sudo` | boolean | `false` | Stage in `/tmp` under the SSH user, then `sudo cp` next to the target and rename into place |
| `owner` | string | — | When `sudo=true`: `"user:group"` applied with `chown` before the file takes the target path |
| `overwrite` | boolean | `true` | Allow overwriting an existing remote file |
| `concurrency` | number | — | Deprecated and ignored: `scp` has no chunk concurrency to tune |

```typescript
// 1) Single file with sha256 verify and atomic rename (defaults)
ssh_upload({
  profile: "production",
  local_path: "./build/app.tar.gz",
  remote_path: "/srv/releases/app-2026-05.tar.gz",
  mode: "644"
})
// scp → write to .upload-<rand>.<name> → sha256 verify → mv -T → chmod

// 2) Recursive directory upload (auto-detected from local stat)
ssh_upload({
  profile: "production",
  local_path: "./dist",
  remote_path: "/var/www/app/current",
  mode: "755"
})
// walks local tree, uploads to staging dir, mv -T into place

// 3) sudo write to /etc — staged in /tmp under the SSH user, then `sudo cp`
//    next to the target, chmod/chown, and rename into place
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
// Symlinks in recursive uploads arrive as copies: a link to a file becomes the
// file, a link to a directory becomes the directory with its contents.
// To keep links as links, tar -czf locally and upload the tarball.

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
| `concurrency` | number | — | Deprecated and ignored: `scp` has no chunk concurrency to tune |

```typescript
ssh_download({
  profile: "production",
  remote_path: "/var/backups/db",
  local_path: "./backups/db",
  recursive: true
})
```

---

## 🔍 Audit tools (v1.3.0+)

Specialized read-only audit primitives that collect evidence in **one round-trip each**. The big win is `ssh_audit_baseline`: **one call replaces 5+ separate ssh_exec invocations** (df, free, ss, docker ps, systemctl, sshd -T, ufw, …) — both the latency and the result-merging cost are gone.

For pipeline guidance and full section descriptions see [docs/audit.md](docs/audit.md).

### ssh_audit_baseline

One batched compound shell command, results split by sentinel markers, parsed into structured JSON + a CRITICAL/WARNING/OK shortlist. Replaces 5–10 separate `ssh_exec` calls (df, free, ss, docker, systemctl, sshd -T, ufw, apt …) with **one round-trip**.

Sections (toggle via `include`): `system, disk, mem, net, ssh, services, docker, firewall, updates`. All of them run by default, `ssh` included — a full audit that stays silent about password login is not a full audit. `include_sudo_sections` picks how the sshd settings are read, not whether they are read at all: as root they are readable without sudo.

| Flag | Default | Purpose |
|------|---------|---------|
| `include` | all sections | Restrict to subset, e.g. `["disk", "services"]` |
| `include_sudo_sections` | `false` | Reads the sshd settings under sudo (whole compound runs under sudo) |
| `compact` | `true` | Trim long sections (listeners, interfaces, docker rows) for smaller LLM payload |

Output format: human-readable summary (host header → CRITICAL/WARNING shortlist → disk table → listeners → sshd → services → docker → firewall → updates) followed by `--- raw JSON ---` and the full structured result. The same result also comes back as `structuredContent`, so a client does not have to cut the text apart.

Auto red-flag rules:
- **CRITICAL**: filesystem ≥ 90%, `PermitRootLogin yes`, `PasswordAuthentication yes` on port 22
- **WARNING**: filesystem 70–90%, exited containers, failed systemd units, reboot pending, > 50 upgradable packages
- **OK**: filesystem < 70% per mount, everything nominal
- **NOT CHECKED**: a section whose command could not run — no `ss`/`netstat`, no `df` output, no `systemctl`, a systemd that does not answer, no `apt` — is listed in `unavailable` and left out of the result, rather than reported as an empty — and therefore healthy-looking — one

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

- **UNKNOWN**: the certificate was never read (no `openssl`, connection refused, domain unreachable) — the reason is quoted, `not_after` and `san_includes_hostname` stay `null`, and no verdict about the certificate is issued
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

### Optional (Transport)
Commands are delivered by the system `ssh` client. The connection is shared through a control socket, so it outlives the server process on purpose — closing it would cut the channel of another window on the same machine.
- `SSH_MCP_CONTROL_PERSIST` - How long a connection stays alive after the last command, in whole seconds; `0` closes it immediately (default: `600`)
- `SSH_MCP_CONTROL_DIR` - Where control sockets live (default: `~/.ssh/ssh-mcp`)

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

# Optional - Transport
export SSH_MCP_CONTROL_PERSIST="600"

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
SSH MCP Server (stdio)
      ↓
MCP layer — one source for the tool list and the call routing
      ↓
18 Tools (exec, file, job, log, snapshot, monitor, transfer, audit)
      ↓                          ↘ Profile Resolver → ~/.cursor/ssh-profiles.json
SSH Executor (builds the command: sudo, cwd)
      ↓
SSH Runner (system ssh/scp, one multiplexed connection per destination)
      ↓
Remote Server(s)
```

### Key Principles:

- **Connection reuse** - one multiplexed connection per destination (ControlMaster), shared with every other process on the machine that uses the same control socket
- **Session-based metrics** - command and transfer counters live in this server process; the connection itself belongs to `ssh`
- **NO streaming** - snapshot results only
- **REST approach** - arrays where logical
- **Retry logic** - one retry for idempotent commands after a transport failure; a refused multiplexed session falls back to a connection of its own
- **Cancellation** - a cancelled call drops the local `ssh` client at once instead of sitting out the command's timeout. It does not stop a command already running on the server, and file transfers and `ssh_snapshot` do not take it at all: one has a window where stopping would leave the target empty, the other would answer with blanks instead of a refusal. Work that has to be stoppable is started with `detach: true` and stopped by `ssh_job_kill`
- **Background jobs** - a detached command keeps its whole state on the server, so nothing is remembered on our side and a restart of this server loses nothing

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
├── index.ts                    # Entry point: profiles, transport, shutdown
├── mcp-server.ts               # Tool list and call routing, built from one source
├── runner/                     # The transport: system ssh/scp and everything around them
│   ├── openssh-runner.ts       # Commands and transfers over the shared connection
│   ├── ssh-args.ts             # Command line for ssh/scp, control socket path
│   ├── process.ts              # Child process: timeout, cancellation, output limit
│   ├── error-classifier.ts     # Which failure this is: auth, host, mux, closed channel
│   ├── control-sockets.ts      # What is left running on this machine
│   └── passport.ts             # What the server has: bash, sha256sum, timeout
├── managers/
│   ├── ssh-executor.ts         # Builds the command (sudo, cwd) and hands it to the runner
│   ├── installer.ts            # The only path that puts data onto the target
│   ├── path-guard.ts           # Tilde expansion + profile path rules
│   └── remote-verify.ts        # sha256 of what landed on the server
├── tools/
│   ├── exec-tool.ts            # ssh_exec
│   ├── file-tools.ts           # ssh_file_read/write/list (verify/atomic/binary)
│   ├── log-tools.ts            # ssh_log_tail/search
│   ├── snapshot-tool.ts        # ssh_snapshot
│   ├── monitoring-tool.ts      # ssh_monitor
│   ├── transfer-tool.ts        # ssh_upload, ssh_download
│   ├── audit-tool.ts           # ssh_audit_baseline, ssh_tls_check,
│   │                           # ssh_disk_breakdown, ssh_service_status
│   └── audit-output.ts         # audit result types + their output schemas
└── utils/
    ├── logger.ts               # Logging
    ├── ssh-config.ts           # SSH configuration
    ├── profile-resolver.ts     # Load profiles
    ├── profiles-file.ts        # Parse profiles
    ├── path-validator.ts       # Path security
    ├── df-table.ts             # Parsing the df table by name, not by column number
    ├── output-notes.ts         # Notes about an answer that is not the whole answer
    ├── tool-result.ts          # The one place a failed answer is built (isError)
    ├── sha256.ts               # Local + remote sha256 helpers
    └── tmp-name.ts             # Atomic temp / staging path generators
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
- ✅ Transfer tools — `ssh_upload`, `ssh_download` (binary-safe, atomic, sha256 verify)
- ✅ `ssh_file_write` / `ssh_file_read` extended with `verify`, `atomic`, `binary`
- ✅ Audit tools — `ssh_audit_baseline`, `ssh_tls_check`, `ssh_disk_breakdown`, `ssh_service_status`
- ✅ Tool count: 8 → 14

### v2.0.0 (in progress) 🚧
- ✅ Transport moved to the system OpenSSH client with connection multiplexing
- ✅ Malformed tool arguments are rejected before the first command runs
- ✅ Password profiles verified live: no secret in `ps`, none on disk, one prompt
      per `ControlPersist` window (requires a local OpenSSH client 8.4+)
- ✅ The sudo path is verified live on both BusyBox and coreutils servers
- ✅ The system OpenSSH client is the only transport; the bundled ssh2 backend is gone
- ✅ Answers keep three outcomes apart — done, not done, nothing to check with — instead of
      printing an empty reading as a fact
- ✅ A timeout is answered in the time it names, and `ssh_log_search` has a limit
      (`maxMatches`) with an honest note when the output was cut
- ✅ Glob patterns work in `ssh_log_tail` and `ssh_log_search`: expanded by name on the
      server, so odd file names stay names
- ✅ A failed call is marked as failed (`isError`), and a command killed by its timeout
      still hands over what it managed to print. A refused destructive command and a batch
      where nothing succeeded are failures too — the header counts what worked
      (`Read 0/2 files`), not what was attempted
- ✅ MCP SDK 0.6.1 → 1.30: the server answers each client with the protocol revision that
      client asked for, and the audit tools return their result already parsed
      (`structuredContent`) next to the unchanged text
- ✅ A cancelled call drops the local `ssh` client at once instead of sitting out the
      command's timeout (it does not stop a command already running on the server)

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

**Single Quotes:**
- Used for every path, including paths that contain `~`
- Prevents ALL expansions (variables, commands, globs)
- Example: `cat '/etc/hosts'` - safest option

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
    "maxPathLength": 1000
  }
}
```

See [Quick Start](#11-optional-path-security-configuration) for details.

**How a path is judged.** Rules are never matched against the string you passed. The path is
first brought to a canonical form — a leading `~` and relative paths are expanded against the
server's home directory, `..`, `.` and doubled slashes are folded — and only then compared, by
directory boundary: `/root` denies `/root/secret` but not `/rootkit`. A `~` further down the
path is an ordinary file name and is treated as one.

Symlinks are followed too: the server is asked where the path really leads, and the rule is
applied to both the name and the target. A link inside an allowed directory that points at a
denied one is rejected. This costs one extra round trip per path, and only for profiles that
actually define rules — without `pathSecurity` nothing is asked.

Two limits worth knowing:

- If the server cannot resolve the path (no `readlink`), the operation still runs, checked by
  name alone, and says so in its answer. A router that cannot resolve links is not a reason to
  refuse work.
- Rules cover file and log tools. `ssh_exec` runs arbitrary commands, and a command is not a
  path — restrict those with the account's own permissions on the server.

## 📄 License

MIT License - Copyright (c) 2026 hypnosis

See [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for AI-powered development**
