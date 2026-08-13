CREATE TABLE `send_quota_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`quota_subject` text NOT NULL,
	`policy_role` text NOT NULL,
	`sender_domain` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`reservation_expires_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `send_quota_event_status_check` CHECK (`status` IN ('reserved', 'sent')),
	CONSTRAINT `send_quota_event_role_check` CHECK (`policy_role` IN ('emperor', 'duke', 'knight', 'civilian'))
);
--> statement-breakpoint
CREATE INDEX `send_quota_event_subject_created_idx` ON `send_quota_event` (`quota_subject`,`created_at`);
--> statement-breakpoint
CREATE INDEX `send_quota_event_subject_domain_created_idx` ON `send_quota_event` (`quota_subject`,`sender_domain`,`created_at`);
--> statement-breakpoint
CREATE INDEX `send_quota_event_user_created_idx` ON `send_quota_event` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `send_quota_event_role_created_idx` ON `send_quota_event` (`policy_role`,`created_at`);
