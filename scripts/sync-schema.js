// Copies the canonical schema into the UXP plugin bundle.
// UXP's require() can only read files inside the plugin's own folder, so the
// plugin needs a physical copy. Run this after editing schema/editPlan.schema.json.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "schema", "editPlan.schema.json");
const dest = path.join(__dirname, "..", "CreaCon", "src", "schema", "editPlan.schema.json");

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Synced schema -> ${dest}`);
