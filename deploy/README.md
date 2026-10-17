# Развёртывание Bilig на сервере

Bilig ставится рядом с другими проектами на том же сервере и ни с чем не
пересекается: у него своя PostgreSQL, свой Redis и свои Docker-тома. Наружу
не открыто ничего, кроме сайта на `127.0.0.1:8081`, а HTTPS делает nginx
сервера.

```
Интернет ─► nginx сервера (80/443, HTTPS) ─┬─► ваш первый проект (как есть)
                                           └─► 127.0.0.1:8081  Bilig «web» (сайт + /api, /cdn)
                                                   └─► api ─► postgres, redis  (сеть только внутри Docker)
```

## Что нужно на сервере

- Linux с Docker и Docker Compose v2.17+ (`docker compose version`).
- nginx и certbot на сервере (`sudo apt install nginx certbot python3-certbot-nginx`),
  если их ещё нет.
- Около 1 ГБ свободной памяти и 3 ГБ диска.

## Адрес без своего домена

Возьмите бесплатное имя [sslip.io](https://sslip.io) от IP сервера: для IP
`203.0.113.5` это `bilig.203-0-113-5.sslip.io`. Оно уже указывает на сервер,
и Let's Encrypt выдаёт для него сертификат. Когда появится свой домен,
поменяйте `BILIG_URL` и `server_name` и выпустите сертификат заново.

## Первый запуск

На своём компьютере, в папке с обоими репозиториями:

```bash
bilig_back/deploy/push.sh user@203.0.113.5
```

Скрипт выгружает закоммиченный код обоих проектов в `~/bilig` на сервере и
запускает `deploy.sh`. В первый раз он только создаёт
`~/bilig/bilig_back/deploy/production.env` с новыми паролями и останавливается.

На сервере:

1. Откройте `~/bilig/bilig_back/deploy/production.env` и заполните:
   - `BILIG_URL=https://bilig.203-0-113-5.sslip.io`;
   - `TUTOR_PROVIDER=anthropic` и `ANTHROPIC_API_KEY=…`, если нужен помощник
     (иначе оставьте `none`);
   - `DEV_ADMIN_EMAIL` и `DEV_ADMIN_PASSWORD` для первого суперадмина.
2. Запустите `~/bilig/bilig_back/deploy/deploy.sh`. Первая сборка занимает
   5–10 минут.
3. Подключите HTTPS: скопируйте `deploy/nginx/host-bilig.conf` в
   `/etc/nginx/sites-available/bilig`, впишите своё имя, включите его и
   выпустите сертификат (команды есть в начале файла).
4. Откройте `https://bilig.…sslip.io`, войдите как суперадмин и подключите
   двухфакторный вход. После этого очистите `DEV_ADMIN_*` в
   `production.env`.

## Обновление

Снова запустите `deploy/push.sh user@host` со своего компьютера. Перед
обновлением делается бэкап базы. Новые темы и модели загружаются в базу при
старте, миграции применяются сами.

## Бэкапы

- `deploy/backup.sh` пишет сжатый дамп в `deploy/backups/` и хранит 14 дней.
- Каждую ночь: `crontab -e` →
  `30 3 * * * $HOME/bilig/bilig_back/deploy/backup.sh >/dev/null 2>&1`.
- Восстановление: команда в начале `backup.sh`.

## Полезные команды (на сервере, в `~/bilig/bilig_back`)

```bash
c="docker compose -f deploy/docker-compose.yml --env-file deploy/production.env"
$c ps                 # состояние
$c logs -f api        # логи API
$c restart api        # перезапуск API
$c down               # остановить (данные остаются в томах)
```

## Ограничения сейчас

- **Почта не отправляется.** Письма (приглашения, сброс пароля, подтверждение)
  пока только пишутся в лог API (`MAIL_TRANSPORT=console`). Ссылку из письма
  можно взять из `$c logs api`. Для настоящей отправки нужен SMTP и доработка
  `src/services/mailer.ts`.
- **Модели и миниатюры раздаёт сам API** (`/cdn/…`). Для одной школы этого
  хватает. Для большой нагрузки их лучше вынести на CDN (`CDN_BASE_URL`).
