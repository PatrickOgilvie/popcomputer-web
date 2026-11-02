CREATE TABLE `orgs` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`org_id` integer NOT NULL REFERENCES `orgs`(`id`),
	`name` text NOT NULL,
	`visibility` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL REFERENCES `projects`(`id`),
	`title` text NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` integer PRIMARY KEY NOT NULL,
	`parent_id` integer REFERENCES `folders`(`id`),
	`name` text NOT NULL
);
