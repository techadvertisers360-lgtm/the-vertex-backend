-- AlterTable
ALTER TABLE `services` ADD COLUMN `category` VARCHAR(191) NULL,
    ADD COLUMN `source` VARCHAR(191) NULL,
    ADD COLUMN `note` TEXT NULL;
