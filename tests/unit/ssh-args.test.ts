/**
 * Unit tests for ssh/scp argument building
 */

import { describe, it, expect } from 'vitest';
import {
  buildCommonOptions,
  buildSshArgs,
  buildScpArgs,
  buildControlArgs,
  buildControlPath,
  buildRemoteSpec,
  normalizeLocalSpec,
  needsAskpass,
  type RunnerConfig,
  type SshCapabilities,
} from '../../src/runner/ssh-args.js';

const CAPS: SshCapabilities = {
  multiplexing: true,
  controlDir: '/home/user/.ssh/ssh-mcp',
};

const CAPS_NO_MUX: SshCapabilities = {
  multiplexing: false,
  controlDir: '/home/user/.ssh/ssh-mcp',
};

const KEY_PROFILE: RunnerConfig = {
  host: 'example.com',
  port: 22,
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

const PASSWORD_PROFILE: RunnerConfig = {
  host: 'example.com',
  port: 2222,
  username: 'deploy',
  password: 'hunter2',
};

const ENCRYPTED_KEY_PROFILE: RunnerConfig = {
  host: 'example.com',
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
  passphrase: 'secret-passphrase',
};

/** Найти значение -o опции по имени */
function optionValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-o' && args[i + 1].startsWith(`${name}=`)) {
      return args[i + 1].slice(name.length + 1);
    }
  }
  return undefined;
}

function hasOption(args: string[], name: string): boolean {
  return optionValue(args, name) !== undefined;
}

describe('ssh-args', () => {
  describe('secrets never reach argv', () => {
    it('omits password from every argument', () => {
      const args = buildSshArgs(PASSWORD_PROFILE, CAPS, 'whoami');
      expect(args.join(' ')).not.toContain('hunter2');
    });

    it('omits passphrase from every argument', () => {
      const args = buildSshArgs(ENCRYPTED_KEY_PROFILE, CAPS, 'whoami');
      expect(args.join(' ')).not.toContain('secret-passphrase');
    });

    it('omits password from scp arguments', () => {
      const args = buildScpArgs(PASSWORD_PROFILE, CAPS, 'upload', '/tmp/a', '/tmp/b');
      expect(args.join(' ')).not.toContain('hunter2');
    });
  });

  describe('BatchMode', () => {
    it('is enabled for key-only profiles so they never hang on a prompt', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS);
      expect(optionValue(args, 'BatchMode')).toBe('yes');
    });

    it('is disabled for password profiles — it would block askpass', () => {
      const args = buildCommonOptions(PASSWORD_PROFILE, CAPS);
      expect(hasOption(args, 'BatchMode')).toBe(false);
    });

    it('is disabled for encrypted-key profiles', () => {
      const args = buildCommonOptions(ENCRYPTED_KEY_PROFILE, CAPS);
      expect(hasOption(args, 'BatchMode')).toBe(false);
    });
  });

  describe('needsAskpass', () => {
    it('is false for a plain key profile', () => {
      expect(needsAskpass(KEY_PROFILE)).toBe(false);
    });

    it('is true when a password is configured', () => {
      expect(needsAskpass(PASSWORD_PROFILE)).toBe(true);
    });

    it('is true when a key passphrase is configured', () => {
      expect(needsAskpass(ENCRYPTED_KEY_PROFILE)).toBe(true);
    });
  });

  describe('multiplexing', () => {
    it('sets ControlMaster, ControlPath and ControlPersist when supported', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS);
      expect(optionValue(args, 'ControlMaster')).toBe('auto');
      expect(optionValue(args, 'ControlPath')).toBe('/home/user/.ssh/ssh-mcp/s-%C');
      expect(optionValue(args, 'ControlPersist')).toBe('600');
    });

    it('omits all control options when unsupported', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS_NO_MUX);
      expect(hasOption(args, 'ControlMaster')).toBe(false);
      expect(hasOption(args, 'ControlPath')).toBe(false);
      expect(hasOption(args, 'ControlPersist')).toBe(false);
    });

    it('honours a custom ControlPersist window', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS, { controlPersistSec: 1800 });
      expect(optionValue(args, 'ControlPersist')).toBe('1800');
    });

    it('keeps the control socket path short enough for a unix socket address', () => {
      // Лимит адреса unix-сокета на macOS — 104 байта. %C разворачивается в 40 hex-символов.
      const path = buildControlPath('/home/user/.ssh/ssh-mcp').replace('%C', 'a'.repeat(40));
      expect(path.length).toBeLessThan(104);
    });
  });

  describe('identity handling', () => {
    it('pins the identity file so the agent does not offer other keys', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS);
      expect(optionValue(args, 'IdentityFile')).toBe('/home/user/.ssh/id_ed25519');
      expect(optionValue(args, 'IdentitiesOnly')).toBe('yes');
    });

    it('disables pubkey auth for password-only profiles', () => {
      const args = buildCommonOptions(PASSWORD_PROFILE, CAPS);
      expect(optionValue(args, 'PubkeyAuthentication')).toBe('no');
      expect(optionValue(args, 'PreferredAuthentications')).toBe('password,keyboard-interactive');
      expect(optionValue(args, 'NumberOfPasswordPrompts')).toBe('1');
    });

    it('prefers the key when both key and password are present', () => {
      const both: RunnerConfig = { ...KEY_PROFILE, password: 'hunter2' };
      const args = buildCommonOptions(both, CAPS);
      expect(optionValue(args, 'IdentityFile')).toBe('/home/user/.ssh/id_ed25519');
      expect(hasOption(args, 'PubkeyAuthentication')).toBe(false);
    });
  });

  describe('host key policy', () => {
    it('defaults to accept-new', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS);
      expect(optionValue(args, 'StrictHostKeyChecking')).toBe('accept-new');
    });

    it('honours an explicit policy from the profile', () => {
      const strict: RunnerConfig = { ...KEY_PROFILE, strictHostKeyChecking: 'yes' };
      const args = buildCommonOptions(strict, CAPS);
      expect(optionValue(args, 'StrictHostKeyChecking')).toBe('yes');
    });
  });

  describe('user config', () => {
    it('reads ~/.ssh/config by default', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS);
      expect(args).not.toContain('-F');
    });

    it('ignores it when the profile asks to', () => {
      const isolated: RunnerConfig = { ...KEY_PROFILE, ignoreUserConfig: true };
      const args = buildCommonOptions(isolated, CAPS);
      expect(args).toContain('-F');
    });
  });

  describe('option-like values are rejected', () => {
    it('rejects a host that would be parsed as an ssh option', () => {
      const evil: RunnerConfig = { ...KEY_PROFILE, host: '-oProxyCommand=touch /tmp/pwned' };
      expect(() => buildCommonOptions(evil, CAPS)).toThrow(/must not start with/);
    });

    it('rejects an option-like username', () => {
      const evil: RunnerConfig = { ...KEY_PROFILE, username: '-oProxyCommand=x' };
      expect(() => buildCommonOptions(evil, CAPS)).toThrow(/must not start with/);
    });

    it('rejects an option-like private key path', () => {
      const evil: RunnerConfig = { ...KEY_PROFILE, privateKeyPath: '-oProxyCommand=x' };
      expect(() => buildCommonOptions(evil, CAPS)).toThrow(/must not start with/);
    });
  });

  describe('buildSshArgs', () => {
    it('puts host and command last, in that order', () => {
      const args = buildSshArgs(KEY_PROFILE, CAPS, 'ls -la /tmp');
      expect(args[args.length - 2]).toBe('example.com');
      expect(args[args.length - 1]).toBe('ls -la /tmp');
    });

    it('passes the command as a single argument, not split on spaces', () => {
      const command = 'echo "hello world"; rm -f /tmp/x';
      const args = buildSshArgs(KEY_PROFILE, CAPS, command);
      expect(args.filter((a) => a === command)).toHaveLength(1);
    });

    it('uses lowercase -p for the port', () => {
      const args = buildSshArgs(PASSWORD_PROFILE, CAPS, 'whoami');
      const portIndex = args.indexOf('-p');
      expect(portIndex).toBeGreaterThan(-1);
      expect(args[portIndex + 1]).toBe('2222');
    });

    it('defaults the port to 22', () => {
      const args = buildSshArgs(ENCRYPTED_KEY_PROFILE, CAPS, 'whoami');
      expect(args[args.indexOf('-p') + 1]).toBe('22');
    });

    it('adds -tt only when a tty is requested', () => {
      expect(buildSshArgs(KEY_PROFILE, CAPS, 'top')).not.toContain('-tt');
      expect(buildSshArgs(KEY_PROFILE, CAPS, 'top', { requestTty: true })).toContain('-tt');
    });
  });

  describe('buildControlArgs', () => {
    it('builds a check command', () => {
      const args = buildControlArgs(KEY_PROFILE, CAPS, 'check');
      const oIndex = args.lastIndexOf('-O');
      expect(args[oIndex + 1]).toBe('check');
      expect(args[args.length - 1]).toBe('example.com');
    });

    it('builds an exit command', () => {
      const args = buildControlArgs(KEY_PROFILE, CAPS, 'exit');
      expect(args[args.lastIndexOf('-O') + 1]).toBe('exit');
    });
  });

  describe('buildScpArgs', () => {
    it('uses uppercase -P for the port', () => {
      const args = buildScpArgs(PASSWORD_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b');
      const portIndex = args.indexOf('-P');
      expect(portIndex).toBeGreaterThan(-1);
      expect(args[portIndex + 1]).toBe('2222');
    });

    it('orders local then remote for upload', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b');
      expect(args[args.length - 2]).toBe('/tmp/a');
      expect(args[args.length - 1]).toBe('example.com:/etc/b');
    });

    it('orders remote then local for download', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'download', '/tmp/a', '/etc/b');
      expect(args[args.length - 2]).toBe('example.com:/etc/b');
      expect(args[args.length - 1]).toBe('/tmp/a');
    });

    it('adds -r only for recursive transfers', () => {
      expect(buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b')).not.toContain('-r');
      expect(
        buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b', { recursive: true })
      ).toContain('-r');
    });

    it('reuses the same control socket as ssh', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b');
      expect(optionValue(args, 'ControlPath')).toBe(buildControlPath(CAPS.controlDir));
    });
  });

  describe('remote and local path specs', () => {
    it('wraps IPv6 hosts in brackets', () => {
      expect(buildRemoteSpec('2001:db8::1', '/etc/hosts')).toBe('[2001:db8::1]:/etc/hosts');
    });

    it('leaves hostnames alone', () => {
      expect(buildRemoteSpec('example.com', '/etc/hosts')).toBe('example.com:/etc/hosts');
    });

    it('disambiguates a local path that looks remote', () => {
      expect(normalizeLocalSpec('weird:name.txt')).toBe('./weird:name.txt');
    });

    it('leaves absolute paths untouched', () => {
      expect(normalizeLocalSpec('/tmp/a:b')).toBe('/tmp/a:b');
    });

    it('leaves paths whose colon comes after a slash untouched', () => {
      expect(normalizeLocalSpec('dir/a:b')).toBe('dir/a:b');
    });
  });
});
