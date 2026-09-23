import { login } from "./auth";
import { serve } from "./server";

switch (process.argv[2]) {
  case "login": await login(); break;
  case "serve": serve(); break;
  default: console.error("Usage: bun src/cli.ts <login|serve>"); process.exitCode = 2;
}
