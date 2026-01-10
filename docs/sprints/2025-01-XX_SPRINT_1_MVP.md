# 🎯 SPRINT 1: MVP - Базовый каркас

**Статус:** 🟢 АКТИВНЫЙ  
**Период:** 2025-01-XX  
**Дата начала:** 2025-01-XX

## 📅 ПЛАН НА СЕГОДНЯ

**Задача:** Создать базовый каркас SSH MCP Server

## 🎯 ЗАДАЧИ

### 1. Проектная структура ✅
- [x] Создать структуру проекта
- [x] Настроить package.json
- [x] Настроить TypeScript
- [x] Скопировать общие утилиты (logger, ssh-config)

### 2. SSH Manager (база) 🚧
- [ ] Реализовать SSHManager.execute()
- [ ] Реализовать SSHManager.executeBatch()
- [ ] Реализовать SSHManager.testConnection()
- [ ] Реализовать SSHManager.uploadFile() / downloadFile()

### 3. MCP Tools (заглушки) ✅
- [x] NginxTools (заглушки)
- [x] LogTools (заглушки)
- [x] ConfigTools (заглушки)
- [x] CrondTools (заглушки)
- [x] BackupTools (заглушки)
- [x] PackageTools (заглушки)

### 4. Интеграция SSH конфигурации 🚧
- [x] Реализовать getSSHConfig() в NginxTools и LogTools
- [ ] Реализовать getSSHConfig() в остальных tools
- [x] Поддержка профилей из SSH_PROFILES
- [x] Валидация конфигурации

### 5. Документация ✅
- [x] README.md
- [x] Базовая структура docs/
- [x] Sprint план

## 📝 ИТОГИ ДНЯ

_Будет заполнено в конце дня_

## 🔄 СЛЕДУЮЩИЕ ШАГИ

1. Реализовать SSHManager
2. Реализовать базовые инструменты (Nginx, Logs)
3. Тестирование на реальных серверах
