CREATE TABLE `adjusted_prices` (
	`type_id` integer PRIMARY KEY NOT NULL,
	`adjusted_price` real,
	`average_price` real,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `build_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`product_type_id` integer NOT NULL,
	`runs` integer DEFAULT 1 NOT NULL,
	`me` integer DEFAULT 0 NOT NULL,
	`te` integer DEFAULT 0 NOT NULL,
	`profile_id` integer,
	`decisions` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `structure_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `build_plans_product` ON `build_plans` (`product_type_id`);--> statement-breakpoint
CREATE TABLE `cost_indices` (
	`solar_system_id` integer NOT NULL,
	`activity` text NOT NULL,
	`cost_index` real NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`solar_system_id`, `activity`)
);
--> statement-breakpoint
CREATE TABLE `price_cache` (
	`type_id` integer NOT NULL,
	`location_id` integer NOT NULL,
	`buy_max` real,
	`sell_min` real,
	`buy_volume` integer DEFAULT 0 NOT NULL,
	`sell_volume` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`type_id`, `location_id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `structure_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`structure_type` text NOT NULL,
	`security` text NOT NULL,
	`rigs` text DEFAULT '{}' NOT NULL,
	`solar_system_id` integer,
	`facility_tax` real DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
