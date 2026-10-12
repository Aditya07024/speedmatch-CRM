import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", router);

// Static file serving for single-server production deployment (e.g. Hostinger KVM VPS)
const staticDirs = [
  path.resolve(process.cwd(), "artifacts/speedmatch/dist/public"),
  path.resolve(process.cwd(), "artifacts/speedmatch/dist"),
  path.resolve(process.cwd(), "../speedmatch/dist/public"),
];

let publicPath: string | null = null;
for (const dir of staticDirs) {
  if (fs.existsSync(dir) && fs.existsSync(path.join(dir, "index.html"))) {
    publicPath = dir;
    break;
  }
}

if (publicPath) {
  logger.info({ publicPath }, "Serving static frontend files");
  app.use(express.static(publicPath));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(publicPath!, "index.html"));
  });
}

export default app;
