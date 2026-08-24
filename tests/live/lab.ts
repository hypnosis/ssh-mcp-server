/**
 * Лаборатория живых тестов: два контейнера с разными наборами утилит.
 *
 * Обычный `npm test` живую сетку пропускает, если лаборатория не поднята, —
 * но пропуск виден в выводе поимённо. `npm run test:live` (SSH_MCP_LIVE=1)
 * наоборот падает: отсутствие лаборатории там — это несделанная проверка,
 * а не «нечего проверять».
 *
 * Поднять: npm run lab:up
 */

import { connect } from 'net';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Ключ лаборатории — создаётся scripts/lab-up.sh, в репозиторий не попадает */
export const LAB_KEY = join(REPO_ROOT, '.lab', 'key');

/** Сервер лаборатории */
export interface LabServer {
  /** Имя для заголовка теста */
  name: string;
  port: number;
  /** Имя контейнера: через его лог видно, сколько входов увидел sshd */
  container: string;
}

export const LAB_SERVERS: LabServer[] = [
  { name: 'alpine/BusyBox', port: 2231, container: 'mcp-alpine' },
  { name: 'debian/dash', port: 2232, container: 'mcp-debian' },
];

/**
 * Роутер: dropbear вместо OpenSSH, sftp-server не собран вовсе — только
 * классический scp. Нарочно вне LAB_SERVERS: общая сетка гоняет sftp-путь,
 * и этот узел провалит его по определению, а не по дефекту.
 */
export const LAB_ROUTER: LabServer = { name: 'router/dropbear', port: 2233, container: 'mcp-router' };

/**
 * Машина с докером внутри: единственная в лаборатории, где журнал контейнера
 * лежит там, куда указывает `docker inspect`. Тоже вне LAB_SERVERS — общей
 * сетке она не нужна, а проверка журналов контейнеров без неё непроверяема.
 */
export const LAB_DOCKER: LabServer = { name: 'dind/docker', port: 2234, container: 'mcp-dind' };

/** Строгий режим: отсутствие лаборатории — падение, а не пропуск */
export const LAB_REQUIRED = process.env.SSH_MCP_LIVE === '1';

/**
 * Сокет мультиплексирования упирается в 104 байта, поэтому каталог
 * управления держим коротким — длинный путь ломает ssh с кодом 255.
 */
export const LAB_CONTROL_DIR = '/tmp/mcp-lab-ctl';

/**
 * Пароль пользователя `pwuser`. То же значение задаёт scripts/lab-up.sh —
 * оно живёт в двух языках сразу, поэтому меняется в двух местах.
 */
export const LAB_PASSWORD = 'lab-pwd-9c4e1a';

export function labConfig(server: LabServer, username = 'root'): SSHConfig {
  return {
    host: '127.0.0.1',
    port: server.port,
    username,
    privateKeyPath: LAB_KEY,
    strictHostKeyChecking: 'no',
    ignoreUserConfig: true,
  };
}

/**
 * Профиль, который входит по паролю.
 *
 * Ключа у него нет намеренно: с ключом клиент вошёл бы по нему, и парольная
 * ветка (askpass) осталась бы непроверенной.
 */
export function labPasswordConfig(server: LabServer, password = LAB_PASSWORD): SSHConfig {
  return {
    host: '127.0.0.1',
    port: server.port,
    username: 'pwuser',
    password,
    strictHostKeyChecking: 'no',
    ignoreUserConfig: true,
  };
}

/**
 * Профиль третьей группы: вход по ключу, а `sudo` на сервере требует пароль.
 *
 * Пароля входа у него нет намеренно — иначе `sudo` получил бы его и случай,
 * ради которого профиль заведён, остался бы непроверенным.
 */
export function labSudoPasswordConfig(server: LabServer, sudoPassword = LAB_PASSWORD): SSHConfig {
  return { ...labConfig(server, 'keyuser'), sudoPassword };
}

/**
 * Профиль сервера с вендорской оболочкой.
 *
 * Вход проходит, а команды POSIX серверу неизвестны — так отвечают роутеры и
 * встраиваемые устройства со своим CLI. Пользователя заводит scripts/lab-up.sh.
 */
export function labVendorConfig(server: LabServer): SSHConfig {
  return { ...labConfig(server, 'vendorcli') };
}

/** Отвечает ли порт — дешёвая проба, чтобы обычный прогон не ждал таймаутов */
function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Почему лаборатория недоступна, или null если всё на месте */
export async function labUnavailableReason(): Promise<string | null> {
  if (!existsSync(LAB_KEY)) return `нет ключа ${LAB_KEY}`;

  for (const server of LAB_SERVERS) {
    if (!(await portOpen(server.port))) return `порт ${server.port} (${server.name}) молчит`;
  }

  return null;
}

/** То же для узла с докером: свой порт, свой сторож */
export async function dockerUnavailableReason(): Promise<string | null> {
  if (!existsSync(LAB_KEY)) return `нет ключа ${LAB_KEY}`;
  if (!(await portOpen(LAB_DOCKER.port))) {
    return `порт ${LAB_DOCKER.port} (${LAB_DOCKER.name}) молчит`;
  }
  return null;
}

/**
 * То же для роутера: он вне общей сетки, поэтому и сторож ему нужен свой —
 * иначе «контейнер не поднят» прочиталось бы как «проверка прошла».
 */
export async function routerUnavailableReason(): Promise<string | null> {
  if (!existsSync(LAB_KEY)) return `нет ключа ${LAB_KEY}`;
  if (!(await portOpen(LAB_ROUTER.port))) {
    return `порт ${LAB_ROUTER.port} (${LAB_ROUTER.name}) молчит`;
  }
  return null;
}
