CREATE TABLE `notes` (
	`id` integer PRIMARY KEY NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notes_body_unique` ON `notes` (`body`);
