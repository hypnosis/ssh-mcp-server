# 🐛 DEBUG: Batch Exec with Array

## ✅ РЕШЕНО

**Проблема:** MCP инструмент `ssh_exec` при передаче массива с одинарными кавычками выдавал ошибку:

```
bash: line 1: [hostname,: command not found
Exit code: 127
```

**Причина:** Использование одинарных кавычек в массиве (`['cmd1', 'cmd2']`) вместо двойных (`["cmd1", "cmd2"]`)

**Решение:**
1. ✅ Добавлен валидатор в `exec-tool.ts` для детекта неправильного формата
2. ✅ Улучшено описание инструмента с примерами правильного синтаксиса
3. ✅ Обновлена документация в README.md

---

## Оригинальная проблема

MCP инструмент `ssh_exec` должен поддерживать массив команд в параметре `command`.

## Правильное использование

Массив должен передаваться как **валидный JSON array с двойными кавычками**:

```json
{
  "command": ["hostname", "whoami", "date"],
  "profile": "example-profile"
}
```

## Правильный синтаксис

### ✅ Правильно (двойные кавычки):

```typescript
mcp_ssh_ssh_exec({
  command: ["hostname", "whoami", "date"],
  profile: "example-profile"
})
```

### ❌ Неправильно (одинарные кавычки):

```typescript
mcp_ssh_ssh_exec({
  command: ['hostname', 'whoami', 'date'],  // ❌ НЕ РАБОТАЕТ!
  profile: "example-profile"
})
```

## Что было сделано

### 1. Валидатор в exec-tool.ts

Добавлена проверка на неправильный формат массива ДО выполнения команды:

```typescript
// Validator: Check for malformed array syntax
if (typeof args.command === 'string') {
  const trimmed = args.command.trim();
  
  if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
    // Detect ['cmd'] or ['cmd', 'cmd'] format
    return {
      content: [{
        type: 'text',
        text: `❌ Malformed 'command' parameter detected

Use DOUBLE QUOTES for arrays: ["cmd1", "cmd2"]
NOT single quotes: ['cmd1', 'cmd2']`
      }]
    };
  }
}
```

### 2. Улучшенное описание инструмента

```typescript
description: 'Single command string or array of commands to execute. 
For arrays, use JSON format with double quotes: ["cmd1", "cmd2"]. 
Examples: command: "hostname" (single) or command: ["hostname", "whoami"] (batch)'
```

### 3. Документация в README.md

Добавлена секция с предупреждением о синтаксисе массивов.

## Успешный результат

С правильным синтаксисом `["cmd1", "cmd2"]` получаем:

```
Executed 3 commands:

[1/3] hostname
────────────────────────────────────────────────────────────
example-hostname
Exit code: 0

[2/3] whoami
────────────────────────────────────────────────────────────
root
Exit code: 0

[3/3] date
────────────────────────────────────────────────────────────
Sun Jan 12 09:21:57 PM UTC 2026
Exit code: 0
```

## Почему это важно?

**MCP протокол требует валидного JSON формата:**
- JSON стандарт: строки только в двойных кавычках
- `["a", "b"]` - валидный JSON ✅
- `['a', 'b']` - НЕвалидный JSON ❌

**Аналогия:**
```javascript
JSON.parse('["a", "b"]')  // ✅ работает
JSON.parse("['a', 'b']")  // ❌ SyntaxError
```

MCP SDK парсит аргументы как JSON, поэтому одинарные кавычки не работают.

## Файлы изменены

- ✅ `src/tools/exec-tool.ts` - добавлен валидатор
- ✅ `README.md` - добавлена документация
- ✅ `docs/archive/DEBUG_BATCH_EXEC.md` - описание решения

## Применимо к другим инструментам

Та же логика для всех инструментов с массивами:
- `ssh_file_read` - `path: ["file1", "file2"]`
- `ssh_log_tail` - `path: ["log1", "log2"]`
- `ssh_log_search` - `path: ["log1", "log2"]`

**Всегда используй двойные кавычки в JSON массивах!**
