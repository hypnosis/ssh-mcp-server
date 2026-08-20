# SSH MCP Server Architecture

SSH MCP Server lets Codex, Claude, and other MCP clients administer remote servers over
SSH. It is a local stdio bridge: it uses the system `ssh`/`scp` clients, and nothing has
to be installed or kept running on the remote server. The README covers installation and
what the tools do; this file is for anyone who wants to read or change the code.

## Overview

```
MCP client config (Claude Code, Codex, …)
      ↓
SSH MCP Server (stdio)
      ↓
MCP layer — one source for the tool list and the call routing
      ↓
18 Tools (exec, file, job, log, snapshot, monitor, transfer, audit)
      ↓                          ↘ Profile Resolver → SSH_PROFILES_FILE
SSH Executor (builds the command: sudo, cwd)
      ↓
SSH Runner (system ssh/scp, one multiplexed connection per destination)
      ↓
Remote Server(s)
```

### Key Principles

- **Connection reuse** - one multiplexed connection per destination (ControlMaster). Other processes on the machine can use it too when they use the same control socket
- **Session-based metrics** - command and transfer counters live in this server process; the connection itself belongs to `ssh`
- **NO streaming** - snapshot results only
- **REST approach** - arrays where logical
- **Retry logic** - one retry for idempotent commands after a transport failure; a refused multiplexed session falls back to a connection of its own
- **Cancellation** - a cancelled call stops the local `ssh` client immediately, rather than waiting for the command timeout. It cannot stop a command already running on the server. File transfers and `ssh_snapshot` do not support cancellation: stopping a transfer could leave its target empty, while a cancelled snapshot would return blanks. For work that must be stoppable, use `detach: true` and then `ssh_job_kill`
- **Background jobs** - a detached command keeps its whole state on the server, so nothing is remembered on our side and a restart of this server loses nothing

## Development

### Requirements

- Node.js 18+
- TypeScript 5+
- SSH access to remote servers

### Development Setup

For contributors who want to build or change the server. For regular installation and
MCP client configuration, see the [README](../README.md).

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
├── index.ts                     # Entry point: profiles, transport, shutdown
├── mcp-server.ts                # Tool list and call routing, built from one source
├── runner/                      # The transport: system ssh/scp and everything around them
│   ├── get-runner.ts            # The only place tools obtain a transport
│   ├── openssh-runner.ts        # Commands and transfers over the shared connection
│   ├── ssh-args.ts              # Command line for ssh/scp, control socket path
│   ├── askpass.ts               # Password/passphrase delivery via SSH_ASKPASS
│   ├── runtime-check.ts         # Probes ssh version/capabilities once per process
│   ├── process.ts               # Child process: timeout, cancellation, output limit
│   ├── error-classifier.ts      # Which failure this is: auth, host, mux, closed channel
│   ├── errors.ts                # Transport error types (SSHRunnerError, ...)
│   ├── control-sockets.ts       # What is left running on this machine
│   ├── passport.ts              # What the server has: bash, sha256sum, timeout
│   └── types.ts                 # CommandRunner contract shared by tools and transport
├── managers/
│   ├── ssh-executor.ts          # Builds the command (sudo, cwd) and hands it to the runner
│   ├── installer.ts             # The only path that puts data onto the target
│   ├── local-path-ops.ts        # Installer's local-filesystem half (used by downloads)
│   ├── remote-path-ops.ts       # Installer's remote-filesystem half (mv -T, test -L)
│   ├── removal-guard.ts         # Resolves rm targets through symlinks before they run
│   ├── path-guard.ts            # Tilde expansion + profile path rules
│   └── remote-verify.ts         # sha256 of what landed on the server
├── tools/
│   ├── exec-tool.ts             # ssh_exec
│   ├── file-tools.ts            # ssh_file_read/write/list (verify/atomic/binary)
│   ├── job-tools.ts             # ssh_job_status/output/list/kill
│   ├── log-tools.ts             # ssh_log_tail/search
│   ├── snapshot-tool.ts         # ssh_snapshot
│   ├── monitoring-tool.ts       # ssh_monitor
│   ├── transfer-tool.ts         # ssh_upload, ssh_download
│   ├── audit-tool.ts            # ssh_audit_baseline, ssh_tls_check,
│   │                             # ssh_disk_breakdown, ssh_service_status
│   └── audit-output.ts          # audit result types + their output schemas
└── utils/
    ├── logger.ts                 # Logging
    ├── ssh-config.ts             # SSH configuration
    ├── profile-resolver.ts       # Load profiles
    ├── profiles-file.ts          # Parse profiles
    ├── path-validator.ts         # Path security
    ├── df-table.ts                # Parsing the df table by name, not by column number
    ├── output-notes.ts           # Notes about an answer that is not the whole answer
    ├── tool-result.ts            # The one place a failed answer is built (isError)
    ├── tool-args.ts              # Argument shape checks: required field present, right type
    ├── sha256.ts                  # Local + remote sha256 helpers
    ├── tmp-name.ts                # Atomic temp / staging path generators
    ├── shell-arg.ts               # Quoting of values placed into a shell command
    ├── command-parse.ts          # Splits a command line into the invocations it runs
    ├── destructive-command.ts    # Detects rm targeting root/home/system trees, incl. via symlink
    ├── irreversible-command.ts   # Detects commands that destroy a whole container (DB, volume, disk)
    ├── job-command.ts             # Wire protocol for background jobs (start/status/read/kill)
    ├── local-tree.ts              # Walks a local directory the way scp -r will carry it
    ├── array-validator.ts        # Validates string-or-array MCP parameters
    └── process-guards.ts         # Keeps one bad async error from killing the whole server
```
