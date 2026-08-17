# Contributing

Patches are welcome. The rules below are short, and each exists because something
once broke without it.

## Getting set up

```bash
npm install
npm run build            # tsc
npx tsc --noEmit         # types, plus unused locals and parameters
npm run test:unit        # unit tests
npm run lab:up           # two throwaway containers to test against
npm run test:live        # the live suite, against those containers
```

You need Node 18+, Docker for the live suite, and an OpenSSH client on `PATH`.

## The one rule worth reading twice

**A feature is done when it has been proven on a live server, not when the code is
written and a mocked test is green.** Path restrictions once sat in this repository for
months marked complete: the code existed, the README described it, the tests passed —
and the profile field never reached the configuration, so nothing was ever restricted.
Mocks agree with whoever wrote them; a container does not.

The live suite runs against **two** containers on purpose — one BusyBox, one coreutils.
They disagree quietly: the timeout guard kills a command with code 124 on one and 143 on
the other, `sha256sum` escapes odd filenames on one and not the other, long options exist
on one and not the other. Tested on one is not tested.

## Tests

- A new test must be checked by breaking it. Change the expectation, watch it go red,
  put it back. A test that cannot fail is not a test.
- `npm run mutate -- HEAD` mutates only what you changed and takes seconds. Look at the
  surviving mutants in your own new code, not at the project-wide score — the score is
  meaningless here, because mutation runs unit tests only and the code covered by live
  tests looks worse than it is.
- Where the code has a pair — two exit codes, two loops, two branches — test both. A test
  on the first element leaves the second unguarded, and that is how a wrong exit code
  survived a full green suite.

## Style

- Comments name what a thing is for. They are not a changelog, not a record of the
  decision, and not a retelling of the code. Reasoning belongs in `docs/decisions/`.
- Match the surrounding code. `camelCase` for values and functions, `PascalCase` for
  types, `CONSTANT_CASE` for constants.
- Names say what they mean: `retryCount`, not `n`; `isAuthenticated`, not `flag`.

## Things that will not be merged

- A change that renames a tool or changes the shape of a profile without a strong reason —
  the package is published, and both are a public contract.
- Narrowing working functionality in the name of safety.
- A secret, a real hostname, or a real profile name in the repository. The lab password is
  the only credential that lives here, and it belongs to throwaway containers.

## Commits and pull requests

Conventional Commits, subject in English, 72 characters or fewer:

```
fix: expand the tilde once, so the profiles watcher sees a real path
```

In the pull request, say what you measured, not only what you wrote. A diff plus "tested
on Alpine and Debian, live suite green" is reviewable in minutes; a diff alone is not.
