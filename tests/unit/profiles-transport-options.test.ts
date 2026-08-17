/**
 * Unit tests for the transport options in the profiles file
 *
 * Поля добавляются аддитивно: файлы прежнего формата обязаны грузиться
 * без изменений, а новые настройки — доезжать до транспорта.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { loadProfilesFile } from '../../src/utils/profiles-file.js';
import { reloadProfiles, resolveSSHConfig } from '../../src/utils/profile-resolver.js';
import { buildScpArgs, buildSshArgs, type SshCapabilities } from '../../src/runner/ssh-args.js';
import { buildRunnerEnv, SECRET_ENV_VAR } from '../../src/runner/askpass.js';
import { createPathValidator } from '../../src/utils/path-validator.js';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const tempDirs: string[] = [];

/** Записать файл профилей и вернуть путь к нему */
function writeProfiles(profiles: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-mcp-profiles-'));
  tempDirs.push(dir);
  const path = join(dir, 'profiles.json');
  writeFileSync(path, JSON.stringify({ profiles }), 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Пройти путь «файл → загрузчик → конфигурация» целиком.
 *
 * Профиль собирается вручную дважды подряд — в загрузчике и в сборщике
 * конфигурации, — поэтому промежуточный объект ничего не доказывает: нужен
 * тот, у которого транспорт спрашивает, куда и чем подключаться.
 */
function configFromFile(fields: Record<string, unknown>): SSHConfig {
  const path = writeProfiles({
    production: { host: 'example.com', username: 'deploy', ...fields },
  });

  const previous = process.env.SSH_PROFILES_FILE;
  process.env.SSH_PROFILES_FILE = path;
  try {
    reloadProfiles();
    return resolveSSHConfig({ profile: 'production' });
  } finally {
    // Возвращаем окружение как было; без файла профилей перезагрузка
    // законно отказывается — соседние тесты от этого страдать не должны
    if (previous === undefined) delete process.env.SSH_PROFILES_FILE;
    else process.env.SSH_PROFILES_FILE = previous;
    try {
      reloadProfiles();
    } catch {
      /* профилей больше нет — так и было до теста */
    }
  }
}

const CAPS: SshCapabilities = {
  multiplexing: true,
  controlDir: '/tmp/ssh-mcp-test',
  scpOverSftp: true,
};

/** Значение, стоящее в аргументах сразу за флагом */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Значение опции `-o Name=value` */
function optionValue(args: string[], name: string): string | undefined {
  const option = args.find((arg, index) => args[index - 1] === '-o' && arg.startsWith(`${name}=`));
  return option?.slice(name.length + 1);
}

describe('profiles file: transport options', () => {
  it('доносит политику проверки ключа хоста до конфигурации', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        strictHostKeyChecking: 'yes',
      },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors).toEqual([]);
    expect(config?.profiles.production.strictHostKeyChecking).toBe('yes');
  });

  it('доносит отказ от пользовательского ~/.ssh/config', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', ignoreUserConfig: true },
    });

    expect(loadProfilesFile(path).config?.profiles.production.ignoreUserConfig).toBe(true);
  });

  it('профиль прежнего формата грузится без новых полей', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', privateKeyPath: '~/.ssh/id_ed25519' },
    });

    const profile = loadProfilesFile(path).config?.profiles.production;

    expect(profile?.strictHostKeyChecking).toBeUndefined();
    expect(profile?.ignoreUserConfig).toBeUndefined();
  });

  it('опечатка в политике проверки ключа хоста не проходит молча', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', strictHostKeyChecking: 'true' },
    });

    const { errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(/strictHostKeyChecking/);
  });
});

/**
 * Ограничения на пути.
 *
 * README обещает их с давних пор, но поле терялось дважды: загрузчик собирал
 * профиль по одному полю и про него не знал, а сборщик конфигурации не
 * переносил его дальше. Валидатор из-за этого не создавался ни разу — замерено
 * на живых серверах: запись в запрещённый каталог проходила успешно.
 */
describe('profiles file: ограничения на пути', () => {
  it('правила доезжают из файла до профиля', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        pathSecurity: { deniedPaths: ['/root'], allowedPaths: ['/var/www'] },
      },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors).toEqual([]);
    expect(config?.profiles.production.pathSecurity).toEqual({
      deniedPaths: ['/root'],
      allowedPaths: ['/var/www'],
    });
  });

  it('профиль без ограничений остаётся без них', () => {
    const path = writeProfiles({ production: { host: 'example.com', username: 'deploy' } });

    expect(loadProfilesFile(path).config?.profiles.production.pathSecurity).toBeUndefined();
  });

  /**
   * Испорченная запись обязана быть ошибкой: молча забытое правило выглядит
   * как включённая защита, которой на самом деле нет.
   */
  it.each([
    ['список вместо объекта', ['/root']],
    ['строка вместо списка путей', { deniedPaths: '/root' }],
    ['пустая строка в списке', { deniedPaths: ['/root', '  '] }],
    ['число в списке путей', { allowedPaths: [42] }],
    ['нечисловая длина пути', { maxPathLength: 'много' }],
    ['нелогическое allowTraversal', { allowTraversal: 'no' }],
    ['тильда в запрете', { deniedPaths: ['~/.ssh'] }],
    ['тильда в разрешении', { allowedPaths: ['~/data'] }],
    ['чужой дом в запрете', { deniedPaths: ['~deploy/.ssh'] }],
    ['относительный запрет', { deniedPaths: ['logs'] }],
    ['относительное разрешение', { allowedPaths: ['./data'] }],
    ['пробел перед правилом', { deniedPaths: [' /root'] }],
  ])('испорченные правила (%s) не проходят молча', (_name, pathSecurity) => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', pathSecurity },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(/pathSecurity/);
    expect(config?.profiles.production).toBeUndefined();
  });

  /**
   * Правило `~/.ssh` не совпало бы никогда: проверяемый путь приходит
   * раскрытым, а дом сервера отсюда не виден. Отказ обязан назвать само
   * правило — иначе человеку нечего исправлять в файле.
   */
  it('отказ по неабсолютному правилу называет правило и причину', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        pathSecurity: { deniedPaths: ['/root', '~/.ssh'] },
      },
    });

    const { errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toContain('~/.ssh');
    expect(errors.join(' ')).toMatch(/deniedPaths/);
    expect(errors.join(' ')).toMatch(/absolute/i);
  });

  // Правила в непричёсанном виде работали и работают: сужать нечего
  it('абсолютные правила со сдвоенным слэшем и `.` грузятся', () => {
    const path = writeProfiles({
      production: {
        host: 'example.com',
        username: 'deploy',
        pathSecurity: { deniedPaths: ['//root'], allowedPaths: ['/var/./www', '/var/log/'] },
      },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors).toEqual([]);
    expect(config?.profiles.production.pathSecurity).toEqual({
      deniedPaths: ['//root'],
      allowedPaths: ['/var/./www', '/var/log/'],
    });
  });

  /**
   * Второе звено той же цепочки: сборка конфигурации из профиля. Здесь поле
   * терялось отдельно от загрузчика, поэтому проверяется весь путь целиком —
   * от файла до того объекта, у которого инструменты спрашивают правила.
   */
  it('правила доходят до конфигурации, с которой работают инструменты', () => {
    expect(configFromFile({ pathSecurity: { deniedPaths: ['/root'] } }).pathSecurity).toEqual({
      deniedPaths: ['/root'],
    });
  });

  // Последнее звено: тот валидатор, который спрашивают инструменты
  it('запрет из файла доезжает до валидатора и срабатывает', () => {
    const config = configFromFile({ pathSecurity: { deniedPaths: ['//root'] } });
    const validator = createPathValidator(config);

    expect(validator?.validate('/root/secret').valid).toBe(false);
    expect(validator?.validate('/var/log/app.log').valid).toBe(true);
  });
});

/**
 * Поля входа: порт, ключ, пароль и passphrase.
 *
 * Тот же класс, которым терялся `pathSecurity`, и та же цепочка: поле из файла
 * дважды переписывается вручную, а потом превращается в аргумент команды или в
 * переменную окружения. Поэтому утверждение здесь не про значение в объекте, а
 * про то, что уехало в транспорт.
 */
describe('profiles file: поля входа доезжают до транспорта', () => {
  it('порт из файла уезжает и в ssh, и в scp', () => {
    const config = configFromFile({ port: 2222 });

    expect(config.port).toBe(2222);
    expect(flagValue(buildSshArgs(config, CAPS, 'true'), '-p')).toBe('2222');
    // У scp порт задаётся заглавной буквой — это отдельный вызов и отдельная дыра
    expect(flagValue(buildScpArgs(config, CAPS, 'upload', '/tmp/a', '/tmp/b'), '-P')).toBe('2222');
  });

  it('порт, записанный строкой, доезжает числом', () => {
    const config = configFromFile({ port: '2222' });

    expect(config.port).toBe(2222);
    expect(flagValue(buildSshArgs(config, CAPS, 'true'), '-p')).toBe('2222');
  });

  it('профиль без порта уходит на 22', () => {
    const config = configFromFile({});

    expect(config.port).toBe(22);
    expect(flagValue(buildSshArgs(config, CAPS, 'true'), '-p')).toBe('22');
  });

  it('путь к ключу уезжает в IdentityFile, и чужие ключи при этом не перебираются', () => {
    const config = configFromFile({ privateKeyPath: '/home/deploy/.ssh/id_ed25519' });
    const args = buildSshArgs(config, CAPS, 'true');

    expect(config.privateKeyPath).toBe('/home/deploy/.ssh/id_ed25519');
    expect(optionValue(args, 'IdentityFile')).toBe('/home/deploy/.ssh/id_ed25519');
    // Без IdentitiesOnly клиент перебирает ключи агента, и вход прошёл бы даже
    // с неверным путём — то есть проверка ключа ничего бы не значила
    expect(optionValue(args, 'IdentitiesOnly')).toBe('yes');
  });

  /**
   * Тильду раскрывает сборщик конфигурации, а не ssh: в IdentityFile она
   * уехала бы как есть, и клиент искал бы каталог с именем `~`.
   */
  it('тильда в пути к ключу раскрывается до передачи транспорту', () => {
    const config = configFromFile({ privateKeyPath: '~/.ssh/id_ed25519' });
    const expected = join(homedir(), '.ssh', 'id_ed25519');

    expect(config.privateKeyPath).toBe(expected);
    expect(optionValue(buildSshArgs(config, CAPS, 'true'), 'IdentityFile')).toBe(expected);
  });

  it('пароль доезжает до askpass и переключает вход на парольный', () => {
    const config = configFromFile({ password: 'hunter2' });
    const args = buildSshArgs(config, CAPS, 'true');

    expect(optionValue(args, 'PubkeyAuthentication')).toBe('no');
    // BatchMode запрещает любые запросы ввода, включая askpass: с ним секрет
    // некуда подать, и профиль с паролем не вошёл бы вовсе
    expect(optionValue(args, 'BatchMode')).toBeUndefined();

    const env = buildRunnerEnv({ config, askpassScriptPath: '/tmp/askpass.sh', baseEnv: {} });
    expect(env[SECRET_ENV_VAR]).toBe('hunter2');
  });

  /**
   * Пароль и passphrase едут одной дорогой, и перепутать их можно молча:
   * ssh спросит фразу к ключу, а получит пароль пользователя.
   */
  it('passphrase доезжает до askpass, а не пароль рядом с ней', () => {
    const config = configFromFile({
      privateKeyPath: '/home/deploy/.ssh/id_ed25519',
      passphrase: 'key-secret',
      password: 'user-secret',
    });
    const env = buildRunnerEnv({ config, askpassScriptPath: '/tmp/askpass.sh', baseEnv: {} });

    expect(config.passphrase).toBe('key-secret');
    expect(env[SECRET_ENV_VAR]).toBe('key-secret');
    expect(optionValue(buildSshArgs(config, CAPS, 'true'), 'BatchMode')).toBeUndefined();
  });

  it('профиль без секретов идёт с BatchMode и без переменной секрета', () => {
    const config = configFromFile({ privateKeyPath: '/home/deploy/.ssh/id_ed25519' });
    const env = buildRunnerEnv({ config, askpassScriptPath: '/tmp/askpass.sh', baseEnv: {} });

    expect(optionValue(buildSshArgs(config, CAPS, 'true'), 'BatchMode')).toBe('yes');
    expect(env[SECRET_ENV_VAR]).toBeUndefined();
  });
});

/**
 * Испорченный профиль рядом с исправным.
 *
 * Пока в файле остаётся хоть один пригодный профиль, ошибка соседнего не должна
 * теряться: иначе испорченный исчезает из списка молча, и его отсутствие
 * обнаружит только тот, кто позовёт его по имени.
 */
describe('profiles file: испорченный профиль рядом с исправным', () => {
  /** Поле, порча которого признаётся ошибкой профиля, и след этой ошибки */
  const brokenFields: Array<[string, Record<string, unknown>, RegExp]> = [
    ['порт', { port: 70000 }, /invalid port/],
    ['политика проверки ключа хоста', { strictHostKeyChecking: 'Yes' }, /strictHostKeyChecking/],
    ['ограничения на пути', { pathSecurity: { deniedPaths: '/root' } }, /pathSecurity/],
  ];

  it.each(brokenFields)('ошибка видна, когда испорчен первый профиль (%s)', (_name, broken, trace) => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', ...broken },
      staging: { host: 'staging.example.com', username: 'deploy' },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(trace);
    expect(errors.join(' ')).toMatch(/production/);
    expect(config?.profiles.production).toBeUndefined();
  });

  it.each(brokenFields)('ошибка видна, когда испорчен второй профиль (%s)', (_name, broken, trace) => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy' },
      staging: { host: 'staging.example.com', username: 'deploy', ...broken },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors.join(' ')).toMatch(trace);
    expect(errors.join(' ')).toMatch(/staging/);
    expect(config?.profiles.staging).toBeUndefined();
  });

  it('исправный профиль остаётся пригодным, а не исчезает вместе с ошибкой', () => {
    const path = writeProfiles({
      production: { host: 'example.com', username: 'deploy', port: 70000 },
      staging: { host: 'staging.example.com', username: 'deploy', port: 2222 },
    });

    const { config, errors } = loadProfilesFile(path);

    expect(errors.length).toBeGreaterThan(0);
    expect(config?.profiles.staging?.port).toBe(2222);
  });
});
