/**
 * Unit tests for ssh/scp argument building
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';
import {
  resolveControlPersistSec,
  resetControlPersistWarning,
  buildCommonOptions,
  buildSshArgs,
  buildScpArgs,
  buildControlArgs,
  buildControlPath,
  buildRemoteSpec,
  escapeRemotePath,
  prepareRemotePath,
  normalizeLocalSpec,
  needsAskpass,
  type RunnerConfig,
  type SshCapabilities,
} from '../../src/runner/ssh-args.js';

const CAPS: SshCapabilities = {
  multiplexing: true,
  controlDir: '/home/user/.ssh/ssh-mcp',
  scpOverSftp: true,
};

/** Клиент до 9.0: передача идёт классическим протоколом, путь читает shell сервера */
const CAPS_CLASSIC_SCP: SshCapabilities = { ...CAPS, scpOverSftp: false };

const CAPS_NO_MUX: SshCapabilities = {
  multiplexing: false,
  controlDir: '/home/user/.ssh/ssh-mcp',
  scpOverSftp: true,
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
      expect(optionValue(args, 'ControlPath')).toBe(buildControlPath(CAPS.controlDir, KEY_PROFILE));
      expect(optionValue(args, 'ControlPersist')).toBe('600');
    });

    it('omits all control options when unsupported', () => {
      const args = buildCommonOptions(KEY_PROFILE, CAPS_NO_MUX);
      expect(hasOption(args, 'ControlMaster')).toBe(false);
      expect(hasOption(args, 'ControlPath')).toBe(false);
      expect(hasOption(args, 'ControlPersist')).toBe(false);
    });

    it('honours a custom ControlPersist window from the environment', () => {
      process.env.SSH_MCP_CONTROL_PERSIST = '1800';
      try {
        const args = buildCommonOptions(KEY_PROFILE, CAPS);
        expect(optionValue(args, 'ControlPersist')).toBe('1800');
      } finally {
        delete process.env.SSH_MCP_CONTROL_PERSIST;
      }
    });

    it('keeps the control socket path short enough for a unix socket address', () => {
      // Лимит адреса unix-сокета на macOS — 104 байта
      const path = buildControlPath('/home/user/.ssh/ssh-mcp', KEY_PROFILE);
      expect(path.length).toBeLessThan(104);
    });

    it('даёт разным учётным данным разные сокеты: иначе профиль без ключа проедет по чужому', () => {
      const noCreds: RunnerConfig = { host: KEY_PROFILE.host, username: KEY_PROFILE.username };
      const otherKey: RunnerConfig = { ...KEY_PROFILE, privateKeyPath: '/home/user/.ssh/other' };

      expect(buildControlPath(CAPS.controlDir, noCreds)).not.toBe(
        buildControlPath(CAPS.controlDir, KEY_PROFILE)
      );
      expect(buildControlPath(CAPS.controlDir, otherKey)).not.toBe(
        buildControlPath(CAPS.controlDir, KEY_PROFILE)
      );
      expect(buildControlPath(CAPS.controlDir, PASSWORD_PROFILE)).not.toBe(
        buildControlPath(CAPS.controlDir, KEY_PROFILE)
      );
    });

    it('даёт одинаковым учётным данным один сокет: ради этого мультиплексирование и заводили', () => {
      const sameByAnotherName: RunnerConfig = { ...KEY_PROFILE };

      expect(buildControlPath(CAPS.controlDir, sameByAnotherName)).toBe(
        buildControlPath(CAPS.controlDir, KEY_PROFILE)
      );
    });

    it('разделяет назначения: тот же ключ на другом порту — другой сокет', () => {
      expect(buildControlPath(CAPS.controlDir, { ...KEY_PROFILE, port: 2222 })).not.toBe(
        buildControlPath(CAPS.controlDir, KEY_PROFILE)
      );
      expect(buildControlPath(CAPS.controlDir, { ...KEY_PROFILE, username: 'root' })).not.toBe(
        buildControlPath(CAPS.controlDir, KEY_PROFILE)
      );
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

    it('adds -p only when the local permissions must survive the trip', () => {
      expect(buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b')).not.toContain('-p');
      expect(
        buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b', { preserveMode: true })
      ).toContain('-p');
    });

    /**
     * Единственное, что обрывает зависшую передачу: своего потолка у неё нет
     * с тех пор, как его сняли (пункт 3.1). Если keepalive уйдёт из аргументов,
     * молчащий канал будет держать передачу вечно — и заметить это будет негде.
     */
    it('keeps the keepalive that ends a silent transfer', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b');

      expect(optionValue(args, 'ServerAliveInterval')).toBe('15');
      expect(optionValue(args, 'ServerAliveCountMax')).toBe('3');
    });

    it('reuses the same control socket as ssh', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b');
      expect(optionValue(args, 'ControlPath')).toBe(buildControlPath(CAPS.controlDir, KEY_PROFILE));
    });

    /**
     * Судьба удалённого пути зависит от направления и от клиента. Замерено на
     * живом сервере: цель загрузки в SFTP-режиме берётся буквально, и файл
     * `/tmp/a b.txt` лёг бы под именем `a\ b.txt` — после чего сверка, `mv` и
     * уборка искали бы путь без слэша и не находили.
     */
    it('leaves the upload target unescaped on a modern client', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/srv/my app.txt');
      expect(args[args.length - 1]).toBe('example.com:/srv/my app.txt');
    });

    it('escapes the download source on a modern client', () => {
      const args = buildScpArgs(KEY_PROFILE, CAPS, 'download', '/tmp/a', '/srv/star*name.txt');
      expect(args[args.length - 2]).toBe('example.com:/srv/star\\*name.txt');
    });

    it('escapes both directions on a classic client — the remote shell parses them', () => {
      const upload = buildScpArgs(KEY_PROFILE, CAPS_CLASSIC_SCP, 'upload', '/tmp/a', '/srv/my app.txt');
      const download = buildScpArgs(KEY_PROFILE, CAPS_CLASSIC_SCP, 'download', '/tmp/a', '/srv/my app.txt');

      expect(upload[upload.length - 1]).toBe('example.com:/srv/my\\ app.txt');
      expect(download[download.length - 2]).toBe('example.com:/srv/my\\ app.txt');
    });

    it('refuses a newline path on a classic client', () => {
      expect(() =>
        buildScpArgs(KEY_PROFILE, CAPS_CLASSIC_SCP, 'upload', '/tmp/a', '/srv/x\ntouch /tmp/pwned')
      ).toThrow(/newline/);
    });

    /**
     * Сервер без подсистемы sftp понимает только классический протокол.
     * Флаг просит о нём модерный клиент; путь при этом читает shell сервера,
     * то есть экранирование обязано включиться в обе стороны.
     */
    describe('legacyProtocol', () => {
      it('asks a modern client for the classic protocol', () => {
        const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b', {
          legacyProtocol: true,
        });
        expect(args).toContain('-O');
        expect(args.indexOf('-O')).toBeLessThan(args.length - 2);
      });

      it('does not add the flag when it was not asked for', () => {
        const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b');
        expect(args).not.toContain('-O');
      });

      /** До 9.0 классический протокол и так единственный, а флага ещё нет */
      it('omits the flag on a client that only speaks the classic protocol', () => {
        const args = buildScpArgs(KEY_PROFILE, CAPS_CLASSIC_SCP, 'upload', '/tmp/a', '/etc/b', {
          legacyProtocol: true,
        });
        expect(args).not.toContain('-O');
      });

      it('escapes both directions once the classic protocol is asked for', () => {
        const upload = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/srv/my app.txt', {
          legacyProtocol: true,
        });
        const download = buildScpArgs(KEY_PROFILE, CAPS, 'download', '/tmp/a', '/srv/my app.txt', {
          legacyProtocol: true,
        });

        expect(upload[upload.length - 1]).toBe('example.com:/srv/my\\ app.txt');
        expect(download[download.length - 2]).toBe('example.com:/srv/my\\ app.txt');
      });

      it('refuses a newline path once the classic protocol is asked for', () => {
        expect(() =>
          buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/srv/x\ntouch /tmp/pwned', {
            legacyProtocol: true,
          })
        ).toThrow(/newline/);
      });

      it('keeps -r alongside the flag', () => {
        const args = buildScpArgs(KEY_PROFILE, CAPS, 'upload', '/tmp/a', '/etc/b', {
          legacyProtocol: true,
          recursive: true,
        });
        expect(args).toContain('-O');
        expect(args).toContain('-r');
      });
    });
  });

  describe('remote and local path specs', () => {
    it('wraps IPv6 hosts in brackets', () => {
      expect(buildRemoteSpec('2001:db8::1', '/etc/hosts')).toBe('[2001:db8::1]:/etc/hosts');
    });

    it('leaves hostnames alone', () => {
      expect(buildRemoteSpec('example.com', '/etc/hosts')).toBe('example.com:/etc/hosts');
    });

    /**
     * Удалённый путь не остаётся у клиента: в классическом протоколе его
     * разбирает shell сервера, в современном шаблоны раскрывает сам клиент.
     * Замерено на живых серверах в обоих режимах: `star*name.txt` тащит три
     * посторонних файла везде, а `$(id)` в классическом исполняется.
     */
    it.each([
      ['пробел', '/tmp/sp ace.txt', '/tmp/sp\\ ace.txt'],
      ['звёздочка', '/tmp/star*name.txt', '/tmp/star\\*name.txt'],
      ['подстановка команды', '/tmp/$(id).txt', '/tmp/\\$\\(id\\).txt'],
      ['точка с запятой', '/tmp/a;rm -rf /.txt', '/tmp/a\\;rm\\ -rf\\ /.txt'],
      ['апостроф', "/tmp/it's.txt", "/tmp/it\\'s.txt"],
      ['обратный слэш', '/tmp/a\\b.txt', '/tmp/a\\\\b.txt'],
      ['вопросительный знак', '/tmp/a?.txt', '/tmp/a\\?.txt'],
    ])('escapes %s in the remote path', (_name, path, escaped) => {
      expect(escapeRemotePath(path)).toBe(escaped);
    });

    it('leaves ordinary paths untouched', () => {
      expect(escapeRemotePath('/var/www/app-1.2_3/index.html')).toBe('/var/www/app-1.2_3/index.html');
    });

    it('leaves non-ASCII names as they are', () => {
      // Кириллица в именах работает и без экранирования — менять её форму незачем
      expect(escapeRemotePath('/tmp/отчёт.txt')).toBe('/tmp/отчёт.txt');
    });

    it('leaves newlines alone: a backslash before one would swallow it', () => {
      // Замерено: в классическом режиме `\` + перевод строки означает
      // продолжение строки, и символ исчезает — имя становится другим
      expect(escapeRemotePath('/tmp/a\nb.txt')).toBe('/tmp/a\nb.txt');
    });

    it('leaves the tilde alone: the server expands it', () => {
      // `\~/app.conf` уехал бы в каталог с именем `~`, а не в домашний
      expect(escapeRemotePath('~/app.conf')).toBe('~/app.conf');
    });

    /**
     * У scp путь-источник и путь-приёмник живут по разным правилам. Замерено:
     * цель загрузки в SFTP-режиме берётся буквально, и экранирование сделало бы
     * обратный слэш частью имени — файл лёг бы под именем `a\ b.txt`.
     */
    it('leaves an upload target as it is: SFTP takes it literally', () => {
      expect(prepareRemotePath('/tmp/a b.txt', 'literal')).toBe('/tmp/a b.txt');
    });

    it('escapes a download source: the client expands globs in it', () => {
      expect(prepareRemotePath('/tmp/star*name.txt', 'glob')).toBe('/tmp/star\\*name.txt');
    });

    it('escapes a path parsed by the remote shell', () => {
      expect(prepareRemotePath('/tmp/$(id).txt', 'shell')).toBe('/tmp/\\$\\(id\\).txt');
    });

    it('rejects a newline for the classic protocol — it would run as a command', () => {
      expect(() => prepareRemotePath('/tmp/a\ntouch /tmp/pwned', 'shell')).toThrow(/newline/);
    });

    it('accepts a newline where the path is not parsed', () => {
      // В SFTP-режиме такое имя работает, и отказ отнял бы работающее
      expect(prepareRemotePath('/tmp/a\nb.txt', 'literal')).toBe('/tmp/a\nb.txt');
      expect(prepareRemotePath('/tmp/a\nb.txt', 'glob')).toBe('/tmp/a\nb.txt');
    });

    it('keeps the remote spec free of escaping decisions', () => {
      expect(buildRemoteSpec('example.com', '/tmp/a b')).toBe('example.com:/tmp/a b');
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

    /**
     * Локальный путь — первый позиционный аргумент scp. Ведущий дефис делает
     * его похожим на опцию: замерено, `scp -q -oNotARealOption=1 src dst`
     * съедает `src` как значение опции и копирует не тот файл.
     */
    it('disambiguates a relative local path that looks like an option', () => {
      expect(normalizeLocalSpec('-rf')).toBe('./-rf');
    });

    it('disambiguates a dashed filename with an extension', () => {
      expect(normalizeLocalSpec('-oProxyCommand=x')).toBe('./-oProxyCommand=x');
    });

    it('leaves a path whose dash is not the first character untouched', () => {
      expect(normalizeLocalSpec('sub/-file')).toBe('sub/-file');
    });

    it('leaves an already-disambiguated dashed path untouched', () => {
      expect(normalizeLocalSpec('./-rf')).toBe('./-rf');
    });
  });

  // Срок простоя приходит и в команду ssh, и в ответ о том, что осталось на
  // машине. Источник один, поэтому разбор значения проверяется отдельно
  describe('resolveControlPersistSec', () => {
    afterEach(() => {
      resetControlPersistWarning();
      vi.restoreAllMocks();
    });

    it('без переменной держит соединение прежние 600 секунд', () => {
      expect(resolveControlPersistSec({})).toBe(600);
      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '  ' })).toBe(600);
    });

    it('берёт из переменной целое число секунд', () => {
      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '30' })).toBe(30);
      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: ' 1800 ' })).toBe(1800);
    });

    it('ноль понимает как «закрывать сразу», а не как отсутствие значения', () => {
      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '0' })).toBe(0);
    });

    it('на непригодное значение берёт прежний срок', () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});

      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: 'soon' })).toBe(600);
      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '-5' })).toBe(600);
      expect(resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '1.5' })).toBe(600);
    });

    it('предупреждение называет и полученное значение, и запасное', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: 'soon' });

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('soon');
      expect(message).toContain('600');
      // Отказ обязан объяснить, какое значение подошло бы
      expect(message).toContain('whole number of seconds');
      expect(message).toContain('0 to close immediately');
    });

    it('молчит на пригодных значениях', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveControlPersistSec({});
      resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '0' });
      resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: '30' });

      expect(warn).not.toHaveBeenCalled();
    });

    it('повторяет предупреждение один раз, а не на каждую команду', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: 'soon' });
      resolveControlPersistSec({ SSH_MCP_CONTROL_PERSIST: 'later' });

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
