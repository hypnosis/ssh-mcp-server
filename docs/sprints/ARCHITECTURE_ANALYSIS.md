# 🔍 Анализ архитектуры SSH MCP Server

**Дата:** 2025-01-12  
**Версия:** v1.0.0 → v1.1.0  
**Статус:** Анализ завершён, план составлен

---

## 📊 EXECUTIVE SUMMARY

### Найдено проблем
- 🔴 **2 критичных** (производительность)
- 🟡 **2 важных** (стабильность)
- 🟢 **3 низкоприоритетных** (удобство)

### Общее влияние
- ⚡ **Производительность:** 6-10× медленнее чем могло бы быть
- 🔧 **Стабильность:** Race conditions, нет retry механизма
- 🛡️ **Безопасность:** Нет валидации путей
- 📋 **Удобство:** Тильда не работает, нет мониторинга

### План решения
- **5 спринтов** (5 дней)
- **Главный фокус:** Connection Pool (Sprint 2) - решает 80% проблем производительности
- **Ожидаемый результат:** v1.1.0 - production-ready с 6-10× ускорением

---

## 🔴 КРИТИЧЕСКИЕ ПРОБЛЕМЫ

### 1. НЕТ ПУЛИНГА SSH СОЕДИНЕНИЙ

**Текущая архитектура:**
```
USER → Tool → SSHExecutor.execute() → SSHManager.execute() → new Client()
                                                               ↓
                                                          Открыть TCP (200-500ms)
                                                          SSH handshake (300-800ms)
                                                          Key exchange (200-500ms)
                                                          Аутентификация (100-300ms)
                                                          Выполнить команду (10-100ms)
                                                          Закрыть соединение (50-100ms)
                                                          ────────────────────────────
                                                          ИТОГО: 1-2 секунды на команду
```

**Проблема:**
- 10 команд = 10 соединений = 10-20 секунд ❌
- Каждое соединение: TCP → SSH handshake → Key exchange → Auth → Exec → Close

**Правильная архитектура:**
```
ConnectionPool (Singleton)
  ├─ Profile "prod" → Client (keep-alive, reusable)
  ├─ Profile "dev" → Client (keep-alive, reusable)
  └─ Auto cleanup (idle timeout 30s)

10 команд = 1 соединение = 2-3 секунды ✅
  ├─ Connect (1.5s) - ОДИН РАЗ
  ├─ Exec 1 (0.1s)
  ├─ Exec 2 (0.1s)
  ├─ ...
  └─ Exec 10 (0.1s)
```

**Метрики:**
- Текущее: 10 команд = ~16 секунд
- С пулом: 10 команд = ~2.5 секунды
- **Ускорение: 6-10×** 🚀

**Решение:** Sprint 2 - Connection Pool

---

### 2. EXECUTEBATCH НЕЭФФЕКТИВЕН

**Код:**
```typescript
// ssh-manager.ts:99-112
async executeBatch(commands: string[]) {
  const results: string[] = [];
  
  for (const command of commands) {
    const result = await this.execute(config, command);  // ❌ Новое соединение!
    results.push(result);
  }
  
  return results;
}
```

**Проблема:**
```
executeBatch(["cmd1", "cmd2", ..., "cmd10"])

Command 1 → Connect (1.5s) → Exec (0.1s) → Close
Command 2 → Connect (1.5s) → Exec (0.1s) → Close
...
Command 10 → Connect (1.5s) → Exec (0.1s) → Close

ИТОГО: 10 × 1.6s = 16 секунд ❌
```

**Правильно (с пулом):**
```typescript
async executeBatch(commands: string[], profileName: string) {
  const client = await pool.getClient(profileName, config);  // ✅ Одно соединение
  
  const results: string[] = [];
  for (const command of commands) {
    const result = await this.executeOnClient(client, command);  // ✅ На одном клиенте
    results.push(result);
  }
  
  pool.releaseClient(profileName);
  return results;
}

Connect (1.5s) → Exec × 10 (1s) → Release
ИТОГО: 2.5 секунды ✅
```

**Метрики:**
- Текущее: batch из 10 команд = ~16 секунд
- С пулом: batch из 10 команд = ~2.5 секунды
- **Ускорение: 6-10×** 🚀

**Решение:** Sprint 2 - Connection Pool

---

## 🟡 ВАЖНЫЕ ПРОБЛЕМЫ

### 3. ТИЛЬДА НЕ РАСКРЫВАЕТСЯ (ISSUE-001)

**Проблема:**
```typescript
// file-tools.ts:182
const command = `cat '${this.escapePath(paths[0])}'`;

// Путь: "~/.bashrc"
// Команда: cat '~/.bashrc'  ❌ Shell видит литеральную тильду!

// Ошибка: cat: '~/.bashrc': No such file or directory
```

**Почему:**
- Single quotes (`'...'`) в bash НЕ раскрывают спецсимволы
- `~` раскрывается только в unquoted или double-quoted контексте
- `profile-resolver.ts` раскрывает `~` только для **локальных** ключей (privateKeyPath)
- Для **удалённых** путей тильда НЕ раскрывается

**Решения:**

**Вариант 1: eval (самое простое)**
```typescript
// Если путь содержит ~
if (path.includes('~')) {
  return `eval cat '${this.escapePath(path)}'`;  // eval раскроет ~
}
```

**Вариант 2: $HOME (чистое)**
```typescript
function expandRemoteTilde(path: string): string {
  if (path.startsWith('~/')) {
    return '$HOME/' + path.substring(2);  // ~/file → $HOME/file
  }
  return path;
}

// cat "$HOME/file"  (двойные кавычки для раскрытия $HOME)
```

**Решение:** Sprint 3 - Tilde Expansion

---

### 4. TIMEOUT RACE CONDITION

**Код:**
```typescript
// ssh-manager.ts:86-89
timeoutId = setTimeout(() => {
  client.end();
  reject(new Error('Timeout'));  // ❌ Может вызваться после resolve()
}, timeout);

stream.on('close', (code) => {
  clearTimeout(timeoutId);
  if (code !== 0) {
    reject(...);  // ❌ Может вызваться после timeout reject()
  } else {
    resolve(...);  // ❌ Может вызваться после timeout reject()
  }
});
```

**Race condition:**
```
Timeline:
0ms    → Timeout запущен
100ms  → SSH connected
5000ms → Command executing...
30000ms → TIMEOUT! → reject('Timeout')
30001ms → Stream closes → resolve(stdout)  ❌ Promise уже rejected!

Результат: UnhandledPromiseRejection или двойной callback
```

**Решение:**
```typescript
let settled = false;

const resolveOnce = (value) => {
  if (!settled) {
    settled = true;
    clearTimeout(timeoutId);
    client.end();
    resolve(value);
  }
};

const rejectOnce = (error) => {
  if (!settled) {
    settled = true;
    clearTimeout(timeoutId);
    client.end();
    reject(error);
  }
};

// Использовать везде resolveOnce/rejectOnce
```

**Решение:** Sprint 4 - Timeout Fix

---

## 🟢 НИЗКОПРИОРИТЕТНЫЕ ПРОБЛЕМЫ

### 5. ESCAPEPATH НЕ ПОЛНЫЙ

**Текущий код:**
```typescript
// file-tools.ts:382
private escapePath(path: string): string {
  return path.replace(/'/g, "'\"'\"'");  // Только single quotes
}
```

**Работает для:**
```bash
cat 'path/to/file'           ✅
cat 'path with spaces'       ✅
cat 'path$with$vars'         ✅ (литерально)
cat 'path`cmd`'              ✅ (литерально)
```

**Проблемы:**
```bash
cat 'path/to/file's/name'    → cat 'path/to/file'"'"'s/name'  ✅ (работает но уродливо)
cat 'path\nwith\nnewlines'   → Может быть проблема
```

**Улучшение:**
```typescript
// Метод 1: Single quotes с правильным экранированием
private escapePath(path: string): string {
  return path.replace(/'/g, "'\\''");  // ' → '\''
}

// Метод 2: printf %q (самый безопасный)
const safeCommand = `path=$(printf %q "${path}") && cat "$path"`;
```

**Решение:** Sprint 3 - Path Security

---

### 6. НЕТ ВАЛИДАЦИИ ПУТЕЙ

**Проблема:**
```typescript
ssh_file_read("../../../etc/passwd")  → ✅ Работает
ssh_file_read("/etc/shadow")          → ✅ Работает (если sudo)
ssh_file_read("/root/.ssh/id_rsa")   → ✅ Работает (если есть доступ)
```

**Риски:**
- AI может случайно читать чувствительные файлы
- Нет ограничений на path traversal
- Нет whitelist/blacklist

**Решение:**
```json
// В SSH_PROFILES_FILE:
{
  "profiles": {
    "production": {
      "pathSecurity": {
        "allowedPaths": ["/home/admin", "/var/www", "/var/log"],
        "deniedPaths": ["/etc/shadow", "/root", "/etc/ssh"],
        "allowTraversal": false,
        "maxPathLength": 1000
      }
    }
  }
}
```

**Решение:** Sprint 3 - Path Validator (опционально)

---

### 7. PROFILES СИНГЛТОН БЕЗ RELOAD

**Код:**
```typescript
// profile-resolver.ts:81
const PROFILES: ProfilesConfig = loadProfilesFromEnv();  // ❌ Один раз при импорте
```

**Проблема:**
```bash
# 1. Запустить сервер
npm start

# 2. Изменить SSH_PROFILES_FILE
vim ~/.ssh/mcp-profiles.json  # Добавить новый профиль

# 3. Попробовать использовать
ssh_exec("echo test", profile="new-profile")
→ Error: Profile not found  ❌ Нужен рестарт сервера!
```

**Решение 1: Кэш с TTL**
```typescript
let PROFILES_CACHE: { config: ProfilesConfig, loadedAt: number } | null = null;
const CACHE_TTL = 60000; // 1 минута

function getProfiles(): ProfilesConfig {
  if (!PROFILES_CACHE || Date.now() - PROFILES_CACHE.loadedAt > CACHE_TTL) {
    PROFILES_CACHE = { config: loadProfilesFromEnv(), loadedAt: Date.now() };
  }
  return PROFILES_CACHE.config;
}
```

**Решение 2: File watcher**
```typescript
import { watch } from 'fs';

watch(profilesFile, (eventType) => {
  if (eventType === 'change') {
    logger.info('Profiles file changed, reloading...');
    PROFILES_CACHE = null;
    getProfiles();
  }
});
```

**Решение:** Sprint 5 - Profile Reload + File Watcher

---

## 📐 ДИАГРАММЫ

### Текущая архитектура (v1.0.0)
```
┌─────────────────────────────────────────────────────────┐
│  USER (AI Assistant)                                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  MCP Server (index.ts)                                  │
│  ├─ ExecTool                                            │
│  ├─ FileTools                                           │
│  ├─ LogTools                                            │
│  └─ SnapshotTool                                        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  SSHExecutor (каждый Tool создаёт свой экземпляр)      │
│  ❌ ПРОБЛЕМА: Нет переиспользования                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│  SSHManager (создаётся в SSHExecutor)                   │
│  ❌ ПРОБЛЕМА: Нет синглтона                             │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
  ┌───────────────┐     ┌───────────────┐
  │ new Client()  │     │ new Client()  │  ❌ Каждый раз новый!
  │ Connect       │     │ Connect       │
  │ Auth          │     │ Auth          │
  │ Exec          │     │ Exec          │
  │ Close         │     │ Close         │
  └───────────────┘     └───────────────┘
     Command 1             Command 2
     ~1.5-2s              ~1.5-2s

  10 команд = 10 соединений = 15-20 секунд ❌
```

### Целевая архитектура (v1.1.0)
```
┌─────────────────────────────────────────────────────────┐
│  MCP Server                                             │
│  ├─ ExecTool ─────────┐                                 │
│  ├─ FileTools ────────┤                                 │
│  ├─ LogTools ─────────┼─► ConnectionPool (Singleton)   │
│  ├─ SnapshotTool ─────┤    │                            │
│  └─ MonitoringTool ───┘    │                            │
│                      ┌─────┴─────┐                      │
│                      │           │                      │
│                  Profile A   Profile B                  │
│                   Client      Client                    │
│                (keep-alive) (keep-alive)                │
│                   │           │                         │
│            ┌──────┴───────────┴──────┐                  │
│            │  Idle Cleanup (30s)     │                  │
│            │  Auto-reconnect         │                  │
│            │  Retry (3×)             │                  │
│            └──────────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
                     │
                     ▼
          ┌──────────┴──────────┐
          ▼                     ▼
    Server A                Server B
   (1 connection)         (1 connection)
   Reused for all         Reused for all
   commands               commands

   10 команд = 1 connection = 2-3 секунды ✅
   6-10× БЫСТРЕЕ! 🚀
```

---

## 📈 МЕТРИКИ ПРОИЗВОДИТЕЛЬНОСТИ

### Benchmark: 10 команд подряд

**Текущее (v1.0.0):**
```
Command 1: Connect (1.5s) + Exec (0.1s) = 1.6s
Command 2: Connect (1.5s) + Exec (0.1s) = 1.6s
Command 3: Connect (1.5s) + Exec (0.1s) = 1.6s
...
Command 10: Connect (1.5s) + Exec (0.1s) = 1.6s

ИТОГО: ~16 секунд ❌
```

**С Connection Pool (v1.1.0):**
```
Command 1: Connect (1.5s) + Exec (0.1s) = 1.6s
Command 2: Reuse + Exec (0.1s) = 0.1s
Command 3: Reuse + Exec (0.1s) = 0.1s
...
Command 10: Reuse + Exec (0.1s) = 0.1s

ИТОГО: ~2.5 секунды ✅
УСКОРЕНИЕ: 6.4× 🚀
```

### Benchmark: Batch из 10 команд

**Текущее (v1.0.0):**
```
executeBatch(["cmd1", ..., "cmd10"])
→ 10 соединений последовательно
→ ~16 секунд ❌
```

**С Connection Pool (v1.1.0):**
```
executeBatch(["cmd1", ..., "cmd10"])
→ 1 соединение для всех команд
→ ~2.5 секунды ✅
УСКОРЕНИЕ: 6.4× 🚀
```

### Cache Hit Rate (ожидаемый)

```
Scenario: Работа с одним профилем
├─ First command: Cache MISS → Connect (1.5s)
├─ Commands 2-100: Cache HIT → Reuse (0.1s each)
└─ Cache Hit Rate: 99% ✅

Scenario: Переключение между профилями
├─ Profile A (1st): MISS → Connect (1.5s)
├─ Profile A (2-10): HIT → Reuse (0.1s)
├─ Profile B (1st): MISS → Connect (1.5s)
├─ Profile B (2-10): HIT → Reuse (0.1s)
└─ Cache Hit Rate: 90% ✅
```

---

## 🎯 ПРИОРИТЕТЫ

### Must Have (v1.1.0)
1. ✅ Connection Pool (**Sprint 2**) - критично для производительности
2. ✅ Tilde expansion (**Sprint 3**) - исправить ISSUE-001
3. ✅ Timeout fix (**Sprint 4**) - стабильность

### Should Have (v1.1.0)
4. ✅ Path security (**Sprint 3**) - безопасность
5. ✅ Retry mechanism (**Sprint 4**) - надёжность

### Nice to Have (v1.1.0)
6. ✅ Profile reload (**Sprint 5**) - удобство
7. ✅ Monitoring tool (**Sprint 5**) - мониторинг
8. ⭕ Path validator (опционально)

---

## 📝 СЛЕДУЮЩИЕ ШАГИ

### 1. Прочитать детальные планы спринтов
```bash
# Roadmap
cat docs/sprints/ROADMAP.md

# Sprint 2 (КРИТИЧНО - начать с него!)
cat docs/sprints/2025-01-13_SPRINT_2_CONNECTION_POOL.md

# Sprint 3
cat docs/sprints/2025-01-15_SPRINT_3_PATH_SECURITY.md

# Sprint 4
cat docs/sprints/2025-01-16_SPRINT_4_TIMEOUT_ERRORS.md

# Sprint 5
cat docs/sprints/2025-01-17_SPRINT_5_PROFILES_MONITORING.md
```

### 2. Начать с Sprint 2 (Connection Pool)
- **Самый критичный**
- Решает 80% проблем производительности
- 6-10× ускорение

### 3. Далее по порядку (Sprint 3 → 4 → 5)
- Каждый спринт независим
- Можно делать параллельно (разные агенты)
- Общее время: 5 дней

### 4. После завершения всех спринтов
- Релиз v1.1.0
- Обновить CHANGELOG.md
- Закрыть ISSUE-001
- Celebration! 🎉

---

## 🏆 ОЖИДАЕМЫЙ РЕЗУЛЬТАТ

После завершения всех спринтов:

### Производительность
- ⚡ **6-10× быстрее** для последовательных команд
- ⚡ **6-10× быстрее** для batch операций
- ⚡ Cache hit rate >80%

### Стабильность
- 🔧 Нет race conditions в timeout
- 🔧 Автоматический retry при сбоях (3 попытки)
- 🔧 Auto-reconnect при потере соединения

### Удобство
- 📋 Тильда работает корректно
- 📋 Понятные error messages
- 📋 Profile reload без рестарта
- 📋 Мониторинг через ssh_monitor

### Безопасность
- 🛡️ Безопасное экранирование путей
- 🛡️ Опциональная валидация путей

**PRODUCTION READY! 🚀**
