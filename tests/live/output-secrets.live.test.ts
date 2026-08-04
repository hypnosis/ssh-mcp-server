/**
 * Секрет профиля не влияет на данные сервера.
 *
 * Раньше вывод каждой команды парольного профиля чистился от секрета, и пароль
 * вида `root` превращал `/etc/passwd` в `***:x:0:0:***:/***`. Молчаливая порча:
 * такой текст легко записать обратно на сервер уже сломанным. Замер показал,
 * что прятать там нечего — секрет на сервер не уезжает.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getOpenSshRunner, closeAllRunners } from '../../src/runner/openssh-runner.js';
import { LAB_SERVERS, LAB_KEY, LAB_CONTROL_DIR, LAB_REQUIRED, labUnavailableReason } from './lab.js';

process.env.SSH_MCP_CONTROL_DIR = LAB_CONTROL_DIR;

const unavailable = await labUnavailableReason();
if (unavailable && LAB_REQUIRED) throw new Error(`Лаборатория недоступна: ${unavailable}`);

/** Секрет профиля — обычное слово, которое заведомо есть в файлах сервера */
const SECRET_LIKE_A_WORD = 'root';

/** Секрет, которого на сервере быть не может: по нему видно, уехал он туда или нет */
const UNIQUE_SECRET = 'sekret-marker-b4d9f1';

afterAll(async () => {
  await closeAllRunners();
});

describe.each(LAB_SERVERS)('Вывод сервера и секрет профиля — $name', (server) => {
  /** Секрет в профиле есть, вход идёт по ключу — как у профиля с passphrase */
  const runner = (secret?: string) =>
    getOpenSshRunner({
      host: '127.0.0.1',
      port: server.port,
      username: 'root',
      privateKeyPath: LAB_KEY,
      passphrase: secret,
      strictHostKeyChecking: 'no',
      ignoreUserConfig: true,
    });

  /** Эталон — тот же сервер и та же команда, но в профиле секрета нет */
  const withAndWithoutSecret = async (command: string) => {
    const [withSecret, plain] = await Promise.all([
      (await runner(SECRET_LIKE_A_WORD)).exec(command, {}),
      (await runner()).exec(command, {}),
    ]);
    return { withSecret: withSecret.stdout, plain: plain.stdout };
  };

  it.skipIf(unavailable)('файл сервера приходит тем же текстом, что и без секрета', async () => {
    const { withSecret, plain } = await withAndWithoutSecret('head -n 1 /etc/passwd');

    expect(plain).toContain('root');
    expect(withSecret).toBe(plain);
    expect(withSecret).not.toContain('***');
  });

  it.skipIf(unavailable)('листинг сохраняет владельца, а не прячет его', async () => {
    const { withSecret, plain } = await withAndWithoutSecret('ls -ld /root');

    expect(plain).toContain('root');
    expect(withSecret).toBe(plain);
    expect(withSecret).not.toContain('***');
  });

  it.skipIf(unavailable)('секрет профиля не уезжает в окружение удалённой сессии', async () => {
    // Пока это так, вывод сервера физически не может содержать наш секрет
    const { stdout } = await (await runner(UNIQUE_SECRET)).exec('env', {});

    expect(stdout).toContain('SSH_CONNECTION');
    expect(stdout).not.toContain(UNIQUE_SECRET);
  });
});
