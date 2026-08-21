# Tool Reference

Full usage reference for all 18 tools. The README gives a one-line-per-tool
overview and the two most important warnings (binary transfer, destructive
commands) — this file has the parameter tables and worked examples.

**`profile` is required on every tool that touches a server.** Profiles are separate
machines and none is assumed for you; a call without one is refused and the refusal lists
the names to choose from. Where the profiles and their secrets live, and what makes a
profile broken, is in [security.md](security.md#profiles-the-machine-is-always-named).

## Safer SSH work through MCP

The specialised tools make routine SSH work safer and easier to inspect than arbitrary
shell commands: they return structured results, keep related work in one call, and make
the boundary between reading, writing, transfer, and audit explicit. Use `ssh_exec` when
there is no fitting tool, not as the default for work the server already understands.

## Common SSH and audit tasks

- Check a server first: `ssh_audit_baseline`; follow a disk, TLS, or service finding with
  `ssh_disk_breakdown`, `ssh_tls_check`, or `ssh_service_status`.
- Inspect files and logs: `ssh_file_read`, `ssh_file_list`, `ssh_log_tail`, and
  `ssh_log_search`.
- Move or update files: `ssh_upload`, `ssh_download`, and `ssh_file_write`.
- Run work that outlives a call: `ssh_exec` with `detach: true`, then
  `ssh_job_status`, `ssh_job_output`, `ssh_job_list`, or `ssh_job_kill`.

## What the server says before the first call

On connect the server hands the client a map of the toolset, and the client puts it in the
model's system prompt. It is not a description of the server: it says what each tool does
that `ssh_exec` cannot — a round trip saved, an answer parsed, a write verified against
sha256, a measurement marked as missing instead of returned as a blank. A model that sees
only a list of eighteen names reaches for the one tool that runs anything, and loses all of
that without noticing.

Every tool is named in that map. A tool missing from it is a tool the model will not
choose, so the map is checked against the declared list by a test rather than kept in step
by hand.

## What each tool declares about itself

Every tool carries the standard MCP annotations, so a client knows what a call does before
it makes it — and can ask you first when it matters. `openWorldHint` is true wherever a
remote machine answers: which one depends on the profile.

| Tool | Reads only | May change or remove state | Same call twice is safe |
|---|---|---|---|
| `ssh_audit_baseline` | yes | — | — |
| `ssh_disk_breakdown` | yes | — | — |
| `ssh_file_list` | yes | — | — |
| `ssh_file_read` | yes | — | — |
| `ssh_job_list` | yes | — | — |
| `ssh_job_output` | yes | — | — |
| `ssh_job_status` | yes | — | — |
| `ssh_log_search` | yes | — | — |
| `ssh_log_tail` | yes | — | — |
| `ssh_service_status` | yes | — | — |
| `ssh_snapshot` | yes | — | — |
| `ssh_tls_check` | yes | — | — |
| `ssh_download` | no | yes | yes |
| `ssh_file_write` | no | yes | yes |
| `ssh_job_kill` | no | yes | yes |
| `ssh_upload` | no | yes | yes |
| `ssh_exec` | no | yes | **no** |
| `ssh_monitor` | no | no | yes |

Here, “may change or remove state” includes writing a local or remote file and stopping a
process; it does not mean that every call destroys data. `ssh_exec` is the one tool whose
effect cannot be known in advance: it runs whatever it is handed, so it promises nothing
about a repeat. `ssh_download` writes to your own disk rather than the server's.
`ssh_monitor` touches neither — only the connection this process holds, which is why it is
the only tool with `openWorldHint` false.

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
  - [`ssh_audit_baseline`](#ssh_audit_baseline)
  - [`ssh_tls_check`](#ssh_tls_check)
  - [`ssh_disk_breakdown`](#ssh_disk_breakdown)
  - [`ssh_service_status`](#ssh_service_status)

## `ssh_exec` - Execute Commands

**When to reach for it.** When nothing else fits: a package manager, a migration, a
one-off script. Everything with a tool of its own — files, logs, transfers, health, jobs —
costs more here, because you get back text you then have to parse, and one round trip per
thing you asked about.

**Handy.** A list of commands travels in one call, and a non-zero exit does not stop the
rest of the list. `cwd` applies to every one of them.

**Trap.** Each command in a list runs in its own shell: no variable and no `cd` survives
into the next one. `timeout` is per command, not for the list, and a job measured in
minutes wants `detach` rather than a larger number.

**What comes back.** Every command carries its own `stdout` and `stderr`. An empty string
means it ran and printed nothing; a command that never ran has no such field, so silence
and absence cannot be confused. Past 128 KB per command both ends are kept with a seam
between them, and `clipped_bytes` names how much of the middle went — separately from
`truncated`, which is about the transport buffer, not the field.


**⚠️ Important: Array Syntax**

For batch commands, use **double quotes** in JSON format:
- ✅ Correct: `command: ["cmd1", "cmd2"]`
- ❌ Incorrect: `command: ['cmd1', 'cmd2']`

MCP tools require valid JSON syntax. Single quotes will cause errors. The same rule applies
to `ssh_file_read`, `ssh_log_tail` and `ssh_log_search`: each of them takes either one
string or an array of them, a value of any other shape is refused by name before the call
leaves, and an empty array is refused rather than treated as "nothing to do".

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

**Why not plain `ssh_exec`.** The usual workaround — `nohup … > /tmp/out &`, wait, then
`cat /tmp/out` — leaves a file nobody owns, gives no exit code and no way to tell "still
running" from "died quietly". A detached job has an id, a state and an output cursor.

**Handy.** `ssh_job_output` answers with the next offset, so repeated reads never overlap
or skip a byte. `ssh_job_list` finds jobs when the id was not kept. `ssh_job_kill` reaches
the whole process group, and a job already gone is reported rather than refused.

**Trap.** `lost` is not `done`: the exit code is gone, but what the job wrote is still
readable through `ssh_job_output`. Detach takes one command, and with `sudo` the whole
protocol goes as root — the id says so, nothing extra is passed.


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

**A job under root stays under root.** `detach` and `sudo` go together: the job runs as root,
and its id carries that, so `ssh_job_status`, `ssh_job_output`, `ssh_job_kill` and `ssh_job_list`
reach it as root by themselves. Without that they would call a root job lost and fail to stop it —
the process is not theirs to signal. What `sudo` still needs is something to answer with: a
password in the profile, or a `sudoers` line that asks for none. A key-only profile whose `sudo`
demands a password gets a refusal saying exactly that, and no job is started.

**Limits.** One command per job (arrays are refused). Jobs that are no longer running
are cleaned up by `ssh_job_list` seven days after they started; running ones are never touched.

### `ssh_file_read` - Read Files

**Why not `ssh_exec` + `cat`.** A list of paths is one call instead of one per file, and
an unreadable file costs the list nothing — the others still come back, and the one that
failed is named. Measured on the lab: five config files cost ≈483 tokens through `cat`
and ≈253 through this tool.

**Handy.** `sudo` per call for files the profile user cannot open; `binary: true` moves
the read off the command channel entirely.

**Trap.** A file too large or not text comes back as a named failure, never as a partial
file — a truncated config is worse than no config. `encoding: base64` still travels
through the command channel and its size limit; real binary wants `binary: true`.


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

**Why not `ssh_exec` + `cat > file`.** The write lands beside its target under a temporary
name and moves into place with one rename, so a whole copy exists at every moment. With
`verify` the sha256 is compared afterwards, which a heredoc cannot do.

**Handy.** `mode` and `sudo` are decided per file, not per call, so one call can drop a
config into `/etc` as root and a script into a home directory as the profile user.

**Trap.** `verified: "unavailable"` means the machine has no `sha256sum` — the file was
delivered, not damaged. Treating it as a failure is how a good write gets rolled back.
Local files and directories belong to `ssh_upload`.


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

**Why not `ssh_exec` + `ls`.** Names, sizes, modes, owner and mtime come back as fields
instead of a column layout that changes between BusyBox and coreutils.

**Handy.** `pattern` is matched on the machine, so a wide directory is filtered before it
travels. `recursive` walks the tree, and a tree too deep is cut at the output limit and
says so rather than ending mid-way in silence.


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

**Why not `ssh_exec` + `tail`.** A list of files, or a glob, is one call; file size does
not matter because only the tail is read.

**Handy.** The glob is expanded by the server's `find`, not by a shell, so a name with a
space or a newline stays one name.

**Trap.** A glob is allowed in the file name, not in the directory part. Looking for
something specific is `ssh_log_search`, which filters on the machine instead of shipping
the tail to you first.


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

**Why not `ssh_exec` + `grep`.** One call covers a list, a glob or a whole tree, and the
answer separates three outcomes that `grep` merges into an empty output: nothing matched,
nothing was read, and the file could not be opened at all. Measured on the lab: four logs
cost ≈402 tokens through `grep` and ≈159 here.

**Handy.** `since` takes the day from the server rather than from your clock. `namesOnly`
answers with paths alone — the cheapest way to find out where to look. `from` decides
which end `maxMatches` keeps, and `start` stops reading at the cap instead of scanning a
multi-gigabyte file to its end.

**Trap.** A directory closed by permissions is not silence: it arrives in
`files_unreadable`, and that is the signal to retry with `sudo: true`. Under a day, `since`
filters files rather than lines; a file with undated lines is searched whole and named as
such.

**What comes back.** The matched lines themselves, as `lines`: `{file, line, text,
context}`. `context: true` marks a neighbour brought in by the `context` option rather than
a match of its own — quoting one as a find would be quoting a line that does not answer the
query.


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

**Why not six commands.** One call answers cpu, memory, disk, containers, ports, services
and recent errors, already classified.

**Trap that this tool exists to avoid.** What could not be measured comes back as `null`
with a note in `unavailable` — never as `0`. A device whose shell answers nothing used to
read as a healthy machine with no load and no connections; a zero you did not measure is
worse than a gap you did.

**What comes back.** Besides the counters, the sections behind them: `listening`,
`services`, `containers_running` and `error_lines`. Each is `null` exactly where its
counter is `null`, for the same reason.


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

**Start here on a machine you have not touched.** `action: "test"` names the state before
anything else runs: `ready`, `limited` (a shell that answers, but not with a POSIX
toolset), `no-route`, `rejected`. `action: "list"` names the profiles you may name — it is
the answer to "which machines do I have", and no secret is ever part of it.

**Handy.** `stats` shows what the multiplexed connection is doing, `close` drops it, and
`reload` re-reads the profiles file without restarting the server.

**What comes back from `list`.** `profiles` — the names themselves — and `broken`: entries
the profiles file has but the server cannot use, each with the reason. A machine missing
from both lists is a machine you cannot name.


Every action except `list` and `reload` names its profile: profiles are different
machines, and none is assumed on your behalf. Ask without a name and the answer lists
the names to choose from.

```typescript
// Get transport statistics
ssh_monitor({
  action: "stats",
  profile: "production"
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
// Names the state first, then the timings

// List available profiles
ssh_monitor({
  action: "list"
})
// Shows every loaded profile, plus the broken ones with the reason

// Close the shared connection now, without waiting for it to idle out
ssh_monitor({
  action: "close",
  profile: "production"
})
// Closes the connection of that profile and reports what is still left on
// this machine — connections of other profiles outlive both this call and
// the server itself
```

**What `test` answers.** The first word is the state, so the line alone is enough to act
on:

| State | What it means | What to do |
|---|---|---|
| `✅ ready` | Logged in, POSIX commands run | Nothing |
| `⚠️ limited` | Logged in, but the shell is the device's own CLI — the probe `true` is unknown there | Use `ssh_exec` with the vendor's commands; file tools and `ssh_audit_baseline` do not apply |
| `❌ no-route` | The server was never reached | Check network, host and port — credentials are not the problem |
| `❌ rejected` | Reached and refused the login | Check user, key or password and known hosts — the network is fine |

Only `no-route` and `rejected` are reported as errors. `limited` is a working connection:
routers and appliances answer that way, and calling it a failure would send you fixing
nothing.

---

## Transfer tools (v1.3.0+)

Binary-safe upload/download through the system `scp`, over the same multiplexed connection
the other tools use. The full parameter tables, architecture and recipes live in
[docs/transfer.md](transfer.md); what follows is what these two tools do that a command
cannot.

**Why not base64 through `ssh_exec`.** The command channel has a size limit, and a base64
blob that hits it is cut without a word — you get a file that looks written and is not.
These tools move the bytes over the transport instead, verify sha256 on both sides per
file, and put the result in place with one rename.

**`ssh_upload` — handy.** `mode` and `owner` apply to every file sent, a directory is
recognised without `recursive`, and `sudo` stages the data in `/tmp` before moving it into
`/etc` or `/opt`. `overwrite: false` refuses rather than replaces — including when the
target cannot be checked at all, which is the case worth having it for.

**`ssh_upload` — traps.** A sent directory becomes the remote path itself and replaces it
whole, not file by file. Staging under `sudo` means the machine needs room for a second
copy. `owner` needs `sudo`; without it the answer says it was not applied rather than
pretending it was.

**`ssh_download` — handy.** Fetches a file or a whole directory to local disk with the same
sha256 check. `sudo` stages a root-owned copy in `/tmp`, fetches it and removes it.

**`ssh_download` — trap.** Reading a file to look at it is `ssh_file_read`; downloading it
first only to open it locally costs a write to your disk for nothing.

**Both — the answer to read.** `verified: "unavailable"` means the machine has no
`sha256sum`. That is a delivery nobody could check, not a corrupt one, and it is reported
apart from a real mismatch on purpose: a mismatch is what makes the installer remove what
it just wrote.

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

Four read-only tools that collect evidence in one round trip each. The command tables,
red-flag rules and the recommended pipeline live in [docs/audit.md](audit.md); what follows
is what each one is for and where its answer is easy to misread.

These are the tools that cost *more* tokens than the equivalent hand-written commands,
because they come back with more: every section classified, and the sections nobody could
measure named as such. What they save is round trips and the reading you would otherwise do
yourself.

### `ssh_audit_baseline`

How a machine is set up, not how it is doing right now: sshd, firewall, updates, services,
docker, ports, disk, each marked CRITICAL, WARNING or OK.

**Handy.** `include` picks sections, so a second look at one area does not re-run
everything. `compact: true` (the default) trims the long sections; `false` returns them
whole and the answer grows a lot.

**Trap.** `include_sudo_sections: true` reads the sshd config the way sshd itself sees it
(`sshd -T`). Without it the ssh section says it could not read the effective config rather
than guessing from the file on disk — a guess that goes wrong wherever an include or a
`Match` block is in play.

### `ssh_tls_check`

The certificate a domain actually serves, from a handshake made *on the server* — which is
the point: it sees what that machine sees, including a certificate only reachable from
inside.

**Handy.** Days left, SAN match and issuer come back as fields; the renewal hook is looked
for as well.

**Trap.** `null` means the value could not be read, not zero days. And "no hook configured"
without `sudo: true` only means nobody was allowed to look.

### `ssh_disk_breakdown`

Where the disk went: `df`, the largest directories per path, docker, journald and caches.

**Handy.** Naming the suspect in `paths` beats walking the whole filesystem, and `top_n`
decides how many entries come back per path.

**Trap.** A directory the profile user cannot enter is left out of the sizes, and a list of
"largest directories" that is short by exactly the one filling the disk is worse than no
list. Those directories are named in `unreadable`, and that is the signal to retry with
`sudo: true` — which also makes the cache section read root's home rather than the profile
user's. A path that simply does not exist is not listed there: an unmatched pattern is
absence, not a refusal.

### `ssh_service_status`

One systemd unit: its state plus the tail of its journal.

**Handy.** `since` takes a journalctl window (`"1h ago"`, `"today"`, a date), `log_lines`
decides how much of the journal comes back.

**Trap.** A machine without systemd answers `no_systemd` and leaves the state `null`. It is
never reported as stopped — "we did not check" and "it is down" lead to opposite actions.
Without `sudo: true` the journal arrives trimmed to what the profile user may see, which
reads as a quiet service.
