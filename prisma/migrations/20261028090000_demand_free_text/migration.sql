-- Office Boy writes demand items by name (D-066)
ALTER TABLE `stock_demand_lines` MODIFY `itemId` VARCHAR(191) NULL,
    ADD COLUMN `itemName` VARCHAR(120) NULL;
