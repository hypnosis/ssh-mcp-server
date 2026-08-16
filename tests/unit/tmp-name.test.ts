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
      ).toBe("cat > '/etc/nginx.conf (staging copy)': Permission denied");
    });

    it('временная копия и цель в одной строке не сливаются в один путь', () => {
      // Иначе замена превращает `mv` копии на место цели в «переименовать цель
      // саму в себя», и отказ читается как бессмыслица
      expect(
        hideArtifactNames(
          "mv -T -- '/etc/.upload-2f6e757b0157.hosts' '/etc/hosts' — " +
            "mv: cannot move '/etc/.upload-2f6e757b0157.hosts' to '/etc/hosts': Device or resource busy"
        )
      ).toBe(
        "mv -T -- '/etc/hosts (staging copy)' '/etc/hosts' — " +
          "mv: cannot move '/etc/hosts (staging copy)' to '/etc/hosts': Device or resource busy"
      );
    });

    it('имя с пробелом внутри кавычек не режется по пробелу', () => {
      expect(hideArtifactNames("cat > '/srv/.upload-a5be28a9d096.my file.conf': No space left")).toBe(
        "cat > '/srv/my file.conf (staging copy)': No space left"
      );
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
