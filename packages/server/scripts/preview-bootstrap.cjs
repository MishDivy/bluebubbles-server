"use strict";

const fs = require("node:fs");
const path = require("node:path");

function startPreview(app, loadMain = () => require("./main.js"), files = fs) {
    const state = path.join(app.getPath("appData"), "divy-mac-utils/services/bluebubbles-preview/data");
    const directory = files.lstatSync(state);
    const database = files.lstatSync(path.join(state, "config.db"));
    if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        files.realpathSync(state) !== state ||
        (directory.mode & 0o077) !== 0 ||
        directory.uid !== process.getuid() ||
        !database.isFile() ||
        database.isSymbolicLink() ||
        database.uid !== process.getuid() ||
        (database.mode & 0o077) !== 0
    ) {
        throw new Error("Preview requires an existing private state clone prepared by the deployment tool.");
    }
    app.setPath("userData", state);
    process.env.BLUEBUBBLES_PREVIEW = "1";
    loadMain();
}

module.exports = { startPreview };
if (require.main === module) startPreview(require("electron").app);
