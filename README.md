# SSH MCP Server

An MCP server that lets an AI assistant — Claude Code, Codex, or anything else that speaks MCP — run commands, move files, and audit live servers over SSH, using the OpenSSH client, keys, and config already on your machine.

[![npm version](https://img.shields.io/npm/v/@hypnosis/ssh-mcp-server?style=flat-square&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@hypnosis/ssh-mcp-server?style=flat-square&logo=npm&logoColor=white&color=CB3837&label=downloads)](https://www.npmjs.com/package/@hypnosis/ssh-mcp-server)
[![tests](https://img.shields.io/github/actions/workflow/status/hypnosis/ssh-mcp-server/test.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=tests)](https://github.com/hypnosis/ssh-mcp-server/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/node/v/@hypnosis/ssh-mcp-server?style=flat-square&logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/npm/dependency-version/@hypnosis/ssh-mcp-server/dev/typescript?style=flat-square&logo=typescript&logoColor=white&color=3178C6&label=typescript)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/npm/dependency-version/@hypnosis/ssh-mcp-server/@modelcontextprotocol/sdk?style=flat-square&logo=modelcontextprotocol&logoColor=white&color=0F172A&label=MCP%20SDK)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/npm/l/@hypnosis/ssh-mcp-server?style=flat-square&color=2563EB)](LICENSE)

**[Install](#installation) · [Quick start](#quick-start) · [Tools](#tools) · [Security](#security) · [Docs](docs/) · [Changelog](CHANGELOG.md)**

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

## Requirements

- **Node.js 18+**
- **A system `ssh` client on `PATH`** — nothing is bundled. Any OpenSSH will run; see the version table above for what each floor unlocks.

`ssh_monitor({ action: "stats" })` reports the client version it found and whether multiplexing is active.

## Installation

```bash
# Global install
npm install -g @hypnosis/ssh-mcp-server

# Or run on demand without installing
npx @hypnosis/ssh-mcp-server
```

## Quick start

### 1. Create a profile file

Put it wherever you like. The examples below use `~/.claude/ssh-profiles.json` for Claude Code and `~/.codex/ssh-profiles.json` for Codex:

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

You can reuse the same file as the Docker MCP Server: profiles with `mode: "local"` are skipped, profiles with `host` and `username` are picked up.

Each profile optionally takes a `pathSecurity` block that whitelists or blacklists the paths file tools may touch — see [docs/security.md](docs/security.md#path-security).

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

Done — the assistant can now reach your servers. Ask it to run `ssh_monitor({ action: "stats" })`: it reports the ssh client it found and whether multiplexing is active.

## Tools

18 tools. Full parameters and examples live in **[docs/tools.md](docs/tools.md)**.

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

**What it deliberately does not see:** a delete and a read split across two separate calls (no state is carried between invocations), and sinks of tools it does not special-case. It is a seatbelt, not a policy engine — the reasoning is written down in [docs/decisions/007-refusal-threshold.md](docs/decisions/007-refusal-threshold.md) (Russian).

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
