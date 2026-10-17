CREATE TABLE `assets` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` integer NOT NULL,
	`via_character_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`location_id` integer NOT NULL,
	`location_flag` text NOT NULL,
	`location_type` text NOT NULL,
	`is_singleton` integer DEFAULT false NOT NULL,
	`is_blueprint_copy` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assets_type` ON `assets` (`type_id`);--> statement-breakpoint
CREATE INDEX `assets_location` ON `assets` (`location_id`);--> statement-breakpoint
CREATE TABLE `location_names` (
	`location_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`title` text NOT NULL,
	`data` text NOT NULL
);
