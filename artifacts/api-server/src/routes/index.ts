import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import speedmatchRouter from "./speedmatch";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(speedmatchRouter);

export default router;
