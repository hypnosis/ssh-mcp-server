/**
 * Страховки процесса
 *
 * Сервер обслуживает много независимых операций подряд. Ошибка, всплывшая мимо
 * обработчика — из канала SFTP, из таймера, из промиса, за которым никто не
 * следит, — по умолчанию завершает процесс Node целиком: клиент теряет не один
 * вызов, а всю сессию со всеми профилями. Здесь такая ошибка становится записью
 * в журнале, а сервер продолжает отвечать.
 *
 * Единственное исключение — закрытый канал к клиенту: работать больше не для
 * кого, и оставаться в памяти незачем.
 */

import { logger } from './logger.js';

/** Канал к клиенту закрыт с той стороны */
function isClientChannelClosed(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EPIPE';
}

/** Текст для журнала: у ошибки берём стек, у чего угодно ещё — как есть */
function describeFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
}

export function installProcessGuards(target: NodeJS.Process = process): void {
  target.on('uncaughtException', (error: Error) => {
    if (isClientChannelClosed(error)) {
      logger.info('[MCP Server] Client channel closed, shutting down');
      target.exit(0);
      return;
    }

    logger.error(
      `[MCP Server] Uncaught exception, the server keeps running: ${describeFailure(error)}`
    );
  });

  target.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      `[MCP Server] Unhandled rejection, the server keeps running: ${describeFailure(reason)}`
    );
  });
}
