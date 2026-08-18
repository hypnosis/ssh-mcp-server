/**
 * What the server can tell about its own setup, on request.
 *
 * The map in `instructions` travels in every session and has to stay short;
 * the shape of a config file and the list of configured machines are needed
 * now and then, so they wait here until someone asks. Without them an agent
 * invents a format, or goes asking a person for a password that the server
 * already holds.
 */

import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import { describeProfiles, getBrokenProfiles } from '../utils/profile-resolver.js';
import { describeBrokenProfile } from '../utils/profiles-file.js';
import { SECRETS_FILE_EXAMPLE } from '../utils/secrets-file.js';

export const CURRENT_PROFILES_URI = 'ssh://profiles/current';
export const PROFILES_EXAMPLE_URI = 'ssh://profiles/example';

export const RESOURCES: Resource[] = [
  {
    uri: CURRENT_PROFILES_URI,
    name: 'Configured profiles',
    description:
      'The machines this server can reach: name, host, port, user and whether the login ' +
      'uses a key or a password. No secret is included. Read it instead of asking anyone ' +
      'which servers exist.',
    mimeType: 'application/json',
  },
  {
    uri: PROFILES_EXAMPLE_URI,
    name: 'Profiles file format',
    description:
      'The shape of SSH_PROFILES_FILE with every field it accepts, and of the secrets file ' +
      'beside it. Read it before writing or editing a profile.',
    mimeType: 'text/markdown',
  },
];

/**
 * The profiles as they are configured now, plus the ones the loader rejected.
 *
 * A rejected profile is named on purpose: it exists in the file, and leaving it
 * out would send the reader hunting for a typo in a name that is really there.
 */
function currentProfiles(): string {
  return JSON.stringify(
    {
      profiles: describeProfiles(),
      broken: getBrokenProfiles().map((entry) => ({
        name: entry.name,
        problem: describeBrokenProfile(entry),
      })),
    },
    null,
    2
  );
}

const PROFILES_EXAMPLE = `# SSH profiles file

The path comes from the SSH_PROFILES_FILE environment variable. Every tool call
names one profile from here; there is no default profile.

\`\`\`json
{
  "secretsFile": "~/.ssh/mcp-secrets.json",
  "profiles": {
    "production": {
      "host": "server.example.com",
      "username": "deploy",
      "port": 22,
      "privateKeyPath": "~/.ssh/id_ed25519"
    },
    "router": {
      "host": "192.168.1.1",
      "username": "admin",
      "port": 2222,
      "strictHostKeyChecking": "accept-new"
    }
  }
}
\`\`\`

## Fields of a profile

- \`host\`, \`username\` — required, everything else is optional.
- \`port\` — defaults to 22.
- \`privateKeyPath\` — path to the private key; \`~\` stands for the home directory.
- \`passphrase\`, \`password\` — accepted here, but they belong in the secrets file.
- \`secretsFile\` — where this profile's password and passphrase are kept, overriding
  the file-level \`secretsFile\`. A relative path is taken from the profiles file.
- \`strictHostKeyChecking\` — \`yes\`, \`accept-new\` or \`no\`; defaults to \`accept-new\`.
- \`ignoreUserConfig\` — ignore the user's ~/.ssh/config for this profile.
- \`pathSecurity\` — \`{ "allowedPaths": [...], "deniedPaths": [...] }\`, absolute paths only.

A profile with a broken field is rejected on its own: its neighbours keep working,
and the rejection reaches whoever asks for that profile by name.

## Secrets file

Kept apart from the profiles file, which gets copied, shown and committed by
accident. It must be readable by its owner alone — \`chmod 600\`.

\`\`\`json
${SECRETS_FILE_EXAMPLE}
\`\`\`
`;

/** The body of one resource; an unknown uri is a mistake, not an empty answer */
export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  if (uri === CURRENT_PROFILES_URI) {
    return { uri, mimeType: 'application/json', text: currentProfiles() };
  }
  if (uri === PROFILES_EXAMPLE_URI) {
    return { uri, mimeType: 'text/markdown', text: PROFILES_EXAMPLE };
  }

  throw new Error(
    `Unknown resource: ${uri}. Available: ${RESOURCES.map((resource) => resource.uri).join(', ')}`
  );
}
