/**
 * Unit tests for tmp-name helpers
 */

import { describe, it, expect } from 'vitest';
import { buildTempPath, buildSudoStagingPath } from '../../src/utils/tmp-name.js';

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
});
