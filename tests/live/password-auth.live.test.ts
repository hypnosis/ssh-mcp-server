/**
 * Парольный профиль живьём: доставка секрета через askpass.
 *
 * До сих пор эта ветка проверялась только юнитами — они смотрят на список
 * аргументов и на объект окружения, то есть ровно на то, что мы сами и
 * написали. Живого доказательства, что системный ssh вообще пускает по
 * паролю без терминала, не было ни одного.
 *
 * Три обещания документации проверяются здесь буквально:
 *  - секрет не появляется в argv (иначе его видно всей системе через `ps`);
 *  - секрет не появляется на диске (askpass-скрипт только читает переменную);
 *  - пароль спрашивается один раз на окно ControlPersist, а не на команду.
 *
 * Последнее — то, ради чего затевалось мультиплексирование, и проверяется оно
 * заведомо неверным паролем: пока управляющее соединение живо, команда всё
 * равно проходит; стоит его закрыть — тот же профиль получает отказ.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { OpenSshRunner, getOpenSshRunner, closeAllRunners } from '../../src/runner/openssh-runner.js';
import { detectRuntime, toCapabilities } from '../../src/runner/runtime-check.js';
import { ASKPASS_SCRIPT_NAME, buildRunnerEnv, ensureAskpassScript } from '../../src/runner/askpass.js';
import { buildSshArgs } from '../../src/runner/ssh-args.js';
import {
  LAB_SERVERS,
  LAB_PASSWORD,
  LAB_CONTROL_DIR,
  LAB_REQUIRED,
  labPasswordConfig,
  labUnavailableReason,
} from './lab.js';

process.env.SSH_MCP_CONTROL_DIR = LAB_CONTROL_DIR;

const unavailable = await labUnavailableReason();
if (unavailable && LAB_REQUIRED) throw new Error(`Лаборатория недоступна: ${unavailable}`);

const LIVE_TIMEOUT_MS = 60_000;

/**
 * Снимок командных строк всех процессов машины.
 *
 * `-ww` снимает обрезку по ширине: без неё длинный список опций ssh обрубается,
 * и секрет в хвосте строки не нашёлся бы просто потому, что строку укоротили.
 */
function processArgsSnapshot(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-Aww', '-o', 'args='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Код возврата ssh с тем же окружением, но без перечисленных переменных */
function sshExitCode(args: string[], env: NodeJS.ProcessEnv, drop: string[]): Promise<number> {
  const childEnv = { ...env };
  for (const name of drop) delete childEnv[name];

  return new Promise((resolve) => {
    execFile('ssh', args, { env: childEnv, timeout: 15_000 }, (error) => {
      resolve(error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0);
    });
  });
}

afterAll(async () => {
  await closeAllRunners();
});

describe.each(LAB_SERVERS)('Парольный профиль — $name', { timeout: LIVE_TIMEOUT_MS }, (server) => {
  const runner = () => getOpenSshRunner(labPasswordConfig(server));

  it.skipIf(unavailable)('вход по паролю проходит, а сам пароль в ответе не появляется', async () => {
    const result = await (await runner()).exec('whoami', {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('pwuser');
    expect(result.stdout + result.stderr).not.toContain(LAB_PASSWORD);
  });

  it.skipIf(unavailable)('пароля нет в командной строке запущенных процессов', async () => {
    // Снимок снимается на ходу: процесс ssh должен существовать в этот момент,
    // иначе проверять было бы нечего
    const running = (await runner()).exec('sleep 4', { remoteTimeout: false });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const snapshot = await processArgsSnapshot();
    await running;

    // Негативный контроль: без него тест зеленел бы и на пустом снимке
    expect(snapshot).toContain('User=pwuser');
    expect(snapshot).not.toContain(LAB_PASSWORD);
  });

  it.skipIf(unavailable)('пароля нет в askpass-скрипте на диске', async () => {
    const script = await readFile(join(LAB_CONTROL_DIR, ASKPASS_SCRIPT_NAME), 'utf8');

    expect(script).toContain('SSH_MCP_SECRET');
    expect(script).not.toContain(LAB_PASSWORD);
  });

  it.skipIf(unavailable)('к askpass ведут две дороги, и каждой хватает по отдельности', async () => {
    // Дорог действительно две: SSH_ASKPASS_REQUIRE=force (клиент 8.4+) и старая,
    // через наличие DISPLAY. Замерено, что каждая работает без другой, а без
    // обеих вход отклоняется. Пока проверялась только их сумма, удаление любой
    // из двух строк оставляло живую сетку зелёной — вторая молча подменяла её.
    const config = labPasswordConfig(server);
    const runtime = await detectRuntime();
    const env = buildRunnerEnv({
      config,
      askpassScriptPath: ensureAskpassScript(runtime.controlDir),
    });

    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env.DISPLAY).toBeTruthy();

    // Без мультиплексирования: через готовое соединение вход прошёл бы мимо
    // askpass, и обе дороги выглядели бы рабочими даже будучи сломанными
    const args = buildSshArgs(config, { ...toCapabilities(runtime), multiplexing: false }, 'whoami');

    expect(await sshExitCode(args, env, ['DISPLAY'])).toBe(0);
    expect(await sshExitCode(args, env, ['SSH_ASKPASS_REQUIRE'])).toBe(0);
    expect(await sshExitCode(args, env, ['DISPLAY', 'SSH_ASKPASS_REQUIRE'])).not.toBe(0);
  });

  it.skipIf(unavailable)('вход проходит, пока askpass-скрипт переписывают на ходу', async () => {
    // Управляющий каталог общий: пока один профиль входит по паролю, соседний
    // может пересоздавать тот же скрипт. Замер до правки: 56 запусков из 330
    // печатали пустоту вместо секрета — ssh получал пустой пароль и отказ.
    const config = labPasswordConfig(server);
    const runtime = await detectRuntime();
    const env = buildRunnerEnv({
      config,
      askpassScriptPath: ensureAskpassScript(runtime.controlDir),
    });

    // Без мультиплексирования: через готовое соединение askpass не читается
    // вовсе, и залп прошёл бы даже по обнулённому файлу
    const args = buildSshArgs(config, { ...toCapabilities(runtime), multiplexing: false }, 'true');

    let rewriting = true;
    const writer = (async () => {
      while (rewriting) {
        ensureAskpassScript(runtime.controlDir);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const codes: number[] = [];
    // По шесть за раз: сервер держит ограниченное число неаутентифицированных
    // соединений, и залп пошире давал бы отказы сам по себе
    for (let round = 0; round < 4; round++) {
      codes.push(...(await Promise.all(Array.from({ length: 6 }, () => sshExitCode(args, env, [])))));
    }
    rewriting = false;
    await writer;

    // Длина проверяется отдельно: на пустом списке проверка кодов зеленела бы
    expect(codes).toHaveLength(24);
    expect(codes.filter((code) => code !== 0)).toEqual([]);
  });

  it.skipIf(unavailable)('пока управляющее соединение живо, пароль больше не спрашивается', async () => {
    const live = await runner();
    expect((await live.stats()).masterActive).toBe(true);

    // Транспорт с заведомо неверным паролем создаётся мимо кэша: getOpenSshRunner
    // увидел бы смену учётных данных и закрыл бы то самое соединение, которое
    // здесь и проверяется
    const runtime = await detectRuntime();
    const wrongPassword = new OpenSshRunner(labPasswordConfig(server, 'not-the-password'), runtime);

    const throughMaster = await wrongPassword.exec('whoami', {});
    expect(throughMaster.stdout.trim()).toBe('pwuser');

    // Негативный контроль: без готового соединения тот же профиль не пускают,
    // то есть предыдущая команда прошла именно по master, а не мимо пароля
    await live.closeMaster();
    await expect(wrongPassword.exec('whoami', {})).rejects.toThrow();
  });
});
