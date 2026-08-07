/**
 * Unit tests for askpass secret delivery and runtime detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureAskpassScript,
  selectSecret,
  buildRunnerEnv,
  SECRET_ENV_VAR,
  ASKPASS_SCRIPT_NAME,
} from '../../src/runner/askpass.js';
import {
  parseSshVersion,
  computeRuntime,
  resolveControlDir,
  toCapabilities,
  assertProfileSupported,
  type SshRuntime,
} from '../../src/runner/runtime-check.js';
import { SSHUnsupportedConfigError } from '../../src/runner/errors.js';
import type { RunnerConfig } from '../../src/runner/ssh-args.js';

const KEY_PROFILE: RunnerConfig = {
  host: 'example.com',
  username: 'deploy',
  privateKeyPath: '/home/user/.ssh/id_ed25519',
};

const PASSWORD_PROFILE: RunnerConfig = {
  host: 'example.com',
  username: 'deploy',
  password: 'hunter2',
};

const ENCRYPTED_KEY_PROFILE: RunnerConfig = {
  ...KEY_PROFILE,
  passphrase: 'secret-passphrase',
};

function runtimeWith(overrides: Partial<SshRuntime> = {}): SshRuntime {
  return {
    available: true,
    version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1, LibreSSL 3.3.6' },
    multiplexing: true,
    askpassForce: true,
    controlDir: '/home/user/.ssh/ssh-mcp',
    ...overrides,
  };
}

describe('parseSshVersion', () => {
  it.each([
    ['OpenSSH_10.2p1, LibreSSL 3.3.6', 10, 2],
    ['OpenSSH_8.9p1 Ubuntu-3ubuntu0.4, OpenSSL 3.0.2 15 Mar 2022', 8, 9],
    ['OpenSSH_7.4p1, OpenSSL 1.0.2k-fips', 7, 4],
    ['OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3', 8, 6],
  ])('parses %j', (output, major, minor) => {
    const version = parseSshVersion(output);
    expect(version?.major).toBe(major);
    expect(version?.minor).toBe(minor);
  });

  it('returns undefined for unrecognised output', () => {
    expect(parseSshVersion('some other ssh implementation')).toBeUndefined();
  });
});

describe('computeRuntime', () => {
  const controlDir = '/home/user/.ssh/ssh-mcp';

  it('marks ssh unavailable when no version was detected', () => {
    const runtime = computeRuntime({ platform: 'linux', version: undefined, controlDir });
    expect(runtime.available).toBe(false);
    expect(runtime.multiplexing).toBe(false);
  });

  it('enables multiplexing on a modern posix client', () => {
    const runtime = computeRuntime({
      platform: 'darwin',
      version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1' },
      controlDir,
    });
    expect(runtime.multiplexing).toBe(true);
    expect(runtime.askpassForce).toBe(true);
  });

  it('disables multiplexing on Windows and explains why', () => {
    const runtime = computeRuntime({
      platform: 'win32',
      version: { major: 8, minor: 6, raw: 'OpenSSH_for_Windows_8.6p1' },
      controlDir,
    });
    expect(runtime.available).toBe(true);
    expect(runtime.multiplexing).toBe(false);
    expect(runtime.multiplexingDisabledReason).toMatch(/Windows/);
  });

  it('disables multiplexing below OpenSSH 5.6', () => {
    const runtime = computeRuntime({
      platform: 'linux',
      version: { major: 5, minor: 5, raw: 'OpenSSH_5.5p1' },
      controlDir,
    });
    expect(runtime.multiplexing).toBe(false);
    expect(runtime.multiplexingDisabledReason).toMatch(/5\.6/);
  });

  it.each([
    [8, 4, true],
    [8, 3, false],
    [9, 0, true],
    [7, 9, false],
  ])('reports askpassForce for OpenSSH %i.%i as %s', (major, minor, expected) => {
    const runtime = computeRuntime({
      platform: 'linux',
      version: { major, minor, raw: `OpenSSH_${major}.${minor}p1` },
      controlDir,
    });
    expect(runtime.askpassForce).toBe(expected);
  });

  /**
   * С OpenSSH 9.0 scp гоняет файлы поверх SFTP, и от этого зависит судьба
   * удалённого пути: в классическом протоколе его разбирает shell сервера,
   * в SFTP-режиме путь-приёмник берётся буквально.
   */
  it.each([
    [9, 0, true],
    [8, 9, false],
    [10, 2, true],
    [7, 4, false],
  ])('reports scpOverSftp for OpenSSH %i.%i as %s', (major, minor, expected) => {
    const runtime = computeRuntime({
      platform: 'linux',
      version: { major, minor, raw: `OpenSSH_${major}.${minor}p1` },
      controlDir,
    });
    expect(runtime.scpOverSftp).toBe(expected);
  });

  it('exposes capabilities in the shape argument building expects', () => {
    const caps = toCapabilities(
      computeRuntime({
        platform: 'darwin',
        version: { major: 10, minor: 2, raw: 'OpenSSH_10.2p1' },
        controlDir,
      })
    );
    expect(caps).toEqual({
      multiplexing: true,
      controlDir: '/home/user/.ssh/ssh-mcp',
      scpOverSftp: true,
    });
  });
});

describe('resolveControlDir', () => {
  it('defaults to a directory under ~/.ssh, not the shared temp dir', () => {
    const dir = resolveControlDir({});
    expect(dir).toMatch(/[\\/]\.ssh[\\/]ssh-mcp$/);
    expect(dir).not.toMatch(/^\/tmp/);
  });

  it('honours an explicit override', () => {
    expect(resolveControlDir({ SSH_MCP_CONTROL_DIR: '/custom/dir' })).toBe('/custom/dir');
  });
});

describe('assertProfileSupported', () => {
  it('accepts a key-only profile on any client', () => {
    expect(() => assertProfileSupported(KEY_PROFILE, runtimeWith({ askpassForce: false }))).not.toThrow();
  });

  it('accepts a password profile on OpenSSH 8.4+', () => {
    expect(() => assertProfileSupported(PASSWORD_PROFILE, runtimeWith())).not.toThrow();
  });

  it('rejects a password profile on an older client with actionable advice', () => {
    const runtime = runtimeWith({
      askpassForce: false,
      version: { major: 8, minor: 3, raw: 'OpenSSH_8.3p1' },
    });
    expect(() => assertProfileSupported(PASSWORD_PROFILE, runtime)).toThrow(SSHUnsupportedConfigError);
    expect(() => assertProfileSupported(PASSWORD_PROFILE, runtime)).toThrow(/OpenSSH 8\.4\+/);
  });

  it('rejects an encrypted-key profile on an older client', () => {
    const runtime = runtimeWith({ askpassForce: false });
    expect(() => assertProfileSupported(ENCRYPTED_KEY_PROFILE, runtime)).toThrow(SSHUnsupportedConfigError);
  });
});

describe('selectSecret', () => {
  it('returns nothing for a plain key profile', () => {
    expect(selectSecret(KEY_PROFILE)).toBeUndefined();
  });

  it('returns the passphrase when a key is configured', () => {
    expect(selectSecret(ENCRYPTED_KEY_PROFILE)).toBe('secret-passphrase');
  });

  it('returns the password when there is no key', () => {
    expect(selectSecret(PASSWORD_PROFILE)).toBe('hunter2');
  });

  it('prefers the passphrase when both are present alongside a key', () => {
    const both: RunnerConfig = { ...ENCRYPTED_KEY_PROFILE, password: 'hunter2' };
    expect(selectSecret(both)).toBe('secret-passphrase');
  });
});

describe('ensureAskpassScript', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-askpass-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an executable script readable only by the owner', () => {
    const scriptPath = ensureAskpassScript(dir);
    expect(scriptPath).toBe(join(dir, ASKPASS_SCRIPT_NAME));
    const mode = statSync(scriptPath).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('reads the secret from the environment instead of storing it', () => {
    const contents = readFileSync(ensureAskpassScript(dir), 'utf8');
    expect(contents).toContain(`$${SECRET_ENV_VAR}`);
    expect(contents).toContain('#!/bin/sh');
  });

  it('is idempotent and restores permissions on an existing file', () => {
    ensureAskpassScript(dir);
    const scriptPath = ensureAskpassScript(dir);
    expect(statSync(scriptPath).mode & 0o777).toBe(0o700);
  });

  // A rewrite in place truncates the file first, and a neighbouring ssh running
  // the script at that moment prints nothing instead of the secret. Swapping a
  // fully written file in leaves no such window — the inode tells the two apart.
  it('swaps a new file in instead of rewriting the script in place', () => {
    const scriptPath = ensureAskpassScript(dir);
    const firstInode = statSync(scriptPath).ino;

    ensureAskpassScript(dir);

    expect(statSync(scriptPath).ino).not.toBe(firstInode);
    expect(readFileSync(scriptPath, 'utf8')).toContain(`$${SECRET_ENV_VAR}`);
  });

  // A crash between the write and the rename leaves the temporary file behind.
  // Writing over it does not reset its permissions, so a leftover with loose
  // ones would be renamed into place and ssh could not execute the script.
  it('fixes permissions of a leftover temporary file before swapping it in', () => {
    const leftover = join(dir, `${ASKPASS_SCRIPT_NAME}.${process.pid}`);
    writeFileSync(leftover, '# stale', { mode: 0o644 });

    const scriptPath = ensureAskpassScript(dir);

    expect(statSync(scriptPath).mode & 0o777).toBe(0o700);
  });

  it('leaves no half-written leftovers in the control directory', () => {
    ensureAskpassScript(dir);
    ensureAskpassScript(dir);

    expect(readdirSync(dir)).toEqual([ASKPASS_SCRIPT_NAME]);
  });
});

describe('buildRunnerEnv', () => {
  const scriptPath = '/home/user/.ssh/ssh-mcp/askpass.sh';

  it('does not set askpass variables for a key-only profile', () => {
    const env = buildRunnerEnv({ config: KEY_PROFILE, askpassScriptPath: scriptPath, baseEnv: {} });
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env[SECRET_ENV_VAR]).toBeUndefined();
  });

  it('wires askpass for a password profile', () => {
    const env = buildRunnerEnv({ config: PASSWORD_PROFILE, askpassScriptPath: scriptPath, baseEnv: {} });
    expect(env.SSH_ASKPASS).toBe(scriptPath);
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env[SECRET_ENV_VAR]).toBe('hunter2');
  });

  it('does not mutate the base environment', () => {
    const baseEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    buildRunnerEnv({ config: PASSWORD_PROFILE, askpassScriptPath: scriptPath, baseEnv });
    expect(baseEnv[SECRET_ENV_VAR]).toBeUndefined();
    expect(baseEnv.SSH_ASKPASS).toBeUndefined();
  });

  it('drops an inherited secret variable so it cannot leak into ssh', () => {
    const baseEnv: NodeJS.ProcessEnv = { [SECRET_ENV_VAR]: 'leaked-from-parent' };
    const env = buildRunnerEnv({ config: KEY_PROFILE, askpassScriptPath: scriptPath, baseEnv });
    expect(env[SECRET_ENV_VAR]).toBeUndefined();
  });

  it('leaves the secret out when no askpass script is available', () => {
    const env = buildRunnerEnv({ config: PASSWORD_PROFILE, baseEnv: {} });
    expect(env[SECRET_ENV_VAR]).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
  });

  it('keeps an existing DISPLAY untouched', () => {
    const env = buildRunnerEnv({
      config: PASSWORD_PROFILE,
      askpassScriptPath: scriptPath,
      baseEnv: { DISPLAY: ':1' },
    });
    expect(env.DISPLAY).toBe(':1');
  });
});
