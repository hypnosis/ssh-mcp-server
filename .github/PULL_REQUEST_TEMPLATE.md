# What this changes

<!-- One paragraph: what behaves differently now, and why it had to. -->

## How it was checked

<!--
Say what you measured, not only what you wrote. Delete what does not apply.
-->

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run test:unit` green
- [ ] `npm run test:live` green — **on both containers**, BusyBox and coreutils
- [ ] New tests were broken on purpose and went red
- [ ] `npm run mutate -- HEAD` — no surviving mutants in the new code
- [ ] Checked on a real server (say which kind: Linux, appliance, router)

## Notes for the reviewer

<!--
Anything that would take the reviewer an hour to find: a platform trap, an
ordering requirement, a case you decided not to handle and why.
-->

<!--
Reminder: no real hostnames, usernames or passwords in the diff or in this
description. Documentation and comments in English.
-->
