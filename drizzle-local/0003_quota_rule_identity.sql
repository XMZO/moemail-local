ALTER TABLE `send_quota_event` ADD `global_rule_id` text;--> statement-breakpoint
ALTER TABLE `send_quota_event` ADD `scoped_rule_id` text;--> statement-breakpoint
CREATE INDEX `send_quota_event_global_rule_created_idx` ON `send_quota_event` (`global_rule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_scoped_rule_created_idx` ON `send_quota_event` (`scoped_rule_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_scoped_rule_user_created_idx` ON `send_quota_event` (`scoped_rule_id`,`user_id`,`created_at`);
