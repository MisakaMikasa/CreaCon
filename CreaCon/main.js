const { entrypoints } = require("uxp");
const { setup } = require("./src/panel");

entrypoints.setup({
  panels: {
    vanilla: {
      show() {
        setup();
      },
    },
  },
});
