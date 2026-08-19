/**
 * Unit tests: обещанный срок команды и срок, который уезжает на самом деле.
 *
 * Число жило четырьмя экземплярами — в схеме инструмента, в двух его ветках и
 * в двух слоях под ним. Каждое по отдельности верное, поэтому расхождение не
 * ловил ни один тест: правка одного места оставляла инструмент обещающим одно,
 * а делающим другое.
 *
 * Здесь сравниваются два независимых наблюдения — текст схемы и аргумент, с
 * которым позвали транспорт. Подменён только транспорт, поэтому наблюдается вся
 * цепочка целиком: схема → инструмент → исполнитель → раннер.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ExecOptions } from '../../src/runner/types.js';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));

vi.mock('../../src/runner/get-runner.js', () => ({
  getRunner: async () => ({ exec: execMock }),
}));

vi.mock('../../src/utils/profile-resolver.js', () => ({
  resolveSSHConfig: () => ({ host: 'example.com', username: 'deploy', port: 22 }),
  getAvailableProfiles: () => ['production'],
}));

const { ExecTool } = await import('../../src/tools/exec-tool.js');
const { resetPassportCache } = await import('../../src/runner/passport.js');

function call(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'ssh_exec', arguments: args } } as CallToolRequest;
}

/** Срок, с которым позвали транспорт для команды по образцу */
function sentTimeout(pattern: RegExp): number | undefined {
  const call = execMock.mock.calls.find(([command]) => pattern.test(String(command)));
  return (call?.[1] as ExecOptions | undefined)?.timeoutMs;
}

/** Обещание схемы: значение по умолчанию для параметра `timeout` */
function promisedDefault(): unknown {
  const properties = new ExecTool().getTool().inputSchema.properties as Record<
    string,
    { default?: unknown; description?: string }
  >;
  return properties.timeout.default;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPassportCache();
  execMock.mockResolvedValue({
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    truncated: false,
    durationMs: 1,
  });
});

describe('ssh_exec: обещанный срок совпадает с отправленным', () => {
  it('команда без срока уезжает с тем, что обещает схема', async () => {
    await new ExecTool().handleCall(call({ command: 'hostname' }));

    expect(sentTimeout(/hostname/)).toBe(promisedDefault());
  });

  /**
   * Вторая ветка инструмента: батч собирает опции сам, отдельной строкой.
   * Тест на одну ветку оставил бы вторую без сторожа.
   */
  it('каждая команда батча уезжает с тем же сроком', async () => {
    await new ExecTool().handleCall(call({ command: ['hostname', 'whoami'] }));

    expect(sentTimeout(/hostname/)).toBe(promisedDefault());
    expect(sentTimeout(/whoami/)).toBe(promisedDefault());
  });

  /**
   * Ноль у инструмента означает «срок не назван» и заменяется общим, тогда как
   * ниже, у транспорта, тот же ноль значит «потолка нет». Разница намеренная:
   * пропуск нуля вниз тихо снял бы потолок с команд, которые его ждут.
   */
  it('ноль читается как «срок не назван», а не как «без потолка»', async () => {
    await new ExecTool().handleCall(call({ command: 'hostname', timeout: 0 }));

    expect(sentTimeout(/hostname/)).toBe(promisedDefault());
  });

  it('названный срок доезжает нетронутым', async () => {
    await new ExecTool().handleCall(call({ command: 'hostname', timeout: 5000 }));

    expect(sentTimeout(/hostname/)).toBe(5000);
  });

  it('названный срок доезжает и до каждой команды батча', async () => {
    await new ExecTool().handleCall(call({ command: ['hostname', 'whoami'], timeout: 5000 }));

    expect(sentTimeout(/hostname/)).toBe(5000);
    expect(sentTimeout(/whoami/)).toBe(5000);
  });

  /**
   * Обе величины в тексте — миллисекунды и секунды — обязаны идти от одного
   * числа: разъехавшись, они превращают описание в ложь, которую читает агент.
   */
  it('текст схемы называет то же число, что и её значение по умолчанию', () => {
    const properties = new ExecTool().getTool().inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    const promised = Number(promisedDefault());

    expect(properties.timeout.description).toContain(`default ${promised}`);
    expect(properties.timeout.description).toContain(`(${promised / 1000} seconds)`);
  });
});
