import { builder } from "./builder.js";

// Import all type definitions to register them
import "./types/user.js";

export const schema = builder.toSchema();
