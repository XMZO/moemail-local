ALTER TABLE `user` ADD `banned_at` integer;--> statement-breakpoint
CREATE INDEX `user_banned_at_idx` ON `user` (`banned_at`);
