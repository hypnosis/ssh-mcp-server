/**
 * Правила доступа к путям: белый и чёрный списки каталогов профиля.
 *
 * Правила сравниваются с каноническим путём — приводит его `path-guard`.
 */

import { posix } from 'path';

/** Правила доступа к путям, задаются в профиле */
export interface PathSecurityConfig {
  /** Каталоги, за пределы которых выходить нельзя */
  allowedPaths?: string[];
  /** Каталоги, закрытые независимо от белого списка */
  deniedPaths?: string[];
  /** Пропускать ли `..` в пути; по умолчанию да */
  allowTraversal?: boolean;
  /** Предел длины пути; по умолчанию без предела */
  maxPathLength?: number;
}

export interface PathValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Путь, о котором можно судить: абсолютный, без `.` и `..`, без сдвоенных
 * слэшей. Приводит к такому виду resolveRemotePath.
 *
 * Тильда отдельного условия не требует: раскрывается только ведущая, а она
 * невозможна у пути, начинающегося со слэша. В середине `~` — обычное имя
 * файла, и такой путь судится наравне с остальными.
 */
function isCanonical(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.includes('//')) return false;

  return path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/**
 * Каталог из правила в том же виде, в каком приходит проверяемый путь.
 * Тильда и относительный вид сюда не доходят: правило обязано быть абсолютным,
 * это проверяет загрузчик профилей.
 */
function normalizeRule(directory: string): string {
  return posix.normalize(directory);
}

/**
 * Лежит ли путь внутри каталога.
 *
 * Сравнение идёт по границе имени, иначе правило цепляет соседей: запрет
 * `/root` отклонял бы `/rootkit`, а разрешение `/var/log` пропускало бы
 * `/var/logs-of-someone-else` — другой каталог с похожим именем.
 */
export function isUnder(path: string, directory: string): boolean {
  const base = directory.length > 1 && directory.endsWith('/')
    ? directory.slice(0, -1)
    : directory;

  if (base === '/') return path.startsWith('/');

  return path === base || path.startsWith(`${base}/`);
}

/** Судит путь по правилам профиля: белый список, чёрный список, длина, `..` */
export class PathValidator {
  /** Правила сравнения, приведённые к виду проверяемого пути */
  private readonly deniedPaths: string[];
  private readonly allowedPaths: string[];

  constructor(private config?: PathSecurityConfig) {
    this.deniedPaths = (config?.deniedPaths ?? []).map(normalizeRule);
    this.allowedPaths = (config?.allowedPaths ?? []).map(normalizeRule);
  }

  /** Причина отказа или согласие: путь судится по всем заданным правилам */
  validate(path: string): PathValidationResult {
    if (!this.config) {
      return { valid: true };
    }

    if (this.config.maxPathLength && path.length > this.config.maxPathLength) {
      return {
        valid: false,
        error: `Path too long: ${path.length} chars (max ${this.config.maxPathLength})`
      };
    }
    
    if (this.config.allowTraversal === false && path.includes('..')) {
      return {
        valid: false,
        error: 'Path traversal (..) not allowed for security reasons'
      };
    }
    
    // Правила сравнивают путь с каталогами, поэтому судить можно только
    // канонический абсолютный путь: `~` и `logs/app.log` ведут неизвестно куда.
    // Приведением занимается resolveRemotePath
    if (!this.hasRules()) {
      return { valid: true };
    }

    if (!isCanonical(path)) {
      return {
        valid: false,
        error: `Path is not canonical: "${path}". Rules apply to absolute paths ` +
          'with no leading "~", no "." or ".." — resolve it before validating'
      };
    }

    // Чёрный список судит первым: он закрывает путь и внутри разрешённого
    for (const denied of this.deniedPaths) {
      if (isUnder(path, denied)) {
        return {
          valid: false,
          error: `Access denied to path: ${denied}`
        };
      }
    }

    if (this.allowedPaths.length > 0) {
      const isAllowed = this.allowedPaths.some(allowed => isUnder(path, allowed));

      if (!isAllowed) {
        return {
          valid: false,
          error: `Path not in allowed list. Allowed: ${this.allowedPaths.join(', ')}`
        };
      }
    }

    return { valid: true };
  }

  /** Есть ли правила, которые сравнивают путь с каталогами */
  private hasRules(): boolean {
    return this.deniedPaths.length > 0 || this.allowedPaths.length > 0;
  }
  
  /** Пачка путей: ответом становится первый отказ */
  validateBatch(paths: string[]): PathValidationResult {
    for (const path of paths) {
      const result = this.validate(path);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  }
}

/** Валидатор профиля, или ничего — если правил в профиле нет */
export function createPathValidator(sshConfig: any): PathValidator | undefined {
  if (sshConfig.pathSecurity) {
    return new PathValidator(sshConfig.pathSecurity);
  }
  return undefined;
}
