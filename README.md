# SSH MCP Server — Remote server tools for AI agents

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hypnosis/ssh-mcp-server/main/assets/icon-dark-128.png">
  <img src="https://raw.githubusercontent.com/hypnosis/ssh-mcp-server/main/assets/icon-128.png" align="left" width="72" hspace="12" alt="SSH MCP Server">
</picture>

**An SSH MCP server — a Swiss army knife that saves you and your AI agent time and tokens on debugging, development and server maintenance.** Run commands, move files, read logs and audit machines over SSH — a cloud VPS, a bare-metal box, or the BusyBox router sitting in your closet.<br clear="left">

It uses the OpenSSH client already on your machine: your keys, your `~/.ssh/config`, your jump hosts, your agent forwarding. Nothing bundled, nothing to compile, no native bindings.

Works with Claude Code, Codex CLI, opencode, Gemini CLI, Qwen Code, Hermes and other MCP clients.

[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dio.github.hypnosis%2Fssh-mcp-server%26version%3Dlatest&query=%24.servers%5B0%5D.server.version&style=flat-square&logo=modelcontextprotocol&logoColor=white&label=MCP%20Registry&color=0F172A)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.hypnosis/ssh-mcp-server&version=latest) [![Glama](https://glama.ai/mcp/servers/hypnosis/ssh-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/hypnosis/ssh-mcp-server) [![npm downloads](https://img.shields.io/npm/dm/@hypnosis/ssh-mcp-server?style=flat-square&logo=npm&logoColor=white&color=2EA043&label=downloads)](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server) [![tests](https://img.shields.io/github/actions/workflow/status/hypnosis/ssh-mcp-server/test.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=tests)](https://github.com/hypnosis/ssh-mcp-server/actions/workflows/test.yml)

**[Install](#install-in-30-seconds) · [Tools](#ssh-mcp-tools-for-server-operations) · [Setup](#set-up-the-ssh-mcp-server) · [Security](#destructive-command-protection-for-ai-agents) · [Roadmap](#ssh-mcp-server-roadmap) · [Docs](docs/tools.md) · [Changelog](CHANGELOG.md)**

---

## Install in 30 seconds

No global installation required. `npx` downloads the package on first use:

```bash
npx -y @hypnosis/ssh-mcp-server
```

Add it to **Claude Code** for every project:

```bash
claude mcp add ssh -s user \
  -e SSH_PROFILES_FILE="$HOME/.claude/ssh-profiles.json" \
  -- npx -y @hypnosis/ssh-mcp-server
```

Then create `~/.claude/ssh-profiles.json` with at least one machine:

```json
{
  "profiles": {
    "production": {
      "host": "server.example.com",
      "username": "admin",
      "privateKeyPath": "~/.ssh/your_private_key"
    }
  }
}
```

That is enough to connect.

Codex, opencode, Qwen Code and other clients are covered in
[Set up the SSH MCP server](#set-up-the-ssh-mcp-server).

### Requirements

**Node.js 18+** and a system `ssh` client on `PATH`. On Windows, use a key-based profile;
password and passphrase profiles are not currently available.

[![npm version](https://img.shields.io/npm/v/@hypnosis/ssh-mcp-server?style=flat-square&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server) [![Node.js](https://img.shields.io/node/v/@hypnosis/ssh-mcp-server?style=flat-square&logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org/) [![TypeScript](https://img.shields.io/npm/dependency-version/@hypnosis/ssh-mcp-server/dev/typescript?style=flat-square&logo=typescript&logoColor=white&color=3178C6&label=typescript)](https://www.typescriptlang.org/) [![MCP SDK](https://img.shields.io/npm/dependency-version/@hypnosis/ssh-mcp-server/@modelcontextprotocol/sdk?style=flat-square&logo=modelcontextprotocol&logoColor=white&color=0F172A&label=MCP%20SDK)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/npm/l/@hypnosis/ssh-mcp-server?style=flat-square&color=2563EB)](LICENSE)

Prefer a pinned version, offline work, or one less registry check per launch:
`npm install -g @hypnosis/ssh-mcp-server`, then use `ssh-mcp-server` as the command instead
of `npx`.

## Who this is for

- **DevOps and SREs** who want faster audits, incident checks and routine server work.
- **Vibe coders and indie builders** who ship with an AI assistant and run what they build
  on their own servers.
- **Sysadmins and platform engineers** who want structured tools instead of an unrestricted
  raw shell.
- **Developers and small teams running their own VPS** without a dedicated operations team.
- **Homelab, NAS and router owners** whose useful hardware has outlived its modern protocols.

## Why an SSH MCP server instead of a raw shell

### Fewer tokens, lower AI costs

A raw shell gives an AI agent a firehose: repeated commands, ASCII tables and log dumps.
It burns tokens turning that noise into a picture of the server — your money.

### Faster server debugging

Purpose-built tools batch routine checks, cap noisy output and return the part that matters.
The agent spends less time translating terminal output and gets to the fix sooner.

### Less guesswork, fewer AI mistakes

Structured answers say what was found, what could not be measured and what was truncated.
That leaves the agent less room to fill gaps with a hallucination — and gives you fewer bad
fixes, calmer deploys and more reliable code.

## SSH compatibility: modern servers, legacy gear and Windows

### Use your existing OpenSSH setup

No bundled SSH implementation, no native bindings, no rebuild per platform. Commands ride the
system `ssh` client, so your keys, your `~/.ssh/config`, your jump hosts and your agent
forwarding all keep working exactly as they do in a terminal. When supported, one shared
multiplexed connection per destination means you authenticate once, not once per command.

### SSH support for legacy servers, routers and NAS devices

Send a file to a router with a modern `scp` and you get this:

```bash
scp app.conf router:/etc/
# scp: subsystem request failed on channel 0
```

Nothing is broken — a current `scp` speaks the new protocol, and the router does not know it.
In a terminal you now go read a forum thread and come back with an extra flag. Here you do
nothing: the transfer is tried, the refusal is recognized, the old protocol is used instead,
and that machine is remembered so the next file goes straight there.

**Fallbacks for older SSH clients and missing tools**

Old gear gets a fallback, not a dead end. When a modern feature is missing, the server takes
the older road where it can:

| Your machine | What you get |
|---|---|
| A router or NAS too small for modern file transfer | The file still lands — the old protocol is used automatically |
| A server from ten years ago | The workflow still works; it just opens a fresh connection per command instead of reusing one |
| A stripped-down image with no way to hash a file | The upload says "could not verify" instead of claiming a match nobody checked |
| A box where a tool simply is not installed | The answer says "not measured" — never a zero that reads as "nothing there" |

## Built for the Model Context Protocol

Built on the official MCP SDK, TypeScript throughout, 2500+ unit tests plus a live suite that
runs against real containers rather than mocks.

---

## Raw SSH vs an SSH MCP server: the same job, both ways

### SSH server health check

> **Situation:** A deploy just went out. The server feels slow, and you do not know whether
> disk, memory, services, containers or errors are to blame.
>
> **Question:** “Is this box healthy?”

#### Raw SSH

```console
$ uptime
 10:42:17 up 18 days,  3:21,  2 users,  load average: 0.42, 0.31, 0.28
$ df -hT
Filesystem     Type   Size  Used Avail Use% Mounted on
/dev/sda1      ext4    40G   35G  5.0G  87% /
overlay        overlay  40G   35G  5.0G  87% /var/lib/docker/overlay2/...
$ free -h
               total        used        free      shared  buff/cache   available
Mem:           7.7Gi       4.9Gi       612Mi       121Mi       2.2Gi       2.5Gi
$ systemctl --failed
  UNIT              LOAD   ACTIVE SUB    DESCRIPTION
● api-worker.service loaded failed failed API background worker
$ docker ps -a
CONTAINER ID   IMAGE          STATUS                     PORTS
8e14d0b41c2a   api:latest     Up 3 minutes               0.0.0.0:8080->8080/tcp
65b894af2430   worker:latest  Exited (1) 2 minutes ago
$ ss -tulpn
Netid  State   Local Address:Port   Process
tcp    LISTEN  0.0.0.0:22          users:(("sshd",pid=842,fd=3))
tcp    LISTEN  0.0.0.0:8080        users:(("docker-proxy",pid=1942,fd=4))
$ journalctl -p err --since -1h | tail -50
Aug 20 10:39:14 prod api-worker[22104]: database connection timed out
Aug 20 10:39:14 prod systemd[1]: api-worker.service: Failed with result 'exit-code'.
```

That is still an abridged result. A complete check needs more commands for CPU, service
states, container counts and recent errors, each with its own output format. Worse, a box
without `ss` can look like it has zero listeners when the port check never ran.

#### Structured MCP result

```typescript
ssh_snapshot({ "profile": "production" })
```

```json
{
  "disk_pct": 87,
  "mem_pct": 64,
  "cpu_pct": 12,
  "load": "0.42 0.31 0.28",
  "containers": 7,
  "ports": 14,
  "services_running": 3,
  "recent_errors": 21,
  "unavailable": []
}
```

#### What the agent gains

| Raw SSH | Structured MCP | Your gain |
|---|---|---|
| Several commands and ASCII tables | Named fields in one result | One call, named fields and fewer round trips |
| A missing tool can look like empty output | `unavailable` names what was not measured | Less guessing and fewer bad fixes |
| You sort through disks, services and errors | The problem signals are already surfaced | Faster debugging |

A full `ssh_audit_baseline` result can be longer than a handful of raw command outputs —
about 1,077 tokens versus 765 in our lab measurement. The saving comes from the complete
workflow, not from making one response shorter.

In a real troubleshooting session, purpose-built tools reduced 49 separate command calls to
4 MCP calls. Every additional call starts another model turn with the accumulated
conversation. Prompt caching can reduce the cost of repeated input, but new commands and
their output still consume context. Fewer round trips mean fewer tokens across the session,
less repeated analysis and a faster path to the answer.

**Need the whole picture rather than the pulse?** `ssh_audit_baseline` batches system, disk,
memory, ports, sshd, failed units, Docker, firewall and updates. Findings arrive as
**CRITICAL / WARNING / OK**; unmeasured sections are named instead of silently reading as zero.

### Linux server log search

> **Situation:** The API is timing out, but the same message may be in nginx, syslog,
> journald or an application log you cannot read with your normal user.
>
> **Question:** “Where did that error come from?”

#### Raw SSH

```console
$ grep -i "timeout" /var/log/nginx/error.log
2026/08/20 10:38:54 [error] upstream timed out while reading response header
$ grep -i "timeout" /var/log/syslog
Aug 20 10:39:14 prod api-worker[22104]: database connection timed out
$ grep -i "timeout" /var/log/app/*.log 2>/dev/null
$ journalctl -u api --since "1 hour ago" | grep -i timeout
Aug 20 10:39:14 prod api[22104]: database connection timed out after 30000ms
```

The third command looks clean, but `2>/dev/null` also hid a permission error. "Nothing
matched" and "nothing was read" now look identical. A busy log can also return thousands of
lines and push the rest of the incident out of the agent's context.

#### Structured MCP result

```typescript
ssh_log_search({ "profile": "production",
                 "path": ["/var/log/nginx/error.log", "/var/log/syslog", "/var/log/app/*.log"],
                 "query": "timeout", "context": 2, "since": "1h" })
```

```json
{
  "matches": 34,
  "lines": [
    { "file": "/var/log/nginx/error.log", "line": 4821,
      "text": "upstream timed out while reading response header", "context": false },
    { "file": "/var/log/nginx/error.log", "line": 4822,
      "text": "client closed connection", "context": true }
  ],
  "files_searched": 6,
  "files_unreadable": ["/var/log/app/private"],
  "files_skipped": 12,
  "files_undated": [],
  "limited": false,
  "truncated": false
}
```

#### What the agent gains

| Raw SSH | Structured MCP | Your gain |
|---|---|---|
| Four searches and four outputs | One search across files and globs | Fewer tokens and round trips |
| Permission errors can disappear | `files_unreadable` names every missed path | No false "logs are clean" conclusion |
| Output can grow without a useful ceiling | `limited` and `truncated` expose every cutoff | Safer decisions from partial results |

`since` uses the server's clock, `namesOnly: true` returns only matching paths, and
`ssh_log_tail` reads the last N lines from several logs in one call.

### Safe remote config edits

> **Situation:** You need to replace an nginx config on a live server. A dropped connection,
> wrong mode or unchecked copy could leave the service with a broken file.
>
> **Question:** “Can I replace this config without leaving a partial file?”

#### Raw SSH

```console
$ sudo sh -c 'cat > /etc/nginx/conf.d/api.conf' <<'EOF'
server {
    listen 80;
    location / { proxy_pass http://127.0.0.1:8080; }
}
EOF
$ echo $?
0
```

Exit code zero says the shell finished. It does not prove which bytes landed, and `>`
truncated the old file before the first byte of the new one arrived. If the connection drops
mid-write, the service is left with a partial config.

#### Structured MCP result

```typescript
ssh_file_write({ "profile": "production",
                 "files": [{ "path": "/etc/nginx/conf.d/api.conf",
                             "content": "server {\n    listen 80;\n    location / { proxy_pass http://127.0.0.1:8080; }\n}\n",
                             "mode": "644", "sudo": true, "verify": true }] })
```

```json
{
  "files": [{ "path": "/etc/nginx/conf.d/api.conf", "written": true,
              "verified": "verified", "reason": null, "bytes": 79 }]
}
```

#### What the agent gains

| Raw SSH | Structured MCP | Your gain |
|---|---|---|
| The target is truncated before the copy completes | A complete temp file replaces it with one rename | No half-written config |
| Exit code only | Bytes and verification outcome are named | You know what actually landed |
| Permissions live inside shell text | `sudo`, `mode` and `verify` are per-file fields | Predictable ownership and fewer quoting mistakes |

`verified` has three honest outcomes: `verified`, `unavailable` when the server has no hash
tool, and `skipped` when verification was not requested. For reads, `ssh_file_read` accepts a
list of paths; `ssh_file_list` handles globs, recursion, sizes and modes.

### Run batch SSH commands with sudo

> **Situation:** A deploy is ready, but nginx syntax, service state and recent errors must all
> be checked before traffic moves. One failed check should not disappear inside a combined dump.
>
> **Question:** “Did every preflight check pass?”

#### Raw SSH

```console
$ ssh admin@server.example.com 'sudo nginx -t'
nginx: configuration file /etc/nginx/nginx.conf test is successful
$ ssh admin@server.example.com 'sudo systemctl is-active nginx'
active
$ ssh admin@server.example.com 'sudo tail -5 /var/log/nginx/error.log'
2026/08/20 10:38:54 [error] upstream timed out while reading response header
```

Three connections return three unrelated outputs. If the commands are joined with `;`, the
shell reports only the last exit code; if they are joined with `&&`, later checks disappear
after the first failure.

#### Structured MCP result

```typescript
ssh_exec({ "profile": "production",
           "command": ["nginx -t", "systemctl is-active nginx",
                       "tail -5 /var/log/nginx/error.log"],
           "sudo": true })
```

```json
{
  "commands": [
    { "command": "nginx -t", "exit_code": 0, "truncated": false, "clipped_bytes": 0,
      "stdout": "", "stderr": "nginx: configuration file /etc/nginx/nginx.conf test is successful\n" },
    { "command": "systemctl is-active nginx", "exit_code": 0, "truncated": false,
      "clipped_bytes": 0, "stdout": "active\n", "stderr": "" },
    { "command": "tail -5 /var/log/nginx/error.log", "exit_code": 0, "truncated": false,
      "clipped_bytes": 0, "stdout": "2026/08/21 09:14:02 [error] upstream timed out\n", "stderr": "" }
  ],
  "job_id": null
}
```

#### What the agent gains

| Raw SSH | Structured MCP | Your gain |
|---|---|---|
| Three calls and unrelated outputs | One ordered command list | Fewer round trips |
| A combined shell can hide intermediate status | Every command keeps its own `exit_code` | No missed failed check |
| `sudo` and quoting are repeated in command text | `sudo` applies to the whole batch | Fewer quoting mistakes |

The destructive-command guard checks the complete list before the first command runs. If one
entry is refused, every other entry is marked as not run and nothing is sent to the server.

Each command carries its own `stdout` and `stderr`. A command that ran and printed nothing
has an empty string; a command that never ran has no such field at all, so the two cannot be
confused. Output over 128 KB per command keeps both ends — the head for tables, the tail for
logs — with a seam in between naming the amount, and `clipped_bytes` says how much was cut.
Cutting happens on byte boundaries and steps back to the edge of a character, so a clipped
answer never carries a replacement mark.

`sudo` reaches the server without a terminal: when the profile has a password, it is handed
to `sudo` on standard input. A profile that authenticates by key has no password to offer, so
`sudo` there only works where it is already passwordless — and a command that reads its own
standard input is never given the password, which would otherwise end up mixed into the data.

### Run long-lived SSH jobs

> **Situation:** A backup or migration will run longer than the agent session. The connection
> may close, but you still need its state, output and exit code later.
>
> **Question:** “Will this job survive the conversation?”

#### Raw SSH

```console
$ ssh admin@server.example.com 'pg_dump app | gzip > /srv/backups/app.sql.gz'
client_loop: send disconnect: Broken pipe
```

The terminal is gone. You now have to reconnect, find the process, inspect the target file
and guess whether the backup finished or stopped halfway.

#### Structured MCP result

```typescript
ssh_exec({ "profile": "production",
           "command": "pg_dump app | gzip > /srv/backups/app.sql.gz",
           "detach": true })
```

```json
{
  "commands": [{
    "command": "pg_dump app | gzip > /srv/backups/app.sql.gz",
    "exit_code": null,
    "truncated": false,
    "timed_out": false,
    "blocked": false,
    "blocked_reason": null,
    "not_run": false,
    "warning": null
  }],
  "job_id": "mst0f2q1-9ab3c4d5"
}
```

#### What the agent gains

| Raw SSH | Structured MCP | Your gain |
|---|---|---|
| The job is tied to one SSH session | The remote job has a persistent id | Safe disconnects and restarts |
| Reconnecting means searching processes and files | Status and exit code have named states | No guessing whether it finished |
| Reading output again repeats old text | Output continues from a byte offset | Lower token use on long jobs |

Job state lives on the remote disk, not in this server's memory. `ssh_job_status` distinguishes
`running`, `finished` and `lost`; `ssh_job_output` continues from the last byte offset; and
`ssh_job_kill` signals the whole process group instead of only its shell.

### Transfer files to legacy routers and NAS devices

> **Situation:** A current OpenSSH client tries SFTP, but the router or NAS only understands
> the classic scp protocol. The file must still arrive intact and replace its target safely.
>
> **Question:** “Can this old device still receive a verified file?”

#### Raw SSH

```console
$ scp app.conf operator@router:/etc/app.conf
subsystem request failed on channel 0
scp: Connection closed
```

The usual next step is to remember the legacy flag, retry the copy and then run a separate
hash command—if the device has a hash tool at all.

#### Structured MCP result

```typescript
ssh_upload({ "profile": "router", "local_path": "./app.conf",
             "remote_path": "/etc/app.conf", "sudo": true,
             "mode": "644", "owner": "root:root", "verify": true })
```

```json
{
  "files": [{
    "path": "/etc/app.conf",
    "written": true,
    "verified": "verified",
    "reason": null,
    "bytes": 1284
  }]
}
```

#### What the agent gains

| Raw SSH | Structured MCP | Your gain |
|---|---|---|
| Modern SFTP mode stops at the first error | Classic scp fallback is automatic and remembered | Old gear still works |
| A successful copy does not prove integrity | SHA-256 verification has a named outcome | Corruption is not mistaken for success |
| Direct replacement can leave a partial target | A temp file is moved into place after transfer | The working file survives interruptions |

If the device has neither `sha256sum` nor `openssl`, the result says `unavailable` and names
the reason instead of reporting a false match. Whole directories use `recursive: true` and
verify their hashes in one batch.

## Destructive command protection for AI agents

The guard runs locally, before a command reaches SSH. It separates operations that can be
recovered from those that destroy the container holding the data, and it checks command order
inside chains and batches.

### Stop a destructive chain before it starts

A safe backup-and-replace sequence:

```bash
cp -r /srv/app /srv/app.bak && mv /srv/app /srv/app-old && rm -rf /srv/app
```

The same operations in the wrong order:

```bash
rm -rf /srv/app && cp -r /srv/app /srv/app.bak && mv /srv/app /srv/app-old
# REFUSED before the first command runs
```

The shell would delete the directory and only then discover that the backup source is gone.
The guard sees that later steps read a target already destroyed by an earlier step, so the
whole call stays on your machine. The same check catches
`dropdb app && pg_dump app > backup.sql`.

### Refuse irreversible loss, warn about recoverable changes

| Refused — the container itself | Only warned — its contents |
|---|---|
| `DROP DATABASE`, `dropdb` | `DROP TABLE`, `TRUNCATE`, `DELETE FROM` |
| `docker volume rm`, `docker compose down -v` | `docker rm -f`, `docker system prune -a` |
| `crontab -r` | editing one job |
| `mkfs`, `wipefs -a`, `lvremove`, `zfs destroy` | `chmod 777` |
| `reboot`, `shutdown`, `halt` | `git reset --hard` |

`docker compose down -v` is refused because `-v` removes named Docker volumes, including a database
volume. Without `-v`, stopping the services is not treated as the same irreversible action.

Recursive deletion of the filesystem root, a home directory or system trees such as `/etc`,
`/var` and `/usr` is also refused, including when a symlink leads there. An unresolved target
such as `rm -rf "$DIR"/*` is refused too: "could not check" is not treated as "safe".

### Confirm an intentional destructive command

Nothing is forbidden permanently. Add `# CONFIRMED-DESTRUCTIVE` to a reviewed command and it
is allowed through. When the guard refuses one entry in a batch, the complete batch stops
before execution, so the server is never left after a half-run operation.

The guard works within a single call. It cannot connect a delete in one invocation with a
read in the next, or reason about tools it does not recognize. It is a seatbelt, not a policy
engine: recoverable operations remain your call. Path restrictions and quoting rules are
documented in **[docs/security.md](docs/security.md)**.

## SSH MCP tools for server operations

18 tools. Full parameters and examples live in **[docs/tools.md](docs/tools.md)**.

### MCP tool safety annotations

Standard MCP annotations tell clients which tools are read-only, destructive, idempotent or
open-world. See the [full table](docs/tools.md#what-each-tool-declares-about-itself).

### Run SSH commands and manage remote files

| Tool | What it does |
|---|---|
| `ssh_exec` | Run one command or a batch, with the destructive-command guard and optional detach |
| `ssh_file_read` | Read one or several files, text or binary |
| `ssh_file_write` | Write files with atomic rename and optional SHA-256 verification |
| `ssh_file_list` | List a directory, with optional glob and recursion |

### Monitor long-running SSH jobs

| Tool | What it does |
|---|---|
| `ssh_job_status` | State of a background job: running, finished, or lost |
| `ssh_job_output` | Read accumulated output from a byte offset |
| `ssh_job_list` | List jobs, sweeping finished ones past their TTL |
| `ssh_job_kill` | Signal a job's whole process group |

### Search logs and check server health

| Tool | What it does |
|---|---|
| `ssh_log_tail` | Last N lines of one or several logs, glob supported |
| `ssh_log_search` | Pattern search across logs |
| `ssh_snapshot` | One-shot health snapshot: services, resources, Docker, network, errors |
| `ssh_monitor` | Transport control: stats, reload, test, list, close |

### Upload and download files over SSH

Binary-safe transfers with integrity checks. Details in [docs/transfer.md](docs/transfer.md).

| Tool | What it does |
|---|---|
| `ssh_upload` | Upload a file or directory |
| `ssh_download` | Download a file or directory |

> **For binaries and large files use `ssh_upload` / `ssh_download`** — base64 chunks and
> heredocs are not binary-safe or atomic.

### Audit Linux servers over SSH

Read-only and batched into one round trip. Details in [docs/audit.md](docs/audit.md).

| Tool | What it does |
|---|---|
| `ssh_audit_baseline` | System, disk, memory, network, ssh, services, Docker, firewall, updates |
| `ssh_tls_check` | Certificate expiry, SAN, chain and renewal hook for a domain |
| `ssh_disk_breakdown` | Where the disk went: `du` top-N, Docker, journald, caches |
| `ssh_service_status` | `systemctl status` plus a `journalctl` tail for one unit |

### Windows SSH compatibility mode

Windows uses compatibility mode automatically. When connection multiplexing is
unavailable, the server switches to one connection per command. The same tools remain
available over key-based SSH — no separate setup or Windows-specific implementation.

The destructive-command guard is covered in [Destructive command protection for AI agents](#destructive-command-protection-for-ai-agents).

## Set up the SSH MCP server

Run the package from [Install in 30 seconds](#install-in-30-seconds) first, then create a
profile file.

### Create SSH connection profiles

Put it wherever you like — next to your agent's own config is the usual choice. The examples below use `~/.claude/ssh-profiles.json`; for other agents swap the directory (`~/.codex/`, `~/.qwen/`, `~/.config/opencode/`):

```json
{
  "profiles": {
    "production": {
      "host": "server.example.com",
      "username": "admin",
      "port": 22,
      "privateKeyPath": "~/.ssh/your_private_key"
    }
  }
}
```

**Choose an SSH profile explicitly**

There is no profile the server falls back to: each one is a different machine, and a command
sent to the wrong machine is not something an error message can undo afterwards. Ask without
a name and the answer lists the names to choose from:

```
ssh_exec({ command: "uptime" })
→ No profile specified. Name one explicitly: production
```

A profile the server cannot use for SSH — no `host`, no `username`, or `mode: "local"` — is skipped without complaint, and fields it does not recognize are left alone, so the file can be shared with other tools. A profile with a **broken** field is a different case: it is named along with the field and the value, and its healthy neighbors keep working.

Each profile optionally takes a `pathSecurity` block that whitelists or blacklists the paths file tools may touch — see [docs/security.md](docs/security.md#path-security).

### Keep SSH passwords and passphrases out of profiles

Prefer keys. If a password or encrypted-key passphrase is unavoidable, keep it in a separate
secrets file, never in the profile itself:

```json
{
  "secretsFile": "~/.config/ssh-mcp/secrets.json",
  "profiles": {
    "production": {
      "host": "server.example.com",
      "username": "admin"
    }
  }
}
```

The secrets file is keyed by profile name — see [secrets.json.example](secrets.json.example):

```json
{
  "production": { "password": "..." }
}
```

The secrets file must be readable only by you (`chmod 600`). Relative paths resolve from the
profiles file; secrets stay out of `argv` and are masked in logs. See
[credentials security](docs/security.md#credentials-keep-the-secret-out-of-the-profiles-file).

### Configure Claude Code, Codex and other MCP clients

Choose the client you use and point it at the same profiles file.

**Claude Code**

One command; `-s user` makes the server available in every project:

```bash
claude mcp add ssh -s user \
  -e SSH_PROFILES_FILE="$HOME/.claude/ssh-profiles.json" \
  -- npx -y @hypnosis/ssh-mcp-server
```

**Codex CLI**

```bash
codex mcp add ssh \
  --env SSH_PROFILES_FILE="$HOME/.codex/ssh-profiles.json" \
  -- npx -y @hypnosis/ssh-mcp-server
```

**opencode**

Put it in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ssh": {
      "type": "local",
      "command": ["npx", "-y", "@hypnosis/ssh-mcp-server"],
      "enabled": true,
      "environment": {
        "SSH_PROFILES_FILE": "~/.config/opencode/ssh-profiles.json"
      }
    }
  }
}
```

**Qwen Code**

One command, same as the others:

```bash
qwen mcp add ssh \
  -e SSH_PROFILES_FILE="$HOME/.qwen/ssh-profiles.json" \
  npx -y @hypnosis/ssh-mcp-server
```

**Other MCP clients**

Gemini CLI, Hermes, Cline, an editor plugin or your own agent work the same way. All they
need is a command to run and one environment variable.

### Restart your MCP client

Restart the client, then run `ssh_monitor({ action: "list" })` to confirm the profile loaded.

## SSH MCP server configuration

| Variable | What it does | Default |
|---|---|---|
| `SSH_PROFILES_FILE` | Path to the profiles JSON — **required** | — |
| `SSH_MCP_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_LEVEL` | Fallback, used only when `SSH_MCP_LOG_LEVEL` is unset | `info` |
| `SSH_MCP_LOG_TIMESTAMP` | Timestamps in log lines | `true` |
| `SSH_MCP_CONTROL_PERSIST` | Seconds a shared connection stays alive after the last command; `0` closes it at once | `600` |
| `SSH_MCP_CONTROL_DIR` | Where control sockets live | `~/.ssh/ssh-mcp` |
| `SSH_MCP_PROFILES_CACHE_TTL` | Profile cache TTL, ms | `60000` |
| `SSH_MCP_PROFILES_WATCH` | Reload the profiles file when it changes | `true` |

The shared connection outlives this process on purpose: closing it on exit would cut the channel another window on the same machine is using.

## SSH MCP server limitations

- **Cancellation:** closing SSH may leave the remote command running. Use detached jobs when control matters.
- **Atomic writes:** BSD and macOS cannot pre-check cross-filesystem renames.

## SSH MCP server roadmap

- [ ] Full test run against macOS SSH hosts
- [ ] End-to-end compatibility run on Windows
- [ ] Multi-host audits — compare health across several SSH profiles in one call
- [ ] Import profiles from the existing `~/.ssh/config`
- [ ] Resumable transfers for large files and unstable connections
- [ ] Remote operation timeline — commands, transfers and guard decisions in one audit trail
- [ ] Ready-made SSH troubleshooting playbooks

- [x] ~~Answers that reach the model~~ — **DONE:** command output, matched log lines, machine names and snapshot sections travel in the fields, not only in the text
- [x] ~~Smaller MCP tool schemas~~ — **DONE:** the tool list got 10% lighter, and a detached job now shows the last lines it wrote instead of being polled blind

## Develop and test the SSH MCP server

```bash
npm install
npm run build           # tsc
npx tsc --noEmit        # types, plus dead declarations
npm run test:unit       # unit tests
npm run lab:up          # start the two test containers
npm run test:live       # live suite against those containers
```

The live suite runs against real containers — one BusyBox, one coreutils — because the two disagree quietly, and a mock agrees with whoever wrote it. See [docs/architecture.md](docs/architecture.md) for the layout.

## Like SSH MCP Server? ⭐

If you like the tool, [give it a star on GitHub](https://github.com/hypnosis/ssh-mcp-server) — it helps more people discover the project.

## Contribute to the SSH MCP server

Issues and pull requests are welcome at [github.com/hypnosis/ssh-mcp-server](https://github.com/hypnosis/ssh-mcp-server).

## License

MIT — see [LICENSE](LICENSE).
