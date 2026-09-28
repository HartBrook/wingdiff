import { loadWingdiffEnvironment } from "./environment.js";
import { startWingdiffServer } from "./server.js";

loadWingdiffEnvironment();
const running = await startWingdiffServer();
console.log(`wingdiff is ready at ${running.url}`);
console.log("AI providers: see the in-app provider picker for local availability");
