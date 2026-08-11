import { Pool } from "pg";
import { resolveConnectionString, resolveSslConfig } from "./dbConnection.js";

export const pool = new Pool({ connectionString: resolveConnectionString(), ssl: resolveSslConfig() });
