-- Consultation + Procedure rooms (D-063)
ALTER TABLE `rooms` MODIFY `kind` ENUM('CONSULT', 'PROCEDURE', 'CONSULT_PROCEDURE') NOT NULL;
