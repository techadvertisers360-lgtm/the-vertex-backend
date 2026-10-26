-- AlterTable
ALTER TABLE `stock_intakes` ADD COLUMN `lotNo` VARCHAR(100) NULL,
    ADD COLUMN `distributor` VARCHAR(191) NULL,
    ADD COLUMN `costPaisa` BIGINT NULL;
