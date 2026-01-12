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
export declare function validateArrayParameter(value: any, parameterName?: string): ValidationResult;
/**
 * Create error response for MCP tool
 */
export declare function createValidationErrorResponse(errorMessage: string): {
    content: {
        type: string;
        text: string;
    }[];
};
//# sourceMappingURL=array-validator.d.ts.map