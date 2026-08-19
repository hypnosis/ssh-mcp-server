# GitHub Actions Workflows

## Publish to NPM

Publishing happens on its own when a version tag is pushed. There is no token
anywhere: the workflow run proves its own identity to npm over OIDC, matched
against the trusted publisher configured for this repository and this workflow
file. Nothing is stored, so nothing expires and nothing can leak.

### How the trust is set up

Configured once on npmjs.com, on the package settings page, under **Trusted
Publisher**:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `hypnosis` |
| Repository | `ssh-mcp-server` |
| Workflow filename | `publish.yml` — the name only, no path |
| Environment name | empty — this workflow declares no environment |
| Allowed actions | `npm publish` |

The workflow needs `id-token: write` for this, which it already declares.
Publishing over OIDC also needs npm 11.5.1 or newer, which is why the job runs
on Node 24.

A mismatch in any of those fields is answered by the registry with 404 on the
package itself, which reads as "the package does not exist" and sends you
looking in the wrong place.

### Releasing a version

1. Set the version in `package.json` and in **both** places in `server.json`.
2. Write the section in `CHANGELOG.md`.
3. Refresh `package-lock.json` (`npm install --package-lock-only`), or `npm ci`
   fails on the first step of the run.
4. Commit, then tag and push:

```bash
git tag -a vX.Y.Z -m "Release X.Y.Z: what changed"
git push origin main
git push origin vX.Y.Z
```

The run then verifies the tag against `package.json` and both fields of
`server.json`, installs, runs the unit tests, builds, publishes to npm with a
signed provenance statement, registers the release in the MCP registry, and
creates the GitHub Release.

### Triggers

A push of a tag matching `v*.*.*`. Nothing else publishes.
