# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v2.0.0 (branch `feat/openssh-transport`)

Transport moved from the in-process `ssh2` pool to the system OpenSSH client with
ControlMaster multiplexing. Sprints CORE_08 → CORE_11; full record with measurements in
`docs/sprints/planned/`. The bundled `ssh2` backend is gone, and with it the connection
pool, so `SSH_MCP_BACKEND` no longer selects anything.

**New requirement on your machine (breaking).** There is no bundled SSH any more: a system
`ssh` client has to be on `PATH`. Any OpenSSH works, but three features have a floor —
5.6 for the shared multiplexed connection, 8.4 for password and passphrase profiles, 9.0
for `scp` over SFTP. Below a floor the feature says so instead of failing quietly. If that
does not suit the machines you run on, stay on `1.x`.

### Changed — one transport, and connections that outlive the server
- The system `ssh` client is the only way commands are delivered. `SSH_MCP_BACKEND=ssh2`
  is no longer honoured (**breaking**), and the pool variables `SSH_MCP_POOL_IDLE_TIMEOUT`
  and `SSH_MCP_POOL_KEEPALIVE_INTERVAL` are gone with the pool itself.
- Connections are no longer closed on exit: the control socket is shared with other
  windows on the machine. The server reports what it leaves behind instead — which sockets
  are in the control directory and whether their master is alive.
- `SSH_MCP_CONTROL_PERSIST` sets how long a connection stays alive after the last command
  (whole seconds, `0` closes immediately, default `600`). The remaining idle time is
  deliberately not reported: a socket's timestamp marks when the master came up, not the
  last command. See `docs/decisions/006-leftover-control-sockets.md`.
- `ssh_monitor` gained the action `close`: it closes the shared connection of one profile
  right away instead of waiting for the idle window, and says what is still left on the
  machine. Nothing to close is an answer, not a failure — the connection may have already
  idled out.
- Servers without an sftp subsystem (routers, embedded devices, dropbear) can receive and
  send files again. On client 9.0+ `scp` rides SFTP, which such a server refuses; the
  transfer now falls back to the classic scp protocol once and remembers that destination.
  Nothing to configure. A remote path containing a newline is refused on that path — the
  classic protocol cannot carry it safely.

### Added — commands that outlive the call (4 new tools)
- `ssh_exec` takes `detach: true`: the command is started as a job on the server and the
  answer comes back with its id in under a second. Before this, a command longer than the
  timeout could not be run at all — the client was killed and the work was neither finished
  nor reachable. The timeout does not apply to a job.
- `ssh_job_status`, `ssh_job_output`, `ssh_job_list` and `ssh_job_kill` follow it. State lives
  on the server (`~/.ssh-mcp/jobs/<id>/`: the command, pid, start time, output and exit code),
  so restarting this server or watching from another window changes nothing.
- Three outcomes are kept apart: `running`, `finished` with its exit code, and `lost` — no
  exit code and no process, which means it was signalled or the machine restarted. `lost` is
  not dressed up as success or as failure, because it is neither.
- `ssh_job_output` reads from a byte offset and answers with the offset to continue from, so
  repeated reads never overlap and never skip. The offset counts what was actually read: an
  answer cut off at the transport buffer does not jump over the middle of the output.
- `ssh_job_kill` signals the whole process group, so the children of a job stop with it. A job
  that is already gone is reported, not refused — it may have finished between two calls.
- `ssh_job_list` removes the directories of jobs that are no longer running and started more
  than seven days ago; running jobs are never touched, and removal never leaves `~/.ssh-mcp`.
- Limits: one command per job (an array is refused), and `detach` cannot be combined with
  `sudo` — a background job has nowhere to take a password from. The refusal happens before
  anything is sent. The guard against destructive deletes runs on this path too, before the
  job directory is created.

### Changed — a failure now looks like a failure, and says what it managed to do
- A command killed by its `timeout` no longer loses what it printed. The answer carries the
  output collected until the kill, under a note saying it is only that much. Before, the
  whole answer was a single line naming the timeout — a command that printed progress for
  an hour and then hit its limit left nothing behind. The same applies to a cancelled
  command.
- Every tool marks a failed call with `isError` (**breaking** for clients that parsed the
  text to guess). Before, only `ssh_monitor` did, so a client could not tell "the file is
  not there" from the contents of a file. The text of the answer is unchanged — only the
  flag is new.
- Three outcomes stay apart, and the flag draws the line. The tool could not do the work
  (no such profile, wrong argument shape, command killed by its timeout, server refused) —
  flagged. The work was done — not flagged, **even when the command exited non-zero**: the
  command ran and its output is the answer. There was nothing to check with (`ssh_tls_check`
  answering `UNKNOWN`, `ssh_service_status` answering `NOT CHECKED`) — not flagged either,
  that is a success with a note.

### Changed — MCP SDK 0.6.1 → 1.30
- The server answers each client with the protocol revision that client asked for
  (`2024-11-05` through `2025-11-25`). On `0.6.1` every client was answered `2024-11-05`,
  whatever it asked for. Older clients keep working — measured.
- The upgrade itself changed no behaviour: the whole set of 14 tools was called through a
  real client before and after it, on both lab containers, and the answers matched
  character for character. Tool names and input schemas stay as they were; what the two
  entries below add to the answer came after the upgrade, deliberately.
- The dependency is heavier: 14 packages / 7.5 MB → 91 packages / 24 MB, because the SDK
  now ships its HTTP transports (express, cors, hono, ajv) even for a stdio server. The
  Node requirement stays `>=18`.
- A cancelled call is now acted upon instead of being ignored. The client's cancellation
  reaches the tool and the transport, and the `ssh` client waiting on the answer is
  dropped at once rather than sitting out the command's timeout. What it does not do is
  stop the command on the server — see Known limitations.
- `ssh_audit_baseline` and `ssh_tls_check` hand the client their result already parsed
  (`structuredContent`), and describe its shape in the tool listing (`outputSchema`).
  Before, the only way to get the data was to cut the text at `--- raw JSON ---` and parse
  what followed. That text is unchanged, so a client doing exactly that keeps working.
  A client on SDK 1.x checks the answer against the declared shape and refuses it on a
  mismatch, so the two are tested against each other on live servers.

### Fixed — data loss and false corruption reports
- `~` in `remote_path` of `ssh_upload` / `ssh_download`. Download used to bring the file
  and then delete it (the checksum was asked for a file literally named `~`); upload
  created a directory called `~` next to the real home.
- File names containing a backslash, newline or carriage return were reported as corrupted
  after a correct transfer — and the installer removed the tree it had just delivered.
- A transfer killed by the remote timeout watchdog was read as a checksum mismatch
  (exit code 124 on coreutils, 143 on BusyBox), with the same removal as above.
- Trees of ~1000 files failed to upload with `verify: true`: every file was opened at once
  and the process ran out of descriptors. Hashing now runs through a pool of 16 readers.
- Broken symlinks and symlink loops inside a tree are refused **before** the transfer
  starts instead of leaving half a tree on the server.

### Changed — behaviour
- `pathSecurity` from the profile is now actually enforced, and also covers `ssh_upload` /
  `ssh_download`. It never worked before: the field was lost between the profiles file and
  the tool. Profiles that carry this block will start rejecting paths.
- No default 300-second ceiling on transfers. `ssh_upload` / `ssh_download` accept an
  optional `timeout` (ms) which also covers checksum verification, `chmod -R` and cleanup.
- `~user/path` is rejected instead of being written to a guessed location; under
  `sudo: true`, `~` means the login user's home and the answer says so.
- `ssh_file_read` refuses truncated output instead of returning a partial file.
- `ssh_upload` with `overwrite: false` refuses when it cannot tell whether the target
  exists, instead of taking a failed check for "the file is not there" and writing over
  it. Pass `overwrite: true` if that is what you mean.

### Security
- Tool argument values (`mode`, `owner`, `pattern`, `lines`, `context`, `top_n`,
  `log_lines`) are validated before reaching the command line — eight injection points in
  four files. Working forms (`644`, `u+x`, `*.log`, names with spaces) are unchanged.
- Passwords and passphrases are stripped from everything the server logs itself, at any
  length. Server output is left untouched — masking it corrupted file contents.

### Fixed — found by acceptance testing (251 real MCP calls on four servers)
- `ssh_snapshot` no longer hangs on a connection that is not up yet. Its ten parallel
  reads and the server passport deadlocked behind the first-command gate, and the hang
  took the whole server down with it. The passport now comes from the transport, whose
  probe bypasses the gate; a cold snapshot answers in 200–300 ms.
- A profile with no key and no password could run commands as `root` **(security)**. The
  shared socket was named after host, port and user only, so such a profile rode the
  connection another profile had opened — and closed that connection on its way out. The
  socket name now includes a fingerprint of the credentials: the profile is refused by
  authentication and the neighbouring window keeps its channel. Profiles that share
  credentials still share one connection.

### Fixed — the warning now matches the danger
Found on a fresh production server: the audit stayed silent where the machine stood
unprotected, and a warning fired where a file was being read. Both halves were harmful —
silence reads as "checked, clean", and noise on routine work teaches you to skip warnings.
- `ssh_audit_baseline`: `PasswordAuthentication yes` is critical on any port. The flag used
  to require port 22 as well, so a server that allows password login on a non-standard port
  — that is, one somebody had already configured by hand — got no critical flag at all.
- `ssh_audit_baseline`: the port from `sshd -T` is compared with the sockets sshd actually
  listens on, and a mismatch is its own warning. On Ubuntu 22.04+ the port is set by
  `ssh.socket` and the config disagrees silently; the dangerous direction is a config with a
  non-standard port while 22 is what is open. No listeners to compare with means the config
  port is reported as unconfirmed rather than as fact.
- `ssh_audit_baseline`: the firewall section takes part in the classification. It was
  collected and printed but produced no flag whatsoever, so a machine with ufw off, an
  `ACCEPT` policy and no rules got an empty findings list. Presence of filtering is judged by
  the `INPUT` chain policy, not by the number of rule lines.
- `ssh_audit_baseline`: ports published by docker are checked in the `nat` table. Those rules
  run before the ufw rules, so `ufw status` could honestly say `deny (incoming)` while a
  container port was open to the internet — and the report said the firewall was on.
- `ssh_exec`: warnings read the command position instead of searching the text. `reboot` as
  the command is a call; `reboot` inside a path, an argument or a quoted string is not — so
  `test -f /var/run/reboot-required` no longer prints "reboot detected", a file that any
  audit reads, this server's own included. SQL warnings fire only when a database client is
  the command being run. Wrappers (`sudo`, `timeout 5`, `nice -n 10`, `env VAR=1`) are seen
  through, and a separator inside quotes no longer starts a new command.

### Fixed — answers that no longer claim more than was checked
Every tool below used to report a check it had not performed. The three outcomes —
done, failed, nothing to check with — are now distinct in the answer itself.
- `ssh_audit_baseline`: sections that were not requested are no longer printed as facts
  ("firewall inactive", "0 updates"); an unknown name in `include` is refused with the
  list of valid sections instead of yielding an empty report; `ufw` and `iptables` report
  `not installed` / `NOT CHECKED` / their real state separately; unreadable `sshd -T`
  says so and points at `include_sudo_sections` instead of printing empty fields.
- `ssh_tls_check`: the Let's Encrypt renewal hook has four distinct answers — not
  readable (retry with `sudo`), Let's Encrypt not installed, installed without a hook,
  hook configured. The tool accepts `sudo` for this check.
- `ssh_snapshot`: memory percentage is computed after converting units, so a server
  reporting `506Mi` of `3.8Gi` no longer shows `13316% used`; CPU usage is derived from
  the idle share and parses both procps and BusyBox `top`; missing `systemctl` and
  missing `ss`/`netstat` are reported as `NOT CHECKED` rather than "no services, no
  ports". The `ss || netstat` fallback never actually ran (the trailing `sort` returned
  0), so BusyBox servers now list their listening ports for the first time.
- `ssh_file_write`: the answer says whether the sha256 was verified, could not be
  verified (no `sha256sum`, no `openssl`), or was not requested.
- `ssh_upload`: `owner` without `sudo: true` is reported as not applied — for single
  files and for directories, where `chown` was not even attempted.
- `ssh_snapshot` no longer loses readings on a server that cuts channels opened in a
  burst (dropbear does). Exit code 255 with no output at all is now recognised as a
  closed channel rather than a value, and retried immediately for reads that declared
  themselves safe to repeat — `ssh_exec` running `exit 255` still answers `Exit code:
  255`. Reads run four at a time, a lost reading yields an empty metric instead of an
  empty report, and an unread core count or load average says `NOT CHECKED` instead of
  showing `0 cores`. Measured: twelve consecutive router snapshots, twelve complete
  answers, unchanged timing elsewhere.
- `ssh_file_read` refuses a file that is not valid UTF-8 instead of returning it as
  damaged text, and points at `binary: true`. A 4096-byte random file used to come back
  with 1736 replacement characters and no warning; written back, it was a different file.
  In a batch only the damaged file is refused. Text with Cyrillic or emoji is unaffected.
- `ssh_snapshot` says why the error log is silent instead of leaving the section out:
  no `/var/log/syslog`, not readable, or the read did not go through. A read that fails
  under `sudo` is retried without it, so a server that has no `sudo` at all still gets a
  precise answer. A service whose status could not be read is printed as `? NOT CHECKED`
  rather than vanishing from the list.
- `ssh_audit_baseline` asks about the sshd config always. It used to appear only with
  `include_sudo_sections: true`, so a full audit under root stayed silent about password
  login; that flag now selects how the config is read, not whether the section exists.
- A timeout is answered in the time it names. `ssh_exec` with `timeout: 3000` used to answer
  after ~8 s: the ssh client dies on SIGTERM within milliseconds, but its streams are held
  open by the shared master process, which only lets go when the remote command ends — so
  the answer waited for the server-side guard instead. A process we killed is now awaited by
  its own exit, with 200 ms for the tail of its output. Measured: 8123 ms → 3231 ms
  (debian), 8117 → 3218 (alpine), 8071 → 3220 (router); a 200 000-line output still arrives
  whole.
- `ssh_log_search` takes `maxMatches` (default 200 per log file). The limit is set by grep
  itself (`-m`), not by a trailing `head` that would return 0 for a missing file and make
  "no matches" indistinguishable from a failed read, and the answer says when it was cut.
  A real journal used to come back as 3736 lines in one answer. Context lines do not count
  against the limit.
- Answers no longer show the kitchen. An error names the path you asked for instead of the
  staging name the data travelled through (`/etc/nginx.conf`, not
  `/etc/.upload-7952b8939bc0.nginx.conf`) — the address of a leftover backup copy is still
  printed, because that one is really on the server. Where a message names both paths — the
  rename that puts the prepared copy in place — the temp one is marked `(staging copy)`:
  without it the two collapsed into one and the refusal read as `mv -T -- '/etc/hosts'
  '/etc/hosts'`, a file renamed onto itself. A missing local file is refused with
  `local_path does not exist: …` instead of a raw `ENOENT` stack line.
  `ssh_disk_breakdown` prints titled sections instead of its `__SSH_MCP_DISK_SEP__` markers,
  and says `not installed` where it used to echo `NO_DOCKER`.
- `ssh_service_status` tells apart three outcomes. A raw systemctl message no longer stands
  in the `enabled` field next to `?` in the others: with no systemd on the server all three
  fields say `NOT CHECKED`, an unknown unit says `no unit by that name`, and a running
  service reads as before. The restart pause is asked for by the name systemd actually
  prints (`RestartUSec`), so the field is a value — `on-failure (after 100ms)` — instead of
  a permanent `(?s)`.
- Two installs into the same path: the loser now says what happened. The refusal used to be
  the utility's own line (`mv: cannot stat …`), which says nothing about a parallel install
  or about the data being intact. The cause is asked of the server rather than parsed out of
  the message: a target that vanished between the survey and the replacement was moved away
  by someone else (nothing was changed here), a target that could not be taken was claimed by
  someone else (the prepared copy stayed where it was, and its address is in the warnings).
  The utility's line is kept after `Details:`.
- The search for leftovers next to the target no longer passes a cut-off listing off as the
  whole picture. The transport reports when output hit the 10 MiB limit; that flag now
  travels with the list, and the answer says the search was incomplete — including when
  nothing was found, since an empty list out of a cut-off answer proves nothing. Measured on
  a directory of 40 001 files whose listing is 10 680 045 bytes: before, debian answered with
  no warning at all.
- A glob pattern in `ssh_log_search` and `ssh_log_tail` names files again. The pattern is
  expanded on the server by `find` matching the file name, not by the shell, so the quoting
  that protects a name with a space, `$(…)` or a newline stays in place — measured on all
  three lab servers with such names present. The pattern is supported in the file name only
  (`/var/*/app.log` is refused by name), a path that exists under its own name is read as
  itself, and at most 50 matching files are read, with a note in the answer when there were
  more. A pattern that matches nothing is refused as `no files match "…"` instead of the
  utility's message.
- The mount-point check tells "not a mount point" from "there was nothing to check with".
  The device numbers are asked for with `stat -c`, a GNU and BusyBox option; a server whose
  `stat` speaks another syntax (BSD, macOS) answered nothing, and the silence was read as a
  clean result. Such a server now installs as before — the check never blocked anything by
  itself — but the answer carries a note that the check did not run. Measured on debian and
  alpine with `stat` replaced by a BSD-like one: the note appears, and disappears again once
  the real `stat` is back. The rename stays the real guard: `mv -T` onto a mount point is
  refused by both coreutils (`Device or resource busy`) and BusyBox (`Resource busy`),
  measured on a live bind mount, with the target left intact.
- Disk, memory and listener readings are no longer taken by column position. The disk
  overview of `ssh_snapshot` picked its rows by device name (`^/dev/`), so the root
  filesystem was missing on every container — where it sits on overlay — and the list
  showed the files bind-mounted over it instead. It now reads `df -hT`, drops kernel
  pseudo filesystems by type and shows one row per device. A filesystem name too long for
  its column, which `df` wraps onto a second line, keeps its name; a row neither tool can
  read is printed as `NOT CHECKED` instead of disappearing. `available` memory is read by
  column name, so `free` from procps older than 2014 — which has no such column — reports
  `n/a` rather than its cache size. A listening port is taken after the last colon of the
  address, so an IPv6-only listener (`[::]:4847`) is no longer skipped.
- A working directory the server cannot enter now stops the call. `cwd` used to be joined
  as `cd <dir> && <command>`, and `&&` binds only up to the first `;`: everything after it
  ran in the home directory and the call ended with code 0. `cwd: "/opt/app"` with a typo
  and `rm -rf ./cache; systemctl restart app` deleted files where nobody asked and reported
  success. The join is now `cd <dir> || exit 1; <command>` — the command text is left
  untouched — and a failed `cd` ends every call shape with a non-zero code: single command,
  `;`-chain, batch, `sudo`, and a detached job (whose `exit_code` is non-zero as well).
- A refused destructive command is marked as a failure (`isError`). The wording of the
  refusal is unchanged, but a client that reads the flag rather than the text no longer
  takes a blocked `rm -rf` for a completed one.
- A batch of files that failed completely is a failed call. `ssh_file_read` and
  `ssh_file_write` used to answer `Read 2 files:` over two errors, without the failure flag,
  because the header counted what was attempted. It now counts what succeeded — `Read 0/2
  files:` — and zero successes marks the call as failed, exactly as the single-file form
  already did. A partial result stays a success with ✓/✗ per file.
- `ssh_job_output` and `ssh_job_kill` tell a missing job from an empty one. A job id from
  another server (or a typo) used to answer `0 bytes total` and `never recorded a pid`; both
  now say `no such job on the server`, the same answer `ssh_job_status` already gave.
- `ssh_audit_baseline` no longer counts services and updates it could not count. `0 running
  services` and `0 upgradable packages` appeared on servers with no `systemctl`, no `apt`,
  or a systemd that does not answer. Those sections are now left out and listed in
  `unavailable` with the reason; a real zero from a working `apt` is still reported as zero.
- `ssh_snapshot` tells a silent systemd from a server without services. With `systemctl`
  installed but no systemd running, every probe answered with an error that `|| echo
  inactive` turned into "stopped", and the report printed `No active services detected`. The
  snapshot now asks the bus itself first and says `NOT CHECKED: systemd did not answer on
  this server`; servers without `systemctl` keep their previous wording.

### Known limitations
These ship with the release. Each is recorded in `docs/tech-debt/` with measurements.
- **Cancelling a call does not stop the work on the server.** Cancellation now reaches the
  transport and drops the local `ssh` client immediately, but a command already started on
  the machine runs to its end — closing the channel does not kill what is behind it
  (measured). A long transfer still runs until its `timeout`, set before it starts. File
  transfers and the system snapshot do not take cancellation at all, deliberately: one has
  a window where stopping would leave the target empty, the other would come back with
  blanks instead of a refusal (`TD-08`). Work that has to be stoppable from outside can be
  started with `detach: true` and stopped by `ssh_job_kill` — that path knows the pid.
- **The mount-point check needs a `stat` that speaks the GNU or BusyBox syntax.** On a
  server whose `stat` differs (BSD, macOS), the check does not run and says so; the install
  proceeds, and the rename stays the real guard (`TD-09`).

## [1.3.2] - 2026-06-20

### Fixed
- `ssh_upload` / `ssh_exec` with `sudo: true` no longer fail on shell constructs.
  Previously `sudo <command>` was prepended literally, so any command containing a
  subshell `(...)`, `if/elif/fi`, or a pipe (e.g. the sha256 verify command) produced
  `bash: syntax error near unexpected token '('` and the upload's integrity check was
  silently skipped. Sudo commands are now wrapped as `sudo bash -c '<command>'`, so the
  remote shell interprets the construct under root. Non-sudo commands are unchanged —
  they already run through the remote login shell via `client.exec`.
  - File: `src/managers/ssh-executor.ts` (`execute`)

## [1.3.1] - 2026-05-03

### Documentation
- README: expanded v1.3.0 tool documentation
  - `ssh_audit_baseline` — added flags table (`include`, `include_sudo_sections`, `compact`), output format description, subset-include example
  - `ssh_disk_breakdown` — added sections table (df, du_path, docker, journald, var_log, cache) and defaults
  - `ssh_service_status` — added sections table (status, is_enabled, show, log) and unit name validation note
  - Transfer section — added file-size guidance (when to use `ssh_file_write` vs `ssh_upload`)
  - `ssh_upload` / `ssh_download` — replaced inline parameter lists with full tables
  - Caveat extended for `recursive + sudo` workflow and symlink behavior on recursive uploads
  - Installation: added `npx` variant and npm link
- LICENSE / package.json / README: removed author full name (kept GitHub handle `@hypnosis`)

## [1.3.0] - 2026-05-03

### Added — Transfer & Audit Sprint

**SFTP Transfer Tools (Sprint 6) 📦**
- `ssh_upload` — binary-safe file/directory upload through SFTP with sha256 verify and atomic rename
- `ssh_download` — binary-safe download with sha256 verify
- Native ssh2 SFTP channel piggy-backed on the existing connection pool — no extra deps
- Concurrent fastPut chunks (default concurrency=4)
- Atomic semantics: temp file next to target + mv (avoids EXDEV across FS borders)
- sudo path: stage in /tmp under user → `sudo install -m mode -o owner src dst`
- sha256 fallback: tries sha256sum, falls back to openssl dgst -sha256

**Audit Tools (Sprint 6) 🔍**
- `ssh_audit_baseline` — single-batch baseline: hostname, disk, mem, net listeners, sshd config, services, docker, firewall, updates with auto-classification CRITICAL/WARNING/OK
- `ssh_tls_check` — TLS expiry + SAN match + issuer chain + Let's Encrypt renew_hook detection
- `ssh_disk_breakdown` — top-N largest dirs + docker df + journald + cache breakdown
- `ssh_service_status` — combined systemctl status + journalctl tail in one call

**ssh_file_write extensions (back-compat)**
- New per-file flags: `verify` (sha256 after write), `atomic` (.tmp + rename), `binary` (content as base64; uploaded via SFTP)
- Routing: any of verify/atomic/binary OR size > 256KB → SFTP path; otherwise legacy heredoc fast path
- sudo write: stage in /tmp + `sudo install` (avoids sftp under root)

**ssh_file_read extensions (back-compat)**
- New `binary: true` — reads via SFTP, returns base64 (binary-safe; legacy `cat` over PTY corrupts binaries)

### Changed
- Connection pool: added `getSftp()` helper around `client.sftp()` for tool reuse
- SSHManager.uploadFile/downloadFile: implemented (were `throw new Error('not implemented yet')`)
- Total tool count: 8 → 14

### Technical Details
- New file: `src/tools/transfer-tool.ts` — TransferTool with ssh_upload, ssh_download
- New file: `src/tools/audit-tool.ts` — AuditTool with 4 audit primitives
- New file: `src/utils/sha256.ts` — local + remote hashing helpers
- New file: `src/utils/tmp-name.ts` — atomic temp/staging path generators
- New tests: `tests/unit/sha256.test.ts` (8 tests), `tests/unit/tmp-name.test.ts` (9 tests)
- 77 total tests passing

### Documentation
- New: docs/transfer.md (SFTP transfer guide)
- New: docs/audit.md (audit tools guide)
- README.md: updated tool count and added Transfer/Audit sections

## [1.2.2] - 2026-01-12

**Note on version jump (1.0.1 → 1.2.2):** This release combines changes from multiple development sprints that were documented in CHANGELOG as versions 1.1.0, 1.1.1, 1.2.0, and 1.2.1, but were never released as separate git tags or npm packages. To maintain consistency with the [Keep a Changelog](https://keepachangelog.com/) standard (every version in CHANGELOG must have a corresponding git tag), all these changes have been consolidated into version 1.2.2.

**Why not 2.0.0?** This is not a breaking change release. All changes are backward compatible - existing functionality continues to work, and new features are additive. According to [Semantic Versioning](https://semver.org/), breaking changes would require a major version bump (2.0.0). The jump from 1.0.1 to 1.2.2 reflects the accumulation of multiple minor feature releases (Sprints 2-5) that were developed but not individually released.

### Added - Major Features Update (Sprints 2-5) 🚀

**Sprint 2: Connection Pool & Performance 🚀**
- **Connection Pool (Singleton)** - Reuse SSH connections for all commands
- **Keep-alive mechanism** - Automatic pings every 10 seconds to maintain connection
- **Auto-reconnect** - Automatic reconnection on connection loss
- **Idle cleanup** - Automatic closure of unused connections after 30 seconds
- **Graceful shutdown** - Proper closure of all connections on server stop
- **Pool metrics** - Pool usage statistics (cache hit/miss, reconnects, total commands)
- ⚡ **6-10× faster** for sequential commands (16s → 2.5s for 10 commands)
- ⚡ **6-10× faster** for batch operations
- ⚡ Cache hit rate >80% for repeated commands
- ⚡ One connection per profile instead of N connections for N commands

**Sprint 3: Path Security & Tilde Expansion 🛡️**
- **Tilde Expansion:**
  - Automatic tilde expansion - `~/file` automatically expands to `$HOME/file` on remote server
  - Support for ~user paths - `~username/file` properly handled by shell
  - Works in all file/log tools - `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`, `ssh_log_search`
- **Path Security (Optional):**
  - PathValidator utility - New optional security layer for path validation
  - Whitelist support - `allowedPaths` to restrict access to specific directories
  - Blacklist support - `deniedPaths` to block access to sensitive paths
  - Path traversal protection - `allowTraversal: false` prevents `../` attacks
  - Path length limits - `maxPathLength` to prevent extremely long paths
  - Per-profile configuration - Add `pathSecurity` to any SSH profile
- **Security Improvements:**
  - Dual quoting strategy - Single quotes (default) for safety, double quotes only for `$HOME`
  - Comprehensive escaping - Prevents variable expansion, command substitution, history expansion
  - Injection protection - Safe handling of special characters in paths (`;`, `$`, `` ` ``, `!`)

**Sprint 4: Timeout & Error Handling 🔧**
- **Retry Mechanism:**
  - Automatic retry - Connection failures automatically retry up to 3 times
  - Exponential backoff - Delays increase progressively (1s, 2s, 4s)
  - Smart retry logic - Retries only temporary errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND)
  - No retry for auth errors - Authentication failures fail immediately (no wasted attempts)
- **Enhanced Error Messages:**
  - ECONNREFUSED - "Check if SSH server is running and port is correct"
  - ETIMEDOUT - "Check firewall rules and network connectivity"
  - ENOTFOUND - "Check hostname/IP address in profile configuration"
  - Authentication failed - "Check username, SSH key path, and passphrase"
  - Invalid SSH key - "Check file exists and has correct permissions (600)"
  - Timeout after retries - "Check network connectivity and SSH server availability"

**Sprint 5: Profiles Reload & Monitoring 📊**
- **Profile Reload:**
  - Automatic reload - SSH profiles reload automatically when `SSH_PROFILES_FILE` changes
  - File watcher - Monitors profile file for changes (can be disabled with `SSH_MCP_PROFILES_WATCH=false`)
  - Cache with TTL - Profiles cached for 60 seconds (configurable with `SSH_MCP_PROFILES_CACHE_TTL`)
  - Manual reload - `ssh_monitor(action="reload")` to force reload profiles
  - Config change detection - ConnectionPool detects profile config changes and reconnects automatically
- **Monitoring Tool (ssh_monitor):**
  - stats - Get connection pool statistics (cache hit rate, active connections, metrics)
  - reload - Reload SSH profiles without server restart
  - test - Test connection to profile with timing metrics
  - list - List all available profiles with default marked
- **Enhanced Logging:**
  - Context logger - `logger.context('ModuleName')` for scoped logging
  - Performance timer - `logger.time('label')` for measuring operation duration
  - Configurable logging - `SSH_MCP_LOG_LEVEL`, `SSH_MCP_LOG_TIMESTAMP`, `SSH_MCP_LOG_COLORS`

**Environment Variables:**
- `SSH_MCP_LOG_LEVEL` - Log level: debug, info, warn, error (default: info)
- `SSH_MCP_LOG_TIMESTAMP` - Show timestamps: true, false (default: true)
- `SSH_MCP_LOG_COLORS` - Enable colors: true, false (default: false)
- `SSH_MCP_POOL_IDLE_TIMEOUT` - Connection idle timeout in ms (default: 30000)
- `SSH_MCP_POOL_KEEPALIVE_INTERVAL` - Keep-alive interval in ms (default: 10000)
- `SSH_MCP_PROFILES_CACHE_TTL` - Profile cache TTL in ms (default: 60000)
- `SSH_MCP_PROFILES_WATCH` - Watch profiles file: true, false (default: true)

### Changed - Performance & Developer Experience
- **SSHManager** - Uses ConnectionPool instead of creating new connection for each command
- **SSHExecutor** - Delegates connection management to SSHManager with pool
- **executeBatch** - Optimized to use single connection for all commands
- **All Tools** - Pass profileName for connection identification in pool
- **profile-resolver.ts** - Profiles now cached with TTL and auto-reload support
- **connection-pool.ts** - Detects profile config changes and reconnects automatically
- **logger.ts** - Enhanced with context logger and performance timer
- **index.ts** - Added MonitoringTool registration (8 tools total now)
- **file-tools.ts** - Added `expandRemoteTilde()`, `escapeForSingleQuotes()`, `escapeForDoubleQuotes()`, `buildSafeCommand()`
- **log-tools.ts** - Added `expandRemoteTilde()`, `escapeForSingleQuotes()`, `escapeForDoubleQuotes()`, `buildSafePath()`
- **All file/log operations** - Now use secure quoting strategy with proper escaping
- **ConnectionPool** - Integrated retry mechanism with exponential backoff
- **createConnection()** - Wrapped in `retryWithTimeout()` for automatic retry
- **connectClient()** - Separated single connection attempt for retry logic
- **Error messages** - Enhanced with specific troubleshooting hints

### Fixed
- **Connection Pool metrics** - Fixed negative `activeConnections` value (now calculated dynamically from pool size)
- **Session metrics auto-reset** - Metrics automatically reset when all connections close (session-based metrics, prevents memory leak)
- **Race condition** - Fixed race condition in timeout handler (resolveOnce/rejectOnce in ssh-manager.ts)
- **ISSUE-001** - Tilde (`~`) not expanding in file paths (now works correctly)
- **ARCH-004** - Incomplete path escaping (now escapes all special characters)
- **ARCH-005** - No path validation (now optional PathValidator available)
- **ARCH-007** - Profiles singleton without reload (now auto-reload with file watcher)
- **Temporary network failures** - Now automatically retry instead of failing immediately
- **Authentication errors** - No longer retry (fail fast with helpful message)
- **Timeout errors** - Clear error messages with context about what failed
- **No monitoring** - Added ssh_monitor tool for diagnostics and stats
- **No profile reload** - Profiles reload automatically or manually without server restart

### Technical Details
- New file: `src/managers/connection-pool.ts` - ConnectionPool Singleton for connection management
- New file: `src/tools/monitoring-tool.ts` - MonitoringTool with 4 actions
- New file: `src/utils/path-validator.ts` - PathValidator class with security rules
- New tests: `tests/unit/path-security.test.ts` - Comprehensive tests for tilde expansion and path validation
- File watcher using Node.js `fs.watch()` for instant profile reload
- Profile cache with TTL fallback if file watcher fails
- Map<profileName, PooledConnection> for storing active connections
- Automatic cleanup of idle connections every 10 seconds
- Thread-safe access to pool via async locks
- Logging of all pool operations (cache hit/miss, reconnects, cleanup)
- **retry.ts** - Integrated into ConnectionPool
- **createSSHRetryPredicate()** - Fixed to check auth errors first (case-insensitive)
- **retryWithTimeout()** - 3 attempts, 10s timeout per attempt, exponential backoff
- **Error context** - All errors include host, port, username for debugging
- **22 new tests** - Comprehensive error handling test suite
- **60 total tests** - All passing ✅

### Documentation
- Added Environment Variables section to README.md
- Added ssh_monitor examples to README.md
- Updated tool count from 7 to 8 commands
- Documented profile reload behavior
- Added Path Security section to README.md with configuration examples
- Updated BUGLIST.md - closed ISSUE-001, ARCH-004, ARCH-005
- Added Security section to README.md explaining quoting strategy
- Documented tilde expansion in usage examples
- Error handling improvements documented
- Retry mechanism explained

## [1.0.1] - 2026-01-12

### Added
- Input validation for array parameters in all tools (ssh_exec, ssh_file_read, ssh_log_tail, ssh_log_search)
- Centralized array validator utility (`array-validator.ts`) for reusable validation logic
- Clear error messages when using single quotes instead of double quotes in arrays
- Improved description in `ssh_exec` tool schema with examples of correct syntax
- Documentation about array syntax requirements in README.md
- Array validator documentation (docs/ARRAY_VALIDATOR.md)

### Fixed
- Fixed issue where array commands with single quotes (`['cmd1', 'cmd2']`) caused parsing errors
- Added validation to prevent execution of malformed command arrays

### Changed
- Refactored array validation to centralized utility (DRY principle)
- Applied validation to all tools with array parameters for consistency

### Documentation
- Added array syntax guidelines to README.md usage examples
- Updated DEBUG_BATCH_EXEC.md with problem solution and explanation
- Added ARRAY_VALIDATOR.md with validator API documentation
- Improved tool descriptions for AI assistants with explicit examples

## [1.0.0] - 2026-01-XX

### Added
- Initial release
- 7 core SSH tools (exec, file operations, logs, snapshot)
- SSH profile support from JSON file
- Retry logic for network errors
- Security warnings for dangerous commands
- sudo support for all commands

[1.3.1]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.1...v1.2.2
[1.0.1]: https://github.com/hypnosis/ssh-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/hypnosis/ssh-mcp-server/releases/tag/v1.0.0
