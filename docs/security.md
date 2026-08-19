# Security

How the server decides what to run, and how it handles the paths it is given. The line
between a warning and a refusal is drawn where the loss stops being recoverable: a command
that destroys the whole container of the data is refused, everything that can still be
undone is warned about and left to you.

## Two levels: warning and refusal

The server reads what a command is going to do and answers on one of two levels. The
check reads the command position, not the text: a name that starts a command is a call,
the same word inside a path, an argument or a quoted string is not.

| Level | What happens | When |
|---|---|---|
| ⚠️ Warning | the command **runs**, the warning goes with the answer | the damage can be undone or is limited to content |
| ⛔ Refusal | nothing is sent to the server | the loss is final: the container itself is gone |

```typescript
ssh_exec({ command: "reboot" })
// ⛔ BLOCKED: reboot restarts the machine, and the connection dies with it.
// The command was NOT executed.
// If this is intended, repeat it with the marker: reboot # CONFIRMED-DESTRUCTIVE

ssh_exec({ command: "chmod 777 /srv/app" })
// ⚠️  DANGEROUS COMMAND: chmod 777 detected — the command still runs

ssh_exec({ command: "test -f /var/run/reboot-required && cat /var/run/reboot-required" })
// no warning — nothing is being rebooted, a file is being read
```

**Refused** — the whole container stops existing, and what was inside cannot be read
back:

- `reboot`, `shutdown`, `halt`, `poweroff` — including behind `sudo`, `timeout`, `nice`, `env`
- `docker compose down -v`, `docker volume rm`, `docker system prune --volumes`
- `DROP DATABASE`, `dropdb`, `FLUSHALL`/`FLUSHDB` in `redis-cli`
- `crontab -r` — the whole job list of a user at once
- `mkfs`, `wipefs -a`, `lvremove`/`vgremove`/`pvremove`, `zfs destroy`, `btrfs subvolume delete`
- `dd of=` pointing at a device
- recursive deletion aimed at the root, a home or a system tree — see
  [`ssh_exec`](tools.md#ssh_exec---execute-commands) in the tool reference
- reading an object after the same call destroyed it: `rm -rf A && cp -r A A.bak`

**Warned about** — the container survives, the content changes:

- `chmod 777`
- `docker system prune -a`, `docker rm -f $(docker ps -aq)`
- `DROP TABLE`, `TRUNCATE`, `DELETE FROM` — only when a database client
  (`psql`, `mysql`, `sqlite3`, …) is the command being run

A refusal is not a dead end: repeating the command with the `# CONFIRMED-DESTRUCTIVE`
marker sends it as written. Rebooting a router guarded by the `router-no-reboot.sh` hook
needs **two** markers in one command — that hook has its own, `# CONFIRMED-REBOOT`, and
the two belong to different systems.

## What the guard does not see

The checks read the command text and nothing else. Four gaps are known and left open on
purpose:

- **Destruction and reading split across two calls.** `rm -rf A` in one call, `cp -r A
  A.bak` in the next — by the time the second call arrives the data is already gone. The
  server keeps no memory between calls: it would disagree with the server, where the path
  may have been recreated without us.
- **A single argument counts as the destination.** `rm -rf /srv/db && pg_restore
  /srv/db/dump.sql` passes — the only path is read as the place being written to.
- **The long form of an archiver key.** `tar czf` and `tar -czf` are understood,
  `tar --file X` is not.
- **A utility whose destination sits in the middle and is not named by a flag** is not
  parsed at all. The destination is looked up in one position — last, or named by `-t`,
  `of=`, the `f` key of `tar`, the first argument of `zip`.

Looking (`ls`, `test`, `stat`) and creating something empty (`mkdir`, `touch`, `mkfifo`)
do not count as reading: that is how you check the deletion went through, and how you
prepare the place again. So `rm -rf A B && mkdir -p A B` passes.

A command coming from a file the server never read is outside all of this: the guard
reads what it is given.

## Profiles: the machine is always named

A profile is a machine. There is no profile the server falls back to, and none is chosen
on your behalf — every call names the profile it talks to. A call without a name is
refused, and the refusal lists the names available to choose from.

This is deliberate. When a default existed, the machine a command reached depended on the
order of entries in the profiles file: adding an entry at the top silently moved every
unnamed call to a different server. A command that ran on the wrong machine cannot be
taken back afterwards, so guessing is not worth the keystrokes it saves.

Two consequences worth knowing:

- A profile the server cannot use for SSH — no `host`, no `username`, or `mode: "local"` —
  is skipped without an error, and asking for it by name says "not found". Fields the
  server does not recognise are left alone. A profiles file shared with other tools keeps
  working.
- A profile with a **broken** field (a port outside 1–65535, an unknown host-key policy, a
  malformed `pathSecurity` or `secretsFile`) is a different case: it is reported by name,
  field and value, and asking for it repeats that reason instead of quietly connecting
  with a default. Its healthy neighbours in the same file keep working.

## Credentials: keep the secret out of the profiles file

Prefer keys. Where a password or an encrypted key is unavoidable, the secret does not
belong in the profiles file — that file gets copied, pasted into issues and committed by
accident. Point at a separate file instead, with `secretsFile` at the top level, per
profile, or both:

```json
{
  "secretsFile": "~/.config/ssh-mcp/secrets.json",
  "profiles": {
    "production": { "host": "server.example.com", "username": "admin" },
    "appliance": {
      "host": "10.0.0.2",
      "port": 2222,
      "username": "operator",
      "secretsFile": "./appliance-secret.json"
    }
  }
}
```

The secrets file is a flat JSON keyed by profile name:

```json
{
  "production": { "password": "..." },
  "staging": { "passphrase": "..." }
}
```

What the server guarantees about it:

- **`chmod 600` or it is not read.** A secrets file others can read is refused the way
  `ssh` refuses a private key, and the refusal says which file and what to run.
- **A relative path is resolved from the profiles file**, not from whatever directory the
  MCP client happened to start the server in.
- **An unreadable secret breaks the profile, loudly.** Missing file, malformed JSON, wrong
  permissions — the profile is reported as broken rather than quietly connecting without a
  password, which would fail later as a confusing authentication error.
- **A profile with no entry in a shared secrets file is fine** — key-based profiles need
  none.
- **Inline `password` and `passphrase` still work**, so existing setups keep running, but
  the secrets file wins and a warning is logged.

**Where the secret travels.** Never in `argv`: the password is handed to `ssh` through an
askpass helper that reads it from the environment of that one child process, so `ps` on
the machine does not show it. It is not written to disk, and it is masked in this server's
logs. With multiplexing on, it is asked for once per connection window rather than once
per command. All of this is checked by the live suite, not only by unit tests.

## Recommendations

1. **Use SSH keys** instead of passwords; keep the passphrase in a secrets file
2. **Limit user permissions** (use non-root user with sudo)
3. **Regularly rotate keys**
4. **Keep the profiles and secrets files outside any repository**
5. **Check MCP server logs**

## Path handling & quoting

SSH MCP Server uses a secure quoting strategy to prevent injection attacks:

**Single Quotes:**
- Used for every path, including paths that contain `~`
- Prevents ALL expansions (variables, commands, globs)
- Example: `cat '/etc/hosts'` - safest option

**Inert inside a quoted path:**
- ✅ Separators and chaining — `;`, `&&`, `||`
- ✅ Variable expansion (`$VAR`)
- ✅ Command substitution (`` `cmd` ``, `$(cmd)`)
- ✅ History expansion (`!`)
- ✅ Glob expansion (`*`, `?`)

Four kinds of value cannot be quoted and are guarded differently: numbers (`lines`,
`context`, `top_n`) are re-validated as numbers rather than trusted from the request, mode
and owner travel to `chmod` and `install` as separate words, and a glob `pattern` has to
expand on the server — so it is escaped character by character instead of quoted.

**This is about values, not about the command.** A path or an argument reaches the server
quoted, so none of the above fires inside it. The command string you hand to `ssh_exec` is a
different matter: it is executed as written, `&&` and `;` included, because running shell
constructs is what the tool is for. `ssh_exec` is not a sandbox — what protects you there is
the destructive-command guard described above, not quoting.

**Tilde Expansion:**
- `~/file` → expanded on our side to the home directory reported by the SSH session
  (probed once per session, then cached) — the path reaches the server fully quoted
- `~user/file` → **rejected** with an explanation: writing to a guessed home directory is
  worse than refusing
- Under `sudo: true`, `~` still means the home of the **login** user, not root — the tool
  says so in its answer
- Works in: `ssh_file_read`, `ssh_file_write`, `ssh_file_list`, `ssh_log_tail`,
  `ssh_log_search`, `ssh_upload`, `ssh_download`

## Path security

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

The block goes inside a profile in `SSH_PROFILES_FILE`, next to `host` and `username`.

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
