# LAN Veto Tournament (Steam + Auth) — fixed host

Проект зафиксирован под адрес хоста:
**http://192.168.1.100:4000**

Именно по этому адресу игроки должны открывать сайт в браузере, чтобы Steam редиректил назад корректно.

## Запуск (Windows)
1) Установи Node.js LTS (20/22)
2) В папке проекта:

```powershell
npm install
npm run seed
npm run dev
```

Открыть:
- Регистрация: http://192.168.1.100:4000/register.html
- Вход:        http://192.168.1.100:4000/login.html
- Игроки:      http://192.168.1.100:4000/players.html
- Админка:     http://192.168.1.100:4000/admin.html
- Матч:        ссылка из `npm run seed`

Seed создаёт admin:
- login: admin
- pass:  admin
