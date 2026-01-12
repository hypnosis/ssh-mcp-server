# 🎯 SPRINT 5: Profiles Reload & Monitoring

**Статус:** 🔴 ПЛАНИРУЕТСЯ  
**Период:** Week 2, Day 5 (2025-01-17)  
**Дата начала:** 2025-01-17  
**Приоритет:** 🟢 НИЗКИЙ (удобство и мониторинг)

## 📋 ОПИСАНИЕ

Улучшения для удобства разработки и мониторинга:
1. Reload профилей без рестарта сервера (проблема #7)
2. Мониторинг состояния соединений
3. Debug tool для диагностики
4. Health check endpoint (опционально)

## 🎯 ЗАДАЧИ

### 1. Добавить reload профилей без рестарта 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/utils/profile-resolver.ts`  
**Агент:** SONNET 4.5  
**Время:** 40 минут

**Проблема:**
```typescript
// СЕЙЧАС: Profiles загружаются один раз при импорте модуля
const PROFILES: ProfilesConfig = loadProfilesFromEnv();  // ❌ Один раз

// Изменения в SSH_PROFILES_FILE не подхватываются без рестарта сервера
```

**Решение 1: Кэш с TTL**
```typescript
// profile-resolver.ts
interface ProfilesCache {
  config: ProfilesConfig;
  loadedAt: number;
  filePath: string;
}

let PROFILES_CACHE: ProfilesCache | null = null;
const CACHE_TTL = 60000; // 1 минута

/**
 * Get profiles with caching and auto-reload
 */
function getProfiles(): ProfilesConfig {
  const profilesFile = process.env.SSH_PROFILES_FILE;
  
  if (!profilesFile) {
    throw new Error('SSH_PROFILES_FILE not set');
  }
  
  // Проверить кэш
  const now = Date.now();
  const cacheValid = PROFILES_CACHE &&
                     PROFILES_CACHE.filePath === profilesFile &&
                     (now - PROFILES_CACHE.loadedAt) < CACHE_TTL;
  
  if (cacheValid) {
    logger.debug('[Profiles] Using cached profiles');
    return PROFILES_CACHE!.config;
  }
  
  // Загрузить профили заново
  logger.debug(`[Profiles] Cache expired or invalid, reloading from ${profilesFile}`);
  
  const config = loadProfilesFromEnv();
  
  PROFILES_CACHE = {
    config,
    loadedAt: now,
    filePath: profilesFile
  };
  
  logger.info(`[Profiles] Reloaded ${Object.keys(config.profiles).length} profiles`);
  
  return config;
}

/**
 * Force reload profiles (manual)
 */
export function reloadProfiles(): void {
  logger.info('[Profiles] Manual reload requested');
  PROFILES_CACHE = null;
  getProfiles();  // Загрузить заново
}

/**
 * Resolve SSH config (теперь использует getProfiles)
 */
export function resolveSSHConfig(args: { profile?: string }): SSHConfig {
  const PROFILES = getProfiles();  // ✅ С кэшем и TTL
  
  // ... rest of logic
}
```

**Решение 2: File watcher (более продвинуто)**
```typescript
// profile-resolver.ts
import { watch } from 'fs';

let fileWatcher: ReturnType<typeof watch> | null = null;

/**
 * Watch SSH_PROFILES_FILE for changes
 */
function watchProfilesFile(filePath: string): void {
  if (fileWatcher) {
    fileWatcher.close();
  }
  
  logger.debug(`[Profiles] Watching ${filePath} for changes...`);
  
  fileWatcher = watch(filePath, (eventType) => {
    if (eventType === 'change') {
      logger.info(`[Profiles] SSH_PROFILES_FILE changed, reloading...`);
      
      // Invalidate cache
      PROFILES_CACHE = null;
      
      try {
        getProfiles();  // Reload
        logger.info('[Profiles] ✅ Profiles reloaded successfully');
      } catch (error: any) {
        logger.error(`[Profiles] ❌ Failed to reload profiles: ${error.message}`);
      }
    }
  });
}

// Start watching on module import
const profilesFile = process.env.SSH_PROFILES_FILE;
if (profilesFile) {
  watchProfilesFile(profilesFile);
}
```

**Решение 3: Оба подхода (лучший вариант)**
```typescript
// Кэш + File watcher + Manual reload
let PROFILES_CACHE: ProfilesCache | null = null;
const CACHE_TTL = 60000; // 1 минута (fallback если watcher не работает)

function getProfiles(): ProfilesConfig {
  // Check cache (with TTL fallback)
  const now = Date.now();
  if (PROFILES_CACHE && (now - PROFILES_CACHE.loadedAt) < CACHE_TTL) {
    return PROFILES_CACHE.config;
  }
  
  // Reload
  const config = loadProfilesFromEnv();
  PROFILES_CACHE = { config, loadedAt: now, filePath: profilesFile! };
  
  return config;
}

// File watcher для instant reload
watchProfilesFile(profilesFile);

// Manual reload для debug
export function reloadProfiles(): void {
  PROFILES_CACHE = null;
  getProfiles();
}
```

**Интеграция в ConnectionPool:**
```typescript
// connection-pool.ts
async getClient(profileName: string, config: SSHConfig): Promise<Client> {
  const existing = this.connections.get(profileName);
  
  // Проверить изменился ли config профиля
  if (existing && this.hasConfigChanged(existing.config, config)) {
    logger.info(`[Pool] Config changed for "${profileName}", reconnecting...`);
    
    // Close old connection
    await this.closeClient(profileName);
    
    // Create new with updated config
    // ... (fallthrough to create new)
  }
  
  // ... rest of logic
}

/**
 * Check if SSH config has changed
 */
private hasConfigChanged(old: SSHConfig, new: SSHConfig): boolean {
  return old.host !== new.host ||
         old.port !== new.port ||
         old.username !== new.username ||
         old.privateKeyPath !== new.privateKeyPath ||
         old.password !== new.password ||
         old.passphrase !== new.passphrase;
}
```

---

### 2. Добавить SSH tool для мониторинга 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/tools/monitoring-tool.ts` (новый)  
**Агент:** SONNET 4.5  
**Время:** 1 час

**Реализация:**
```typescript
// monitoring-tool.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConnectionPool } from '../managers/connection-pool.js';
import { getAvailableProfiles, getDefaultProfile, reloadProfiles } from '../utils/profile-resolver.js';

export class MonitoringTool {
  getTool(): Tool {
    return {
      name: 'ssh_monitor',
      description: 'Monitor SSH connections and server status. Get stats, reload profiles, test connections.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['stats', 'reload', 'test', 'list'],
            description: 'Action to perform: stats (get stats), reload (reload profiles), test (test connection), list (list profiles)'
          },
          profile: {
            type: 'string',
            description: 'Profile name (for test action)'
          }
        },
        required: ['action']
      }
    };
  }
  
  async handleCall(request: CallToolRequest) {
    const args = request.params.arguments as any;
    const action = args.action;
    
    switch (action) {
      case 'stats':
        return this.getStats();
      
      case 'reload':
        return this.reloadProfiles();
      
      case 'test':
        return this.testConnection(args.profile);
      
      case 'list':
        return this.listProfiles();
      
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
  
  /**
   * Get connection pool statistics
   */
  private async getStats() {
    const pool = ConnectionPool.getInstance();
    const stats = pool.getStats();
    
    let output = '📊 SSH Connection Pool Statistics\n\n';
    
    output += `🔢 Metrics:\n`;
    output += `  Total Connections: ${stats.totalConnections}\n`;
    output += `  Active Connections: ${stats.activeConnections}\n`;
    output += `  Total Commands: ${stats.totalCommands}\n`;
    output += `  Cache Hits: ${stats.cacheHits}\n`;
    output += `  Cache Misses: ${stats.cacheMisses}\n`;
    output += `  Reconnects: ${stats.reconnects}\n`;
    
    if (stats.cacheHits + stats.cacheMisses > 0) {
      const hitRate = (stats.cacheHits / (stats.cacheHits + stats.cacheMisses) * 100).toFixed(1);
      output += `  Cache Hit Rate: ${hitRate}%\n`;
    }
    
    output += `\n🔗 Active Connections:\n`;
    if (stats.connections.length === 0) {
      output += `  No active connections\n`;
    } else {
      for (const conn of stats.connections) {
        const idleTime = Math.floor(conn.idleTime / 1000);
        const status = conn.isReady ? '✅' : '❌';
        
        output += `  ${status} ${conn.profileName}\n`;
        output += `     Active Commands: ${conn.activeCommands}\n`;
        output += `     Idle Time: ${idleTime}s\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }
  
  /**
   * Reload SSH profiles
   */
  private async reloadProfiles() {
    try {
      const beforeCount = getAvailableProfiles().length;
      
      reloadProfiles();
      
      const afterCount = getAvailableProfiles().length;
      const profiles = getAvailableProfiles();
      const defaultProfile = getDefaultProfile();
      
      let output = '🔄 SSH Profiles Reloaded\n\n';
      output += `✅ Loaded ${afterCount} profiles (was ${beforeCount})\n\n`;
      output += `📋 Available Profiles:\n`;
      
      for (const profile of profiles) {
        const isDefault = profile === defaultProfile ? ' (default)' : '';
        output += `  • ${profile}${isDefault}\n`;
      }
      
      return {
        content: [{ type: 'text', text: output }]
      };
      
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ Failed to reload profiles: ${error.message}` }]
      };
    }
  }
  
  /**
   * Test connection to profile
   */
  private async testConnection(profileName?: string) {
    try {
      const profile = profileName || getDefaultProfile();
      const sshConfig = resolveSSHConfig({ profile });
      
      const pool = ConnectionPool.getInstance();
      const startTime = Date.now();
      
      // Get client (will create connection if needed)
      const client = await pool.getClient(profile, sshConfig);
      
      const connectTime = Date.now() - startTime;
      
      // Test command
      const cmdStartTime = Date.now();
      await new Promise<void>((resolve, reject) => {
        client.exec('echo "test"', (err, stream) => {
          if (err) return reject(err);
          
          stream.on('close', () => resolve());
          stream.resume();
        });
      });
      const cmdTime = Date.now() - cmdStartTime;
      
      pool.releaseClient(profile);
      
      let output = `✅ Connection Test: ${profile}\n\n`;
      output += `Host: ${sshConfig.host}:${sshConfig.port || 22}\n`;
      output += `Username: ${sshConfig.username}\n`;
      output += `Connect Time: ${connectTime}ms\n`;
      output += `Command Time: ${cmdTime}ms\n`;
      output += `Total Time: ${connectTime + cmdTime}ms\n`;
      
      return {
        content: [{ type: 'text', text: output }]
      };
      
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ Connection test failed: ${error.message}` }]
      };
    }
  }
  
  /**
   * List available profiles
   */
  private async listProfiles() {
    const profiles = getAvailableProfiles();
    const defaultProfile = getDefaultProfile();
    
    let output = '📋 Available SSH Profiles\n\n';
    
    for (const profile of profiles) {
      const isDefault = profile === defaultProfile ? ' ⭐ (default)' : '';
      output += `• ${profile}${isDefault}\n`;
    }
    
    output += `\nTotal: ${profiles.length} profiles\n`;
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }
}
```

**Регистрация в index.ts:**
```typescript
// index.ts
import { MonitoringTool } from './tools/monitoring-tool.js';

const monitoringTool = new MonitoringTool();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [
    execTool.getTool(),
    ...fileTools.getTools(),
    ...logTools.getTools(),
    snapshotTool.getTool(),
    monitoringTool.getTool(),  // ✅ Добавить
  ];
  
  return { tools: allTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // ...
  
  if (toolName === 'ssh_monitor') {
    return monitoringTool.handleCall(request);
  }
  
  // ...
});
```

**Примеры использования:**
```bash
# Get stats
ssh_monitor(action="stats")
→ Shows connection pool stats, cache hit rate, active connections

# Reload profiles
ssh_monitor(action="reload")
→ Reloads SSH_PROFILES_FILE, shows new profiles

# Test connection
ssh_monitor(action="test", profile="production")
→ Tests connection, shows connect time and command time

# List profiles
ssh_monitor(action="list")
→ Shows all available profiles
```

---

### 3. Добавить debug logging для диагностики 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/utils/logger.ts`  
**Агент:** HAIKU  
**Время:** 20 минут

**Улучшить logger:**
```typescript
// logger.ts
export class Logger {
  private logLevel: string;
  private enableTimestamp: boolean;
  private enableColors: boolean;
  
  constructor() {
    this.logLevel = process.env.SSH_MCP_LOG_LEVEL || 'info';
    this.enableTimestamp = process.env.SSH_MCP_LOG_TIMESTAMP === 'true';
    this.enableColors = process.env.SSH_MCP_LOG_COLORS !== 'false';
  }
  
  /**
   * Log with performance timing
   */
  time(label: string): () => void {
    const start = Date.now();
    
    return () => {
      const duration = Date.now() - start;
      this.debug(`[⏱️ ${label}] ${duration}ms`);
    };
  }
  
  /**
   * Log with context
   */
  context(context: string) {
    return {
      debug: (msg: string, ...args: any[]) => this.debug(`[${context}] ${msg}`, ...args),
      info: (msg: string, ...args: any[]) => this.info(`[${context}] ${msg}`, ...args),
      warn: (msg: string, ...args: any[]) => this.warn(`[${context}] ${msg}`, ...args),
      error: (msg: string, ...args: any[]) => this.error(`[${context}] ${msg}`, ...args)
    };
  }
}

// Usage:
const poolLogger = logger.context('ConnectionPool');
poolLogger.debug('Creating connection...');

const endTimer = logger.time('SSH Connect');
// ... connect logic
endTimer();  // Logs: [⏱️ SSH Connect] 1234ms
```

**Добавить в ConnectionPool:**
```typescript
class ConnectionPool {
  private logger = logger.context('Pool');
  
  async getClient(profileName: string, config: SSHConfig): Promise<Client> {
    const endTimer = logger.time(`Get client "${profileName}"`);
    
    try {
      // ... logic
      
      return client;
    } finally {
      endTimer();
    }
  }
}
```

---

### 4. Добавить environment variables для конфигурации 🟢 ОБЯЗАТЕЛЬНО
**Файл:** `README.md`  
**Агент:** HAIKU  
**Время:** 15 минут

**Документировать ENV vars:**
```markdown
## 🔧 Environment Variables

### Required
- `SSH_PROFILES_FILE` - Path to SSH profiles JSON file

### Optional (Logging)
- `SSH_MCP_LOG_LEVEL` - Log level: `debug`, `info`, `warn`, `error` (default: `info`)
- `SSH_MCP_LOG_TIMESTAMP` - Show timestamps in logs: `true`, `false` (default: `false`)
- `SSH_MCP_LOG_COLORS` - Enable colors in logs: `true`, `false` (default: `true`)

### Optional (Connection Pool)
- `SSH_MCP_POOL_IDLE_TIMEOUT` - Idle timeout for connections in ms (default: `30000`)
- `SSH_MCP_POOL_KEEPALIVE_INTERVAL` - Keep-alive ping interval in ms (default: `10000`)
- `SSH_MCP_POOL_CONNECT_TIMEOUT` - Connection timeout in ms (default: `10000`)
- `SSH_MCP_POOL_MAX_RETRIES` - Max retry attempts for connection (default: `3`)

### Optional (Profiles)
- `SSH_MCP_PROFILES_CACHE_TTL` - Profile cache TTL in ms (default: `60000`)
- `SSH_MCP_PROFILES_WATCH` - Watch profiles file for changes: `true`, `false` (default: `true`)

### Example
```bash
export SSH_PROFILES_FILE="$HOME/.ssh/mcp-profiles.json"
export SSH_MCP_LOG_LEVEL="debug"
export SSH_MCP_POOL_IDLE_TIMEOUT="60000"
export SSH_MCP_PROFILES_WATCH="true"
```
```

**Реализовать в коде:**
```typescript
// connection-pool.ts
const IDLE_TIMEOUT = parseInt(process.env.SSH_MCP_POOL_IDLE_TIMEOUT || '30000');
const KEEPALIVE_INTERVAL = parseInt(process.env.SSH_MCP_POOL_KEEPALIVE_INTERVAL || '10000');
const CONNECT_TIMEOUT = parseInt(process.env.SSH_MCP_POOL_CONNECT_TIMEOUT || '10000');
const MAX_RETRIES = parseInt(process.env.SSH_MCP_POOL_MAX_RETRIES || '3');

// profile-resolver.ts
const CACHE_TTL = parseInt(process.env.SSH_MCP_PROFILES_CACHE_TTL || '60000');
const WATCH_PROFILES = process.env.SSH_MCP_PROFILES_WATCH !== 'false';
```

---

## 📊 ОЖИДАЕМЫЙ РЕЗУЛЬТАТ

**До:**
```bash
# Изменение SSH_PROFILES_FILE
vim ~/.ssh/mcp-profiles.json  # Добавить новый профиль
ssh_exec("echo test", profile="new-profile")
→ Error: Profile not found  ❌ Нужен рестарт сервера

# Мониторинг
# Нет возможности посмотреть состояние соединений
# Нет возможности протестировать connection
```

**После:**
```bash
# Auto-reload профилей (file watcher)
vim ~/.ssh/mcp-profiles.json  # Добавить новый профиль
→ [INFO] SSH_PROFILES_FILE changed, reloading...
→ [INFO] ✅ Profiles reloaded successfully
ssh_exec("echo test", profile="new-profile")
→ Success  ✅ Работает без рестарта!

# Manual reload
ssh_monitor(action="reload")
→ ✅ Loaded 5 profiles (was 3)

# Мониторинг
ssh_monitor(action="stats")
→ 📊 Cache Hit Rate: 85%
→ 🔗 Active Connections: 2

ssh_monitor(action="test", profile="production")
→ ✅ Connect Time: 1234ms, Command Time: 45ms
```

---

## 🧪 ТЕСТИРОВАНИЕ

**Test 1: Profile reload**
```bash
# 1. Start server
# 2. Edit SSH_PROFILES_FILE (add new profile)
# 3. Check logs: should see "Profiles reloaded"
# 4. Use new profile: should work immediately
```

**Test 2: Monitoring**
```bash
ssh_monitor(action="list")
→ Should show all profiles

ssh_monitor(action="stats")
→ Should show cache hit rate, active connections

ssh_monitor(action="test")
→ Should test connection and show timings
```

**Test 3: ENV vars**
```bash
export SSH_MCP_LOG_LEVEL="debug"
export SSH_MCP_POOL_IDLE_TIMEOUT="60000"
# Start server
# Check logs: should see debug messages
# Check idle timeout: connections should stay 60s instead of 30s
```

---

## 📝 ЧЕКЛИСТ ЗАВЕРШЕНИЯ

- [ ] Profile reload с кэшем и TTL реализован
- [ ] File watcher для автоматического reload добавлен
- [ ] MonitoringTool реализован (stats, reload, test, list)
- [ ] Debug logging улучшен (context, time)
- [ ] ENV variables документированы и реализованы
- [ ] Тесты пройдены
- [ ] Документация обновлена (README.md, CHANGELOG.md)

---

## 🔗 СВЯЗАННЫЕ ISSUES

- Решает: Profiles синглтон без reload (проблема #7 из анализа)
- Улучшает: Developer experience (мониторинг, диагностика)
- Улучшает: Production readiness (конфигурация через ENV)

---

## 🎯 ИТОГО ПО ВСЕМ СПРИНТАМ

После завершения всех 5 спринтов:

✅ Sprint 2: Connection Pool → 6-10× быстрее  
✅ Sprint 3: Path Security → Безопасность и удобство (тильда)  
✅ Sprint 4: Timeout & Errors → Стабильность и надёжность  
✅ Sprint 5: Monitoring → Удобство разработки и мониторинг  

**ГОТОВ К PRODUCTION! 🚀**
