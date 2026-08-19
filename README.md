# SSH MCP Server

An MCP server that lets an AI coding agent — Claude Code, Codex, Gemini CLI, Hermes, or anything else that speaks MCP — run commands, move files, and audit live servers over SSH, using the OpenSSH client, keys, and config already on your machine.

[![npm version](https://img.shields.io/npm/v/@hypnosis/ssh-mcp-server?style=flat-square&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@hypnosis/ssh-mcp-server?style=flat-square&logo=npm&logoColor=white&color=CB3837&label=downloads)](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server)
[![tests](https://img.shields.io/github/actions/workflow/status/hypnosis/ssh-mcp-server/test.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=tests)](https://github.com/hypnosis/ssh-mcp-server/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/node/v/@hypnosis/ssh-mcp-server?style=flat-square&logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/npm/dependency-version/@hypnosis/ssh-mcp-server/dev/typescript?style=flat-square&logo=typescript&logoColor=white&color=3178C6&label=typescript)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/npm/dependency-version/@hypnosis/ssh-mcp-server/@modelcontextprotocol/sdk?style=flat-square&logo=modelcontextprotocol&logoColor=white&color=0F172A&label=MCP%20SDK)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/npm/l/@hypnosis/ssh-mcp-server?style=flat-square&color=2563EB)](LICENSE)

**[Install](#installation) · [Quick start](#quick-start) · [Tools](#tools) · [Security](#security) · [Docs](docs/) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)**

---

## What it's for

You already ask an assistant about your servers. Without this, it hands you a command to paste, waits for you to paste the output back, and repeats — you become the transport. With it, the assistant reaches the machine itself and gets structured answers back.

The everyday jobs it was built for:

- **Find out why something broke.** One `ssh_snapshot` call returns services, resources, docker, network and recent errors together, instead of a dozen commands typed one at a time.
- **Audit a machine you inherited.** Disks, listening ports, firewall, pending updates, certificate expiry — batched into one round trip, read-only, with the findings already sorted into critical, warning and fine.
- **Work through logs.** Tail or search several journals at once, with context lines and a cap that keeps the answer readable.
- **Ship files.** A file or a whole directory, binary-safe, verified by sha256, put in place by atomic rename — never a half-written file where the old one used to be.
- **Start work that outlives the conversation.** A migration or a backup keeps running after the call returns; job state lives on the remote disk, so it survives a restart of this server too.

**Why not just give the assistant a shell?** Because a shell has no brakes and no memory of what it just did. Here every destructive command is checked before it leaves your machine, every transfer says plainly whether it could verify itself, and a broken pipe is reported as "could not check" instead of being passed off as success.

## Why this one

**It uses the SSH you already have.** No bundled SSH implementation, no native bindings, no rebuild per platform. Commands ride the system `ssh` client, so your keys, your `~/.ssh/config`, your jump hosts and your agent forwarding all keep working exactly as they do in a terminal. One shared multiplexed connection per destination means you authenticate once, not once per command.

**It still talks to old servers.** OpenSSH has moved on; the machines in the rack often have not. Three features have version floors, and missing one degrades a feature instead of refusing the connection — a client from 2010 is still served:

| From version | What it unlocks | Below it |
|---|---|---|
| 5.6 | Shared multiplexed connection (`ControlPersist`) | Every command opens its own connection |
| 8.4 | Password and passphrase profiles (`SSH_ASKPASS_REQUIRE`) | Refused — but only for profiles that need a password; key-based profiles are unaffected |
| 9.0 | `scp` rides the SFTP protocol | Falls back to the classic scp protocol |

**It refuses to destroy what cannot be brought back.** Two independent checks run before anything reaches the server. The first reads the command text and stops whole-container destruction — wiping a disk, dropping a database, `crontab -r`, removing a Docker volume, halting the machine. The second catches a recursive delete aimed at the filesystem root, a home directory or a system tree, **including when a symlink leads there**. Neither is a policy you have to configure, and both step aside for an explicit confirmation marker: this guards against the slip, not against you.

**It speaks current MCP.** Built on `@modelcontextprotocol/sdk` 1.30, TypeScript throughout, 2100+ unit tests plus a live suite that runs against real containers rather than mocks.

---

## What changed in 2.1.0

The server now explains itself to an agent that has never seen it. That is not a cosmetic
change: an agent connected to the previous version solved "show me the app log for the last
two minutes" with one `ssh_exec` that chained `cd`, `sudo`, `curl`, `sleep`, `docker compose
logs`, `grep` and `tail`, and parked the output in `/tmp` to read it back with a second
call. Eighteen tools had collapsed into the one that runs anything.

Every description was rewritten to one shape — what the tool does, the parameters that
matter with their values, the antipattern — and the server instructions became an index of
question to tool instead of a retelling of the descriptions.

**The surface costs less.** A client loads it once per session, before any call:

| | before | after | |
|---|---:|---:|---:|
| tool descriptions | 9 628 | 2 292 | −76% |
| parameter descriptions | 10 509 | 6 782 | −35% |
| server instructions | 3 875 | 1 579 | −59% |
| input and output schemas | 27 378 | 23 557 | −14% |
| **whole surface** | **44 007 chars ≈ 11 000 tokens** | **30 514 ≈ 7 628** | **−31%** |

Schemas are what is left, and they stay: they are the validator's contract, not prose.

**The tools cost less per use, which is where it adds up.** Measured against a lab
container, counting what actually travels to the model — the arguments sent and the answer
received — for the same task done both ways:

| Task | Through `ssh_exec` | With the tool for it | Difference |
|---|---|---|---|
| read 5 config files | 5 calls, ≈483 tokens | 1 call, ≈253 | **−48%**, 4 fewer round trips |
| find errors across 4 logs | 4 calls, ≈402 tokens | 1 call, ≈159 | **−61%**, 3 fewer round trips |
| collect machine health | 6 calls, ≈765 tokens | 1 call, ≈1 077 | **+41%** — see below |
| run a 3-second job and read it | 2 calls, ≈191 tokens | 2 calls, ≈178 | −7% |

The batching tools pay off exactly as expected, and the more often an agent reaches for
them the larger the gap grows. `ssh_audit_baseline` is the honest exception: it costs more
than six hand-written commands because it comes back with more — every section classified,
and the ones that could not be measured named as such rather than reported as zero. What it
saves there is round trips and the reading you would otherwise do yourself.

The method behind both tables, and what an agent actually reads in a tool surface, is in
[docs/decisions/009-how-an-agent-reads-the-surface.md](docs/decisions/009-how-an-agent-reads-the-surface.md).

## Requirements

- **Node.js 18+**
- **A system `ssh` client on `PATH`** — nothing is bundled. Any OpenSSH will run; see the version table above for what each floor unlocks.

`ssh_monitor({ action: "stats", profile: "production" })` reports the client version it found and whether multiplexing is active.

## Installation

**You do not have to install anything.** Every example below launches the server with
`npx -y`, which fetches the package on first use and keeps it in the npx cache — the `-y`
answers the prompt npx would otherwise ask before downloading:

```bash
npx -y @hypnosis/ssh-mcp-server
```

Install it globally if you would rather pin a version, work offline, or avoid the extra
second npx spends checking the registry:

```bash
npm install -g @hypnosis/ssh-mcp-server
```

Then use `ssh-mcp-server` as the command in the client config instead of `npx`.

## Quick start

### 1. Create a profile file

Put it wherever you like. The examples below use `~/.claude/ssh-profiles.json` for Claude Code and `~/.codex/ssh-profiles.json` for Codex:

```json
{
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

**Every call names its profile.** There is no profile the server falls back to: each one is a different machine, and a command sent to the wrong machine is not something an error message can undo afterwards. Ask without a name and the answer lists the names to choose from:

```
ssh_exec({ command: "uptime" })
→ No profile specified. Name one explicitly: production, staging
```

A profile the server cannot use for SSH — no `host`, no `username`, or `mode: "local"` — is skipped without complaint, and fields it does not recognise are left alone, so the file can be shared with other tools. A profile with a **broken** field is a different case: it is named along with the field and the value, and its healthy neighbours keep working.

Each profile optionally takes a `pathSecurity` block that whitelists or blacklists the paths file tools may touch — see [docs/security.md](docs/security.md#path-security).

### Keep passwords out of the profiles file

Prefer keys. Where a password — or an encrypted key — is unavoidable, the secret does not belong in the profiles file: that file gets copied, pasted into issues and committed by accident. Point at a secrets file instead, with `secretsFile` at the top level, per profile, or both:

```json
{
  "secretsFile": "~/.config/ssh-mcp/secrets.json",
  "profiles": {
    "production": {
      "host": "server.example.com",
      "username": "admin"
    },
    "appliance": {
      "host": "10.0.0.2",
      "port": 2222,
      "username": "operator",
      "secretsFile": "./appliance-secret.json"
    }
  }
}
```

The secrets file is keyed by profile name — see [secrets.json.example](secrets.json.example):

```json
{
  "production": { "password": "..." },
  "staging": { "passphrase": "..." }
}
```

- **`chmod 600` is required.** The server refuses to read a secrets file that anyone but you can read, the same way `ssh` refuses a private key — and says which file and what to run.
- A relative path is resolved **from the profiles file**, not from the working directory the client happened to start the server in.
- A profile whose secrets file is missing, malformed or too permissive is reported as broken instead of quietly logging in without a password.
- A profile named in `secretsFile` but absent from the file is fine — key-based profiles need no entry.
- `password` and `passphrase` written directly in a profile still work, so existing setups keep running, but the secrets file wins and a warning is logged.

The password never travels in `argv` — it reaches `ssh` through an askpass helper reading one environment variable, so `ps` does not show it — and it is masked in the logs. Details in [docs/security.md](docs/security.md#credentials-keep-the-secret-out-of-the-profiles-file).

### 2. Point your MCP client at it

**Claude Code** — one command, `-s user` makes the server available in every project:

```bash
claude mcp add ssh -s user \
  -e SSH_PROFILES_FILE="$HOME/.claude/ssh-profiles.json" \
  -- npx -y @hypnosis/ssh-mcp-server
```

Or write it into `~/.claude.json` by hand:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@hypnosis/ssh-mcp-server"],
      "env": {
        "SSH_PROFILES_FILE": "~/.claude/ssh-profiles.json"
      }
    }
  }
}
```

**Codex CLI** — same shape, TOML instead of JSON:

```bash
codex mcp add ssh \
  --env SSH_PROFILES_FILE="$HOME/.codex/ssh-profiles.json" \
  -- npx -y @hypnosis/ssh-mcp-server
```

Or write it into `~/.codex/config.toml` by hand:

```toml
[mcp_servers.ssh]
command = "npx"
args = ["-y", "@hypnosis/ssh-mcp-server"]

[mcp_servers.ssh.env]
SSH_PROFILES_FILE = "~/.codex/ssh-profiles.json"
```

Any other MCP client works too — it needs a command to run and one environment variable.

### 3. Restart the client

Done — the assistant can now reach your servers. Ask it to run `ssh_monitor({ action: "list" })` to see the profile names it loaded, then `ssh_monitor({ action: "stats", profile: "production" })`: it reports the ssh client it found and whether multiplexing is active.

## Tools

18 tools. Full parameters and examples live in **[docs/tools.md](docs/tools.md)**.

**Every tool tells the client what it will do to your machine** — before the call, not
after. Reading a log and wiping a directory do not look alike to an assistant: each tool
carries the standard MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`), so a client can run the harmless ones quietly and stop to ask you about
the rest. The full table is in
[docs/tools.md](docs/tools.md#what-each-tool-declares-about-itself).

**Commands and files**

| Tool | What it does |
|---|---|
| `ssh_exec` | Run one command or a batch, with the destructive-command guard and optional detach |
| `ssh_file_read` | Read one or several files, text or binary |
| `ssh_file_write` | Write files with atomic rename and optional sha256 verification |
| `ssh_file_list` | List a directory, with optional glob and recursion |

**Long-running work** — a command that outlives the call

| Tool | What it does |
|---|---|
| `ssh_job_status` | State of a background job: running, finished, or lost |
| `ssh_job_output` | Read accumulated output from a byte offset |
| `ssh_job_list` | List jobs, sweeping finished ones past their TTL |
| `ssh_job_kill` | Signal a job's whole process group |

Job state lives on the remote disk, not in this server's memory — jobs survive a restart of the MCP server itself.

**Logs and health**

| Tool | What it does |
|---|---|
| `ssh_log_tail` | Last N lines of one or several logs, glob supported |
| `ssh_log_search` | Pattern search across logs |
| `ssh_snapshot` | One-shot health snapshot: services, resources, docker, network, errors |
| `ssh_monitor` | Transport control: stats, reload, test, list, close |

**Transfer** — binary-safe, atomic, sha256-verified. Details in [docs/transfer.md](docs/transfer.md).

| Tool | What it does |
|---|---|
| `ssh_upload` | Upload a file or directory |
| `ssh_download` | Download a file or directory |

> **For binaries and large files use `ssh_upload` / `ssh_download`** — not base64 chunks through `ssh_exec`, and not a heredoc through `ssh_file_write`. Heredoc writes corrupt binaries and offer no integrity or atomicity guarantee.

**Audit** — read-only, batched into one round trip. Details in [docs/audit.md](docs/audit.md).

| Tool | What it does |
|---|---|
| `ssh_audit_baseline` | System, disk, memory, network, ssh, services, docker, firewall, updates |
| `ssh_tls_check` | Certificate expiry, SAN, chain and renewal hook for a domain |
| `ssh_disk_breakdown` | Where the disk went: `du` top-N, docker, journald, caches |
| `ssh_service_status` | `systemctl status` plus a `journalctl` tail for one unit |

## Security

Two levels of caution, and the difference between them is whether the loss can be undone:

- **A warning** is returned for a destructive but recoverable command — dropping a table, `chmod 777`, force-removing a container. You see it and decide.
- **A refusal** stops the call before it reaches the server when the loss would be final: destroying the whole container of the data, or reading something that the same command already destroyed.

Both are bypassed by an explicit `# CONFIRMED-DESTRUCTIVE` marker, so nothing is permanently forbidden — the guard is there to catch the slip.

**What it deliberately does not see:** a delete and a read split across two separate calls (no state is carried between invocations), and sinks of tools it does not special-case. It is a seatbelt, not a policy engine: the line between a warning and a refusal is drawn where the loss stops being recoverable, and everything that can still be undone stays your call.

Path handling, quoting rules and per-profile path restrictions: **[docs/security.md](docs/security.md)**.

## Configuration

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

## Documentation

| | |
|---|---|
| [docs/tools.md](docs/tools.md) | Every tool, every parameter, with examples |
| [docs/security.md](docs/security.md) | Destructive-command guard, path handling, quoting |
| [docs/transfer.md](docs/transfer.md) | Upload and download in depth |
| [docs/audit.md](docs/audit.md) | Audit tools and the recommended pipeline |
| [docs/architecture.md](docs/architecture.md) | How the project is built, and how to work on it |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up the lab and what a patch has to prove |
| [SECURITY.md](SECURITY.md) | What the server promises, and how to report a vulnerability privately |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Development

```bash
npm install
npm run build           # tsc
npx tsc --noEmit        # types, plus dead declarations
npm run test:unit       # unit tests
npm run lab:up          # start the two test containers
npm run test:live       # live suite against those containers
```

The live suite runs against real containers — one BusyBox, one coreutils — because the two disagree quietly, and a mock agrees with whoever wrote it. See [docs/architecture.md](docs/architecture.md) for the layout.

## Contributing

Issues and pull requests are welcome at [github.com/hypnosis/ssh-mcp-server](https://github.com/hypnosis/ssh-mcp-server).

## License

MIT — see [LICENSE](LICENSE).
