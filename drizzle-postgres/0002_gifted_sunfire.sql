CREATE TABLE "mailbox_name_block" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"scope_key" text NOT NULL,
	"local_part" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "send_quota_event" ADD COLUMN "direction" text DEFAULT 'send' NOT NULL;--> statement-breakpoint
ALTER TABLE "send_quota_event" ADD COLUMN "mailbox_address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_name_block" ADD CONSTRAINT "mailbox_name_block_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_name_block_scope_unique" ON "mailbox_name_block" USING btree ("scope_key","local_part","domain");--> statement-breakpoint
CREATE INDEX "mailbox_name_block_lookup_idx" ON "mailbox_name_block" USING btree ("local_part","domain","scope_key");--> statement-breakpoint
CREATE INDEX "send_quota_event_subject_direction_created_idx" ON "send_quota_event" USING btree ("quota_subject","direction","created_at");--> statement-breakpoint
CREATE INDEX "send_quota_event_subject_direction_domain_created_idx" ON "send_quota_event" USING btree ("quota_subject","direction","sender_domain","created_at");--> statement-breakpoint
CREATE INDEX "send_quota_event_user_direction_mailbox_created_idx" ON "send_quota_event" USING btree ("user_id","direction","mailbox_address","created_at");--> statement-breakpoint
ALTER TABLE "send_quota_event" ADD CONSTRAINT "send_quota_event_direction_check" CHECK ("send_quota_event"."direction" IN ('send', 'receive'));