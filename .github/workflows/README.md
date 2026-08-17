# GitHub Actions Workflows

## Publish to NPM

Automatic publishing to NPM when a version tag is created.

### Setup

1. **Create an NPM token:**
   - Go to https://www.npmjs.com/settings/YOUR_USERNAME/tokens
   - Create a new token of type "Automation" (for CI/CD)
   - Copy the token

2. **Add the token to GitHub Secrets:**
   - Go to Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: paste your NPM token
   - Click "Add secret"

### Usage

1. Update the version in `package.json`
2. Update `CHANGELOG.md` (if present)
3. Commit the changes:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to X.Y.Z"
   git push
   ```

4. Create and push the tag:
   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z: Description"
   git push origin vX.Y.Z
   ```

5. GitHub Actions will automatically:
   - Run the tests
   - Build the project
   - Publish to NPM
   - Create a GitHub Release

### Triggers

The workflow runs on push of a tag starting with `v` (for example, `v1.0.2`).
