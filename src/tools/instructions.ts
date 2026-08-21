/**
 * The index of the toolset, handed to the model at connect time.
 *
 * The client reads it once, on initialize, and puts it in the system prompt
 * before any call is made. It answers "which tool for which question" and the
 * few rules that hold for all of them; what each tool takes and returns lives
 * in the tool itself, so nothing is said twice.
 *
 * Every tool is named here on purpose: one missing from the index is one the
 * model will not choose.
 */

export const SERVER_INSTRUCTIONS = `SSH to configured machines. Every call names a profile; there is no default.

Credentials — key, passphrase or password — live in the profiles and the server reads
them itself. Never ask anyone for a secret; name the profile. When the person says "the
server" without naming one, ask ssh_monitor action:list for the names instead of guessing:
two profiles can point at the same address and differ only by name.

On a machine you have not touched yet: ssh_monitor action:test first — it names the
state (ready, limited, no-route, rejected) before anything else runs.

Which tool for which question:
  run something          ssh_exec — for what has no tool of its own
  slow work              ssh_exec detach:true, then ssh_job_status, ssh_job_output,
                         ssh_job_list, ssh_job_kill
  logs, any text search   ssh_log_search, ssh_log_tail
  files                   ssh_file_read, ssh_file_list, ssh_file_write
  move bytes              ssh_upload, ssh_download
  how it is doing         ssh_snapshot
  how it is set up        ssh_audit_baseline, ssh_tls_check
  something is wrong      ssh_service_status, ssh_disk_breakdown
  the connection          ssh_monitor

Reach for the specific tool before ssh_exec: each batches round trips, parses the
answer, verifies what it wrote, or says it could not check — where exec returns a
blank that reads as zero.

A detached job is followed, not waited for: ssh_job_status names its state and shows the
last lines it wrote, so every look says how far the work got. Look again when the work
would have moved on. Never sleep on this side and never hold a call open to wait.

Answers put the outcome in structuredContent wherever a schema is declared, and its
legend explains the words it uses. Read the fields; the text holds the detail.

Setup questions: ssh://profiles/current (what is configured here) and
ssh://profiles/example (the shape of the file).
`;
