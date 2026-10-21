import { Router, type IRouter } from "express";
import { requireActiveMember } from "../../lib/speedmatch-auth";
import communicationsRouter from "./communications";
import crmRouter from "./crm";
import dashboardRouter from "./dashboard";
import notesRouter from "./notes";
import superadminRouter from "./superadmin";
import supportRouter from "./support";
import teamRouter from "./team";

const router: IRouter = Router();

router.use(teamRouter);
router.use(superadminRouter);
router.use(requireActiveMember);
router.use(dashboardRouter);
router.use(crmRouter);
router.use(communicationsRouter);
router.use(notesRouter);
router.use(supportRouter);

export default router;
