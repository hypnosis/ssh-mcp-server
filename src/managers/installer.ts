/**
 * Единая точка установки файла или каталога на место
 *
 * Через неё проходит любое появление данных на боевом пути — и на сервере,
 * и локально при скачивании. Смысл в одном инварианте:
 *
 *   Целая копия существует в каждый момент времени. Ничего не удаляется,
 *   пока замена не удалась. Обработчик ошибки никогда не трогает последнюю
 *   оставшуюся копию.
 *
 * Отсюда порядок работы: данные всегда пишутся рядом с целью под временным
 * именем, проверяются там же и попадают на место одним переименованием.
 * Всё, что ломается до этого переименования, убирает за собой только
 * временный путь. Всё, что ломается после, — уже предупреждение, а не
 * провал: замена состоялась.
 *
 * Сам протокол не знает, где лежат данные. Файловые операции приходят
 * снаружи: на сервере это команды через транспорт, локально — обычный fs.
 */

import { logger } from '../utils/logger.js';
import { buildBackupPath, buildTempPath, isArtifactOf } from '../utils/tmp-name.js';

export type PathKind = 'file' | 'directory' | 'symlink' | 'missing';

/** Файловые операции, из которых собран протокол */
export interface PathOps {
  /**
   * Что лежит по пути прямо сейчас. Симлинк — отдельный вид: битая ссылка
   * не видна ни через `test -e`, ни через `test -d`, и без этого различия
   * замена упала бы с необъяснимым «путь не существует».
   */
  inspect(path: string): Promise<PathKind>;
  /** Создать родительский каталог, если его нет */
  ensureParent(path: string): Promise<void>;
  /**
   * Переименовать. Обязано вести себя как `mv -T`: в занятую цель ничего
   * не вкладывать, а отказывать. Обычный `mv` каталога поверх каталога
   * кладёт его внутрь и возвращает успех — проверено на BusyBox и coreutils.
   */
  rename(from: string, to: string): Promise<void>;
  /** Удалить путь целиком */
  removeTree(path: string): Promise<void>;
  /** Лежит ли путь на отдельной файловой системе (точка монтирования) */
  isSeparateFilesystem?(path: string): Promise<boolean>;
  /**
   * Пути в каталоге, похожие на наши временные имена.
   *
   * Нужны только чтобы назвать их человеку: убирать их самим нельзя — по
   * имени не отличить брошенный след от временного пути соседнего вызова,
   * который прямо сейчас доливает туда данные.
   */
  listArtifacts?(directory: string): Promise<string[]>;
}

export interface InstallPlan {
  /** Путь, который просил пользователь */
  finalPath: string;
  kind: 'file' | 'directory';
  /** Положить данные во временный путь */
  stage: (stagingPath: string) => Promise<void>;
  /** Проверить временный путь до замены: причина отказа или null */
  verify?: (stagingPath: string) => Promise<string | null>;
  /** Права и владелец после замены; сбой здесь операцию не отменяет */
  finalize?: (finalPath: string) => Promise<void>;
}

export interface InstallOutcome {
  path: string;
  /** Что пошло не так уже после состоявшейся замены */
  warnings: string[];
}

export class InstallError extends Error {
  /**
   * То, что человек обязан прочитать вместе с отказом: где остались его
   * данные. Без этого поля предупреждение «боевой путь пуст, копия лежит
   * рядом по адресу X» терялось бы ровно в том случае, ради которого
   * оно написано.
   */
  readonly warnings: string[];

  constructor(message: string, warnings: string[] = []) {
    super(warnings.length > 0 ? `${message} — ${warnings.join('; ')}` : message);
    this.name = 'InstallError';
    this.warnings = warnings;
  }
}

/**
 * Поставить данные на место.
 *
 * Возвращает предупреждения, а не глотает их: «файл заменён, но права не
 * применились» — это другой ответ, чем «всё получилось», и другой, чем
 * «операция провалилась».
 */
export async function install(ops: PathOps, plan: InstallPlan): Promise<InstallOutcome> {
  const warnings: string[] = [];

  // prepare: разведка цели. Всё, что здесь не так, — отказ до единого
  // изменения на диске
  const existing = await ops.inspect(plan.finalPath);

  // Следы прошлых операций: называем их и оставляем как есть
  const leftovers = await findLeftovers(ops, plan.finalPath);
  if (leftovers.length > 0) warnings.push(describeLeftovers(leftovers, plan.finalPath, existing));

  if (existing === 'symlink') {
    throw new InstallError(
      `the target is a symbolic link: ${plan.finalPath}. ` +
      'Point the path at the file or directory it leads to, or remove the link first.',
      warnings
    );
  }

  // Тип цели обязан совпасть с тем, что ставим: иначе переименование молча
  // вложит одно в другое и отчитается успехом
  if (existing !== 'missing' && existing !== plan.kind) {
    throw new InstallError(
      `cannot install ${plan.kind} over an existing ${existing}: ${plan.finalPath}`,
      warnings
    );
  }

  // Точка монтирования переименованием не заменяется: старый путь пришлось бы
  // сначала вычистить, а это ровно тот `rm -rf`, от которого мы уходим
  if (existing !== 'missing' && (await ops.isSeparateFilesystem?.(plan.finalPath))) {
    throw new InstallError(
      `the target is a mount point: ${plan.finalPath}. ` +
      'Replacing it by rename is not possible; write into a directory inside the volume instead.',
      warnings
    );
  }

  await ops.ensureParent(plan.finalPath);
  const staging = buildTempPath(plan.finalPath.replace(/\/+$/, ''));

  // stage, verify и права: всё, что здесь падает, уносит с собой только staging.
  // Права ставятся до замены — иначе на боевом пути возникло бы окно, в котором
  // данные уже живут, а доступ к ним ещё чужой
  try {
    await plan.stage(staging);

    if (plan.verify) {
      const reason = await plan.verify(staging);
      if (reason) throw new InstallError(`verification failed for ${plan.finalPath}: ${reason}`);
    }

    if (plan.finalize) await plan.finalize(staging);
  } catch (error) {
    await discard(ops, staging);
    throw warnings.length > 0
      ? new InstallError(message(error), warnings)
      : error;
  }

  // commit: с первого удавшегося переименования операция состоялась
  const committed = await commit(ops, plan, existing, staging, warnings);
  if (!committed.ok) {
    // Убирать staging можно только пока боевой путь цел. Если откат не удался,
    // staging — вторая из двух оставшихся копий, и трогать его нельзя
    if (committed.lastCopyAtRisk) {
      throw new InstallError(committed.error.message, warnings);
    }

    await discard(ops, staging);
    throw warnings.length > 0
      ? new InstallError(committed.error.message, warnings)
      : committed.error;
  }

  return { path: plan.finalPath, warnings };
}

type CommitResult =
  | { ok: true }
  /** lastCopyAtRisk — откат не удался: боевой путь пуст, и уборка запрещена */
  | { ok: false; error: Error; lastCopyAtRisk?: boolean };

/**
 * Поставить staging на место цели.
 *
 * Файл поверх файла и установка на пустое место — одно переименование, оно
 * атомарно. Каталог поверх каталога переименованием не заменяется, поэтому
 * старый сначала отводится в сторону под уникальным именем и удаляется
 * только после успешной замены.
 */
async function commit(
  ops: PathOps,
  plan: InstallPlan,
  existing: PathKind,
  staging: string,
  warnings: string[]
): Promise<CommitResult> {
  if (!(existing === 'directory' && plan.kind === 'directory')) {
    try {
      await ops.rename(staging, plan.finalPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  }

  const backup = buildBackupPath(plan.finalPath);

  try {
    await ops.rename(plan.finalPath, backup);
  } catch (error) {
    return { ok: false, error: toError(error) };
  }

  // Между этими двумя переименованиями боевой путь пуст — здесь не место
  // ни отмене, ни проверкам: прерваться тут значит оставить пустоту
  try {
    await ops.rename(staging, plan.finalPath);
  } catch (error) {
    const restored = await restore(ops, backup, plan.finalPath, warnings);
    return { ok: false, error: toError(error), lastCopyAtRisk: !restored };
  }

  // Точка невозврата пройдена: неубранная старая копия — это предупреждение
  try {
    await ops.removeTree(backup);
  } catch (error) {
    warnings.push(`the previous copy is still on the server at ${backup}: ${message(error)}`);
  }

  return { ok: true };
}

/** Вернуть отведённую копию на место, если замена не удалась */
async function restore(
  ops: PathOps,
  backup: string,
  finalPath: string,
  warnings: string[]
): Promise<boolean> {
  try {
    await ops.rename(backup, finalPath);
    return true;
  } catch (error) {
    // Худший исход: боевой путь пуст, а копия лежит рядом. Молчать нельзя —
    // это единственное, что позволит человеку вернуть данные руками
    warnings.push(
      `${finalPath} is empty; the previous copy is intact at ${backup} and must be moved back manually: ${message(error)}`
    );
    return false;
  }
}

/**
 * Найти рядом с целью наши временные пути от прошлых операций.
 *
 * Только чтение. Листинг не удался — считаем, что ничего нет: справка о мусоре
 * не стоит того, чтобы из-за неё отказала сама установка.
 */
async function findLeftovers(ops: PathOps, finalPath: string): Promise<string[]> {
  if (!ops.listArtifacts) return [];

  const trimmed = finalPath.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const directory = lastSlash > 0 ? trimmed.slice(0, lastSlash) : lastSlash === 0 ? '/' : '.';
  const base = trimmed.slice(lastSlash + 1);

  try {
    const found = await ops.listArtifacts(directory);
    return found.filter((path) => isArtifactOf(path.slice(path.lastIndexOf('/') + 1), base));
  } catch {
    return [];
  }
}

/**
 * Сказать про находку так, чтобы человек мог решить сам.
 *
 * Мы их не трогаем: по имени не отличить брошенный след от временного пути
 * чужого вызова, который прямо сейчас пишет туда данные. Поэтому в ответе —
 * адреса и готовая команда, а решение за человеком.
 */
function describeLeftovers(leftovers: string[], finalPath: string, existing: PathKind): string {
  const paths = leftovers.map((path) => `'${path}'`).join(' ');

  // Пустая цель рядом с отложенной копией — след процесса, убитого между двумя
  // переименованиями. Тогда рядом лежат последние целые данные, и это другой
  // разговор, чем «уберите мусор»
  if (existing === 'missing') {
    return (
      `${finalPath} did not exist before this install, but leftovers from an interrupted ` +
      `operation are next to it: ${paths}. They were not touched. If those are your data, ` +
      `put them back yourself: mv -T ${leftovers.map((path) => `'${path}'`).join(' ')} '${finalPath}'`
    );
  }

  return (
    `leftovers from an interrupted operation are next to the target and were left untouched: ` +
    `${paths}. Remove them yourself once you are sure no other transfer is using them: rm -rf ${paths}`
  );
}

/**
 * Убрать временный путь; неудача уборки операцию не меняет.
 *
 * След в журнале всё же оставляем: раньше ошибка исчезала бесследно, и путь,
 * который мы объявили убранным, мог остаться на сервере.
 */
async function discard(ops: PathOps, staging: string): Promise<void> {
  await ops.removeTree(staging).catch((error: unknown) => {
    logger.warn(`[Installer] could not remove the temporary path ${staging}: ${message(error)}`);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
