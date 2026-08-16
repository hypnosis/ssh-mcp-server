/**
 * Живая сетка передачи: один набор утверждений на двух наборах утилит
 *
 * Один и тот же контракт гоняется на BusyBox и на coreutils — там, где они
 * расходятся, расходится и поведение передачи.
 *
 * Без лаборатории обычный прогон пропускает набор поимённо, а `npm run
 * test:live` падает: отсутствие лаборатории там — несделанная проверка.
 */

import { describe, it } from 'vitest';
import {
  LAB_CONTROL_DIR,
  LAB_REQUIRED,
  LAB_SERVERS,
  labConfig,
  labUnavailableReason,
} from './lab.js';
import { describeTransferContract } from './transfer-contract.js';

// Сокет мультиплексирования ограничен 104 байтами — путь по умолчанию
// в домашнем каталоге слишком длинный и валит ssh с кодом 255
process.env.SSH_MCP_CONTROL_DIR ??= LAB_CONTROL_DIR;

const { getOpenSshRunner, closeAllRunners } = await import('../../src/runner/openssh-runner.js');

const unavailable = await labUnavailableReason();

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
      cleanup: () => closeAllRunners(),
    });
  }
}
