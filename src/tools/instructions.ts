/**
 * The map of the toolset, handed to the model at connect time.
 *
 * The client reads this once, on initialize, and puts it in the model's system
 * prompt before any call is made. It says what each tool does that ssh_exec
 * cannot — a round trip saved, an answer parsed, a write verified, a
 * measurement honestly marked as missing — because a model that only sees a
 * list of names reaches for the one tool that runs anything.
 *
 * Every tool is named here on purpose: a tool missing from the map is a tool
 * the model will not choose.
 */

export const SERVER_INSTRUCTIONS = `SSH access to remote machines. Every call names a profile; there is no default.

On a machine you have not touched yet, start with ssh_monitor action:test: it
names the state before anything else runs against it.

Reach for the specific tool before ssh_exec. Each one below does something exec
cannot: it batches round trips, parses the answer, verifies what it wrote, or
says it could not check — instead of returning a blank you would read as zero.

logs       ssh_log_tail and ssh_log_search take a list of files, and a glob in
           the file name, in one call. The glob is expanded by the server's
           find, not by its shell, so a name with a space or a newline stays a
           name. A result cut short says so. exec + tail/grep gives none of
           that and costs a round trip per file.

files      ssh_file_read takes a list of paths, ssh_file_list one directory.
           ssh_file_write takes a list of files with mode and sudo per file,
           writes each one beside its target and moves it into place, and with
           verify:true compares sha256 afterwards. exec + cat/echo has no such
           step: a half-written config is already live.

binaries   ssh_upload and ssh_download. Never move bytes as base64 through
           exec — output limits truncate it silently and the file lands broken.

health     ssh_snapshot for one machine at a glance. ssh_audit_baseline and
           ssh_tls_check return structured fields — read them, do not parse the
           text. What could not be measured says NOT CHECKED: that is neither
           zero nor healthy, and reporting it as either is a lie.

digging    ssh_service_status for one unit, ssh_disk_breakdown when a disk
           fills up. Each collects its evidence in one round trip and classifies
           it; exec + systemctl + du + find is four calls and no verdict.

slow work  ssh_exec with detach:true answers with a job id at once; without
           it a long command dies on the timeout with the work half done and out
           of reach. Follow it with ssh_job_status, ssh_job_output, ssh_job_list
           and stop it with ssh_job_kill. Of its three outcomes — running,
           finished, lost — lost is neither success nor failure.

is it up   ssh_monitor action:test answers with one of four states. limited
           means logged in, but the shell is the device's own CLI (routers,
           appliances): the connection is fine and ssh_exec with the vendor's
           own commands is all that runs there. The file tools, ssh_snapshot,
           ssh_audit_baseline, ssh_tls_check, ssh_disk_breakdown and
           ssh_service_status have nothing to work with on such a shell. Do not
           go fixing a network that works.

ssh_exec is for what has no tool of its own. It refuses a recursive delete aimed
at a system path and stops the whole batch; append # CONFIRMED-DESTRUCTIVE to
that one command when you mean it.`;
