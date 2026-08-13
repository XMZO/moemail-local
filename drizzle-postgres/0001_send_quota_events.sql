CREATE TABLE "send_quota_event" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"quota_subject" text NOT NULL,
	"policy_role" text NOT NULL,
	"sender_domain" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"reservation_expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "send_quota_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "send_quota_event_status_check" CHECK ("status" IN ('reserved', 'sent')),
	CONSTRAINT "send_quota_event_role_check" CHECK ("policy_role" IN ('emperor', 'duke', 'knight', 'civilian'))
);
--> statement-breakpoint
CREATE INDEX "send_quota_event_subject_created_idx" ON "send_quota_event" USING btree ("quota_subject","created_at");
--> statement-breakpoint
CREATE INDEX "send_quota_event_subject_domain_created_idx" ON "send_quota_event" USING btree ("quota_subject","sender_domain","created_at");
--> statement-breakpoint
CREATE INDEX "send_quota_event_user_created_idx" ON "send_quota_event" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "send_quota_event_role_created_idx" ON "send_quota_event" USING btree ("policy_role","created_at");
