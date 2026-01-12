# GitHub Actions Workflows

## Publish to NPM

Автоматическая публикация в NPM при создании тега версии.

### Настройка

1. **Создайте NPM Token:**
   - Зайдите на https://www.npmjs.com/settings/YOUR_USERNAME/tokens
   - Создайте новый токен типа "Automation" (для CI/CD)
   - Скопируйте токен

2. **Добавьте токен в GitHub Secrets:**
   - Зайдите в Settings → Secrets and variables → Actions
   - Нажмите "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: вставьте ваш NPM токен
   - Нажмите "Add secret"

### Использование

1. Обновите версию в `package.json`
2. Обновите `CHANGELOG.md` (если есть)
3. Закоммитьте изменения:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to X.Y.Z"
   git push
   ```

4. Создайте и запушьте тег:
   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z: Description"
   git push origin vX.Y.Z
   ```

5. GitHub Actions автоматически:
   - Запустит тесты
   - Соберёт проект
   - Опубликует в NPM
   - Создаст GitHub Release

### Триггеры

Workflow запускается при push тега, начинающегося с `v` (например, `v1.0.2`).
