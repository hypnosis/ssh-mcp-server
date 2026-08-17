# Transfer Guide

Binary-safe file and directory transfer for SSH MCP Server, available since **v1.3.0**.

Two tools:

- `ssh_upload` — local → remote
- `ssh_download` — remote → local

Both ride the same shared connection as `ssh_exec` / `ssh_file_*` — one multiplexed OpenSSH
channel per destination, no extra handshake — and both default to **atomic** rename +
**sha256** verification.

---

## Why

`ssh_file_write` sends small content on the command's stdin. That is fine for configs, and
the write itself is atomic and can be verified — but two limits stay:

1. **The payload travels through the answer.** The whole content has to live in the LLM
   context and in Node's string heap before it goes anywhere. A tree or a tarball has no
   business being there.
2. **Text only on that route.** Binary content has to be base64 in the request, which
   inflates it by a third before it even starts moving.

`ssh_upload` removes both: the bytes go with `scp` over the connection the commands already
use, straight from disk to disk. Over 256 KB `ssh_file_write` hands the content to the same
route by itself — the difference is where the payload comes from, not how it lands.

---

## Architecture

```
┌──────────────────┐   one control socket per destination + credentials
│ shared OpenSSH   │ ──────────────┬──────────────────────────────────
│ master (system   │               │
│ ssh, ControlMaster)              │
└──────────────────┘               ▼
                          ┌─────────────────┐
                          │  ssh <command>  │  ssh_exec, ssh_file_* (content on stdin)
                          └─────────────────┘
                                   │
                          ┌─────────────────┐
                          │       scp       │  ssh_upload / ssh_download
                          └─────────────────┘
```

Key choices:

- **`scp` over the shared connection** — the transfer reuses the control socket the commands
  already use, so there is no second handshake and no second authentication.
- **Servers without an sftp subsystem** (routers, embedded devices, dropbear) are handled: on
  client 9.0+ `scp` rides SFTP, which such a server refuses; the transfer falls back to the
  classic scp protocol once and remembers that destination. A remote path containing a
  newline is refused on that path — the classic protocol cannot carry it safely.
- **Atomic rename**: write to a temp file next to the target — for `/etc/nginx/site.conf` that's `/etc/nginx/.upload-<rand>.site.conf` — then rename it onto the final path with `mv -T`, which replaces an existing file but refuses to land inside an existing directory instead of nesting into it. Rename within the same filesystem is atomic by POSIX guarantee. The temp file is co-located with the target on purpose — putting it in `/tmp` would cross filesystems on most servers and trigger `EXDEV`, forcing a non-atomic copy.
- **sha256 verification**: hash the local file with `crypto.createHash('sha256')` (streamed, constant memory), then run `sha256sum <path>` on the remote (fallback to `openssl dgst -sha256 <path>` if `sha256sum` is missing — common on minimal Alpine images). If neither is present, the answer says the check could not be made — "nothing to check with" is a success with a note, not a mismatch, and the file stays where it landed.
- **sudo path**: SFTP under `root` is awkward to enable on hardened servers. Instead the file travels to `/tmp/.ssh-mcp-upload-<rand>` as the SSH user, is copied next to the target with `sudo cp`, gets its `chmod`/`chown` there, and takes the target path by rename. `install` is not used: it copies over the target, destroying the old content before the new one is written, so an interrupted write would leave a truncated file and no intact copy anywhere.

---

## API

### `ssh_upload`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `local_path` | string | **required** | Local file or directory path |
| `remote_path` | string | **required** | Remote destination path |
| `mode` | string | — | Octal file mode, e.g. `"644"` or `"755"` |
| `recursive` | boolean | auto | Force directory mode. If omitted, auto-detected via local `stat()` |
| `atomic` | boolean | `true` | Ignored: the upload always writes to a temp path next to the target and renames it into place |
| `verify` | boolean | `true` | Compare local and remote sha256 after upload |
| `sudo` | boolean | `false` | Transfer to `/tmp`, copy next to the target under sudo, rename into place |
| `owner` | string | — | When `sudo=true`: `"user:group"` for `chown` on the temp path |
| `overwrite` | boolean | `true` | Allow overwriting an existing remote file |
| `concurrency` | number | — | Deprecated and ignored: `scp` has no chunk concurrency to tune |
| `timeout` | number | — | Give up after this many milliseconds; covers verification, `chmod -R` and cleanup. No limit by default |

Returns a text block summarizing: `remote_path`, `bytes`, `sha256` (if verified), `atomic`, `sudo`. For directories, also `files_uploaded`.

### `ssh_download`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `remote_path` | string | **required** | Remote source path |
| `local_path` | string | **required** | Local destination path |
| `recursive` | boolean | auto | Force directory mode. Auto-detected via remote `test -d` |
| `verify` | boolean | `true` | Compare local and remote sha256 after download |
| `concurrency` | number | — | Deprecated and ignored: `scp` has no chunk concurrency to tune |
| `timeout` | number | — | Give up after this many milliseconds. No limit by default |

Returns a text block with `bytes` (or file count for directories).

---

## Recipes

### Single file with verify (default)

```typescript
ssh_upload({
  profile: "production",
  local_path: "./build/app.tar.gz",
  remote_path: "/srv/releases/app-2026-05.tar.gz",
  mode: "644"
})
```

Flow: local sha256 → `scp` to `/srv/releases/.upload-<rand>.app-2026-05.tar.gz` → remote sha256 → compare → `mv -T` onto the target → `chmod 644`.

### Directory tree (recursive)

```typescript
ssh_upload({
  profile: "production",
  local_path: "./dist",
  remote_path: "/var/www/app/current",
  mode: "755"
})
```

Flow: walk local tree (skipping symlinks) → upload each file into a staging directory next to the target, e.g. `/var/www/app/.upload-<rand>.current/` → per-file sha256 verify → if the target doesn't exist yet, `mv -T` the staging directory straight onto it; if it does, `mv -T` the existing directory aside to `/var/www/app/.bak-<rand>.current` first, `mv -T` staging onto the target, then remove the set-aside copy.

### sudo write to /etc/nginx/conf.d/site.conf

```typescript
ssh_upload({
  profile: "production",
  local_path: "./nginx-site.conf",
  remote_path: "/etc/nginx/conf.d/site.conf",
  mode: "644",
  owner: "root:root",
  sudo: true
})
```

Flow: transfer into `/tmp/.ssh-mcp-upload-<rand>` as the SSH user → `sudo cp` it to `/etc/nginx/conf.d/.upload-<rand>.site.conf` → `rm -f` the /tmp copy → optional sudo sha256 verify of the temp path → `sudo chmod 644` + `sudo chown root:root` on it → `sudo mv -T` onto `/etc/nginx/conf.d/site.conf`. The target keeps its previous content until that last rename.

### Download a binary back

```typescript
ssh_download({
  profile: "production",
  remote_path: "/var/log/nginx/access.log.1.gz",
  local_path: "./logs/access.log.1.gz"
})
```

Flow: `scp` into a temp file next to the target → local sha256 → compare against remote sha256 → rename into place.

---

## Caveats

### `recursive` + `sudo` is not supported

Trying both flags together throws an explicit error. The right pattern is two-step:

```typescript
// Step 1: upload to a user-writable staging dir (no sudo)
ssh_upload({
  profile: "production",
  local_path: "./dist",
  remote_path: "/tmp/dist-staging",
  recursive: true
});

// Step 2: move into the protected location
ssh_exec({
  profile: "production",
  command: "sudo cp -r /tmp/dist-staging/. /var/www/app/current/ && sudo rm -rf /tmp/dist-staging",
  sudo: true
});
```

A native one-shot recursive-sudo path is still not implemented.

### sha256 tool fallback

The remote command first tries `sha256sum`. If absent (rare — most distros ship coreutils, but minimal Alpine and some BusyBox-only images do not), it falls back to `openssl dgst -sha256`. If neither is on the remote, the answer says the check could not be made and names why. That is not a failed comparison: the file stays where it landed, and nothing is removed. Treating "nothing to check with" as a mismatch is what used to make a correct upload look corrupt. To skip the check on purpose, pass `verify: false`.

### Atomic rename only within the same filesystem

`mv` is atomic only when source and target share a mount point. Putting the temp file in `/tmp` while the target lives on a separate volume would trigger an `EXDEV` cross-device link error and silently degrade to a copy + delete (not atomic). For this reason the temp path is always created **next to** the target, e.g. `/srv/releases/.upload-<rand>.app.tar.gz`. If the target's parent directory is read-only for the SSH user, the upload fails fast — that's intentional.

### Symlinks travel as copies, and a broken one stops the upload

The tree is counted the way `scp -r` will carry it: a link to a file is a file, a link to a
directory is entered, and both arrive as copies — links are not recreated as links on the
server. A broken link or a loop is refused **before** the transfer starts, with the offending
path named; `scp` would notice it too, but halfway through, with part of the tree already on
the server. If you need symlink fidelity, `tar -czf` the tree locally, upload the tarball and
unpack it with `ssh_exec`.

### File-size guidance

- **Text you are composing right now** (a config, a unit file): `ssh_file_write`. Up to
  256 KB it goes on the command's stdin; above that the same tool switches to the transfer
  route by itself, so there is no size at which the call stops working.
- **A file that already exists on disk**, of any size, and anything binary: `ssh_upload`. It
  streams from disk and never puts the content into the LLM context.
- **A directory**: `ssh_upload` — `ssh_file_write` takes files, one by one.

### Concurrency is no longer a knob

`concurrency` is accepted and ignored: `scp` has no per-file chunk parallelism to tune. The
parameter stays in the schema so existing calls keep working. Hashing a tree still runs
through a pool of 16 readers — that one is internal and not configurable.

### An error names the path you asked for

The data travels through a temp name next to the target, but a failure reports the path you
passed (`/etc/nginx/site.conf`), not `/etc/nginx/.upload-<rand>.site.conf`. Where a message
names both — the rename that puts the prepared copy in place — the temp one is marked
`(staging copy)`, so the two do not read as one path renamed onto itself. The exception is
a leftover backup copy: its real address is printed, because removing it is up to you.

### Two installs into the same path

Both trees stay whole; one wins and one is refused. The refusal says which of the two
happened — the target was moved away by the other install (nothing was changed here), or it
was claimed by it (the prepared copy stayed where it was, and the warnings carry its
address). The cause is asked of the server, not read out of the utility's message, which is
kept after `Details:`.

### A mount point as the target

A path on its own filesystem cannot be replaced by rename, so the install refuses it before
anything is written. The check compares device numbers via `stat -c`, which GNU and BusyBox
speak and BSD and macOS do not: on those servers the check cannot run, and the answer says
so instead of implying the target was checked and cleared. The install itself goes ahead —
the rename is the real guard, and `mv -T` onto a mount point is refused by the server with
the target left intact.

### Leftovers next to the target

Before installing, the directory is scanned for temp names left by interrupted operations;
they are named in the answer and never touched. If that listing hit the output limit, the
answer says the search was incomplete instead of presenting the part it managed to read as
the whole picture.
