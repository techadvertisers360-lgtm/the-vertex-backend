-- AlterTable
ALTER TABLE `stock_items` ADD COLUMN `code` VARCHAR(64) NULL,
    ADD COLUMN `department` VARCHAR(191) NULL,
    ADD COLUMN `procedureUse` TEXT NULL,
    ADD COLUMN `itemType` VARCHAR(191) NULL,
    ADD COLUMN `sterile` BOOLEAN NULL,
    ADD COLUMN `note` TEXT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `stock_items_code_key` ON `stock_items`(`code`);
