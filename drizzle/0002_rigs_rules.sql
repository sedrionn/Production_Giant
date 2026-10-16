PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_structure_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`structure_type` text NOT NULL,
	`security` text NOT NULL,
	`rigs` text DEFAULT '[]' NOT NULL,
	`solar_system_id` integer,
	`facility_tax` real DEFAULT 0 NOT NULL,
	`system_job_bonus` real DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_structure_profiles`("id", "name", "structure_type", "security", "rigs", "solar_system_id", "facility_tax", "system_job_bonus", "is_default", "created_at") SELECT "id", "name", "structure_type", "security", "rigs", "solar_system_id", "facility_tax", "system_job_bonus", "is_default", "created_at" FROM `structure_profiles`;--> statement-breakpoint
DROP TABLE `structure_profiles`;--> statement-breakpoint
ALTER TABLE `__new_structure_profiles` RENAME TO `structure_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
UPDATE `structure_profiles` SET `rigs` = '[]' WHERE `rigs` = '{}';