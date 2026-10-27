-- Manager deletes rooms; rooms still in history are archived (D-065)
ALTER TABLE `rooms` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedById` VARCHAR(191) NULL;
