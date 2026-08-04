/**
 * Array Parameter Validator
 * Validates MCP tool parameters that accept string or array
 */

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errorMessage?: string;
}

/**
 * Validate array parameter format
 * Detects malformed arrays with single quotes or stringified arrays
 * 
 * @param value - Parameter value to validate
 * @param parameterName - Name of parameter (for error message)
 * @returns Validation result with error message if invalid
 */
export function validateArrayParameter(
  value: any,
  parameterName: string = 'parameter'
): ValidationResult {
  // If it's already a valid array, it's fine
  if (Array.isArray(value)) {
    return { isValid: true };
  }
  
  // If it's not a string, let it pass (will be validated by schema)
  if (typeof value !== 'string') {
    return { isValid: true };
  }
  
  const trimmed = value.trim();
  
  // Detect malformed array: starts with [ but not [[ (bash test)
  if (trimmed.startsWith('[') && !trimmed.startsWith('[[')) {
    // Check if it looks like array with single quotes: ['item'] or ['item', 'item']
    const hasSingleQuotes = /^\[['"]/.test(trimmed) || /,\s*['"]/.test(trimmed);
    
    if (hasSingleQuotes || (trimmed.includes('[') && trimmed.includes(','))) {
      return {
        isValid: false,
        errorMessage: formatErrorMessage(value, parameterName)
      };
    }
  }
  
  return { isValid: true };
}

/**
 * Format error message for malformed array
 */
function formatErrorMessage(receivedValue: string, parameterName: string): string {
  return `❌ Malformed '${parameterName}' parameter detected

Received: ${receivedValue}

For array of items, use DOUBLE QUOTES in JSON format:
✅ Correct:   ${parameterName}: ["item1", "item2", "item3"]
❌ Incorrect: ${parameterName}: ['item1', 'item2', 'item3']

For single item, use string:
✅ Correct:   ${parameterName}: "item1"
${
  // Подсказка про bash-тест уместна только там, где значение — команда:
  // в ответе про `path` она сбивала с толку, советуя чинить чужой параметр.
  parameterName === 'command'
    ? '\nBash tests are not affected by this check:\n✅ Correct:   command: "[[ -f file.txt ]] && echo exists"\n'
    : ''
}
MCP tools require valid JSON syntax for arrays.`;
}

/**
 * Create error response for MCP tool
 */
export function createValidationErrorResponse(errorMessage: string) {
  return {
    content: [{ type: 'text', text: errorMessage }]
  };
}
