/**
 * Unit tests: команды установщика на сервере
 *
 * Здесь проверяются сами строки команд, потому что цена ошибки в них —
 * потерянные данные, а не упавший тест. Два случая уже случились вживую:
 *
 *  - `test -d -- путь` ломается и на BusyBox, и на dash: разделитель `--`
 *    разбирается как операнд, и существующий каталог объявляется
 *    несуществующим. Дальше установщик считает путь свободным и заменяет
 *    каталог напрямую;
 *  - обычный `mv` каталога поверх каталога кладёт его ВНУТРЬ и возвращает
 *    успех. Отсюда `-T` во всех переименованиях.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SSHConfig } from '../../src/utils/ssh-config.js';

const { remotePathOps } = await import('../../src/managers/remote-path-ops.js');

const CONFIG: SSHConfig = { host: 'example.com', port: 22, username: 'deploy' };

const executeMock = vi.fn();
const executeCheckedMock = vi.fn();

function ops(sudo?: boolean) {
  return remotePathOps({
    executor: { execute: executeMock, executeChecked: executeCheckedMock } as never,
    config: CONFIG,
    profileName: 'production',
    sudo,
  });
}

/** Команда, ушедшая на сервер последним вызовом */
function lastCommand(mock: typeof executeMock): string {
  return mock.mock.calls[mock.mock.calls.length - 1][1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ stdout: 'SSH_MCP_KIND_ABSENT\n', stderr: '', exitCode: 0 });
  executeCheckedMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('разведка типа цели', () => {
  it('не ставит разделитель внутрь test — иначе путь объявляется свободным', async () => {
    await ops().inspect('/srv/app');

    expect(lastCommand(executeMock)).not.toMatch(/\[ -[LdeE] --/);
    expect(lastCommand(executeMock)).toContain(`[ -L '/srv/app' ]`);
  });

  it('спрашивает про ссылку раньше, чем про каталог и файл', async () => {
    await ops().inspect('/srv/app');

    const command = lastCommand(executeMock);
    expect(command.indexOf('-L')).toBeLessThan(command.indexOf('-d'));
    expect(command.indexOf('-d')).toBeLessThan(command.indexOf('-e'));
  });

  it.each([
    ['SSH_MCP_KIND_SYMLINK', 'symlink'],
    ['SSH_MCP_KIND_DIR', 'directory'],
    ['SSH_MCP_KIND_FILE', 'file'],
    ['SSH_MCP_KIND_ABSENT', 'missing'],
  ])('ответ %s читается как %s', async (marker, expected) => {
    executeMock.mockResolvedValue({ stdout: `баннер\n${marker}\n`, stderr: '', exitCode: 0 });

    await expect(ops().inspect('/srv/app')).resolves.toBe(expected);
  });

  it('невнятный ответ — ошибка, а не «пути нет»', async () => {
    executeMock.mockResolvedValue({ stdout: '', stderr: 'permission denied', exitCode: 1 });

    await expect(ops().inspect('/srv/app')).rejects.toThrow(/cannot tell what/);
  });
});

describe('переименование', () => {
  it('идёт только с -T', async () => {
    await ops().rename('/srv/.upload-abc.app', '/srv/app');

    expect(lastCommand(executeCheckedMock)).toBe(
      `mv -T -- '/srv/.upload-abc.app' '/srv/app'`
    );
  });

  it('обязано удаться: молчаливая неудача оставила бы цель пустой', async () => {
    await ops().rename('/srv/a', '/srv/b');

    // Именно executeChecked, а не execute: ненулевой код здесь не «ответ»
    expect(executeCheckedMock).toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('права доступа', () => {
  it('под sudo команды уходят с повышением прав', async () => {
    await ops(true).removeTree('/srv/.upload-abc.app');

    expect(executeCheckedMock.mock.calls[0][2]).toMatchObject({ sudo: true });
  });
});

describe('точка монтирования', () => {
  it('распознаётся по разным номерам устройств у пути и родителя', async () => {
    executeMock.mockResolvedValue({ stdout: '2049\n64768\n', stderr: '', exitCode: 0 });

    await expect(ops().isSeparateFilesystem('/srv/data')).resolves.toBe(true);
  });

  it('одинаковые номера — обычный каталог', async () => {
    executeMock.mockResolvedValue({ stdout: '64768\n64768\n', stderr: '', exitCode: 0 });

    await expect(ops().isSeparateFilesystem('/srv/data')).resolves.toBe(false);
  });

  it('сервер без stat не мешает операции', async () => {
    executeMock.mockResolvedValue({ stdout: '', stderr: 'stat: not found', exitCode: 127 });

    await expect(ops().isSeparateFilesystem('/srv/data')).resolves.toBe(false);
  });
});
