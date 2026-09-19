import { getAuthConfig } from "./auth/config.js";
import { createApp } from "./app.js";

getAuthConfig(); // fail fast on missing auth env vars

const port = process.env.PORT ?? 4000;
const app = createApp();

app.listen(port, () => {
  console.log(`api listening on port ${port}`);
});
