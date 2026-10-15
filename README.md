# Production Giant

Личный планировщик производства для EVE Online в духе EVE Guru: цепочки сборки (T1/T2/T3, капиталы, реакции), цены Jita, стоимость джоб, прибыль. Работает локально, для одного пользователя.

План: [`docs/plan.md`](docs/plan.md) · решения: [`docs/decisions.md`](docs/decisions.md)

## Установка (один раз)

Нужны **Node.js 22 LTS** (подойдёт 20–24) и **Git**.

```bash
git clone https://github.com/sedrionn/production_giant.git
cd production_giant
npm install
npm run db:migrate        # создаёт data/app.sqlite с пресетами структур
npm run sde:download      # качает официальный SDE (~сотни МБ) и собирает data/sde.sqlite
```

`sde:download` в конце печатает количество типов и чертежей. Если видишь `SANITY CHECK FAILED`, скопируй вывод целиком и пришли в сессию: значит, CCP поменяли формат.

## Снять фикстуры (после каждого обновления SDE или раз в пару недель)

```bash
npm run fixtures:capture
git add fixtures && git commit -m "Update fixtures" && git push
```

Это реальные данные (дерево Jackdaw, R.A.M., Hammerhead II, капитальный компонент, реакция + цены Jita). По ним облачные сессии и тесты работают без доступа к ESI. Свои предметы можно передать аргументами: `npm run fixtures:capture -- "Hammerhead II" 34828`.

## Запуск

```bash
npm run dev               # http://localhost:3000
```

## Разработка

```bash
npm test                  # Vitest
npm run typecheck
npm run lint
```

| Папка | Что там |
|---|---|
| `src/engine` | чистый движок расчёта (без IO — проверяется линтером) |
| `src/sde` | импорт и доступ к SDE (`SdeSource`: SQLite или фикстуры) |
| `src/esi` | клиент ESI и преобразования ответов |
| `src/db` | схема Drizzle, сиды |
| `scripts` | `sde-download`, `fixtures-capture`, `db-migrate` — **запускаются локально** |
| `fixtures` | коммитящийся срез реальных данных для тестов |
| `data` | локальные БД, в git не попадают |
