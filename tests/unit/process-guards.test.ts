/**
 * Страховки процесса
 *
 * MCP-сервер обслуживает много независимых операций подряд. Ошибка в одной из
 * них не должна уносить весь процесс: клиент теряет не один вызов, а всю сессию
 * со всеми профилями. Пользователи видели ровно это — «инструмент падает с
 * внутренней ошибкой», после чего сервер переставал отвечать вообще.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/utils/logger.js', () => ({ logger: loggerMock }));

const { installProcessGuards } = await import('../../src/utils/process-guards.js');

/** Процесс с наблюдаемым выходом */
class FakeProcess extends EventEmitter {
  readonly exit = vi.fn();
}

function loggedText(): string {
  return loggerMock.error.mock.calls.map((args) => args.join(' ')).join('\n');
}

describe('installProcessGuards', () => {
  let proc: FakeProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    proc = new FakeProcess();
    installProcessGuards(proc as unknown as NodeJS.Process);
  });

  it('вешает обработчики на оба события, которые роняют процесс по умолчанию', () => {
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
  });

  it('необработанное исключение логируется и не завершает процесс', () => {
    proc.emit('uncaughtException', new Error('SFTP channel died'));

    expect(proc.exit).not.toHaveBeenCalled();
    expect(loggedText()).toContain('SFTP channel died');
  });

  it('отклонённый промис без обработчика логируется и не завершает процесс', () => {
    proc.emit('unhandledRejection', new Error('connection reset'), Promise.resolve());

    expect(proc.exit).not.toHaveBeenCalled();
    expect(loggedText()).toContain('connection reset');
  });

  it('отклонение не-ошибкой тоже переживается', () => {
    proc.emit('unhandledRejection', 'просто строка', Promise.resolve());

    expect(proc.exit).not.toHaveBeenCalled();
    expect(loggedText()).toContain('просто строка');
  });

  it('обрыв канала к клиенту завершает процесс штатно — работать больше не для кого', () => {
    const broken = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    proc.emit('uncaughtException', broken);

    expect(proc.exit).toHaveBeenCalledWith(0);
  });
});
