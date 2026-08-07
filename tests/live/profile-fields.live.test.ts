/**
 * Поля профиля живьём: порт, ключ, пароль, passphrase.
 *
 * Юниты доказывают, что поле доехало до аргументов команды, — но аргументы
 * пишем мы сами, и ровно так `pathSecurity` месяцами числился работающим.
 * Здесь утверждается поведение сервера: под каким пользователем и на какой
 * машине выполнилась команда, а при неверных учётных данных — что команда не
 * выполнилась вовсе. Отказ проверяется по отсутствию следа на сервере, а не по
 * тексту ошибки: текст может соврать, файла на диске быть не может.
 *
 * Свой каталог управления обязателен: сокет — хэш от (хост, порт, пользователь),
 * и мастер, поднятый соседним живым набором, пустил бы команду с заведомо
 * неверным ключом — отрицательные утверждения зазеленели бы, ничего не проверив.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LAB_KEY,
  LAB_PASSWORD,
  LAB_REQUIRED,
  LAB_SERVERS,
  labUnavailableReason,
  type LabServer,
} from './lab.js';

const LIVE_TIMEOUT_MS = 60_000;

/** Свой каталог управления: короткий, потому что адрес unix-сокета — 104 байта */
const CONTROL_DIR = '/tmp/mcp-lab-pf';

/** Фраза к ключу, который заводится этим файлом */
const KEY_PASSPHRASE = 'lab-passphrase-3b7d2f';

/** По этой метке ключ находится в authorized_keys и убирается оттуда */
const PROBE_KEY_COMMENT = 'ssh-mcp-passphrase-probe';

/** Какой контейнер отвечает на каком порту — по нему и видно, что порт доехал */
const OS_ID_BY_PORT: Record<number, string> = { 2231: 'alpine', 2232: 'debian' };

const unavailable = await labUnavailableReason();
const workDir = await mkdtemp(join(tmpdir(), 'profile-fields-'));

/** Ключ с фразой: вход им проходит только когда passphrase доехала до askpass */
const passKeyPath = join(workDir, 'passkey');
/** Ключ, которого нет ни в одном authorized_keys */
const foreignKeyPath = join(workDir, 'foreign');

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout) => {
      resolve({ code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout });
    });
  });
}

/**
 * Команда на сервере мимо проверяемого кода.
 *
 * Подготовка и сверка идут своим ssh с выключенным мультиплексированием:
 * иначе состояние сервера спрашивалось бы у того же соединения, которое
 * тест и проверяет.
 */
function sshRoot(port: number, command: string): Promise<{ code: number; stdout: string }> {
  return run('ssh', [
    '-o', 'ControlPath=none',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-i', LAB_KEY,
    '-p', String(port),
    'root@127.0.0.1',
    command,
  ]);
}

const AUTH_KEYS = '/home/deploy/.ssh/authorized_keys';

/** Убрать пробный ключ из authorized_keys, не тронув ключ лаборатории */
function forgetProbeKey(port: number): Promise<{ code: number; stdout: string }> {
  // Пустой результат фильтра не переносим: он означал бы, что файл прочитан
  // неверно, и вход на контейнер потерялся бы вместе с ключом лаборатории
  return sshRoot(
    port,
    `grep -v ${PROBE_KEY_COMMENT} ${AUTH_KEYS} > /tmp/pf-ak; ` +
      `[ -s /tmp/pf-ak ] && cat /tmp/pf-ak > ${AUTH_KEYS}; rm -f /tmp/pf-ak`
  );
}

if (!unavailable) {
  await run('ssh-keygen', ['-t', 'ed25519', '-N', KEY_PASSPHRASE, '-C', PROBE_KEY_COMMENT, '-q', '-f', passKeyPath]);
  await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'ssh-mcp-foreign-key', '-q', '-f', foreignKeyPath]);

  const publicKey = (await readFile(`${passKeyPath}.pub`, 'utf8')).trim();

  for (const server of LAB_SERVERS) {
    await forgetProbeKey(server.port);
    await sshRoot(server.port, `printf '%s\\n' '${publicKey}' >> ${AUTH_KEYS}`);
  }
}

const profilesPath = join(workDir, 'profiles.json');

/** Имена профилей: по одному на проверяемое поле и по одному на его отрицание */
const badKeyName = (server: LabServer) => `${server.name}-badkey`;
const passwordName = (server: LabServer) => `${server.name}-pw`;
const badPasswordName = (server: LabServer) => `${server.name}-pw-bad`;
const passphraseName = (server: LabServer) => `${server.name}-pass`;
const badPassphraseName = (server: LabServer) => `${server.name}-pass-bad`;

await writeFile(
  profilesPath,
  JSON.stringify({
    default: LAB_SERVERS[0].name,
    profiles: Object.fromEntries(
      LAB_SERVERS.flatMap((server) => {
        const base = {
          host: '127.0.0.1',
          port: server.port,
          strictHostKeyChecking: 'no',
          ignoreUserConfig: true,
        };
        return [
          [server.name, { ...base, username: 'root', privateKeyPath: LAB_KEY }],
          [badKeyName(server), { ...base, username: 'root', privateKeyPath: foreignKeyPath }],
          [passwordName(server), { ...base, username: 'pwuser', password: LAB_PASSWORD }],
          [badPasswordName(server), { ...base, username: 'pwuser', password: 'not-the-password' }],
          [
            passphraseName(server),
            { ...base, username: 'deploy', privateKeyPath: passKeyPath, passphrase: KEY_PASSPHRASE },
          ],
          [
            badPassphraseName(server),
            { ...base, username: 'deploy', privateKeyPath: passKeyPath, passphrase: 'not-the-passphrase' },
          ],
        ];
      })
    ),
  })
);

process.env.SSH_PROFILES_FILE = profilesPath;
process.env.SSH_MCP_CONTROL_DIR = CONTROL_DIR;

// Соединение, оставшееся от прошлого прогона, пустило бы команду с заведомо
// неверными данными: свой кэш у нового процесса пуст, и смены учётных данных
// он не увидит. Каталог сносится целиком — со снесённым сокетом вход всегда
// настоящий
await rm(CONTROL_DIR, { recursive: true, force: true });

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { closeAllRunners } = await import('../../src/runner/openssh-runner.js');

afterAll(async () => {
  await closeAllRunners();
  if (!unavailable) {
    for (const server of LAB_SERVERS) {
      await forgetProbeKey(server.port);
      await sshRoot(server.port, 'rm -f /tmp/pf-*.marker');
    }
  }
  await rm(workDir, { recursive: true, force: true });
  await rm(CONTROL_DIR, { recursive: true, force: true });
});

if (unavailable && LAB_REQUIRED) {
  describe('поля профиля живьём', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  describe.skip(`поля профиля живьём — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущены', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    describe(`Поля профиля: ${server.name}`, { timeout: LIVE_TIMEOUT_MS }, () => {
      const tool = new ExecTool();

      const call = async (profile: string, command: string): Promise<void> => {
        await tool
          .handleCall({ params: { name: 'ssh_exec', arguments: { profile, command } } } as never)
          .catch(() => undefined);
      };

      /**
       * Что команда оставила на сервере, или `none`, если не выполнилась.
       *
       * Ответ инструмента здесь не читается вовсе, и это не педантизм: текст
       * отказа содержит `pwuser@127.0.0.1: Permission denied`, поэтому поиск
       * имени пользователя в ответе зеленел на самом отказе. Оба положительных
       * утверждения так и прошли на профиле без пароля.
       */
      const leftOnServer = async (profile: string, script: string, marker: string): Promise<string> => {
        await sshRoot(server.port, `rm -f ${marker}`);
        await call(profile, `${script} > ${marker}`);
        const { stdout } = await sshRoot(server.port, `cat ${marker} 2>/dev/null || echo none`);
        return stdout.trim();
      };

      it('порт и ключ приводят команду на нужный контейнер под нужным пользователем', async () => {
        const left = await leftOnServer(
          server.name,
          '. /etc/os-release; printf "%s %s" "$(id -un)" "$ID"',
          `/tmp/pf-${server.port}-key.marker`
        );

        expect(left).toBe(`root ${OS_ID_BY_PORT[server.port]}`);
      });

      it('профиль с чужим ключом на сервер не попадает', async () => {
        const left = await leftOnServer(
          badKeyName(server),
          'printf "%s" "$(id -un)"',
          `/tmp/pf-${server.port}-badkey.marker`
        );

        expect(left).toBe('none');
      });

      it('пароль из профиля пускает своего пользователя', async () => {
        const left = await leftOnServer(
          passwordName(server),
          'printf "%s" "$(id -un)"',
          `/tmp/pf-${server.port}-pw.marker`
        );

        expect(left).toBe('pwuser');
      });

      it('профиль с неверным паролем на сервер не попадает', async () => {
        const left = await leftOnServer(
          badPasswordName(server),
          'printf "%s" "$(id -un)"',
          `/tmp/pf-${server.port}-pw-bad.marker`
        );

        expect(left).toBe('none');
      });

      it('passphrase отпирает ключ, и вход проходит под его владельцем', async () => {
        const left = await leftOnServer(
          passphraseName(server),
          'printf "%s" "$(id -un)"',
          `/tmp/pf-${server.port}-pass.marker`
        );

        expect(left).toBe('deploy');
      });

      it('профиль с неверной passphrase на сервер не попадает', async () => {
        const left = await leftOnServer(
          badPassphraseName(server),
          'printf "%s" "$(id -un)"',
          `/tmp/pf-${server.port}-pass-bad.marker`
        );

        expect(left).toBe('none');
      });
    });
  }
}
