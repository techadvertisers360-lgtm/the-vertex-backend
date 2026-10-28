-- Office Boy writes damage items by name (D-068)
ALTER TABLE `damage_reports` MODIFY `itemId` VARCHAR(191) NULL,
    ADD COLUMN `itemName` VARCHAR(120) NULL;
