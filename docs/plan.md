# EVE Industry App: план

Личная локальная замена EVE Guru: персонажи через ESI, ассеты, цены, полное дерево производства (T1/T2/T3, капиталы, реакции), прибыль.

## Ключевые решения

- **Стек:** Next.js (App Router) + TypeScript + Tailwind + SQLite (better-sqlite3 + Drizzle). Один пользователь, локально, без своей авторизации. SQLite выбран потому, что не нужен сервер БД, бэкап делается копированием файла, а для одного пользователя этого хватает.
- **Движок расчёта** — чистый TS-модуль `src/engine` без сети и БД. На вход данные, на выход результат. Поэтому его можно целиком писать и тестировать в облаке.
- **SDE:** официальный SDE от CCP в формате JSON Lines (`eve-online-static-data-latest-jsonl.zip`, формат после переделки 2025 года). Скрипт сам строит из него нормализованный `data/sde.sqlite` и проверяет результат на здравый смысл. От схем сторонних дампов (Fuzzwork) не зависим.
- **Облако и локалка:** облачная сессия не имеет доступа к esi.evetech.net, Fuzzwork и login.eveonline.com (проверено, все запросы блокируются). Поэтому облако пишет код и тесты на фикстурах, а локально запускаются импорт SDE, захват фикстур, SSO и проверка на живых данных.
- **Универсальный узел:** любая активность (manufacturing, reaction, invention, reverse engineering, copying) представлена узлом с входами, выходами, временем и стоимостью джобы. T3 и капиталы отличаются только данными.

## Структура репозитория

```
eve-industry/
  src/app/              UI (Next.js)
  src/engine/           materials.ts, jobCost.ts, invention.ts, tree.ts, pricing.ts, types.ts
  src/sde/              доступ к SDE (запросы по чертежам, типам)
  src/esi/              клиент ESI, SSO (PKCE), синк (этап 2)
  src/db/schema.ts      таблицы приложения (Drizzle)
  scripts/
    sde-download.ts     скачать официальный SDE (JSONL) и собрать data/sde.sqlite
    fixtures-capture.ts вытащить подмножество SDE и ответы ESI в fixtures/
  fixtures/sde/*.json   чертежи и типы для тестовых предметов (коммитятся)
  fixtures/esi/*.json   prices, cost indices, ордера (коммитятся)
  data/                 sde.sqlite, app.sqlite (в .gitignore)
  tests/
```

## Схема БД приложения

**Этап 1:**
- `structure_profiles`: id, name, structure_type (npc_station | raitaru | azbel | sotiyo | athanor | tatara), rigs (json: активность → T1/T2), security (high | low | null_wh), system_id, facility_tax, is_default
- `price_cache`: type_id, location (jita_4_4 | the_forge | amarr…), buy_max, sell_min, buy_volume, sell_volume, updated_at
- `adjusted_prices`: type_id, adjusted_price, average_price, updated_at
- `cost_indices`: system_id, activity, cost_index, updated_at
- `settings`: key, value (режимы цен, налоги, хаб по умолчанию)
- `build_plans`: id, name, product_type_id, runs, me, te, profile_id, decisions (json: type_id → build | buy)

**Этап 2:**
- `characters`: character_id, name, corporation_id, refresh_token (шифрованно), scopes, is_trader
- `char_skills`, `char_blueprints` (item_id, type_id, me, te, runs, is_bpo, location), `char_assets` (type_id, quantity, location_id, owner), `industry_jobs`

## Движок: формулы (значения бонусов задаются конфигом, перед фиксацией сверить с игрой)

- **Материалы:** `qty = max(runs, ceil(round(base × runs × (1 − ME/100) × structMod × rigMod, 2)))`, где `rigMod = 1 − rigBonus × secMultiplier`.
  - Defaults: engineering complex role −1% материалов. Риги ME: T1 2.0%, T2 2.4%. Множитель безопасности: high 1.0, low 1.9, null/WH 2.1.
- **Выход продукта:** `runs × productQuantity`. Например, R.A.M. дают 100 штук за ран. В текущей таблице это не учтено (см. баги).
- **Стоимость джобы:** `EIV = Σ(base_qty × adjusted_price) × runs`, считается **без ME**. `cost = EIV × (costIndex × (1 − structureJobBonus) + facilityTax + SCC)`. SCC и бонусы структур берутся из конфига.
- **Инвент:** шанс = `base × (1 + (sci1 + sci2)/30 + encryption/40) × decryptorMod`. Ожидаемая стоимость BPC = стоимость попытки / шанс.
- **Дерево:** рекурсия по материалам. Решение на каждом узле: build, если `buildCost(qty) < buyCost(qty)`, иначе buy. Плюс ручной оверрайд и вычет того, что уже лежит на складе (этап 2). Агрегация одинаковых промежуточных продуктов по всему дереву (с округлением ранов вверх и остатками).
- **Цены:** две независимые настройки:
  - материалы: `buy_max | sell_min | split (avg)`
  - продукт: `buy_max | sell_min | split`
  
  Хаб: Jita 4-4 (station 60003760), фильтр ордеров по location_id, а не по всему региону. Налоги: sales tax и broker fee задаются вручную в настройках, потом считаются по скиллам торгового персонажа.

## Что взято из старой таблицы

Эталон (Jackdaw 34828, 20 ранов, ME 4, без бонусов структуры), количество материалов на уровне 1:
- по 39 шт: 30466, 30002, 30476, 29992, 30478, 29994
- 154 × 30464 Metallofullerene Plating
- 58 × 34396 Self-Assembling Nanolattice
- 192 × 11478 R.A.M.- Starship Tech

Эти числа станут первым golden-тестом формулы материалов (базовые количества берутся из SDE).

Баги таблицы, которые новый движок должен закрыть (оформить как регрессионные тесты):
1. **Portion size:** билд 192 R.A.M. посчитан как 192 рана, получилось 85 402 Tritanium и 9.1M ISK. Правильно: 2 рана по 100 шт.
2. **Total Build Cost** суммирует build cost даже там, где решение BUY. На R.A.M. это +9M ISK лишних. Нужно брать `min(build, buy)` или выбранное решение.
3. Нет стоимости джоб, cost index, бонусов структуры, нет уровня реакций (fullerene-материалы), нет стоимости BPC (reverse engineering).
4. Цены берутся минимумом по всему региону The Forge, а не по Jita 4-4. Режим цен один на всё.
5. Налог 4.4% захардкожен.

## Этапы

**Этап 1 — движок и калькулятор (без персонажей)**
- 1a (облако): скелет проекта, схема БД, скрипты `sde-download` и `fixtures-capture`, движок materials, jobCost, pricing с юнит-тестами на фикстурах, сделанных вручную.
- 1b (локально): `npm run sde:download && npm run fixtures:capture`, закоммитить `fixtures/`.
- 1c (облако): tree (build/buy, агрегация, реакции), invention/RE, пресеты структур, UI калькулятора (выбор предмета, раны, ME/TE, профиль, режимы цен, таблица дерева, шопинг-лист).
- 1d (локально): сверить 3 предмета с EVE Guru (T2 модуль, Jackdaw, капитальный компонент).

**Этап 1d — обзор выгодности (сделано) (как «Blueprints» в EVE Guru):** таблица по категориям с фильтрами и сортировкой.
- Категории: калдарские корабли T1/T2, T3 (крейсеры, эсминцы), реакции, риги T1/T2, плюс свои списки.
- Колонки: прибыль за ран и за партию, маржа, ISK/ч, объём продаж в день (сколько рынок съест), стоимость чертежа (инвент), время джобы.
- Для каждой строки считается полное дерево с теми же пресетами, порогом ISK/ч и режимами цен.
- Массовое обновление цен для всей категории (ESI, параллельно, с кэшем).

**Этап 1e — недельный план (сделано, v1):** страница «План недели». Партии подбираются под ритм заходов (по умолчанию раз в 2 дня), джобы раскладываются по свободным слотам персонажей (слоты из скиллов минус активные джобы), компоненты ставятся раньше корпуса, в пределах бюджета и доли рынка. Дальше: лабораторные слоты (инвент) в расписании, запас материалов на несколько недель.

**Этап 2 — персонажи (сделано):** SSO (PKCE, callback на localhost), мультичар, синк скиллов, чертежей, ассетов и джоб. Корповые данные только при наличии роли Director.

**Этап 3a — учёт (сделано):** кошелёк, сделки, ордера, контракты из ESI; страница «Учёт»: деньги по категориям, построено и продано по предметам, сигналы (перебитые ордера, джобы в минусе). Автообновление персонажей и цен раз в сутки.

**Этап 3b — склад в дереве:** вычет ассетов, шопинг-лист «что докупить».

**Этап 4 — дашборд:** прибыльность всех своих чертежей, ISK/час, объёмы рынка.

## Скоупы ESI (этап 2)

`esi-skills.read_skills.v1`, `esi-characters.read_blueprints.v1`, `esi-assets.read_assets.v1`, `esi-industry.read_character_jobs.v1`, `esi-markets.read_character_orders.v1`, `esi-wallet.read_character_wallet.v1`, `esi-contracts.read_character_contracts.v1`. Для корпы: `esi-corporations.read_blueprints.v1`, `esi-assets.read_corporation_assets.v1`, `esi-industry.read_corporation_jobs.v1`.

---

## Промпт для облачной сессии: этап 1a

```
Проект: личное локальное приложение для производства в EVE Online (аналог EVE Guru), один пользователь.
Стек: Next.js (App Router) + TypeScript strict + Tailwind + better-sqlite3 + Drizzle ORM + Vitest. Node 20+.

ВАЖНО: в этой среде НЕТ доступа к esi.evetech.net, fuzzwork.co.uk, login.eveonline.com.
Никогда не пытайся скачивать данные EVE. Всё, что требует сети EVE, пишется как скрипт,
который пользователь запустит локально. Тесты работают только на фикстурах из репозитория.
Не выдумывай базовые количества материалов из SDE — в тестах используй явно помеченные
синтетические фикстуры, реальные придут позже из fixtures-capture.

Задачи этапа 1a:
1. Скелет: структура папок src/app, src/engine, src/sde, src/esi, src/db, scripts, fixtures, data (data/ в .gitignore). npm-скрипты: dev, test, typecheck, lint, sde:download, fixtures:capture.
2. src/db/schema.ts: таблицы structure_profiles, price_cache, adjusted_prices, cost_indices, settings, build_plans (поля по docs/plan.md). Миграции drizzle-kit.
3. scripts/sde-download.ts: качает официальный SDE (JSONL zip) с developers.eveonline.com, строит data/sde.sqlite, делает проверку на здравый смысл.
4. src/sde/: функции getBlueprintForProduct(typeId), getActivity(bpId, activity) -> {time, materials[], products[], skills[], probability?}, getType(typeId) (name, groupId, categoryId, portionSize, volume). Работают поверх data/sde.sqlite И поверх fixtures/sde/*.json (один интерфейс SdeSource, две реализации).
5. scripts/fixtures-capture.ts: для списка typeId (Jackdaw 34828, R.A.M.- Starship Tech 11478, все компоненты дерева Jackdaw до минералов/лунных материалов, плюс Hammerhead II, Capital Armor Plates, одна реакция) рекурсивно выгружает из SDE всё нужное в fixtures/sde/; качает с ESI /markets/prices/, /industry/systems/, ордера Jita для этих typeId (фильтр location_id 60003760) в fixtures/esi/.
6. src/engine (чистые функции, без IO):
   - materials.ts: qty = max(runs, ceil(round(base*runs*(1-ME/100)*structMod*rigMod, 2))); rigMod = 1 - rigBonus*secMult. Все бонусы — из конфигурационного объекта src/engine/bonuses.ts с комментарием «сверить с игрой».
   - output: runs * productQuantity; runsNeeded(qty) = ceil(qty / productQuantity).
   - jobCost.ts: EIV от базовых количеств (без ME) * adjusted price; cost = EIV*(costIndex*(1-structJobBonus) + facilityTax + scc).
   - pricing.ts: режимы buy_max | sell_min | split для материалов и для продукта отдельно; sales tax и broker fee из настроек.
7. Тесты Vitest:
   - формула материалов: ME0/ME10, base=1 (никогда не меньше runs), разные множители безопасности, синтетический чертёж «base 2 × 20 ранов, ME4 → 39», «base 3 × 20 ранов, ME4 → 58», «base 10 × 20 ранов, ME4 → 192»;
   - portion size: 192 штуки при productQuantity 100 → 2 рана;
   - jobCost: EIV не зависит от ME;
   - pricing: все комбинации режимов.
8. docs/plan.md — положи туда этот план (я его приложу), docs/decisions.md — фиксируй принятые решения.

Чеклист готовности (проверь сам и отчитайся по каждому пункту):
[ ] npm install && npm run typecheck && npm test проходят чисто
[ ] engine не импортирует ничего из db/, esi/, node:fs, fetch
[ ] SdeSource имеет две реализации, тесты используют fixture-реализацию
[ ] все бонусы структур/ригов в одном конфиге, ни одного магического числа в формулах
[ ] scripts/sde-download.ts и fixtures-capture.ts компилируются; в README описано, как их запускать локально
[ ] data/ в .gitignore, fixtures/ — нет
[ ] коммиты небольшие, осмысленные; запушено в ветку и открыт PR
```

## Локальные шаги для Ника (один раз)

1. Установить Node 20+ и Git.
2. Создать пустой приватный репозиторий на GitHub (например `eve-industry`).
3. После этапа 1a: `git clone`, затем `npm install`, `npm run sde:download`, `npm run fixtures:capture`, закоммитить и запушить `fixtures/`.
4. Зарегистрировать приложение на developers.eveonline.com (нужно к этапу 2), callback `http://localhost:3000/api/auth/callback`.
