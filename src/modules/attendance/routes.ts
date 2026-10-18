import { Router } from 'express';
import { route } from '../../middleware/route';
import * as svc from './service';
import { myReviews } from '../manager/staff';

export const attendanceRouter = Router();

attendanceRouter.get('/today', route({ permission: 'attendance:own' }, async ({ actor }) => ({ attendance: await svc.today(actor) })));
attendanceRouter.post('/check-in', route({ permission: 'attendance:own', status: 201 }, async ({ actor }) => svc.checkIn(actor)));
attendanceRouter.get('/reviews', route({ permission: 'attendance:own' }, async ({ actor }) => myReviews(actor)));
attendanceRouter.post('/check-out', route({ permission: 'attendance:own' }, async ({ actor }) => svc.checkOut(actor)));
