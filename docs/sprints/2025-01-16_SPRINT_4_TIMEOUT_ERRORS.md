# 🎯 SPRINT 4: Timeout & Error Handling

**Статус:** 🔴 ПЛАНИРУЕТСЯ  
**Период:** Week 2, Day 4 (2025-01-16)  
**Дата начала:** 2025-01-16  
**Приоритет:** 🟡 СРЕДНИЙ (стабильность)

## 📋 ОПИСАНИЕ

Исправление проблем с таймаутами и обработкой ошибок:
1. Race condition в timeout handler (проблема #6)
2. Улучшение обработки ошибок подключения
3. Retry механизм для временных сбоев
4. Graceful degradation при потере соединения

## 🎯 ЗАДАЧИ

### 1. Исправить race condition в timeout handler 🟡 ВАЖНО
**Файл:** `src/managers/ssh-manager.ts`  
**Агент:** SONNET 4.5  
**Время:** 30 минут

**Проблема:**
```typescript
// СЕЙЧАС:
async execute(config, command) {
  return new Promise((resolve, reject) => {
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
  });
}

// Race condition:
// 1. Command выполняется 30s
// 2. timeout fires → reject()
// 3. Stream закрывается → resolve() или reject() снова
// 4. 💥 Promise уже settled!
```

**Решение:**
```typescript
async execute(
  config: SSHConfig,
  command: string,
  options: SSHExecuteOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timeout = options.timeout || 30000;
    let timeoutId: NodeJS.Timeout;
    let settled = false;  // ✅ Флаг для предотвращения двойного resolve/reject
    
    // Helper: resolve once
    const resolveOnce = (value: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        client.end();
        resolve(value);
      }
    };
    
    // Helper: reject once
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        client.end();
        reject(error);
      }
    };
    
    client.on('ready', () => {
      logger.debug(`SSH connected to ${config.host}, executing: ${command}`);
      
      client.exec(command, (err, stream) => {
        if (err) {
          rejectOnce(new Error(`Failed to execute command: ${err.message}`));
          return;
        }
        
        let stdout = '';
        let stderr = '';
        
        stream.on('close', (code: number) => {
          if (code !== 0) {
            rejectOnce(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
          } else {
            resolveOnce(stdout);
          }
        });
        
        stream.on('data', (data: Buffer) => {
          stdout += data.toString(options.encoding || 'utf8');
        });
        
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString(options.encoding || 'utf8');
        });
      });
    });
    
    client.on('error', (err) => {
      rejectOnce(new Error(`SSH connection error: ${err.message}`));
    });
    
    // Timeout handler
    timeoutId = setTimeout(() => {
      rejectOnce(new Error(`SSH command timeout after ${timeout}ms`));
    }, timeout);
    
    // Connect
    this.connect(client, config);
  });
}
```

**Тесты:**
```typescript
// Тест 1: Нормальное выполнение (< timeout)
execute(config, 'echo test', { timeout: 5000 })
  → Success: "test\n"  ✅

// Тест 2: Timeout (> timeout)
execute(config, 'sleep 10', { timeout: 2000 })
  → Error: "SSH command timeout after 2000ms"  ✅
  → client.end() вызван ОДИН раз  ✅

// Тест 3: Ошибка команды
execute(config, 'false', { timeout: 5000 })
  → Error: "Command failed with code 1"  ✅

// Тест 4: Connection error
execute(invalidConfig, 'echo test', { timeout: 5000 })
  → Error: "SSH connection error: ..."  ✅
```

---

### 2. Добавить retry механизм для временных сбоев 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/utils/retry.ts` (уже существует!)  
**Агент:** SONNET 4.5  
**Время:** 30 минут

**Проверить существующий retry.ts:**
```bash
# Посмотреть что уже есть
cat src/utils/retry.ts
```

**Если есть - интегрировать в ConnectionPool:**
```typescript
// connection-pool.ts
import { retry } from '../utils/retry.js';

class ConnectionPool {
  /**
   * Create connection with retry
   */
  private async createConnection(
    profileName: string,
    config: SSHConfig
  ): Promise<Client> {
    return retry(
      async () => {
        const client = new Client();
        
        return new Promise<Client>((resolve, reject) => {
          const connectTimeout = setTimeout(() => {
            client.end();
            reject(new Error('Connection timeout'));
          }, 10000);
          
          client.on('ready', () => {
            clearTimeout(connectTimeout);
            this.metrics.totalConnections++;
            logger.info(`[Pool] Connected to profile "${profileName}"`);
            resolve(client);
          });
          
          client.on('error', (err) => {
            clearTimeout(connectTimeout);
            reject(err);
          });
          
          this.connect(client, config);
        });
      },
      {
        retries: 3,              // 3 попытки
        delay: 1000,             // 1s между попытками
        factor: 2,               // Экспоненциальный backoff (1s, 2s, 4s)
        shouldRetry: (err) => {
          // Retry только для временных ошибок
          const temporaryErrors = [
            'ECONNREFUSED',
            'ETIMEDOUT',
            'ENOTFOUND',
            'EHOSTUNREACH',
            'Connection timeout'
          ];
          
          return temporaryErrors.some(e => err.message.includes(e));
        },
        onRetry: (attempt, error) => {
          logger.warn(`[Pool] Retry ${attempt} for profile "${profileName}": ${error.message}`);
        }
      }
    );
  }
}
```

**Если retry.ts НЕ существует - создать:**
```typescript
// src/utils/retry.ts
export interface RetryOptions {
  retries?: number;           // Количество попыток (default: 3)
  delay?: number;            // Задержка между попытками (ms, default: 1000)
  factor?: number;           // Множитель для exponential backoff (default: 2)
  maxDelay?: number;         // Максимальная задержка (ms, default: 30000)
  shouldRetry?: (error: Error) => boolean;  // Условие для retry
  onRetry?: (attempt: number, error: Error) => void;  // Callback при retry
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    delay = 1000,
    factor = 2,
    maxDelay = 30000,
    shouldRetry = () => true,
    onRetry = () => {}
  } = options;
  
  let lastError: Error;
  let currentDelay = delay;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      // Последняя попытка - не retry
      if (attempt === retries) {
        break;
      }
      
      // Проверить условие retry
      if (!shouldRetry(error)) {
        throw error;
      }
      
      // Callback
      onRetry(attempt, error);
      
      // Задержка перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, Math.min(currentDelay, maxDelay)));
      
      // Exponential backoff
      currentDelay *= factor;
    }
  }
  
  throw lastError;
}
```

---

### 3. Улучшить обработку ошибок подключения 🟡 ВАЖНО
**Файл:** `src/managers/connection-pool.ts`  
**Агент:** SONNET 4.5  
**Время:** 30 минут

**Добавить детальные ошибки:**
```typescript
class ConnectionPool {
  private async createConnection(
    profileName: string,
    config: SSHConfig
  ): Promise<Client> {
    logger.debug(`[Pool] Creating connection for profile "${profileName}"...`);
    logger.debug(`[Pool] Config: ${config.username}@${config.host}:${config.port || 22}`);
    
    try {
      const client = await retry(
        () => this.connectClient(config),
        {
          retries: 3,
          delay: 1000,
          factor: 2,
          shouldRetry: (err) => this.isTemporaryError(err),
          onRetry: (attempt, error) => {
            logger.warn(`[Pool] Connection retry ${attempt}/3 for "${profileName}": ${error.message}`);
          }
        }
      );
      
      this.setupKeepAlive(client, profileName);
      this.setupAutoReconnect(client, profileName, config);
      
      logger.info(`[Pool] ✅ Connected to profile "${profileName}"`);
      this.metrics.totalConnections++;
      
      return client;
      
    } catch (error: any) {
      // Детальная диагностика ошибки
      logger.error(`[Pool] ❌ Failed to connect to profile "${profileName}"`);
      logger.error(`[Pool] Host: ${config.host}:${config.port || 22}`);
      logger.error(`[Pool] Username: ${config.username}`);
      logger.error(`[Pool] Error: ${error.message}`);
      
      // Специфичные ошибки с подсказками
      if (error.message.includes('ECONNREFUSED')) {
        throw new Error(
          `Connection refused to ${config.host}:${config.port || 22}. ` +
          `Check if SSH server is running and port is correct.`
        );
      }
      
      if (error.message.includes('ETIMEDOUT')) {
        throw new Error(
          `Connection timeout to ${config.host}:${config.port || 22}. ` +
          `Check firewall rules and network connectivity.`
        );
      }
      
      if (error.message.includes('ENOTFOUND')) {
        throw new Error(
          `Host not found: ${config.host}. ` +
          `Check hostname/IP address in profile configuration.`
        );
      }
      
      if (error.message.includes('Authentication failed')) {
        throw new Error(
          `Authentication failed for ${config.username}@${config.host}. ` +
          `Check username, SSH key path, and passphrase.`
        );
      }
      
      if (error.message.includes('privateKey')) {
        throw new Error(
          `Invalid SSH key at ${config.privateKeyPath}. ` +
          `Check file exists and has correct permissions (600).`
        );
      }
      
      // Общая ошибка
      throw new Error(
        `Failed to connect to ${config.username}@${config.host}:${config.port || 22}: ${error.message}`
      );
    }
  }
  
  /**
   * Check if error is temporary and should be retried
   */
  private isTemporaryError(error: Error): boolean {
    const temporaryErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'Connection timeout',
      'Connection reset'
    ];
    
    return temporaryErrors.some(e => error.message.includes(e));
  }
}
```

---

### 4. Добавить graceful degradation при потере соединения 🟢 ЖЕЛАТЕЛЬНО
**Файл:** `src/managers/connection-pool.ts`  
**Агент:** SONNET 4.5  
**Время:** 30 минут

**Автоматическое переподключение:**
```typescript
class ConnectionPool {
  /**
   * Setup auto-reconnect on connection loss
   */
  private setupAutoReconnect(
    client: Client,
    profileName: string,
    config: SSHConfig
  ): void {
    const pooled = this.connections.get(profileName);
    if (!pooled) return;
    
    // Connection closed unexpectedly
    client.on('end', () => {
      if (pooled.activeCommands > 0) {
        logger.warn(`[Pool] Connection lost for "${profileName}" with ${pooled.activeCommands} active commands`);
        logger.warn(`[Pool] Attempting to reconnect...`);
        
        pooled.isReady = false;
        this.metrics.reconnects++;
        
        // Reconnect after 1 second
        setTimeout(async () => {
          try {
            const newClient = await this.createConnection(profileName, config);
            
            // Update pooled connection
            pooled.client = newClient;
            pooled.isReady = true;
            pooled.lastUsed = Date.now();
            
            logger.info(`[Pool] ✅ Reconnected to profile "${profileName}"`);
          } catch (error: any) {
            logger.error(`[Pool] ❌ Failed to reconnect to "${profileName}": ${error.message}`);
            
            // Remove from pool after failed reconnect
            this.connections.delete(profileName);
          }
        }, 1000);
      } else {
        logger.debug(`[Pool] Connection closed for "${profileName}" (no active commands)`);
        pooled.isReady = false;
      }
    });
    
    // Connection error
    client.on('error', (err) => {
      logger.error(`[Pool] Connection error for "${profileName}": ${err.message}`);
      pooled.isReady = false;
    });
  }
  
  /**
   * Get client with automatic reconnect on failure
   */
  async getClient(profileName: string, config: SSHConfig): Promise<Client> {
    const existing = this.connections.get(profileName);
    
    // Existing connection is ready
    if (existing && existing.isReady) {
      existing.lastUsed = Date.now();
      existing.activeCommands++;
      this.metrics.cacheHits++;
      logger.debug(`[Pool] Cache HIT for "${profileName}"`);
      return existing.client;
    }
    
    // Existing connection is broken - reconnect
    if (existing && !existing.isReady) {
      logger.debug(`[Pool] Connection broken for "${profileName}", reconnecting...`);
      
      try {
        const newClient = await this.createConnection(profileName, config);
        existing.client = newClient;
        existing.isReady = true;
        existing.lastUsed = Date.now();
        existing.activeCommands = 1;
        this.metrics.reconnects++;
        return newClient;
      } catch (error: any) {
        logger.error(`[Pool] Failed to reconnect: ${error.message}`);
        this.connections.delete(profileName);
        throw error;
      }
    }
    
    // Create new connection
    this.metrics.cacheMisses++;
    logger.debug(`[Pool] Cache MISS for "${profileName}", creating new connection`);
    
    const client = await this.createConnection(profileName, config);
    
    this.connections.set(profileName, {
      client,
      config,
      isReady: true,
      lastUsed: Date.now(),
      activeCommands: 1
    });
    
    return client;
  }
}
```

---

### 5. Добавить тесты для error handling 🟢 ОБЯЗАТЕЛЬНО
**Файл:** `tests/unit/error-handling.test.ts` (новый)  
**Агент:** SONNET 4.5  
**Время:** 40 минут

**Что тестировать:**
```typescript
// Test 1: Timeout не вызывает race condition
test('execute timeout does not cause race condition', async () => {
  const manager = new SSHManager();
  
  // Command занимает больше времени чем timeout
  const promise = manager.execute(config, 'sleep 10', { timeout: 1000 });
  
  await expect(promise).rejects.toThrow('timeout');
  
  // client.end() должен быть вызван ОДИН раз
  expect(clientEndSpy).toHaveBeenCalledTimes(1);
});

// Test 2: Retry для временных ошибок
test('retry on temporary connection errors', async () => {
  const pool = ConnectionPool.getInstance();
  
  // Mock: первые 2 попытки fail, 3я succeed
  let attempts = 0;
  jest.spyOn(Client.prototype, 'connect').mockImplementation(() => {
    attempts++;
    if (attempts < 3) {
      throw new Error('ECONNREFUSED');
    }
    // Success on 3rd attempt
  });
  
  await expect(pool.getClient('test', config)).resolves.toBeDefined();
  expect(attempts).toBe(3);
});

// Test 3: NO retry для постоянных ошибок
test('no retry on permanent errors', async () => {
  const pool = ConnectionPool.getInstance();
  
  jest.spyOn(Client.prototype, 'connect').mockImplementation(() => {
    throw new Error('Authentication failed');
  });
  
  await expect(pool.getClient('test', config)).rejects.toThrow('Authentication failed');
  
  // Только 1 попытка (no retry)
  expect(connectSpy).toHaveBeenCalledTimes(1);
});

// Test 4: Auto-reconnect при потере соединения
test('auto-reconnect on connection loss', async () => {
  const pool = ConnectionPool.getInstance();
  const client = await pool.getClient('test', config);
  
  // Simulate connection loss
  client.emit('end');
  
  // Wait for reconnect
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Should reconnect automatically
  const client2 = await pool.getClient('test', config);
  expect(client2).toBeDefined();
  expect(pool.getStats().reconnects).toBe(1);
});

// Test 5: Детальные ошибки
test('detailed error messages', async () => {
  const pool = ConnectionPool.getInstance();
  
  // Test ECONNREFUSED
  jest.spyOn(Client.prototype, 'connect').mockImplementation(() => {
    throw new Error('ECONNREFUSED');
  });
  
  await expect(pool.getClient('test', config)).rejects.toThrow(
    'Connection refused to server.com:22. Check if SSH server is running'
  );
});
```

---

## 📊 ОЖИДАЕМЫЙ РЕЗУЛЬТАТ

**До:**
```bash
# Race condition
execute('sleep 10', { timeout: 5000 })
→ Timeout error + Stream close error  ❌ Двойной reject

# Temporary error
execute('echo test')  # Server временно недоступен
→ Error: ECONNREFUSED  ❌ Сразу падает, no retry

# Connection loss
Client connected → server перезагружается → execute()
→ Error: Connection lost  ❌ Нужно вручную переподключаться
```

**После:**
```bash
# Race condition fixed
execute('sleep 10', { timeout: 5000 })
→ Timeout error  ✅ Только один reject, client.end() вызван один раз

# Retry на temporary errors
execute('echo test')  # Server временно недоступен
→ Retry 1/3... Retry 2/3... Success  ✅ Автоматический retry

# Auto-reconnect
Client connected → server перезагружается → execute()
→ Connection lost, reconnecting... Success  ✅ Автоматическое переподключение
```

---

## 🧪 ТЕСТИРОВАНИЕ

**Manual tests:**
```bash
# Test 1: Timeout
ssh_exec("sleep 10", timeout=2000)
→ Error: SSH command timeout after 2000ms  ✅

# Test 2: Connection refused
ssh_exec("echo test")  # Server недоступен
→ Retry 1/3... Retry 2/3... Retry 3/3... Error with helpful message  ✅

# Test 3: Auto-reconnect
ssh_exec("echo test")  # Success
# Перезагрузить сервер
ssh_exec("echo test")  # Connection lost, reconnecting... Success  ✅

# Test 4: Invalid hostname
ssh_exec("echo test")  # With invalid host in config
→ Error: Host not found: invalid.host. Check hostname/IP address  ✅
```

**Stress tests:**
```bash
# Test concurrent commands with timeout
for i in 1..10:
  ssh_exec("sleep 5", timeout=2000) in parallel

→ All timeout correctly, no race conditions  ✅
```

---

## 📝 ЧЕКЛИСТ ЗАВЕРШЕНИЯ

- [ ] Race condition в timeout исправлена
- [ ] Retry механизм реализован (retry.ts)
- [ ] Retry интегрирован в ConnectionPool
- [ ] Детальные ошибки добавлены
- [ ] Auto-reconnect реализован
- [ ] Graceful degradation работает
- [ ] Тесты error handling написаны
- [ ] Тесты пройдены
- [ ] Документация обновлена (CHANGELOG.md)

---

## 🔗 СВЯЗАННЫЕ ISSUES

- Решает: Timeout race condition (проблема #6 из анализа)
- Улучшает: Надёжность при временных сбоях
- Улучшает: User experience (понятные ошибки)

---

## 🎯 СЛЕДУЮЩИЙ SPRINT

После завершения Timeout & Errors → Sprint 5: Profiles Reload & Monitoring
