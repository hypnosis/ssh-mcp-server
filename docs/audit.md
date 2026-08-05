# Audit Tools Guide

Read-only audit primitives for SSH MCP Server, available since **v1.3.0**.

Four tools, all built around the same idea: **collect a lot of evidence in one round-trip** instead of dragging a chatty agent across N separate `ssh_exec` calls.

- `ssh_audit_baseline` — system / disk / mem / net / ssh / services / docker / firewall / updates
- `ssh_tls_check` — TLS expiry + SAN + chain + Let's Encrypt renew_hook
- `ssh_disk_breakdown` — df + top-N du + docker df + journald + caches
- `ssh_service_status` — systemctl + journalctl tail in one call

---

## Why

Before v1.3.0 the typical `server-auditor` agent sequence looked like this: one `ssh_exec` for `df -hT`, another for `free -h`, another for `ss -tulpenH`, another for `docker ps -a`, another for `systemctl --failed`, and so on. Five to ten separate round-trips and five to ten disjoint stdout chunks the agent had to merge in its head.

`ssh_audit_baseline` collects all of them in **one** batched compound shell command, splits the output by sentinel markers, parses it into a structured JSON object, and on top of the raw data emits a human-readable shortlist of `CRITICAL` / `WARNING` / `OK` items the agent can act on directly. The other three tools follow the same pattern for their narrower domains.

---

## Tools

### ssh_audit_baseline

**Sections** (toggle via `include: [...]`):

| Section | Commands | Purpose |
|---------|----------|---------|
| `system` | `hostname`, `uptime`, `date -u`, `/etc/os-release`, `uname -r`, `/proc/loadavg` | Identification + load |
| `disk` | `df -hT` (tmpfs/devtmpfs/squashfs dropped while parsing — BusyBox `df` has no `-x`) | Filesystem usage by mount |
| `mem` | `free -h` (Linux) / `vm_stat` (macOS) | Memory totals |
| `net` | `ss -tulpenH` (fallback `netstat -tulpn`, then `NO_NET_TOOL`), `ip -br a` | Listening ports + interfaces |
| `ssh` | `sshd -T \| grep -E ...` | Effective sshd config (**requires sudo**) |
| `services` | `systemctl --failed`, `systemctl list-units --state=running \| wc -l` | Failed units + running count |
| `docker` | `docker ps -a --format ...`, `docker system df` | Containers + Docker disk |
| `firewall` | `ufw status verbose`, `iptables -nL \| wc -l` | Firewall posture |
| `updates` | `apt list --upgradable \| wc -l`, `test -f /var/run/reboot-required` | Pending package updates + reboot flag |

**Flags:**

- `include: ["disk", "mem", "services"]` — restrict to a subset (default: all except `ssh`)
- `include_sudo_sections: true` — enable the `ssh` section (runs the whole compound under sudo)
- `compact: true` (default) — trim long sections (listeners, interfaces, docker rows) to keep the response small for the LLM

**Output:**

A single text block with two parts:

1. Human-readable summary — host header, CRITICAL/WARNING shortlist, `NOT CHECKED` list, disk table, listeners, sshd line, services, docker, firewall, updates
2. `--- raw JSON ---` followed by the full structured result

**Sections that could not be checked** land in `unavailable` (and in the `NOT CHECKED` block) instead of quietly reading as zero: a server without `ss` and `netstat` used to report `listeners (0)`, which is "nothing is listening", not "there was nothing to look with". No red flag is raised for such a section.

**Auto red-flag classification:**

| Severity | Trigger |
|----------|---------|
| **CRITICAL** | filesystem ≥ 90% full |
| **CRITICAL** | `PermitRootLogin yes` |
| **CRITICAL** | `PasswordAuthentication yes` on port 22 |
| **WARNING** | filesystem 70–90% full |
| **WARNING** | one or more `Exited` containers |
| **WARNING** | one or more failed systemd units |
| **WARNING** | `/var/run/reboot-required` exists |
| **WARNING** | > 50 upgradable apt packages |
| **OK** | filesystem < 70% full (per mount) |

### ssh_tls_check

Pipes `openssl s_client -connect <domain>:<port> -servername <domain> -showcerts` into `openssl x509 -noout -dates -ext subjectAltName -issuer`, parses:

- `notAfter=...` → `not_after` ISO date
- computes `days_until_expiry`
- `X509v3 Subject Alternative Name` → list of DNS names → checks `san_includes_hostname`
- `issuer=...` → `issuer`

If `check_renew_hook: true` (default), additionally inspects:

- `/etc/letsencrypt/renewal/*.conf` for `renew_hook = ...`
- `/etc/letsencrypt/renewal-hooks/deploy/` for any deploy script

Returns UNKNOWN/CRITICAL/WARNING flags + structured JSON.

| Severity | Trigger |
|----------|---------|
| **UNKNOWN** | the certificate was never read — no `openssl` on the server, connection refused, domain unreachable. The reason is quoted from the command output; `not_after` and `san_includes_hostname` are `null`, and no certificate verdict is issued |
| **CRITICAL** | certificate expired |
| **CRITICAL** | ≤ 7 days until expiry |
| **CRITICAL** | SAN does not include the requested domain (only when the certificate was actually read) |
| **WARNING** | ≤ 30 days until expiry |
| **WARNING** | no Let's Encrypt deploy_hook configured (when `check_renew_hook: true`) |

### ssh_disk_breakdown

Single batched call collecting:

| Section | Command |
|---------|---------|
| `df` | `df -hT` |
| `du_<path>` | `du -shx <path>/* \| sort -rh \| head -<top_n>` for each entry in `paths` |
| `docker` | `docker system df -v` (or `NO_DOCKER`) |
| `journald` | `journalctl --disk-usage` (or `NO_JOURNALD`) |
| `var_log` | `du -sh /var/log/* \| sort -rh \| head -<top_n>` |
| `cache` | `du -sh "$HOME"/.cache/* \| sort -rh \| head -<top_n>` |

Defaults: `top_n: 20`, `paths: ["/"]`. `paths` is shell-quoted before interpolation.

### ssh_service_status

Single batched call collecting, for one systemd unit:

| Section | Command |
|---------|---------|
| `status` | `systemctl status <unit> --no-pager \| head -40` |
| `is_enabled` | `systemctl is-enabled <unit>` |
| `show` | `systemctl show <unit> --property=Restart,RestartSec,LoadState,ActiveState,SubState` |
| `log` | `journalctl -u <unit> -n <log_lines> --no-pager [--since <since>]` |

Defaults: `log_lines: 50`. `since` is optional and accepts any `journalctl --since` value (`"1h ago"`, `"2026-05-03"`, etc.). Unit name is validated against `^[a-zA-Z0-9@._-]+$` to keep the input safe for shell interpolation.

Returns a structured response with `enabled`, `active`, `restart`, the head of `systemctl status`, and the recent log tail.

---

## Pipeline (recommended audit order)

```typescript
// 1) One batched baseline → CRITICAL/WARNING shortlist
const baseline = ssh_audit_baseline({
  profile: "production",
  include_sudo_sections: true
});

// 2) If any disk is at >= 70% → drill down
ssh_disk_breakdown({
  profile: "production",
  top_n: 20,
  paths: ["/", "/var", "/home"]
});

// 3) For each public FQDN
ssh_tls_check({ profile: "production", domain: "app.example.com" });
ssh_tls_check({ profile: "production", domain: "api.example.com" });

// 4) For each failed unit reported in step (1)
ssh_service_status({ profile: "production", unit: "nginx.service", log_lines: 100 });
```

This pipeline covers ~80% of a typical server audit — system health, SSH posture, disk pressure, TLS validity, broken services — **without a single bare `ssh_exec` call**. The remaining 20% (app-specific health endpoints, custom checks, log searches) is what `ssh_exec` and `ssh_log_search` are for.

A few rules of thumb when using this pipeline:

- **Always start with `ssh_audit_baseline`.** It's cheap (one round-trip, ~1 second on most servers) and tells you which deeper tool to reach for next.
- **`ssh_tls_check` is per-domain.** If you have N FQDNs, run it N times — each call is independent and the results are small.
- **`ssh_disk_breakdown` is heavier** (multiple `du -shx` traversals); only invoke when the baseline flags a disk above 70%.
- **`ssh_service_status` replaces `systemctl status` + `journalctl -u` for diagnostics** — when an agent says "nginx is failing", this is the right tool, not two separate `ssh_exec` calls.
