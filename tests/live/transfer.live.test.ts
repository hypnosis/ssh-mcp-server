/**
 * Живая сетка передачи: матрица бэкендов и наборов утилит
 *
 * Один набор утверждений гоняется четырежды — {openssh, ssh2} × {BusyBox,
 * coreutils}. Сверх этого бэкенды сверяются между собой: расхождение,
 * которое не описано ни одним утверждением, всё равно всплывёт как разница
 * приехавших деревьев.
 *
 * Без лаборатории обычный прогон пропускает набор поимённо, а `npm run
 * test:live` падает: отсутствие лаборатории там — несделанная проверка.
 */

import { describe, it, expect } from 'vitest';
import {
  LAB_CONTROL_DIR,
  LAB_REQUIRED,
  LAB_SERVERS,
  labConfig,
  labUnavailableReason,
} from './lab.js';
import { describeTransferContract } from './transfer-contract.js';
import type { Manifest } from './manifest.js';

// Сокет мультиплексирования ограничен 104 байтами — путь по умолчанию
// в домашнем каталоге слишком длинный и валит ssh с кодом 255
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { getOpenSshRunner, closeAllRunners } = await import('../../src/runner/openssh-runner.js');
const { Ssh2Runner } = await import('../../src/runner/ssh2-runner.js');
const { ConnectionPool } = await import('../../src/managers/connection-pool.js');

const unavailable = await labUnavailableReason();

/** Приехавшие деревья: ключ — бэкенд и сервер */
const manifests = new Map<string, Manifest>();

/**
 * Чему бэкенд ssh2 не соответствует — измерено этой же сеткой (2026-08-04).
 *
 * Не чиним: бэкенд удаляется вместе с флипом дефолта, и промежуточной версии
 * в npm не будет. Расхождения зафиксированы, чтобы не потеряться:
 *   — исполняемый бит не переносится (`fastPut` без опций режим теряет);
 *   — пустой каталог не создаётся вовсе, а пустой подкаталог внутри дерева
 *     пропадает: обход в обе стороны видит только файлы;
 *   — символические ссылки не передаются вовсе, включая битые и циклические:
 *     передача «успешна», а данных нет.
 * Список и весь этот блок уходят вместе с бэкендом (пункт 5.3).
 */
const SSH2_GAPS = [
  'каталог едет в несуществующую цель: структура, права и имена сохранены',
  'пустой каталог всё равно создаётся',
  'скачивание возвращает дерево один в один',
  'пустой каталог доезжает и при скачивании',
  'ссылки внутри дерева разыменовываются',
  'битая ссылка обрывает передачу',
  'цикл ссылок обрывает передачу',
];

if (unavailable && LAB_REQUIRED) {
  describe('живая сетка передачи', () => {
    it('лаборатория должна быть поднята', () => {
      throw new Error(`${unavailable}. Поднять: npm run lab:up`);
    });
  });
} else if (unavailable) {
  // Пропуск должен быть виден: молчаливо зелёный прогон без живой сетки
  // опаснее красного — проверка не сделана, а выглядит как сделанная
  console.warn(`\n⚠ живая сетка передачи пропущена: ${unavailable}. Поднять: npm run lab:up\n`);

  describe.skip(`живая сетка передачи — ${unavailable}, поднять: npm run lab:up`, () => {
    it('пропущена', () => undefined);
  });
} else {
  for (const server of LAB_SERVERS) {
    const config = labConfig(server);

    describeTransferContract({
      name: `openssh @ ${server.name}`,
      remoteBase: `/tmp/xfer-openssh-${server.port}`,
      createRunner: () => getOpenSshRunner(config),
      record: (manifest) => manifests.set(`openssh @ ${server.name}`, manifest),
      cleanup: () => closeAllRunners(),
    });

    describeTransferContract({
      name: `ssh2 @ ${server.name}`,
      remoteBase: `/tmp/xfer-ssh2-${server.port}`,
      createRunner: () => new Ssh2Runner(config, `live-ssh2-${server.port}`),
      knownGaps: SSH2_GAPS,
      record: (manifest) => manifests.set(`ssh2 @ ${server.name}`, manifest),
      cleanup: () => ConnectionPool.getInstance().closeAll(),
    });
  }

  /**
   * Сверка бэкендов между собой ловит то, чего не описывает ни одно
   * утверждение. Известные расхождения ssh2 (права и пустые каталоги) из
   * сравнения вынесены — иначе оно всегда красное и ничего не сообщает.
   * Всё остальное: те же файлы, то же содержимое.
   */
  const fileContents = (manifest: Manifest | undefined): string =>
    (manifest ?? '')
      .split('\n')
      .filter((line) => line.startsWith('f '))
      .map((line) => {
        const [, , ...rest] = line.split(' ');
        return rest.join(' ');
      })
      .sort()
      .join('\n');

  describe('бэкенды кладут на сервер одно и то же', () => {
    for (const server of LAB_SERVERS) {
      it(`${server.name}: файлы и содержимое совпадают у обоих бэкендов`, () => {
        const openssh = manifests.get(`openssh @ ${server.name}`);
        const ssh2 = manifests.get(`ssh2 @ ${server.name}`);

        // Без этой проверки два непроехавших дерева (оба undefined)
        // дали бы ложно зелёное сравнение
        expect(typeof openssh, 'дерево openssh не приехало — смотри его набор').toBe('string');
        expect(typeof ssh2, 'дерево ssh2 не приехало — смотри его набор').toBe('string');
        expect(fileContents(ssh2)).toBe(fileContents(openssh));
      });
    }
  });
}
