-- Lead Team connection booking (D-071)
ALTER TABLE `appointments` MODIFY `source` ENUM('LEAD', 'RECEPTION', 'MANAGER', 'DOCTOR_PLAN', 'CONNECTION') NOT NULL;
