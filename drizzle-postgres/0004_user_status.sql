ALTER TABLE "user" ADD COLUMN "banned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "user_banned_at_idx" ON "user" USING btree ("banned_at");
