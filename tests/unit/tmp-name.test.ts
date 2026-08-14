/**
 * Unit tests for tmp-name helpers
 */

import { describe, it, expect } from 'vitest';
import { buildTempPath, buildSudoStagingPath, hideArtifactNames } from '../../src/utils/tmp-name.js';

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

  /**
   * Человек называл один путь, а отказ приходил про другой — про временное имя,
   * которого на сервере уже нет и найти которое он не может.
   */
  describe('hideArtifactNames', () => {
    it('возвращает в текст путь, который назвал человек', () => {
      expect(
        hideArtifactNames("cat > '/etc/.upload-a5be28a9d096.nginx.conf': Permission denied")
      ).toBe("cat > '/etc/nginx.conf': Permission denied");
    });

    it('адрес отложенной копии остаётся: она лежит на сервере, её и убирать', () => {
      expect(hideArtifactNames('mv: /var/www/.bak-6627deccfe36.app: busy')).toBe(
        'mv: /var/www/.bak-6627deccfe36.app: busy'
      );
    });

    it('чужие точки в имени остаются на месте', () => {
      expect(hideArtifactNames('/etc/my.upload-notes.conf and /tmp/.bak-of-mine.txt')).toBe(
        '/etc/my.upload-notes.conf and /tmp/.bak-of-mine.txt'
      );
    });

    it('текст без наших имён не меняется', () => {
      expect(hideArtifactNames('chown: invalid user')).toBe('chown: invalid user');
    });
  });
});
