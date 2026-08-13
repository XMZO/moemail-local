CREATE TABLE `mailbox_name_block` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`scope_key` text NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_name_block_scope_unique` ON `mailbox_name_block` (`scope_key`,`local_part`,`domain`);--> statement-breakpoint
CREATE INDEX `mailbox_name_block_lookup_idx` ON `mailbox_name_block` (`local_part`,`domain`,`scope_key`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_send_quota_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`quota_subject` text NOT NULL,
	`policy_role` text NOT NULL,
	`direction` text DEFAULT 'send' NOT NULL,
	`sender_domain` text NOT NULL,
	`mailbox_address` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`reservation_expires_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "send_quota_event_status_check" CHECK("__new_send_quota_event"."status" IN ('reserved', 'sent')),
	CONSTRAINT "send_quota_event_direction_check" CHECK("__new_send_quota_event"."direction" IN ('send', 'receive')),
	CONSTRAINT "send_quota_event_role_check" CHECK("__new_send_quota_event"."policy_role" IN ('emperor', 'duke', 'knight', 'civilian'))
);
--> statement-breakpoint
INSERT INTO `__new_send_quota_event`("id", "user_id", "quota_subject", "policy_role", "direction", "sender_domain", "mailbox_address", "status", "created_at", "reservation_expires_at", "completed_at") SELECT "id", "user_id", "quota_subject", "policy_role", 'send', "sender_domain", '', "status", "created_at", "reservation_expires_at", "completed_at" FROM `send_quota_event`;--> statement-breakpoint
DROP TABLE `send_quota_event`;--> statement-breakpoint
ALTER TABLE `__new_send_quota_event` RENAME TO `send_quota_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `send_quota_event_subject_created_idx` ON `send_quota_event` (`quota_subject`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_subject_domain_created_idx` ON `send_quota_event` (`quota_subject`,`sender_domain`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_subject_direction_created_idx` ON `send_quota_event` (`quota_subject`,`direction`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_subject_direction_domain_created_idx` ON `send_quota_event` (`quota_subject`,`direction`,`sender_domain`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_user_direction_mailbox_created_idx` ON `send_quota_event` (`user_id`,`direction`,`mailbox_address`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_user_created_idx` ON `send_quota_event` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_quota_event_role_created_idx` ON `send_quota_event` (`policy_role`,`created_at`);
