/**
 * Куда ведёт удаление на самом деле
 *
 * По тексту команды видно имя, а не цель: `rm -rf /var/www/data/`, где
 * `data` — ссылка на `/`, читается как уборка каталога приложения, а на
 * coreutils опустошает корень. Единственный способ узнать правду — спросить
 * сервер, поэтому здесь один запрос: резолв путей через `readlink -f`.
 *
 * Запрос делается только для целей со слэшем или `/*` на конце: замер на
 * лаборатории показал, что `rm -rf ссылка` без слэша удаляет саму ссылку и
 * ничего больше — проверять там нечего.
 */

import type { SSHExecutor } from './ssh-executor.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import { shellQuote } from '../utils/shell-arg.js';
import { classifyTarget, type RemovalTarget } from '../utils/destructive-command.js';

/** Ответ сервера, у которого нет чем резолвить путь */
const NO_READLINK = 'SSH_MCP_NO_READLINK';

export interface ResolutionVerdict {
  blocked: boolean;
  reason?: string;
}

/**
 * Проверить, куда ведут цели удаления.
 *
 * Три исхода не смешиваются: цель безопасна, цель ведёт в корень или
 * системное дерево, проверить нечем. Последнее — тоже отказ: незнание не
 * повод сносить, а повод спросить хозяина.
 */
export async function resolveRemovalTargets(
  executor: SSHExecutor,
  config: SSHConfig,
  targets: RemovalTarget[],
  options: { profileName: string; sudo?: boolean }
): Promise<ResolutionVerdict> {
  if (targets.length === 0) return { blocked: false };

  const passport = await executor.passport(config);

  // Пути идут по одному на строку, порядок сохраняется — по нему и сверяем
  const probes = targets
    .map((target) => `readlink -f -- ${shellQuote(target.path)} 2>/dev/null || echo`)
    .join('; ');
  const command =
    `command -v readlink >/dev/null 2>&1 || { echo ${NO_READLINK}; exit 0; }; ${probes}`;

  const result = await executor.execute(config, command, {
    profileName: options.profileName,
    sudo: options.sudo,
    idempotent: true,
  });

  if (result.stdout.includes(NO_READLINK)) {
    return {
      blocked: true,
      reason:
        'the server has no readlink, so there is no way to tell whether the target is a ' +
        'symlink into the root or a system directory',
    };
  }

  const resolved = result.stdout.split('\n').map((line) => line.trim());

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const actual = resolved[index];

    if (!actual) {
      return {
        blocked: true,
        reason: `"${target.raw}" could not be resolved on the server, so its real target is unknown`,
      };
    }

    const verdict = classifyTarget(actual, passport.home);
    if (verdict !== 'safe') {
      const where =
        verdict === 'root' ? 'the filesystem root' : verdict === 'home' ? 'the home directory' : 'a system directory';
      const via = actual === target.path ? '' : ` (via symlink → ${actual})`;
      return { blocked: true, reason: `"${target.raw}" is ${where}${via}` };
    }
  }

  return { blocked: false };
}
