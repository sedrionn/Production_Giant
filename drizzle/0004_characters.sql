CREATE TABLE `character_skills` (
	`character_id` integer NOT NULL,
	`skill_id` integer NOT NULL,
	`level` integer NOT NULL,
	PRIMARY KEY(`character_id`, `skill_id`)
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`corporation_id` integer,
	`scopes` text DEFAULT '[]' NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`access_expires_at` text,
	`last_sync_at` text,
	`last_sync_notes` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `industry_jobs` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`installer_id` integer NOT NULL,
	`via_character_id` integer NOT NULL,
	`activity_id` integer NOT NULL,
	`blueprint_type_id` integer NOT NULL,
	`product_type_id` integer,
	`runs` integer NOT NULL,
	`status` text NOT NULL,
	`facility_id` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owned_blueprints` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` integer NOT NULL,
	`via_character_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`me` integer NOT NULL,
	`te` integer NOT NULL,
	`runs` integer NOT NULL,
	`quantity` integer NOT NULL,
	`location_id` integer NOT NULL,
	`location_flag` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `owned_blueprints_type` ON `owned_blueprints` (`type_id`);