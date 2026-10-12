// Loads environment variables from a local .env file (if present).
// Must be imported before anything that reads process.env (e.g. @workspace/db).
import path from "node:path";
import { config } from "dotenv";

config({ path: path.resolve(process.cwd(), "../../.env") });
config({ path: path.resolve(process.cwd(), ".env") });
