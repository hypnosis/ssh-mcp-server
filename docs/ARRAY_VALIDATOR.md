# Array Parameter Validator

## Описание

Утилита для валидации параметров MCP инструментов, которые принимают строку или массив.

## Проблема

MCP протокол требует валидного JSON синтаксиса. При передаче массивов с одинарными кавычками (`['a', 'b']`) вместо двойных (`["a", "b"]`) происходит ошибка парсинга, и массив превращается в искажённую строку.

## Решение

Централизованный валидатор `array-validator.ts` проверяет параметры ДО выполнения команд и выдаёт понятные сообщения об ошибках.

## Использование

### В инструментах

```typescript
import { validateArrayParameter, createValidationErrorResponse } from '../utils/array-validator.js';

async handleCall(request: CallToolRequest) {
  const args = request.params.arguments as any;
  
  // Validate array parameter
  const validation = validateArrayParameter(args.command, 'command');
  if (!validation.isValid) {
    return createValidationErrorResponse(validation.errorMessage!);
  }
  
  // Continue with normal processing...
}
```

### Инструменты с валидацией

1. **ssh_exec** - параметр `command`
2. **ssh_file_read** - параметр `path`
3. **ssh_log_tail** - параметр `path`
4. **ssh_log_search** - параметр `path`

## Что проверяет

### ✅ Валидные значения

```typescript
// Массив с двойными кавычками
command: ["hostname", "whoami", "date"]

// Строка
command: "hostname"

// Bash test (не срабатывает валидация)
command: "[[ -f file.txt ]] && echo exists"
```

### ❌ Невалидные значения

```typescript
// Массив с одинарными кавычками
command: ['hostname', 'whoami']

// Строка, похожая на массив
command: "['hostname', 'whoami']"
```

## Сообщение об ошибке

```
❌ Malformed 'command' parameter detected

Received: ['hostname', 'whoami']

For array of items, use DOUBLE QUOTES in JSON format:
✅ Correct:   command: ["item1", "item2", "item3"]
❌ Incorrect: command: ['item1', 'item2', 'item3']

For single item, use string:
✅ Correct:   command: "item1"

MCP tools require valid JSON syntax for arrays.
```

## API

### validateArrayParameter(value, parameterName)

Проверяет корректность формата массива.

**Параметры:**
- `value: any` - значение параметра
- `parameterName: string` - имя параметра (для сообщения об ошибке)

**Возвращает:**
```typescript
{
  isValid: boolean;
  errorMessage?: string;
}
```

### createValidationErrorResponse(errorMessage)

Создаёт ответ MCP инструмента с сообщением об ошибке.

**Параметры:**
- `errorMessage: string` - текст ошибки

**Возвращает:**
```typescript
{
  content: [{ type: 'text', text: string }],
  isError: true
}
```

Неверная форма аргумента — это отказ инструмента, поэтому ответ несёт признак провала:
без него вызывающий отличал бы ошибку от результата только по тексту.

## Преимущества

1. **DRY принцип** - одна реализация для всех инструментов
2. **Консистентность** - одинаковые сообщения об ошибках
3. **Поддерживаемость** - изменения в одном месте
4. **Безопасность** - проверка ДО выполнения команд
5. **Понятность** - чёткие инструкции для пользователей

## Тестирование

```bash
# Сборка
npm run build

# Тест с валидным массивом
mcp_ssh_ssh_exec({
  command: ["hostname", "whoami"],
  profile: "example-profile"
})
# ✅ Работает

# Тест с невалидным массивом
mcp_ssh_ssh_exec({
  command: ['hostname', 'whoami'],
  profile: "example-profile"
})
# ❌ Ошибка с понятным сообщением
```

## Файлы

- `src/utils/array-validator.ts` - утилита валидации
- `src/tools/exec-tool.ts` - использование в ssh_exec
- `src/tools/file-tools.ts` - использование в ssh_file_read
- `src/tools/log-tools.ts` - использование в ssh_log_tail и ssh_log_search
