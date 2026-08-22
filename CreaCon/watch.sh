echo "Loading plugin..."
uxp plugin load

echo "Watching plugin..."
# json matters: src/schema/editPlan.schema.json is require()d by validator.js to
# derive the list of valid ops, so a schema change that isn't reloaded shows up
# as "unknown op" at Apply time. css matters for the same reason - it is loaded
# by index.html, not bundled.
nodemon --exec "uxp plugin reload" -e js,jsx,html,json,css
