/**
 * Unit tests for tmp-name helpers
 */

import { describe, it, expect } from 'vitest';
import { buildTempPath, buildSudoStagingPath, shellQuote } from '../../src/utils/tmp-name.js';

describe('tmp-name helpers', () => {
  describe('buildTempPath', () => {
    it('places temp next to target on the same FS', () => {
      const tmp = buildTempPath('/etc/nginx/site.conf');
      expect(tmp).toMatch(/^\/etc\/nginx\/\.upload-[0-9a-f]{12}\.site\.conf$/);
    });

    it('handles paths without slash', () => {
      const tmp = buildTempPath('local.txt');
      expect(tmp).toMatch(/^\.upload-[0-9a-f]{12}\.local\.txt$/);
    });

    it('produces a unique name per call', () => {
      const a = buildTempPath('/x/y');
      const b = buildTempPath('/x/y');
      expect(a).not.toBe(b);
    });
  });

  describe('buildSudoStagingPath', () => {
    it('puts sudo staging in /tmp', () => {
      const s = buildSudoStagingPath();
      expect(s).toMatch(/^\/tmp\/\.ssh-mcp-upload-[0-9a-f]{16}$/);
    });
  });

  describe('shellQuote', () => {
    it('wraps simple paths in single quotes', () => {
      expect(shellQuote('/etc/foo')).toBe(`'/etc/foo'`);
    });

    it("escapes embedded single quotes via '\\''", () => {
      expect(shellQuote("/path/it's.txt")).toBe(`'/path/it'\\''s.txt'`);
    });

    it('quotes paths with $ and ` literally', () => {
      expect(shellQuote('$HOME/`code`')).toBe(`'$HOME/\`code\`'`);
    });
  });
});
