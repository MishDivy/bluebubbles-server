const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { startPreview } = require("../scripts/preview-bootstrap.cjs");
const { previewConfig, previewSigningOptions, previewBuildProfile, helperRevision } = require("../scripts/build-preview.cjs");

test("packaging uses a distinct app, pinned helper and a newly generated archive", () => {
    const config = previewConfig({
        revision: "a".repeat(40),
        helper: "/fixture/helper",
        checksum: "/fixture/helper.md5",
        output: "/fixture/output"
    });
    assert.equal(config.productName, "BlueBubbles Preview");
    assert.equal(config.appId, "com.mishdivy.bluebubbles-preview");
    assert.equal(config.electronVersion, "25.9.8");
    assert.equal(config.extraMetadata.main, "./dist/preview-bootstrap.cjs");
    assert.equal(config.extraMetadata.version, "1.9.9-preview.aaaaaaa");
    assert.equal(config.asar, true);
    assert.equal(config.mac.publish, null);
    assert.equal(path.isAbsolute(config.mac.entitlements), true);
    assert.equal(fs.existsSync(config.mac.entitlements), true);
    assert.equal(config.mac.entitlementsInherit, config.mac.entitlements);
    assert.equal(config.mac.target[0].arch[0], "arm64");
    assert.equal(config.extraResources[1].from, "/fixture/helper");
    assert.ok(config.extraResources[0].filter.includes("!macos/sticker-preview"));
    assert.equal(config.extraResources.length, 3);
    assert.match(helperRevision, /^[a-f0-9]{40}$/);
    assert.throws(() => previewConfig({ revision: "short" }), /complete source/);
});

test("native stickers require an explicit build profile and separately verified converter", () => {
    assert.deepEqual(previewBuildProfile(), {
        name: "stable", helperRevision, helperDirectory: "messages", nativeStickers: false
    });
    const profile = previewBuildProfile("native-stickers");
    assert.match(profile.helperRevision, /^[a-f0-9]{40}$/);
    assert.notEqual(profile.helperRevision, helperRevision);
    assert.equal(profile.nativeStickers, true);
    assert.equal(profile.helperDirectory, "messages-experimental-stickers");
    assert.throws(() => previewBuildProfile("typo"), /Build profile/);
    const config = previewConfig({ revision: "b".repeat(40), helper: "/fixture/helper",
        checksum: "/fixture/checksum", output: "/fixture/output", stickerPreview: "/fixture/converter" });
    assert.deepEqual(config.extraResources[3], {
        from: "/fixture/converter", to: "appResources/macos/sticker-preview"
    });
    assert.ok(config.mac.signIgnore.includes("/appResources/macos/sticker-preview$"));
});

test("bootstrap selects the existing private clone before any server module loads", () => {
    const calls = [];
    const state = "/fixture/appData/divy-mac-utils/services/bluebubbles-preview/data";
    const app = {
        getPath: name => {
            assert.equal(name, "appData");
            return "/fixture/appData";
        },
        setPath: (name, value) => calls.push([name, value])
    };
    const files = {
        lstatSync: file => ({
            isDirectory: () => file === state,
            isFile: () => file !== state,
            isSymbolicLink: () => false,
            mode: file === state ? 0o700 : 0o600,
            uid: process.getuid()
        }),
        realpathSync: value => value
    };
    const previous = process.env.BLUEBUBBLES_PREVIEW;
    try {
        startPreview(
            app,
            () => {
                assert.equal(process.env.BLUEBUBBLES_PREVIEW, "1");
                calls.push(["load"]);
            },
            files
        );
        assert.deepEqual(calls, [["userData", state], ["load"]]);
        for (const unsafe of [
            { realpathSync: () => "/other" },
            { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => true }) }
        ]) {
            assert.throws(
                () => startPreview(app, () => assert.fail("loaded unsafe clone"), { ...files, ...unsafe }),
                /private state clone/
            );
        }
        assert.throws(
            () =>
                startPreview(app, () => assert.fail("loaded missing clone"), {
                    ...files,
                    lstatSync: () => {
                        throw new Error("missing");
                    }
                }),
            /missing/
        );
    } finally {
        if (previous === undefined) delete process.env.BLUEBUBBLES_PREVIEW;
        else process.env.BLUEBUBBLES_PREVIEW = previous;
    }
});

test("ad-hoc signing preserves runtime entitlements without requesting a timestamp authority", () => {
    const options = previewSigningOptions({
        optionsForFile: () => ({ hardenedRuntime: true, entitlements: "/fixture/entitlements.plist" })
    });
    assert.equal(options.identity, "-");
    assert.equal(options.identityValidation, false);
    assert.deepEqual(options.optionsForFile("fixture"), {
        hardenedRuntime: true, entitlements: "/fixture/entitlements.plist", timestamp: "none"
    });
});

function compile(relative, dependencies) {
    const module = { exports: {} };
    const source = fs.readFileSync(path.resolve(__dirname, "../src/server", relative), "utf8");
    const code = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    new Function("require", "module", "exports", code)(
        name => {
            if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency ${name}`);
            return dependencies[name];
        },
        module,
        module.exports
    );
    return module.exports;
}

test("preview disables automatic and manual update checks without contacting the vendor", async () => {
    let checks = 0;
    const { UpdateService } = compile("services/updateService/index.ts", {
        electron: { app: { getVersion: () => "1.9.9-preview.aaaaaaa" } },
        semver: require("semver"),
        "@server": {},
        "@server/events": {},
        "@server/lib/ScheduledService": {
            ScheduledService: class {
                constructor() {
                    checks++;
                }
            }
        },
        "@server/lib/logging/Loggable": { Loggable: class {} },
        axios: {
            get: () => {
                checks++;
            }
        },
        "@server/preview": { isPreviewBuild: true }
    });
    const update = new UpdateService(null);
    update.start();
    assert.equal(await update.checkForUpdate({ showNoUpdateDialog: true }), false);
    assert.equal(checks, 0);
});

test("preview install endpoint rejects before checking or downloading updates", async () => {
    class BadRequest extends Error {
        constructor({ message }) {
            super(message);
        }
    }
    const { ServerRouter } = compile("api/http/api/v1/routers/serverRouter.ts", {
        "@server/fileSystem": {},
        "@server": {},
        "@server/api/interfaces/serverInterface": {},
        "@server/api/interfaces/generalInterface": {
            GeneralInterface: { checkForUpdate: () => assert.fail("update check reached") }
        },
        "../responses/success": {},
        "@server/api/interfaces/alertsInterface": {},
        "@server/helpers/utils": {},
        "../responses/errors": { BadRequest },
        "electron-updater": { autoUpdater: { downloadUpdate: () => assert.fail("download reached") } },
        "@server/events": {},
        "@server/preview": { isPreviewBuild: true }
    });
    await assert.rejects(ServerRouter.installUpdate({}, null), /disabled for this preview/);
});
