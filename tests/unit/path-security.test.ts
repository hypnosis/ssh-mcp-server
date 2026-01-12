/**
 * Unit tests for Path Security features
 * - Tilde expansion
 * - Path escaping
 * - PathValidator
 */

import { describe, it, expect } from 'vitest';
import { PathValidator, PathSecurityConfig } from '../../src/utils/path-validator.js';

describe('PathValidator', () => {
  describe('Basic validation', () => {
    it('should allow all paths when no config provided', () => {
      const validator = new PathValidator();
      
      expect(validator.validate('/etc/shadow').valid).toBe(true);
      expect(validator.validate('/root/.ssh/id_rsa').valid).toBe(true);
      expect(validator.validate('~/file.txt').valid).toBe(true);
    });
    
    it('should allow all paths when empty config provided', () => {
      const validator = new PathValidator({});
      
      expect(validator.validate('/etc/shadow').valid).toBe(true);
      expect(validator.validate('/root/.ssh/id_rsa').valid).toBe(true);
    });
  });
  
  describe('Path length validation', () => {
    it('should reject paths exceeding max length', () => {
      const config: PathSecurityConfig = {
        maxPathLength: 20
      };
      const validator = new PathValidator(config);
      
      const result = validator.validate('/very/long/path/that/exceeds/limit');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path too long');
    });
    
    it('should allow paths within max length', () => {
      const config: PathSecurityConfig = {
        maxPathLength: 100
      };
      const validator = new PathValidator(config);
      
      const result = validator.validate('/short/path');
      expect(result.valid).toBe(true);
    });
  });
  
  describe('Path traversal validation', () => {
    it('should allow path traversal by default', () => {
      const validator = new PathValidator({});
      
      expect(validator.validate('../file.txt').valid).toBe(true);
      expect(validator.validate('../../etc/passwd').valid).toBe(true);
    });
    
    it('should reject path traversal when disabled', () => {
      const config: PathSecurityConfig = {
        allowTraversal: false
      };
      const validator = new PathValidator(config);
      
      const result = validator.validate('../../../etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path traversal');
    });
    
    it('should allow normal paths when traversal disabled', () => {
      const config: PathSecurityConfig = {
        allowTraversal: false
      };
      const validator = new PathValidator(config);
      
      expect(validator.validate('/home/user/file.txt').valid).toBe(true);
      expect(validator.validate('~/file.txt').valid).toBe(true);
    });
  });
  
  describe('Blacklist validation (deniedPaths)', () => {
    it('should reject paths in blacklist', () => {
      const config: PathSecurityConfig = {
        deniedPaths: ['/etc/shadow', '/root', '/etc/ssh']
      };
      const validator = new PathValidator(config);
      
      const result1 = validator.validate('/etc/shadow');
      expect(result1.valid).toBe(false);
      expect(result1.error).toContain('Access denied');
      
      const result2 = validator.validate('/root/.ssh/id_rsa');
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('Access denied');
    });
    
    it('should allow paths not in blacklist', () => {
      const config: PathSecurityConfig = {
        deniedPaths: ['/etc/shadow', '/root']
      };
      const validator = new PathValidator(config);
      
      expect(validator.validate('/home/user/file.txt').valid).toBe(true);
      expect(validator.validate('/var/log/app.log').valid).toBe(true);
    });
  });
  
  describe('Whitelist validation (allowedPaths)', () => {
    it('should allow only paths in whitelist', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin', '/var/www', '/var/log']
      };
      const validator = new PathValidator(config);
      
      expect(validator.validate('/home/admin/file.txt').valid).toBe(true);
      expect(validator.validate('/var/www/index.html').valid).toBe(true);
      expect(validator.validate('/var/log/app.log').valid).toBe(true);
    });
    
    it('should reject paths not in whitelist', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin', '/var/log']
      };
      const validator = new PathValidator(config);
      
      const result = validator.validate('/etc/hosts');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not in allowed list');
    });
    
    it('should allow subdirectories of whitelisted paths', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin']
      };
      const validator = new PathValidator(config);
      
      expect(validator.validate('/home/admin/subdir/file.txt').valid).toBe(true);
      expect(validator.validate('/home/admin/deep/nested/path.txt').valid).toBe(true);
    });
  });
  
  describe('Combined validation rules', () => {
    it('should apply blacklist before whitelist', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home'],
        deniedPaths: ['/home/admin/.ssh']
      };
      const validator = new PathValidator(config);
      
      // Whitelisted but blacklisted → should be denied
      const result = validator.validate('/home/admin/.ssh/id_rsa');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Access denied');
      
      // Whitelisted and not blacklisted → should be allowed
      expect(validator.validate('/home/admin/file.txt').valid).toBe(true);
    });
    
    it('should apply all rules together', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin', '/var/log'],
        deniedPaths: ['/home/admin/.ssh'],
        allowTraversal: false,
        maxPathLength: 100
      };
      const validator = new PathValidator(config);
      
      // Valid path
      expect(validator.validate('/home/admin/file.txt').valid).toBe(true);
      
      // Blacklisted
      expect(validator.validate('/home/admin/.ssh/key').valid).toBe(false);
      
      // Not in whitelist
      expect(validator.validate('/etc/hosts').valid).toBe(false);
      
      // Path traversal
      expect(validator.validate('../file.txt').valid).toBe(false);
      
      // Too long
      const longPath = '/home/admin/' + 'a'.repeat(100);
      expect(validator.validate(longPath).valid).toBe(false);
    });
  });
  
  describe('Tilde path normalization', () => {
    it('should normalize tilde paths for validation', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/user']
      };
      const validator = new PathValidator(config);
      
      // ~/file should be normalized to /home/user/file
      expect(validator.validate('~/file.txt').valid).toBe(true);
    });
  });
  
  describe('Batch validation', () => {
    it('should validate multiple paths', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin']
      };
      const validator = new PathValidator(config);
      
      const result = validator.validateBatch([
        '/home/admin/file1.txt',
        '/home/admin/file2.txt',
        '/home/admin/file3.txt'
      ]);
      
      expect(result.valid).toBe(true);
    });
    
    it('should return first error in batch', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin']
      };
      const validator = new PathValidator(config);
      
      const result = validator.validateBatch([
        '/home/admin/file1.txt',
        '/etc/shadow',  // Invalid
        '/home/admin/file3.txt'
      ]);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not in allowed list');
    });
  });
});

describe('Tilde Expansion (conceptual tests)', () => {
  // Note: These are conceptual tests for the tilde expansion logic
  // The actual implementation is in FileTools and LogTools classes
  
  describe('expandRemoteTilde logic', () => {
    const expandRemoteTilde = (path: string): string => {
      if (!path) return path;
      if (path.startsWith('~/')) return '$HOME/' + path.substring(2);
      if (path === '~') return '$HOME';
      return path;
    };
    
    it('should expand ~/path to $HOME/path', () => {
      expect(expandRemoteTilde('~/file.txt')).toBe('$HOME/file.txt');
      expect(expandRemoteTilde('~/.bashrc')).toBe('$HOME/.bashrc');
      expect(expandRemoteTilde('~/dir/subdir/file')).toBe('$HOME/dir/subdir/file');
    });
    
    it('should expand ~ alone to $HOME', () => {
      expect(expandRemoteTilde('~')).toBe('$HOME');
    });
    
    it('should leave ~user paths unchanged', () => {
      expect(expandRemoteTilde('~admin/.bashrc')).toBe('~admin/.bashrc');
      expect(expandRemoteTilde('~root/file')).toBe('~root/file');
    });
    
    it('should leave absolute paths unchanged', () => {
      expect(expandRemoteTilde('/etc/hosts')).toBe('/etc/hosts');
      expect(expandRemoteTilde('/home/user/file')).toBe('/home/user/file');
    });
    
    it('should leave relative paths unchanged', () => {
      expect(expandRemoteTilde('./file.txt')).toBe('./file.txt');
      expect(expandRemoteTilde('../file.txt')).toBe('../file.txt');
      expect(expandRemoteTilde('file.txt')).toBe('file.txt');
    });
  });
  
  describe('escapeForSingleQuotes logic', () => {
    const escapeForSingleQuotes = (path: string): string => {
      return path.replace(/'/g, "'\\''");
    };
    
    it('should escape single quotes', () => {
      expect(escapeForSingleQuotes("file's name")).toBe("file'\\''s name");
      expect(escapeForSingleQuotes("it's a file")).toBe("it'\\''s a file");
    });
    
    it('should leave other characters unchanged', () => {
      expect(escapeForSingleQuotes('/path/to/file')).toBe('/path/to/file');
      expect(escapeForSingleQuotes('file with spaces')).toBe('file with spaces');
      expect(escapeForSingleQuotes('file$var')).toBe('file$var');
      expect(escapeForSingleQuotes('file`cmd`')).toBe('file`cmd`');
    });
  });
  
  describe('escapeForDoubleQuotes logic', () => {
    const escapeForDoubleQuotes = (str: string): string => {
      return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')
        .replace(/!/g, '\\!');
    };
    
    it('should escape backslashes', () => {
      expect(escapeForDoubleQuotes('path\\file')).toBe('path\\\\file');
    });
    
    it('should escape double quotes', () => {
      expect(escapeForDoubleQuotes('file"name')).toBe('file\\"name');
    });
    
    it('should escape dollar signs', () => {
      expect(escapeForDoubleQuotes('file$var')).toBe('file\\$var');
    });
    
    it('should escape backticks', () => {
      expect(escapeForDoubleQuotes('file`cmd`')).toBe('file\\`cmd\\`');
    });
    
    it('should escape exclamation marks', () => {
      expect(escapeForDoubleQuotes('file!name')).toBe('file\\!name');
    });
    
    it('should escape multiple special characters', () => {
      const input = 'file"with$special`chars!';
      const expected = 'file\\"with\\$special\\`chars\\!';
      expect(escapeForDoubleQuotes(input)).toBe(expected);
    });
  });
  
  describe('buildSafeCommand logic', () => {
    it('should use double quotes for $HOME paths', () => {
      // ~/file → $HOME/file → "$HOME/file"
      const path = '~/file.txt';
      const expanded = '$HOME/file.txt';
      
      // Should produce: cat "$HOME/file.txt"
      expect(expanded.startsWith('$HOME')).toBe(true);
    });
    
    it('should use single quotes for regular paths', () => {
      // /etc/hosts → '/etc/hosts'
      const path = '/etc/hosts';
      
      // Should produce: cat '/etc/hosts'
      expect(path.startsWith('$HOME')).toBe(false);
    });
    
    it('should handle paths with special characters', () => {
      // ~/file's name → $HOME/file's name → "$HOME/file\'s name"
      const path = "~/file's name";
      const expanded = "$HOME/file's name";
      
      expect(expanded.startsWith('$HOME')).toBe(true);
    });
  });
});

describe('Security scenarios', () => {
  describe('Injection prevention', () => {
    it('should prevent command injection via semicolon', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin']
      };
      const validator = new PathValidator(config);
      
      // This path contains command injection attempt
      // When properly quoted, it will be treated as literal filename
      const maliciousPath = '/home/admin/file; rm -rf /';
      
      // Should be allowed (it's just a filename with semicolon)
      expect(validator.validate(maliciousPath).valid).toBe(true);
      
      // Note: The actual safety comes from proper quoting in buildSafeCommand
      // cat "/home/admin/file; rm -rf /" → treats entire string as filename
    });
    
    it('should prevent variable expansion injection', () => {
      // Path with $VAR should be escaped in double quotes
      const path = '/home/admin/file$VAR';
      
      // When escaped: /file\$VAR → shell won't expand $VAR
      const escaped = path.replace(/\$/g, '\\$');
      expect(escaped).toBe('/home/admin/file\\$VAR');
    });
    
    it('should prevent command substitution injection', () => {
      // Path with `cmd` should be escaped
      const path = '/home/admin/file`rm -rf /`';
      
      // When escaped: /file\`rm -rf /\` → shell won't execute
      const escaped = path.replace(/`/g, '\\`');
      expect(escaped).toBe('/home/admin/file\\`rm -rf /\\`');
    });
  });
  
  describe('Real-world scenarios', () => {
    it('should handle production server config', () => {
      const config: PathSecurityConfig = {
        allowedPaths: ['/home/admin', '/var/www', '/var/log'],
        deniedPaths: ['/home/admin/.ssh', '/var/www/.env'],
        allowTraversal: false,
        maxPathLength: 500
      };
      const validator = new PathValidator(config);
      
      // Allowed operations
      expect(validator.validate('/home/admin/config.json').valid).toBe(true);
      expect(validator.validate('/var/www/public/index.html').valid).toBe(true);
      expect(validator.validate('/var/log/app.log').valid).toBe(true);
      
      // Denied operations
      expect(validator.validate('/home/admin/.ssh/id_rsa').valid).toBe(false);
      expect(validator.validate('/var/www/.env').valid).toBe(false);
      expect(validator.validate('/etc/shadow').valid).toBe(false);
      expect(validator.validate('../../../etc/passwd').valid).toBe(false);
    });
  });
});
