# Transfer (SFTP) Guide

Binary-safe file and directory transfer for SSH MCP Server, available since **v1.3.0**.

Two tools:

- `ssh_upload` — local → remote
- `ssh_download` — remote → local

Both ride on the same SSH connection pool used by `ssh_exec` / `ssh_file_*` (no extra TCP/TLS handshakes), and both default to **atomic** rename + **sha256** verification.

---

## Why

The legacy `ssh_file_write` path uses a heredoc (`cat > file <<EOF … EOF`) over the existing command channel. That works for tiny configs but has four problems for anything else:

1. **Binary-unsafe.** Heredoc and shell expansion mangle bytes (CR/LF translation, NUL termination, `$VAR` interpolation, backslash escaping). A `.tar.gz` written via heredoc is corrupt on arrival.
2. **No atomic semantics.** A failed write leaves a half-written file at the target path. Readers (nginx reload, systemd unit) see partial content.
3. **No integrity verification.** Network truncation or terminal-layer corruption goes unnoticed — there is no end-to-end checksum.
4. **Whole-payload memory pressure.** The full file content has to live in the LLM context and in Node's string heap before being shoved through the SSH channel.

`ssh_upload` removes all four limitations by using the **native SFTP** subsystem instead of `cat > file`.

---

## Architecture

```
┌──────────────┐      ssh2.Client (1 TCP connection per profile)
│ Connection   │ ───────────────────┬─────────────────────────────
│ Pool         │                    │
│ (singleton)  │                    │
└──────────────┘                    │
                                    ▼
                            ┌─────────────────┐
                            │ command channel │  ssh_exec, ssh_file_* (heredoc)
                            └─────────────────┘
                                    │
                            ┌─────────────────┐
                            │  SFTP channel   │  ssh_upload / ssh_download
                            │  client.sftp()  │  (fastPut / fastGet)
                            └─────────────────┘
```

Key choices:

- **`ssh2.Client.sftp()`** opens an SFTP subsystem on the **same** connection as the command channel — no second TCP handshake, no second auth round-trip. The pool exposes `getSftp(profileName, sshConfig)` to tools.
- **`fastPut` / `fastGet`** ship file bytes in 32 KB chunks with a configurable `concurrency` (default 4). The library handles flow-control internally.
- **Atomic rename**: write to `<remote_path>.tmp.<random>` next to the target, then `mv -f tmp final`. Rename within the same filesystem is atomic by POSIX guarantee. The temp file is co-located with the target on purpose — putting it in `/tmp` would cross filesystems on most servers and trigger `EXDEV`, forcing a non-atomic copy.
- **sha256 verification**: hash the local file with `crypto.createHash('sha256')` (streamed, constant memory), then run `sha256sum <path>` on the remote (fallback to `openssl dgst -sha256 <path>` if `sha256sum` is missing — common on minimal Alpine images). If neither is present a warning is logged and `verified` returns `false`.
- **sudo path**: SFTP under `root` is awkward to enable on hardened servers. Instead the file is staged in `/tmp/.ssh-mcp-upload-<rand>` as the SSH user, then moved into place with `sudo install -m <mode> -o <user> -g <group> stage target`. `install` is preferred over `cp + chmod + chown` because it sets mode/owner atomically and creates parent dirs as needed.

---

## API

### ssh_upload

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `local_path` | string | **required** | Local file or directory path |
| `remote_path` | string | **required** | Remote destination path |
| `mode` | string | — | Octal file mode, e.g. `"644"` or `"755"` |
| `recursive` | boolean | auto | Force directory mode. If omitted, auto-detected via local `stat()` |
| `atomic` | boolean | `true` | Write to `<path>.tmp.<rand>`, then `mv` |
| `verify` | boolean | `true` | Compare local and remote sha256 after upload |
| `sudo` | boolean | `false` | Stage in `/tmp`, then `sudo install` into target |
| `owner` | string | — | When `sudo=true`: `"user:group"` for `install -o/-g` |
| `overwrite` | boolean | `true` | Allow overwriting an existing remote file |
| `concurrency` | number | `4` | Parallel SFTP chunk concurrency for `fastPut` |

Returns a text block summarizing: `remote_path`, `bytes`, `sha256` (if verified), `atomic`, `sudo`. For directories, also `files_uploaded`.

### ssh_download

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `profile` | string | `"default"` | SSH profile name |
| `remote_path` | string | **required** | Remote source path |
| `local_path` | string | **required** | Local destination path |
| `recursive` | boolean | auto | Force directory mode. Auto-detected via remote `test -d` |
| `verify` | boolean | `true` | Compare local and remote sha256 after download |
| `concurrency` | number | `4` | Parallel SFTP chunk concurrency for `fastGet` |

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

Flow: local sha256 → SFTP `fastPut` to `…tar.gz.tmp.<rand>` → remote sha256 → compare → `mv -f` → `chmod 644`.

### Directory tree (recursive)

```typescript
ssh_upload({
  profile: "production",
  local_path: "./dist",
  remote_path: "/var/www/app/current",
  mode: "755",
  concurrency: 8
})
```

Flow: walk local tree (skipping symlinks) → upload each file into a staging dir `<remote>.tmp.<rand>/` → per-file sha256 verify → if all OK, `rm -rf old final` then `mv -f staging final`.

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

Flow: SFTP into `/tmp/.ssh-mcp-upload-<rand>` as the SSH user → `sudo install -m 644 -o root -g root /tmp/… /etc/nginx/conf.d/site.conf` → `rm -f` the stage → optional sudo sha256 verify of the final path.

### Download a binary back

```typescript
ssh_download({
  profile: "production",
  remote_path: "/var/log/nginx/access.log.1.gz",
  local_path: "./logs/access.log.1.gz"
})
```

Flow: SFTP `fastGet` → local sha256 → compare against remote sha256 → done.

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

A native one-shot recursive-sudo path is on the v1.4 roadmap.

### sha256 tool fallback

The remote command first tries `sha256sum`. If absent (rare — most distros ship coreutils, but minimal Alpine and some BusyBox-only images do not), it falls back to `openssl dgst -sha256`. If neither is on the remote, a warning is logged and the result is reported with `verified: false` (the file itself is still uploaded). To force-skip the check, pass `verify: false`.

### Atomic rename only within the same filesystem

`mv` is atomic only when source and target share a mount point. Putting the temp file in `/tmp` while the target lives on a separate volume would trigger an `EXDEV` cross-device link error and silently degrade to a copy + delete (not atomic). For this reason the temp path is always created **next to** the target, e.g. `/srv/releases/app.tar.gz.tmp.<rand>`. If the target's parent directory is read-only for the SSH user, the upload fails fast — that's intentional.

### Symlinks are ignored on recursive upload

The local walker (`walkLocalDir`) only follows directories and reads regular files. Symlinks are skipped — they are neither dereferenced nor recreated as links on the remote. If you need symlink fidelity, `tar -czf` the tree locally and `ssh_upload` the tarball, then unpack with `ssh_exec`. Native symlink support may be added in a follow-up.

### File-size guidance

- ≤ 256 KB and text-only: `ssh_file_write` legacy path is fine (and slightly faster — no second sha256 round-trip).
- 256 KB to ~1 MB and text: `ssh_file_write` with `atomic: true, verify: true` (auto-routes to SFTP).
- Anything binary, or > 1 MB: `ssh_upload`. It streams and never loads the file into the LLM context.

### Concurrency

`concurrency` controls the number of in-flight chunks **per file** for `fastPut`/`fastGet`. The default of 4 is a good trade-off for typical home-uplink → cloud-server scenarios. Bump to 8–16 for high-bandwidth fat pipes; drop to 1 if the server has tight per-connection bandwidth caps. For directory uploads, file-level parallelism uses the same value, so the worst-case in-flight chunk count is `concurrency × concurrency` — keep that in mind when tuning.
