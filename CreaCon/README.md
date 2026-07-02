# CreaCon

A Photoshop UXP panel where you describe an edit in plain language, an AI backend turns it
into a structured, reviewable edit plan, and the plugin applies it as real, editable Photoshop
operations (adjustment layers, masks, opacity, groups) - not a flattened image.

## Architecture

- `main.js` / `src/panel.js` - panel UI: instruction box, plan preview, edit trace
- `src/aiClient.js` - sends the instruction (+ optional preview image) to the backend
- `src/validator.js` - lightweight structural check of the returned plan before executing
- `src/executor/` - applies each plan step via the Photoshop DOM API / batchPlay
- `../backend/` - FastAPI service that calls Claude and validates its output against
  `../schema/editPlan.schema.json`

## Getting started

1. Start the backend: see `../backend/README.md`.
2. Add this plugin to the UXP Developer Tools ("Add Plugin" -> select `manifest.json`), then
   Load it into Photoshop.
3. Type an instruction, review the generated plan, and click Apply.

If you change `../schema/editPlan.schema.json`, run `node ../scripts/sync-schema.js` to copy
it into `src/schema/` before reloading the plugin.

## Documentation

* [UXP Developer Tools walkthrough](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/udt-walkthrough/)
* [Editing the document](https://developer.adobe.com/photoshop/uxp/2022/guides/getting-started/editing-the-document/)
* [Writing a file](https://developer.adobe.com/photoshop/uxp/2022/guides/getting-started/writing-a-file/)
