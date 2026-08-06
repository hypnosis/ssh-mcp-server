/**
 * Файловые операции установщика на сервере
 *
 * Каждая — одна команда, понятная и coreutils, и BusyBox. Два места, где
 * ошибиться дороже всего:
 *
 * 1. Переименование идёт только с `-T`. Обычный `mv` каталога поверх
 *    существующего каталога кладёт его ВНУТРЬ и возвращает успех — проверено
 *    на обоих наборах утилит. Именно из-за этого прежний код был вынужден
 *    сначала делать `rm -rf` по боевому пути, а между удалением и заменой
 *    оставалось окно, в котором обрыв связи уносил данные насовсем.
 * 2. Тип пути определяется начиная с `test -L`. Битая ссылка не видна ни
 *    через `-e`, ни через `-d`: без этой проверки установщик считал бы путь
 *    свободным и падал на замене с необъяснимой ошибкой.
 */

import { posix as posixPath } from 'path';
import type { PathKind, PathOps } from './installer.js';
import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { shellQuote } from '../utils/shell-arg.js';

/** Маркеры ответа: разбираем по ним, а не по коду возврата */
const KIND_MARKERS: Record<string, PathKind> = {
  SSH_MCP_KIND_SYMLINK: 'symlink',
  SSH_MCP_KIND_DIR: 'directory',
  SSH_MCP_KIND_FILE: 'file',
  SSH_MCP_KIND_ABSENT: 'missing',
};

export interface RemoteOpsContext {
  executor: SSHExecutor;
  config: SSHConfig;
  profileName: string;
  sudo?: boolean;
}

export function remotePathOps(context: RemoteOpsContext): PathOps {
  const { executor, config, profileName, sudo } = context;

  const run = (command: string, idempotent = false) =>
    executor.execute(config, command, { profileName, sudo, idempotent });

  return {
    async inspect(path: string): Promise<PathKind> {
      const quoted = shellQuote(path);
      // Внутри `test` разделителя `--` быть не должно: и BusyBox, и dash
      // разбирают его как операнд («unknown operand», «binary operator
      // expected») и отвечают «пути нет» на существующий путь. Проверено
      // вживую на обоих серверах; от имён с дефисом защищают кавычки.
      const result = await run(
        `if [ -L ${quoted} ]; then echo SSH_MCP_KIND_SYMLINK; ` +
        `elif [ -d ${quoted} ]; then echo SSH_MCP_KIND_DIR; ` +
        `elif [ -e ${quoted} ]; then echo SSH_MCP_KIND_FILE; ` +
        `else echo SSH_MCP_KIND_ABSENT; fi`,
        true
      );

      for (const [marker, kind] of Object.entries(KIND_MARKERS)) {
        if (result.stdout.includes(marker)) return kind;
      }

      throw new Error(`cannot tell what ${path} is: ${result.stderr.trim() || 'no answer'}`);
    },

    /**
     * Точка монтирования: номер устройства у пути и у его родителя разный.
     *
     * Нет `stat` или он с другим синтаксисом (BSD) — отвечаем «не знаем»
     * и не мешаем операции: страховкой остаётся отказ самого `mv -T`.
     */
    async isSeparateFilesystem(path: string): Promise<boolean> {
      const parent = posixPath.dirname(path);
      const result = await run(
        `stat -c %d -- ${shellQuote(path)} ${shellQuote(parent)} 2>/dev/null`,
        true
      );

      const devices = result.stdout.trim().split(/\s+/);
      if (devices.length !== 2) return false;
      return devices[0] !== devices[1];
    },

    async ensureParent(path: string): Promise<void> {
      const parent = posixPath.dirname(path);
      if (!parent || parent === '/' || parent === '.') return;
      await executor.executeChecked(config, `mkdir -p -- ${shellQuote(parent)}`, {
        profileName,
        sudo,
      });
    },

    async rename(from: string, to: string): Promise<void> {
      await executor.executeChecked(
        config,
        `mv -T -- ${shellQuote(from)} ${shellQuote(to)}`,
        { profileName, sudo }
      );
    },

    /**
     * Наши временные пути, оставшиеся рядом с целью от прошлых операций.
     *
     * В шаблон идут только наши приставки: имя цели пользовательское, и `*`
     * или `[` в нём стали бы чужим шаблоном. Отбор по самому имени делается у
     * нас, как и сравнение хэшей.
     *
     * Читаем построчно: имя с переводом строки внутри даст лишнюю строку в
     * списке, но список этот только показывается человеку — ничего по нему
     * не удаляется.
     */
    async listArtifacts(directory: string): Promise<string[]> {
      const result = await run(
        `find ${shellQuote(directory)} -maxdepth 1 ` +
        `\\( -name '.upload-*' -o -name '.bak-*' \\) 2>/dev/null`,
        true
      );

      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    /**
     * Удалить путь целиком.
     *
     * Без потолка времени, как и другие шаги, длительность которых задаёт объём
     * данных: на контейнере полсотни тысяч файлов убираются за секунду, но на
     * флеш-памяти роутера или сетевом диске уборка в общие тридцать секунд может
     * не уложиться — и тогда временный путь молча останется на сервере.
     */
    async removeTree(path: string): Promise<void> {
      await executor.executeChecked(config, `rm -rf -- ${shellQuote(path)}`, {
        profileName,
        sudo,
        timeout: 0,
      });
    },
  };
}
