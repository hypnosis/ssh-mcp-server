# Tool Reference

Full usage reference for all 18 tools. The README gives a one-line-per-tool
overview and the two most important warnings (binary transfer, destructive
commands) — this file has the parameter tables and worked examples.

## Contents

- [`ssh_exec`](#ssh_exec---execute-commands)
- [Background jobs (detach)](#background-jobs--a-command-that-outlives-the-call-v200)
- [`ssh_file_read`](#ssh_file_read---read-files)
- [`ssh_file_write`](#ssh_file_write---write-files)
- [`ssh_file_list`](#ssh_file_list---list-files)
- [`ssh_log_tail`](#ssh_log_tail---last-log-lines)
- [`ssh_log_search`](#ssh_log_search---search-logs)
- [`ssh_snapshot`](#ssh_snapshot---system-health-check)
- [`ssh_monitor`](#ssh_monitor---monitoring--diagnostics)
- [Transfer tools](#transfer-tools-v130)
- [Audit tools](#audit-tools-v130)

## `ssh_exec` - Execute Commands

**⚠️ Important: Array Syntax**

For batch commands, use **double quotes** in JSON format:
- ✅ Correct: `command: ["cmd1", "cmd2"]`
- ❌ Incorrect: `command: ['cmd1', 'cmd2']`

MCP tools require valid JSON syntax. Single quotes will cause errors. Same rule
applies to `ssh_file_read`, `ssh_log_tail` and `ssh_log_search` — see
[array-validator.md](array-validator.md) (Russian) for the full validation logic and
error format.

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

See [docs/security.md](security.md) for the full refusal/warning threshold and what the guard
does not see.

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

### `ssh_file_read` - Read Files

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

### `ssh_file_write` - Write Files

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
|------|---------|---------------|
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

#### v1.3.0+ `ssh_file_read` — `binary: true`

Reads through the transfer runner (`scp`, which rides SFTP on client 9.0+) and returns base64-encoded bytes, byte-for-byte safe (legacy `cat` over PTY corrupts binaries due to encoding/CR-LF translation).

```typescript
ssh_file_read({
  profile: "production",
  path: "/etc/ssl/certs/app.crt",
  binary: true   // returns base64
})
```

### `ssh_file_list` - List Files

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

### `ssh_log_tail` - Last Log Lines

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

### `ssh_log_search` - Search Logs

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

### `ssh_snapshot` - System Health Check

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

### `ssh_monitor` - Monitoring & Diagnostics

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

## Transfer tools (v1.3.0+)

Binary-safe upload/download through the system `scp`, over the same multiplexed connection
the other tools use. The full parameter tables, architecture and recipes already live in
[docs/transfer.md](transfer.md) — the README's own Transfer tools section duplicated that
file almost line for line, so it is not repeated here. One example from the README is not
in transfer.md's recipes and is kept below.

```typescript
// Recursive directory download
ssh_download({
  profile: "production",
  remote_path: "/var/backups/db",
  local_path: "./backups/db",
  recursive: true
})
```

## Audit tools (v1.3.0+)

Specialized read-only audit primitives that collect evidence in one round-trip each:
`ssh_audit_baseline`, `ssh_tls_check`, `ssh_disk_breakdown`, `ssh_service_status`. The
per-tool command tables, red-flag rules, and the recommended audit pipeline already live in
[docs/audit.md](audit.md) — the README's own Audit tools section duplicated that file, so it
is not repeated here.
