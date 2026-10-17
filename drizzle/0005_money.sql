CREATE TABLE `contracts` (
	`contract_id` integer PRIMARY KEY NOT NULL,
	`character_id` integer NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`issuer_id` integer NOT NULL,
	`acceptor_id` integer,
	`for_corporation` integer DEFAULT false NOT NULL,
	`price` real,
	`reward` real,
	`collateral` real,
	`volume` real,
	`start_location_id` integer,
	`end_location_id` integer,
	`title` text,
	`date_issued` text NOT NULL,
	`date_completed` text
);
--> statement-breakpoint
CREATE TABLE `market_orders` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`character_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`location_id` integer NOT NULL,
	`region_id` integer NOT NULL,
	`is_buy` integer NOT NULL,
	`price` real NOT NULL,
	`volume_total` integer NOT NULL,
	`volume_remain` integer NOT NULL,
	`issued` text NOT NULL,
	`duration` integer NOT NULL,
	`escrow` real,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `market_orders_type` ON `market_orders` (`type_id`);--> statement-breakpoint
CREATE TABLE `wallet_balances` (
	`character_id` integer NOT NULL,
	`at` text NOT NULL,
	`balance` real NOT NULL,
	PRIMARY KEY(`character_id`, `at`)
);
--> statement-breakpoint
CREATE TABLE `wallet_journal` (
	`id` integer PRIMARY KEY NOT NULL,
	`character_id` integer NOT NULL,
	`date` text NOT NULL,
	`ref_type` text NOT NULL,
	`amount` real NOT NULL,
	`balance` real,
	`description` text DEFAULT '' NOT NULL,
	`first_party_id` integer,
	`second_party_id` integer,
	`context_id` integer,
	`context_id_type` text,
	`reason` text,
	`tax` real
);
--> statement-breakpoint
CREATE INDEX `wallet_journal_char_date` ON `wallet_journal` (`character_id`,`date`);--> statement-breakpoint
CREATE TABLE `wallet_transactions` (
	`transaction_id` integer PRIMARY KEY NOT NULL,
	`character_id` integer NOT NULL,
	`date` text NOT NULL,
	`type_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` real NOT NULL,
	`is_buy` integer NOT NULL,
	`is_personal` integer DEFAULT true NOT NULL,
	`location_id` integer NOT NULL,
	`client_id` integer,
	`journal_ref_id` integer
);
--> statement-breakpoint
CREATE INDEX `wallet_transactions_type` ON `wallet_transactions` (`type_id`);--> statement-breakpoint
CREATE INDEX `wallet_transactions_date` ON `wallet_transactions` (`date`);--> statement-breakpoint
ALTER TABLE `industry_jobs` ADD `cost` real;--> statement-breakpoint
ALTER TABLE `industry_jobs` ADD `completed_date` text;--> statement-breakpoint
ALTER TABLE `industry_jobs` ADD `successful_runs` integer;