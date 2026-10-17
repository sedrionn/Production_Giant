ALTER TABLE `market_stats` ADD `avg_price_7d` real;--> statement-breakpoint
ALTER TABLE `price_cache` ADD `sell_orders` integer;--> statement-breakpoint
ALTER TABLE `price_cache` ADD `sell_orders_fresh` integer;