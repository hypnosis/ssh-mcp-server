/**
 * Path Security Validator
 * Optional security layer for validating file paths against whitelist/blacklist rules
 */
/**
 * Path security configuration
 * Can be specified per SSH profile for additional security
 */
export interface PathSecurityConfig {
    /**
     * Whitelist of allowed directory paths
     * If specified, only paths starting with these prefixes are allowed
     * Example: ["/home/admin", "/var/www", "/var/log"]
     */
    allowedPaths?: string[];
    /**
     * Blacklist of forbidden paths
     * Paths starting with these prefixes will be rejected
     * Example: ["/etc/shadow", "/root", "/etc/ssh"]
     */
    deniedPaths?: string[];
    /**
     * Allow path traversal (../) in paths
     * Default: true (allowed)
     * Set to false to prevent directory traversal attacks
     */
    allowTraversal?: boolean;
    /**
     * Maximum allowed path length
     * Default: unlimited
     * Example: 1000
     */
    maxPathLength?: number;
}
/**
 * Path validation result
 */
export interface PathValidationResult {
    valid: boolean;
    error?: string;
}
/**
 * PathValidator
 * Validates file paths against security rules
 *
 * Usage:
 *   const validator = new PathValidator(config);
 *   const result = validator.validate("/etc/shadow");
 *   if (!result.valid) {
 *     throw new Error(result.error);
 *   }
 */
export declare class PathValidator {
    private config?;
    constructor(config?: PathSecurityConfig | undefined);
    /**
     * Validate file path against security rules
     *
     * @param path - File path to validate
     * @returns Validation result with error message if invalid
     *
     * @example
     * // With whitelist
     * const validator = new PathValidator({
     *   allowedPaths: ["/home/admin", "/var/log"]
     * });
     * validator.validate("/home/admin/file.txt"); // ✅ valid
     * validator.validate("/etc/shadow");          // ❌ not in whitelist
     *
     * @example
     * // With blacklist
     * const validator = new PathValidator({
     *   deniedPaths: ["/etc/shadow", "/root"]
     * });
     * validator.validate("/home/user/file.txt"); // ✅ valid
     * validator.validate("/etc/shadow");         // ❌ blacklisted
     *
     * @example
     * // Prevent path traversal
     * const validator = new PathValidator({
     *   allowTraversal: false
     * });
     * validator.validate("/home/user/file.txt");     // ✅ valid
     * validator.validate("../../../etc/passwd");     // ❌ traversal not allowed
     */
    validate(path: string): PathValidationResult;
    /**
     * Normalize path for comparison
     * Converts tilde and relative paths to absolute-like paths
     *
     * Note: This is a best-effort normalization for validation purposes
     * The actual path expansion happens on the remote server
     */
    private normalizePath;
    /**
     * Validate multiple paths at once
     * Returns first validation error or success
     *
     * @param paths - Array of paths to validate
     * @returns Validation result with error message if any path is invalid
     */
    validateBatch(paths: string[]): PathValidationResult;
}
/**
 * Create PathValidator from SSH config
 * Helper function to create validator from profile configuration
 *
 * @param sshConfig - SSH configuration object (may contain pathSecurity)
 * @returns PathValidator instance or undefined if no security config
 *
 * @example
 * const sshConfig = resolveSSHConfig({ profile: 'production' });
 * const validator = createPathValidator(sshConfig);
 * if (validator) {
 *   const result = validator.validate(path);
 *   if (!result.valid) throw new Error(result.error);
 * }
 */
export declare function createPathValidator(sshConfig: any): PathValidator | undefined;
//# sourceMappingURL=path-validator.d.ts.map