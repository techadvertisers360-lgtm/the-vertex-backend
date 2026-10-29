-- D-076: a walk-in procedure done by an Assistant may have no Doctor.
ALTER TABLE `appointments` MODIFY `doctorId` VARCHAR(191) NULL;
ALTER TABLE `treatment_plans` MODIFY `doctorId` VARCHAR(191) NULL;
ALTER TABLE `procedure_tasks` MODIFY `doctorId` VARCHAR(191) NULL;
