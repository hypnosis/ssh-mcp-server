# Security Policy

This server runs commands on live machines. A defect here is not a crashed page —
it is a command on the wrong server, a truncated file, or a password in a log. The
list below is what the project promises, and how to tell us when a promise breaks.

## Supported versions

| Version | Supported |
|---|---|
| 2.x | Yes |
| 1.x | No — the `ssh2` backend it was built on is gone |

## Reporting a vulnerability

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/hypnosis/ssh-mcp-server/security/advisories/new)**.
It stays between you and the maintainer until a fix ships.

Please do not open a public issue for anything that lets someone run a command they
should not, read a secret they should not, or destroy data without the guard firing.

What helps most, in order:

1. The exact tool call and profile shape that triggers it (secrets removed).
2. What you expected and what happened instead.
3. Your `ssh -V` and OS — behaviour differs between OpenSSH versions and between
   BusyBox and coreutils servers, and a report without them may not reproduce.

Expect a first reply within a few days.

## What the server does and does not promise

**It protects against the slip, not against you.** Two guards run before a command
leaves the machine: one refuses irreversible destruction (wiping a disk, dropping a
database, `crontab -r`), one refuses a recursive delete aimed at the filesystem root,
a home directory or a system tree, symlinks included. Both step aside for an explicit
`# CONFIRMED-DESTRUCTIVE` marker. Neither is a policy engine, and `ssh_exec` is not a
sandbox: it runs the command you give it, `&&` and `;` included, because that is what
the tool is for.

**Secrets stay out of `argv` and out of logs.** A password reaches `ssh` through an
askpass helper that reads one environment variable of one child process, so `ps` does
not show it. It is never written to disk and is masked in this server's logs. Secrets
belong in a `secretsFile` that must be `chmod 600` — see
[docs/security.md](docs/security.md#credentials-keep-the-secret-out-of-the-profiles-file).

**Every call names its server.** There is no default profile. A call without a profile
is refused rather than sent to whichever entry happens to come first in the file.

**A transfer never destroys the only intact copy.** Data is written next to the target
under a temporary name and moved into place by a single rename. When verification is
impossible — no `sha256sum` on the server, output truncated, the guard killed the
command — the answer says "could not verify" instead of claiming a mismatch, because a
false mismatch would make the installer delete what it just delivered.

**What is out of scope.** Whoever can call this MCP server can reach every machine in
the profiles file with the rights of those accounts. The server does not authenticate
its caller — that is the MCP client's job. Restrict what an account may do on the
server side (a non-root user with narrow sudo), and use `pathSecurity` to fence off the
paths file tools may touch.

## Dependencies

One runtime dependency: `@modelcontextprotocol/sdk`. Nothing else is bundled — the SSH
work is done by the OpenSSH client already on your machine, so its patches are your
system's, not this package's.
