# 🎯 SPRINT 3: Path Security & Tilde Expansion

**Статус:** ✅ ЗАВЕРШЕНО  
**Период:** Week 2, Day 3 (2025-01-15)  
**Дата начала:** 2025-01-15  
**Дата завершения:** 2025-01-15  
**Приоритет:** 🟡 СРЕДНИЙ (безопасность и удобство)

## 📋 ОПИСАНИЕ

Исправление проблем с путями:
1. Раскрытие тильды (~) на удалённой стороне (ISSUE-001)
2. Улучшение escapePath для безопасности
3. Опциональная валидация путей (whitelist/blacklist)

## 🎯 ЗАДАЧИ

### 1. Исправить раскрытие тильды на удалённой стороне 🟡 ВАЖНО
**Файл:** `src/tools/file-tools.ts`  
**Агент:** SONNET 4.5  
**Время:** 30 минут

**Проблема (ISSUE-001):**
```typescript
// Сейчас:
ssh_file_read("~/.bashrc")  → cat '~/.bashrc'  ❌ Тильда не раскрывается!

// Ошибка: cat: '~/.bashrc': No such file or directory
```

**Решение:**
```typescript
// Опция 1: Использовать $HOME (рекомендуется)
private expandRemoteTilde(path: string): string {
  if (path.startsWith('~/')) {
    return '$HOME/' + path.substring(2);  // ~/file → $HOME/file
  }
  if (path === '~') {
    return '$HOME';
  }
  return path;
}

// В handleFileRead:
const expandedPath = this.expandRemoteTilde(paths[0]);
const command = encoding === 'base64'
  ? `base64 "${expandedPath}"`  // Двойные кавычки для раскрытия $HOME
  : `cat "${expandedPath}"`;

// Опция 2: Явное раскрытие через eval
const command = `eval cat "\\$(echo ~)/file"`;

// Опция 3: Раскрыть через подкоманду
const command = `HOME_DIR=$(echo ~) && cat "$HOME_DIR/file"`;
```

**Рекомендуемая реализация:**
```typescript
class FileTools {
  /**
   * Expand tilde (~) for remote execution
   * Converts ~ to $HOME for shell expansion
   */
  private expandRemoteTilde(path: string): string {
    if (!path) return path;
    
    // ~/path → $HOME/path
    if (path.startsWith('~/')) {
      return '$HOME/' + path.substring(2);
    }
    
    // ~ → $HOME
    if (path === '~') {
      return '$HOME';
    }
    
    // ~user/path → ~user/path (оставляем как есть - shell раскроет)
    if (path.startsWith('~')) {
      return path;
    }
    
    return path;
  }
  
  /**
   * Build cat command with tilde expansion
   */
  private buildCatCommand(path: string, encoding: string = 'utf8'): string {
    const expandedPath = this.expandRemoteTilde(path);
    
    // Используем двойные кавычки для раскрытия $HOME
    if (encoding === 'base64') {
      return `base64 "${this.escapeDoubleQuotePath(expandedPath)}"`;
    } else {
      return `cat "${this.escapeDoubleQuotePath(expandedPath)}"`;
    }
  }
  
  /**
   * Escape path for double-quoted context
   */
  private escapeDoubleQuotePath(path: string): string {
    return path
      .replace(/\\/g, '\\\\')   // \ → \\
      .replace(/"/g, '\\"')     // " → \"
      .replace(/\$/g, '\\$')    // $ → \$ (но НЕ в $HOME!)
      .replace(/`/g, '\\`');    // ` → \`
  }
}
```

**⚠️ ПРОБЛЕМА:** `$HOME` тоже нужно экранировать, НО мы хотим его раскрыть!

**Правильное решение:**
```typescript
private buildCatCommand(path: string, encoding: string = 'utf8'): string {
  const expandedPath = this.expandRemoteTilde(path);
  
  // Разделяем на части: $HOME и остальное
  let finalPath = expandedPath;
  
  // Если путь начинается с $HOME - не экранируем $HOME
  if (expandedPath.startsWith('$HOME')) {
    const homePrefix = '$HOME';
    const restPath = expandedPath.substring(5); // После $HOME
    
    // Экранируем только часть после $HOME
    const escapedRest = restPath
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')  // Экранируем $ в остальной части
      .replace(/`/g, '\\`');
    
    finalPath = homePrefix + escapedRest;
  } else {
    // Обычный путь - экранируем всё
    finalPath = this.escapeDoubleQuotePath(expandedPath);
  }
  
  // Строим команду
  if (encoding === 'base64') {
    return `base64 "${finalPath}"`;
  } else {
    return `cat "${finalPath}"`;
  }
}
```

**Альтернатива (ПРОЩЕ):** Использовать eval
```typescript
private buildCatCommand(path: string, encoding: string = 'utf8'): string {
  // Если путь содержит ~, используем eval для раскрытия
  if (path.includes('~')) {
    const escapedPath = this.escapePath(path);  // Single quotes
    
    if (encoding === 'base64') {
      return `eval base64 ${escapedPath}`;  // eval раскроет ~ внутри
    } else {
      return `eval cat ${escapedPath}`;
    }
  }
  
  // Обычный путь без тильды
  if (encoding === 'base64') {
    return `base64 '${this.escapePath(path)}'`;
  } else {
    return `cat '${this.escapePath(path)}'`;
  }
}
```

**Тесты:**
```typescript
// Тест 1: ~/file
ssh_file_read("~/.bashrc")  → eval cat '~/.bashrc'  ✅

// Тест 2: /absolute/path
ssh_file_read("/etc/hosts") → cat '/etc/hosts'  ✅

// Тест 3: relative/path
ssh_file_read("./file.txt") → cat './file.txt'  ✅

// Тест 4: ~user/file
ssh_file_read("~admin/.bashrc") → eval cat '~admin/.bashrc'  ✅

// Тест 5: ~ alone
ssh_file_read("~") → eval cat '~'  ✅
```

**Применить к:**
- `ssh_file_read` - все пути
- `ssh_file_write` - все пути
- `ssh_file_list` - директории
- `ssh_log_tail` - пути к логам
- `ssh_log_search` - пути к логам

---

### 2. Улучшить escapePath для безопасности 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/tools/file-tools.ts`  
**Агент:** SONNET 4.5  
**Время:** 20 минут

**Текущая проблема:**
```typescript
private escapePath(path: string): string {
  return path.replace(/'/g, "'\"'\"'");  // Только single quotes
}

// Работает для single-quoted контекста:
cat 'path/to/file'  ✅
cat 'path with spaces'  ✅
cat 'path$with$vars'  ✅

// НО проблемы с самими single quotes:
cat 'path/to/file's/name'  → cat 'path/to/file'"'"'s/name'  ✅ (работает но уродливо)
```

**Улучшенная версия:**
```typescript
/**
 * Escape path for shell execution
 * Uses single quotes (safest) with proper handling of embedded single quotes
 */
private escapePath(path: string): string {
  // Метод 1: Single quotes с экранированием внутренних single quotes
  // 'path' → заменить ' на '\''
  return path.replace(/'/g, "'\\''");
  
  // Пример: path/to/file's → 'path/to/file'\''s'
  // Shell интерпретирует: 'path/to/file' + \' + 's'
}

/**
 * Escape path for double-quoted context
 * Used when we need variable expansion (e.g., $HOME)
 */
private escapeDoubleQuotePath(path: string): string {
  return path
    .replace(/\\/g, '\\\\')   // \ → \\
    .replace(/"/g, '\\"')     // " → \"
    .replace(/\$/g, '\\$')    // $ → \$ (prevent var expansion)
    .replace(/`/g, '\\`')     // ` → \` (prevent command substitution)
    .replace(/!/g, '\\!');    // ! → \! (prevent history expansion)
}

/**
 * Choose appropriate escaping based on context
 */
private buildSafeCommand(path: string, command: string): string {
  // Если путь содержит тильду или переменные - используем eval + single quotes
  if (path.includes('~') || path.startsWith('$')) {
    return `eval ${command} '${this.escapePath(path)}'`;
  }
  
  // Обычный путь - single quotes
  return `${command} '${this.escapePath(path)}'`;
}
```

**Тесты безопасности:**
```typescript
// Тест 1: Single quote в имени
"/tmp/file's name.txt" → cat '/tmp/file'\''s name.txt'  ✅

// Тест 2: Пробелы
"/tmp/file with spaces.txt" → cat '/tmp/file with spaces.txt'  ✅

// Тест 3: Переменные (не должны раскрываться)
"/tmp/file$VAR.txt" → cat '/tmp/file$VAR.txt'  ✅ (литерально $VAR)

// Тест 4: Command substitution (не должна выполняться)
"/tmp/file`cmd`.txt" → cat '/tmp/file`cmd`.txt'  ✅ (литерально `cmd`)

// Тест 5: Injection попытка
"/tmp/file; rm -rf /" → cat '/tmp/file; rm -rf /'  ✅ (безопасно)

// Тест 6: Newline
"/tmp/file\n.txt" → cat '/tmp/file\n.txt'  ✅ (литерально \n)
```

---

### 3. Добавить валидацию путей (опционально) 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/utils/path-validator.ts` (новый)  
**Агент:** SONNET 4.5  
**Время:** 40 минут

**Концепция:**
```json
// В SSH_PROFILES_FILE добавить опции безопасности:
{
  "profiles": {
    "production": {
      "host": "server.com",
      "username": "admin",
      "privateKeyPath": "~/.ssh/key",
      
      // ✨ Новые опции безопасности (опционально)
      "pathSecurity": {
        "allowedPaths": ["/home/admin", "/var/www", "/var/log"],
        "deniedPaths": ["/etc/shadow", "/root", "/etc/ssh"],
        "allowTraversal": false,  // Запретить ../
        "maxPathLength": 1000
      }
    }
  }
}
```

**Реализация:**
```typescript
// path-validator.ts
export interface PathSecurityConfig {
  allowedPaths?: string[];      // Whitelist
  deniedPaths?: string[];       // Blacklist
  allowTraversal?: boolean;     // Разрешить ../
  maxPathLength?: number;       // Макс длина пути
}

export class PathValidator {
  constructor(private config?: PathSecurityConfig) {}
  
  /**
   * Validate file path against security rules
   */
  validate(path: string): { valid: boolean; error?: string } {
    if (!this.config) {
      return { valid: true };  // Без конфига - без валидации
    }
    
    // 1. Check max length
    if (this.config.maxPathLength && path.length > this.config.maxPathLength) {
      return {
        valid: false,
        error: `Path too long (max ${this.config.maxPathLength} chars)`
      };
    }
    
    // 2. Check traversal (../)
    if (!this.config.allowTraversal && path.includes('../')) {
      return {
        valid: false,
        error: 'Path traversal (..) not allowed'
      };
    }
    
    // 3. Normalize path for checks
    const normalized = this.normalizePath(path);
    
    // 4. Check denied paths (blacklist)
    if (this.config.deniedPaths) {
      for (const denied of this.config.deniedPaths) {
        if (normalized.startsWith(denied)) {
          return {
            valid: false,
            error: `Access denied to path: ${denied}`
          };
        }
      }
    }
    
    // 5. Check allowed paths (whitelist)
    if (this.config.allowedPaths && this.config.allowedPaths.length > 0) {
      const isAllowed = this.config.allowedPaths.some(allowed =>
        normalized.startsWith(allowed)
      );
      
      if (!isAllowed) {
        return {
          valid: false,
          error: `Path not in allowed list: ${this.config.allowedPaths.join(', ')}`
        };
      }
    }
    
    return { valid: true };
  }
  
  /**
   * Normalize path for comparison
   */
  private normalizePath(path: string): string {
    // ~ → /home/user (примерно)
    if (path.startsWith('~/')) {
      return '/home/' + path.substring(2);  // Упрощённо
    }
    
    // ./path → path
    if (path.startsWith('./')) {
      return path.substring(2);
    }
    
    return path;
  }
}
```

**Интеграция в FileTools:**
```typescript
class FileTools {
  private validator?: PathValidator;
  
  constructor() {
    this.executor = new SSHExecutor();
  }
  
  private async handleFileRead(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const sshConfig = resolveSSHConfig({ profile: args.profile });
    
    // ✨ Создать валидатор для профиля
    if (sshConfig.pathSecurity) {
      this.validator = new PathValidator(sshConfig.pathSecurity);
    }
    
    const paths = Array.isArray(args.path) ? args.path : [args.path];
    
    // ✨ Валидировать каждый путь
    for (const path of paths) {
      const validation = this.validator?.validate(path);
      if (validation && !validation.valid) {
        throw new Error(`Path validation failed: ${validation.error}`);
      }
    }
    
    // Продолжить выполнение...
  }
}
```

**Тесты:**
```typescript
// Конфиг:
{
  allowedPaths: ["/home/admin", "/var/log"],
  deniedPaths: ["/etc/shadow"],
  allowTraversal: false
}

// Тест 1: Allowed path
"/home/admin/file.txt" → ✅ Valid

// Тест 2: Denied path
"/etc/shadow" → ❌ Access denied

// Тест 3: Not in whitelist
"/tmp/file.txt" → ❌ Not in allowed list

// Тест 4: Traversal
"../../../etc/passwd" → ❌ Traversal not allowed

// Тест 5: Allowed with subdir
"/home/admin/subdir/file.txt" → ✅ Valid (starts with /home/admin)
```

---

### 4. Обновить документацию 🟢 ОБЯЗАТЕЛЬНО
**Файлы:**
- `docs/BUGLIST.md` - закрыть ISSUE-001
- `README.md` - добавить раздел про pathSecurity
- `CHANGELOG.md` - добавить изменения

**Агент:** HAIKU  
**Время:** 20 минут

**Что добавить в README.md:**
```markdown
## 🛡️ Path Security (Optional)

You can configure path validation rules in your SSH profiles:

```json
{
  "profiles": {
    "production": {
      "host": "server.com",
      "username": "admin",
      
      "pathSecurity": {
        "allowedPaths": ["/home/admin", "/var/www"],
        "deniedPaths": ["/etc/shadow", "/root"],
        "allowTraversal": false,
        "maxPathLength": 1000
      }
    }
  }
}
```

- `allowedPaths`: Whitelist of allowed directories
- `deniedPaths`: Blacklist of forbidden paths
- `allowTraversal`: Allow `../` in paths (default: true)
- `maxPathLength`: Maximum path length (default: unlimited)

**Note:** Path security is optional. If not configured, all paths are allowed.
```

**Обновить BUGLIST.md:**
```markdown
### ✅ ISSUE-001: Тильда не раскрывается в путях файлов [ИСПРАВЛЕНО]

**Описание:** При использовании `ssh_file_read` с путями содержащими тильду (`~`), команда `cat` не может найти файл

**Статус:** ✅ ИСПРАВЛЕНО в v1.1.0

**Решение:** Добавлено автоматическое раскрытие тильды через `eval`:
- `~/file` → `eval cat '~/file'` → shell раскрывает `~`
- `~user/file` → `eval cat '~user/file'` → shell раскрывает `~user`

**Компоненты:** `file-tools.ts`, `log-tools.ts`
```

---

## 📊 ОЖИДАЕМЫЙ РЕЗУЛЬТАТ

**До:**
```bash
ssh_file_read("~/.bashrc")
# Error: cat: '~/.bashrc': No such file or directory  ❌

ssh_file_read("/etc/shadow")  # Нет защиты
# Success: <shadow contents>  ⚠️ Небезопасно
```

**После:**
```bash
ssh_file_read("~/.bashrc")
# Success: <bashrc contents>  ✅ Тильда раскрывается

ssh_file_read("/etc/shadow")  # С pathSecurity
# Error: Access denied to path: /etc/shadow  ✅ Защищено

ssh_file_read("../../../etc/passwd")
# Error: Path traversal (..) not allowed  ✅ Защищено
```

---

## 🧪 ТЕСТИРОВАНИЕ

**Тесты тильды:**
1. `ssh_file_read("~/.bashrc")` → успех
2. `ssh_file_read("~/folder/file.txt")` → успех
3. `ssh_file_read("~admin/.bashrc")` → успех
4. `ssh_file_write("~/test.txt", "content")` → успех

**Тесты безопасности:**
1. Path с `'` → корректно экранируется
2. Path с пробелами → корректно экранируется
3. Path с `$VAR` → НЕ раскрывается (литерально)
4. Path с `` `cmd` `` → НЕ выполняется (литерально)

**Тесты валидации (с pathSecurity):**
1. Allowed path → успех
2. Denied path → ошибка
3. Path traversal → ошибка (если allowTraversal=false)
4. Path too long → ошибка

---

## 📝 ЧЕКЛИСТ ЗАВЕРШЕНИЯ

- [x] Тильда раскрывается в file-tools.ts ✅
- [x] Тильда раскрывается в log-tools.ts ✅
- [x] escapePath улучшен для безопасности ✅
- [x] PathValidator реализован (опционально) ✅
- [x] PathValidator интегрирован в FileTools ✅
- [x] PathValidator интегрирован в LogTools ✅
- [x] Тесты тильды пройдены ✅ (37 тестов)
- [x] Тесты безопасности пройдены ✅
- [x] Тесты валидации пройдены ✅
- [x] Документация обновлена (README, BUGLIST, CHANGELOG) ✅
- [x] ISSUE-001 закрыт ✅

## 📊 РЕЗУЛЬТАТЫ ВЫПОЛНЕНИЯ

### ✅ Выполнено:
1. **Tilde Expansion** - Реализовано через `$HOME` с двойными кавычками
   - `~/file` → `$HOME/file` → `cat "$HOME/file"` ✅
   - Работает во всех file/log tools
   - Безопасное экранирование всех спецсимволов кроме `$HOME`

2. **Path Escaping** - Два метода экранирования:
   - `escapeForSingleQuotes()` - для обычных путей (безопаснее)
   - `escapeForDoubleQuotes()` - для путей с `$HOME` (экранирует `\`, `"`, `$`, `` ` ``, `!`)

3. **PathValidator** - Опциональная валидация путей:
   - Whitelist (`allowedPaths`)
   - Blacklist (`deniedPaths`)
   - Path traversal protection (`allowTraversal: false`)
   - Max path length (`maxPathLength`)
   - Интегрирован в file-tools.ts и log-tools.ts

4. **Тесты** - 37 unit тестов в `tests/unit/path-security.test.ts`:
   - ✅ Все тесты пройдены
   - Покрытие: tilde expansion, path escaping, PathValidator, security scenarios

5. **Документация**:
   - ✅ README.md - добавлена секция Path Security
   - ✅ BUGLIST.md - закрыты ISSUE-001, ARCH-004, ARCH-005
   - ✅ CHANGELOG.md - добавлена версия 2.1.0

### 📁 Изменённые файлы:
- `src/tools/file-tools.ts` - tilde expansion, path escaping, PathValidator
- `src/tools/log-tools.ts` - tilde expansion, path escaping, PathValidator
- `src/utils/path-validator.ts` - новый файл (PathValidator класс)
- `tests/unit/path-security.test.ts` - новый файл (37 тестов)
- `docs/BUGLIST.md` - обновлён статус issues
- `README.md` - добавлена документация
- `CHANGELOG.md` - добавлена версия 2.1.0

### 🎯 Решённые проблемы:
- ✅ ISSUE-001 - Тильда не раскрывается в путях файлов
- ✅ ARCH-004 - Неполное экранирование путей
- ✅ ARCH-005 - Нет валидации путей

---

## 🔗 СВЯЗАННЫЕ ISSUES

- Решает: ISSUE-001 (Тильда не раскрывается в путях)
- Решает: escapePath не полный (проблема #3 из анализа)
- Решает: Нет валидации путей (проблема #5 из анализа)

---

## 🎯 СЛЕДУЮЩИЙ SPRINT

После завершения Path Security → Sprint 4: Timeout & Error Handling
