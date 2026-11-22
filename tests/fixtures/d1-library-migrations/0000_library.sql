CREATE TABLE `authors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL REFERENCES `authors`(`id`) ON DELETE RESTRICT,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `books_author` ON `books` (`author_id`);
--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`),
	`reply_to` text REFERENCES `annotations`(`id`) ON DELETE CASCADE,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order` (
	`id` integer PRIMARY KEY NOT NULL,
	`book_id` integer NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `archive` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `books_archived` AFTER DELETE ON `books`
BEGIN
	-- What a deleted book was called; the title is kept.
	INSERT INTO `archive` (`title`) VALUES (OLD.`title`);
END;
--> statement-breakpoint
CREATE TRIGGER `authors_kept` BEFORE DELETE ON `authors` WHEN OLD.`name` = 'Ada'
BEGIN
	SELECT RAISE(ABORT, 'authors_kept');
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `titles` USING fts5(`title`, content='books', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER `books_indexed` AFTER INSERT ON `books`
BEGIN
	INSERT INTO `titles` (rowid, `title`) VALUES (NEW.`id`, NEW.`title`);
END;
--> statement-breakpoint
CREATE TRIGGER `books_unindexed` AFTER DELETE ON `books`
BEGIN
	INSERT INTO `titles` (`titles`, rowid, `title`) VALUES ('delete', OLD.`id`, OLD.`title`);
END;
