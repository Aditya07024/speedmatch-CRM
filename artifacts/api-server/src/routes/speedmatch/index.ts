import { Router, type IRouter } from "express";
import { requireActiveMember } from "../../lib/speedmatch-auth";
import communicationsRouter from "./communications";
import crmRouter from "./crm";
import dashboardRouter from "./dashboard";
import superadminRouter from "./superadmin";
import teamRouter from "./team";

const router: IRouter = Router();

router.use(teamRouter);
router.use(superadminRouter);
router.use(requireActiveMember);
router.use(dashboardRouter);
router.use(crmRouter);
router.use(communicationsRouter);

export default router;