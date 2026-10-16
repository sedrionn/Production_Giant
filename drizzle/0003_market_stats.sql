CREATE TABLE `market_stats` (
	`type_id` integer NOT NULL,
	`region_id` integer NOT NULL,
	`avg_daily_volume_7d` real NOT NULL,
	`avg_daily_volume_30d` real NOT NULL,
	`avg_price_30d` real,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`type_id`, `region_id`)
);
