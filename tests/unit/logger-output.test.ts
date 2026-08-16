/**
 * Логгер печатает то, ради чего его зовут: уровень, время, имя контекста.
 *
 * Проверка секретов живёт отдельно (`logger-secrets.test.ts`) — там сторож
 * стоит на том, что в лог попасть не должно, здесь на том, что должно.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const LEVEL_VARS = ['SSH_MCP_LOG_LEVEL', 'LOG_LEVEL', 'SSH_MCP_LOG_TIMESTAMP'] as const;

/**
 * Логгер читает окружение один раз, при создании, поэтому каждый набор
 * переменных требует своего экземпляра — модуль загружается заново.
 */
async function loggerWith(env: Partial<Record<(typeof LEVEL_VARS)[number], string>>) {
  for (const name of LEVEL_VARS) delete process.env[name];
  Object.assign(process.env, env);

  vi.resetModules();
  return (await import('../../src/utils/logger.js')).logger;
}

describe('логгер печатает уровень, время и контекст', () => {
  let written: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(LEVEL_VARS.map((name) => [name, process.env[name]]));
    written = [];
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.resetModules();
  });

  describe('уровень стоит в строке — по нему лог и фильтруют глазами', () => {
    it.each([
      ['debug', 'DEBUG'],
      ['info', 'INFO'],
      ['warn', 'WARN'],
      ['error', 'ERROR'],
    ] as const)('%s печатается с меткой [%s]', async (method, label) => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'debug' });

      logger[method]('something happened');

      expect(written).toHaveLength(1);
      expect(written[0]).toContain(`[${label}]`);
      expect(written[0]).toContain('something happened');
    });
  });

  describe('порог уровня отсекает то, что ниже', () => {
    it('на пороге warn молчат оба нижних уровня', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'warn' });

      logger.debug('debug line');
      logger.info('info line');

      expect(written).toEqual([]);
    });

    it('на пороге warn печатаются оба верхних уровня', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'warn' });

      logger.warn('warn line');
      logger.error('error line');

      expect(written).toHaveLength(2);
    });

    it('на пороге debug печатаются все четыре', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'debug' });

      logger.debug('a');
      logger.info('b');
      logger.warn('c');
      logger.error('d');

      expect(written).toHaveLength(4);
    });

    it('без переменных порог info: debug молчит, info пишет', async () => {
      const logger = await loggerWith({});

      logger.debug('debug line');
      logger.info('info line');

      expect(written).toHaveLength(1);
      expect(written[0]).toContain('info line');
    });
  });

  describe('порог берётся из обеих переменных', () => {
    it('LOG_LEVEL действует, когда своей переменной нет', async () => {
      const logger = await loggerWith({ LOG_LEVEL: 'error' });

      logger.warn('warn line');

      expect(written).toEqual([]);
    });

    it('SSH_MCP_LOG_LEVEL сильнее LOG_LEVEL', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'debug', LOG_LEVEL: 'error' });

      logger.debug('debug line');

      expect(written).toHaveLength(1);
    });
  });

  describe('метка времени', () => {
    it('по умолчанию строка начинается со времени в ISO', async () => {
      const logger = await loggerWith({});

      logger.error('with time');

      expect(written[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[ERROR\]/);
    });

    it('SSH_MCP_LOG_TIMESTAMP=false убирает время, уровень остаётся', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_TIMESTAMP: 'false' });

      logger.error('no time');

      expect(written[0]).toMatch(/^\[ERROR\] no time/);
    });

    it('любое другое значение оставляет время на месте', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_TIMESTAMP: 'no' });

      logger.error('with time');

      expect(written[0]).toMatch(/^\[\d{4}-/);
    });
  });

  describe('контекст называет, кто пишет', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)(
      '%s именованного логгера несёт имя контекста',
      async (method) => {
        const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'debug' });

        logger.context('ConnectionPool')[method]('creating connection');

        expect(written[0]).toContain('[ConnectionPool] creating connection');
      }
    );

    it('второй аргумент доезжает до вывода наравне с сообщением', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'debug' });

      logger.context('Runner').info('args:', { port: 2231 });

      expect(spy.mock.calls[0][2]).toEqual({ port: 2231 });
    });
  });

  describe('замер длительности', () => {
    it('печатает метку и время в миллисекундах, когда таймер закрывают', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'debug' });

      const done = logger.time('SSH Connect');
      expect(written).toEqual([]);
      done();

      expect(written[0]).toMatch(/\[⏱️ SSH Connect\] \d+ms/);
    });

    it('идёт по уровню debug и на пороге info молчит', async () => {
      const logger = await loggerWith({ SSH_MCP_LOG_LEVEL: 'info' });

      logger.time('SSH Connect')();

      expect(written).toEqual([]);
    });
  });
});
